import { expect, test, type Page } from "@playwright/test";

/**
 * LIVE-MODE differential questions + clinical lens engine (Milestone 2).
 * Skipped unless E2E_LIVE=1 (live-flag build + the committed contract
 * fixture, or a real backend). Recipe: see e2e/live-tasks.spec.ts — same
 * stub, same env. The fixture backend is stateful in-memory — restart it
 * between runs.
 *
 * Implements the milestone's 14-step browser verification gate:
 *  1. open an encounter with transcript + labs + chart → run a deterministic
 *     evaluation
 *  2. red flags identical under every paradigm
 *  3. changing the lens alters only permitted framing (ranking/terminology)
 *  4. inspect provenance: patient evidence, knowledge basis (unknown shown
 *     as "unknown"), run snapshot
 *  5. accept + mark asked
 *  6. record an answer, then correct it WITHOUT mutating the original
 *  7. explicit add-to-note into the open draft (never automatic)
 *  8. a source change (transcript correction) makes the output STALE
 *  9. dismiss with structured feedback
 * 10. nothing enters the signed note automatically
 * 11. cross-tenant access fails
 * 12. the fixture AI cannot silently pass as production AI
 * 13. transcript injection → blocked run with a reviewable safety failure
 * 14. urgent-safety case: the urgent question outranks every lens
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a live-flag build + backend");

test.describe.configure({ mode: "serial" });

const PATIENT_ID = "aaaaaaaa-1111-2222-3333-444444444401";
const LENS_ENCOUNTER = `/patients/${PATIENT_ID}/encounter/eeeeeeee-2222-3333-4444-444444444777`;
const INJECTED_ENCOUNTER = `/patients/${PATIENT_ID}/encounter/eeeeeeee-2222-3333-4444-444444444778`;
const OTHER_ORG_ENCOUNTER = `/patients/${PATIENT_ID}/encounter/eeeeeeee-2222-3333-4444-444444444888`;
const STUB_ORIGIN = (process.env.TRPC_BASE_URL ?? "http://127.0.0.1:3999/api/trpc").replace(/\/api\/trpc\/?$/, "");

const panel = (page: Page) => page.getByTestId("lens-panel");
const card = (page: Page, text: string | RegExp) =>
  page.getByTestId("question-card").filter({ hasText: text });

async function selectParadigm(page: Page, paradigm: string): Promise<void> {
  await page.getByTestId("lens-paradigm").selectOption(paradigm);
}

async function runEvaluation(page: Page): Promise<void> {
  await page.getByTestId("run-evaluation").click();
  await expect(page.getByTestId("lens-notice")).toBeVisible({ timeout: 15_000 });
}

/** The invariant-core section's rendered text — the identity witness. */
async function coreText(page: Page): Promise<string> {
  const text = await page.getByTestId("lens-core").innerText();
  return text.replace(/\s+/g, " ").trim();
}

test("steps 1–4: deterministic run over transcript+labs+chart; core identical across paradigms; framing-only changes; provenance inspectable", async ({ page }) => {
  await page.goto(LENS_ENCOUNTER);
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("lens-empty")).toBeVisible();

  // Step 1 — run under the conventional lens.
  await runEvaluation(page);
  await expect(page.getByTestId("lens-core")).toBeVisible();
  // The urgent red flags are stated in words, with URGENT markers.
  await expect(page.getByTestId("core-red-flags")).toContainText("URGENT — Chest pain reported in the encounter");
  await expect(page.getByTestId("core-red-flags")).toContainText("URGENT — Medication/allergy conflict or interaction caution on record");
  await expect(page.getByTestId("core-conflicts")).toContainText('Recorded medication "Penicillin VK" matches recorded allergy "penicillin"');
  await expect(page.getByTestId("core-interactions")).toContainText("St. John's Wort + Sertraline");
  const westernCore = await coreText(page);
  const westernRanking = (await page.getByTestId("lens-ranking").innerText()).replace(/\s+/g, " ");

  // Step 2 + 3 — every other paradigm: SAME core, different (permitted) framing.
  for (const paradigm of ["functional", "naturopathic", "tcm", "biohacking", "synergistic"]) {
    await selectParadigm(page, paradigm);
    await runEvaluation(page);
    await expect(page.getByTestId("lens-core")).toBeVisible();
    expect(await coreText(page), `invariant core must be identical under ${paradigm}`).toBe(westernCore);
    // Urgent domains stay pinned first by the core, whatever the lens says.
    const first = page.getByTestId("lens-ranking").locator("li").first();
    await expect(first).toContainText("URGENT — pinned by core");
  }
  // TCM framing labels patterns as non-diagnoses; ranking differs from western.
  await selectParadigm(page, "tcm");
  await expect(page.getByTestId("lens-framing")).toContainText("NOT equivalent to biomedical diagnoses");
  const tcmRanking = (await page.getByTestId("lens-ranking").innerText()).replace(/\s+/g, " ");
  expect(tcmRanking).not.toBe(westernRanking);

  // Synergistic composition is transparent: every non-urgent ranked item is
  // attributed to the member lens it came from (disagreement rows are
  // exercised in the step-13 test, where only one urgent domain is pinned).
  await selectParadigm(page, "synergistic");
  await expect(
    page.getByTestId("lens-ranking").locator("li").filter({ hasText: /from (functional|naturopathic|tcm|biohacking|western_conventional)/ }).first(),
  ).toBeVisible();
  await expect(page.getByTestId("lens-framing")).toContainText("never a hidden blended model");

  // Step 4 — provenance: why-appeared, patient evidence, registry details.
  await selectParadigm(page, "western_conventional");
  const chest = card(page, /Characterize the chest pain/);
  await chest.getByTestId("why-appeared").click();
  await expect(chest.getByTestId("patient-evidence")).toContainText("transcript_segment");
  await expect(chest.getByTestId("knowledge-basis")).toContainText("2021 AHA/ACC Chest Pain Guideline");
  // Registry attributes that are unknown display as "unknown" (IFM row).
  const ai = card(page, /has not been captured in your chart/);
  await ai.getByTestId("why-appeared").click();
  await expect(ai.getByTestId("knowledge-basis")).toContainText("publisher: unknown");
  // Run snapshot: versions + provider identity are visible.
  await page.getByTestId("run-snapshot").click();
  await expect(page.getByTestId("run-snapshot")).toContainText("Rule set lens-rules-v1");
  await expect(page.getByTestId("snapshot-provider")).toContainText("fixture");
});

test("steps 5–7, 9–10: lifecycle, versioned answers preserving originals, explicit add-to-note, dismiss with feedback, signed notes untouched", async ({ page }) => {
  await page.goto(LENS_ENCOUNTER);
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("question-card").first()).toBeVisible();

  // Step 5 — accept, then mark asked.
  const sleep = card(page, /Structured sleep history/);
  await sleep.getByTestId("q-accept").click();
  await expect(sleep.getByTestId("question-status")).toHaveText("Accepted");
  // Accepting inserted NOTHING anywhere: no note exists yet at all.
  await expect(page.getByText("No notes yet.")).toBeVisible();
  await sleep.getByTestId("q-ask").click();
  await expect(sleep.getByTestId("question-status")).toHaveText("Asked");

  // Step 6 — answer, then correct; the original version stays visible.
  await sleep.getByTestId("answer-input").fill("Sleeps about 5 hours, snores loudly per partner.");
  await sleep.getByTestId("save-answer").click();
  await expect(sleep.getByTestId("question-status")).toHaveText("Answered");
  await sleep.getByTestId("show-answers").click();
  await expect(sleep.getByTestId("answer-versions")).toContainText("v1");
  await sleep.getByTestId("correct-answer").click();
  await sleep.getByTestId("correction-input").fill("Sleeps about 6 hours; snoring confirmed by partner.");
  await sleep.getByTestId("correction-reason").fill("patient corrected");
  await sleep.getByTestId("save-correction").click();
  await sleep.getByTestId("show-answers").click();
  const versions = sleep.getByTestId("answer-versions");
  await expect(versions).toContainText("Sleeps about 5 hours, snores loudly per partner."); // original intact
  await expect(versions).toContainText("v2");
  await expect(versions).toContainText("corrects v1 — patient corrected");

  // Step 7 — explicit add-to-note requires an open draft; nothing automatic.
  const addBtn = sleep.getByTestId("q-add-to-note");
  await expect(addBtn).toBeDisabled(); // no draft note open yet
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByLabel("Subjective").fill("Visit narrative by the practitioner.");
  await expect(page.getByTestId("save-state")).toHaveText(/Saved .*v1/, { timeout: 10_000 });
  await expect(addBtn).toBeEnabled();
  await addBtn.click();
  await expect(page.getByLabel("Subjective")).toHaveValue(/Differential question .*Structured sleep history/, { timeout: 5_000 });
  await expect(page.getByTestId("save-state")).toHaveText(/Saved .*v2/, { timeout: 10_000 });
  await expect(page.getByTestId("provenance-panel")).toContainText("Differential question");

  // Step 9 — dismiss with structured feedback.
  const crp = card(page, /hs-CRP draw/);
  await crp.getByTestId("q-dismiss").click();
  await crp.getByTestId("dismiss-kind").selectOption("not_relevant");
  await crp.getByTestId("dismiss-comment").fill("Repeat already ordered last visit.");
  await crp.getByTestId("confirm-dismiss").click();
  await expect(card(page, /hs-CRP draw/).getByTestId("question-status")).toHaveText("Dismissed");

  // Step 10 — sign the note; afterwards nothing can be added to it.
  await page.getByRole("button", { name: "Sign note" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sign and lock" }).click();
  await expect(page.getByTestId("signature-line")).toBeVisible();
  const signedContent = await page.getByTestId("note-composer").innerText();
  const bp = card(page, /How was this blood pressure measured/);
  await bp.getByTestId("q-accept").click();
  await expect(bp.getByTestId("question-status")).toHaveText("Accepted");
  // The signed note is no longer a target — add-to-note is disabled again.
  await expect(bp.getByTestId("q-add-to-note")).toBeDisabled();
  expect(await page.getByTestId("note-composer").innerText()).toBe(signedContent);
});

test("step 8: a transcript correction (source change) marks the evaluation STALE — retained, never recomputed silently", async ({ page }) => {
  await page.goto(LENS_ENCOUNTER);
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("lens-core")).toBeVisible();
  await expect(page.getByTestId("lens-stale")).toHaveCount(0);

  // Another session corrects a transcript segment (raw ASR preserved there;
  // corrections are a layered source change for the lens).
  const res = await page.request.post(`${STUB_ORIGIN}/api/trpc/clinical.scribe.correctSegment`, {
    headers: { authorization: "Bearer fixture-access-token", "content-type": "application/json" },
    data: { json: { segmentId: "lens-seg-2", correctedText: "And I have been sleeping poorly most nights — worse since June." } },
  });
  expect(res.ok()).toBeTruthy();

  await page.reload();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("lens-stale")).toBeVisible();
  await expect(page.getByTestId("lens-stale")).toContainText("STALE");
  await expect(page.getByTestId("lens-stale")).toContainText("transcript_correction");
  // Not-yet-asked questions went stale (words, not color); answered ones kept their state.
  await expect(card(page, /How was this blood pressure measured/).getByTestId("question-status")).toHaveText("Stale");
  await expect(card(page, /Structured sleep history/).getByTestId("question-status")).toHaveText("Answered");

  // Re-running replaces the stale output with a fresh, non-stale run.
  await runEvaluation(page);
  await expect(page.getByTestId("lens-stale")).toHaveCount(0);
});

test("step 11: cross-tenant access fails — an encounter from another organization never renders", async ({ page }) => {
  await page.goto(OTHER_ORG_ENCOUNTER);
  await expect(page.getByText(/isn't available|not found|access denied/i).first()).toBeVisible();
  await expect(page.getByTestId("lens-core")).toHaveCount(0);
});

test("steps 12–14: fixture AI is explicit (never silent production), injection blocks with a reviewable failure, urgent safety outranks every lens", async ({ page }) => {
  // Step 12 — the AI posture is labeled fixture, and AI-assisted questions
  // carry their generation identity on the card.
  await page.goto(LENS_ENCOUNTER);
  await expect(page.getByTestId("lens-ai-status")).toContainText("fixture");
  await expect(page.getByTestId("lens-ai-status")).toContainText("Not the production AI");
  await expect(card(page, /has not been captured in your chart/).first()).toContainText("AI-assisted (fixture-lens-1)");
  await page.getByTestId("run-snapshot").click();
  await expect(page.getByTestId("snapshot-provider")).toContainText("fixture");

  // Step 14 — the urgent chest-pain question is present and marked URGENT in
  // words under the conventional lens AND under TCM (no lens suppresses it).
  const urgentText = /Characterize the chest pain/;
  await expect(card(page, urgentText).first()).toContainText("URGENT");
  await selectParadigm(page, "tcm");
  await expect(page.getByTestId("lens-core")).toBeVisible();
  await expect(card(page, urgentText).first()).toContainText("URGENT");
  const firstRank = page.getByTestId("lens-ranking").locator("li").first();
  await expect(firstRank).toContainText("URGENT — pinned by core");

  // Step 13 — transcript injection: the run BLOCKS into a reviewable failure
  // with zero questions; review resolves it without deleting the evidence.
  await page.goto(INJECTED_ENCOUNTER);
  await expect(panel(page)).toBeVisible();
  await runEvaluation(page);
  await expect(page.getByTestId("lens-blocked")).toBeVisible();
  await expect(page.getByTestId("no-questions")).toContainText("blocked pending safety review");
  const block = page.getByTestId("safety-block").first();
  await expect(block).toContainText("prompt_injection_in_transcript");
  await block.getByTestId("block-resolution-input").fill("Confirmed injection attempt in transcript; capture flow flagged to the practitioner.");
  await block.getByTestId("review-block-btn").click();
  await expect(page.getByTestId("block-reviewed")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("block-reviewed")).toContainText("Confirmed injection attempt");

  // Synergistic member-lens DISAGREEMENTS are shown openly: on this encounter
  // only one urgent domain is pinned, so the members' cardiometabolic ranks
  // diverge far enough to be recorded as an explicit composition conflict.
  await selectParadigm(page, "synergistic");
  await runEvaluation(page);
  await expect(page.getByTestId("composition-conflicts")).toBeVisible();
  await expect(page.getByTestId("composition-conflicts")).toContainText("No position is hidden");
});
