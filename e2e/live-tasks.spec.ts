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

test("live labs workspace loads markers and a review persists across reload", async ({ page }) => {
  await page.goto("/patients/aaaaaaaa-1111-2222-3333-444444444401/labs");

  // Markers come from the fixture backend's clinical.labs.getWorkspace.
  await page.getByRole("button", { name: "Select hs-CRP" }).waitFor();
  await expect(page.getByRole("button", { name: "Select TSH" })).toBeVisible();

  // Review the high-confidence marker (no confirm dialog on this path).
  await page.getByRole("button", { name: "Select hs-CRP" }).click();
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(page.getByText(/Marked reviewed: hs-CRP.*saved to record/).first()).toBeVisible();

  // Fresh load with session state cleared: reviewed state must come from the
  // BACKEND marker row (reviewState), not this browser session.
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  const row = page.locator("tr", { hasText: "hs-CRP" });
  await expect(row.getByText("Reviewed", { exact: true })).toBeVisible();

  // The review landed in the live audit trail.
  await page.goto("/audit-log");
  await expect(page.getByText("biomarker.review").first()).toBeVisible();
});

test("uploading a lab PDF extracts markers and queues a low-confidence review", async ({ page }) => {
  await page.goto("/patients/aaaaaaaa-1111-2222-3333-444444444401/labs");
  await page.getByRole("button", { name: "Upload lab" }).click();

  await page.getByLabel("Lab report PDF").setInputFiles({
    name: "panel.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 fixture panel"),
  });
  await page.getByRole("button", { name: "Upload & extract" }).click();

  // Honest result panel, then the refreshed workspace shows the new markers.
  await expect(page.getByText("2 markers extracted")).toBeVisible();
  await page.getByRole("button", { name: "View extracted markers" }).click();
  await expect(page.getByRole("button", { name: "Select Glucose" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select Osmolality" })).toBeVisible();

  // The low-confidence extraction landed in the live review queue…
  await page.goto("/tasks");
  await expect(page.getByText("Verify 1 low-confidence marker from uploaded panel")).toBeVisible();

  // …and the ingestion event is in the live audit trail.
  await page.goto("/audit-log");
  await expect(page.getByText("lab_document.ingest").first()).toBeVisible();
});

test("practitioner sign-in and sign-out work via httpOnly cookie session", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Redirects home on success; the session endpoint reflects the cookie session.
  await page.waitForURL("**/");
  const session = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  expect(session?.data?.signedIn).toBe(true);
  expect(session?.data?.email).toBe("practitioner@fixture.local");

  await page.goto("/login");
  await expect(page.getByText(/Signed in as/)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const after = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  expect(after?.data?.signedIn).toBe(false);
});

test("no console errors in the live flow", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto("/tasks", { waitUntil: "networkidle" });
  await page.goto("/patients/aaaaaaaa-1111-2222-3333-444444444401/labs", { waitUntil: "networkidle" });
  await page.goto("/audit-log", { waitUntil: "networkidle" });
  await page.goto("/settings", { waitUntil: "networkidle" });
  expect(errors).toEqual([]);
});
