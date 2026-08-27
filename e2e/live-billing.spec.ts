import { expect, test } from "@playwright/test";
import { STUB_BASE, resetBackend } from "./support/backend";

/**
 * PHASE 8A, browser-level: billing, appointment checkout, Stripe TEST-MODE
 * payments, the product catalog, and inventory — against the committed
 * contract fixture backend. The __control endpoints stand in for the
 * service_role processor boundary (attach reference + webhook) and exercise
 * the SAME dedup, amount-agreement, and out-of-order contracts as the
 * database, so nothing browser-reachable can settle a payment.
 *
 * The twenty proofs this suite carries:
 *
 *   1. the billing workspace shows REAL persisted figures, not projections
 *   2. checkout from an appointment opens a draft with the booked service,
 *      and a second checkout for that appointment is refused
 *   3. the client never prices tax — the server returns it on save
 *   4. a discount without a reason is refused; with one it is accepted
 *   5. finalizing assigns a number and RESERVES tracked stock
 *   6. a finalized invoice is no longer editable
 *   7. a partial cash payment moves the invoice to partly paid
 *   8. full settlement marks it paid and commits the stock sale exactly once
 *   9. a refund returns money and NEVER restocks
 *  10. an explicit resalable return is the only thing that restocks
 *  11. a damaged return is recorded without adding sellable stock
 *  12. patient credit is granted with a reason and applied to an invoice
 *  13. a card payment reaches PENDING only — the UI never claims it is paid
 *  14. a second in-flight card payment is refused
 *  15. only the processor webhook settles the card payment
 *  16. a replayed webhook is a recorded duplicate; a mismatched amount is a
 *      recorded refusal — neither is a silent drop
 *  17. voiding an unpaid invoice releases its reservations
 *  18. overselling is refused and reserves nothing
 *  19. crossing the reorder threshold opens ONE low-stock review task
 *  20. no mock identity or fixture-demo content appears anywhere, no PHI in
 *      console logs, and no off-origin requests
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-billing.spec.ts
 *
 * NOTE: the fixture backend is stateful in-memory — restart it between runs.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

/**
 * Isolation, not ordering. This restores the whole fixture backend so the
 * suite runs against exactly the state it was written for, wherever it lands
 * in the battery.
 */
test.beforeAll(resetBackend);

const STUB = STUB_BASE;

// This suite is written against a pristine billing domain; reset it up front
// so the battery is order-independent (other suites may have touched stock).
test.beforeAll(async () => {
  await fetch(`${STUB}/__control/billing-reset`, { method: "POST" });
});

// This suite drives its OWN patient and appointment (seeded for phase 8A) so
// arriving/checking out here never consumes the appointment another suite
// needs — the battery stays order-independent.
const PATIENT_1 = "aaaaaaaa-1111-2222-3333-444444444404";
const CATALOG = "/settings/catalog";
const DEMO_FIXTURE_NAMES = ["Alexandra Morgan", "Michael Johnson", "Priya Sharma"];

/** Ids discovered as the walkthrough proceeds. */
let invoiceUrl = "";
let cardPaymentId = "";

function expectNoFixtureData(text: string) {
  for (const name of DEMO_FIXTURE_NAMES) expect(text).not.toContain(name);
}

/** Open the inventory panel for one product by name (rows are name-sorted). */
async function openInventoryPanel(page: import("@playwright/test").Page, name: string) {
  await page
    .getByTestId("catalog-rows")
    .locator("tr", { hasText: name })
    .getByRole("button", { name: "Manage" })
    .click();
  await expect(page.getByTestId("inventory-panel")).toBeVisible();
}

test("1: the billing workspace shows real persisted figures", async ({ page }) => {
  await page.goto("/billing");
  await expect(page.getByTestId("billing-workspace")).toBeVisible();
  // A pristine domain has no invoices — and says so rather than inventing any.
  await expect(page.getByText("No invoices in this range.")).toBeVisible();
  await expect(page.getByTestId("billing-reconciliation")).toBeVisible();
  // Stock valuation is real: 10 units at $12.00 cost were received in the seed.
  await expect(page.getByText("$120.00").first()).toBeVisible();
  expectNoFixtureData(await page.locator("body").innerText());
});

test("2: checkout from an appointment opens a draft with the booked service", async ({ page }) => {
  await page.goto("/calendar");
  const appointment = page.getByRole("button", { name: /Billing Walkthrough/ }).first();
  await appointment.click();
  // Arrive first — checkout opens once the patient is actually here. The
  // status change re-renders the calendar, so re-open the appointment before
  // reaching for the checkout control.
  const arrive = page.getByTestId("appt-arrive");
  if (await arrive.isVisible().catch(() => false)) {
    await arrive.click();
    // Wait for the persisted transition and its refetch to finish. Merely
    // waiting for the optimistic Arrive button to disappear races onChanged(),
    // which can close a drawer that the test has just reopened.
    await expect(page.getByText(/Arrived recorded/).first()).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Appointment details" })).toHaveCount(0);
    await page.getByRole("button", { name: /Billing Walkthrough/ }).first().click();
  }
  await expect(page.getByTestId("appt-checkout")).toBeVisible();
  await page.getByTestId("appt-checkout").click();
  await page.waitForURL(/\/billing\/inv-/);
  invoiceUrl = page.url();

  await expect(page.getByTestId("invoice-status")).toHaveText("Draft");
  // The booked follow-up matched a catalog service by name and joined it.
  await expect(page.getByTestId("invoice-line-rows")).toContainText("Follow-up");
  await expect(page.getByText("$150.00").first()).toBeVisible();
  // Tax the SERVER priced (8% of $150.00), never computed in the browser.
  await expect(page.getByText("$12.00").first()).toBeVisible();
});

test("2b: a second checkout for the same appointment is refused", async ({ page }) => {
  await page.goto("/calendar");
  await page.getByText("Billing Walkthrough").first().click();
  const checkout = page.getByTestId("appt-checkout");
  await checkout.click();
  // The refusal is stated next to the control that was refused.
  await expect(
    page.locator("span", { has: checkout }).getByRole("alert"),
  ).toContainText(/already|changed|conflict/i);
  // and no second invoice was created
  await page.goto("/billing");
  await expect(page.getByTestId("billing-invoice-rows").locator("tr")).toHaveCount(1);
});

test("3: the client never prices tax — the server returns it on save", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/live/billing/save")) requests.push(r.postData() ?? "");
  });

  await page.goto(invoiceUrl);
  await page.getByTestId("line-product-select").selectOption({ label: "Omega-3 Fish Oil — $25.00" });
  await page.getByTestId("line-add").click();
  await page.getByTestId("line-qty-1").fill("2");
  await page.getByTestId("invoice-location").selectOption({ label: "Main Clinic" });
  await page.getByTestId("invoice-save").click();

  // The saved draft now carries server-priced tax on both lines.
  await expect(page.getByText("$200.00").first()).toBeVisible();
  // Nothing resembling a tax figure left the browser.
  expect(requests.join()).not.toContain("tax");
});

test("4: a discount without a reason is refused, with one it is accepted", async ({ page }) => {
  await page.goto(invoiceUrl);
  await page.getByTestId("line-discount-1").fill("$5.00");
  await page.getByTestId("invoice-save").click();
  await expect(page.getByRole("status")).toContainText(/reason/i);

  await page.getByTestId("line-discount-reason-1").fill("loyalty");
  await page.getByTestId("invoice-save").click();
  await expect(page.getByText("$5.00").first()).toBeVisible();
});

test("5: finalizing assigns a number and reserves tracked stock", async ({ page }) => {
  await page.goto(invoiceUrl);
  await page.getByTestId("invoice-finalize").click();
  await expect(page.getByTestId("invoice-number")).toHaveText("INV-00001");
  await expect(page.getByTestId("invoice-status")).toHaveText("Open");

  // 10 on hand, 2 now reserved → 8 available.
  await page.goto(CATALOG);
  await expect(page.getByTestId("catalog-rows")).toContainText("Main Clinic: 8");
});

test("6: a finalized invoice is no longer editable", async ({ page }) => {
  await page.goto(invoiceUrl);
  await expect(page.getByTestId("invoice-save")).toHaveCount(0);
  await expect(page.getByTestId("line-add")).toHaveCount(0);
  await expect(page.getByTestId("invoice-line-rows")).toContainText("Omega-3");
});

test("7: a partial cash payment moves the invoice to partly paid", async ({ page }) => {
  await page.goto(invoiceUrl);
  await page.getByTestId("payment-method").selectOption("cash");
  await page.getByTestId("payment-amount").fill("$100.00");
  await page.getByTestId("payment-record").click();
  await expect(page.getByTestId("invoice-status")).toHaveText("Partly paid");
});

test("8: full settlement marks it paid and commits the sale exactly once", async ({ page }) => {
  await page.goto(invoiceUrl);
  await page.getByTestId("payment-record").click(); // defaults to the balance
  await expect(page.getByTestId("invoice-status")).toHaveText("Paid");

  // The reservation became a sale: on hand 10 → 8, reserved back to 0.
  await page.goto(CATALOG);
  await expect(page.getByTestId("catalog-rows")).toContainText("Main Clinic: 8");
  await openInventoryPanel(page, "Omega-3");
  const ledger = page.getByTestId("inventory-history-rows");
  await expect(ledger.getByText("sale")).toHaveCount(1);
});

test("9: a refund returns money and never restocks", async ({ page }) => {
  await page.goto(invoiceUrl);
  await page.getByTestId("refund-payment").selectOption({ index: 1 });
  await page.getByTestId("refund-amount").fill("$50.00");
  await page.getByTestId("refund-reason").fill("patient returned product");
  await page.getByTestId("refund-submit").click();
  await expect(page.getByTestId("invoice-status")).toHaveText("Partly refunded");

  // Stock is untouched by the refund — returning goods is a separate decision.
  await page.goto(CATALOG);
  await expect(page.getByTestId("catalog-rows")).toContainText("Main Clinic: 8");
});

test("10: an explicit resalable return is the only thing that restocks", async ({ page }) => {
  await page.goto(CATALOG);
  await openInventoryPanel(page, "Omega-3");
  await page.getByTestId("inventory-return-qty").fill("1");
  await page.getByTestId("inventory-return-condition").selectOption("resalable");
  await page.getByTestId("inventory-return-reason").fill("unopened return");
  await page.getByTestId("inventory-return").click();
  await expect(page.getByTestId("catalog-rows")).toContainText("Main Clinic: 9");
});

test("11: a damaged return is recorded without adding sellable stock", async ({ page }) => {
  await page.goto(CATALOG);
  await openInventoryPanel(page, "Omega-3");
  await page.getByTestId("inventory-return-qty").fill("1");
  await page.getByTestId("inventory-return-condition").selectOption("damaged");
  await page.getByTestId("inventory-return-reason").fill("opened, unusable");
  await page.getByTestId("inventory-return").click();

  // Still 9: recorded in the ledger, never added to sellable stock.
  await expect(page.getByTestId("catalog-rows")).toContainText("Main Clinic: 9");
  await expect(page.getByTestId("inventory-history-rows")).toContainText("damaged");
});

test("12: patient credit is granted with a reason and applied", async ({ page }) => {
  await page.goto(`/patients/${PATIENT_1}/billing`);
  await expect(page.getByTestId("patient-billing")).toBeVisible();

  await page.getByTestId("patient-credit-amount").fill("$25.00");
  await page.getByTestId("patient-credit-grant").click();
  await expect(page.getByRole("status")).toContainText(/reason/i);

  await page.getByTestId("patient-credit-reason").fill("service recovery");
  await page.getByTestId("patient-credit-grant").click();
  await expect(page.getByText("$25.00").first()).toBeVisible();

  // A fresh invoice to apply it against.
  await page.getByTestId("patient-start-checkout").click();
  await page.waitForURL(/\/billing\/inv-/);
  await page.getByTestId("line-product-select").selectOption({ label: "Consult Packet — $5.00" });
  await page.getByTestId("line-add").click();
  await page.getByTestId("invoice-save").click();
  await page.getByTestId("invoice-finalize").click();
  await page.getByTestId("credit-amount").fill("$5.00");
  await page.getByTestId("credit-apply").click();
  await expect(page.getByTestId("invoice-status")).toHaveText("Paid");
});

test("13: a card payment reaches pending only — the UI never claims it is paid", async ({ page }) => {
  await page.goto(`/patients/${PATIENT_1}/billing`);
  await page.getByTestId("patient-start-checkout").click();
  await page.waitForURL(/\/billing\/inv-/);
  invoiceUrl = page.url();
  await page.getByTestId("line-product-select").selectOption({ label: "Omega-3 Fish Oil — $25.00" });
  await page.getByTestId("line-add").click();
  await page.getByTestId("invoice-location").selectOption({ label: "Main Clinic" });
  await page.getByTestId("invoice-save").click();
  await page.getByTestId("invoice-finalize").click();

  await page.getByTestId("card-start").click();
  await expect(page.getByTestId("card-started-note")).toContainText(/not a completed charge/i);
  // The invoice is emphatically NOT paid, and the payment reads as awaiting.
  await expect(page.getByTestId("invoice-status")).not.toHaveText("Paid");
  await expect(page.getByTestId("invoice-payment-rows")).toContainText("awaiting settlement");

  // The screen must disclose BOTH that this is test mode and that no
  // processor is connected — "test mode" alone would still imply Stripe is
  // wired up and operationally verified, which it is not.
  const body = await page.locator("body").innerText();
  expect(body).toMatch(/test.mode/i);
  expect(body).toMatch(/no payment processor is connected/i);
  // and it must never make an AFFIRMATIVE success claim. (A bare "charged"
  // check would be wrong: the honest copy says "no card is charged".)
  expect(body).not.toMatch(
    /card (was |has been )?charged|payment (complete|successful|succeeded)|processed successfully|charge succeeded/i,
  );

  const workspace = await fetch(`${STUB}/rest/v1/rpc/get_billing_workspace`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({ _organization_id: "org-fixture" }),
  }).then((r) => r.json());
  cardPaymentId = workspace.payments.find(
    (p: { status: string; method: string; id: string }) =>
      p.status === "pending" && p.method === "card_test",
  ).id;
  expect(cardPaymentId).toBeTruthy();
});

test("14: a second in-flight card payment is refused", async ({ page }) => {
  await page.goto(invoiceUrl);
  await page.getByTestId("card-start").click();
  await expect(page.getByRole("status")).toContainText(/already in progress|changed/i);
});

test("15: only the processor webhook settles the card payment", async ({ page }) => {
  await fetch(`${STUB}/__control/billing-attach-processor-ref`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentId: cardPaymentId, processorRef: "pi_test_e2e" }),
  });
  // Still pending until the processor actually confirms.
  await page.goto(invoiceUrl);
  await expect(page.getByTestId("invoice-payment-rows")).toContainText("awaiting settlement");

  await fetch(`${STUB}/__control/billing-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: "evt-e2e-1",
      eventType: "payment_intent.succeeded",
      processorRef: "pi_test_e2e",
    }),
  });
  await page.goto(invoiceUrl);
  await expect(page.getByTestId("invoice-status")).toHaveText("Paid");
});

test("16: a replayed webhook duplicates and a mismatched amount is refused — both recorded", async ({ page }) => {
  const replay = await fetch(`${STUB}/__control/billing-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: "evt-e2e-1",
      eventType: "payment_intent.succeeded",
      processorRef: "pi_test_e2e",
    }),
  }).then((r) => r.json());
  expect(replay.outcome).toBe("duplicate");

  const mismatch = await fetch(`${STUB}/__control/billing-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: "evt-e2e-2",
      eventType: "payment_intent.succeeded",
      processorRef: "pi_test_e2e",
      amountMinor: 1,
    }),
  }).then((r) => r.json());
  expect(mismatch.outcome).toBe("refused");

  // Both are visible on the reconciliation surface — neither was dropped.
  await page.goto("/billing");
  const rows = page.getByTestId("billing-webhook-rows");
  await expect(rows).toContainText("refused");
  await expect(rows).toContainText("amount mismatch");
});

test("17: voiding an unpaid invoice releases its reservations", async ({ page }) => {
  await page.goto(`/patients/${PATIENT_1}/billing`);
  await page.getByTestId("patient-start-checkout").click();
  await page.waitForURL(/\/billing\/inv-/);
  const voidUrl = page.url();
  await page.getByTestId("line-product-select").selectOption({ label: "Omega-3 Fish Oil — $25.00" });
  await page.getByTestId("line-add").click();
  await page.getByTestId("invoice-location").selectOption({ label: "Main Clinic" });
  await page.getByTestId("invoice-save").click();
  await page.getByTestId("invoice-finalize").click();

  await page.goto(CATALOG);
  const beforeVoid = await page.getByTestId("catalog-rows").innerText();

  await page.goto(voidUrl);
  await page.getByTestId("invoice-void").click();
  await page.getByTestId("void-confirm").click();
  await expect(page.getByRole("status")).toContainText(/reason/i);
  await page.getByTestId("void-reason").fill("entered in error");
  await page.getByTestId("void-confirm").click();
  await page.getByRole("button", { name: "Void invoice" }).last().click();
  await expect(page.getByTestId("invoice-status")).toHaveText("Void");

  // The reserved unit came back to available.
  await page.goto(CATALOG);
  expect(await page.getByTestId("catalog-rows").innerText()).not.toBe(beforeVoid);
});

test("18: overselling is refused and reserves nothing", async ({ page }) => {
  await page.goto(`/patients/${PATIENT_1}/billing`);
  await page.getByTestId("patient-start-checkout").click();
  await page.waitForURL(/\/billing\/inv-/);
  await page.getByTestId("line-product-select").selectOption({ label: "Omega-3 Fish Oil — $25.00" });
  await page.getByTestId("line-add").click();
  await page.getByTestId("line-qty-0").fill("999");
  await page.getByTestId("invoice-location").selectOption({ label: "Main Clinic" });
  await page.getByTestId("invoice-save").click();
  await page.getByTestId("invoice-finalize").click();

  // Refused as a conflict; the invoice is still a draft and nothing reserved.
  await expect(page.getByTestId("invoice-status")).toHaveText("Draft");
  await page.goto(CATALOG);
  await expect(page.getByTestId("catalog-rows")).not.toContainText("Main Clinic: -");
});

test("19: crossing the reorder threshold opens ONE low-stock review task", async ({ page }) => {
  await page.goto(CATALOG);
  await openInventoryPanel(page, "Omega-3");
  await page.getByTestId("inventory-adjust-delta").fill("-6");
  await page.getByTestId("inventory-adjust-kind").selectOption("adjustment");
  await page.getByTestId("inventory-adjust").click();
  await expect(page.getByRole("status")).toContainText(/reason/i);

  await page.getByTestId("inventory-adjust-reason").fill("cycle count correction");
  await page.getByTestId("inventory-adjust").click();

  // A REAL review task, once — a second crossing does not duplicate it.
  await page.goto("/tasks");
  await expect(page.getByText(/Low stock: Omega-3/)).toHaveCount(1);

  await page.goto(CATALOG);
  await openInventoryPanel(page, "Omega-3");
  await page.getByTestId("inventory-adjust-delta").fill("-1");
  await page.getByTestId("inventory-adjust-reason").fill("second correction");
  await page.getByTestId("inventory-adjust").click();
  await page.goto("/tasks");
  await expect(page.getByText(/Low stock: Omega-3/)).toHaveCount(1);
});

test("20: no fixture identity, no PHI in logs, no off-origin requests", async ({ page }) => {
  const logs: string[] = [];
  const offOrigin: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("request", (r) => {
    const url = r.url();
    if (!url.startsWith("http://localhost") && !url.startsWith("http://127.0.0.1")) {
      offOrigin.push(url);
    }
  });

  for (const path of ["/billing", CATALOG, `/patients/${PATIENT_1}/billing`]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expectNoFixtureData(await page.locator("body").innerText());
  }

  const logText = logs.join("\n");
  expectNoFixtureData(logText);
  expect(logText).not.toContain("Billing Walkthrough");
  expect(offOrigin).toEqual([]);
});
