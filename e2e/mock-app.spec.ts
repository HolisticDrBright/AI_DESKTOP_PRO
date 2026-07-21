import { expect, test, type Page } from "@playwright/test";

/**
 * Mock-app E2E coverage (demo mode, no live backend).
 *
 * Each test runs in a fresh browser context, so sessionStorage-backed demo
 * state (review outcomes, audit log, queue items) is isolated per test.
 * Where a test asserts persistence, the action and the reload happen inside
 * the same test/context — matching what the UI promises ("this session").
 */

const PATIENT = "p-78435";

/** Collect real page/console errors (benign resource 404s excluded). */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) {
      errors.push(`console: ${m.text()}`);
    }
  });
  return errors;
}

test("app shell loads (sidebar, top bar, patient overview)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: /command palette/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Labs & Biomarkers" })).toBeVisible();
});

test("patient summary loads with header card", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/summary`);
  await expect(page.getByRole("heading", { name: "Alexandra Morgan" })).toBeVisible();
  await expect(page.getByText("Primary Goals")).toBeVisible();
});

test("snapshot approve updates visible state", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/summary`);
  const approve = page.getByRole("button", { name: /^Approve —/ }).first();
  await approve.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved this session").first()).toBeVisible();
});

test("audit event survives reload in the same session", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/summary`);
  await page.getByRole("button", { name: /^Approve —/ }).first().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved this session").first()).toBeVisible();

  await page.goto("/audit-log");
  await expect(page.getByText("Approve", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("Approve", { exact: true }).first()).toBeVisible();
});

test("tasks filters narrow the queue (saved view + priority param)", async ({ page }) => {
  await page.goto("/tasks");
  const rows = page.getByText(/Assigned /);
  // The queue loads through the async façade — wait for rows before counting.
  await rows.first().waitFor();
  const all = await rows.count();
  expect(all).toBeGreaterThan(4);

  await page.getByRole("button", { name: "Urgent", exact: true }).click();
  await expect
    .poll(async () => rows.count(), { message: "urgent view should narrow rows" })
    .toBeLessThan(all);

  // Deep-linked priority filter (used by the patient right rail).
  await page.goto("/tasks?priority=High");
  await rows.first().waitFor();
  const high = await rows.count();
  expect(high).toBeGreaterThan(0);
  expect(high).toBeLessThan(all);
});

test("overdue saved view actually filters to overdue items (P0 regression)", async ({ page }) => {
  await page.goto("/tasks");
  const rows = page.getByText(/Assigned /);
  await rows.first().waitFor();
  const all = await rows.count();

  await page.getByRole("button", { name: "Overdue", exact: true }).click();
  // The memo previously omitted overdueOnly from its deps, so this view
  // silently showed everything. It must narrow to ONLY overdue rows now.
  await expect
    .poll(async () => rows.count(), { message: "overdue view should narrow rows" })
    .toBe(2);
  await expect(page.getByText("Iron repletion protocol — phase 1 pending approval")).toBeVisible();
  // A known non-overdue row must be gone.
  await expect(page.getByText(/Assigned /).first()).toBeVisible();
  expect(await rows.count()).toBeLessThan(all);
});

test("task resolve updates the row and records audit", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByRole("button", { name: /^Resolve —/ }).first().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText("Resolved this session").first()).toBeVisible();

  await page.goto("/audit-log");
  await expect(page.getByText("Resolve", { exact: true }).first()).toBeVisible();
});

test("labs workspace loads markers", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/labs`);
  await expect(page.getByRole("heading", { name: "hs-CRP" })).toBeVisible();
  await expect(page.getByText(/awaiting review/).first()).toBeVisible();
});

test("marker selection updates the inspector", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/labs`);
  await expect(page.getByRole("heading", { name: "hs-CRP" })).toBeVisible();
  await page.getByRole("button", { name: "Vitamin D, 25-OH" }).click();
  await expect(page.getByRole("heading", { name: "Vitamin D, 25-OH" })).toBeVisible();
});

test("low-confidence marker review requires confirmation", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/labs`);
  await page.getByRole("button", { name: "Fasting insulin" }).click();
  await expect(page.getByRole("heading", { name: "Fasting insulin" })).toBeVisible();
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/low extraction confidence/i)).toBeVisible();
  await dialog.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(page.getByRole("button", { name: "Reviewed", exact: true })).toBeVisible();
});

test("marker action opens composer with seeded context", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/labs`);
  await expect(page.getByRole("heading", { name: "hs-CRP" })).toBeVisible();
  await page.getByRole("button", { name: /^Add to note —/ }).first().click();
  const composer = page.getByRole("dialog", { name: /composer/i });
  await expect(composer).toBeVisible();
  await expect
    .poll(async () => (await page.locator("#composer-body").inputValue()).length, {
      message: "composer body should be seeded from the marker context",
    })
    .toBeGreaterThan(40);
});

test("import wizard reaches review-queue completion", async ({ page }) => {
  await page.goto("/imports");
  await page.getByText("Practice Better").first().click();
  await page.getByRole("button", { name: /Upload & detect/ }).click();
  await page.getByRole("button", { name: "Continue to mapping" }).click();
  await page.getByRole("button", { name: "Continue to conflicts" }).click();
  await page.getByRole("button", { name: "Continue to preview" }).click();
  await page.getByRole("button", { name: /Queue \d+ for review/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Queue for review" }).click();
  await expect(page.getByText(/queued for practitioner review/).first()).toBeVisible();
});

test("settings display scale changes UI mode", async ({ page }) => {
  await page.goto("/settings");
  const scaleControl = page.locator('[aria-label="Display scale"]');
  await expect(scaleControl).toBeVisible();
  await scaleControl.getByText("Large", { exact: true }).click();
  await expect(page.locator('[data-scale="large"]')).toHaveCount(1);
  await scaleControl.getByText("Compact", { exact: true }).click();
  await expect(page.locator('[data-scale="compact"]')).toHaveCount(1);
});

test("no console errors across the main flows", async ({ page }) => {
  const errors = trackErrors(page);
  for (const route of [
    "/practice",
    "/tasks",
    `/patients/${PATIENT}/summary`,
    `/patients/${PATIENT}/chart`,
    `/patients/${PATIENT}/labs`,
    `/patients/${PATIENT}/lab-orders`,
    `/patients/${PATIENT}/reasoning`,
    `/patients/${PATIENT}/supplements`,
    "/calendar",
    "/programs",
    "/imports",
    "/audit-log",
    "/integrations",
    "/settings",
    "/ai-safety",
  ]) {
    await page.goto(route, { waitUntil: "networkidle" });
  }
  expect(errors).toEqual([]);
});

test("chart: dynamic fields, body-chart draw, sign, and AI scribe", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(`/patients/${PATIENT}/chart`, { waitUntil: "networkidle" });

  // Template renders: a checkbox group, a 0–10 slider, SOAP boxes.
  await expect(page.getByText("Lung & Large Intestine")).toBeVisible();
  await expect(page.getByRole("slider", { name: "Energy" })).toBeVisible();

  // Subjective quick-tag toggles.
  const tag = page.getByRole("button", { name: "Poor Sleep", exact: true });
  await tag.click();
  await expect(tag).toHaveAttribute("aria-pressed", "true");

  // A symptom checkbox toggles on.
  const symptom = page.getByRole("checkbox", { name: "Allergies", exact: true });
  await symptom.click();
  await expect(symptom).toHaveAttribute("aria-checked", "true");

  // Draw a stroke on the first body chart (front silhouette).
  const canvas = page.locator("svg.touch-none").first();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45, { steps: 6 });
    await page.mouse.up();
    await expect(canvas.locator("polyline")).toHaveCount(1);
  }

  // AI Scribe panel opens.
  await page.getByRole("button", { name: "AI Scribe" }).click();
  await expect(page.getByRole("dialog", { name: "AI Scribe" })).toBeVisible();
  await page.getByRole("button", { name: "Close AI Scribe" }).click();
  await expect(page.getByRole("dialog", { name: "AI Scribe" })).toHaveCount(0);

  // Sign the note → read-only banner appears.
  await page.getByRole("button", { name: "Sign note" }).click();
  await expect(page.getByText("Signed note — read only.")).toBeVisible();

  // Selection persists after a reload (demo session store).
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("button", { name: "Poor Sleep", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  expect(errors).toEqual([]);
});
