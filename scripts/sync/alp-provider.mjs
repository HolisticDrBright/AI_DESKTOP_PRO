/**
 * The REAL AI Longevity Pro provider adapter (staging bridge, Phase 6B).
 *
 * Speaks patient-sync/1 to the ALP receiver's signed envelope boundary:
 * validated claimed envelope -> exact wire DTO -> HMAC-signed POST with a
 * strict timeout -> the receiver's receipts become the ONLY delivery
 * evidence the worker records.
 *
 * Approval is layered and this adapter shortcuts none of it:
 *   1. the database registry — without a CONNECTED `alp_patient_sync`
 *      connector, `claim_sync_outbound` refuses and this adapter is never
 *      handed work;
 *   2. complete staging configuration — createAlpProvider throws unless
 *      base URL, secret, key id, and organization id are all present;
 *   3. the reviewed code path — there is NO fallback to the fixture here,
 *      and no environment flag substitutes for any of the above.
 *
 * Failure taxonomy (never weaker than the receiver's answer):
 *   401/403  -> security (consent for connection_revoked) — never retried
 *   400/413/415/422 -> contract — never retried, dead-letters
 *   409 (nonce replay) -> retryable with a fresh nonce
 *   429      -> retryable, Retry-After honored
 *   5xx / timeout / network -> retryable with bounded backoff upstream
 */
import { randomUUID } from "node:crypto";
import { SyncError } from "./errors.mjs";
import { CONTRACT_VERSION, toWireEnvelope, validateOutboundEnvelope } from "./contract.mjs";
import { signCallback } from "./hmac.mjs";

export const ALP_PROVIDER_NAME = "alp_patient_sync";
export const ALP_PROVIDER_LABEL = "AI Longevity Pro patient sync (staging bridge)";

const RECEIPT_KINDS = new Set(["delivered", "acknowledged"]);

export function createAlpProvider({
  baseUrl,
  secret,
  keyId,
  organizationId,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  now = () => Date.now(),
  makeNonce = () => randomUUID(),
} = {}) {
  if (!baseUrl || !secret || !keyId || !organizationId) {
    throw new SyncError(
      "security",
      "alp_config_incomplete",
      "the ALP provider requires SYNC_ALP_BASE_URL, SYNC_ALP_OUTBOUND_SECRET, SYNC_ALP_KEY_ID, and SYNC_WORKER_ORG_ID",
    );
  }
  const base = String(baseUrl).replace(/\/$/, "");

  return {
    name: ALP_PROVIDER_NAME,
    label: ALP_PROVIDER_LABEL,
    contractVersion: CONTRACT_VERSION,
    fixture: false,

    health() {
      // Names only — no secrets, no URLs with credentials.
      return { name: ALP_PROVIDER_NAME, fixture: false, contractVersion: CONTRACT_VERSION };
    },

    async deliver(rawEnvelope) {
      const envelope = validateOutboundEnvelope(rawEnvelope);
      const wire = toWireEnvelope(envelope, { organizationId });
      const rawBody = Buffer.from(JSON.stringify(wire), "utf8");
      const timestamp = now();
      const nonce = makeNonce();
      const signature = signCallback({ rawBody, secret, timestamp, nonce });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${base}/patient-sync/v1/envelopes`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sync-signature": signature,
            "x-sync-key-id": keyId,
            "x-sync-timestamp": String(timestamp),
            "x-sync-nonce": nonce,
          },
          body: rawBody,
          signal: controller.signal,
        });
      } catch (e) {
        const code = e && e.name === "AbortError" ? "alp_timeout" : "alp_unreachable";
        throw new SyncError("retryable", code, "ALP receiver unreachable");
      } finally {
        clearTimeout(timer);
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const errorCode = body && body.error && body.error.code ? String(body.error.code) : null;

      if (response.status === 200 && body && body.ok === true) {
        const receipts = Array.isArray(body.receipts) ? body.receipts : [];
        if (receipts.length === 0) {
          throw new SyncError("contract", "alp_no_receipts", "receiver returned no receipts");
        }
        const evidence = receipts.map((r) => {
          if (!RECEIPT_KINDS.has(r.kind) || typeof r.providerEventId !== "string"
            || typeof r.occurredAt !== "string" || r.eventUid !== envelope.eventUid) {
            throw new SyncError("contract", "alp_malformed_receipt", "receiver receipt is malformed");
          }
          return { providerEventId: r.providerEventId, kind: r.kind, occurredAt: r.occurredAt };
        });
        return { evidence, duplicate: body.duplicate === true };
      }

      if (response.status === 401) {
        throw new SyncError("security", errorCode ?? "alp_unauthorized", "receiver refused the signature");
      }
      if (response.status === 403) {
        if (errorCode === "connection_revoked") {
          // The patient side revoked: consent-class — durably not deliverable.
          throw new SyncError("consent", "connection_revoked", "connection revoked on the patient side");
        }
        throw new SyncError("security", errorCode ?? "alp_forbidden", "receiver refused the connection");
      }
      if (response.status === 409) {
        // Nonce replay collision: the request itself may retry with a fresh
        // nonce. This is transport-level, not envelope-level.
        throw new SyncError("retryable", "alp_replay_collision", "nonce replay collision");
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers?.get?.("retry-after") ?? 0);
        throw new SyncError("retryable", "alp_rate_limited", "receiver rate limited", {
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000,
        });
      }
      if ([400, 413, 415, 422].includes(response.status)) {
        throw new SyncError("contract", errorCode ?? `alp_http_${response.status}`, "receiver refused the envelope");
      }
      if (response.status >= 500) {
        throw new SyncError("retryable", `alp_http_${response.status}`, "receiver unavailable");
      }
      throw new SyncError("permanent", errorCode ?? `alp_http_${response.status}`, "unexpected receiver response");
    },
  };
}
