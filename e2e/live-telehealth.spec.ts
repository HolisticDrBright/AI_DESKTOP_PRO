import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

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
    data: {
      appointmentId: APPOINTMENT, start: "2026-10-11T18:00:00.000Z", end: "2026-10-11T18:30:00.000Z",
      timeZone: "America/Los_Angeles", hostDisplayName: "Demo Practitioner",
    },
  });
  expect(res.status()).toBe(409);
  const body = (await res.json()) as { error?: { message?: string } };
  expect(body.error?.message).toMatch(/no signed telehealth consent/i);
});

test("recording consent unlocks the visit; ending it stores quick notes and opens the note", async ({ page }) => {
  await page.goto(`/telehealth?date=${DATE}`);
  await page.getByRole("button", { name: "Record consent" }).click();
  const dialog = page.getByRole("dialog", { name: "Record telehealth consent" });
  await expect(dialog).toBeVisible();
  // Refused until both the typed name and the attestation are present.
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
  await expect(page.getByRole("button", { name: "End visit" })).toBeEnabled();
  await page.getByLabel("Quick notes").fill("Patient reports better afternoons.");
  await page.getByRole("button", { name: "Flag this moment" }).click();
  await expect(page.getByRole("list", { name: "Flagged moments" }).locator("li")).toHaveCount(1);

  await page.getByRole("button", { name: "End visit" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "End visit" }).click();
  await page.waitForURL(`**/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  await expect(page.getByText("Visit ended · note pending")).toBeVisible();

  // Persisted on the visit record, not in this tab: a fresh load still carries them.
  await page.goto(`/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  await page.getByRole("button", { name: "Paste my quick notes from the call" }).click();
  await expect(page.getByLabel("Practitioner notes")).toHaveValue("Patient reports better afternoons.");
  await expect(page.getByText(/Flagged at/)).toBeVisible();
});

test("AI Companion notes import as not reviewed and one signature freezes the note", async ({ page }) => {
  await page.goto(`/telehealth/visit/${APPOINTMENT}/note?date=${DATE}`);
  await page.getByRole("button", { name: "Import AI Companion notes" }).click();
  await expect(page.getByText("Not reviewed", { exact: true })).toBeVisible();
  await expect(page.getByLabel("What the patient reported")).toHaveValue(/Afternoon fatigue has eased/);
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
  await expect(page.getByTestId("note-signed")).toContainText("This note is frozen");
  await expect(page.getByTestId("signed-practitioner-notes")).toHaveText("Agree with the summary. Continue protocol.");
  await expect(page.getByText("Edited summary.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign note" })).toHaveCount(0);

  // Reload: the signed state comes from the record, not from this tab.
  await page.reload();
  await expect(page.getByTestId("note-signed")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Repeat ferritin" })).toContainText("approved");
  await expect(page.getByRole("listitem").filter({ hasText: "sleep log" })).toContainText("dismissed");
  await page.goto(`/telehealth?date=${DATE}`);
  await expect(page.getByTestId("telehealth-row").first()).toContainText("Note signed");
  await expect(page.getByRole("link", { name: "View note" })).toBeVisible();
});
