import { expect, test } from "@playwright/test";

/**
 * PHASE 9B, browser-level: the governed import pipeline.
 *
 * The claim this file exists to prove is the one a reviewer has to be able to
 * trust: A PREVIEW HAS CHANGED NOTHING, and content reaches the registry only
 * through an explicit commit that refuses while anything is unresolved.
 *
 * The stub is a real implementation, not a yes-machine — it classifies rows,
 * detects conflicts, is idempotent on the source hash and returns the same
 * refusals the database does. A browser proof against a backend that cannot
 * refuse proves nothing.
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-knowledge-import.spec.ts
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

const STUB = "http://127.0.0.1:3999";
const KNOWLEDGE = "/settings/knowledge";

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

test.beforeAll(async () => {
  await fetch(`${STUB}/__control/import-reset`, { method: "POST" });
});

/** Attach a JSON file without touching disk — the panel accepts a file input. */
async function stageFile(page: import("@playwright/test").Page, rows: unknown[]) {
  await page
    .locator('[data-testid="import-preview-panel"] input[type="file"]')
    .setInputFiles({
      name: "operator-import.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(rows)),
    });
}

async function openKnowledge(page: import("@playwright/test").Page) {
  await page.goto(KNOWLEDGE);
  await page.getByRole("tab", { name: "Import review" }).click();
  await expect(page.getByTestId("import-preview-panel")).toBeVisible();
}

test("1. preview is gated on an explicit no-PHI attestation", async ({ page }) => {
  await openKnowledge(page);
  await stageFile(page, CLEAN_ROWS);
  await page.getByLabel("Source name").fill("Operator sheet");

  // The attestation is unticked: preview must be unavailable, not merely
  // discouraged.
  await expect(page.getByTestId("run-preview")).toBeDisabled();

  await page
    .getByText("I confirm this file contains no patient-identifiable information")
    .click();
  await expect(page.getByTestId("run-preview")).toBeEnabled();
});

test("2. a preview classifies every row and states that nothing was written", async ({
  page,
}) => {
  await openKnowledge(page);
  await stageFile(page, CLEAN_ROWS);
  await page.getByLabel("Source name").fill("Operator sheet");
  await page
    .getByText("I confirm this file contains no patient-identifiable information")
    .click();
  await page.getByTestId("run-preview").click();

  await expect(page.getByTestId("preview-counts")).toBeVisible();
  await expect(page.getByTestId("count-added")).toContainText("2");
  await expect(page.getByTestId("count-changed")).toContainText("0");

  // The central claim, on screen, before any commit.
  await expect(page.getByTestId("nothing-written-yet")).toContainText(
    "Nothing has been written yet",
  );
});

test("3. a graded row citing no reference blocks the commit and says why", async ({
  page,
}) => {
  await fetch(`${STUB}/__control/import-reset`, { method: "POST" });
  await openKnowledge(page);
  await stageFile(page, [...CLEAN_ROWS, UNGROUNDED_ROW]);
  await page.getByLabel("Source name").fill("Sheet with a bad row");
  await page
    .getByText("I confirm this file contains no patient-identifiable information")
    .click();
  await page.getByTestId("run-preview").click();

  await expect(page.getByTestId("validation-blockers")).toBeVisible();
  await expect(page.getByTestId("validation-blockers")).toContainText(
    "requires a governed reference",
  );
  // The row is named, not merely counted — an operator has to know which one.
  await expect(page.getByTestId("validation-blockers")).toContainText("Ungrounded");

  await expect(page.getByTestId("commit-import")).toBeDisabled();
  await expect(page.getByTestId("commit-blocked-reason")).toContainText(
    "Fix the validation errors in the source",
  );
});

test("4. a duplicate identity is a conflict that needs a written reason", async ({
  page,
}) => {
  await fetch(`${STUB}/__control/import-reset`, { method: "POST" });
  await openKnowledge(page);
  await stageFile(page, CONFLICT_ROWS);
  await page.getByLabel("Source name").fill("Conflicting sheet");
  await page
    .getByText("I confirm this file contains no patient-identifiable information")
    .click();
  await page.getByTestId("run-preview").click();

  await expect(page.getByTestId("count-conflicts")).toContainText("1");
  await expect(page.getByTestId("conflict-list")).toContainText(
    "claims the same identity",
  );

  // Commit is blocked, and the reason names the conflict rather than being generic.
  await expect(page.getByTestId("commit-import")).toBeDisabled();
  await expect(page.getByTestId("commit-blocked-reason")).toContainText(
    "Resolve every conflict",
  );

  // The resolution buttons stay disabled until a reason is typed.
  const useThisRow = page.getByRole("button", { name: "Use this row", exact: true });
  await expect(useThisRow).toBeDisabled();
  await page
    .getByLabel(/Reason for resolving row/)
    .fill("The later row is the corrected one.");
  await expect(useThisRow).toBeEnabled();

  await useThisRow.click();
  await expect(page.getByTestId("commit-import")).toBeEnabled();
});

test("5. commit applies rows as NON-APPROVED drafts and says so", async ({ page }) => {
  await fetch(`${STUB}/__control/import-reset`, { method: "POST" });
  await openKnowledge(page);
  await stageFile(page, CLEAN_ROWS);
  await page.getByLabel("Source name").fill("Operator sheet");
  await page
    .getByText("I confirm this file contains no patient-identifiable information")
    .click();
  await page.getByTestId("run-preview").click();
  await expect(page.getByTestId("commit-import")).toBeEnabled();
  await page.getByTestId("commit-import").click();

  const result = page.getByTestId("commit-result");
  await expect(result).toBeVisible();
  await expect(result).toContainText("NON-APPROVED drafts");
  await expect(result).toContainText("is approved for clinical use until a practitioner approves it");

  // The "nothing written yet" banner must be gone — it would now be a lie.
  await expect(page.getByTestId("nothing-written-yet")).toHaveCount(0);
});

test("6. re-importing the same file is idempotent, not a second import", async ({
  page,
}) => {
  // Deliberately NOT reset: test 5 committed this exact payload.
  await openKnowledge(page);
  await stageFile(page, CLEAN_ROWS);
  await page.getByLabel("Source name").fill("Operator sheet");
  await page
    .getByText("I confirm this file contains no patient-identifiable information")
    .click();
  await page.getByTestId("run-preview").click();

  await expect(page.getByTestId("import-notice")).toContainText(
    "already imported",
  );
  await expect(page.getByTestId("import-notice")).toContainText(
    "nothing was staged a second time",
  );
});

test("7. a row that has not moved is reported unchanged, not re-added", async ({
  page,
}) => {
  await openKnowledge(page);
  // Same lab row, plus a genuinely new one — a different file, so a new batch.
  await stageFile(page, [
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
  ]);
  await page.getByLabel("Source name").fill("Operator sheet v2");
  await page
    .getByText("I confirm this file contains no patient-identifiable information")
    .click();
  await page.getByTestId("run-preview").click();

  await expect(page.getByTestId("count-unchanged")).toContainText("1");
  await expect(page.getByTestId("count-added")).toContainText("1");
});

test("8. a removal is reported and explicitly never performed", async ({ page }) => {
  await openKnowledge(page);
  await stageFile(page, [
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
  ]);
  await page.getByLabel("Source name").fill("Operator sheet v3");
  await page
    .getByText("I confirm this file contains no patient-identifiable information")
    .click();
  await page.getByTestId("run-preview").click();

  await expect(page.getByTestId("count-removals")).not.toContainText("0");
  await expect(page.getByTestId("import-preview-panel")).toContainText(
    "never deletes governed clinical content",
  );
});

test("9. a non-JSON file is refused with a reason, not a silent no-op", async ({
  page,
}) => {
  await openKnowledge(page);
  await page
    .locator('[data-testid="import-preview-panel"] input[type="file"]')
    .setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("this is a spreadsheet, not JSON"),
    });
  await expect(page.getByTestId("import-error")).toContainText("not valid JSON");
  await expect(page.getByTestId("run-preview")).toBeDisabled();
});

test("10. the panel tells the operator not to upload the raw source file", async ({
  page,
}) => {
  await openKnowledge(page);
  await expect(page.getByTestId("import-preview-panel")).toContainText(
    "never uploaded here",
  );
});
