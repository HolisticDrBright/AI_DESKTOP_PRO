import { beforeEach, describe, expect, test, vi } from "vitest";
import { billingLive } from "./billing.live";

const TOKEN = "signed-practitioner-token";
const ORG_ID = "10000000-0000-4000-8000-000000000001";
const INVOICE_ID = "20000000-0000-4000-8000-000000000001";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The RPC name and argument object the adapter actually sent. */
function sentCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

beforeEach(() => {
  process.env.CLINICAL_SUPABASE_URL = "https://clinical.example.test";
  process.env.CLINICAL_SUPABASE_ANON_KEY = "publishable-test-key";
  vi.restoreAllMocks();
});

describe("billingLive Desktop Supabase boundary", () => {
  test("the workspace read passes every filter through untouched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ summary: { invoicedMinor: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    await billingLive.getWorkspace(
      { from: "2026-07-01T00:00:00Z", to: "2026-07-31T00:00:00Z", status: "open" },
      ORG_ID,
      TOKEN,
    );

    const { url, body } = sentCall(fetchMock);
    expect(url).toContain("/rest/v1/rpc/get_billing_workspace");
    expect(body).toEqual({
      _organization_id: ORG_ID,
      _from: "2026-07-01T00:00:00Z",
      _to: "2026-07-31T00:00:00Z",
      _status: "open",
      _practitioner_user_id: null,
      _location_id: null,
      _method: null,
    });
  });

  test("the invoice projection is returned as the server built it", async () => {
    const invoice = {
      id: INVOICE_ID,
      number: "INV-00001",
      status: "partially_paid",
      version: 4,
      totalMinor: 20700,
      paidMinor: 10000,
      balanceMinor: 10700,
      lines: [{ id: "line-1", taxRateBps: 800, taxMinor: 1200 }],
      payments: [],
      history: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(response(invoice));
    vi.stubGlobal("fetch", fetchMock);

    await expect(billingLive.getInvoice(INVOICE_ID, ORG_ID, TOKEN)).resolves.toEqual(invoice);
  });

  test("saving a draft sends NO tax field — the server computes it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: INVOICE_ID, version: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    await billingLive.saveDraft(
      {
        invoiceId: INVOICE_ID,
        expectedVersion: 2,
        locationId: null,
        lines: [
          { productId: "product-1", quantity: 2, discountMinor: 500, discountReason: "loyalty" },
        ],
      },
      ORG_ID,
      TOKEN,
    );

    const { url, body } = sentCall(fetchMock);
    expect(url).toContain("/rest/v1/rpc/save_invoice_draft");
    expect(body._expected_version).toBe(2);
    const lines = body._lines as Record<string, unknown>[];
    expect(lines[0]).toEqual({
      productId: "product-1",
      quantity: 2,
      discountMinor: 500,
      discountReason: "loyalty",
    });
    // The wire carries no tax of any spelling: tax is not a client input.
    expect(JSON.stringify(body).toLowerCase()).not.toContain("tax");
  });

  test("starting a card payment carries the idempotency key and claims no success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({ paymentId: "payment-1", amountMinor: 11200, currency: "USD" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const started = await billingLive.startCardPayment(
      { invoiceId: INVOICE_ID, expectedVersion: 5, idempotencyKey: "idem-1" },
      ORG_ID,
      TOKEN,
    );

    const { url, body } = sentCall(fetchMock);
    expect(url).toContain("/rest/v1/rpc/start_card_payment");
    expect(body._idempotency_key).toBe("idem-1");
    // The intent reports what is owed. There is no success/paid field to read.
    expect(started).toEqual({ paymentId: "payment-1", amountMinor: 11200, currency: "USD" });
    expect(started).not.toHaveProperty("succeeded");
    expect(started).not.toHaveProperty("paid");
  });

  test("a return demands its condition and reason on the wire", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await billingLive.returnStock(
      {
        locationId: "location-1",
        productId: "product-1",
        quantity: 1,
        condition: "damaged",
        reason: "opened, unusable",
        invoiceId: INVOICE_ID,
      },
      ORG_ID,
      TOKEN,
    );

    const { url, body } = sentCall(fetchMock);
    expect(url).toContain("/rest/v1/rpc/return_inventory_stock");
    expect(body._condition).toBe("damaged");
    expect(body._reason).toBe("opened, unusable");
  });

  test("an oversell conflict maps to a typed conflict without leaking the server message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({ code: "40001", message: "insufficient stock to finalize this sale" }, 409),
    );
    vi.stubGlobal("fetch", fetchMock);

    const failure = await billingLive
      .finalize({ invoiceId: INVOICE_ID, expectedVersion: 2 }, ORG_ID, TOKEN)
      .then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      );

    expect(failure?.code).toBe("conflict");
    expect(failure?.message).not.toContain("insufficient stock");
  });

  test("a role refusal maps to forbidden, a missing invoice to not_found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ code: "42501" }, 403)));
    const forbidden = await billingLive
      .recordManualPayment(
        { invoiceId: INVOICE_ID, expectedVersion: 1, amountMinor: 100, method: "cash" },
        ORG_ID,
        TOKEN,
      )
      .then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
    expect(forbidden?.code).toBe("forbidden");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ code: "P0002" }, 404)));
    const missing = await billingLive.getInvoice(INVOICE_ID, ORG_ID, TOKEN).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(missing?.code).toBe("not_found");
  });

  test("an invalid write (no discount reason) maps to invalid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ code: "22023" }, 400)));

    const failure = await billingLive
      .adjustStock(
        {
          locationId: "location-1",
          productId: "product-1",
          delta: -1,
          kind: "damaged",
          reason: "",
        },
        ORG_ID,
        TOKEN,
      )
      .then(
        () => null,
        (e: unknown) => e as { code?: string },
      );

    expect(failure?.code).toBe("invalid");
  });
});
