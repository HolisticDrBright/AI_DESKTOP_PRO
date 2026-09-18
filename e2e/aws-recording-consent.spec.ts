import { test, expect, type Page } from "@playwright/test";
test.skip(process.env.E2E_RECORDING_AWS !== "1", "Run with the dedicated AWS consent presentation configuration.");
// Presentation contract: fictional HTTP responses only. Real authorization,
// consent and isolation execute separately in encounter-recording-authority.database.test.
const encounterId = "11111111-1111-4111-8111-111111111111";
const participantId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const consentId = "44444444-4444-4444-8444-444444444444";
const patientId = "aaaaaaaa-1111-2222-3333-444444444401";
const path = `/patients/${patientId}/encounter/${encounterId}`;
const capabilities = { consentManagement: true, audioCapture: false, reason: "audio_transport_not_configured" };
const release = { id: releaseId, scope: "recording", version: "fictional-v1", locale: "en-US", jurisdiction: "FICTIONAL", contentSha256: "a".repeat(64) };
const participant = { id: participantId, kind: "patient", displayName: "Fictional Participant", canSelfConsent: true, joinedAt: "2026-09-17T00:00:00Z", consents: [] as unknown[] };
function workspace(participants = [] as unknown[]) {
  return { encounterId, encounterStatus: "in_progress", participants, consentReleases: [release], activeCapture: null };
}
async function open(page: Page) {
  // Preserve the pre-hydration boundary on failure without logging clinical
  // payloads, URL parameters or browser credentials. Do not relax deadlines.
  let encounterRequests = 0, pageErrors = 0, failedScripts = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/live/emr/encounter') encounterRequests++; });
  page.on('pageerror', () => { pageErrors++; });
  page.on('requestfailed', request => { if (request.resourceType() === 'script') failedScripts++; });
  await page.route("**/api/live/emr/encounter?*", route => route.fulfill({ json: { data: {
    encounter: { encounterId, patientId, status: "in_progress", appointmentId: null, visitType: null, startedAt: null, endedAt: null, statusReason: null }, notes: [],
  } } }));
  await page.goto(path);
  try { await expect(page.getByRole("heading", { name: "Recording consent — AWS" })).toBeVisible(); }
  catch (error) {
    await test.info().attach('encounter-mount-boundary', {contentType:'application/json',
      body:JSON.stringify({encounterRequests,pageErrors,failedScripts})});
    throw error;
  }
  await expect(page.getByRole("button", { name: /Start recording/i })).toHaveCount(0);
  await page.getByLabel("Consent locale").fill("en-US");
  await page.getByLabel("Reviewed jurisdiction").fill("FICTIONAL");
  await page.getByRole("button", { name: "Load consent workspace" }).click();
}
test("reviews exact document, independently grants and withdraws consent without capturing", async ({ page }, info) => {
  const calls: Record<string, unknown>[] = []; const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  let participants: unknown[] = [];
  await page.route("**/api/live/scribe/authority", async route => {
    const body = route.request().postDataJSON(); calls.push(body);
    let data: unknown;
    if (body.action === "workspace") data = workspace(participants);
    else if (body.action === "addParticipant") { participants = [{ ...participant }]; data = { participantId }; }
    else if (body.action === "readConsentRelease") data = { ...release, content: "Fictional exact reviewed recording text. No transcription or AI drafting consent." };
    else if (body.action === "grantConsent") {
      participants = [{ ...participant, consents: [{ id: consentId, scope: "recording", releaseId, status: "granted", effective: true, grantedAt: "2026-09-17T01:00:00Z", withdrawnAt: null }] }];
      data = { consentId };
    } else {
      expect(body.action).toBe("withdrawConsent");
      participants = [{ ...participant, consents: [{ id: consentId, scope: "recording", releaseId, status: "withdrawn", effective: false, grantedAt: "2026-09-17T01:00:00Z", withdrawnAt: "2026-09-17T02:00:00Z" }] }];
      data = { withdrawn: true };
    }
    await route.fulfill({ json: { data, capabilities } });
  });
  await open(page);
  await page.getByLabel("Participant name", { exact: true }).fill("Fictional Participant");
  await page.getByLabel("Self-consent capacity").selectOption("yes");
  await page.getByRole("button", { name: "Add participant", exact: true }).click();
  await page.getByRole("button", { name: "Review recording consent for Fictional Participant" }).click();
  await expect(page.getByText("Fictional exact reviewed recording text.", { exact: false })).toBeVisible();
  // An empty acknowledgment and unchecked presentation assertion cannot save.
  await page.getByRole("button", { name: "Record recording consent", exact: true }).click();
  expect(calls.filter(c => c.action === "grantConsent")).toHaveLength(0);
  await page.getByLabel("Acknowledgment of this exact document").fill("Fictional participant agreed after this document was read.");
  await page.getByRole("checkbox", { name: /I presented this exact document/ }).check();
  await page.screenshot({ path: info.outputPath("recording-consent-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Record recording consent", exact: true }).click();
  await expect(page.getByText("Recording: Effective consent recorded", { exact: true })).toBeVisible();
  await expect(page.getByText("Transcription: Not granted", { exact: true })).toBeVisible();
  await expect(page.getByText("AI drafting: Not granted", { exact: true })).toBeVisible();
  await page.getByLabel("Withdrawal reason").fill("Fictional withdrawal requested.");
  await page.getByRole("button", { name: "Withdraw recording consent for Fictional Participant" }).click();
  await expect(page.getByText("Recording: Not effective (withdrawn)", { exact: true })).toBeVisible();
  expect(calls.find(c => c.action === "grantConsent")).toMatchObject({ participantId, releaseId, representativeAuthorityId: null, method: "verbal_attested" });
  expect(calls.some(c => String(c.action).includes("Capture"))).toBe(false);
  expect(errors).toEqual([]);
});
test("uncertain participant creation retries the original command instead of issuing a duplicate", async ({ page }) => {
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/live/scribe/authority", async route => {
    const body = route.request().postDataJSON();
    if (body.action === "addParticipant") {
      commands.push(body);
      if (commands.length === 1) { await route.fulfill({ status: 503, json: { error: { message: "DO NOT RENDER PROVIDER SECRET" } } }); return; }
      await route.fulfill({ json: { data: { participantId }, capabilities } }); return;
    }
    await route.fulfill({ json: { data: workspace(commands.length ? [participant] : []), capabilities } });
  });
  await open(page);
  await page.getByLabel("Participant name", { exact: true }).fill("Fictional Participant");
  await page.getByLabel("Self-consent capacity").selectOption("yes");
  await page.getByRole("button", { name: "Add participant", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry the same request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add participant", exact: true })).toBeDisabled();
  await expect(page.getByText("DO NOT RENDER PROVIDER SECRET")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry the same request" }).click();
  await expect(page.getByRole("heading", { name: "Fictional Participant — patient" })).toBeVisible();
  expect(commands).toHaveLength(2); expect(commands[0]).toEqual(commands[1]);
  expect(commands[0].commandId).toMatch(/^[0-9a-f-]{36}$/);
});
test("representative capacity and missing jurisdiction releases never become implied consent", async ({ page }) => {
  await page.route("**/api/live/scribe/authority", route => route.fulfill({ json: {
    data: { ...workspace([{ ...participant, canSelfConsent: false }]), consentReleases: [] }, capabilities,
  } }));
  await open(page);
  await expect(page.getByText(/No current reviewed consent documents match/)).toBeVisible();
  await expect(page.getByText(/Representative evidence requires a separate reviewed-authority workflow/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Review recording consent/ })).toHaveCount(0);
  await page.getByLabel("Reviewed jurisdiction").fill("ANOTHER");
  await expect(page.getByRole("heading", { name: "Fictional Participant — patient" })).toHaveCount(0);
});
test("unavailable or fresh-auth-required service never renders a fictional empty workspace", async ({ page }) => {
  let status = 503;
  await page.route("**/api/live/scribe/authority", route => route.fulfill({ status, json: { error: "untrusted detailed failure" } }));
  await open(page);
  await expect(page.getByRole("alert").filter({ hasText: "The clinical service is unavailable" })).toBeVisible();
  await expect(page.getByText("No participants recorded.")).toHaveCount(0);
  status = 401;
  await page.getByRole("button", { name: "Load consent workspace" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sign in again to renew your workforce authorization" })).toBeVisible();
  await expect(page.getByText("untrusted detailed failure")).toHaveCount(0);
});
test("the real Desktop proxy refuses a browser without a workforce cookie, despite local chart fixtures", async ({ page }) => {
  await page.goto("/today");
  const result = await page.evaluate(async (encounterId) => {
    const response = await fetch("/api/live/scribe/authority", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "workspace", encounterId, locale: "en-US", jurisdiction: "FICTIONAL" }) });
    return { status: response.status, cache: response.headers.get("cache-control"), data: await response.json() };
  }, encounterId);
  expect(result).toMatchObject({ status: 401, data: { error: { code: "unauthenticated" } } });
  // The app middleware adds no-cache/must-revalidate to the route's no-store.
  expect(result.cache?.split(",").map(v => v.trim())).toContain("no-store");
});

const recovery = { recordingId: consentId, sessionId: releaseId, status: "capturing", credentialVersion: 0,
  authorityEpoch: 1, currentAuthorityEpoch: 1, tokenExpiresAt: "2026-09-17T22:00:00Z",
  deletionDeadline: "2026-09-18T22:00:00Z", storedSegments: 2, pendingSegments: 0, reservedBytes: 8,
  nextSequence: 2, inventorySha256: "a".repeat(64), disposition: null as string | null,
  processingRequested: false, audioDeleted: false };

test("reconciles a pending object with exact retry after a lost response, without sending audio or credentials", async ({ page }, info) => {
  await withCapture(page);
  let reconciliations=0;
  const calls:Record<string,unknown>[]=[];
  await page.route("**/api/live/scribe/capture/*",async route=>{
    const operation=new URL(route.request().url()).pathname.split("/").at(-1), body=route.request().postDataJSON();
    calls.push({operation,...body});
    expect(["state","reconcile"]).toContain(operation);
    expect(body).toEqual({recordingId:consentId});
    if(operation==="state"){
      await route.fulfill({json:{data:{...recovery,status:"paused",credentialVersion:1,
        storedSegments:reconciliations?3:2,pendingSegments:reconciliations?0:1,nextSequence:3,
        inventorySha256:(reconciliations?"b":"a").repeat(64)}}});return;
    }
    reconciliations++;
    if(reconciliations===1){await route.fulfill({status:503,json:{error:"FICTIONAL SECRET MUST NOT DISPLAY"}});return;}
    await route.fulfill({json:{data:{recordingId:consentId,outcome:"no_pending_segment"}}});
  });
  await open(page);await page.getByRole("button",{name:"Load recording status"}).click();
  await expect(page.getByRole("option",{name:"Finish capture without processing"})).toHaveJSProperty("disabled",true);
  await page.getByRole("button",{name:"Reconcile pending upload"}).click();
  await expect(page.getByRole("button",{name:"Retry the same recording command"})).toBeVisible();
  await expect(page.getByText("FICTIONAL SECRET MUST NOT DISPLAY")).toHaveCount(0);
  await page.getByRole("button",{name:"Retry the same recording command"}).click();
  await expect(page.getByText("Recording status: paused. Stored segments: 3. Pending segments: 0.")).toBeVisible();
  await expect(page.getByRole("option",{name:"Finish capture without processing"})).toHaveJSProperty("disabled",false);
  await expect(page.getByRole("button",{name:"Reconcile pending upload"})).toHaveCount(0);
  await expect(page.getByText(/Audio deletion is not confirmed/)).toBeVisible();
  expect(calls.filter(c=>c.operation==="reconcile")).toEqual([
    {operation:"reconcile",recordingId:consentId},{operation:"reconcile",recordingId:consentId}]);
  await page.screenshot({path:info.outputPath("recording-reconciled.png"),fullPage:true});
});
async function withCapture(page: Page) {
  await page.route("**/api/live/scribe/authority", route => route.fulfill({ json: { data: {
    ...workspace(), activeCapture: { id: consentId, sessionId: releaseId, status: "capturing",
      createdAt: "2026-09-17T21:00:00Z", authorityEpoch: 1, deletionDeadline: recovery.deletionDeadline },
  }, capabilities } }));
}
test("rediscovers a recording, pauses and explicitly finishes it without microphone, processing or deletion", async ({ page }, info) => {
  await withCapture(page);
  let current = { ...recovery };
  const commands: Record<string, unknown>[] = [], errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/live/scribe/capture/*", async route => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1);
    const body = route.request().postDataJSON();
    expect(operation === "state" || operation === "command").toBe(true);
    if (operation === "state") { expect(body).toEqual({ recordingId: consentId }); await route.fulfill({ json: { data: current } }); return; }
    commands.push(body);
    current = { ...current, status: body.action === "pause" ? "paused" : "closed",
      disposition: body.action === "pause" ? null : body.action, credentialVersion: current.credentialVersion + 1 };
    await route.fulfill({ json: { data: { recordingId: consentId, commandId: body.commandId, action: body.action,
      statusAtCommand: current.status, credentialVersion: current.credentialVersion, expiresAt: recovery.tokenExpiresAt,
      inventorySha256: body.inventorySha256, processingRequested: false, audioDeleted: false,
      replayed: false, captureToken: null, requiresCredentialRecovery: false } } });
  });
  await open(page);
  await expect(page.getByRole("heading", { name: "Existing recording recovery" })).toBeVisible();
  expect(commands).toHaveLength(0);
  await page.getByRole("button", { name: "Load recording status" }).click();
  await expect(page.getByText("Recording status: capturing.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Pause this recording" }).click();
  await expect(page.getByText("Recording status: paused.", { exact: false })).toBeVisible();
  await page.getByLabel("Recording disposition", { exact: false }).selectOption("finish");
  await page.getByRole("button", { name: "Confirm recording disposition" }).click();
  expect(commands).toHaveLength(1);
  await page.getByRole("checkbox", { name: /I reviewed this inventory/ }).check();
  await page.screenshot({ path: info.outputPath("recording-recovery-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Confirm recording disposition" }).click();
  await expect(page.getByText("Capture closed: finish.", { exact: false })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({ action: "pause", expectedVersion: 0, inventorySha256: null });
  expect(commands[1]).toMatchObject({ action: "finish", expectedVersion: 1, inventorySha256: recovery.inventorySha256 });
  await expect(page.getByRole("button", { name: /Resume|Start recording/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("uncertain recovery retries the exact command and blocks closing an unresolved upload", async ({ page }) => {
  await withCapture(page);
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/live/scribe/capture/*", async route => {
    if (route.request().url().endsWith("/state")) {
      await route.fulfill({ json: { data: { ...recovery, pendingSegments: 1, nextSequence: 3 } } }); return;
    }
    const body = route.request().postDataJSON(); commands.push(body);
    if (commands.length === 1) { await route.fulfill({ status: 503, json: { secret: "NEVER SHOW THIS TOKEN" } }); return; }
    await route.fulfill({ status: 409, json: { secret: "NEVER SHOW THIS TOKEN" } });
  });
  await open(page);
  await page.getByRole("button", { name: "Load recording status" }).click();
  // Playwright's enabled-state matcher does not model native option disabling.
  // Assert the actual DOM property and the available selectable disposition.
  await expect(page.getByRole("option", { name: "Finish capture without processing" })).toHaveJSProperty("disabled", true);
  await page.getByLabel("Recording disposition", { exact: false }).selectOption("discard");
  await expect(page.getByLabel("Recording disposition", { exact: false })).toHaveValue("discard");
  await page.getByRole("button", { name: "Pause this recording" }).click();
  await expect(page.getByRole("button", { name: "Retry the same recording command" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm recording disposition" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry the same recording command" }).click();
  await expect(page.getByText(/The recording changed. Reload its status/)).toBeVisible();
  expect(commands).toHaveLength(2); expect(commands[0]).toEqual(commands[1]);
  await expect(page.getByText("NEVER SHOW THIS TOKEN")).toHaveCount(0);
});
test("wrong-session recovery response is refused and real capture proxy cannot use fixture auth", async ({ page }) => {
  await withCapture(page);
  await page.route("**/api/live/scribe/capture/state", route => route.fulfill({ json: { data: { ...recovery, sessionId: participantId } } }));
  await open(page);
  await page.getByRole("button", { name: "Load recording status" }).click();
  await expect(page.getByRole("region", { name: "Recording recovery" }).getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause this recording" })).toHaveCount(0);
  await page.unroute("**/api/live/scribe/capture/state");
  const status = await page.evaluate(async recordingId => (await fetch("/api/live/scribe/capture/state", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recordingId }),
  })).status, consentId);
  expect(status).toBe(401);
});
