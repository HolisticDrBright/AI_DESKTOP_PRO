/**
 * Sync worker error taxonomy. Every failure the worker can see is classified
 * into exactly one class, and the class — not the raw error — decides retry
 * behavior:
 *
 *   retryable  — transient transport/provider trouble; bounded backoff retry
 *   permanent  — provider rejected the envelope; dead-letter, never retried
 *   contract   — DTO/version/hash violations; dead-letter, never retried
 *   security   — signature/tenant/binding violations; dead-letter, never
 *                retried, and surfaced loudly
 *   consent    — consent/connection withdrawn; durable cancellation (the
 *                recheck RPC owns the state change), never retried
 */
export class SyncError extends Error {
  constructor(errorClass, code, message, { retryAfterMs = null } = {}) {
    super(message);
    this.name = "SyncError";
    this.errorClass = errorClass;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export const NON_RETRYABLE_CLASSES = ["permanent", "contract", "security", "consent"];

export function isRetryable(error) {
  return error instanceof SyncError && error.errorClass === "retryable";
}

/** Map a provider HTTP status to an error class per the contract. */
export function classifyHttpStatus(status, { retryAfterMs = null } = {}) {
  if (status === 429) {
    return new SyncError("retryable", "rate_limited", "provider rate limit", { retryAfterMs });
  }
  if (status >= 500) {
    return new SyncError("retryable", `http_${status}`, "provider server error");
  }
  if (status === 401 || status === 403) {
    return new SyncError("security", `http_${status}`, "provider refused credentials");
  }
  if (status >= 400) {
    return new SyncError("permanent", `http_${status}`, "provider rejected the envelope");
  }
  return new SyncError("retryable", `http_${status}`, "unexpected provider status");
}
