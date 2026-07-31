import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * PHASE 8A BOUNDARIES — the payment processor, proven from the outside:
 *
 *   1. the browser-reachable surface has NO way to assert a charge succeeded:
 *      `startCardPayment` returns only what is owed, and no environment
 *      variable can conjure a processor that would settle from the client;
 *   2. the two service_role processor RPCs (`attach_payment_processor_ref`,
 *      `record_billing_webhook`) are absent from every client-reachable
 *      module, so a compromised browser cannot even name them;
 *   3. tax is never a client input — no billing call sends one;
 *   4. adversarial: a request crafted to look like a settled payment (extra
 *      `succeeded`/`paid`/`status` fields, injected instructions in a reason)
 *      changes nothing — the refusal to assert success is structural, and the
 *      server is the only thing that can move money.
 */

const TOKEN = "signed-practitioner-token";
const ORG_ID = "10000000-0000-4000-8000-000000000001";
const INVOICE_ID = "20000000-0000-4000-8000-000000000001";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.CLINICAL_SUPABASE_URL = "https://clinical.example.test";
  process.env.CLINICAL_SUPABASE_ANON_KEY = "publishable-test-key";
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("payment processor boundary", () => {
  test("no environment variable can enable a client-side processor", async () => {
    // Names a misconfigured deploy (or an attacker) might try. None are read:
    // there is no processor module to populate on the client at all.
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_should_never_be_used");
    vi.stubEnv("NEXT_PUBLIC_STRIPE_KEY", "pk_test_anything");
    vi.stubEnv("PAYMENT_PROVIDER", "stripe");
    vi.stubEnv("NEXT_PUBLIC_PAYMENT_PROVIDER", "stripe");
    vi.stubEnv("ENABLE_FIXTURE_PAYMENTS", "1");
    vi.resetModules();

    const liveClient = await import("./live-client");
    const surface = JSON.stringify(Object.keys(liveClient.liveClient));
    // The client bridge can start a payment; it has no settle/capture verb.
    expect(surface).toContain("billingStartCardPayment");
    for (const forbidden of ["settle", "capture", "confirmPayment", "chargeCard"]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  test("the service_role processor RPCs are unreachable from client modules", async () => {
    const [liveClient, registry] = await Promise.all([
      import("./live-client"),
      import("./index"),
    ]);
    const text =
      JSON.stringify(Object.keys(liveClient.liveClient)) +
      JSON.stringify(Object.keys(registry.api)) +
      JSON.stringify(Object.keys(registry.api.billing)) +
      JSON.stringify(Object.keys(registry.api.inventory));
    expect(text).not.toContain("attach_payment_processor_ref");
    expect(text).not.toContain("record_billing_webhook");
    expect(text).not.toContain("webhook");
  });

  test("starting a card payment cannot report success, only what is owed", async () => {
    const { billingLive } = await import("./billing.live");
    // Even if the server were to echo extra fields, the contract the UI reads
    // has no success flag — the browser has nothing to render "paid" from.
    const fetchMock = vi.fn().mockResolvedValue(
      response({ paymentId: "payment-1", amountMinor: 11200, currency: "USD" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const started = await billingLive.startCardPayment(
      { invoiceId: INVOICE_ID, expectedVersion: 3, idempotencyKey: "idem-1" },
      ORG_ID,
      TOKEN,
    );

    expect(Object.keys(started).sort()).toEqual(["amountMinor", "currency", "paymentId"]);
  });

  test("adversarial: a payload dressed up as a settled charge settles nothing", async () => {
    const { billingLive } = await import("./billing.live");
    const fetchMock = vi.fn().mockResolvedValue(
      response({ paymentId: "payment-1", amountMinor: 11200, currency: "USD" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await billingLive.startCardPayment(
      {
        invoiceId: INVOICE_ID,
        expectedVersion: 3,
        // A caller trying to smuggle settlement through the idempotency key.
        idempotencyKey:
          "idem-1\", \"status\": \"succeeded\", \"paid_at\": \"2026-07-31T00:00:00Z",
      },
      ORG_ID,
      TOKEN,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    // JSON encoding keeps the injection inside the key value: it is data, not
    // structure. The RPC receives exactly four named arguments.
    expect(Object.keys(sent).sort()).toEqual([
      "_expected_version",
      "_idempotency_key",
      "_invoice_id",
      "_organization_id",
    ]);
    expect(sent).not.toHaveProperty("status");
    expect(sent).not.toHaveProperty("paid_at");
  });

  test("no billing write ever sends a tax amount", async () => {
    const { billingLive } = await import("./billing.live");
    const fetchMock = vi.fn().mockResolvedValue(response({ id: INVOICE_ID, version: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await billingLive.saveDraft(
      {
        invoiceId: INVOICE_ID,
        expectedVersion: 1,
        lines: [
          // A client insisting on its own tax figure; the adapter drops it
          // because the contract has no field for it.
          {
            productId: "product-1",
            quantity: 1,
            ...(({ taxMinor: 999999, taxRateBps: 0 } as unknown) as Record<string, never>),
          },
        ],
      },
      ORG_ID,
      TOKEN,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const lines = (JSON.parse(String(init.body)) as { _lines: Record<string, unknown>[] })._lines;
    expect(lines[0]).not.toHaveProperty("taxMinor");
    expect(lines[0]).not.toHaveProperty("taxRateBps");
  });

  test("a refund carries no restock instruction of any kind", async () => {
    const { billingLive } = await import("./billing.live");
    const fetchMock = vi.fn().mockResolvedValue(response({ id: INVOICE_ID, version: 6 }));
    vi.stubGlobal("fetch", fetchMock);

    await billingLive.refundPayment(
      { paymentId: "payment-1", amountMinor: 5000, reason: "patient returned product" },
      ORG_ID,
      TOKEN,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/rpc/refund_payment");
    const sent = JSON.stringify(JSON.parse(String(init.body)));
    for (const needle of ["restock", "quantity", "condition", "location"]) {
      expect(sent).not.toContain(needle);
    }
  });
});
