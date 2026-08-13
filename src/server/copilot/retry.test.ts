import { describe, expect, test } from "vitest";
import {
  classifyProviderError,
  isRetryable,
  withRetry,
  DEFAULT_RETRY_POLICY,
} from "./retry";

describe("classifyProviderError — retry classes", () => {
  test("network reset → retryable_transport", () => {
    expect(classifyProviderError({})).toBe("retryable_transport");
  });
  test("429 → retryable_throttling", () => {
    expect(classifyProviderError({ httpStatus: 429 })).toBe("retryable_throttling");
  });
  test("502/503/504 → retryable_transient_5xx", () => {
    expect(classifyProviderError({ httpStatus: 502 })).toBe("retryable_transient_5xx");
    expect(classifyProviderError({ httpStatus: 503 })).toBe("retryable_transient_5xx");
    expect(classifyProviderError({ httpStatus: 504 })).toBe("retryable_transient_5xx");
  });
  test("501/500/505 → unknown_failure (NOT retried)", () => {
    expect(classifyProviderError({ httpStatus: 500 })).toBe("unknown_failure");
    expect(classifyProviderError({ httpStatus: 501 })).toBe("unknown_failure");
  });
});

describe("classifyProviderError — never-retry classes", () => {
  test("401/403 → authorization", () => {
    expect(classifyProviderError({ httpStatus: 401 })).toBe("authorization");
    expect(classifyProviderError({ httpStatus: 403 })).toBe("authorization");
  });
  test("400 with content_policy → safety_refusal", () => {
    expect(classifyProviderError({ httpStatus: 400, providerCode: "content_policy" })).toBe("safety_refusal");
  });
  test("400 with unsupported_model → invalid_model", () => {
    expect(classifyProviderError({ httpStatus: 400, providerCode: "unsupported_model" })).toBe("invalid_model");
  });
  test("400 with baa_missing → baa_or_retention", () => {
    expect(classifyProviderError({ httpStatus: 400, providerCode: "baa_missing" })).toBe("baa_or_retention");
  });
  test("400 with retention_violation → baa_or_retention", () => {
    expect(classifyProviderError({ httpStatus: 400, providerCode: "retention_violation" })).toBe("baa_or_retention");
  });
  test("400 with no provider code → policy_refusal", () => {
    expect(classifyProviderError({ httpStatus: 400 })).toBe("policy_refusal");
  });
  test("malformed → malformed_output", () => {
    expect(classifyProviderError({ parseError: "openai_malformed_output" })).toBe("malformed_output");
  });
  test("hallucinated citation → citation_validation", () => {
    expect(classifyProviderError({ parseError: "openai_hallucinated_citation" })).toBe("citation_validation");
  });
});

describe("isRetryable", () => {
  test("only retryable_* categories are retryable", () => {
    expect(isRetryable("retryable_transport")).toBe(true);
    expect(isRetryable("retryable_throttling")).toBe(true);
    expect(isRetryable("retryable_transient_5xx")).toBe(true);
    expect(isRetryable("authorization")).toBe(false);
    expect(isRetryable("safety_refusal")).toBe(false);
    expect(isRetryable("baa_or_retention")).toBe(false);
    expect(isRetryable("invalid_model")).toBe(false);
    expect(isRetryable("malformed_output")).toBe(false);
    expect(isRetryable("citation_validation")).toBe(false);
    expect(isRetryable("policy_refusal")).toBe(false);
    expect(isRetryable("revoked_provider")).toBe(false);
    expect(isRetryable("timeout")).toBe(false);
    expect(isRetryable("cancelled")).toBe(false);
  });
});

describe("withRetry", () => {
  test("succeeds on first attempt", async () => {
    const res = await withRetry(
      async () => "ok",
      () => "unknown_failure",
      { sleep: async () => {} },
    );
    expect(res).toBe("ok");
  });

  test("retries retryable transport up to maxAttempts", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("boom");
        },
        () => "retryable_transport",
        { policy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  test("never-retry classes throw immediately", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("boom");
        },
        () => "authorization",
        { policy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 5 }, sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("cancellation via AbortSignal aborts mid-op", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    await expect(
      withRetry(
        async () =>
          await new Promise<string>((_, rej) => {
            setTimeout(() => rej(new Error("late")), 200);
          }),
        () => "retryable_transport",
        {
          policy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 5, timeoutMs: 100 },
          sleep: async () => {},
          signal: ctl.signal,
        },
      ),
    ).rejects.toThrow();
  });

  test("timeout collapses to timeout category", async () => {
    await expect(
      withRetry(
        async () =>
          await new Promise<string>((_, rej) => {
            setTimeout(() => rej(new Error("late")), 200);
          }),
        () => "timeout",
        {
          policy: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, timeoutMs: 5 },
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(/timeout|late/);
  });
});
