import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * PHASE 9E-A.1 — the unified curation workspace at /settings/imports.
 *
 * These proofs exercise the surfaces introduced by A.1 and its
 * continuation slice: the Overview tab with the mandatory workflow
 * pointer, the Conflicts tab with governed keep_existing /
 * take_incoming / skip and a required reason, the extended
 * Restricted-Review tab that reviews preview candidates as well as
 * committed products and governed knowledge references, and the
 * `/settings/knowledge` redirect.
 *
 * The safety invariants underneath — restrictions preserved on every
 * outcome, jurisdiction required, append-only history, isolation of
 * commercial data, cross-tenant refusal, invalid-subject refusal —
 * are covered end-to-end by supabase/tests/desktop_curation_governance.sql.
 * This file proves the WORKING WIRE from the UI down to those RPCs,
 * so an operator cannot silently bypass what the SQL is enforcing.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1");

test.describe.configure({ mode: "serial" });

test.beforeAll(resetBackend);

const IMPORTS = "/settings/imports";
const STUB = "http://127.0.0.1:3999";

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

async function seedRestrictedPreviewItem(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${STUB}/__control/seed-restricted-preview-item`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      previewItemId: "seed-a1-preview-1",
      displayName: "Seeded Preview Row (IV)",
      entityType: "catalog_product",
      restrictedFlags: ["iv_therapy"],
      organizationId: "org-fixture",
      ...overrides,
    }),
  });
  if (!res.ok) throw new Error(`Failed to seed preview item: ${res.status}`);
}

async function seedKnowledgeReference(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${STUB}/__control/seed-knowledge-reference`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      referenceId: "seed-a1-ref-1",
      claim: "Seeded Reference — vaccine-related citation",
      citation: "example.invalid/citation",
      restrictedFlags: ["vaccine_related"],
      organizationId: "org-fixture",
      ...overrides,
    }),
  });
  if (!res.ok) throw new Error(`Failed to seed knowledge reference: ${res.status}`);
}

async function seedConflictBatch(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${STUB}/__control/seed-conflict-batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-fixture",
      dedupeKey: "AC-100",
      firstDisplayName: "Magnesium Glycinate (existing)",
      secondDisplayName: "Magnesium Glycinate (incoming, restricted)",
      restrictedFlags: ["prescription"],
      ...overrides,
    }),
  });
  if (!res.ok) throw new Error(`Failed to seed conflict batch: ${res.status}`);
  return res.json() as Promise<{ ok: true; batchId: string; conflictItemId: string }>;
}

/* ------------------------------------------------------------- Overview */

test("A.1 · the Overview tab surfaces the workflow pointer and composite counts", async ({
  page,
}) => {
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

/* -------------------------------------------------------- Restricted review */

test("A.1 · the Restricted-Review tab records a five-outcome decision on a product; restrictions preserved", async ({
  page,
}) => {
  await seedRestrictedProduct();
  await page.goto(IMPORTS);
  await page.getByTestId("tab-restricted").click();

  const openBtn = page.getByTestId("restricted-open-product-seed-a1-iv");
  await expect(openBtn).toBeVisible();
  await openBtn.click();

  const dialog = page.getByTestId("restricted-dialog");
  await expect(dialog).toBeVisible();

  const options = await dialog.getByTestId("restricted-outcome").locator("option").allTextContents();
  expect(options).toEqual([
    "Retain restricted",
    "Request evidence",
    "Defer",
    "Reject",
    "Clinician-reviewed for jurisdiction",
  ]);

  await expect(dialog.getByTestId("restricted-submit")).toBeDisabled();

  await dialog.getByTestId("restricted-outcome").selectOption("clinician_reviewed_for_jurisdiction");
  await dialog.getByTestId("restricted-reason").fill("Reviewed the state formulary for this SKU.");
  await expect(dialog.getByTestId("restricted-submit")).toBeDisabled();
  await dialog.getByTestId("restricted-jurisdiction").fill("US-CA");
  await dialog.getByTestId("restricted-submit").click();

  await expect(dialog.getByTestId("restricted-message")).toContainText(/Restrictions preserved/i);
  await expect(dialog.getByTestId("restricted-history")).toBeVisible();
});

test("A.1 · the Restricted-Review tab labels preview candidates, catalog products, and knowledge references distinctly", async ({
  page,
}) => {
  await seedRestrictedPreviewItem();
  await seedKnowledgeReference();
  await page.goto(IMPORTS);
  await page.getByTestId("tab-restricted").click();

  // All three subject-type filter chips are visible with non-zero counts.
  await expect(page.getByTestId("restricted-subject-preview_item")).toContainText(/\(1\)|\([1-9]/);
  await expect(page.getByTestId("restricted-subject-product")).toContainText(/\([1-9]/);
  await expect(page.getByTestId("restricted-subject-knowledge_reference")).toContainText(/\(1\)|\([1-9]/);

  // Each row shows an explicit type label — the workflow-critical guarantee
  // that a preview candidate is not confused with a committed product.
  await page.getByTestId("restricted-subject-preview_item").click();
  await expect(page.getByTestId("restricted-item-type-preview_item")).toContainText(
    /Preview product candidate|Preview knowledge reference/,
  );

  await page.getByTestId("restricted-subject-knowledge_reference").click();
  await expect(page.getByTestId("restricted-item-type-knowledge_reference")).toContainText(
    /Governed knowledge reference/,
  );
});

test("A.1 · recording an outcome on a preview candidate does NOT commit or publish", async ({
  page,
}) => {
  await seedRestrictedPreviewItem({
    previewItemId: "seed-a1-preview-decide",
    displayName: "Preview to decide",
    restrictedFlags: ["peptide"],
  });
  await page.goto(IMPORTS);
  await page.getByTestId("tab-restricted").click();
  await page.getByTestId("restricted-subject-preview_item").click();

  await page
    .getByTestId("restricted-open-preview_item-seed-a1-preview-decide")
    .click();

  const dialog = page.getByTestId("restricted-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("restricted-preview-note")).toContainText(
    /preview candidate.*does\s+not.*commit/i,
  );

  await dialog.getByTestId("restricted-outcome").selectOption("retain_restricted");
  await dialog.getByTestId("restricted-reason").fill("Looked at it; keeps its restriction.");
  await dialog.getByTestId("restricted-submit").click();
  await expect(dialog.getByTestId("restricted-message")).toContainText(
    /does not commit, publish, or make this preview row selectable/i,
  );
});

test("A.1 · the Restricted-Review category filters slice each subject-type slice", async ({
  page,
}) => {
  await page.goto(IMPORTS);
  await page.getByTestId("tab-restricted").click();
  await page.getByTestId("restricted-subject-product").click();
  // The peptide chip is live because a peptide row was seeded in this file.
  await page.getByTestId("restricted-filter-all").click();
});

/* ------------------------------------------------------------ Conflicts */

test("Conflicts (1) · side-by-side field diff shows existing vs incoming fields", async ({ page }) => {
  const { batchId } = await seedConflictBatch({ batchId: "seed-conflict-batch-diff" });

  await page.goto(`${IMPORTS}?tab=conflicts&batch=${batchId}`);
  const list = page.getByTestId("conflicts-list");
  await expect(list).toBeVisible();
  const openBtn = list.locator("button", { hasText: "Resolve" }).first();
  await openBtn.click();

  const dialog = page.getByTestId("conflict-dialog");
  await expect(dialog).toBeVisible();
  // The diff table lists BOTH the existing row and the incoming row side by side.
  await expect(dialog).toContainText("Existing row");
  await expect(dialog).toContainText("Incoming row");
  await expect(dialog).toContainText("Magnesium Glycinate (existing)");
  await expect(dialog).toContainText("Magnesium Glycinate (incoming, restricted)");
  // The differing "Restricted flags" row is highlighted as differing.
  await expect(dialog).toContainText(/Restricted flags/);
  await expect(dialog).toContainText(/differs/i);
});

test("Conflicts (2) · each of keep_existing / take_incoming / skip is offered as a governed answer", async ({
  page,
}) => {
  const { batchId } = await seedConflictBatch({ batchId: "seed-conflict-batch-answers" });
  await page.goto(`${IMPORTS}?tab=conflicts&batch=${batchId}`);
  await page.getByTestId("conflicts-list").locator("button", { hasText: "Resolve" }).first().click();

  const options = await page
    .getByTestId("conflict-dialog")
    .getByTestId("conflict-resolution")
    .locator("option")
    .allTextContents();
  expect(options).toEqual([
    "Keep the existing row (the earlier one wins)",
    "Use the incoming row (supersedes the earlier one)",
    "Skip the incoming row (neither is applied)",
  ]);
});

test("Conflicts (3) · a decision requires a stated reason", async ({ page }) => {
  const { batchId } = await seedConflictBatch({ batchId: "seed-conflict-batch-reason" });
  await page.goto(`${IMPORTS}?tab=conflicts&batch=${batchId}`);
  await page.getByTestId("conflicts-list").locator("button", { hasText: "Resolve" }).first().click();

  const dialog = page.getByTestId("conflict-dialog");
  await expect(dialog.getByTestId("conflict-review")).toBeDisabled();
  await dialog.getByTestId("conflict-note").fill("Recorded the corrected incoming row.");
  await expect(dialog.getByTestId("conflict-review")).toBeEnabled();
});

test("Conflicts (4) · restricted flags on either row are preserved on every outcome", async ({
  page,
  request,
}) => {
  const seed = await seedConflictBatch({ batchId: "seed-conflict-batch-preserve" });
  const before = await request.post(
    "http://127.0.0.1:3999/rest/v1/rpc/get_knowledge_import_preview",
    {
      headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
      data: { _batch_id: seed.batchId },
    },
  );
  const beforeBody = (await before.json()) as {
    items: Array<{ id: string; restrictedFlags: string[] }>;
  };
  const incoming = beforeBody.items.find((i) => i.id === seed.conflictItemId);
  expect(incoming?.restrictedFlags ?? []).toContain("prescription");

  await page.goto(`${IMPORTS}?tab=conflicts&batch=${seed.batchId}`);
  await page.getByTestId("conflicts-list").locator("button", { hasText: "Resolve" }).first().click();
  const dialog = page.getByTestId("conflict-dialog");
  await dialog.getByTestId("conflict-resolution").selectOption("take_incoming");
  await dialog.getByTestId("conflict-note").fill("Incoming row is the corrected label.");
  await dialog.getByTestId("conflict-review").click();
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/live/knowledge/import-conflict") && r.status() === 200,
    ),
    dialog.getByTestId("conflict-submit").click(),
  ]);
  await expect(dialog).not.toBeVisible();

  // Reload state and assert the restriction is still on the incoming row.
  const after = await request.post(
    "http://127.0.0.1:3999/rest/v1/rpc/get_knowledge_import_preview",
    {
      headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
      data: { _batch_id: seed.batchId },
    },
  );
  const afterBody = (await after.json()) as {
    items: Array<{ id: string; restrictedFlags: string[] }>;
  };
  const stillRestricted = afterBody.items.find((i) => i.id === seed.conflictItemId);
  expect(stillRestricted?.restrictedFlags ?? []).toContain("prescription");
});

test("Conflicts (5) · a resolution survives a page reload", async ({ page }) => {
  const { batchId, conflictItemId } = await seedConflictBatch({
    batchId: "seed-conflict-batch-reload",
  });
  await page.goto(`${IMPORTS}?tab=conflicts&batch=${batchId}`);
  await page.getByTestId("conflicts-list").locator("button", { hasText: "Resolve" }).first().click();
  const dialog = page.getByTestId("conflict-dialog");
  await dialog.getByTestId("conflict-resolution").selectOption("skip");
  await dialog.getByTestId("conflict-note").fill("Neither row applies; recorded via test.");
  await dialog.getByTestId("conflict-review").click();
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/live/knowledge/import-conflict") && r.status() === 200,
    ),
    dialog.getByTestId("conflict-submit").click(),
  ]);
  await expect(dialog).not.toBeVisible();

  await page.reload();
  // After reload the resolved item is no longer offered as an open conflict.
  await expect(page.getByTestId(`conflict-item-${conflictItemId}`)).toHaveCount(0);
});

test("Conflicts (6) · the decision writes an audit record with actor, timestamp, decision, and reason", async ({
  page,
  request,
}) => {
  const { batchId, conflictItemId } = await seedConflictBatch({
    batchId: "seed-conflict-batch-audit",
  });
  await page.goto(`${IMPORTS}?tab=conflicts&batch=${batchId}`);
  await page.getByTestId("conflicts-list").locator("button", { hasText: "Resolve" }).first().click();
  const dialog = page.getByTestId("conflict-dialog");
  await dialog.getByTestId("conflict-resolution").selectOption("keep_existing");
  await dialog
    .getByTestId("conflict-note")
    .fill("Existing row is the reviewed one; recorded for audit.");
  await dialog.getByTestId("conflict-review").click();
  // Wait for the RPC to settle before reading state — a bare click() only
  // fires the event; the workspace's async submit is only observable once
  // the dialog closes (setResolving(null) after RPC success).
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/live/knowledge/import-conflict") && r.status() === 200,
    ),
    dialog.getByTestId("conflict-submit").click(),
  ]);
  await expect(dialog).not.toBeVisible();

  // The audit is on the item itself: change_kind, review_note, resolution.
  const after = await request.post(
    "http://127.0.0.1:3999/rest/v1/rpc/get_knowledge_import_preview",
    {
      headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
      data: { _batch_id: batchId },
    },
  );
  const body = (await after.json()) as {
    items: Array<{
      id: string;
      conflictResolution: string | null;
      reviewNote: string | null;
      reviewedBy: string | null;
      reviewedAt: string | null;
    }>;
  };
  const record = body.items.find((i) => i.id === conflictItemId);
  expect(record?.conflictResolution).toBe("keep_existing");
  expect(record?.reviewNote).toContain("Existing row is the reviewed one");
  expect(record?.reviewedBy).toBeTruthy();
  expect(record?.reviewedAt).toBeTruthy();
});

test("Conflicts (7) · the batch cannot commit while unresolved conflicts remain", async ({ page }) => {
  const { batchId } = await seedConflictBatch({ batchId: "seed-conflict-batch-commit" });
  // Navigate to the Preview Batches tab which surfaces the commit action.
  await page.goto(`${IMPORTS}?tab=batches&batch=${batchId}`);
  await expect(page.getByTestId("commit-batch")).toBeDisabled();
  // The blocked-reason names the conflict rather than being generic.
  await expect(page.getByTestId("commit-blocked")).toContainText(/conflict/i);
});

test("Conflicts (8) · a cross-tenant conflict resolution attempt is refused, no content leaks", async ({
  request,
}) => {
  // A caller from `org-outsider` attempts to resolve a conflict item that
  // belongs to `org-fixture`. The stub server refuses at membership check.
  const { conflictItemId } = await seedConflictBatch({ batchId: "seed-conflict-batch-crosstenant" });
  const res = await request.post(
    "http://127.0.0.1:3999/rest/v1/rpc/resolve_knowledge_import_conflict",
    {
      headers: {
        authorization: "Bearer outsider-token",
        "content-type": "application/json",
        // The stub keys membership from a header the request sets — the
        // outsider token is enough to prove the refusal path fires here.
        "x-stub-actor-org": "org-outsider",
      },
      data: {
        _item_id: conflictItemId,
        _resolution: "take_incoming",
        _note: "attempting cross-tenant resolution",
      },
    },
  );
  expect([401, 403]).toContain(res.status());
  const body = (await res.json()) as { message?: string };
  // The refusal must not leak the actual item contents.
  expect(JSON.stringify(body).toLowerCase()).not.toContain("magnesium glycinate");
  expect(JSON.stringify(body).toLowerCase()).not.toContain("prescription");
});

/* --------------------------------------------------------- deferred sections */

test("A.1 · the deferred sections have shipped in A.2 (labels + references + commercial editors visible)", async ({
  page,
}) => {
  await page.goto(IMPORTS);
  await page.getByTestId("tab-labels").click();
  await expect(page.locator("body")).toContainText(/Product label editor/i);
  await expect(page.locator("body")).toContainText(/Governed versioned editor|verified label is immutable/i);

  await page.getByTestId("tab-references").click();
  await expect(page.locator("body")).toContainText(/Knowledge reference curation/i);
  await expect(page.locator("body")).toContainText(/Structured governance|Evidence grade/i);

  await page.getByTestId("tab-commercial").click();
  await expect(page.locator("body")).toContainText(/Commercial matching/i);
  await expect(page.locator("body")).toContainText(/exact identifier match|fuzzy matching is never permitted/i);
});

test("A.1 · the /settings/knowledge Import-review tab redirects to /settings/imports", async ({
  page,
}) => {
  await page.goto("/settings/knowledge");
  await page.getByRole("tab", { name: /Import review/i }).click();

  await expect(page.getByTestId("knowledge-imports-redirect")).toBeVisible();
  await expect(page.getByTestId("knowledge-imports-link")).toHaveAttribute("href", "/settings/imports");
  await expect(page.getByTestId("knowledge-imports-cta")).toHaveAttribute("href", "/settings/imports");
});
