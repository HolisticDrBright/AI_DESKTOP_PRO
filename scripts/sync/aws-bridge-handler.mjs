import { randomUUID } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import { createAlpProvider, ALP_PROVIDER_NAME } from "./alp-provider.mjs";
import { createCircuit } from "./circuit.mjs";
import { SyncError } from "./errors.mjs";
import { verifyCallback } from "./hmac.mjs";
import { makeLogger } from "./redact.mjs";
import { createRpcClient } from "./supabase.mjs";
import { runCycle } from "./worker-core.mjs";

const MAX_BODY_BYTES = 65_536;
const logger = makeLogger();
let cachedSecret = null;

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function header(event, name) {
  const wanted = name.toLowerCase();
  const entry = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === wanted);
  return entry ? String(entry[1] ?? "") : "";
}

function requestPath(event) {
  return event.rawPath ?? event.requestContext?.http?.path ?? "";
}

function rawRequestBody(event) {
  const encoded = String(event.body ?? "");
  return Buffer.from(encoded, event.isBase64Encoded ? "base64" : "utf8");
}

async function loadBridgeSecret({ env = process.env, client = new SecretsManagerClient({}) } = {}) {
  if (cachedSecret) return cachedSecret;
  if (!env.SYNC_BRIDGE_SECRET_ARN) {
    throw new SyncError("security", "missing_bridge_secret", "sync bridge secret is not configured");
  }
  const result = await client.send(new GetSecretValueCommand({ SecretId: env.SYNC_BRIDGE_SECRET_ARN }));
  let parsed;
  try {
    parsed = JSON.parse(result.SecretString ?? "{}");
  } catch {
    throw new SyncError("security", "invalid_bridge_secret", "sync bridge secret is invalid");
  }
  for (const field of ["supabaseServiceRoleKey", "desktopToV2Secret", "v2ToDesktopSecret"]) {
    if (typeof parsed[field] !== "string" || parsed[field].length < 32) {
      throw new SyncError("security", "incomplete_bridge_secret", "sync bridge secret is incomplete");
    }
  }
  cachedSecret = parsed;
  return cachedSecret;
}

export function resetSecretCacheForTesting() {
  cachedSecret = null;
}

export function createSignedBridgeHandler({
  rpc,
  organizationId,
  callbackKeyId,
  callbackSecret,
  nowMs = () => Date.now(),
  log = logger,
}) {
  return async (event) => {
    const method = event.requestContext?.http?.method ?? event.httpMethod ?? "";
    const path = requestPath(event);
    const isVerify = method === "POST" && path === "/sync/verify";
    const isCallback = method === "POST" && path === "/sync/callback";
    if (!isVerify && !isCallback) return response(404, { error: { code: "not_found" } });
    if (!/^application\/json\b/i.test(header(event, "content-type"))) {
      return response(415, { error: { code: "unsupported_content_type" } });
    }
    const rawBody = rawRequestBody(event);
    if (rawBody.length > MAX_BODY_BYTES) return response(413, { error: { code: "payload_too_large" } });

    try {
      verifyCallback({
        rawBody,
        signature: header(event, "x-sync-signature"),
        keyId: header(event, "x-sync-key-id"),
        timestamp: header(event, "x-sync-timestamp"),
        nonce: header(event, "x-sync-nonce"),
        resolveSecret: (keyId) => keyId === callbackKeyId ? callbackSecret : null,
        nowMs: nowMs(),
      });
    } catch (error) {
      log.log("callback_refused", { errorClass: "security", errorCode: error.code ?? "invalid" });
      return response(401, { error: { code: error.code ?? "invalid_signature" } });
    }

    const nonceResult = await rpc("register_sync_callback_nonce", {
      _organization_id: organizationId,
      _provider: ALP_PROVIDER_NAME,
      _nonce: header(event, "x-sync-nonce"),
    });
    if (nonceResult.replay) return response(409, { error: { code: "replay" } });

    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return response(400, { error: { code: "invalid_json" } });
    }

    if (isVerify) {
      if (typeof body.token !== "string" || !body.token || typeof body.subject !== "string" || !body.subject) {
        return response(400, { error: { code: "invalid_verification_request" } });
      }
      try {
        const verified = await rpc("verify_sync_invitation", {
          _token: body.token,
          _external_subject_id: body.subject,
        });
        return response(200, {
          ok: true,
          connectionId: verified.connectionId,
          organizationId: verified.organizationId,
          contractVersion: verified.contractVersion,
        });
      } catch {
        return response(400, { error: { code: "invitation_invalid" } });
      }
    }

    try {
      if (body.kind && body.eventUid) {
        const result = await rpc("record_sync_delivery", {
          _event_uid: body.eventUid,
          _provider_event_id: String(body.providerEventId ?? ""),
          _kind: String(body.kind),
          _occurred_at: String(body.occurredAt ?? new Date().toISOString()),
          _error_safe: body.errorSafe ? String(body.errorSafe).slice(0, 300) : null,
          _signature_key_id: header(event, "x-sync-key-id"),
        });
        return response(200, { ok: true, duplicate: result.duplicate === true });
      }
      if (body.resourceType && body.providerEventId) {
        const result = await rpc(body.resourceType === "lab_result" ? "record_sync_lab_result" : "record_sync_inbound", {
          _connection_id: String(body.connectionId ?? ""),
          _provider_event_id: String(body.providerEventId),
          _contract_version: String(body.contractVersion ?? ""),
          _resource_type: String(body.resourceType),
          _payload: body.payload ?? {},
          _payload_hash: String(body.payloadHash ?? ""),
          _occurred_at: String(body.occurredAt ?? new Date().toISOString()),
          _external_resource_id: body.externalResourceId ? String(body.externalResourceId) : null,
          _resource_version: body.resourceVersion ? String(body.resourceVersion) : null,
          _signature_key_id: header(event, "x-sync-key-id"),
          _correlation_id: null,
        });
        return response(200, { ok: true, duplicate: result.duplicate === true });
      }
      return response(400, { error: { code: "unroutable_callback" } });
    } catch (error) {
      log.log("callback_processing_failed", { errorCode: error.code ?? "processing_failed" });
      return response(422, { error: { code: error.code ?? "processing_failed" } });
    }
  };
}

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new SyncError("security", `missing_${name.toLowerCase()}`, "sync bridge configuration is incomplete");
  return value;
}

export async function apiHandler(event) {
  const secret = await loadBridgeSecret();
  const rpc = createRpcClient({
    url: requiredEnv(process.env, "SYNC_SUPABASE_URL"),
    serviceKey: secret.supabaseServiceRoleKey,
  }).rpc;
  return createSignedBridgeHandler({
    rpc,
    organizationId: requiredEnv(process.env, "SYNC_ORGANIZATION_ID"),
    callbackKeyId: requiredEnv(process.env, "SYNC_CALLBACK_KEY_ID"),
    callbackSecret: secret.v2ToDesktopSecret,
  })(event);
}

export async function workerHandler() {
  const secret = await loadBridgeSecret();
  const organizationId = requiredEnv(process.env, "SYNC_ORGANIZATION_ID");
  const rpc = createRpcClient({
    url: requiredEnv(process.env, "SYNC_SUPABASE_URL"),
    serviceKey: secret.supabaseServiceRoleKey,
  }).rpc;
  const provider = createAlpProvider({
    baseUrl: requiredEnv(process.env, "SYNC_V2_BASE_URL"),
    secret: secret.desktopToV2Secret,
    keyId: requiredEnv(process.env, "SYNC_V2_KEY_ID"),
    organizationId,
  });
  return runCycle({
    rpc,
    provider,
    circuit: createCircuit(),
    logger,
    organizationId,
    batchSize: Number(process.env.SYNC_WORKER_BATCH ?? 10),
    leaseSeconds: Number(process.env.SYNC_WORKER_LEASE_SECONDS ?? 120),
    workerId: randomUUID(),
  });
}
