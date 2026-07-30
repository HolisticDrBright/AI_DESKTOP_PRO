/**
 * The provider-callback boundary, owned by the WORKER process (the only
 * process holding service-role credentials).
 *
 * Every request: content-type + size limits -> raw bytes -> HMAC verification
 * (constant-time, timestamp tolerance) BEFORE any parsing -> nonce replay
 * registration -> route to record_sync_delivery / record_sync_inbound.
 * Responses are sanitized ({ok} / {error:{code}}); nothing echoes bodies, and
 * logs carry no PHI, payloads, tokens, or secrets.
 */
import { createServer } from "node:http";
import { verifyCallback } from "./hmac.mjs";
import { SyncError } from "./errors.mjs";

const MAX_BODY_BYTES = 65536;

export function createCallbackServer({
  rpc,
  organizationId,
  provider,
  resolveSecret,
  logger,
  toleranceMs = 5 * 60_000,
  parseJson = (buf) => JSON.parse(buf.toString("utf8")),
}) {
  const handler = async (req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const isCallback = req.method === "POST" && req.url === "/sync/callback";
    const isVerify = req.method === "POST" && req.url === "/sync/verify";
    if (!isCallback && !isVerify) {
      return respond(404, { error: { code: "not_found" } });
    }
    if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
      return respond(415, { error: { code: "unsupported_content_type" } });
    }

    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) overflow = true;
      else chunks.push(c);
    });
    req.on("end", async () => {
      if (overflow) return respond(413, { error: { code: "payload_too_large" } });
      const rawBody = Buffer.concat(chunks);
      try {
        // SIGNATURE FIRST — over the exact raw bytes, before any parsing.
        verifyCallback({
          rawBody,
          signature: req.headers["x-sync-signature"],
          keyId: req.headers["x-sync-key-id"],
          timestamp: req.headers["x-sync-timestamp"],
          nonce: req.headers["x-sync-nonce"],
          resolveSecret,
          toleranceMs,
        });
      } catch (e) {
        logger.log("callback_refused", { errorClass: "security", errorCode: e.code ?? "invalid" });
        return respond(401, { error: { code: e.code ?? "invalid_signature" } });
      }

      const nonceResult = await rpc("register_sync_callback_nonce", {
        _organization_id: organizationId,
        _provider: provider,
        _nonce: String(req.headers["x-sync-nonce"]),
      });
      if (nonceResult.replay) {
        logger.log("callback_replay_refused", { errorClass: "security", errorCode: "replay" });
        return respond(409, { error: { code: "replay" } });
      }

      let body;
      try {
        body = parseJson(rawBody);
      } catch {
        return respond(400, { error: { code: "invalid_json" } });
      }

      if (isVerify) {
        // Connection verification: the patient app presents the one-time
        // invitation code together with its OPAQUE authenticated subject id.
        // Never an email, name, phone, or date of birth. The response never
        // includes the desktop patient id — minimum necessary only.
        if (typeof body.token !== "string" || typeof body.subject !== "string"
          || !body.token || !body.subject) {
          return respond(400, { error: { code: "invalid_verification_request" } });
        }
        try {
          const verified = await rpc("verify_sync_invitation", {
            _token: body.token,
            _external_subject_id: String(body.subject),
          });
          logger.log("verify_accepted", { connectionId: String(verified.connectionId ?? "") });
          return respond(200, {
            ok: true,
            connectionId: verified.connectionId,
            organizationId: verified.organizationId,
            contractVersion: verified.contractVersion,
          });
        } catch (e) {
          const code = e instanceof SyncError ? e.code : "verification_failed";
          logger.log("verify_refused", { errorCode: code });
          // One typed refusal for every failure mode: an attacker probing
          // codes learns nothing about which invitations exist.
          return respond(400, { error: { code: "invitation_invalid" } });
        }
      }

      try {
        if (body.kind && body.eventUid) {
          // Delivery evidence callback.
          const result = await rpc("record_sync_delivery", {
            _event_uid: body.eventUid,
            _provider_event_id: String(body.providerEventId ?? ""),
            _kind: String(body.kind),
            _occurred_at: String(body.occurredAt ?? new Date().toISOString()),
            _error_safe: body.errorSafe ? String(body.errorSafe).slice(0, 300) : null,
            _signature_key_id: String(req.headers["x-sync-key-id"]),
          });
          logger.log("callback_delivery_recorded", { eventUid: String(body.eventUid), state: result.state });
          return respond(200, { ok: true, duplicate: result.duplicate === true });
        }
        if (body.resourceType && body.providerEventId) {
          // Inbound resource callback — enters the review/conflict workflow.
          const result = await rpc("record_sync_inbound", {
            _connection_id: String(body.connectionId ?? ""),
            _provider_event_id: String(body.providerEventId),
            _contract_version: String(body.contractVersion ?? ""),
            _resource_type: String(body.resourceType),
            _payload: body.payload ?? {},
            _payload_hash: String(body.payloadHash ?? ""),
            _occurred_at: String(body.occurredAt ?? new Date().toISOString()),
            _external_resource_id: body.externalResourceId ? String(body.externalResourceId) : null,
            _resource_version: body.resourceVersion ? String(body.resourceVersion) : null,
            _signature_key_id: String(req.headers["x-sync-key-id"]),
          });
          logger.log("callback_inbound_recorded", {
            state: String(result.state ?? ""), replay: result.duplicate === true,
          });
          return respond(200, { ok: true, duplicate: result.duplicate === true });
        }
        return respond(400, { error: { code: "unroutable_callback" } });
      } catch (e) {
        const code = e instanceof SyncError ? e.code : "processing_failed";
        logger.log("callback_processing_failed", { errorCode: code });
        return respond(422, { error: { code } });
      }
    });
  };
  return createServer(handler);
}
