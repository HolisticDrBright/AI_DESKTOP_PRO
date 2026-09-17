import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

test.skip(!process.env.E2E_LIVE, "requires the synthetic clinical fixture");
test.beforeAll(resetBackend);
const chart = "/patients/aaaaaaaa-1111-2222-3333-444444444401/chart";

test("a stalled client navigation exposes the created encounter without a second POST", async ({ page }, testInfo) => {
  let creations = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.url().endsWith("/api/live/emr/encounter") && request.method() === "POST") creations++;
  });
  // Hold only RSC navigation. A normal document GET must remain available.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/patients/*/encounter/**", async route => {
    if (route.request().headers().rsc !== "1") return route.continue();
    await held;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto(chart);
    await page.getByRole("button", { name: "Start encounter", exact: true }).click();
    const link = page.getByTestId("open-created-encounter");
    await expect(link).toBeVisible();
    await expect(page.getByRole("button", { name: "Opening…" })).toHaveCount(0);
    expect(creations).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("encounter-ready-recovery.png") });
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/patients\/aaaaaaaa-1111-2222-3333-444444444401\/encounter\/[a-f0-9-]{36}$/);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByTestId("scribe-panel")).toBeVisible();
    expect(creations).toBe(1);
    expect(errors).toEqual([]);
  } finally { release(); }
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
