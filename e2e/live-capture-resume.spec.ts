import { expect, test, type Page } from "@playwright/test";
import { resetBackend } from "./support/backend";

test.skip(!process.env.E2E_LIVE, "requires synthetic clinical fixture");
test.beforeAll(resetBackend);
const patientId = "aaaaaaaa-1111-2222-3333-444444444401";
const status = (page: Page) => page.getByTestId("recording-status");

type Probe = { streams: MediaStream[]; recorders: MediaRecorder[]; chunks: Blob[]; denyNext: boolean };
async function setup(page: Page) {
  await page.addInitScript(() => {
    const probe: Probe = { streams: [], recorders: [], chunks: [], denyNext: false };
    (window as unknown as { __resumeProbe: Probe }).__resumeProbe = probe;
    const microphone = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (probe.denyNext) { probe.denyNext = false; throw new DOMException("Synthetic denial", "NotAllowedError"); }
      const stream = await microphone(constraints); probe.streams.push(stream); return stream;
    };
    const Native = window.MediaRecorder;
    window.MediaRecorder = class extends Native {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options); probe.recorders.push(this);
        this.addEventListener("dataavailable", event => { if (event.data.size) probe.chunks.push(event.data); });
      }
    };
  });
  // Exercise capture independently of the separately tracked client-router
  // stall. This creates a real fixture encounter and loads its document URL.
  const response = await page.request.post("/api/live/emr/encounter", { data: { patientId, visitType: "follow-up" } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).data.encounterId;
  await page.goto(`/patients/${patientId}/encounter/${id}`);
  await expect(page.getByTestId("scribe-panel")).toBeVisible();
  for (const [kind, name] of [["patient", "Synthetic patient"], ["practitioner", "Synthetic practitioner"]]) {
    await page.getByTestId("participant-name").fill(name);
    await page.getByTestId("participant-kind").selectOption(kind);
    await page.getByTestId("add-participant-btn").click();
    await expect(page.getByTestId("participant-name")).toHaveValue("");
    for (const scope of ["recording", "transcription"]) {
      await page.getByTestId(`ack-${kind}-${scope}`).check();
      await page.getByTestId(`grant-${kind}-${scope}`).click();
      await expect(page.getByTestId(`withdraw-${kind}-${scope}`)).toBeVisible();
    }
  }
  await page.getByTestId("start-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "recording");
}

test("background heartbeat cannot unpause capture and failed fresh authorization cannot resume it", async ({ page }) => {
  await setup(page);
  await page.getByTestId("pause-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "paused");
  await page.waitForResponse(response => response.url().endsWith("/api/live/scribe/recording")
    && response.request().method() === "PATCH" && response.request().postDataJSON()?.action === "heartbeat");
  await expect(status(page)).toHaveAttribute("data-phase", "paused");
  expect(await page.evaluate(() => (window as unknown as { __resumeProbe: Probe }).__resumeProbe.recorders[0].state)).toBe("paused");
  let resumes = 0;
  await page.route("**/api/live/scribe/recording", async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    const action = route.request().postDataJSON().action;
    if (action === "resume") resumes++;
    if (action === "heartbeat") return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    return route.continue();
  });
  await page.getByTestId("resume-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "paused");
  await expect(page.getByText("Fresh capture authorization was not confirmed. Recording remains paused; no automatic resume was sent.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __resumeProbe: Probe }).__resumeProbe.recorders[0].state)).toBe("paused");
  expect(resumes).toBe(1);
  await page.unroute("**/api/live/scribe/recording");
  await page.getByTestId("resume-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(1700);
  await page.getByTestId("stop-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "transcript_ready");
});

test("ended microphone can reconnect only after authorization while preserving one playable recording", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await setup(page); await page.waitForTimeout(1700);
  const outputTrack = await page.evaluate(() => (window as unknown as { __resumeProbe: Probe }).__resumeProbe.recorders[0].stream.getTracks()[0].id);
  await page.evaluate(() => {
    const probe = (window as unknown as { __resumeProbe: Probe }).__resumeProbe;
    const track = probe.streams[0].getAudioTracks()[0]; track.stop(); track.dispatchEvent(new Event("ended"));
    probe.denyNext = true;
  });
  await expect(status(page)).toHaveAttribute("data-phase", "device_lost");
  await page.getByTestId("resume-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "device_lost");
  await expect(status(page)).toContainText("Resume could not be confirmed");
  expect(await page.evaluate(() => (window as unknown as { __resumeProbe: Probe }).__resumeProbe.recorders[0].state)).toBe("paused");
  await page.getByTestId("resume-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "recording");
  expect(await page.evaluate(() => {
    const p = (window as unknown as { __resumeProbe: Probe }).__resumeProbe;
    return { count: p.recorders.length, microphones: p.streams.length, output: p.recorders[0].stream.getTracks()[0].id };
  })).toEqual({ count: 1, microphones: 2, output: outputTrack });
  await page.waitForTimeout(1700);
  await page.getByTestId("stop-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "transcript_ready");
  const decoded = await page.evaluate(async () => {
    const p = (window as unknown as { __resumeProbe: Probe }).__resumeProbe;
    const context = new AudioContext();
    try {
      const audio = await context.decodeAudioData(await new Blob(p.chunks, { type: p.recorders[0].mimeType }).arrayBuffer());
      return { seconds: audio.duration, stopped: p.streams.every(s => s.getTracks().every(t => t.readyState === "ended")) };
    } finally { await context.close(); }
  });
  expect(decoded.seconds).toBeGreaterThan(2); expect(decoded.stopped).toBe(true);
  await page.getByTestId("recording-status").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("reconnected-capture.png") });
  expect(errors).toEqual([]);
});

test("cancelled resume ignores a late successful response and preserves the paused recorder", async ({ page }) => {
  await setup(page); await page.getByTestId("pause-recording").click();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const seen = new Promise<void>(resolve => { reached = resolve; });
  let resumes = 0;
  await page.route("**/api/live/scribe/recording", async route => {
    if (route.request().method() !== "PATCH" || route.request().postDataJSON().action !== "resume") return route.continue();
    resumes++; const response = await route.fetch(); reached(); await held;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByTestId("resume-recording").click(); await seen;
    await page.getByTestId("cancel-recording-resume").click();
    await expect(status(page)).toHaveAttribute("data-phase", "paused");
    release(); await page.unroute("**/api/live/scribe/recording");
    expect(await page.evaluate(() => (window as unknown as { __resumeProbe: Probe }).__resumeProbe.recorders[0].state)).toBe("paused");
    expect(resumes).toBe(1);
    await page.getByTestId("resume-recording").click();
    await expect(status(page)).toHaveAttribute("data-phase", "recording");
    await page.waitForTimeout(1700); await page.getByTestId("stop-recording").click();
    await expect(status(page)).toHaveAttribute("data-phase", "transcript_ready");
  } finally { release(); }
});

test("revocation cancels a pending chunk and fences delayed recorder events and upload replies", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const seen = new Promise<void>(resolve => { reached = resolve; });
  let uploads = 0;
  const uploaded: { recordingId: string; lateAudio: boolean }[] = [];
  await page.route("**/api/live/scribe/chunk", async route => {
    uploads++;
    uploaded.push({ recordingId: route.request().headers()["x-recording-id"],
      lateAudio: route.request().postDataBuffer()?.includes(Buffer.from("synthetic late audio")) ?? false });
    if (uploads > 1) return route.continue();
    const response = await route.fetch(); reached(); await held;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await setup(page); await seen;
    await page.getByTestId("withdraw-patient-recording").click();
    await expect(status(page)).toHaveAttribute("data-phase", "revoked");
    await expect(page.getByText("Unsent audio was cleared from this page.", { exact: false })).toBeVisible();
    const count = uploads;
    await page.evaluate(() => {
      const recorder = (window as unknown as { __resumeProbe: Probe }).__resumeProbe.recorders[0];
      // Deliver the final event after cancellation, as browser event queues may.
      recorder.dispatchEvent(new BlobEvent("dataavailable", { data: new Blob(["synthetic late audio"]) }));
    });
    await page.waitForTimeout(1800);
    expect(uploads).toBe(count);
    await expect(status(page)).toHaveAttribute("data-phase", "revoked");
    expect(await page.evaluate(() => {
      const probe = (window as unknown as { __resumeProbe: Probe }).__resumeProbe;
      return probe.recorders.every(recorder => recorder.state === "inactive")
        && probe.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended"));
    })).toBe(true);
    expect(errors).toEqual([]);
    await status(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("revoked-upload.png") });
    // Renewed consent does not dispose of the old paused recording or revive
    // its revoked session. The backend must continue refusing a competing start.
    await page.getByTestId("ack-patient-recording").check();
    await page.getByTestId("grant-patient-recording").click();
    await expect(page.getByTestId("withdraw-patient-recording")).toBeVisible();
    await page.getByTestId("start-recording").click();
    await expect(status(page)).toHaveAttribute("data-phase", "unconfirmed");
    release();
    expect(uploads).toBe(count);
    expect(uploaded.some(chunk => chunk.lateAudio)).toBe(false);
    expect(errors).toEqual([]);
  } finally { release(); }
});

test("a completed recorder cannot inject delayed audio into a subsequent recording", async ({ page }) => {
  const uploaded: { recordingId: string; lateAudio: boolean }[] = [];
  await page.route("**/api/live/scribe/chunk", async route => {
    uploaded.push({ recordingId: route.request().headers()["x-recording-id"],
      lateAudio: route.request().postDataBuffer()?.includes(Buffer.from("synthetic late audio")) ?? false });
    await route.continue();
  });
  await setup(page);
  await expect.poll(() => uploaded.length).toBeGreaterThan(0);
  const firstId = uploaded[0].recordingId;
  await page.getByTestId("stop-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "transcript_ready");
  await page.getByTestId("start-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "recording");
  await page.evaluate(() => {
    const probe = (window as unknown as { __resumeProbe: Probe }).__resumeProbe;
    if (probe.recorders.length !== 2) throw new Error("expected two distinct recorders");
    probe.recorders[0].dispatchEvent(new BlobEvent("dataavailable", { data: new Blob(["synthetic late audio"]) }));
  });
  await expect.poll(() => uploaded.some(chunk => chunk.recordingId !== firstId)).toBe(true);
  await page.getByTestId("stop-recording").click();
  await expect(status(page)).toHaveAttribute("data-phase", "transcript_ready");
  expect(uploaded.some(chunk => chunk.lateAudio)).toBe(false);
});
