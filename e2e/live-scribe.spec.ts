import { expect, test, type Page } from "@playwright/test";
import { resetBackend } from "./support/backend";
import { EXPECT_TIMEOUT_MS } from "./support/budgets";

/**
 * LIVE-MODE consent-gated recording + AI scribe (Milestone 1). Skipped unless
 * E2E_LIVE=1 (live-flag build + the committed contract fixture, or a real
 * backend). Recipe: see e2e/live-tasks.spec.ts — same stub, same env.
 *
 * Chromium runs with fake media devices (playwright.config.ts), so
 * getUserMedia + MediaRecorder produce REAL audio chunks: this drives the
 * actual browser capture pipeline, not a mock of it.
 *
 * Covers the milestone acceptance workflow:
 *   consent all participants → authorize → record → pause/resume → upload →
 *   transcribe → correct → proposed draft → practitioner review → sign →
 *   delete audio → verify deletion → audit
 * plus: mic denial, device loss, consent revoked mid-recording, late joins,
 * network interruption, refresh recovery, competing second tab, raw-ASR
 * immutability, draft-overwrite protection, unchanged signing workflow, and
 * the no-tracker network boundary (any unauthorized third-party request
 * fails the run).
 *
 * NOTE: the fixture backend is stateful in-memory — restart it between runs.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a live-flag build + backend");

test.describe.configure({ mode: "serial" });

/**
 * Isolation, not ordering. This restores the whole fixture backend so the
 * suite runs against exactly the state it was written for, wherever it lands
 * in the battery.
 */
test.beforeAll(resetBackend);

const PATIENT_URL = "/patients/aaaaaaaa-1111-2222-3333-444444444401/chart";
const pageReadyTimeout = EXPECT_TIMEOUT_MS;

/** Start a FRESH encounter (no appointment → a new encounter every time). */
async function openNewEncounter(page: Page): Promise<void> {
  await page.goto(PATIENT_URL);
  await page.getByRole("button", { name: "Start encounter" }).first().click();
  await page.waitForURL("**/encounter/**");
  await expect(page.getByTestId("scribe-panel")).toBeVisible({ timeout: pageReadyTimeout });
}

async function addParticipant(page: Page, name: string, kind: string): Promise<void> {
  const nameInput = page.getByTestId("participant-name");
  await nameInput.fill(name);
  await page.getByTestId("participant-kind").selectOption(kind);
  await page.getByTestId("add-participant-btn").click();
  // The local dev server compiles this API route on first use. The input is
  // cleared only after the write succeeds; the participant appears only
  // after the authoritative server list is read back.
  const persistedTimeout = EXPECT_TIMEOUT_MS;
  await expect(nameInput).toHaveValue("", { timeout: persistedTimeout });
  await expect(page.getByText(name)).toBeVisible({ timeout: persistedTimeout });
}

async function grant(page: Page, kind: string, scope: string): Promise<void> {
  await page.getByTestId(`ack-${kind}-${scope}`).check();
  await page.getByTestId(`grant-${kind}-${scope}`).click();
  await expect(page.getByTestId(`withdraw-${kind}-${scope}`)).toBeVisible();
}

async function consentEveryone(page: Page, scopes: string[]): Promise<void> {
  await addParticipant(page, "Pat Fixture", "patient");
  await addParticipant(page, "Demo Practitioner", "practitioner");
  for (const scope of scopes) {
    await grant(page, "patient", scope);
    await grant(page, "practitioner", scope);
  }
}

const phase = (page: Page) => page.getByTestId("recording-status");

async function probeMicrophones(page:Page){
  await page.addInitScript(()=>{
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const probe=window as unknown as {__captureStreams:MediaStream[]};probe.__captureStreams=[];
    navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await original(constraints);probe.__captureStreams.push(stream);return stream;};
  });
}
async function microphonesStopped(page:Page){
  await expect.poll(()=>page.evaluate(()=>{
    const streams=(window as unknown as {__captureStreams:MediaStream[]}).__captureStreams;
    return streams.length>0&&streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'));
  })).toBe(true);
}

test('uncertain recording start stops the microphone and recovers without replaying begin',async({page},testInfo)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await probeMicrophones(page);await openNewEncounter(page);await consentEveryone(page,['recording','transcription']);
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let starts=0;
  await page.route('**/api/live/scribe/recording',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    starts++;const response=await route.fetch(); // Commit once, withhold the response.
    await held;await route.fulfill({response}).catch(()=>{});
  });
  try{
    await page.getByTestId('start-recording').click();
    await expect(phase(page)).toHaveAttribute('data-phase','starting');
    await expect(phase(page)).toHaveAttribute('data-phase','unconfirmed',{timeout:12000});
    await microphonesStopped(page);expect(starts).toBe(1);
    await page.getByTestId('recording-status').scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath('recording-unconfirmed.png')});
    expect(errors).toEqual([]);
    await expect(page.getByTestId('start-recording')).toHaveCount(0);
    await page.getByTestId('check-recording-start').click();
    await expect(page.getByTestId('recover-recording')).toBeVisible();
    release();await page.unroute('**/api/live/scribe/recording');
    await page.getByTestId('recover-recording').click();
    await expect(phase(page)).toHaveAttribute('data-phase','recording');
    await page.waitForTimeout(1600);await page.getByTestId('stop-recording').click();
    await expect(phase(page)).toHaveAttribute('data-phase','transcript_ready');
    expect(starts).toBe(1);
  }finally{release();}
});

test('cancelled preparation closes the microphone and permits only a status check before manual retry',async({page})=>{
  await probeMicrophones(page);await openNewEncounter(page);await consentEveryone(page,['recording']);
  let attempted!:()=>void;const requestSeen=new Promise<void>(resolve=>{attempted=resolve;});
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let starts=0;
  await page.route('**/api/live/scribe/recording',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    starts++;attempted();await held;await route.abort().catch(()=>{}); // No server mutation.
  });
  try{
    await page.getByTestId('start-recording').click();await requestSeen;
    await page.getByTestId('cancel-recording-start').click();
    await expect(phase(page)).toHaveAttribute('data-phase','unconfirmed');await microphonesStopped(page);
    expect(starts).toBe(1);await expect(page.getByTestId('start-recording')).toHaveCount(0);
    release();await page.unroute('**/api/live/scribe/recording');
    await page.getByTestId('check-recording-start').click();
    await expect(phase(page)).toContainText('No active recording was found');
    await expect(page.getByTestId('start-recording')).toBeEnabled();
    // There is no implicit replay when status becomes available.
    expect(starts).toBe(1);
  }finally{release();}
});

test("milestone workflow: consent → record → pause/resume → transcribe → correct → draft → sign → verified deletion → audit", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // ---- no-tracker boundary: every request must stay on the app origin ----
  const offOrigin: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (!["localhost", "127.0.0.1"].includes(u.hostname)) offOrigin.push(req.url());
  });

  await page.goto(PATIENT_URL);
  await page.getByRole("button", { name: "Start encounter" }).first().click();
  await page.waitForURL("**/encounter/**");
  const encounterResponse = await page.request.get(page.url());
  const csp = encounterResponse.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("frame-src 'none'");

  await expect(page.getByTestId("scribe-panel")).toBeVisible({ timeout: pageReadyTimeout });
  await expect(page.getByTestId("scribe-provider")).toContainText("fixture", { timeout: pageReadyTimeout });

  // Recording cannot start until EVERY participant consents.
  await addParticipant(page, "Pat Fixture", "patient");
  await addParticipant(page, "Demo Practitioner", "practitioner");
  await grant(page, "patient", "recording");
  await expect(page.getByTestId("start-recording")).toBeDisabled();
  await expect(page.getByTestId("consent-gate-hint")).toBeVisible();
  await grant(page, "practitioner", "recording");
  for (const scope of ["transcription", "ai_drafting"]) {
    await grant(page, "patient", scope);
    await grant(page, "practitioner", scope);
  }
  await expect(page.getByTestId("start-recording")).toBeEnabled();

  // A practitioner-authored draft exists BEFORE the scribe runs — it must
  // never be overwritten (asserted at the end).
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByLabel("Subjective").fill("Practitioner-authored subjective. Do not overwrite.");
  await expect(page.getByTestId("save-state")).toHaveText(/Saved .*v1/, { timeout: 10_000 });

  // ---- capture: REAL MediaRecorder chunks over the authorized pipeline ----
  await page.getByTestId("start-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  await expect(phase(page)).toContainText("Recording in progress");
  await page.waitForTimeout(3500); // several 1.5s chunks flow through /api/live/scribe/chunk

  await page.getByTestId("pause-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "paused");
  await page.getByTestId("resume-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(1600);

  // ---- stop → upload (single-use completion token) → transcribe ----
  await page.getByTestId("stop-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "transcript_ready", { timeout: EXPECT_TIMEOUT_MS });
  await expect(page.getByTestId("transcript-section")).toBeVisible();
  await expect(page.getByTestId("segment-1")).toContainText("one eighteen over seventy six");
  await expect(page.getByTestId("segment-1")).toContainText("raw ASR");

  // ---- practitioner correction: overlay, raw ASR immutable ----
  await page.getByTestId("correct-1").click();
  await page.getByTestId("correction-text").fill("BP 118/76 seated, left arm.");
  await page.getByTestId("save-correction").click();
  await expect(page.getByTestId("segment-1-effective")).toHaveText("BP 118/76 seated, left arm.");
  await expect(page.getByTestId("segment-1")).toContainText("corrected");
  await expect(page.getByTestId("segment-1-raw")).toContainText("Raw ASR (immutable)");
  await expect(page.getByTestId("segment-1-raw")).toContainText("one eighteen over seventy six");
  await expect(page.getByTestId("transcript-status")).toContainText("corrected");

  // ---- proposed draft: ALWAYS a new note; idempotent per revision ----
  await page.getByTestId("generate-draft").click();
  await expect(page.getByLabel("Subjective")).toHaveValue(/AI scribe draft \(unreviewed, proposed\)/, {
    timeout: 10_000,
  });
  await expect(page.getByLabel("Subjective")).toHaveValue(/BP 118\/76 seated/);
  // The practitioner's own note is untouched (separate note in the rail).
  await expect(page.getByRole("button", { name: /SOAP/ })).toHaveCount(2);
  await page.getByTestId("generate-draft").click();
  await expect(page.getByText(/already has a proposed draft/)).toBeVisible();
  await expect(page.getByRole("button", { name: /SOAP/ })).toHaveCount(2); // no duplicate

  // ---- finalize the transcript ----
  await page.getByTestId("finalize-transcript").click();
  await expect(page.getByTestId("transcript-status")).toContainText("finalized");
  await expect(page.getByTestId("correct-1")).toHaveCount(0);

  // ---- signing workflow is UNCHANGED on the scribe note ----
  await page.getByRole("button", { name: "Ready for review" }).click();
  await expect(page.getByText("Marked ready for review.")).toBeVisible();
  await page.getByRole("button", { name: "Sign note" }).click();
  await page.getByRole("button", { name: "Sign and lock" }).click();
  await expect(page.getByTestId("signature-line")).toContainText("Signed at");
  await expect(page.getByText("Signed content is locked.")).toBeVisible();

  // The manual practitioner note is still intact, word for word.
  await page.getByRole("button", { name: /SOAP.*draft/i }).click();
  const subjectiveValues = [
    await page.getByLabel("Subjective").inputValue().catch(() => null),
    await page.getByText("Practitioner-authored subjective. Do not overwrite.").count(),
  ];
  expect(
    subjectiveValues[0] === "Practitioner-authored subjective. Do not overwrite." || (subjectiveValues[1] as number) > 0,
  ).toBe(true);

  // ---- durable, VERIFIED deletion (retry visible, proof retained) ----
  await page.getByTestId("request-deletion").click();
  await expect(page.getByTestId("deletion-verified")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
  await expect(page.getByTestId("deletion-verified")).toContainText("Audio deleted and verified");

  // ---- audit: the clinical timeline shows the chart chain; the recording's
  // append-only transition log covers its full lifecycle; access events stay
  // out of both (they live in the separate security log). ----
  const timeline = await page.request.get(
    "/api/live/emr/timeline?patientId=aaaaaaaa-1111-2222-3333-444444444401",
  );
  const timelineBody = await timeline.text();
  expect(timelineBody).toContain("Encounter started");
  expect(timelineBody).toContain("Note signed");
  expect(timelineBody).not.toContain("transcript.accessed"); // security log is separate

  const recordingId = await page.getByTestId("scribe-panel").getAttribute("data-recording-id");
  expect(recordingId).toBeTruthy();
  const recStatus = await page.request.get(`/api/live/scribe/recording?recordingId=${recordingId}`);
  const recBody = (await recStatus.json()) as {
    data: { status: string; transitions: { to: string }[] };
  };
  const visited = recBody.data.transitions.map((t) => t.to);
  for (const expected of ["capturing", "uploaded", "transcript_ready", "finalized", "deletion_pending", "deleted"]) {
    expect(visited).toContain(expected);
  }
  expect(recBody.data.status).toBe("deleted");

  // ---- the no-tracker boundary held for the entire workflow ----
  expect(offOrigin).toEqual([]);
});

test("microphone denial is a clear, recoverable failure", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
  await openNewEncounter(page);
  await consentEveryone(page, ["recording"]);
  await page.getByTestId("start-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "failed");
  await expect(phase(page)).toContainText("Microphone access was denied");
});

test("consent withdrawn mid-recording stops capture immediately (active revocation)", async ({ page }) => {
  await openNewEncounter(page);
  await consentEveryone(page, ["recording"]);
  await page.getByTestId("start-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  await page.waitForTimeout(2000);

  await page.getByTestId("withdraw-patient-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "revoked", { timeout: 15_000 });
  await expect(phase(page)).toContainText("Consent withdrawn — recording stopped");
  await expect(page.getByText(/Recording consent was withdrawn/)).toBeVisible();

  // The captured audio can still be deleted through the verified workflow.
  await page.getByTestId("request-deletion").click();
  await expect(page.getByTestId("deletion-verified")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
});

test("a late participant join pauses capture until they are identified and consent", async ({ page }) => {
  await openNewEncounter(page);
  await consentEveryone(page, ["recording"]);
  await page.getByTestId("start-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });

  await addParticipant(page, "Walk-in Caregiver", "caregiver");
  await expect(phase(page)).toHaveAttribute("data-phase", "paused", { timeout: EXPECT_TIMEOUT_MS });
  await expect(phase(page)).toContainText("new participant must be identified and consent");

  // Resume refuses until the caregiver consents; then it recovers.
  await page.getByTestId("resume-recording").click();
  await expect(page.getByText("Capture cannot resume until every participant has consented.")).toBeVisible();
  await grant(page, "caregiver", "recording");
  await page.getByTestId("resume-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  await page.getByTestId("stop-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "processing", { timeout: EXPECT_TIMEOUT_MS });
});

test("network interruption buffers locally and recovers without losing the recording", async ({ page }) => {
  await openNewEncounter(page);
  await consentEveryone(page, ["recording", "transcription"]);
  await page.getByTestId("start-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  await page.waitForTimeout(1800);

  // Kill the chunk route: the recorder keeps capturing, chunks buffer locally.
  await page.route("**/api/live/scribe/chunk", (route) => route.abort());
  await expect(phase(page)).toHaveAttribute("data-phase", "reconnecting", { timeout: 15_000 });
  await expect(phase(page)).toContainText("retrying upload");
  await page.unroute("**/api/live/scribe/chunk");
  await expect(phase(page)).toHaveAttribute("data-phase", "recording", { timeout: 15_000 });

  // Everything buffered arrives; the workflow completes normally.
  await page.getByTestId("stop-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "transcript_ready", { timeout: EXPECT_TIMEOUT_MS });
});

test("microphone loss mid-recording pauses with an unmistakable status", async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      (window as unknown as { __endCapture: () => void }).__endCapture = () => {
        for (const track of stream.getAudioTracks()) track.dispatchEvent(new Event("ended"));
      };
      return stream;
    };
  });
  await openNewEncounter(page);
  await consentEveryone(page, ["recording", "transcription"]);
  await page.getByTestId("start-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  await page.waitForTimeout(1800);

  await page.evaluate(() => (window as unknown as { __endCapture: () => void }).__endCapture());
  await expect(phase(page)).toHaveAttribute("data-phase", "device_lost");
  await expect(phase(page)).toContainText("Microphone disconnected");

  // What was captured is still completable.
  await page.getByTestId("stop-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "transcript_ready", { timeout: EXPECT_TIMEOUT_MS });
});

test("refresh mid-recording recovers the interrupted capture from the server", async ({ page }) => {
  await openNewEncounter(page);
  const encounterUrl = page.url();
  await consentEveryone(page, ["recording", "transcription"]);
  await page.getByTestId("start-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  await page.waitForTimeout(2000);

  await page.reload();
  await expect(page.getByTestId("recover-recording")).toBeVisible({ timeout: 10_000 });
  await expect(phase(page)).toContainText("interrupted");
  expect(page.url()).toBe(encounterUrl);

  await page.getByTestId("recover-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });
  await page.waitForTimeout(1600);
  await page.getByTestId("stop-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "transcript_ready", { timeout: EXPECT_TIMEOUT_MS });
});

test("a second tab cannot start a competing capture for the same encounter", async ({ page, context }) => {
  await openNewEncounter(page);
  const encounterUrl = page.url();
  await consentEveryone(page, ["recording"]);
  await page.getByTestId("start-recording").click();
  await expect(phase(page)).toHaveAttribute("data-phase", "recording", { timeout: 10_000 });

  const second = await context.newPage();
  await second.goto(encounterUrl);
  await expect(second.getByTestId("scribe-panel")).toBeVisible({ timeout: pageReadyTimeout });
  // The second tab discovers the live capture: no fresh Start, recovery only.
  await expect(second.getByTestId("recover-recording")).toBeVisible({ timeout: 10_000 });
  await expect(second.getByTestId("start-recording")).toHaveCount(0);
  await expect(second.getByTestId("recording-status")).toContainText("another tab");
  await second.close();
});
