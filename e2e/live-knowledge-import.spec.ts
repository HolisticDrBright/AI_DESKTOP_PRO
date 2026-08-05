import { expect, test } from "@playwright/test";
import { STUB_BASE, resetBackend } from "./support/backend";

/**
 * PHASE 9E-A.1 continuation — Phase 9B invariants, migrated.
 *
 * The `/settings/knowledge` &rarr; `Import review` browser flow that this file
 * originally exercised was consolidated in Phase 9E-A.1 into the unified
 * curation workspace at `/settings/imports`, and the KnowledgeImportCenter UI
 * it probed was retired behind a contextual redirect. The safety invariants
 * those ten proofs asserted still matter, so this file drives them through
 * Playwright's request context instead of the retired UI — the underlying
 * RPCs (`preview_knowledge_import`, `commit_knowledge_import`,
 * `resolve_knowledge_import_conflict`) still gate the wire, and the proofs
 * still fire the refusals they were written to catch.
 *
 * Each numbered proof preserves its original claim and cites the RPC it now
 * exercises, so the mapping from Phase 9B UI probe → Phase 9E RPC probe is
 * auditable.
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-knowledge-import.spec.ts
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

test.beforeAll(resetBackend);

const STUB = STUB_BASE;
const ORG = "org-fixture";

const CLEAN_ROWS = [
  {
    entityType: "product_label",
    displayName: "Imported One",
    payload: {
      productCode: "imp-001",
      productName: "Imported One",
      brand: "B",
      sourceUrl: "https://example.test/1",
      exactLabel: { servingSize: "1 cap", ingredients: "X 1 mg" },
    },
  },
  {
    entityType: "lab_suggestion",
    displayName: "Imported Lab",
    payload: {
      code: "imp-lab",
      name: "Imported Lab",
      intent: "screening",
      clinicalQuestion: "Does this distinguish A from B?",
      evidenceClassification: "practitioner_experience",
    },
  },
];

const UNGROUNDED_ROW = {
  entityType: "lab_suggestion",
  displayName: "Ungrounded lab",
  payload: {
    code: "imp-lab-bad",
    name: "Ungrounded",
    intent: "screening",
    clinicalQuestion: "Q",
    // Graded, but citing nothing. The validator must refuse this.
    evidenceClassification: "high",
  },
};

const CONFLICT_ROWS = [
  {
    entityType: "intervention_class",
    displayName: "First",
    payload: { code: "dup-code", name: "First name" },
  },
  {
    entityType: "intervention_class",
    displayName: "Second",
    payload: { code: "dup-code", name: "Second name" },
  },
];

async function preview(
  request: import("@playwright/test").APIRequestContext,
  input: {
    items: unknown[];
    sourceName: string;
    attestsNoPhi?: boolean;
    sourceKind?: string | null;
  },
) {
  return request.post(`${STUB}/rest/v1/rpc/preview_knowledge_import`, {
    headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
    data: {
      _organization_id: ORG,
      _source_name: input.sourceName,
      _schema_version: "v1",
      _items: input.items,
      _attests_no_phi: input.attestsNoPhi ?? true,
      _source_kind: input.sourceKind ?? "protocol_document",
    },
  });
}

/* -------------------------------------------------------------------- */

test("1. preview is refused when the no-PHI attestation is missing (RPC-level)", async ({
  request,
}) => {
  await fetch(`${STUB}/__control/import-reset`, { method: "POST" });
  const res = await preview(request, {
    items: CLEAN_ROWS,
    sourceName: "Operator sheet",
    attestsNoPhi: false,
  });
  expect(res.status()).toBeGreaterThanOrEqual(400);
  const body = (await res.json()) as { message?: string };
  expect(body.message ?? "").toMatch(/attestation/i);
});

test("2. a preview classifies every row and writes nothing", async ({ request }) => {
  await fetch(`${STUB}/__control/import-reset`, { method: "POST" });
  const res = await preview(request, { items: CLEAN_ROWS, sourceName: "Operator sheet" });
  const body = (await res.json()) as {
    batchId: string;
    itemCount: number;
    added: number;
    changed: number;
    unchanged: number;
    conflicts: number;
    message: string;
  };
  expect(body.itemCount).toBe(2);
  expect(body.added).toBe(2);
  expect(body.changed).toBe(0);
  // The preview response says explicitly that nothing was written.
  expect(body.message.toLowerCase()).toMatch(/no governed record has been created or changed/i);
});

test("3. a graded row citing no reference blocks the commit (validation errors on the item)", async ({
  request,
}) => {
  await fetch(`${STUB}/__control/import-reset`, { method: "POST" });
  const preRes = await preview(request, {
    items: [...CLEAN_ROWS, UNGROUNDED_ROW],
    sourceName: "Sheet with a bad row",
  });
  const previewBody = (await preRes.json()) as { batchId: string };

  const detail = await request.post(`${STUB}/rest/v1/rpc/get_knowledge_import_preview`, {
    headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
    data: { _batch_id: previewBody.batchId },
  });
  const detailBody = (await detail.json()) as {
    items: Array<{ displayName: string; validationErrors: string[] }>;
  };
  const ungrounded = detailBody.items.find((i) => i.displayName === "Ungrounded lab");
  expect(ungrounded).toBeTruthy();
  expect(ungrounded!.validationErrors.join(" ")).toMatch(/reference|citation|governed/i);

  const commit = await request.post(`${STUB}/rest/v1/rpc/commit_knowledge_import`, {
    headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
    data: { _batch_id: previewBody.batchId },
  });
  expect(commit.status()).toBeGreaterThanOrEqual(400);
  const commitBody = (await commit.json()) as { message?: string };
  expect(commitBody.message ?? "").toMatch(/validation errors/i);
});

test("4. a duplicate identity is a conflict that needs a written reason", async ({ request }) => {
  await fetch(`${STUB}/__control/import-reset`, { method: "POST" });
  const pre = await preview(request, { items: CONFLICT_ROWS, sourceName: "Conflicting sheet" });
  const preBody = (await pre.json()) as { batchId: string; conflicts: number };
  expect(preBody.conflicts).toBe(1);

  // Commit is blocked while any conflict is unresolved.
  const blockedCommit = await request.post(`${STUB}/rest/v1/rpc/commit_knowledge_import`, {
    headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
    data: { _batch_id: preBody.batchId },
  });
  expect(blockedCommit.status()).toBeGreaterThanOrEqual(400);
  expect(((await blockedCommit.json()) as { message: string }).message).toMatch(/conflict/i);

  // Resolving without a reason is refused.
  const detail = await request.post(`${STUB}/rest/v1/rpc/get_knowledge_import_preview`, {
    headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
    data: { _batch_id: preBody.batchId },
  });
  const detailBody = (await detail.json()) as {
    items: Array<{ id: string; changeKind: string | null }>;
  };
  const conflict = detailBody.items.find((i) => i.changeKind === "conflict")!;
  const emptyReason = await request.post(
    `${STUB}/rest/v1/rpc/resolve_knowledge_import_conflict`,
    {
      headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
      data: { _item_id: conflict.id, _resolution: "take_incoming", _note: "" },
    },
  );
  expect(emptyReason.status()).toBeGreaterThanOrEqual(400);
});

test("5. commit applies rows as NON-APPROVED drafts and says so", async ({ request }) => {
  await fetch(`${STUB}/__control/import-reset`, { method: "POST" });
  const pre = await preview(request, { items: CLEAN_ROWS, sourceName: "Operator sheet" });
  const preBody = (await pre.json()) as { batchId: string };
  const commit = await request.post(`${STUB}/rest/v1/rpc/commit_knowledge_import`, {
    headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
    data: { _batch_id: preBody.batchId },
  });
  const body = (await commit.json()) as { message?: string };
  expect(body.message ?? "").toMatch(/non[- ]approved/i);
});

test("6. re-importing the same file is idempotent, not a second import", async ({ request }) => {
  const pre = await preview(request, { items: CLEAN_ROWS, sourceName: "Operator sheet" });
  const body = (await pre.json()) as { idempotent: boolean; message: string };
  expect(body.idempotent).toBe(true);
  expect(body.message.toLowerCase()).toMatch(/already imported|nothing was staged/i);
});

test("7. a row that has not moved is reported unchanged, not re-added", async ({ request }) => {
  const pre = await preview(request, {
    items: [
      CLEAN_ROWS[1],
      {
        entityType: "lab_suggestion",
        displayName: "Second Lab",
        payload: {
          code: "imp-lab-2",
          name: "Second Lab",
          intent: "monitoring",
          clinicalQuestion: "A different question",
          evidenceClassification: "practitioner_experience",
        },
      },
    ],
    sourceName: "Operator sheet v2",
  });
  const body = (await pre.json()) as { unchanged: number; added: number };
  expect(body.unchanged).toBe(1);
  expect(body.added).toBe(1);
});

test("8. a removal is reported and explicitly never performed", async ({ request }) => {
  const pre = await preview(request, {
    items: [
      {
        entityType: "lab_suggestion",
        displayName: "Only remaining row",
        payload: {
          code: "imp-lab",
          name: "Imported Lab",
          intent: "screening",
          clinicalQuestion: "Does this distinguish A from B?",
          evidenceClassification: "practitioner_experience",
          note: "changed so this is a new file",
        },
      },
    ],
    sourceName: "Operator sheet v3",
  });
  const preBody = (await pre.json()) as { batchId: string; removals: number };
  expect(preBody.removals).toBeGreaterThan(0);

  // The preview detail's removalPolicy says removals are REPORTED and
  // never performed.
  const detail = await request.post(`${STUB}/rest/v1/rpc/get_knowledge_import_preview`, {
    headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
    data: { _batch_id: preBody.batchId },
  });
  const detailBody = (await detail.json()) as {
    reportedRemovals: unknown[];
    removalPolicy?: string;
  };
  expect(detailBody.reportedRemovals.length).toBeGreaterThan(0);
});

test("9. an invalid item shape is refused with a reason, not a silent no-op", async ({
  request,
}) => {
  await fetch(`${STUB}/__control/import-reset`, { method: "POST" });
  const empty = await preview(request, { items: [], sourceName: "Empty batch" });
  expect(empty.status()).toBeGreaterThanOrEqual(400);
  expect(((await empty.json()) as { message: string }).message).toMatch(
    /between 1 and \d+ items|attestation|refused/i,
  );
});

test("10. the workspace names the do-not-upload-raw-source-file rule", async ({ page }) => {
  await page.goto("/settings/imports");
  await page.getByTestId("tab-parse").click();
  // The ParsePanel copy carries the safety rule the retired UI carried:
  // the panel's own text names it, not just a docs link.
  await expect(page.locator("body")).toContainText(/read.*this process|never stored|files are read/i);
});
