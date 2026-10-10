import { expect, test } from "@playwright/test";
import { STUB_BASE, resetBackend } from "./support/backend";

/**
 * TELEHEALTH TAB, browser-level, against the committed contract fixture:
 *
 *   1. the day view lists the day's real telehealth appointments from the
 *      calendar RPC and nothing else (the admin block is not a visit), and
 *      says "Consent not signed" only because the visit service answered
 *   2. the SERVER refuses to start a visit with no consent on record — the
 *      refusal is a 409 from the start route, not a hidden button
 *   3. recording the combined consent on the desktop unlocks the visit, the
 *      embedded-meeting session is issued once, ending the visit stores the
 *      quick notes and flagged moments, and the note opens
 *   4. the AI Companion summary imports as NOT reviewed, the practitioner's
 *      notes sit above it, action items are decisions only, and one
 *      signature freezes the note — persisted, not local state
 *   5. placing the signed record in the chart is an explicit action that
 *      creates ONE unsigned chart draft on the telehealth encounter, links
 *      it from the visit, shows it in the patient timeline, survives a lost
 *      completion response through Inspect, and never writes a second note
 *
 * The Zoom Meeting SDK download is aborted by the suite: no meeting exists in
 * the fixture, and the screen must report that honestly instead of pretending
 * a connection.
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 CLINICAL_CONTRACT_FIXTURE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-telehealth.spec.ts
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

test.beforeAll(resetBackend);

const APPOINTMENT = "abababab-1111-2222-3333-444444444408";

/** The fixture seeds the telehealth visit on the Sunday of the week it is first asked about. */
function sundayOfThisWeek(): string {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`;
}

const DATE = sundayOfThisWeek();

test.beforeEach(async ({ page }) => {
  // No meeting exists in the fixture; the SDK must not be fetched from Zoom's CDN here.
  await page.route("https://source.zoom.us/**", (route) => route.abort());
});

test("day view lists the real telehealth appointment and names the consent state honestly", async ({ page }) => {
  await page.goto(`/telehealth?date=${DATE}`);
  await expect(page.getByRole("heading", { name: "Telehealth" })).toBeVisible();
  const rows = page.getByTestId("telehealth-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Fixture Patient");
  await expect(rows.first()).toContainText("Consent not signed");
  // The admin block is a calendar appointment, not a virtual visit.
  await expect(page.getByText("Admin block")).toHaveCount(0);
  await expect(page.getByTestId("telehealth-service-unavailable")).toHaveCount(0);
  // Stat tiles are counts of the rows shown, nothing else.
  await expect(page.getByText("Virtual visits", { exact: true }).locator("..")).toContainText("1");
  await expect(page.getByText("Consent missing", { exact: true }).locator("..")).toContainText("1");
  // Navigation: the tab is in the sidebar and highlights here.
  await expect(page.getByRole("link", { name: "Telehealth" })).toHaveAttribute("aria-current", "page");
});

test("the server refuses to start a visit without a signed consent", async ({ page }) => {
  await page.goto(`/telehealth/visit/${APPOINTMENT}?date=${DATE}`);
  await expect(page.getByText("This visit cannot start")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start visit" })).toHaveCount(0);
  // The control is the route, not the UI: a direct start is refused with the consent reason.
  const res = await page.request.post("/api/live/telehealth/start", {
    data: { appointmentId: APPOINTMENT, date: DATE, timeZone: "America/Los_Angeles", hostDisplayName: "Demo Practitioner" },
  });
  expect(res.status()).toBe(409);
  const body = (await res.json()) as { error?: { message?: string } };
  expect(body.error?.message).toMatch(/no current telehealth consent/i);
  // An appointment the practitioner's calendar does not return is refused before the boundary is asked.
  const unknown = await page.request.post("/api/live/telehealth/start", {
    data: { appointmentId: "99999999-9999-4999-8999-999999999999", date: DATE, timeZone: "America/Los_Angeles" },
  });
  expect(unknown.status()).toBe(404);
  // A consent that does not name the current approved artifact is refused by the boundary.
  const stale = await page.request.post("/api/live/telehealth/consent", {
    data: { appointmentId: APPOINTMENT, date: DATE, timeZone: "America/Los_Angeles", artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", artifactVersion: "never-reviewed", contentSha256: "b".repeat(64), signerName: "Fixture Patient", agreed: true },
  });
  expect(stale.status()).toBe(409);
  expect(((await stale.json()) as { error?: { message?: string } }).error?.message).toMatch(/current approved telehealth consent/i);
});

test("recording consent unlocks the visit; ending it stores quick notes and opens the note", async ({ page }) => {
  await page.goto(`/telehealth?date=${DATE}`);
  await page.getByRole("button", { name: "Record consent" }).click();
  const dialog = page.getByRole("dialog", { name: "Record telehealth consent" });
  await expect(dialog).toBeVisible();
  // Refused until both the typed name and the attestation are present.
  // The dialog shows the practice's CURRENT approved consent before anything can be attested.
  await expect(dialog.getByTestId("consent-artifact")).toContainText("version telehealth-recording/1");
  await dialog.getByRole("button", { name: "Record consent" }).click();
  await expect(dialog.getByRole("alert")).toContainText("confirm they agreed");
  await dialog.getByLabel("Patient's full name (as they stated it)").fill("Fixture Patient");
  await dialog.getByLabel("Where the patient will be during the visit (state, optional)").fill("CA");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Record consent" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("telehealth-row").first()).toContainText("Consent signed");
  await expect(page.getByTestId("telehealth-row").first()).toContainText("consent recorded by staff");

  await page.getByRole("link", { name: "Start visit" }).click();
  await page.waitForURL(`**/telehealth/visit/${APPOINTMENT}?date=${DATE}`);
  await expect(page.getByText("Consent signed")).toBeVisible();
  await page.getByRole("button", { name: "Start visit" }).click();
  // The visit is open on the server (timer runs, End visit is offered) even
  // though the aborted SDK download means no meeting UI — and the screen says so.
  await expect(page.getByTestId("visit-refusal")).toContainText("Zoom Meeting SDK could not be loaded");
  await expect(page.getByTestId("zoom-stage")).toHaveAttribute("data-zoom-state", "failed");
  await expect(page.getByRole("button", { name: "End visit" })).toBeEnabled();
  await page.getByLabel("Quick notes").fill("Patient reports better afternoons.");
  await page.getByRole("button", { name: "Flag this moment" }).click();
  await expect(page.getByRole("list", { name: "Flagged moments" }).locator("li")).toHaveCount(1);

  await page.getByRole("button", { name: "End visit" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "End visit" }).click();
  // The note opens only because the fixture provider CONFIRMED the shutdown; the Lambda keeps `ending` otherwise.
  await page.waitForURL(`**/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  await expect(page.getByText("Visit ended · note pending")).toBeVisible();
  await expect(page.getByText("Telehealth visit record.")).toBeVisible();

  // Persisted on the visit record, not in this tab: a fresh load still carries them.
  await page.goto(`/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  await page.getByRole("button", { name: "Paste my quick notes from the call" }).click();
  await expect(page.getByLabel("Practitioner notes")).toHaveValue("Patient reports better afternoons.");
  await expect(page.getByText(/Flagged at/)).toBeVisible();
});

test("a refused signature removes opened clinical text and does not retain unsaved edits on retry", async ({ page }) => {
  await page.goto(`/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  await page.getByRole("button", { name: "Import AI Companion notes" }).click();
  await expect(page.getByLabel("Summary")).toHaveValue(/Follow-up on fatigue and iron status/);
  await page.getByLabel("Practitioner notes").fill("FICTIONAL private unsaved note");
  await page.getByLabel("Summary").fill("FICTIONAL private unsaved summary");
  await page.route("**/api/live/telehealth/note/sign", route => route.fulfill({
    status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden", message: "You don't have access to this record." } }),
  }));
  await page.getByRole("button", { name: "Sign note" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sign note" }).click();
  await expect(page.getByText("You don't have access to this record.")).toBeVisible();
  await expect(page.getByLabel("Practitioner notes")).toHaveCount(0);
  await expect(page.getByLabel("Summary")).toHaveCount(0);
  await expect(page.getByText(/Repeat ferritin/)).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.unroute("**/api/live/telehealth/note/sign");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByLabel("Practitioner notes")).toHaveValue("");
  await expect(page.getByLabel("Summary")).toHaveValue(/Follow-up on fatigue and iron status/);
  await expect(page.getByText("FICTIONAL private unsaved summary")).toHaveCount(0);
});

test("the imported unreviewed AI Companion note is frozen by one confirmed signature", async ({ page }) => {
  await page.goto(`/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  // The preceding authorization-loss case imported this same persisted
  // revision. The import control is correctly absent once a note exists.
  await expect(page.getByText("Not reviewed", { exact: true })).toBeVisible();
  await expect(page.getByLabel("What the patient reported")).toHaveValue(/Afternoon fatigue has eased/);
  // Zoom's unified summary document lands whole under Summary as unreviewed text, not split by a model.
  await expect(page.getByLabel("Summary")).toHaveValue(/## Follow-up on fatigue and iron status/);
  await expect(page.getByText("Repeat ferritin in 8 weeks", { exact: true })).toBeVisible();
  // Nothing signed yet: the day view agrees.
  await page.goto(`/telehealth?date=${DATE}`);
  await expect(page.getByTestId("telehealth-row").first()).toContainText("Note awaiting signature");

  await page.goto(`/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  await page.getByLabel("Practitioner notes").fill("Agree with the summary. Continue protocol.");
  await page.getByLabel("Summary").fill("Edited summary.");
  await page.getByRole("listitem").filter({ hasText: "Repeat ferritin in 8 weeks" }).getByRole("button", { name: "Approve" }).click();
  await page.getByRole("listitem").filter({ hasText: "sleep log" }).getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("button", { name: "Sign note" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sign note" }).click();
  await expect(page.getByTestId("note-signed")).toContainText("This telehealth visit note is frozen");
  await expect(page.getByTestId("signed-practitioner-notes")).toHaveText("Agree with the summary. Continue protocol.");
  await expect(page.getByText("Edited summary.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign note" })).toHaveCount(0);

  // Reload: the signed state comes from the record, not from this tab.
  await page.reload();
  await expect(page.getByTestId("note-signed")).toBeVisible();
  await expect(page.getByText("Prior revisions", { exact: true })).toBeVisible();
  await expect(page.getByText(/Revision 1 · not reviewed/)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Repeat ferritin" })).toContainText("approved");
  await expect(page.getByRole("listitem").filter({ hasText: "sleep log" })).toContainText("dismissed");
  await page.goto(`/telehealth?date=${DATE}`);
  await expect(page.getByTestId("telehealth-row").first()).toContainText("Note signed");
  await expect(page.getByRole("link", { name: "View note" })).toBeVisible();
});

test("authorization loss during a failed transfer's recovery read removes the opened signed note", async ({ page }) => {
  await page.goto(`/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  await expect(page.getByTestId("signed-practitioner-notes")).toHaveText("Agree with the summary. Continue protocol.");
  await page.route("**/api/live/telehealth/note/transfer", route => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Fictional transfer unavailable." } }),
  }));
  await page.route("**/api/live/telehealth/note?*", route => route.fulfill({
    status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden", message: "You don't have access to this record." } }),
  }));
  await page.getByTestId("note-transfer").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Place in chart" }).click();
  await expect(page.getByText("You don't have access to this record.")).toBeVisible();
  await expect(page.getByTestId("signed-practitioner-notes")).toHaveCount(0);
  await expect(page.getByText("Edited summary.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Repeat ferritin in 8 weeks", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("note-chart-transfer")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.unroute("**/api/live/telehealth/note?*");
  await page.unroute("**/api/live/telehealth/note/transfer");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByTestId("signed-practitioner-notes")).toHaveText("Agree with the summary. Continue protocol.");
  await expect(page.getByTestId("note-chart-transfer")).toHaveAttribute("data-transfer-state", "none");
});

test("placing the signed note in the chart creates one unsigned draft, links it, reaches the timeline, and a lost completion is reconciled without a second note", async ({ page, request }) => {
  await page.goto(`/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  await expect(page.getByTestId("note-signed")).toBeVisible();
  const card = page.getByTestId("note-chart-transfer");
  await expect(card).toHaveAttribute("data-transfer-state", "none");
  await expect(card).toContainText("Not in the chart yet");

  // The completion read is lost once: the chart write lands, the desktop never hears it.
  await request.post(`${STUB_BASE}/__control/telehealth-lose-completion`);
  await page.getByTestId("note-transfer").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("UNSIGNED chart draft");
  await dialog.getByRole("button", { name: "Place in chart" }).click();
  await expect(page.getByTestId("note-transfer-error")).toBeVisible();
  // The true state, from the chart's own authority: the draft exists at the chart, but the visit record never
  // received the confirmation. Inspect records the chart's receipt; nothing is written to the chart again.
  await expect(card).toHaveAttribute("data-transfer-state", "unreconciled");
  await expect(card).toContainText("Receipt not yet recorded on the visit");
  await expect(page.getByTestId("note-transfer")).toHaveCount(0);
  await page.getByTestId("note-transfer-inspect").click();
  await expect(card).toHaveAttribute("data-transfer-state", "completed");
  await expect(card).not.toContainText("Receipt not yet recorded");
  await expect(card).toContainText("Placed in the chart");
  await expect(card).toContainText("chart note draft");
  await expect(page.getByTestId("note-transfer")).toHaveCount(0);
  const link = page.getByTestId("note-chart-link");
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/patients\/[^/]+\/encounter\/[^/]+$/);

  // Reload: the chart state comes from the records, and the action is gone for good.
  await page.reload();
  await expect(page.getByTestId("note-chart-transfer")).toHaveAttribute("data-transfer-state", "completed");
  await expect(page.getByTestId("note-transfer")).toHaveCount(0);
  await expect(page.getByTestId("note-chart-link")).toHaveAttribute("href", href as string);

  // The chart's own view: exactly one draft note on the telehealth encounter, unsigned, with the reviewed text and provenance.
  await page.goto(href as string);
  await expect(page.getByTestId("encounter-workspace")).toBeVisible();
  await expect(page.getByTestId("encounter-status")).toContainText(/in progress/i);
  // Exactly one note on the encounter: a narrative DRAFT (v1), never a signed one.
  await expect(page.getByRole("button", { name: /Narrative draft · v1/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /signed/i })).toHaveCount(0);
  await page.getByRole("button", { name: /Narrative draft · v1/ }).click();
  const narrative = page.getByLabel("Narrative");
  await expect(narrative).toHaveValue(/## Telehealth visit — AI Companion summary \(reviewed\)\nEdited summary\./);
  await expect(narrative).toHaveValue(/## Practitioner notes\nAgree with the summary\. Continue protocol\./);
  await expect(narrative).toHaveValue(/- Repeat ferritin in 8 weeks \(approved\)/);
  await expect(narrative).toHaveValue(/Transferred UNSIGNED for chart review/);
  await expect(page.getByText(/Zoom AI Companion summary, reviewed in telehealth visit record revision 2/).first()).toBeVisible();
  // The chart's own signature control is present and untouched: the visit signature did not sign the chart.
  await expect(page.getByRole("button", { name: "Sign note" })).toBeVisible();
  // The patient timeline carries the draft through the chart's own events.
  const patientId = (href as string).split("/")[2];
  await page.goto(`/patients/${patientId}/chart`);
  const timeline = page.getByTestId("timeline-list");
  await expect(timeline).toContainText("Encounter started (telehealth)");
  await expect(timeline).toContainText("Draft note created (narrative)");
  await expect(timeline.getByText("Draft note created (narrative)")).toHaveCount(1);

  // Keyboard: the chart link is reachable and activatable without a pointer.
  await page.goto(`/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  await page.getByTestId("note-chart-link").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("encounter-workspace")).toBeVisible();
});

test("a late admitted start after navigation never loads an SDK or reconnects the departed screen", async ({ page }) => {
  await resetBackend();
  await page.goto(`/telehealth?date=${DATE}`);
  await page.getByRole("button", { name: "Record consent" }).click();
  const dialog = page.getByRole("dialog", { name: "Record telehealth consent" });
  await expect(dialog.getByTestId("consent-artifact")).toContainText("version telehealth-recording/1");
  await dialog.getByLabel("Patient's full name (as they stated it)").fill("Fixture Patient");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Record consent" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("link", { name: "Start visit" }).click();
  await expect(page.getByRole("button", { name: "Start visit" })).toBeVisible();
  let sdkRequests = 0;
  await page.route("https://source.zoom.us/**", route => { sdkRequests += 1; return route.abort(); });
  let admit!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let delivered!: () => void;
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  await page.route("**/api/live/telehealth/start", async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200); // A real local contract response, not a fabricated session.
    admit();
    await released;
    await route.fulfill({ response });
    delivered();
  });
  await page.getByRole("button", { name: "Start visit" }).click();
  await admitted;
  await page.getByRole("link", { name: "Telehealth", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Telehealth", exact: true })).toBeVisible();
  release();
  await delivery;
  // Drain two render turns after delivery, not a time-based assertion before the response.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(sdkRequests).toBe(0);
  await expect(page.getByTestId("zoom-stage")).toHaveCount(0);
  await expect(page.getByLabel("Quick notes")).toHaveCount(0);
  // Navigation does not claim end-for-all; the admitted visit remains on the fictional server.
  await page.goto(`/telehealth?date=${DATE}`);
  await expect(page.getByTestId("telehealth-row").first()).toContainText("In visit");
});
