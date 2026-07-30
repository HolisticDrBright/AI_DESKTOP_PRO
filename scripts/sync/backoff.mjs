/**
 * Exponential backoff with bounded jitter. Deterministic when `rand` is
 * injected (tests); the database's own bounded backoff remains the authority
 * for persisted next_retry_at — this local delay only paces the worker loop.
 */
export function backoffMs(attempt, { baseMs = 1000, capMs = 60_000, jitterRatio = 0.2, rand = Math.random } = {}) {
  const exp = Math.min(baseMs * 2 ** Math.max(attempt, 0), capMs);
  const jitter = exp * jitterRatio * rand();
  return Math.min(Math.round(exp + jitter), capMs);
}
