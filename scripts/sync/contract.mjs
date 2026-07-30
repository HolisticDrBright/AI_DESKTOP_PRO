/**
 * patient-sync/1 outbound-envelope runtime validation.
 *
 * The worker validates every claimed envelope BEFORE handing it to any
 * provider, and every provider adapter receives exactly this shape. Unknown
 * fields, wrong versions, malformed hashes, and oversized payloads fail
 * closed as `contract` errors (dead-letter, never retried).
 */
import { createHash } from "node:crypto";
import { SyncError } from "./errors.mjs";

export const CONTRACT_VERSION = "patient-sync/1";
export const MAX_PAYLOAD_BYTES = 65536;

const REQUIRED_FIELDS = [
  "eventId", "eventUid", "contractVersion", "connectionId", "idempotencyKey",
  "scope", "resourceType", "resourceId", "resourceVersion", "occurredAt",
  "producer", "provenance", "payload", "payloadHash", "attempts",
];
const OPTIONAL_FIELDS = ["correlationId", "leaseExpiresAt"];
const KNOWN_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Throws SyncError('contract', ...) on any violation; returns the envelope. */
export function validateOutboundEnvelope(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SyncError("contract", "not_an_object", "envelope is not an object");
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new SyncError("contract", "unknown_field", `unknown envelope field: ${key}`);
    }
  }
  for (const key of REQUIRED_FIELDS) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new SyncError("contract", "missing_field", `missing envelope field: ${key}`);
    }
  }
  if (raw.contractVersion !== CONTRACT_VERSION) {
    throw new SyncError(
      "contract",
      "unsupported_contract_version",
      `unsupported contract version: ${String(raw.contractVersion)}`,
    );
  }
  if (typeof raw.payload !== "object" || Array.isArray(raw.payload)) {
    throw new SyncError("contract", "payload_not_object", "payload must be an object");
  }
  const payloadText = JSON.stringify(raw.payload);
  if (Buffer.byteLength(payloadText, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new SyncError("contract", "payload_too_large", "payload exceeds the size limit");
  }
  if (typeof raw.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.payloadHash)) {
    throw new SyncError("contract", "malformed_hash", "payloadHash is not a sha256 hex digest");
  }
  return raw;
}
