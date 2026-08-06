/**
 * Phase 10B.1 — timeout + bounded retry policy for governed copilot calls.
 *
 * SERVER-ONLY. This module does not know anything about the specific
 * provider — it takes an operation and a classifier and enforces the rule
 * set below.
 *
 * Retry classes (retryable):
 *   - retryable_transport (network reset, DNS failure, TLS reset)
 *   - retryable_throttling (HTTP 429)
 *   - retryable_transient_5xx (HTTP 502, 503, 504)
 *
 * Never-retry classes:
 *   - policy_refusal (400 with a policy category)
 *   - authorization (401, 403)
 *   - safety_refusal (400 with a safety category or provider "content_policy")
 *   - baa_or_retention (400 with a baa_missing / retention_violation code)
 *   - invalid_model (400 with unsupported_model)
 *   - malformed_output (validator threw openai_malformed_output)
 *   - schema_validation (validator threw JSON-schema mismatch)
 *   - citation_validation (validator threw openai_hallucinated_citation)
 *   - revoked_provider (adapter-side, refuses before transport)
 *   - cancelled (AbortSignal fired)
 *
 * PHI-safe failure category is returned by every path — raw error text
 * never surfaces.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/retry is server-only.");
}

export type FailureCategory =
  | "retryable_transport"
  | "retryable_throttling"
  | "retryable_transient_5xx"
  | "policy_refusal"
  | "authorization"
  | "safety_refusal"
  | "baa_or_retention"
  | "invalid_model"
  | "malformed_output"
  | "schema_validation"
  | "citation_validation"
  | "revoked_provider"
  | "cancelled"
  | "timeout"
  | "unknown_failure";

const RETRYABLE = new Set<FailureCategory>([
  "retryable_transport",
  "retryable_throttling",
  "retryable_transient_5xx",
]);

export function isRetryable(category: FailureCategory): boolean {
  return RETRYABLE.has(category);
}

export type RetryPolicy = {
  maxAttempts: number; // total attempts, not additional
  baseBackoffMs: number;
  maxBackoffMs: number;
  timeoutMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseBackoffMs: 200,
  maxBackoffMs: 2000,
  timeoutMs: 20_000,
};

export type ClassifiedError = { category: FailureCategory; message?: string };

export function classifyProviderError(input: {
  httpStatus?: number;
  providerCode?: string;
  parseError?: string;
}): FailureCategory {
  const { httpStatus, providerCode, parseError } = input;
  if (parseError === "openai_malformed_output") return "malformed_output";
  if (parseError === "openai_hallucinated_citation") return "citation_validation";
  if (parseError === "openai_endpoint_not_https") return "authorization";
  if (parseError === "openai_key_shape_invalid") return "authorization";
  if (providerCode === "content_policy") return "safety_refusal";
  if (providerCode === "unsupported_model") return "invalid_model";
  if (providerCode === "baa_missing" || providerCode === "retention_violation") return "baa_or_retention";
  if (httpStatus == null) return "retryable_transport";
  if (httpStatus === 429) return "retryable_throttling";
  if (httpStatus === 401 || httpStatus === 403) return "authorization";
  if (httpStatus >= 500 && httpStatus < 600) {
    if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return "retryable_transient_5xx";
    return "unknown_failure";
  }
  if (httpStatus >= 400 && httpStatus < 500) return "policy_refusal";
  return "unknown_failure";
}

export type WithRetryContext = {
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  classify: (err: unknown) => FailureCategory,
  ctx: WithRetryContext = {},
): Promise<T> {
  const policy = ctx.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let attempt = 0;
  while (true) {
    attempt += 1;
    if (ctx.signal?.aborted) {
      throw Object.assign(new Error("cancelled"), { category: "cancelled" as FailureCategory });
    }
    try {
      // Wrap operation in a timeout race.
      return await withTimeout(operation(attempt), policy.timeoutMs, ctx.signal);
    } catch (err) {
      const category = classify(err);
      if (!isRetryable(category) || attempt >= policy.maxAttempts) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { category });
      }
      const backoff = Math.min(policy.baseBackoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);
      await sleep(backoff);
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { category: "timeout" as FailureCategory })), ms);
  });
  const abort = new Promise<never>((_, rej) => {
    if (!signal) return;
    if (signal.aborted) rej(Object.assign(new Error("cancelled"), { category: "cancelled" as FailureCategory }));
    signal.addEventListener(
      "abort",
      () => rej(Object.assign(new Error("cancelled"), { category: "cancelled" as FailureCategory })),
      { once: true },
    );
  });
  try {
    return await Promise.race([p, timeout, abort]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
