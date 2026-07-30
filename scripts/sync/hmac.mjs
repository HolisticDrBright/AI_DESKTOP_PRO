/**
 * Callback signature scheme for patient-sync/1.
 *
 * The signature is an HMAC-SHA256 over the RAW request bytes plus the
 * timestamp and nonce (`v1:<timestamp>:<nonce>:<rawBody>`), keyed by a
 * rotatable secret identified by `keyId`. Verification:
 *
 *   1. resolves the secret by keyId (unknown key -> refused),
 *   2. enforces the timestamp tolerance window,
 *   3. compares signatures with a CONSTANT-TIME comparison,
 *   4. only then may the caller parse the body.
 *
 * Nothing here logs or returns body content.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { SyncError } from "./errors.mjs";

export function signCallback({ rawBody, secret, timestamp, nonce }) {
  const material = `v1:${timestamp}:${nonce}:`;
  const h = createHmac("sha256", secret);
  h.update(material, "utf8");
  h.update(rawBody);
  return h.digest("hex");
}

/**
 * Verify a callback BEFORE any parsing. Throws SyncError('security', ...)
 * on any violation. `rawBody` must be the exact bytes received.
 */
export function verifyCallback({
  rawBody,
  signature,
  keyId,
  timestamp,
  nonce,
  resolveSecret,
  nowMs = Date.now(),
  toleranceMs = 5 * 60_000,
}) {
  if (!signature || !keyId || !timestamp || !nonce) {
    throw new SyncError("security", "missing_signature_headers", "callback signature headers missing");
  }
  const secret = resolveSecret(keyId);
  if (!secret) {
    throw new SyncError("security", "unknown_key_id", "callback key id is not recognized");
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > toleranceMs) {
    throw new SyncError("security", "timestamp_outside_tolerance", "callback timestamp outside tolerance");
  }
  const expected = signCallback({ rawBody, secret, timestamp, nonce });
  const a = Buffer.from(expected, "hex");
  const b = /^[0-9a-f]+$/i.test(signature) && signature.length === expected.length
    ? Buffer.from(signature, "hex")
    : null;
  if (!b || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new SyncError("security", "invalid_signature", "callback signature is invalid");
  }
  return true;
}
