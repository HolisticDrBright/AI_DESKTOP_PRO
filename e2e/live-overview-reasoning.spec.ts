import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * PHASE 1 VERTICAL SLICE, browser-level: patient record → longitudinal
 * overview → Clinical Reasoning → practitioner review, against the committed
 * contract fixture backend (same recipe as the other live suites).
 *
 * What this proves that the SQL acceptance suites cannot:
 *   * the overview screen renders ONLY backend-supplied values — and the
 *     ungoverned metrics ("health score", wearables) say "Not enough verified
 *     data" instead of showing a number;
 *   * the change brief renders with dated, navigable source links;
 *   * the reasoning workspace shows snapshot version + STALE state, splits
 *     evidence, labels hypotheses as inferences, preserves the internal
 *     strength wording, and keeps "Unknown" as Unknown;
 *   * accepting a hypothesis persists (survives reload) and lands in the
 *     audit log — and does NOT modify any note;
 *   * cross-tenant/no-membership refusals surface as honest errors, and no
 *     fixture-dataset identity ever appears.
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-overview-reasoning.spec.ts
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

/**
 * Isolation, not ordering. This restores the whole fixture backend so the
 * suite runs against exactly the state it was written for, wherever it lands
 * in the battery.
 */
test.beforeAll(resetBackend);

const PATIENT = "aaaaaaaa-1111-2222-3333-444444444401";
const DEMO_FIXTURE_NAMES = ["Alexandra Morgan", "Michael Johnson", "Priya Sharma"];

test("overview renders verified data with honest ungoverned metrics", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/overview`);

  // Real demographics from the backend.
  await expect(page.getByText("Fixture Patient").first()).toBeVisible();
  await expect(page.getByText("Levothyroxine")).toBeVisible();
  await expect(page.getByText("Penicillin")).toBeVisible();
  await expect(page.getByText("Hypothyroidism")).toBeVisible();

  // Change brief: anchored, with dated source links.
  await expect(page.getByText("What changed since the last visit")).toBeVisible();
  const labChange = page.getByRole("link", { name: /New lab result: TSH/ });
  await expect(labChange).toBeVisible();

  // Ungoverned metrics: no invented number, the exact honest phrase.
  await expect(page.getByText("Health score", { exact: true })).toBeVisible();
  await expect(page.getByText("Not enough verified data").first()).toBeVisible();
  // No fabricated score value pattern next to the health-score card.
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/Health score\s*\n?\s*\d{1,3}/);

  // Missing-information indicators are named, not silent.
  await expect(page.getByText("Missing information")).toBeVisible();

  // No demo-dataset identity anywhere.
  for (const name of DEMO_FIXTURE_NAMES) expect(body).not.toContain(name);

  // A change-brief source link navigates to a real surface.
  await labChange.click();
  await page.waitForURL("**/labs**");
});

test("reasoning workspace: snapshot meta, stale state, split evidence, inference labeling", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/labs?view=reasoning`);

  await expect(page.getByText("snapshot v3")).toBeVisible();
  await expect(page.getByText(/^Stale:/)).toBeVisible();

  // AI generation honestly not configured.
  await expect(page.getByText(/AI snapshot generation is not configured/)).toBeVisible();

  // Hypothesis is an inference with the internal wording preserved verbatim.
  await expect(page.getByText("Subclinical hypothyroid pattern")).toBeVisible();
  await expect(page.getByText("Inference — not a diagnosis").first()).toBeVisible();
  await expect(
    page.getByText("Internal evidence weighting 78/100 — not a medical probability"),
  ).toBeVisible();

  // Unknown stays Unknown.
  await expect(page.getByText("Evidence weighting: Unknown")).toBeVisible();

  // Supporting / conflicting / missing render separately with a source link.
  await expect(page.getByText("Elevated TSH (6.2 mIU/L)")).toBeVisible();
  await expect(page.getByText("Fatigue is nonspecific")).toBeVisible();
  await expect(page.getByText("Free T4 not on file")).toBeVisible();
  await expect(page.getByRole("link", { name: /source ·/ }).first()).toBeVisible();

  // Urgent safety questions are shown and labelled lens-invariant.
  await expect(page.getByText("Any chest pain or palpitations at rest?")).toBeVisible();
  await expect(page.getByText(/identical under every clinical lens/)).toBeVisible();

  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/probability of|likelihood|% chance/i);
  for (const name of DEMO_FIXTURE_NAMES) expect(body).not.toContain(name);
});

test("accepting a hypothesis persists, audits, and touches no note", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/labs?view=reasoning`);

  const card = page.locator("section", { hasText: "Subclinical hypothyroid pattern" });
  await page.getByRole("button", { name: "Accept inference" }).first().click();

  // The RPC's message makes the no-auto-insert guarantee explicit.
  await expect(
    page
      .getByText("Hypothesis accepted as a reviewed inference. Nothing was added to a note or care plan.")
      .first(),
  ).toBeVisible();

  // Persisted: the workspace re-reads and shows the review; survives reload.
  await expect(page.getByText("Accepted (inference)").first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("Accepted (inference)").first()).toBeVisible();
  await expect(page.getByText(/Reviewed by Demo Practitioner/)).toBeVisible();

  // Audited: the review action appears in the live audit log.
  await page.goto("/settings/governance?tab=audit");
  await expect(page.getByText("hypothesis.accepted").first()).toBeVisible();
  await expect(
    page.getByText("Practitioner reviewed a clinical hypothesis (accepted)").first(),
  ).toBeVisible();

  // No note was created or modified: the chart timeline carries no new note
  // event from the acceptance.
  await page.goto(`/patients/${PATIENT}/chart`);
  const timeline = (await page.locator("body").innerText()).toLowerCase();
  expect(timeline).not.toContain("hypothesis");
  void card;
});

test("request-data records an actionable request", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/labs?view=reasoning`);

  // The second hypothesis is unreviewed; request data on it.
  await page.getByRole("button", { name: "Request data" }).nth(1).click();
  await page.getByPlaceholder(/What data is needed/).fill("Ferritin and full iron panel");
  await page.getByRole("button", { name: "Save request" }).click();

  await expect(
    page.getByText("More data requested. The request is saved and linked to this hypothesis.").first(),
  ).toBeVisible();
  await expect(page.getByText("More data requested").first()).toBeVisible();
});

test("a patient outside the caller's access shows an honest refusal, never data", async ({ page }) => {
  await page.goto(`/patients/eeeeeeee-9999-8888-7777-666666666666/overview`);
  // Wait for the shell to paint before reading text: reading innerText the
  // instant navigation resolves races the render and produced an empty string
  // in roughly half of runs (this flake predates the phase-2 branch). The
  // substance below is unchanged — SOMETHING must be said, it must be a
  // refusal, and it must contain no patient data.
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeAttached();
  await expect
    .poll(async () => (await page.locator("body").innerText()).trim().length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const body = (await page.locator("body").innerText()).trim();

  // Something is said, and it is a refusal/not-found — not a fabricated chart.
  expect(body.length).toBeGreaterThan(0);
  expect(body).toMatch(/not authorized|not found|couldn.t|unable|error|forbidden/i);
  for (const name of ["Fixture Patient", ...DEMO_FIXTURE_NAMES]) {
    expect(body).not.toContain(name);
  }
  expect(body).not.toContain("Levothyroxine");
});
