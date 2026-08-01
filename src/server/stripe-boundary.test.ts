import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createCustomer,
  getStripeConfig,
  mapSubscriptionStatus,
  requireStripe,
  verifyWebhookSignature,
} from "./stripe-boundary";

/**
 * PHASE 8B BOUNDARY — the Stripe test-mode subscription adapter, proven from
 * the outside:
 *
 *   1. it is DISABLED by default and refuses without configuration;
 *   2. a LIVE secret key or live webhook secret is refused outright;
 *   3. signatures are verified over the RAW body — a tampered payload, a
 *      wrong secret, a malformed header, or a stale timestamp all refuse;
 *   4. a correctly signed LIVE-mode event is STILL refused;
 *   5. there is no fixture fallback: nothing ever fabricates a customer,
 *      subscription, or settlement;
 *   6. an unknown processor status is never guessed.
 */

const TEST_SECRET = "whsec_test_secret_for_signature_verification";

function configure(overrides: Record<string, string> = {}) {
  vi.stubEnv("STRIPE_TEST_MODE_ENABLED", "1");
  vi.stubEnv("STRIPE_TEST_SECRET_KEY", "sk_test_abc123");
  vi.stubEnv("STRIPE_TEST_WEBHOOK_SECRET", TEST_SECRET);
  for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
}

/** Build a genuine Stripe-format signature header for a raw body. */
function sign(rawBody: string, secret = TEST_SECRET, timestamp?: number) {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

function event(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_test_1",
    type: "customer.subscription.updated",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "sub_test_1", status: "active" } },
    ...overrides,
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("disabled by default", () => {
  test("with no configuration the boundary is disabled and says why", () => {
    const report = getStripeConfig();
    expect(report.mode).toBe("disabled");
    expect(report.configured).toBe(false);
    expect(report.problems.join(" ")).toMatch(/STRIPE_TEST_MODE_ENABLED/);
  });

  test("requireStripe throws not_configured rather than degrading", () => {
    const failure = (() => {
      try {
        requireStripe();
        return null;
      } catch (e) {
        return e as { code?: string; problems?: string[] };
      }
    })();
    expect(failure?.code).toBe("not_configured");
    // The refusal names the missing variable, never a secret value.
    expect(JSON.stringify(failure?.problems)).not.toContain("sk_");
  });

  test("enabling the flag alone is not enough — keys are still required", () => {
    vi.stubEnv("STRIPE_TEST_MODE_ENABLED", "1");
    const report = getStripeConfig();
    expect(report.configured).toBe(false);
    expect(report.problems.join(" ")).toMatch(/STRIPE_TEST_SECRET_KEY is missing/);
  });

  test("no API call is possible while unconfigured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createCustomer({ organizationId: "org", patientId: "pat" }),
    ).rejects.toMatchObject({ code: "not_configured" });
    // Crucially: it refused BEFORE reaching the network.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("live credentials and live objects are refused", () => {
  test("a live secret key is a configuration error, not an upgrade path", () => {
    configure({ STRIPE_TEST_SECRET_KEY: "sk_live_realmoney" });
    const report = getStripeConfig();
    expect(report.configured).toBe(false);
    expect(report.mode).toBe("disabled");
    expect(report.problems.join(" ")).toMatch(/LIVE key/);
  });

  test("a restricted live key is refused too", () => {
    configure({ STRIPE_TEST_SECRET_KEY: "rk_live_restricted" });
    expect(getStripeConfig().configured).toBe(false);
  });

  test("a non-whsec webhook secret is refused", () => {
    configure({ STRIPE_TEST_WEBHOOK_SECRET: "not_a_webhook_secret" });
    expect(getStripeConfig().configured).toBe(false);
  });

  test("a correctly signed LIVE-mode event is still refused", () => {
    configure();
    const raw = event({ livemode: true });
    // The signature is genuinely valid — the refusal is about livemode.
    expect(() => verifyWebhookSignature(raw, sign(raw))).toThrow(/live-mode/i);
  });
});

describe("signature verification over the raw body", () => {
  test("a correctly signed test-mode event verifies", () => {
    configure();
    const raw = event();
    const verified = verifyWebhookSignature(raw, sign(raw));
    expect(verified.id).toBe("evt_test_1");
    expect(verified.livemode).toBe(false);
  });

  test("a TAMPERED body fails even with the original signature", () => {
    configure();
    const raw = event();
    const header = sign(raw);
    const tampered = raw.replace('"status":"active"', '"status":"canceled"');
    expect(() => verifyWebhookSignature(tampered, header)).toThrow(/verification failed/i);
  });

  test("a signature from the WRONG secret fails", () => {
    configure();
    const raw = event();
    expect(() => verifyWebhookSignature(raw, sign(raw, "whsec_attacker_secret"))).toThrow(
      /verification failed/i,
    );
  });

  test("a REPLAYED payload outside the tolerance window fails", () => {
    configure();
    const raw = event();
    const oldTimestamp = Math.floor(Date.now() / 1000) - 4000;
    expect(() => verifyWebhookSignature(raw, sign(raw, TEST_SECRET, oldTimestamp))).toThrow(
      /tolerance/i,
    );
  });

  test("a missing or malformed header fails", () => {
    configure();
    const raw = event();
    expect(() => verifyWebhookSignature(raw, null)).toThrow(/Missing signature/i);
    expect(() => verifyWebhookSignature(raw, "garbage")).toThrow(/Malformed/i);
    expect(() => verifyWebhookSignature(raw, "t=123")).toThrow(/Malformed/i);
  });

  test("multiple v1 signatures are accepted (secret rotation)", () => {
    configure();
    const raw = event();
    const t = Math.floor(Date.now() / 1000);
    const good = createHmac("sha256", TEST_SECRET).update(`${t}.${raw}`).digest("hex");
    const header = `t=${t},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${good}`;
    expect(verifyWebhookSignature(raw, header).id).toBe("evt_test_1");
  });

  test("a body that is not valid JSON is refused after signature check", () => {
    configure();
    const raw = "not json at all";
    expect(() => verifyWebhookSignature(raw, sign(raw))).toThrow(/not valid JSON/i);
  });
});

describe("no fixture fallback, no guessing", () => {
  test("no environment variable can enable a fixture processor", () => {
    vi.stubEnv("STRIPE_FIXTURE_MODE", "1");
    vi.stubEnv("ENABLE_FIXTURE_PAYMENTS", "1");
    vi.stubEnv("PAYMENT_PROVIDER", "fixture");
    // Still disabled: only the real test-mode variables count, and there is
    // no fixture branch to reach.
    expect(getStripeConfig().mode).toBe("disabled");
  });

  test("a live object returned by the API is refused mid-flight", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "cus_1", livemode: true }), { status: 200 }),
      ),
    );
    await expect(
      createCustomer({ organizationId: "org", patientId: "pat" }),
    ).rejects.toThrow(/live-mode object/i);
  });

  test("an API error surfaces a code, never the processor's echoed message", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { type: "card_error", code: "card_declined", message: "Card 4242 declined" },
          }),
          { status: 402 },
        ),
      ),
    );
    const failure = await createCustomer({ organizationId: "o", patientId: "p" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(failure?.message).toContain("card_declined");
    // The echoed message could carry submitted data; it must not propagate.
    expect(failure?.message).not.toContain("4242");
  });

  test("customer creation sends an idempotency key and no card data", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "cus_1", livemode: false }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await createCustomer({ organizationId: "org-1", patientId: "pat-1" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("customer:org-1:pat-1");
    const body = String(init.body);
    // No card data of any kind crosses this boundary — only identifiers.
    for (const forbidden of ["number", "cvc", "exp_month", "exp_year", "card"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  test("an unknown subscription status is never guessed", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("past_due")).toBe("past_due");
    // A status this build does not know maps to null so the caller records an
    // exception instead of inventing a state.
    expect(mapSubscriptionStatus("some_future_status")).toBeNull();
  });
});
