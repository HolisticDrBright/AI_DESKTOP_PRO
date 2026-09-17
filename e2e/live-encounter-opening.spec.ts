import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

test.skip(!process.env.E2E_LIVE, "requires the synthetic clinical fixture");
test.beforeAll(resetBackend);
const chart = "/patients/aaaaaaaa-1111-2222-3333-444444444401/chart";

test("creation opens the encounter document without relying on client navigation or another POST", async ({ page }, testInfo) => {
  let creations = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.url().endsWith("/api/live/emr/encounter") && request.method() === "POST") creations++;
  });
  let rscAttempts = 0;
  let documentRequests = 0;
  // Refuse client-router navigation: the creation handoff must use the document.
  await page.route("**/patients/*/encounter/**", async route => {
    if (route.request().headers().rsc === "1") { rscAttempts++; return route.abort(); }
    if (route.request().isNavigationRequest()) documentRequests++;
    return route.continue();
  });
    await page.goto(chart);
    await page.getByRole("button", { name: "Start encounter", exact: true }).click();
    await expect(page).toHaveURL(/\/patients\/aaaaaaaa-1111-2222-3333-444444444401\/encounter\/[a-f0-9-]{36}$/);
    await expect(page.getByTestId("scribe-panel")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("encounter-document-opened.png") });
    expect(creations).toBe(1);
    expect(documentRequests).toBe(1); expect(rscAttempts).toBe(0);
    expect(errors).toEqual([]);
});

test("cancelled browser navigation retains a direct link without creating another encounter", async ({ page }) => {
  let creations = 0;
  page.on("request", request => { if (request.url().endsWith("/api/live/emr/encounter") && request.method() === "POST") creations++; });
  await page.goto(chart);
  await page.evaluate(() => {
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    (window as unknown as { __blockEncounterLeave: typeof handler }).__blockEncounterLeave = handler;
    window.addEventListener("beforeunload", handler);
  });
  const dialog = page.waitForEvent("dialog");
  await page.getByRole("button", { name: "Start encounter", exact: true }).click({ noWaitAfter: true });
  await (await dialog).dismiss();
  const link = page.getByTestId("open-created-encounter"); await expect(link).toBeVisible();
  await expect(page.getByRole("button", { name: "Opening…" })).toHaveCount(0);
  await page.evaluate(() => window.removeEventListener("beforeunload", (window as unknown as { __blockEncounterLeave: (event: BeforeUnloadEvent) => void }).__blockEncounterLeave));
  await link.click();
  await expect(page.getByTestId("scribe-panel")).toBeVisible();
  expect(creations).toBe(1);
});

test("an uncertain creation offers timeline reconciliation, not an automatic retry", async ({ page }) => {
  let creations = 0;
  await page.route("**/api/live/emr/encounter", async route => {
    if (route.request().method() !== "POST") return route.continue();
    creations++;
    // Simulate a gateway failure after a real fixture commit.
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  await page.goto(chart);
  await page.getByRole("button", { name: "Start encounter", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not confirm whether the encounter was created" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start encounter", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Review chart timeline", exact: true }).click();
  await expect(page.getByTestId("timeline-list")).toBeVisible();
  expect(creations).toBe(1);
});
