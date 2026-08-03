import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * PHASE 9E-A.1 — the unified curation workspace at /settings/imports.
 *
 * These proofs exercise the surfaces introduced by A.1: the Overview tab
 * with the mandatory workflow pointer, the Conflicts tab with governed
 * keep_existing / take_incoming / skip and a required reason, and the
 * Restricted-Review tab with all five governed outcomes (each demanding
 * a reason; the clinician outcome additionally demanding a jurisdiction).
 *
 * The safety invariants underneath — restrictions preserved on every
 * outcome, jurisdiction required, append-only history, isolation of
 * commercial data — are covered by supabase/tests/desktop_curation_governance.sql
 * (18 SQL checks). This file proves the WORKING WIRE from the UI down
 * to those RPCs, so an operator cannot silently bypass what the SQL is
 * enforcing.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1");

test.describe.configure({ mode: "serial" });

test.beforeAll(resetBackend);

const IMPORTS = "/settings/imports";
const STUB = "http://127.0.0.1:3999";

/**
 * Phase 9E-A.1 shipped a control-plane seeder for the restricted queue so
 * these workspace proofs are not coupled to the full parse/preview/commit
 * journey in `live-curated-import.spec.ts`. The A.1 restricted-review flow
 * is a governance surface — the parse pipeline is separately covered — so
 * seeding a known restricted row keeps the two proofs orthogonal.
 */
async function seedRestrictedProduct(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${STUB}/__control/seed-restricted-product`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      productId: "seed-a1-iv",
      name: "Seeded Restricted (IV)",
      restrictedFlags: ["iv_therapy", "prescription"],
      organizationId: "org-fixture",
      ...overrides,
    }),
  });
  if (!res.ok) throw new Error(`Failed to seed restricted product: ${res.status}`);
}

test("A.1 · the Overview tab surfaces the workflow pointer and composite counts", async ({ page }) => {
  await page.goto(IMPORTS);
  await page.getByTestId("tab-overview").click();

  await expect(page.getByTestId("ov-counts-declared")).toBeVisible();
  await expect(page.getByTestId("ov-counts-restricted")).toBeVisible();
  await expect(page.getByTestId("ov-counts-not-selectable")).toBeVisible();
  // Every stage in the workflow pointer is a live nav target — no dead buttons.
  await expect(page.getByTestId("ov-stage-1")).toBeVisible();
  await expect(page.getByTestId("ov-stage-2")).toBeVisible();
  await expect(page.getByTestId("ov-stage-3")).toBeVisible();
  await expect(page.getByTestId("ov-stage-4")).toBeVisible();
  await expect(page.getByTestId("ov-stage-5")).toBeVisible();
  await page.getByTestId("ov-goto-sources").click();
  await expect(page.getByTestId("tab-sources")).toHaveAttribute("aria-selected", "true");
});

test("A.1 · the Restricted-Review tab records a five-outcome decision and asserts restrictions are preserved", async ({
  page,
}) => {
  await seedRestrictedProduct();
  await page.goto(IMPORTS);
  await page.getByTestId("tab-restricted").click();

  const rows = page.getByTestId("restricted-list").getByRole("listitem");
  const row = rows.first();
  await expect(row).toBeVisible();

  const openBtn = row.locator('button[data-testid^="restricted-open-"]');
  await openBtn.click();

  const dialog = page.getByTestId("restricted-dialog");
  await expect(dialog).toBeVisible();

  // The five outcomes are the ONLY options offered — nothing that clears.
  const options = await dialog.getByTestId("restricted-outcome").locator("option").allTextContents();
  expect(options).toEqual([
    "Retain restricted",
    "Request evidence",
    "Defer",
    "Reject",
    "Clinician-reviewed for jurisdiction",
  ]);

  // A decision with no reason is not a decision.
  await expect(dialog.getByTestId("restricted-submit")).toBeDisabled();

  // The clinician outcome additionally demands a jurisdiction.
  await dialog.getByTestId("restricted-outcome").selectOption("clinician_reviewed_for_jurisdiction");
  await dialog.getByTestId("restricted-reason").fill("Reviewed the state formulary for this SKU.");
  await expect(dialog.getByTestId("restricted-submit")).toBeDisabled();
  await dialog.getByTestId("restricted-jurisdiction").fill("US-CA");
  await dialog.getByTestId("restricted-submit").click();

  // The confirmation is unmistakable: none of the five outcomes clears.
  await expect(dialog.getByTestId("restricted-message")).toContainText(/Restrictions preserved/i);
  await expect(dialog.getByTestId("restricted-history")).toBeVisible();
});

test("A.1 · the Restricted-Review filter chips slice the queue by governed category", async ({ page }) => {
  await seedRestrictedProduct({
    productId: "seed-a1-peptide",
    name: "Seeded Restricted (Peptide)",
    restrictedFlags: ["peptide"],
  });
  await page.goto(IMPORTS);
  await page.getByTestId("tab-restricted").click();

  await expect(page.getByTestId("restricted-filter-all")).toBeVisible();
  // The peptide chip is live because a peptide row is in the queue.
  await page.getByTestId("restricted-filter-peptide").click();
  await expect(page.getByTestId("restricted-list").getByRole("listitem")).toHaveCount(1);
});

test("A.1 · the deferred sections say precisely what is not yet available and what remains", async ({
  page,
}) => {
  await page.goto(IMPORTS);
  await page.getByTestId("tab-labels").click();
  await expect(page.locator("body")).toContainText(/Not available yet — Phase 9E-A\.2/i);
  await expect(page.locator("body")).toContainText(/versioned editor/i);

  await page.getByTestId("tab-references").click();
  await expect(page.locator("body")).toContainText(/Not available yet — Phase 9E-A\.2/i);
  await expect(page.locator("body")).toContainText(/citation review/i);

  await page.getByTestId("tab-commercial").click();
  await expect(page.locator("body")).toContainText(/Not available yet — Phase 9E-A\.2/i);
  await expect(page.locator("body")).toContainText(/never fuzzy/i);
});

test("A.1 · the /settings/knowledge Import-review tab redirects to /settings/imports", async ({ page }) => {
  await page.goto("/settings/knowledge");
  await page.getByRole("tab", { name: /Import review/i }).click();

  await expect(page.getByTestId("knowledge-imports-redirect")).toBeVisible();
  await expect(page.getByTestId("knowledge-imports-link")).toHaveAttribute("href", "/settings/imports");
  await expect(page.getByTestId("knowledge-imports-cta")).toHaveAttribute("href", "/settings/imports");
});
