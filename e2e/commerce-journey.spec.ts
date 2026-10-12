import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * The fully mounted fictional purchase-to-learning journey, under its SEPARATELY configured fixture
 * (COMMERCE_JOURNEY_FIXTURE=1 on top of the local contract fixture; see
 * src/server/commerce/journey-fixture.ts). It is run by its own CI step and is not part of the
 * `live-` battery: without the flag there is no fixture funnel and nothing here can run.
 *
 * What is real: the funnel page, the purchase page and its form, the checkout route, the return
 * page, the webhook route verifying a signature over the exact bytes, the commerce worker, claim
 * delivery, the education access and progress services, and the in-memory fictional ledgers they
 * write. What stands in (the fixture route, each named): the processor's hosted page and its state,
 * the host scheduler, the purchaser's inbox, the verified consumer session the identity API would
 * build, a clinician of the fixture clinic, and the operator. The hosted page itself is answered by
 * an interception of the processor's fictional host only; nothing of this site is intercepted.
 *
 * Evidence class: fictional-provider browser evidence against this process. It is not embedded
 * database evidence (the PGlite tests), not device evidence (the V2 component tests), and not
 * hosted acceptance.
 */
const journey = process.env.COMMERCE_JOURNEY_FIXTURE === "1";
test.skip(!process.env.E2E_LIVE || !journey, "journey fixture: set E2E_LIVE=1 and COMMERCE_JOURNEY_FIXTURE=1 with the contract fixture");
test.describe.configure({ mode: "serial" });

const SLUG = "fictional-journey-fixture";
const SECRET = process.env.STRIPE_TEST_WEBHOOK_SECRET ?? "";
type Json = Record<string, unknown>;

async function fixture<T = Json>(request: APIRequestContext, baseURL: string, body: Json): Promise<T> {
  const response = await request.post(`${baseURL}/api/live/commerce/fixture`, { data: body });
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
/** The processor sending its event: signed over the exact bytes, posted to the real webhook route. */
async function processorEvent(request: APIRequestContext, baseURL: string, event: Json, raw?: string) {
  const body = raw ?? JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const signature = `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`, "utf8").digest("hex")}`;
  return request.post(`${baseURL}/api/live/commerce/webhook`, { headers: { "content-type": "application/json", "stripe-signature": signature }, data: body });
}
const event = (id: string, type: string, sessionRef: string, extra: Json = {}): Json =>
  ({ id, type, livemode: false, created: Math.floor(Date.now() / 1000), api_version: "2025-08-27.basil", data: { object: { object: "checkout.session", id: sessionRef } }, ...extra });
const consumer = <T = Json>(request: APIRequestContext, baseURL: string, learner: "a" | "b", service: "access" | "progress", body: Json) =>
  fixture<T>(request, baseURL, { action: "consumer", learner, service, body });
// The code is base64url and stands on its own line; a word-boundary pattern misses one that starts or ends with '-'.
const codeIn = (messages: { text: string }[]) => messages.map(m => /^([A-Za-z0-9_-]{43})$/m.exec(m.text)?.[1]).filter(Boolean).at(-1)!;

/** The processor's hosted page: the only interception, on the processor's own fictional host. */
async function hostedCheckoutStandIn(page: Page) {
  await page.route("https://checkout.fictional.example/**", route => route.fulfill({
    status: 200, contentType: "text/html",
    body: "<!doctype html><title>Fictional hosted checkout (test fixture)</title><main data-testid=\"hosted-checkout\">Fictional hosted checkout (test fixture). No real payment is taken here.</main>",
  }));
}
/** Buy through the real page and form, and arrive on the processor's (stand-in) page. */
async function buyThroughThePage(page: Page): Promise<void> {
  await page.goto(`/buy/${SLUG}`);
  await expect(page.getByTestId("purchase-page")).toHaveAttribute("data-purchase", "available");
  await page.getByTestId("purchase-start-button").click();
  // One same-site step, then a plain link to the processor: the purchase page's form-action stays 'self'.
  await expect(page.getByTestId("checkout-continue")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/api/live/commerce/checkout");
  await page.getByTestId("checkout-continue-link").click();
  await expect(page.getByTestId("hosted-checkout")).toBeVisible();
  expect(new URL(page.url()).host).toBe("checkout.fictional.example");
}

let orderId = "";
let sessionRef = "";
let code = "";
let entitlementId = "";
let enrollmentId = "";
let curriculum: Json = {};

test.beforeAll(async ({ request, baseURL }) => {
  await resetBackend();
  await fixture(request, baseURL!, { action: "reset" });
});

test("1: the funnel offers both choices; the buy page shows the fixture's terms; checkout leaves for the processor's page", async ({ page, request, baseURL }) => {
  await page.goto(`/learn/${SLUG}`);
  await expect(page.getByTestId("funnel-page")).toHaveAttribute("data-purchase", "available");
  await expect(page.getByTestId("funnel-cta-top")).toHaveAttribute("href", /\/consult\/longevity-program$/);
  await expect(page.getByTestId("funnel-buy-top")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("funnel-buy-top")).toContainText("12.34 USD");
  await page.goto(`/buy/${SLUG}`);
  await expect(page.getByTestId("purchase-terms")).toContainText("Fictional journey program (test fixture)");
  await expect(page.getByTestId("purchase-terms")).toContainText("30 days of access");
  await expect(page.getByTestId("purchase-excludes")).toContainText("does not include a consultation");
  await hostedCheckoutStandIn(page);
  await buyThroughThePage(page);
  const staff = await fixture<{ commercial: { orders: { orderId: string; state: string; processor: { sessionRef: string; returnSuccess: string } }[] } }>(request, baseURL!, { action: "staff" });
  expect(staff.commercial.orders).toHaveLength(1);
  expect(staff.commercial.orders[0]!.state).toBe("checkout_open");
  orderId = staff.commercial.orders[0]!.orderId;
  sessionRef = staff.commercial.orders[0]!.processor.sessionRef;
  // The same browser buying again lands on the same checkout, not a second order.
  await buyThroughThePage(page);
  expect((await fixture<{ commercial: { orders: unknown[] } }>(request, baseURL!, { action: "staff" })).commercial.orders).toHaveLength(1);
});

test("2: a delayed payment is processing, then succeeds once; duplicate and refused events change nothing", async ({ page, request, baseURL }) => {
  const returnPath = `/buy/return?order=${orderId}&returned=success`;
  await fixture(request, baseURL!, { action: "pay", orderId, outcome: "processing" });
  await page.goto(returnPath);
  // Arriving here is not confirmation: the order is still open until the processor's event is processed.
  await expect(page.getByTestId("return-page")).toHaveAttribute("data-state", "checkout_open");
  expect((await processorEvent(request, baseURL!, event("evt_journey_completed", "checkout.session.completed", sessionRef))).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId("return-page")).toHaveAttribute("data-state", "checkout_open");
  await fixture(request, baseURL!, { action: "work" });
  await page.reload();
  await expect(page.getByTestId("return-page")).toHaveAttribute("data-state", "payment_processing");
  await expect(page.getByTestId("return-not-proof")).toBeVisible();
  // Refused before admission: another account, a forged signature, an oversized stream.
  expect((await processorEvent(request, baseURL!, event("evt_journey_other_account", "checkout.session.completed", sessionRef, { account: "acct_FictionalOther99" }))).status()).toBe(400);
  const forged = await request.post(`${baseURL}/api/live/commerce/webhook`, { headers: { "content-type": "application/json", "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }, data: JSON.stringify(event("evt_journey_forged", "checkout.session.async_payment_succeeded", sessionRef)) });
  expect(forged.status()).toBe(400);
  expect((await processorEvent(request, baseURL!, {}, JSON.stringify({ pad: "x".repeat(300_000) }))).status()).toBe(400);
  // Success arrives; a duplicate delivery of it is a recorded duplicate.
  await fixture(request, baseURL!, { action: "pay", orderId, outcome: "succeeded_async" });
  expect((await processorEvent(request, baseURL!, event("evt_journey_succeeded", "checkout.session.async_payment_succeeded", sessionRef))).status()).toBe(200);
  const duplicate = await processorEvent(request, baseURL!, event("evt_journey_succeeded", "checkout.session.async_payment_succeeded", sessionRef));
  expect(await duplicate.json()).toMatchObject({ outcome: "duplicate" });
  await fixture(request, baseURL!, { action: "work" });
  await page.reload();
  await expect(page.getByTestId("return-page")).toHaveAttribute("data-state", "payment_verified");
  await expect(page.getByText("Your payment is confirmed")).toBeVisible();
  const staff = await fixture<{ commercial: { orders: { state: string }[]; entitlements: { state: string }[]; claims: { delivery: { state: string } }[] } }>(request, baseURL!, { action: "staff" });
  expect(staff.commercial.orders.map(o => o.state)).toEqual(["payment_verified"]);
  expect(staff.commercial.entitlements.map(e => e.state)).toEqual(["awaiting_claim"]);
  expect(staff.commercial.claims.map(c => c.delivery.state)).toEqual(["accepted"]);
});

test("3: the code arrives once; a verified account claims it; another account cannot; one enrollment, the exact course", async ({ request, baseURL }) => {
  const mail = await fixture<{ messages: { text: string }[] }>(request, baseURL!, { action: "mailbox" });
  expect(mail.messages).toHaveLength(1);
  code = codeIn(mail.messages);
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const staffText = JSON.stringify(await fixture(request, baseURL!, { action: "staff" }));
  expect(staffText).not.toContain(code);
  expect(await consumer(request, baseURL!, "a", "access", { action: "claim", token: code })).toMatchObject({ action: "claim", outcome: "claimed" });
  // The winner retrying after a lost reply gets the same receipt; the other account is refused.
  expect(await consumer(request, baseURL!, "a", "access", { action: "claim", token: code })).toMatchObject({ outcome: "claimed" });
  expect(await consumer(request, baseURL!, "b", "access", { action: "claim", token: code })).toMatchObject({ outcome: "refused", reason: "already_claimed_by_other" });
  const access = await consumer<{ view: { entitlements: { entitlementId: string; curriculum: Json }[]; enrollments: { enrollmentId: string }[] } }>(request, baseURL!, "a", "access", { action: "access" });
  expect(access.view.entitlements).toHaveLength(1);
  expect(access.view.enrollments).toHaveLength(1);
  entitlementId = access.view.entitlements[0]!.entitlementId;
  enrollmentId = access.view.enrollments[0]!.enrollmentId;
  curriculum = access.view.entitlements[0]!.curriculum;
  expect(await consumer(request, baseURL!, "a", "access", { action: "curriculum", entitlementId })).toMatchObject({ read: { outcome: "served", title: "Fictional journey course (test fixture)" } });
  expect(await consumer(request, baseURL!, "b", "access", { action: "access" })).toMatchObject({ view: { entitlements: [], enrollments: [] } });
  expect(await consumer(request, baseURL!, "b", "access", { action: "curriculum", entitlementId })).toMatchObject({ read: { outcome: "withheld", reason: "not_owner" } });
});

test("4: a lesson completed on one device is seen on a second; a retry converges; a device that is behind is refused with the saved record; relaunch resumes", async ({ browser, baseURL }) => {
  const deviceOne = await browser.newContext();
  const deviceTwo = await browser.newContext();
  try {
    const write = (lesson: Json, expectedRevision: number, action = "complete", requestId = randomUUID()) => ({ action, entitlementId, enrollmentId, curriculum, lesson, expectedRevision, requestId });
    const first = write({ phaseId: "phase-1", itemId: "lesson-a" }, 0);
    expect(await consumer(deviceOne.request, baseURL!, "a", "progress", first)).toMatchObject({ outcome: { outcome: "recorded", receipt: { requestId: first.requestId, revision: 1 } } });
    expect(await consumer(deviceOne.request, baseURL!, "a", "progress", first)).toMatchObject({ outcome: { outcome: "recorded", receipt: { requestId: first.requestId, revision: 1 } } });
    expect(await consumer(deviceTwo.request, baseURL!, "a", "progress", { action: "read", entitlementId })).toMatchObject({ read: { outcome: "read", progress: { revision: 1, completed: [{ lesson: { itemId: "lesson-a" } }] } } });
    // Device two, still at revision 0, tries to move the resume point: refused, and shown the saved record.
    expect(await consumer(deviceTwo.request, baseURL!, "a", "progress", write({ phaseId: "phase-2", itemId: "lesson-c" }, 0, "position"))).toMatchObject({ outcome: { outcome: "refused", reason: "revision_stale", progress: { revision: 1 } } });
    expect(await consumer(deviceTwo.request, baseURL!, "a", "progress", write({ phaseId: "phase-2", itemId: "lesson-c" }, 1, "position"))).toMatchObject({ outcome: { outcome: "recorded", progress: { revision: 2, position: { itemId: "lesson-c" } } } });
  } finally { await deviceOne.close(); await deviceTwo.close(); }
  // A relaunched device keeps nothing: it reads the same record and resumes where the service says.
  const relaunched = await browser.newContext();
  try {
    expect(await consumer(relaunched.request, baseURL!, "a", "progress", { action: "read", entitlementId })).toMatchObject({ read: { outcome: "read", progress: { revision: 2, position: { phaseId: "phase-2", itemId: "lesson-c" }, completed: [{ lesson: { itemId: "lesson-a" } }] } } });
  } finally { await relaunched.close(); }
});

test("5: a policy hold closes the course and refuses progress until the operator releases it", async ({ request, baseURL }) => {
  await fixture(request, baseURL!, { action: "operator", op: "refund", orderId });
  expect(await consumer(request, baseURL!, "a", "access", { action: "curriculum", entitlementId })).toMatchObject({ read: { outcome: "withheld", reason: "not_active" } });
  expect(await consumer(request, baseURL!, "a", "progress", { action: "complete", entitlementId, enrollmentId, curriculum, lesson: { phaseId: "phase-1", itemId: "habit-b" }, expectedRevision: 2, requestId: randomUUID() })).toMatchObject({ outcome: { outcome: "refused", reason: "not_active" } });
  await fixture(request, baseURL!, { action: "operator", op: "operator_release", orderId });
  expect(await consumer(request, baseURL!, "a", "access", { action: "curriculum", entitlementId })).toMatchObject({ read: { outcome: "served" } });
});

test("6: a second purchase: reversed events converge; an expired code is refused; the operator's replacement works and the old code does not", async ({ browser, request, baseURL }) => {
  const visitor = await browser.newContext();
  try {
    const page = await visitor.newPage();
    await hostedCheckoutStandIn(page);
    await buyThroughThePage(page);
    const orders = (await fixture<{ commercial: { orders: { orderId: string; state: string; processor: { sessionRef: string } }[] } }>(request, baseURL!, { action: "staff" })).commercial.orders;
    const second = orders.find(o => o.orderId !== orderId)!;
    await fixture(request, baseURL!, { action: "pay", orderId: second.orderId, outcome: "paid" });
    // The success event arrives before the completion event: they converge on one verified order.
    expect((await processorEvent(request, baseURL!, event("evt_second_late", "checkout.session.async_payment_succeeded", second.processor.sessionRef))).status()).toBe(200);
    expect((await processorEvent(request, baseURL!, event("evt_second_early", "checkout.session.completed", second.processor.sessionRef))).status()).toBe(200);
    await fixture(request, baseURL!, { action: "work" });
    const staff = await fixture<{ commercial: { orders: { orderId: string; state: string }[]; entitlements: { orderId: string }[] } }>(request, baseURL!, { action: "staff" });
    expect(staff.commercial.orders.find(o => o.orderId === second.orderId)!.state).toBe("payment_verified");
    expect(staff.commercial.entitlements.filter(e => e.orderId === second.orderId)).toHaveLength(1);
    const firstCode = codeIn((await fixture<{ messages: { text: string }[] }>(request, baseURL!, { action: "mailbox" })).messages);
    await fixture(request, baseURL!, { action: "age_claim", orderId: second.orderId, days: 8 });
    expect(await consumer(request, baseURL!, "b", "access", { action: "claim", token: firstCode })).toMatchObject({ outcome: "refused", reason: "claim_expired" });
    expect(await fixture(request, baseURL!, { action: "operator", op: "reissue", orderId: second.orderId })).toMatchObject({ reissued: true });
    await fixture(request, baseURL!, { action: "work" });
    const replacement = codeIn((await fixture<{ messages: { text: string }[] }>(request, baseURL!, { action: "mailbox" })).messages);
    expect(replacement).not.toBe(firstCode);
    expect(await consumer(request, baseURL!, "b", "access", { action: "claim", token: firstCode })).toMatchObject({ outcome: "refused" });
    expect(await consumer(request, baseURL!, "b", "access", { action: "claim", token: replacement })).toMatchObject({ outcome: "claimed" });
    // Learner A still holds exactly one course; learner B now holds exactly one.
    expect(await consumer(request, baseURL!, "a", "access", { action: "access" })).toMatchObject({ view: { enrollments: [{}] } });
    expect(await consumer(request, baseURL!, "b", "access", { action: "access" })).toMatchObject({ view: { enrollments: [{}] } });
  } finally { await visitor.close(); }
});

test("7: outages are said as outages; a later course version refuses new purchases while what was bought is kept; the consult choice stays", async ({ page, request, baseURL }) => {
  await fixture(request, baseURL!, { action: "outage", target: "catalog", down: true });
  await page.goto(`/learn/${SLUG}`);
  await expect(page.getByTestId("funnel-buy-top")).toHaveAttribute("data-reason", "commerce_unverifiable");
  await expect(page.getByTestId("funnel-cta-top")).toBeVisible();
  await fixture(request, baseURL!, { action: "outage", target: "catalog", down: false });
  await fixture(request, baseURL!, { action: "outage", target: "processor", down: true });
  await page.goto(`/buy/${SLUG}`);
  await page.getByTestId("purchase-start-button").click();
  await expect(page.getByTestId("purchase-hold")).toHaveAttribute("data-hold", /.+/);
  expect(new URL(page.url()).searchParams.get("hold")).toBe("processor_unavailable");
  await fixture(request, baseURL!, { action: "outage", target: "processor", down: false });
  await fixture(request, baseURL!, { action: "publish", variant: "later" });
  await page.goto(`/learn/${SLUG}`);
  await expect(page.getByTestId("funnel-buy-top")).toHaveAttribute("data-reason", "curriculum_changed");
  expect(await consumer(request, baseURL!, "a", "access", { action: "curriculum", entitlementId })).toMatchObject({ read: { outcome: "served", curriculum } });
  // Consulting is a separate route: following it creates no order, entitlement or enrollment.
  const before = JSON.stringify((await fixture<{ commercial: Json }>(request, baseURL!, { action: "staff" })).commercial);
  const consult = await page.goto(await page.getByTestId("funnel-cta-top").getAttribute("href") ?? "/consult/longevity-program");
  expect(consult?.status()).toBeLessThan(500);
  expect(JSON.stringify((await fixture<{ commercial: Json }>(request, baseURL!, { action: "staff" })).commercial)).toBe(before);
});
