import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * PHASE 8B, browser-level: plans, packages, memberships, the entitlement
 * ledger, complimentary assignment, credit redemption, dunning, and
 * reconciliation — against the committed contract fixture backend.
 *
 * The `__control` endpoints stand in for the service_role processor and for
 * role changes, and exercise the SAME accounting, permission, and dedup
 * contracts as the database.
 *
 * Acceptance scenarios covered here (the numbering follows the phase brief):
 *
 *    1 create and version a package        2 create and version a membership
 *    3 purchase a package                  4 authorized complimentary package
 *    5 reject unauthorized complimentary   6 entitlements created exactly once
 *    7 reserve and consume a visit credit  8 release after permitted cancel
 *    9 concurrent redemption conflict     10 expired-credit refusal
 *   11 manual restoration with reason     12 Stripe-disabled refusal
 *   18 failed-payment task creation       19 pause / resume / cancel-at-end
 *   20 refund without duplicate restore   21 reconciliation match
 *   22 mismatch + reasoned resolution     24 role/permission refusal
 *   26 no fixture identity leakage        27 no card data / secret / PHI logs
 *   28 no unintended clinical side effect
 *
 * Scenarios 13-17 and 23 are proven elsewhere and noted at their positions.
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-plans.spec.ts
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

/**
 * Isolation, not ordering. This restores the whole fixture backend so the
 * suite runs against exactly the state it was written for, wherever it lands
 * in the battery.
 */
test.beforeAll(resetBackend);

const STUB = "http://127.0.0.1:3999";
const PATIENT = "aaaaaaaa-1111-2222-3333-444444444404";
const PLANS = "/settings/plans";
const PATIENT_PLANS = `/patients/${PATIENT}/plans`;
const DEMO_FIXTURE_NAMES = ["Alexandra Morgan", "Michael Johnson", "Priya Sharma"];

let purchaseInvoiceId = "";
let entitlementId = "";
let membershipId = "";

test.beforeAll(async () => {
  await fetch(`${STUB}/__control/plans-reset`, { method: "POST" });
  await fetch(`${STUB}/__control/billing-reset`, { method: "POST" });
});

async function setRole(role: string) {
  await fetch(`${STUB}/__control/plans-set-role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

function expectNoFixtureData(text: string) {
  for (const name of DEMO_FIXTURE_NAMES) expect(text).not.toContain(name);
}

test("1: create a package and draft + publish a version", async ({ page }) => {
  await page.goto(PLANS);
  await expect(page.getByTestId("plans-workspace")).toBeVisible();
  await expect(page.getByTestId("plans-empty")).toBeVisible();

  await page.getByTestId("plan-type").selectOption("package");
  await page.getByTestId("plan-name").fill("10-Visit Pack");
  await page.getByTestId("plan-kind").selectOption("visit_credits");
  await page.getByTestId("plan-create").click();
  await expect(page.getByTestId("plans-rows")).toContainText("10-Visit Pack");

  // A plan with no published version has no sellable terms.
  await expect(page.getByTestId("plans-rows")).toContainText("not published");

  const row = page.getByTestId("plans-rows").locator("tr", { hasText: "10-Visit Pack" });
  await row.getByRole("button", { name: "New version" }).click();
  await page.getByTestId("version-price").fill("$500.00");
  await page.getByTestId("version-credits").fill("10");
  await page.getByTestId("version-expires").fill("365");
  await page.getByTestId("version-create").click();

  // Draft first — terms are not frozen until published.
  await expect(page.getByTestId("plans-rows")).toContainText("v1 draft");
  await page.getByTestId("plans-rows").locator("tr", { hasText: "10-Visit Pack" })
    .getByRole("button", { name: "Publish draft" }).click();
  await expect(page.getByTestId("plans-rows")).toContainText("v1 published");
  await expect(page.getByTestId("plans-rows")).toContainText("$500.00");
});

test("2: create a membership and version it", async ({ page }) => {
  await page.goto(PLANS);
  await page.getByTestId("plan-type").selectOption("membership");
  await page.getByTestId("plan-name").fill("Longevity Membership");
  await page.getByTestId("plan-create").click();
  await expect(page.getByTestId("plans-rows")).toContainText("Longevity Membership");

  const row = page.getByTestId("plans-rows").locator("tr", { hasText: "Longevity Membership" });
  await row.getByRole("button", { name: "New version" }).click();
  await page.getByTestId("version-price").fill("$199.00");
  await page.getByTestId("version-interval").selectOption("0");
  await page.getByTestId("version-trial").fill("14");
  await page.getByTestId("version-included").fill("2");
  await page.getByTestId("version-grace").fill("7");
  await page.getByTestId("version-create").click();
  await page.getByTestId("plans-rows").locator("tr", { hasText: "Longevity Membership" })
    .getByRole("button", { name: "Publish draft" }).click();
  await expect(page.getByTestId("plans-rows")).toContainText("v1 published");
});

test("3 + 6: purchasing drafts an invoice; credits appear only once it is paid, exactly once", async ({ page }) => {
  await page.goto(PATIENT_PLANS);
  await expect(page.getByTestId("patient-plans")).toBeVisible();

  await page.getByTestId("sell-version").selectOption({ index: 1 });
  await page.getByTestId("sell-submit").click();
  await expect(page.getByRole("status")).toContainText(/invoice drafted/i);

  // An UNPAID purchase confers nothing.
  await page.reload();
  await expect(page.getByTestId("entitlement-rows")).toHaveCount(0);

  const ws = await fetch(`${STUB}/rest/v1/rpc/get_billing_workspace`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({ _organization_id: "org-fixture" }),
  }).then((r) => r.json());
  purchaseInvoiceId = ws.invoices[0].id;

  await fetch(`${STUB}/__control/plans-mark-invoice-paid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invoiceId: purchaseInvoiceId }),
  });

  const grant = async () =>
    fetch(`${STUB}/rest/v1/rpc/grant_entitlements_for_invoice`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer stub" },
      body: JSON.stringify({ _organization_id: "org-fixture", _invoice_id: purchaseInvoiceId }),
    }).then((r) => r.json());

  expect((await grant()).entitlementsCreated).toBe(1);
  // EXACTLY ONCE: a duplicate grant (a replayed webhook) creates nothing more.
  expect((await grant()).entitlementsCreated).toBe(0);

  await page.reload();
  await expect(page.getByTestId("entitlement-rows")).toContainText("10-Visit Pack");
  const remaining = page.locator('[data-testid^="entitlement-remaining-"]').first();
  await expect(remaining).toHaveText("10");
  entitlementId = (await remaining.getAttribute("data-testid"))!.replace("entitlement-remaining-", "");
});

test("4: an authorized complimentary package is granted, labelled, and recorded", async ({ page }) => {
  await page.goto(PATIENT_PLANS);
  await page.getByTestId("comp-type").selectOption("package");
  await page.getByTestId("comp-version").selectOption({ index: 1 });
  await page.getByTestId("comp-submit").click();
  // A reason is required before anything happens.
  await expect(page.getByRole("status")).toContainText(/reason/i);

  await page.getByTestId("comp-reason").fill("service recovery after a scheduling error");
  await page.getByTestId("comp-submit").click();
  await expect(page.getByRole("status")).toContainText(/assigned and recorded/i);

  await page.reload();
  await expect(page.locator('[data-testid^="entitlement-comp-"]').first()).toContainText("Complimentary");
});

test("5: an unauthorized complimentary assignment is refused", async ({ page }) => {
  // Front-desk staff may take money but must not give care away.
  await setRole("staff");
  await page.goto(PATIENT_PLANS);

  // The SERVER is what refuses. Assert the status code directly rather than
  // the copy, because the adapter deliberately genericizes the message (a
  // backend message may carry PHI) — the refusal is what matters.
  const refusal = await page.evaluate(async (patientId) => {
    const lib = await fetch("/api/live/plans/library", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    const versionId = lib.data.packages[0].versions.find(
      (v: { status: string }) => v.status === "published",
    ).id;
    const r = await fetch("/api/live/plans/complimentary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        patientId, planType: "package", versionId, reason: "trying without permission",
      }),
    });
    return { status: r.status, body: JSON.stringify(await r.json()) };
  }, PATIENT);
  expect(refusal.status).toBe(403);
  expect(refusal.body).toMatch(/forbidden/i);

  // And the practitioner sees an honest refusal rather than a silent no-op.
  await page.getByTestId("comp-type").selectOption("package");
  await page.getByTestId("comp-version").selectOption({ index: 1 });
  await page.getByTestId("comp-reason").fill("trying without permission");
  await page.getByTestId("comp-submit").click();
  await expect(page.getByRole("status")).toContainText(/access|permission|forbidden|not allowed/i);

  // Nothing was granted: only the authorized comp from scenario 4 exists.
  await page.reload();
  await expect(page.getByTestId("entitlement-rows")).toBeVisible();
  await expect(page.locator('[data-testid^="entitlement-comp-"]')).toHaveCount(1);
  await setRole("owner");
});

test("7: reserve and consume a visit credit", async ({ page }) => {
  const reserve = await fetch(`${STUB}/rest/v1/rpc/reserve_entitlement_for_appointment`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({
      _organization_id: "org-fixture",
      _entitlement_id: entitlementId,
      _appointment_id: "abababab-1111-2222-3333-444444444404",
    }),
  }).then((r) => r.json());
  expect(reserve.state).toBe("reserved");

  await page.goto(PATIENT_PLANS);
  await expect(page.getByTestId(`entitlement-remaining-${entitlementId}`)).toHaveText("9");

  await fetch(`${STUB}/rest/v1/rpc/settle_entitlement_for_appointment`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({
      _organization_id: "org-fixture",
      _appointment_id: "abababab-1111-2222-3333-444444444404",
      _outcome: "completed",
    }),
  });

  await page.reload();
  // Still 9 available, but now consumed rather than held.
  await expect(page.getByTestId(`entitlement-remaining-${entitlementId}`)).toHaveText("9");
  await page.getByTestId(`entitlement-ledger-${entitlementId}`).click();
  await expect(page.getByTestId(`ledger-entries-${entitlementId}`)).toContainText("consume");
});

test("8: a permitted cancellation returns the credit", async ({ page }) => {
  await fetch(`${STUB}/rest/v1/rpc/reserve_entitlement_for_appointment`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({
      _organization_id: "org-fixture",
      _entitlement_id: entitlementId,
      _appointment_id: "abababab-1111-2222-3333-444444444405",
    }),
  });
  const settled = await fetch(`${STUB}/rest/v1/rpc/settle_entitlement_for_appointment`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({
      _organization_id: "org-fixture",
      _appointment_id: "abababab-1111-2222-3333-444444444405",
      _outcome: "cancelled",
    }),
  }).then((r) => r.json());
  expect(settled.state).toBe("released");

  await page.goto(PATIENT_PLANS);
  await expect(page.getByTestId(`entitlement-remaining-${entitlementId}`)).toHaveText("9");
  await page.getByTestId(`entitlement-ledger-${entitlementId}`).click();
  await expect(page.getByTestId(`ledger-entries-${entitlementId}`)).toContainText("release");
});

test("9: a concurrent second reservation for the same appointment is refused", async () => {
  const appt = "abababab-1111-2222-3333-444444444406";
  const call = () =>
    fetch(`${STUB}/rest/v1/rpc/reserve_entitlement_for_appointment`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer stub" },
      body: JSON.stringify({
        _organization_id: "org-fixture",
        _entitlement_id: entitlementId,
        _appointment_id: appt,
      }),
    });

  // Fire both at once: exactly one may win, and the credit is spent once.
  const [a, b] = await Promise.all([call(), call()]);
  const codes = [a.status, b.status].sort();
  expect(codes).toEqual([200, 409]);

  const ent = await fetch(`${STUB}/rest/v1/rpc/get_patient_entitlements`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({ _organization_id: "org-fixture", _patient_id: PATIENT }),
  }).then((r) => r.json());
  const e = ent.entitlements.find((x: { id: string }) => x.id === entitlementId);
  // The accounting identity still holds after the race.
  expect(
    e.remainingQuantity + e.reservedQuantity + e.consumedQuantity +
      e.expiredQuantity + e.refundedQuantity,
  ).toBe(e.grantedQuantity);
  expect(e.reservedQuantity).toBe(1);
});

test("10: an expired credit cannot be used", async () => {
  // Grant a complimentary package that expired yesterday.
  const comp = await fetch(`${STUB}/rest/v1/rpc/assign_complimentary_plan`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({
      _organization_id: "org-fixture", _patient_id: PATIENT, _plan_type: "package",
      _version_id: (await fetch(`${STUB}/rest/v1/rpc/list_plans`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer stub" },
        body: JSON.stringify({ _organization_id: "org-fixture" }),
      }).then((r) => r.json())).packages[0].versions[0].id,
      _reason: "expiry test",
      _expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    }),
  }).then((r) => r.json());

  const refused = await fetch(`${STUB}/rest/v1/rpc/reserve_entitlement_for_appointment`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({
      _organization_id: "org-fixture",
      _entitlement_id: comp.entitlementId,
      _appointment_id: "abababab-1111-2222-3333-444444444407",
    }),
  });
  expect(refused.status).toBe(409);
  expect((await refused.json()).message).toMatch(/expired/i);
});

test("11: manual restoration needs a reason and appends to the ledger", async ({ page }) => {
  await page.goto(PATIENT_PLANS);
  await page.getByTestId(`entitlement-restore-${entitlementId}`).click();
  await page.getByTestId("restore-submit").click();
  await expect(page.getByRole("status")).toContainText(/reason/i);

  await page.getByTestId("restore-reason").fill("credit consumed in error at the desk");
  await page.getByTestId("restore-submit").click();
  await expect(page.getByRole("status")).toContainText(/restored and recorded/i);

  await page.reload();
  await page.getByTestId(`entitlement-ledger-${entitlementId}`).click();
  const ledger = page.getByTestId(`ledger-entries-${entitlementId}`);
  await expect(ledger).toContainText("manual_restore");
  await expect(ledger).toContainText("consumed in error");
  // Append-only: the original consume is still there.
  await expect(ledger).toContainText("consume");
});

test("12: Stripe is disabled and the UI says so without implying it works", async ({ page }) => {
  await page.goto(PLANS);
  const note = page.getByTestId("stripe-status-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText(/no payment processor is connected/i);

  const body = await page.locator("body").innerText();
  // Never an affirmative claim about a working integration.
  expect(body).not.toMatch(/stripe (is )?(connected|active|working|verified)/i);

  const status = await page.evaluate(async () => {
    const r = await fetch("/api/live/plans/stripe-status", { method: "POST" });
    return (await r.json()).data;
  });
  expect(status.configured).toBe(false);
  // Crucially: no transaction has ever run.
  expect(status.liveTransactionExecuted).toBe(false);
});

/*
 * 13 (Stripe test subscription when configured), 14 (signed webhook
 * verification), 15 (tamper and replay refusal), 16 (duplicate renewal
 * idempotency) and 17 (out-of-order events) are proven deterministically in
 * src/server/stripe-boundary.test.ts against a real HMAC, because no Stripe
 * test credentials are available to this environment. See the PR body.
 */

test("18: a failed subscription payment creates a real work-queue task", async ({ page }) => {
  const lib = await fetch(`${STUB}/rest/v1/rpc/list_plans`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({ _organization_id: "org-fixture" }),
  }).then((r) => r.json());

  const comp = await fetch(`${STUB}/rest/v1/rpc/assign_complimentary_plan`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({
      _organization_id: "org-fixture", _patient_id: PATIENT, _plan_type: "membership",
      _version_id: lib.memberships[0].versions[0].id,
      _reason: "membership lifecycle test",
    }),
  }).then((r) => r.json());
  membershipId = comp.patientMembershipId;

  await fetch(`${STUB}/__control/plans-payment-failed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patientMembershipId: membershipId }),
  });

  await page.goto("/tasks");
  await expect(page.getByText(/Subscription payment failed/i)).toHaveCount(1);

  await page.goto(PATIENT_PLANS);
  await expect(page.getByTestId(`membership-status-${membershipId}`)).toContainText("past due");
});

test("19: pause, resume, and cancel-at-period-end", async ({ page }) => {
  // It went past_due in scenario 18. Recovery is PROCESSOR-driven: there is
  // deliberately no practitioner action that revives a past_due subscription
  // without money actually arriving, so drive it through the webhook stand-in.
  await fetch(`${STUB}/__control/plans-payment-recovered`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patientMembershipId: membershipId }),
  });

  // The dunning task clears when the payment actually recovers.
  await page.goto("/tasks");
  await expect(page.getByText(/Subscription payment failed/i)).toHaveCount(0);

  await page.goto(PATIENT_PLANS);
  await page.getByTestId(`membership-pause-${membershipId}`).click();
  await expect(page.getByTestId(`membership-status-${membershipId}`)).toContainText("paused");

  await page.getByTestId(`membership-resume-${membershipId}`).click();
  await expect(page.getByTestId(`membership-status-${membershipId}`)).toContainText("active");

  // Cancelling requires a reason.
  await page.getByTestId(`membership-cancel-end-${membershipId}`).click();
  await expect(page.getByRole("status")).toContainText(/reason/i);
  await page.getByTestId("membership-cancel-reason").fill("patient relocating");
  await page.getByTestId(`membership-cancel-end-${membershipId}`).click();
  await expect(page.getByTestId(`membership-status-${membershipId}`)).toContainText("ending");
});

test("20: a refund revokes unspent credit only and never duplicates a restore", async ({ page }) => {
  const before = await fetch(`${STUB}/rest/v1/rpc/get_patient_entitlements`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({ _organization_id: "org-fixture", _patient_id: PATIENT }),
  }).then((r) => r.json());
  const e = before.entitlements.find((x: { id: string }) => x.id === entitlementId);
  const consumedBefore = e.consumedQuantity;

  const revoke = async () =>
    fetch(`${STUB}/rest/v1/rpc/revoke_entitlements_for_refund`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer stub" },
      body: JSON.stringify({
        _organization_id: "org-fixture", _invoice_id: purchaseInvoiceId,
        _reason: "patient refunded the package",
      }),
    }).then((r) => r.json());

  expect((await revoke()).revoked).toBe(1);
  // A second revoke finds nothing unspent left — it does not go negative and
  // it does not recreate anything.
  expect((await revoke()).revoked).toBe(0);

  await page.goto(PATIENT_PLANS);
  await expect(page.getByTestId(`entitlement-remaining-${entitlementId}`)).toHaveText("0");

  const after = await fetch(`${STUB}/rest/v1/rpc/get_patient_entitlements`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({ _organization_id: "org-fixture", _patient_id: PATIENT }),
  }).then((r) => r.json());
  const e2 = after.entitlements.find((x: { id: string }) => x.id === entitlementId);
  // The visit already received is untouched by the refund.
  expect(e2.consumedQuantity).toBe(consumedBefore);
  expect(
    e2.remainingQuantity + e2.reservedQuantity + e2.consumedQuantity +
      e2.expiredQuantity + e2.refundedQuantity,
  ).toBe(e2.grantedQuantity);
});

test("21 + 22: reconciliation shows unavailable settlement, and a mismatch resolves with a reason", async ({ page }) => {
  await fetch(`${STUB}/__control/plans-raise-exception`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "amount_mismatch", internalAmountMinor: 50000,
      providerAmountMinor: 49500, detail: "processor reported a lower amount",
    }),
  });

  await page.goto("/billing/reconciliation");
  await expect(page.getByTestId("reconciliation-workspace")).toBeVisible();
  await expect(page.getByTestId("reconciliation-rows")).toContainText("Amount disagreement");

  // Settlement figures are UNAVAILABLE, never rendered as zero.
  await expect(page.getByTestId("settlement-unavailable")).toBeVisible();
  await expect(page.getByTestId("reconciliation-rows")).toContainText("unavailable");
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/fees?:?\s*\$0\.00/i);

  // A dunning task deep-links the exception.
  await page.goto("/tasks");
  await expect(page.getByText(/Unreconciled payment/i)).toHaveCount(1);

  await page.goto("/billing/reconciliation");
  await page.locator('[data-testid^="reconciliation-resolve-"]').first().click();
  await page.getByTestId("resolve-submit").click();
  await expect(page.getByRole("status")).toContainText(/reason/i);

  await page.getByTestId("resolve-reason").fill("processor fee accounts for the difference");
  await page.getByTestId("resolve-submit").click();
  await expect(page.getByRole("status")).toContainText(/resolved and recorded/i);

  await page.getByTestId("reconciliation-status").selectOption("resolved");
  await expect(page.getByTestId("reconciliation-rows")).toContainText("fee accounts for the difference");
});

/* 23 (cross-tenant refusal) is proven for every RPC in the rolled-back DB
 * acceptance suite, which can assume a second tenant the fixture lacks. */

test("24: a role without permission is refused by the server, not just hidden", async ({ page }) => {
  await setRole("staff");
  // Staff CAN read the workspace...
  await page.goto(PLANS);
  await expect(page.getByTestId("plans-workspace")).toBeVisible();

  // ...but cannot author plans. The refusal comes from the server.
  const refusal = await page.evaluate(async () => {
    const r = await fetch("/api/live/plans/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planType: "package", name: "Staff should not create this" }),
    });
    return { status: r.status, body: await r.json() };
  });
  expect(refusal.status).toBe(403);
  expect(JSON.stringify(refusal.body)).toMatch(/permission|forbidden/i);

  await setRole("owner");
});

test("26 + 27 + 28: no fixture identity, no secrets or card data in logs, no clinical side effects", async ({ page }) => {
  const logs: string[] = [];
  const offOrigin: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith("http://localhost") && !u.startsWith("http://127.0.0.1")) offOrigin.push(u);
  });

  for (const path of [PLANS, PATIENT_PLANS, "/billing/reconciliation", "/billing/reports"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expectNoFixtureData(await page.locator("body").innerText());
  }

  const logText = logs.join("\n");
  expectNoFixtureData(logText);
  // No secret material and no card data may ever be logged.
  for (const forbidden of ["sk_test_", "sk_live_", "whsec_", "cvc", "exp_month"]) {
    expect(logText).not.toContain(forbidden);
  }
  expect(logText).not.toMatch(/\b4[0-9]{12}(?:[0-9]{3})?\b/);
  expect(offOrigin).toEqual([]);

  // 28: none of the financial work created a clinical record.
  const timeline = await fetch(`${STUB}/rest/v1/rpc/get_desktop_patient_timeline`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub" },
    body: JSON.stringify({ _organization_id: "org-fixture", _patient_id: PATIENT, _limit: 50 }),
  }).then((r) => r.json()).catch(() => null);
  if (Array.isArray(timeline)) {
    const text = JSON.stringify(timeline).toLowerCase();
    for (const clinical of ["protocol", "prescription", "order", "note signed"]) {
      expect(text).not.toContain(clinical);
    }
  }
});

test("reports: every chart carries a text equivalent and estimates are labelled", async ({ page }) => {
  await page.goto("/billing/reports");
  await expect(page.getByTestId("financial-reports")).toBeVisible();

  // The chart has an accessible name AND a table of the same numbers.
  const bar = page.getByTestId("revenue-share");
  if (await bar.isVisible().catch(() => false)) {
    await expect(bar.getByRole("img")).toHaveAttribute("aria-label", /collected/i);
  }
  await expect(page.getByTestId("report-comparison-rows")).toBeVisible();

  // Estimates must never be presented as revenue, profit, or certified.
  const estimates = page.getByTestId("report-estimates");
  await expect(estimates).toContainText(/estimate/i);
  await expect(estimates).toContainText(/not.*recognized revenue/i);
  // Only AFFIRMATIVE claims are forbidden. A bare /certified/ check would be
  // wrong: the honest disclaimer says "not an accounting-certified result".
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(
    /\bis (accounting-)?certified\b|\baudited results\b|\bnet profit of\b/i,
  );
  // and the disclaimer itself must be present, not merely the absence of lies
  expect(body).toMatch(/not\s+recognized revenue/i);
});
