import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * Program commerce as a browser reaches it under the local contract fixture (the only posture in
 * which this process has a fictional offer ledger and checkout). What holds here:
 *
 *   1. the Studio shows the offer editor and the purchases panel in their honest first states: the
 *      fixture program has no published patient-facing content, so no offer can be written, and the
 *      purchases panel says "no purchases" (distinct from "could not be read");
 *   2. the staff preview of a draft funnel shows both choices with the buy choice unavailable for the
 *      specific reason (no program bound), at a phone width without horizontal overflow;
 *   3. the public purchase page, the return page and the checkout route refuse a draft funnel: 404,
 *      "we do not recognise this order", 404; the checkout route refuses a cross-site post with 403;
 *   4. the webhook answers 503 while the Stripe boundary is unconfigured, and never records anything;
 *   5. the commercial status read answers under its own key for a program with nothing sold.
 *
 * No purchase can be made here: every funnel is a draft and no program is bound. That is the
 * posture, not a gap in the test.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");
test.describe.configure({ mode: "serial" });
test.beforeAll(resetBackend);

let programUrl = "";
let programId = "";

test("1: the Studio shows the offer editor and the purchases panel in their honest first states", async ({ page }) => {
  await page.goto("/programs");
  await page.getByTestId("program-create-toggle").click();
  await page.getByTestId("program-create-name").fill("Commerce Fixture Program");
  await page.getByTestId("program-create-submit").click();
  await page.getByTestId("program-list").getByText("Commerce Fixture Program").click();
  await page.waitForURL("**/programs/**");
  programUrl = page.url();
  programId = programUrl.split("/programs/")[1]!;
  const editor = page.getByTestId("program-offer-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("data-state", "read");
  await expect(page.getByTestId("offer-curriculum")).toContainText("an offer cannot be written until it does");
  await expect(page.getByTestId("offer-empty")).toBeVisible();
  await expect(page.getByTestId("offer-form")).toHaveCount(0);
  const purchases = page.getByTestId("program-purchases");
  await expect(purchases).toHaveAttribute("data-state", "read");
  await expect(page.getByTestId("purchases-empty")).toBeVisible();
  await expect(page.getByTestId("purchases-failed")).toHaveCount(0);
  await expect(page.getByTestId("purchases-disabled")).toHaveCount(0);
});

test("2: the staff preview shows both choices, the buy choice unavailable for its reason, readable at a phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  const response = await page.goto("/funnels/longevity-program/preview", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("funnel-page")).toHaveAttribute("data-purchase", "program_unbound");
  const top = page.getByTestId("funnel-buy-top");
  await expect(top).toHaveAttribute("data-available", "false");
  await expect(top).toContainText("Direct purchase is not available right now. This page is not linked to a program that can be bought yet.");
  await expect(page.getByTestId("funnel-cta-top")).toHaveAttribute("href", "/consult/longevity-program");
  await expect(page.locator('a[href^="/buy/"]')).toHaveCount(0);
  // The preview wraps the funnel in the workforce shell; the funnel itself carries no form, field or button: an unavailable purchase is a sentence, never a disabled checkout.
  await expect(page.getByTestId("funnel-page").locator("form, input, button, select, textarea")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await expect(page.getByText(/USD|\$\d/)).toHaveCount(0);
});

test("3: the public purchase page, the return page and the checkout route refuse a draft funnel", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const buy = await page.goto(`${baseURL}/buy/longevity-program`, { waitUntil: "domcontentloaded" });
    expect(buy?.status()).toBe(404);
    expect(page.url()).not.toContain("/login");
    const ret = await page.goto(`${baseURL}/buy/return?order=11111111-1111-4111-8111-111111111111&returned=success`, { waitUntil: "domcontentloaded" });
    expect(ret?.status()).toBe(200);
    await expect(page.getByTestId("return-page")).toHaveAttribute("data-state", "unknown");
    await expect(page.getByText("We do not recognise this order")).toBeVisible();
    await expect(page.getByTestId("return-not-proof")).toBeVisible();
    const origin = new URL(baseURL!).origin;
    const draft = await context.request.post(`${baseURL}/api/live/commerce/checkout`, { headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }, data: "funnelSlug=longevity-program", maxRedirects: 0 });
    expect(draft.status()).toBe(404);
    const cross = await context.request.post(`${baseURL}/api/live/commerce/checkout`, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }, data: "funnelSlug=longevity-program", maxRedirects: 0 });
    expect(cross.status()).toBe(403);
    const oversized = await context.request.post(`${baseURL}/api/live/commerce/checkout`, { headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }, data: "funnelSlug=longevity-program&pad=" + "x".repeat(2000), maxRedirects: 0 });
    expect(oversized.status()).toBe(400);
  } finally { await context.close(); }
});

test("4: the webhook answers 503 while the Stripe boundary is unconfigured and records nothing", async ({ request, baseURL }) => {
  const body = JSON.stringify({ id: "evt_fictional_e2e", type: "checkout.session.completed", livemode: false, created: 1, data: { object: { object: "checkout.session", id: "cs_test_fictionalE2E00001" } } });
  const unsigned = await request.post(`${baseURL}/api/live/commerce/webhook`, { headers: { "content-type": "application/json" }, data: body });
  expect(unsigned.status()).toBe(503);
  const signed = await request.post(`${baseURL}/api/live/commerce/webhook`, { headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=" + "0".repeat(64) }, data: body });
  expect(signed.status()).toBe(503);
  const json = await signed.json() as { error?: { code?: string } };
  expect(json.error?.code).toBe("not_configured");
});

test("5: the commercial status read answers under its own key for a program with nothing sold", async ({ page, baseURL }) => {
  await page.goto(programUrl);
  const origin = new URL(baseURL!).origin;
  const status = await page.evaluate(async ({ origin, programId }) => {
    const response = await fetch(`${origin}/api/live/commerce/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "status", programId }) });
    return { status: response.status, body: await response.json() as { data?: { commercial?: Record<string, unknown[]> } } };
  }, { origin, programId });
  expect(status.status).toBe(200);
  expect(status.body.data?.commercial).toMatchObject({ orders: [], entitlements: [], claims: [], enrollments: [] });
  // Under its own key, and nothing clinical beside it.
  expect(Object.keys(status.body.data ?? {})).toEqual(["commercial"]);
  // Without the workforce origin the same read is refused before any ledger is chosen.
  const cross = await page.request.post(`${origin}/api/live/commerce/status`, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" }, data: { action: "status", programId } });
  expect(cross.status()).toBe(403);
});
