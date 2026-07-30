/**
 * PHI-safe structured telemetry.
 *
 * Logging is ALLOWLIST-only: a field that is not on the list is dropped, so
 * names, emails, DOBs, clinical text, payload bodies, invitation codes,
 * tokens, and secrets can never reach a log line even if a caller passes
 * them by mistake. String values are additionally length-capped.
 */
const ALLOWED_KEYS = new Set([
  "event", "provider", "contractVersion", "workerId", "cycle",
  "claimed", "succeeded", "retried", "deadLettered", "cancelled",
  "leaseReclaims", "circuitState", "errorClass", "errorCode",
  "maxQueueAgeSeconds", "queueAgeBand", "eventUid", "attempts",
  "state", "reason", "durationMs", "batch", "posture", "port",
  "replay", "deliverable", "count", "status",
]);
const MAX_VALUE_LENGTH = 80;

export function sanitizeFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value.slice(0, MAX_VALUE_LENGTH);
    }
    // objects/arrays are NEVER logged — payloads cannot leak structurally.
  }
  return out;
}

export function makeLogger(write = (line) => process.stdout.write(line + "\n")) {
  return {
    log(event, fields = {}) {
      write(JSON.stringify({ at: new Date().toISOString(), event, ...sanitizeFields(fields) }));
    },
  };
}
