import { createHmac } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * Lesson media on My courses, mounted in the browser, under its OWN flag on top of the journey
 * fixture (COMMERCE_JOURNEY_FIXTURE=1 and LEARNER_MEDIA_FIXTURE=1 with the local contract fixture;
 * see src/server/programs/learner-media-journey-fixture.ts). Without the media flag the course is the
 * eight-case journey's exactly and nothing here runs.
 *
 * What is real: the purchase page and checkout route, the webhook route, the worker, delivery, the
 * claim, the My courses page, its transport and controller, the route, the learner media service and
 * the real exact-version signer. What stands in: the processor's page, the consumer sign-in (the
 * fixture session), the media authority (decided from the fixture's own purchase) and the storage
 * reader (fictional credentials; the signed bucket host is intercepted, so no request leaves this
 * machine). Evidence class: fictional-provider browser evidence. Not hosted, provider or device.
 */
const enabled = process.env.COMMERCE_JOURNEY_FIXTURE === "1" && process.env.LEARNER_MEDIA_FIXTURE === "1";
test.skip(!process.env.E2E_LIVE || !enabled, "learner media fixture: set E2E_LIVE=1, COMMERCE_JOURNEY_FIXTURE=1 and LEARNER_MEDIA_FIXTURE=1 with the contract fixture");
test.describe.configure({ mode: "serial" });

const SLUG = "fictional-journey-fixture";
const SECRET = process.env.STRIPE_TEST_WEBHOOK_SECRET ?? "";
const BUCKET_HOST = "https://alp-fictional-lessons.s3.us-east-2.amazonaws.com";
type Json = Record<string, unknown>;
async function fixture<T = Json>(request: APIRequestContext, baseURL: string, body: Json): Promise<T> {
  const response = await request.post(`${baseURL}/api/live/commerce/fixture`, { data: body });
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
async function signedEvent(request: APIRequestContext, baseURL: string, sessionRef: string) {
  const body = JSON.stringify({ id: "evt_media_completed", type: "checkout.session.completed", livemode: false, created: Math.floor(Date.now() / 1000), api_version: "2025-08-27.basil", data: { object: { object: "checkout.session", id: sessionRef } } });
  const t = Math.floor(Date.now() / 1000);
  return request.post(`${baseURL}/api/live/commerce/webhook`, { headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`, "utf8").digest("hex")}` }, data: body });
}
/** The processor's page and the bucket: the only interceptions. Every request to the reference's own address is recorded, and there must be none. */
async function standIns(page: Page, referenceHits: string[]) {
  await page.route("https://checkout.fictional.example/**", route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Fictional hosted checkout (test fixture)</title><main data-testid=\"hosted-checkout\">Fictional hosted checkout.</main>" }));
  await page.route(`${BUCKET_HOST}/**`, route => route.fulfill({ status: 404, body: "" }));
  await page.route("https://lessons.fictional.example/**", route => { referenceHits.push(route.request().url()); return route.abort(); });
}
const hide = (page: Page) => page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
const show = (page: Page) => page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });

let entitlementId = "";
test.beforeAll(async ({ request, baseURL }) => {
  await resetBackend();
  await fixture(request, baseURL!, { action: "reset" });
});

test("a bought course: the media lesson shows the exact version with its published text, a text lesson shows none, and a hidden tab drops it", async ({ browser, baseURL }) => {
  const learner = await browser.newContext();
  const referenceHits: string[] = [];
  try {
    const page = await learner.newPage();
    await standIns(page, referenceHits);
    // Buy and claim through the real routes (the fixture stands in for the processor and the inbox).
    await page.goto(`/buy/${SLUG}`);
    await page.getByTestId("purchase-start-button").click();
    await page.getByTestId("checkout-continue-link").click();
    await expect(page.getByTestId("hosted-checkout")).toBeVisible();
    const staff = await fixture<{ commercial: { orders: { orderId: string; processor: { sessionRef: string } }[] } }>(learner.request, baseURL!, { action: "staff" });
    const order = staff.commercial.orders[0]!;
    await fixture(learner.request, baseURL!, { action: "pay", orderId: order.orderId, outcome: "paid" });
    expect((await signedEvent(learner.request, baseURL!, order.processor.sessionRef)).status()).toBe(200);
    await fixture(learner.request, baseURL!, { action: "work" });
    const mail = await fixture<{ messages: { text: string }[] }>(learner.request, baseURL!, { action: "mailbox" });
    const code = mail.messages.map(m => /^([A-Za-z0-9_-]{43})$/m.exec(m.text)?.[1]).filter(Boolean).at(-1)!;
    expect(await fixture(learner.request, baseURL!, { action: "consumer", learner: "a", service: "access", body: { action: "claim", token: code } })).toMatchObject({ outcome: "claimed" });
    const access = await fixture<{ view: { entitlements: { entitlementId: string }[] } }>(learner.request, baseURL!, { action: "consumer", learner: "a", service: "access", body: { action: "access" } });
    entitlementId = access.view.entitlements[0]!.entitlementId;

    await fixture(learner.request, baseURL!, { action: "learner_session", learner: "a" });
    await page.goto("/courses");
    await page.getByTestId(`learner-open-${entitlementId}`).click();
    await page.getByTestId("learner-lesson-open-lesson-a").click();
    await expect(page.getByTestId("learner-lesson-text")).toBeVisible();
    await expect(page.getByTestId("learner-lesson-media-held")).toHaveCount(0);
    await expect(page.locator('[data-testid^="learner-media-"]')).toHaveCount(0);

    const media = page.waitForResponse(response => response.url().endsWith("/api/my-courses") && response.request().postData()?.includes('"service":"media"') === true);
    await page.getByTestId("learner-lesson-overview").click();
    await page.getByTestId("learner-lesson-open-lesson-c").click();
    const reply = await media;
    expect(reply.headers()["cache-control"]).toBe("no-store, private");
    await expect(page.getByTestId("learner-media-0")).toHaveAttribute("data-media-state", "available");
    const video = page.getByTestId("learner-media-0-video");
    const src = await video.getAttribute("src");
    expect(new URL(src!).origin).toBe(BUCKET_HOST);
    expect(new URL(src!).searchParams.get("versionId")).toBe("fictional-fixture-object-version-1");
    expect(new URL(src!).searchParams.get("X-Amz-Expires")).toBe("300");
    await expect(page.locator('[data-testid="learner-media-0-video"] track[kind="captions"]')).toHaveCount(1);
    await page.getByTestId("learner-media-0-transcript").locator("summary").click();
    await expect(page.getByTestId("learner-media-0-transcript-text")).toHaveText("Fictional transcript of the journey fixture lesson. Nothing here is advice.");
    // The capability is not kept anywhere the page can read it later.
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie)).not.toContain("X-Amz-Signature");

    // Hidden: the player, its address and the transcript leave the page at once.
    await hide(page);
    await expect(page.getByTestId("learner-media-0-video")).toHaveCount(0);
    await expect(page.getByTestId("learner-media-0-transcript-text")).toHaveCount(0);
    expect(await page.content()).not.toContain("X-Amz-Signature");
    await show(page);
    await page.getByTestId(`learner-open-${entitlementId}`).click();
    await page.getByTestId("learner-lesson-open-lesson-c").click();
    await expect(page.getByTestId("learner-media-0")).toHaveAttribute("data-media-state", "available");
    expect(referenceHits).toEqual([]);
  } finally { await learner.close(); }
});

test("another learner is refused the same slot, and signing out elsewhere takes the media and the lesson with it", async ({ browser, baseURL }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const referenceHits: string[] = [];
  try {
    await fixture(b.request, baseURL!, { action: "learner_session", learner: "b" });
    const access = await fixture<{ view: { entitlements: { curriculum: Json }[] } }>(a.request, baseURL!, { action: "consumer", learner: "a", service: "access", body: { action: "access" } });
    const ask = await b.request.post(`${baseURL}/api/my-courses`, { headers: { origin: baseURL!, "content-type": "application/json" }, data: { service: "media", body: {
      contractVersion: "program-learner-media/1", entitlementId, curriculum: access.view.entitlements[0]!.curriculum, lesson: { phaseId: "phase-2", itemId: "lesson-c" }, slot: 0,
      expected: { artifactId: "7e1a0000-0000-4000-8000-000000000020", version: 4, sha256: "f1c7".padEnd(64, "0") } } } });
    expect(ask.status()).toBe(200);
    expect((await ask.json()).data).toEqual({ outcome: "not_available" });

    const page = await a.newPage();
    await standIns(page, referenceHits);
    await fixture(a.request, baseURL!, { action: "learner_session", learner: "a" });
    await page.goto("/courses");
    await page.getByTestId(`learner-open-${entitlementId}`).click();
    await page.getByTestId("learner-lesson-open-lesson-c").click();
    await expect(page.getByTestId("learner-media-0")).toHaveAttribute("data-media-state", "available");
    await fixture(a.request, baseURL!, { action: "learner_revoke", learner: "a" });
    await page.getByTestId("learner-lesson-previous").click();
    await expect(page.getByTestId("learner-error")).toContainText("Sign in");
    await expect(page.locator('[data-testid^="learner-media-"]')).toHaveCount(0);
    await expect(page.getByTestId("learner-lesson-text")).toHaveCount(0);
    expect(await page.content()).not.toContain("X-Amz-Signature");
    expect(referenceHits).toEqual([]);
  } finally { await a.close(); await b.close(); }
});
