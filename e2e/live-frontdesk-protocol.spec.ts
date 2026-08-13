import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * PHASE 2 VERTICAL SLICES, browser-level: front-desk scheduling and versioned
 * protocols, against the committed contract fixture backend.
 *
 * The fourteen proofs this suite carries (numbered as in the phase brief):
 *
 *   1. an appointment moves scheduled/confirmed → arrived → in room →
 *      completed, and each button appears only where the transition is legal
 *   2. an illegal transition is not offered once the appointment is settled
 *   3. a repeated click does not double-apply (idempotency replay)
 *   4. a stale version surfaces as a conflict, not a silent overwrite
 *   5. status changes survive a reload — they are persisted, not local state
 *   6. rescheduling is a separate action from a status change
 *   7. Today shows real appointment statuses, and names the aggregations that
 *      are still not configured instead of inventing them
 *   8. a patient with no protocol shows an honest empty state
 *   9. a blank draft can be created, edited, and autosaves with a visible
 *      saved state
 *  10. a product carries its exact catalog identity from the picker, and an
 *      affiliate link is labelled as commercial metadata only
 *  11. an unverified/label-only product reads "Interaction review not
 *      completed" and never claims to be interaction-free
 *  12. approve then activate are separate, confirmed steps, and activation says
 *      what it does NOT do
 *  13. an approved/active version is immutable — correcting it creates a new
 *      draft version and the history keeps both
 *  14. a draft can be saved as an org template, and no fixture-dataset
 *      identity from the demo edition ever appears
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-frontdesk-protocol.spec.ts
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

/**
 * Isolation, not ordering. This restores the whole fixture backend so the
 * suite runs against exactly the state it was written for, wherever it lands
 * in the battery.
 */
test.beforeAll(resetBackend);

const PATIENT = "aaaaaaaa-1111-2222-3333-444444444401";
/** Identities that exist only in the demo edition's fixture dataset. */
const DEMO_FIXTURE_NAMES = ["Alexandra Morgan", "Michael Johnson", "Priya Sharma"];

/** Open the week grid and select the seeded confirmed appointment. */
async function openApptDrawer(page: import("@playwright/test").Page) {
  await page.goto("/calendar");
  const appt = page.getByRole("button", { name: /Frontdesk Walkthrough/ }).first();
  await expect(appt).toBeVisible();
  await appt.click();
  await expect(page.getByRole("dialog", { name: "Appointment details" })).toBeVisible();
}

// ============================================================ front desk

test("1+2+6: the drawer offers only the transitions the database would accept", async ({ page }) => {
  await openApptDrawer(page);

  // Confirmed: arrive / reschedule / no-show / cancel are legal. Completing is
  // not — the machine requires arrival first.
  await expect(page.getByTestId("appt-arrive")).toBeVisible();
  await expect(page.getByTestId("appt-reschedule")).toBeVisible();
  await expect(page.getByTestId("appt-no-show")).toBeVisible();
  await expect(page.getByTestId("appt-cancel")).toBeVisible();
  await expect(page.getByTestId("appt-complete")).toHaveCount(0);
  // Opening the encounter is legal here: start_encounter accepts scheduled /
  // confirmed / arrived and performs the transition itself.
  await expect(page.getByRole("button", { name: "Open encounter" })).toBeVisible();

  // 6: rescheduling is its OWN form with its own save — moving a visit in time
  // is not a status change, and it shares no button with the machine above.
  await page.getByTestId("appt-reschedule").click();
  await expect(page.getByLabel("Reschedule date")).toBeVisible();
  await expect(page.getByLabel("Reschedule start time")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save new time" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // Arrive → the drawer re-derives: completing is now legal, arriving is not.
  await page.getByTestId("appt-arrive").click();
  await expect(page.getByRole("status").first()).toContainText(/Arrived/i);

  await openApptDrawer(page);
  await expect(page.getByText("Arrived").first()).toBeVisible();
  await expect(page.getByTestId("appt-complete")).toBeVisible();
  await expect(page.getByTestId("appt-arrive")).toHaveCount(0);
  // Rescheduling a patient who has already arrived is not a status change and
  // is no longer offered.
  await expect(page.getByTestId("appt-reschedule")).toHaveCount(0);

  await page.getByTestId("appt-complete").click();
  await expect(page.getByRole("status").first()).toContainText(/Completed/i);

  // Settled: NO transition button is offered, and the screen says plainly that
  // changing it requires an administrator correction with a reason.
  await openApptDrawer(page);
  await expect(page.getByTestId("appt-arrive")).toHaveCount(0);
  await expect(page.getByTestId("appt-complete")).toHaveCount(0);
  await expect(page.getByTestId("appt-cancel")).toHaveCount(0);
  await expect(page.getByTestId("appt-no-show")).toHaveCount(0);
  // Nor is the encounter entry point offered on a settled appointment.
  await expect(page.getByRole("button", { name: "Open encounter" })).toHaveCount(0);
  await expect(page.getByText(/requires an administrator correction/i)).toBeVisible();
});

test("5: the completed status survives a reload — it is persisted, not local", async ({ page }) => {
  await page.goto("/calendar");
  await page.reload();
  await openApptDrawer(page);
  await expect(page.getByText("Completed").first()).toBeVisible();
});

test("3: a replayed transition is reported as already applied, not applied twice", async ({
  page,
  request,
}) => {
  // Drive the API directly: a UI double-click is debounced by `working`, so the
  // idempotency contract is proved at the boundary that actually enforces it.
  const appointmentId = "abababab-1111-2222-3333-444444444402";
  const body = {
    appointmentId,
    toStatus: "arrived",
    expectedVersion: 1,
    idempotencyKey: `${appointmentId}:arrived:1`,
  };
  const first = await request.post("/api/live/schedule/transition", { data: body });
  expect(first.ok()).toBeTruthy();
  const firstBody = await first.json();
  expect(firstBody.data.already_applied).toBe(false);
  expect(firstBody.data.status).toBe("arrived");

  // The replay returns the STORED outcome instead of transitioning again, and
  // leaves the version where the first call left it.
  const replay = await request.post("/api/live/schedule/transition", { data: body });
  expect(replay.ok()).toBeTruthy();
  const replayBody = await replay.json();
  expect(replayBody.data.already_applied).toBe(true);
  expect(replayBody.data.version).toBe(firstBody.data.version);

  // And the record moved exactly once: the drawer reads the persisted status.
  await page.goto("/calendar");
  await page.getByRole("button", { name: /Admin block/ }).first().click();
  await expect(page.getByRole("dialog", { name: "Appointment details" })).toBeVisible();
  await expect(page.getByText("Arrived").first()).toBeVisible();
});

test("4: a stale version is refused as a conflict rather than overwriting", async ({ request }) => {
  const stale = await request.post("/api/live/schedule/transition", {
    data: {
      appointmentId: "abababab-1111-2222-3333-444444444402",
      toStatus: "completed",
      expectedVersion: 1, // already bumped by the transition above
      idempotencyKey: "stale-attempt",
    },
  });
  expect(stale.status()).toBe(409);
  expect(await stale.text()).toMatch(/changed/i);
});

test("7: Today shows real appointment statuses and names what is not configured", async ({
  page,
}) => {
  await page.goto("/today");
  await expect(page.getByTestId("today-schedule")).toBeVisible();

  // Real, or honestly empty — never a template day.
  const rows = page.getByTestId("today-appointment");
  const empty = page.getByTestId("today-schedule-empty");
  expect((await rows.count()) > 0 || (await empty.count()) > 0).toBeTruthy();

  // The domains with no live backend are NAMED as not configured. No count is
  // shown for them, and no morning brief is invented. (Unread patient
  // messages moved OUT of this list in phase 4 — the inbox card below shows
  // counts of persisted rows instead.)
  await expect(page.getByText(/not configured/i).first()).toBeVisible();
  await expect(page.getByText(/Notes awaiting signature/i)).toBeVisible();
  await expect(page.getByTestId("today-inbox")).toBeVisible();

  for (const name of DEMO_FIXTURE_NAMES) {
    await expect(page.getByText(name, { exact: false })).toHaveCount(0);
  }
});

// ============================================================== protocols

test("8: a patient with no protocol shows an honest empty state", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/protocol`);
  await expect(page.getByTestId("protocol-workspace")).toBeVisible();
  await expect(page.getByTestId("protocol-empty")).toContainText(/no protocol on file/i);
  // Nothing is synthesized to fill the screen.
  await expect(page.getByTestId("protocol-history-empty")).toBeVisible();
  await expect(page.getByTestId("frozen-item")).toHaveCount(0);
});

test("9+10+11: a draft persists with exact product identity and honest interaction state", async ({
  page,
}) => {
  await page.goto(`/patients/${PATIENT}/protocol`);
  await page.getByTestId("protocol-new-title").fill("Metabolic reset");
  await page.getByTestId("protocol-create-blank").click();

  await expect(page.getByTestId("pd-title")).toBeVisible();
  await expect(page.getByTestId("protocol-title")).toContainText("Metabolic reset");

  // 9: a named phase with relative timing, and a visible saved state.
  await page.getByTestId("pd-add-phase").click();
  await page.getByTestId("pd-phase-name-0").fill("Phase 1 — Repletion");
  await page.getByTestId("pd-monitoring").fill("Recheck fasting insulin at 8 weeks");
  await expect(page.getByTestId("pd-save-state")).toHaveAttribute("data-state", "saved", {
    timeout: 10_000,
  });

  // 10: the catalog picker fills exact identity — the practitioner does not
  // type a manufacturer from memory.
  await page.getByTestId("pd-add-product").click();
  await page.getByTestId("pd-catalog-q-0").fill("Fixture Magnesium");
  await page.getByTestId("pd-catalog-search-0").click();
  await page.getByTestId("pd-catalog-pick-88888888-1111-2222-3333-000000000002").click();

  const identity = page.getByTestId("pd-product-identity-0");
  await expect(identity).toContainText("88888888-1111-2222-3333-000000000002");
  await expect(identity).toContainText("Fixture Label Only Labs");
  await expect(identity).toContainText("LBL-2026-B");

  await page.getByTestId("pd-dosage-0").fill("200 mg");
  await page.getByTestId("pd-timing-0").fill("evening");
  await page.getByTestId("pd-route-0").fill("oral");
  await page
    .getByTestId("pd-affiliate-0")
    .fill("https://example.test/affiliate/fixture-magnesium");

  // An affiliate link is labelled as commercial metadata carrying no clinical
  // meaning — it is never presented as evidence or eligibility.
  await expect(
    page.getByText(/establishes no clinical eligibility, evidence, dosage, or safety/i),
  ).toBeVisible();

  await expect(page.getByTestId("pd-save-state")).toHaveAttribute("data-state", "saved", {
    timeout: 10_000,
  });

  // 11: the honest default. A label-only product cannot support a deterministic
  // check, and the screen says so instead of claiming there are no interactions.
  await expect(page.getByTestId("pd-interaction-status-0")).toHaveText(
    "Interaction review not completed",
  );
  await page.getByTestId("pd-run-check-0").click();
  await expect(page.getByTestId("pd-interactions-0")).toContainText(
    /no structured ingredient data in the catalog/i,
  );
  await expect(page.getByTestId("pd-interactions-0")).toContainText(
    /not a determination that a product is interaction-free/i,
  );
  await expect(page.getByText(/no interactions found/i)).toHaveCount(0);

  // The saved draft survives a reload with its exact stored identity.
  await page.reload();
  await expect(page.getByTestId("pd-title")).toHaveValue("Metabolic reset");
  await expect(page.getByTestId("pd-monitoring")).toHaveValue(
    "Recheck fasting insulin at 8 weeks",
  );
  await expect(page.getByTestId("pd-product-identity-0")).toContainText("LBL-2026-B");
});

test("12: approve and activate are separate, confirmed steps", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/protocol`);

  await page.getByTestId("pd-open-approve").click();
  // Approving states what it does and does not do.
  await expect(page.getByText(/Approving .*freezes this version/i)).toBeVisible();
  await expect(page.getByText(/does not.*activate the protocol/i)).toBeVisible();
  await page.getByTestId("pd-review-note").fill("Reviewed against current labs.");
  await page.getByTestId("pd-approve").click();

  // Approved but NOT active: the draft editor is gone, the frozen version is
  // shown, and activation is a separate action in the history.
  await expect(page.getByText(/Approved version \(not active\)/i)).toBeVisible();
  await expect(page.getByTestId("pd-title")).toHaveCount(0);

  await page.getByTestId("protocol-activate-1").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(/does NOT send instructions to the patient/i);
  await expect(dialog).toContainText(/place a lab or supplement order/i);
  await expect(dialog).toContainText(/charge anything/i);
  await expect(dialog).toContainText(/modify medications/i);
  await expect(dialog).toContainText(/write into a note/i);
  await page.getByRole("button", { name: "Activate version" }).click();

  await expect(page.getByText("Active version — v1")).toBeVisible();
  await expect(page.getByTestId("protocol-status")).toHaveText("active");
});

test("13: an active version is immutable — a correction creates a new version", async ({
  page,
}) => {
  await page.goto(`/patients/${PATIENT}/protocol`);

  // The active version is displayed read-only, and says why.
  await expect(page.getByText(/Correcting.*creates a new draft version/i)).toBeVisible();
  await expect(page.getByTestId("pd-title")).toHaveCount(0);

  await page.getByTestId("protocol-revise-1").click();

  // A NEW draft v2 exists; v1 is still in the history, unchanged and active.
  await expect(page.getByTestId("pd-version-heading")).toHaveText("Draft version 2");
  const v1 = page.getByTestId("protocol-history-row").filter({ hasText: "v1" });
  await expect(v1).toHaveAttribute("data-status", "active");
  await expect(page.getByTestId("protocol-history-row")).toHaveCount(2);

  // Editing the new draft leaves v1's instructions alone.
  await page.getByTestId("pd-monitoring").fill("Recheck fasting insulin at 12 weeks");
  await expect(page.getByTestId("pd-save-state")).toHaveAttribute("data-state", "saved", {
    timeout: 10_000,
  });
  await expect(page.getByText("Recheck fasting insulin at 8 weeks")).toBeVisible();

  // A copied product item requires its OWN interaction review.
  await expect(page.getByTestId("pd-interaction-status-0")).toHaveText(
    "Interaction review not completed",
  );
});

test("14: a draft saves as an org template, and no demo fixture identity appears", async ({
  page,
}) => {
  await page.goto(`/patients/${PATIENT}/protocol`);
  await page.getByTestId("tpl-name").fill("Metabolic reset — org template");
  await page.getByTestId("tpl-description").fill("Starting point for metabolic cases");
  await page.getByTestId("tpl-create").click();
  await expect(page.getByRole("status").first()).toContainText(/[Tt]emplate/);

  // The copy is detached: it does not claim to be linked back to this patient.
  await expect(page.getByText(/The copy is detached/i)).toBeVisible();

  for (const name of DEMO_FIXTURE_NAMES) {
    await expect(page.getByText(name, { exact: false })).toHaveCount(0);
  }
});
