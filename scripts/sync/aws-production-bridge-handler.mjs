import { randomUUID } from "node:crypto";
import {
  BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand,
  RDSDataClient, RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import { createAlpProvider, ALP_PROVIDER_NAME } from "./alp-provider.mjs";
import { createCircuit } from "./circuit.mjs";
import { verifyCallback } from "./hmac.mjs";
import { makeLogger } from "./redact.mjs";
import { runCycle } from "./worker-core.mjs";

const MAX_BODY_BYTES = 262_144;
const logger = makeLogger();
let cachedSecret;

const RPC = {
  claim_sync_outbound: [["_organization_id", "uuid"], ["_limit", "integer"], ["_lease_seconds", "integer"], ["_worker_id", "uuid"]],
  recheck_sync_export: [["_event_uid", "uuid"]],
  record_sync_delivery: [["_event_uid", "uuid"], ["_provider_event_id", "text"], ["_kind", "text"], ["_occurred_at", "timestamptz"], ["_error_safe", "text"], ["_signature_key_id", "text"]],
  register_sync_callback_nonce: [["_organization_id", "uuid"], ["_provider", "text"], ["_nonce", "text"]],
  record_sync_inbound: [["_connection_id", "uuid"], ["_provider_event_id", "text"], ["_contract_version", "text"], ["_resource_type", "text"], ["_payload", "jsonb"], ["_payload_hash", "text"], ["_occurred_at", "timestamptz"], ["_external_resource_id", "text"], ["_resource_version", "text"], ["_signature_key_id", "text"], ["_correlation_id", "uuid"]],
  record_sync_lab_result: [["_connection_id", "uuid"], ["_provider_event_id", "text"], ["_contract_version", "text"], ["_resource_type", "text"], ["_payload", "jsonb"], ["_payload_hash", "text"], ["_occurred_at", "timestamptz"], ["_external_resource_id", "text"], ["_resource_version", "text"], ["_signature_key_id", "text"], ["_correlation_id", "uuid"]],
  record_sync_worker_cycle: [["_organization_id", "uuid"], ["_provider", "text"], ["_started_at", "timestamptz"], ["_claimed", "integer"], ["_succeeded", "integer"], ["_retried", "integer"], ["_dead_lettered", "integer"], ["_cancelled", "integer"], ["_lease_reclaims", "integer"], ["_circuit_state", "text"], ["_error_class", "text"], ["_max_queue_age_seconds", "integer"], ["_worker_id", "uuid"]],
};

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("production_sync_configuration_missing");
  return value;
}

function activated() {
  return process.env.PHI_ALLOWED === "true" && process.env.ACTIVATION_STATE === "approved"
    && /^[0-9a-f]{64}$/.test(process.env.ACTIVATION_EVIDENCE_SHA256 ?? "");
}

function response(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: JSON.stringify(body) };
}

function header(event, name) {
  const entry = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1] ?? "") : "";
}

function rawBody(event) {
  return Buffer.from(String(event.body ?? ""), event.isBase64Encoded ? "base64" : "utf8");
}

async function bridgeSecret(client = new SecretsManagerClient({})) {
  if (cachedSecret) return cachedSecret;
  const value = await client.send(new GetSecretValueCommand({ SecretId: required("SYNC_BRIDGE_SECRET_ARN") }));
  let secret;
  try { secret = JSON.parse(value.SecretString ?? "{}"); } catch { throw new Error("production_sync_secret_invalid"); }
  for (const key of ["desktopToV2Secret", "v2ToDesktopSecret"]) {
    if (typeof secret[key] !== "string" || secret[key].length < 32) throw new Error("production_sync_secret_invalid");
  }
  cachedSecret = secret;
  return secret;
}

function field(value, type) {
  if (value === null || value === undefined) return { isNull: true };
  if (type === "integer") return { longValue: Number(value) };
  if (type === "jsonb") return { stringValue: JSON.stringify(value) };
  return { stringValue: String(value) };
}

export function createAwsSyncRpc({ client = new RDSDataClient({}), clusterArn, secretArn, database }) {
  const common = { resourceArn: clusterArn, secretArn, database };
  return async (name, args) => {
    const signature = RPC[name];
    if (!signature) throw new Error("production_sync_rpc_refused");
    const begun = await client.send(new BeginTransactionCommand(common));
    const transactionId = begun.transactionId;
    if (!transactionId) throw new Error("production_sync_transaction_refused");
    try {
      await client.send(new ExecuteStatementCommand({ ...common, transactionId, sql: "set local role clinical_sync_worker" }));
      const parameters = signature.map(([key, type], index) => ({ name: `p${index + 1}`, value: field(args[key], type) }));
      const call = signature.map(([, type], index) => `:p${index + 1}::${type}`).join(",");
      const result = await client.send(new ExecuteStatementCommand({
        ...common, transactionId, includeResultMetadata: true,
        sql: `select clinical_core.${name}(${call}) as data`, parameters,
      }));
      const raw = result.records?.[0]?.[0]?.stringValue;
      if (typeof raw !== "string") throw new Error("production_sync_result_invalid");
      const decoded = JSON.parse(raw);
      await client.send(new CommitTransactionCommand({ ...common, transactionId }));
      return decoded;
    } catch (error) {
      try { await client.send(new RollbackTransactionCommand({ ...common, transactionId })); } catch { /* bounded */ }
      throw error;
    }
  };
}

function configuredRpc() {
  return createAwsSyncRpc({
    clusterArn: required("CLINICAL_DATABASE_CLUSTER_ARN"),
    secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
    database: required("CLINICAL_DATABASE_NAME"),
  });
}

export async function apiHandler(event) {
  if (!activated()) return response(503, { error: "production_not_activated", phiAllowed: false });
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "";
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
  if (method !== "POST" || path !== "/patient-sync/v1/callback") return response(404, { error: "route_not_found" });
  if (!/^application\/json\b/i.test(header(event, "content-type"))) return response(415, { error: "unsupported_content_type" });
  const bytes = rawBody(event);
  if (bytes.length < 2 || bytes.length > MAX_BODY_BYTES) return response(413, { error: "payload_size_invalid" });
  const secret = await bridgeSecret();
  try {
    verifyCallback({ rawBody: bytes, signature: header(event, "x-sync-signature"), keyId: header(event, "x-sync-key-id"),
      timestamp: header(event, "x-sync-timestamp"), nonce: header(event, "x-sync-nonce"),
      resolveSecret: (keyId) => keyId === required("SYNC_CALLBACK_KEY_ID") ? secret.v2ToDesktopSecret : null });
  } catch { return response(401, { error: "invalid_signature" }); }
  const rpc = configuredRpc();
  let nonce;
  try {
    nonce = await rpc("register_sync_callback_nonce", { _organization_id: required("SYNC_ORGANIZATION_ID"),
      _provider: ALP_PROVIDER_NAME, _nonce: header(event, "x-sync-nonce") });
  } catch { return response(422, { error: "callback_processing_refused" }); }
  if (nonce.replay) return response(409, { error: "replay" });
  let body;
  try { body = JSON.parse(bytes.toString("utf8")); } catch { return response(400, { error: "invalid_json" }); }
  try {
    if (body.kind && body.eventUid) {
      const data = await rpc("record_sync_delivery", { _event_uid: body.eventUid, _provider_event_id: body.providerEventId,
        _kind: body.kind, _occurred_at: body.occurredAt, _error_safe: body.errorSafe ?? null,
        _signature_key_id: header(event, "x-sync-key-id") });
      return response(200, { ok: true, duplicate: data.duplicate === true });
    }
    if (body.resourceType && body.providerEventId) {
      const data = await rpc(body.resourceType === "lab_result" ? "record_sync_lab_result" : "record_sync_inbound", {
        _connection_id: body.connectionId, _provider_event_id: body.providerEventId,
        _contract_version: body.contractVersion, _resource_type: body.resourceType, _payload: body.payload ?? {},
        _payload_hash: body.payloadHash, _occurred_at: body.occurredAt,
        _external_resource_id: body.externalResourceId ?? null, _resource_version: body.resourceVersion ?? null,
        _signature_key_id: header(event, "x-sync-key-id"), _correlation_id: body.correlationId ?? null,
      });
      return response(200, { ok: true, duplicate: data.duplicate === true, state: data.state });
    }
    return response(400, { error: "unroutable_callback" });
  } catch { return response(422, { error: "callback_processing_refused" }); }
}

export async function workerHandler() {
  if (!activated()) return { posture: "disabled", phiAllowed: false };
  const secret = await bridgeSecret();
  const organizationId = required("SYNC_ORGANIZATION_ID");
  const provider = createAlpProvider({ baseUrl: required("SYNC_V2_BASE_URL"), secret: secret.desktopToV2Secret,
    keyId: required("SYNC_V2_KEY_ID"), organizationId });
  return runCycle({ rpc: configuredRpc(), provider, circuit: createCircuit(), logger, organizationId,
    batchSize: Number(process.env.SYNC_WORKER_BATCH ?? 10), leaseSeconds: Number(process.env.SYNC_WORKER_LEASE_SECONDS ?? 120),
    workerId: randomUUID() });
}
