/**
 * ============================ TEST FIXTURE ============================
 * The DETERMINISTIC CONTRACT-VERIFICATION PROVIDER for patient-sync/1.
 *
 * This is test infrastructure, NOT AI Longevity Pro and NOT a delivery
 * channel. It exists so the worker's envelope validation, evidence handling,
 * retries, callbacks, and failure taxonomy can be proven against every
 * scenario a real provider could produce. It never performs network I/O.
 * The deploy guard refuses it in any deployed environment, with no override.
 * ======================================================================
 *
 * Scenario selection is deterministic: `scenarioFor(envelope)` (defaulting
 * to payload-independent routing by resourceId suffix or an injected map).
 */
import { SyncError } from "./errors.mjs";
import { sha256Hex, validateOutboundEnvelope, CONTRACT_VERSION } from "./contract.mjs";
import { signCallback } from "./hmac.mjs";

export const FIXTURE_PROVIDER_NAME = "sync_contract_fixture";
export const FIXTURE_LABEL =
  "Deterministic contract fixture (TEST — not a real AI Longevity Pro connection)";

export const FIXTURE_SCENARIOS = [
  "success", "duplicate_delivery", "delayed_ack", "out_of_order_ack",
  "timeout", "retryable_429", "retryable_5xx", "permanent_400",
  "invalid_contract_version", "invalid_payload_hash",
];

export function createFixtureProvider({ scenarioFor = () => "success", now = () => new Date() } = {}) {
  let calls = 0;
  return {
    name: FIXTURE_PROVIDER_NAME,
    label: FIXTURE_LABEL,
    contractVersion: CONTRACT_VERSION,
    fixture: true,

    /** Health/posture without any sensitive configuration. */
    health() {
      return { name: FIXTURE_PROVIDER_NAME, fixture: true, contractVersion: CONTRACT_VERSION, calls };
    },

    /**
     * Deliver one envelope. Returns { evidence: [...] } — each entry is
     * provider evidence the worker records verbatim. Throws classified
     * SyncErrors for failure scenarios. Idempotent per idempotencyKey:
     * evidence ids derive from the key, so replays produce identical ids
     * and the database dedupes them.
     */
    async deliver(envelope) {
      calls += 1;
      // The fixture validates the contract exactly like a real receiver must.
      validateOutboundEnvelope(envelope);
      const payloadText = JSON.stringify(envelope.payload);
      if (sha256Hex(payloadText) !== envelope.payloadHash) {
        throw new SyncError("contract", "payload_hash_mismatch", "payload hash does not match payload");
      }

      const scenario = scenarioFor(envelope);
      const at = now().toISOString();
      const evidenceId = (kind) => `fx-${kind}-${sha256Hex(envelope.idempotencyKey).slice(0, 16)}`;

      switch (scenario) {
        case "success":
          return {
            evidence: [
              { providerEventId: evidenceId("del"), kind: "delivered", occurredAt: at },
              { providerEventId: evidenceId("ack"), kind: "acknowledged", occurredAt: at },
            ],
          };
        case "duplicate_delivery":
          // The provider reports the SAME evidence twice — the database must dedupe.
          return {
            evidence: [
              { providerEventId: evidenceId("del"), kind: "delivered", occurredAt: at },
              { providerEventId: evidenceId("del"), kind: "delivered", occurredAt: at },
              { providerEventId: evidenceId("ack"), kind: "acknowledged", occurredAt: at },
            ],
          };
        case "delayed_ack":
          // Delivery now; the acknowledgment arrives later via callback.
          return {
            evidence: [{ providerEventId: evidenceId("del"), kind: "delivered", occurredAt: at }],
          };
        case "out_of_order_ack":
          // Acknowledgment arrives BEFORE the delivered event.
          return {
            evidence: [
              { providerEventId: evidenceId("ack"), kind: "acknowledged", occurredAt: at },
              { providerEventId: evidenceId("del"), kind: "delivered", occurredAt: at },
            ],
          };
        case "timeout":
          throw new SyncError("retryable", "timeout", "fixture: simulated provider timeout");
        case "retryable_429":
          throw new SyncError("retryable", "rate_limited", "fixture: simulated 429", { retryAfterMs: 1500 });
        case "retryable_5xx":
          throw new SyncError("retryable", "http_503", "fixture: simulated 503");
        case "permanent_400":
          throw new SyncError("permanent", "http_400", "fixture: simulated permanent rejection");
        case "invalid_contract_version":
          throw new SyncError("contract", "unsupported_contract_version", "fixture: receiver rejected the contract version");
        case "invalid_payload_hash":
          throw new SyncError("contract", "payload_hash_mismatch", "fixture: receiver computed a different payload hash");
        default:
          throw new SyncError("contract", "unknown_fixture_scenario", `unknown fixture scenario: ${scenario}`);
      }
    },

    /**
     * Build a SIGNED callback (delivery receipt or inbound envelope) exactly
     * as a real provider would emit one — used to exercise the callback
     * boundary end to end (signature, replay window, nonce, dedup).
     */
    buildSignedCallback({ body, secret, keyId, timestamp = Date.now(), nonce }) {
      const rawBody = Buffer.from(JSON.stringify(body), "utf8");
      const signature = signCallback({ rawBody, secret, timestamp, nonce });
      return {
        rawBody,
        headers: {
          "content-type": "application/json",
          "x-sync-signature": signature,
          "x-sync-key-id": keyId,
          "x-sync-timestamp": String(timestamp),
          "x-sync-nonce": nonce,
        },
      };
    },
  };
}
