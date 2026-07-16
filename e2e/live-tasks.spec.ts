import { expect, test } from "@playwright/test";

/**
 * LIVE-MODE Tasks slice coverage. Skipped unless E2E_LIVE=1, because it needs
 * a live-flag build plus a reachable backend speaking the clinical.* contract
 * (the deployed tRPC backend, or the committed contract fixture).
 *
 * Full recipe (from the repo root):
 *   node scripts/live-stub-server.mjs &          # or a real backend
 *   NEXT_PUBLIC_USE_LIVE_API=true npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-tasks.spec.ts
 *
 * NOTE: the fixture backend is stateful in-memory — restart it between runs.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a live-flag build + backend");

test.describe.configure({ mode: "serial" });

test("live queue loads and shows the live boundary copy", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByText(/Live queue — resolving updates the record/)).toBeVisible();
  await expect(page.getByText("Recheck hs-CRP after abnormal result")).toBeVisible();
  // A row resolved in the BACKEND (not this session) still reads settled —
  // live rows show record state ("Resolved"), not "this session".
  await expect(page.getByText("Resolved", { exact: true }).first()).toBeVisible();
});

test("resolve persists across reload and lands in the live audit log", async ({ page }) => {
  await page.goto("/tasks");
  const row = page.getByText("Verify extracted markers from uploaded panel");
  await expect(row).toBeVisible();

  await page
    .getByRole("button", { name: /^Resolve — extraction review/ })
    .first()
    .click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText(/saved to record \+ audit/).first()).toBeVisible();

  // Fresh page load: state must come from the backend row, not sessionStorage.
  await page.goto("/tasks");
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  await expect(page.getByText("Verify extracted markers from uploaded panel")).toBeVisible();
  await expect(page.getByText("Resolved", { exact: true }).first()).toBeVisible();

  // Live audit log shows the persisted event, and survives its own reload.
  await page.goto("/audit-log");
  await expect(page.getByText("Live · append-only")).toBeVisible();
  await expect(page.getByText("review_task.resolve").first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("review_task.resolve").first()).toBeVisible();
});

test("no console errors in the live flow", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto("/tasks", { waitUntil: "networkidle" });
  await page.goto("/audit-log", { waitUntil: "networkidle" });
  await page.goto("/settings", { waitUntil: "networkidle" });
  expect(errors).toEqual([]);
});
