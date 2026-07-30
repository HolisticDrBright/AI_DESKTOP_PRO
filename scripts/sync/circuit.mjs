/**
 * A bounded, observable, recoverable circuit breaker.
 *
 *   closed    — deliveries flow; consecutive failures are counted
 *   open      — after `failureThreshold` consecutive retryable failures,
 *               deliveries stop for `cooldownMs`
 *   half_open — after cooldown, a single probe is allowed; success closes
 *               the circuit, failure re-opens it
 */
export function createCircuit({ failureThreshold = 5, cooldownMs = 30_000, now = Date.now } = {}) {
  let state = "closed";
  let failures = 0;
  let openedAt = null;

  return {
    get state() {
      if (state === "open" && now() - openedAt >= cooldownMs) state = "half_open";
      return state;
    },
    get failureCount() {
      return failures;
    },
    canAttempt() {
      return this.state !== "open";
    },
    onSuccess() {
      state = "closed";
      failures = 0;
      openedAt = null;
    },
    onFailure() {
      failures += 1;
      if (state === "half_open" || failures >= failureThreshold) {
        state = "open";
        openedAt = now();
      }
    },
  };
}
