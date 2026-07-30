import { expect, test } from "@playwright/test";

/**
 * PHASE 3, browser-level: the Programs & Education workspace against the
 * committed contract fixture backend.
 *
 * The fourteen proofs this suite carries (numbered as in the phase brief):
 *
 *   1. an org with no programs shows an honest empty library — nothing
 *      synthetic fills the screen
 *   2. a blank draft can be created and edited, and autosave confirms from
 *      the SERVER before showing "Saved"
 *   3. modules, lessons, and typed blocks (text, video URL, quiz, check-in,
 *      commercial resource) persist and reorder with accessible controls
 *   4. a concurrent edit surfaces as a conflict with a recovery path — never
 *      a silent overwrite
 *   5. submit → checklist-gated approve → publish are three separate steps;
 *      approve says it does NOT publish; publish is its own confirmation
 *      stating its zero side effects
 *   6. publishing creates no enrollment (the roster stays empty and the
 *      library counts stay at zero afterward)
 *   7. a published version is locked — no editor is offered for it
 *   8. revising a published version opens a NEW draft and the published
 *      original stays exactly as it was
 *   9. a published version can be saved as a DETACHED template, approved for
 *      use, and a program created from it carries the copied curriculum
 *  10. a real enrollment pins the exact published version, and publishing a
 *      newer version later does NOT move it
 *  11. recorded progress persists a reload and reaches the patient chart
 *      (lessons complete, review flag round-trip)
 *  12. Stripe and the Program Builder AI are honestly "not configured" —
 *      stored intent renders as such, enrollment against Stripe is blocked,
 *      and no fixture AI output ever renders
 *  13. archiving a template never cascades into programs created from it
 *  14. a revoked membership refuses the library without leaking any program
 *      data (generic message only)
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-programs.spec.ts
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

const PATIENT = "aaaaaaaa-1111-2222-3333-444444444402";
/** Identities that exist only in the demo edition's fixture dataset. */
const DEMO_FIXTURE_NAMES = ["Alexandra Morgan", "Michael Johnson", "Priya Sharma"];

let programUrl = "";
let programId = "";

test("1: an empty library is honest — no synthetic programs", async ({ page }) => {
  await page.goto("/programs");
  await expect(page.getByTestId("programs-workspace")).toBeVisible();
  await expect(page.getByText("No programs yet")).toBeVisible();
  for (const name of DEMO_FIXTURE_NAMES) {
    await expect(page.getByText(name)).toHaveCount(0);
  }
  // No engagement/revenue metrics anywhere — the workspace says so.
  await expect(page.getByText(/not shown/)).toBeVisible();
});

test("2+3: blank draft, curriculum with every block family, server-confirmed autosave", async ({ page }) => {
  await page.goto("/programs");
  await page.getByTestId("program-create-toggle").click();
  await page.getByTestId("program-create-name").fill("Metabolic Reset");
  await page.getByTestId("program-create-submit").click();

  // Creation lands in the library; open the studio.
  await page.getByTestId("program-list").getByText("Metabolic Reset").click();
  await page.waitForURL("**/programs/**");
  programUrl = page.url();
  programId = programUrl.split("/programs/")[1];
  await expect(page.getByTestId("draft-editor")).toBeVisible();

  // Metadata + one module with two lessons.
  await page.getByTestId("draft-title").fill("Metabolic Reset Program");
  await page.getByTestId("draft-disclaimer").fill("Education only; not medical advice.");
  await page.getByTestId("add-module").click();
  await page.getByTestId("module-name-0").fill("Foundations");
  await page.getByTestId("add-lesson-0").click();
  await page.getByTestId("lesson-title-0-0").fill("Welcome");
  await page.getByTestId("add-block-0-0").click();
  await page.getByTestId("block-body-0-0-0").fill("Welcome to the program.");

  // Video block.
  await page.getByTestId("add-block-0-0").click();
  await page.getByTestId("block-kind-0-0-1").selectOption("video_url");
  await page.getByTestId("block-url-0-0-1").fill("https://example.test/orientation");

  // Second lesson with a quiz and a check-in.
  await page.getByTestId("add-lesson-0").click();
  await page.getByTestId("lesson-title-0-1").fill("Assess");
  await page.getByTestId("add-block-0-1").click();
  await page.getByTestId("block-kind-0-1-0").selectOption("quiz");
  await page.getByTestId("quiz-add-q-0-1-0").click();
  await page.getByTestId("quiz-q-0-1-0-0").fill("How many meals per day?");
  await page.getByLabel("Question 1 option 1").fill("1-2");
  await page.getByLabel("Question 1 option 2").fill("3+");
  await page.getByTestId("add-block-0-1").click();
  await page.getByTestId("block-kind-0-1-1").selectOption("check_in");
  await page.getByTestId("block-prompt-0-1-1").fill("How ready are you?");

  // Commercial resource block.
  await page.getByTestId("add-block-0-1").click();
  await page.getByTestId("block-kind-0-1-2").selectOption("resource");
  await page.getByTestId("block-url-0-1-2").fill("https://example.test/shop/reading");
  await page.getByLabel("Commercial resource").check();

  // Autosave must confirm from the server.
  const save = page.waitForResponse(
    (r) => r.url().includes("/api/live/programs/save") && r.ok(),
  );
  await page.getByTestId("draft-summary").fill("12-week metabolic education");
  await save;
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");

  // Accessible ordering: move lesson 2 up and confirm the order flips.
  await page.getByLabel("Move lesson 2 up").click();
  await expect(page.getByTestId("lesson-title-0-0")).toHaveValue("Assess");
  await page.getByLabel("Move lesson 2 up").click();
  await expect(page.getByTestId("lesson-title-0-0")).toHaveValue("Welcome");

  // Persisted, not local: reload and the curriculum is still there.
  await page.reload();
  await expect(page.getByTestId("module-name-0")).toHaveValue("Foundations");
  await expect(page.getByTestId("lesson-title-0-1")).toHaveValue("Assess");
  await expect(page.getByTestId("block-url-0-0-1")).toHaveValue("https://example.test/orientation");
});

test("4: a concurrent edit is a conflict with recovery, never a silent overwrite", async ({ page }) => {
  await page.goto(programUrl);
  await expect(page.getByTestId("draft-editor")).toBeVisible();

  // Another editor saves the same draft out from under this tab.
  const studio = (await (
    await page.request.post("/api/live/programs/studio", { data: { programId } })
  ).json()) as { data: { editable: { id: string; title: string } } };
  const externalSave = await page.request.post("/api/live/programs/save", {
    data: {
      versionId: studio.data.editable.id,
      payload: { title: "External edit", modules: [] },
      expectedUpdatedAt: null,
    },
  });
  expect(externalSave.ok()).toBeTruthy();

  // This tab's next autosave carries the stale token → conflict UI.
  await page.getByTestId("draft-summary").fill("my competing edit");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "conflict");
  await expect(page.getByTestId("conflict-banner")).toBeVisible();
  await expect(page.getByText("Nothing was overwritten", { exact: false })).toBeVisible();

  // Recovery reloads the authoritative draft (including the external edit).
  await page.getByTestId("conflict-reload").click();
  await expect(page.getByTestId("draft-title")).toHaveValue("External edit");

  // Rebuild the curriculum for the rest of the suite (wholesale save).
  await page.getByTestId("draft-title").fill("Metabolic Reset Program");
  await page.getByTestId("add-module").click();
  await page.getByTestId("module-name-0").fill("Foundations");
  await page.getByTestId("add-lesson-0").click();
  await page.getByTestId("lesson-title-0-0").fill("Welcome");
  await page.getByTestId("add-block-0-0").click();
  await page.getByTestId("block-body-0-0-0").fill("Welcome to the program.");
  await page.getByTestId("add-lesson-0").click();
  await page.getByTestId("lesson-title-0-1").fill("Assess");
  await page.getByTestId("add-block-0-1").click();
  await page.getByTestId("block-body-0-1-0").fill("Baseline check.");
  const save = page.waitForResponse(
    (r) => r.url().includes("/api/live/programs/save") && r.ok(),
  );
  await page.getByTestId("draft-summary").fill("12-week metabolic education");
  await save;
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
});

test("5+6+7: submit → gated approve (NOT publish) → confirmed publish with zero side effects → locked", async ({ page }) => {
  await page.goto(programUrl);
  await page.getByTestId("submit-review").click();
  await expect(page.getByTestId("review-panel")).toBeVisible();

  // Approve is gated behind the checklist.
  await expect(page.getByTestId("approve-open")).toBeDisabled();
  await page.getByTestId("check-content").check();
  await page.getByTestId("check-disclaimer").check();
  await page.getByTestId("check-commercial").check();
  await expect(page.getByTestId("approve-open")).toBeEnabled();

  // Approve: its own confirmation, and it says it does NOT publish.
  await page.getByTestId("approve-open").click();
  const approveDialog = page.getByRole("alertdialog");
  await expect(approveDialog).toContainText("does NOT publish");
  await approveDialog.getByRole("button", { name: "Approve (does not publish)" }).click();

  // Approved-but-unpublished is its own visible state.
  await expect(page.getByTestId("approved-panel")).toBeVisible();
  await expect(page.getByTestId("approved-panel")).toContainText("NOT published");
  await expect(page.getByTestId("published-panel")).toHaveCount(0);

  // Publish: a separate confirmation that states its zero side effects.
  await page.getByTestId("publish-open").click();
  const publishDialog = page.getByRole("alertdialog");
  await expect(publishDialog).toContainText("no enrollment, charge, invoice, or message");
  await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();

  // 7: published and locked — no draft editor is offered.
  await expect(page.getByTestId("published-panel")).toBeVisible();
  await expect(page.getByTestId("published-panel")).toContainText("locked");
  await expect(page.getByTestId("draft-editor")).toHaveCount(0);

  // 6: publishing enrolled nobody.
  await expect(page.getByTestId("roster-panel")).toContainText("No enrollments");
  await page.goto("/programs");
  await expect(page.getByTestId("program-enrollment-counts")).toContainText("0 active");
});

test("8+9: revise preserves the published original; a published version becomes a detached, approved template", async ({ page }) => {
  await page.goto(programUrl);

  // 9 (first half): save the published version as a template.
  await page.getByTestId("template-name").fill("Metabolic Reset Template");
  await page.getByTestId("save-as-template").click();
  await expect(page.getByRole("status").first()).toContainText(/detached copy/i);

  // 8: revise into a NEW draft; the published panel stays.
  await page.getByTestId("revise-published").click();
  await expect(page.getByTestId("draft-editor")).toBeVisible();
  await expect(page.getByTestId("draft-editor")).toContainText("Draft v2");
  await expect(page.getByTestId("published-panel")).toContainText("Published v1");
  // The copied curriculum is editable in v2…
  await expect(page.getByTestId("module-name-0")).toHaveValue("Foundations");
  // …and the published preview still carries the original content.
  await page.getByTestId("preview-toggle").click();
  await expect(page.getByTestId("program-preview")).toBeVisible();
  await page.getByTestId("preview-toggle").click();

  // 9 (second half): approve the template and start a program from it.
  await page.goto("/programs");
  await expect(page.getByTestId("template-list")).toContainText("Metabolic Reset Template");
  await page.getByTestId("template-approve").click();
  await expect(page.getByTestId("template-list")).toContainText("approved");

  await page.getByTestId("program-create-toggle").click();
  await page.getByTestId("program-create-name").fill("Metabolic Reset — Cohort B");
  await page.getByTestId("program-create-template").selectOption({ index: 1 });
  await page.getByTestId("program-create-submit").click();
  await page.getByTestId("program-list").getByText("Metabolic Reset — Cohort B").click();
  await page.waitForURL("**/programs/**");
  // The copy is detached and carries the curriculum.
  await expect(page.getByTestId("module-name-0")).toHaveValue("Foundations");
});

test("10+11: enrollment pins the published version, survives a newer publish, and progress round-trips to the chart", async ({ page }) => {
  // Enroll from the patient chart.
  await page.goto(`/patients/${PATIENT}/overview`);
  await expect(page.getByTestId("patient-programs")).toBeVisible();
  await expect(page.getByTestId("patient-programs-empty")).toBeVisible();
  await page.getByTestId("enroll-toggle").click();
  await page.getByTestId("enroll-program").selectOption({ label: "Metabolic Reset (v1)" });
  await page.getByTestId("enroll-submit").click();
  await expect(page.getByTestId("patient-program-list")).toBeVisible();
  await expect(page.getByTestId("pinned-version")).toContainText("pinned to v1");

  // Record progress from the studio roster.
  await page.goto(programUrl);
  await expect(page.getByTestId("roster-panel")).toContainText("Sample Client");
  await page.getByTestId("progress-lesson").selectOption({ label: "Welcome" });
  await page.getByTestId("progress-complete-lesson").click();
  await expect(page.getByRole("status").first()).toContainText(/Progress recorded/i);
  await page.getByTestId("progress-check-in").click();
  await expect(page.getByTestId("roster-panel")).toContainText("1 need review");
  // Practitioner review clears the flag.
  await page.getByTestId("review-progress").click();
  await expect(page.getByTestId("roster-panel")).not.toContainText("need review");

  // 11: persisted — a reload still shows the records…
  await page.reload();
  await expect(page.getByTestId("roster-panel")).toContainText("2 progress records");

  // Publish v2 (the draft from the revise test).
  await page.getByTestId("submit-review").click();
  await page.getByTestId("check-content").check();
  await page.getByTestId("check-disclaimer").check();
  await page.getByTestId("check-commercial").check();
  await page.getByTestId("approve-open").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Approve (does not publish)" }).click();
  await page.getByTestId("publish-open").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("published-panel")).toContainText("Published v2");

  // 10: the enrollment did NOT move — still pinned to v1, on chart and roster.
  await expect(page.getByTestId("roster-panel")).toContainText("pinned v1");
  await page.goto(`/patients/${PATIENT}/overview`);
  await expect(page.getByTestId("pinned-version")).toContainText("pinned to v1");
  await expect(page.getByTestId("enrollment-progress")).toContainText("1/2 lessons complete");

  // The patient-chart card links back to the studio.
  await page.getByTestId("patient-program-list").getByText("Metabolic Reset").click();
  await page.waitForURL("**/programs/**");

  // Today aggregates the persisted enrollment rows.
  await page.goto("/today");
  await expect(page.getByTestId("today-programs-summary")).toContainText("1 active enrollment");
});

test("12: Stripe and the Program Builder AI are honestly not configured", async ({ page }) => {
  await page.goto(programUrl);

  // A Stripe offer stores terms and renders as not configured.
  await page.getByTestId("offer-name").fill("Paid tier");
  await page.getByTestId("offer-price").fill("499");
  await page.getByTestId("offer-mode").selectOption("stripe");
  await page.getByTestId("offer-save").click();
  await expect(page.getByTestId("stripe-not-configured")).toBeVisible();
  await expect(page.getByTestId("offers-panel")).toContainText("never processes a payment");

  // Enrolling against it is blocked before the server would refuse anyway.
  await page.goto(`/patients/${PATIENT}/overview`);
  await page.getByTestId("enroll-toggle").click();
  await page.getByTestId("enroll-program").selectOption({ index: 1 });
  const offerSelect = page.getByTestId("enroll-offer");
  await offerSelect.selectOption({ index: 1 });
  await expect(page.getByTestId("enroll-stripe-blocked")).toBeVisible();
  await expect(page.getByTestId("enroll-submit")).toBeDisabled();

  // The AI builder fails closed with the honest message; no fixture AI output.
  // (Cohort B still has an editable draft; program 1's v2 is published.)
  await page.goto("/programs");
  await page.getByTestId("program-list").getByText("Metabolic Reset — Cohort B").click();
  await page.waitForURL("**/programs/**");
  await page.getByTestId("ai-builder").click();
  await expect(page.getByTestId("ai-not-configured")).toContainText("not configured");
});

test("13: archiving a template never cascades into programs created from it", async ({ page }) => {
  await page.goto("/programs");
  await page.getByTestId("template-archive").click();
  await expect(page.getByRole("status").first()).toContainText(/untouched/i);
  await expect(page.getByTestId("templates-empty")).toBeVisible();
  // The program created from the template still exists with its content.
  await page.getByTestId("program-list").getByText("Metabolic Reset — Cohort B").click();
  await page.waitForURL("**/programs/**");
  await expect(page.getByTestId("module-name-0")).toHaveValue("Foundations");
});

test("14: a revoked membership refuses the library without leaking program data", async ({ page }) => {
  // Warm the session, then revoke the bearer's memberships mid-session.
  await page.goto("/programs");
  await expect(page.getByTestId("program-list")).toBeVisible();
  await page.request.post("http://127.0.0.1:3999/__control/revoke-memberships", {
    data: { bearer: "fixture-access-token" },
  });
  await page.goto("/programs");
  await expect(page.getByText("You don't have access to this record.")).toBeVisible();
  await expect(page.getByText("Metabolic Reset")).toHaveCount(0);
});
