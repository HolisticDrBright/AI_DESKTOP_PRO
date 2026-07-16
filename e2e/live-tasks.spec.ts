import { expect, test } from "@playwright/test";

/**
 * LIVE-MODE Tasks slice coverage. Skipped unless E2E_LIVE=1, because it needs
 * a live-flag build plus a reachable backend speaking the clinical.* contract
 * (the deployed tRPC backend, or the committed contract fixture).
 *
 * Full recipe (from the repo root):
 *   node scripts/live-stub-server.mjs &          # or a real backend
 *   NEXT_PUBLIC_USE_LIVE_API=true npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-tasks.spec.ts
 *
 * NOTE: the fixture backend is stateful in-memory — restart it between runs.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a live-flag build + backend");

test.describe.configure({ mode: "serial" });

test("root enters the real workspace: directory → patient → labs (no mock patient)", async ({ page }) => {
  // A root 404 (or a redirect to the synthetic demo patient) must FAIL here.
  const res = await page.goto("/");
  expect(res!.status()).toBe(200);
  await page.waitForURL("**/clients");
  expect(page.url()).not.toContain("p-78435");
  await expect(page.getByText("live record, scoped to your access")).toBeVisible();

  // Real directory row → real patient shell (header from patient_profiles).
  await page.getByRole("link", { name: "Fixture Patient" }).click();
  await page.waitForURL("**/patients/aaaaaaaa-1111-2222-3333-444444444401/summary");
  await expect(page.getByText("Fixture Patient").first()).toBeVisible();
  await expect(page.getByText(/Summary panels aren't live yet/)).toBeVisible();

  // Straight into the live labs workspace for the same real patient.
  await page.getByRole("link", { name: "Open live labs" }).click();
  await expect(page.getByRole("button", { name: "Select hs-CRP" })).toBeVisible();
});

test("live queue loads and shows the live boundary copy", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByText(/Live queue — resolving updates the record/)).toBeVisible();
  await expect(page.getByText("Recheck hs-CRP after abnormal result")).toBeVisible();
  // A row resolved in the BACKEND (not this session) still reads settled —
  // live rows show record state ("Resolved"), not "this session".
  await expect(page.getByText("Resolved", { exact: true }).first()).toBeVisible();
});

test("resolve persists across reload and lands in the live audit log", async ({ page }) => {
  await page.goto("/tasks");
  const row = page.getByText("Verify extracted markers from uploaded panel");
  await expect(row).toBeVisible();

  await page
    .getByRole("button", { name: /^Resolve — extraction review/ })
    .first()
    .click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText(/saved to record \+ audit/).first()).toBeVisible();

  // Fresh page load: state must come from the backend row, not sessionStorage.
  await page.goto("/tasks");
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  await expect(page.getByText("Verify extracted markers from uploaded panel")).toBeVisible();
  await expect(page.getByText("Resolved", { exact: true }).first()).toBeVisible();

  // Live audit log shows the persisted event, and survives its own reload.
  await page.goto("/audit-log");
  await expect(page.getByText("Live · append-only")).toBeVisible();
  await expect(page.getByText("review_task.resolve").first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("review_task.resolve").first()).toBeVisible();
});

test("live labs workspace loads markers and a review persists across reload", async ({ page }) => {
  await page.goto("/patients/aaaaaaaa-1111-2222-3333-444444444401/labs");

  // Markers come from the fixture backend's clinical.labs.getWorkspace.
  await page.getByRole("button", { name: "Select hs-CRP" }).waitFor();
  await expect(page.getByRole("button", { name: "Select TSH" })).toBeVisible();

  // P0 status/confidence integrity: an unflagged marker reads UNCLASSIFIED
  // (never "normal"), and missing confidence reads "Not provided" (never 50%).
  await page.getByRole("button", { name: "Select Sodium" }).click();
  const inspector = page.locator("section").getByText("Sodium").first();
  await inspector.waitFor();
  await expect(page.getByText("Unclassified").first()).toBeVisible();
  await expect(page.getByText("Not provided").first()).toBeVisible();
  await expect(page.getByText(/confidence was not recorded/i).first()).toBeVisible();

  // P0 persisted review state, inspector-level: TSH is reviewed IN THE RECORD —
  // the action must be settled (disabled) even in a fresh session.
  await page.getByRole("button", { name: "Select TSH" }).click();
  const reviewedBtn = page.getByRole("button", { name: "Reviewed", exact: true });
  await expect(reviewedBtn).toBeVisible();
  await expect(reviewedBtn).toBeDisabled();

  // True-source provenance: the inspector links the ACTUAL stored document.
  await expect(page.getByRole("link", { name: /Open source PDF/ })).toBeVisible();
  const doc = await page.request.get(
    "/api/live/labs/document/ffffffff-1111-2222-3333-444444444401",
  );
  expect(doc.status()).toBe(200);
  expect((await doc.text()).startsWith("%PDF")).toBe(true);

  // Review the high-confidence marker (no confirm dialog on this path).
  await page.getByRole("button", { name: "Select hs-CRP" }).click();
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(page.getByText(/Marked reviewed: hs-CRP.*saved to record/).first()).toBeVisible();

  // Fresh load with session state cleared: reviewed state must come from the
  // BACKEND marker row (reviewState), not this browser session.
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  const row = page.locator("tr", { hasText: "hs-CRP" });
  await expect(row.getByText("Reviewed", { exact: true })).toBeVisible();

  // The review landed in the live audit trail.
  await page.goto("/audit-log");
  await expect(page.getByText("biomarker.review").first()).toBeVisible();
});

test("uploading a lab PDF extracts markers and queues a low-confidence review", async ({ page }) => {
  await page.goto("/patients/aaaaaaaa-1111-2222-3333-444444444401/labs");
  await page.getByRole("button", { name: "Upload lab" }).click();

  await page.getByLabel("Lab report PDF").setInputFiles({
    name: "panel.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 fixture panel"),
  });
  await page.getByRole("button", { name: "Upload & extract" }).click();

  // Honest result panel, then the refreshed workspace shows the new markers.
  await expect(page.getByText("2 markers extracted")).toBeVisible();
  await page.getByRole("button", { name: "View extracted markers" }).click();
  await expect(page.getByRole("button", { name: "Select Glucose" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select Osmolality" })).toBeVisible();

  // The low-confidence extraction landed in the live review queue…
  await page.goto("/tasks");
  await expect(page.getByText("Verify 1 low-confidence marker from uploaded panel")).toBeVisible();

  // …and the ingestion event is in the live audit trail.
  await page.goto("/audit-log");
  await expect(page.getByText("lab_document.ingest").first()).toBeVisible();
});

test("live calendar shows real appointments and check-in persists with audit", async ({ page }) => {
  await page.goto("/calendar");
  const block = page.getByRole("button", { name: /Fixture Patient/ }).first();
  await block.waitFor();
  await block.click();
  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText(/Appointment arrived/).first()).toBeVisible();

  // Fresh load: the status must come from the backend record, not UI state.
  await page.reload();
  await page.getByRole("button", { name: /Fixture Patient/ }).first().click();
  await expect(
    page.getByRole("dialog", { name: "Appointment details" }).getByText("In progress"),
  ).toBeVisible();

  await page.goto("/audit-log");
  await expect(page.getByText("appointment.status").first()).toBeVisible();
});

test("booking a new appointment persists to the live week", async ({ page }) => {
  await page.goto("/calendar");
  await page.getByRole("button", { name: "New" }).click();
  const dialog = page.getByRole("dialog", { name: "New appointment" });
  await dialog.getByLabel("Patient").selectOption({ label: "Sample Client" });
  await dialog.getByLabel("Start time").fill("20:00");
  await dialog.getByLabel("Location").fill("Room 3");
  await dialog.getByRole("button", { name: "Book appointment" }).click();

  // The booked block renders from the refetched week…
  await expect(page.getByRole("button", { name: /Sample Client/ }).first()).toBeVisible();
  // …and survives a reload (the record, not local state).
  await page.reload();
  await expect(page.getByRole("button", { name: /Sample Client/ }).first()).toBeVisible();

  await page.goto("/audit-log");
  await expect(page.getByText("appointment.book").first()).toBeVisible();
});

const BASE = `http://localhost:${Number(process.env.E2E_PORT ?? 3114)}`;

test("expired access token refreshes globally with rotation (P0 auth lifecycle)", async ({ page, context }) => {
  await context.clearCookies();
  await context.addCookies([
    { name: "aidp_at", value: "deliberately-expired-token", url: BASE },
    { name: "aidp_rt", value: "fixture-refresh-token", url: BASE },
    { name: "aidp_exp", value: String(Date.now() - 60_000), url: BASE },
    { name: "aidp_em", value: "practitioner@fixture.local", url: BASE },
  ]);
  // Any app page — NOT the login screen — must recover the session.
  await page.goto("/tasks");
  await expect(page.getByText(/Live queue — resolving updates the record/)).toBeVisible();
  const session = await page.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  expect(session?.data?.signedIn).toBe(true);
  const rotated = (await context.cookies(BASE)).find((c) => c.name === "aidp_at");
  expect(rotated?.value).toBe("fixture-access-token");
  await context.clearCookies();
});

test("revoked refresh token clears the session instead of looping", async ({ page, context }) => {
  await context.clearCookies();
  await context.addCookies([
    { name: "aidp_at", value: "deliberately-expired-token", url: BASE },
    { name: "aidp_rt", value: "revoked-refresh-token", url: BASE },
    { name: "aidp_exp", value: String(Date.now() - 60_000), url: BASE },
  ]);
  await page.goto("/tasks");
  // The e2e env fallback keeps the page working; the dead session is gone.
  await expect(page.getByText(/Live queue — resolving updates the record/)).toBeVisible();
  const session = await page.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  expect(session?.data?.signedIn).toBe(false);
  await context.clearCookies();
});

test("login honors a same-origin next= return path", async ({ page, context }) => {
  await context.clearCookies();
  await page.goto("/login?next=/tasks");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tasks");
  await expect(page.getByText(/Live queue — resolving updates the record/)).toBeVisible();
  await context.clearCookies();
});

test("password reset: enumeration-safe request + recovery-token completion", async ({ page, context }) => {
  await context.clearCookies();

  // Request from the sign-in screen — the confirmation never reveals whether
  // the account exists.
  await page.goto("/login");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByRole("button", { name: /Forgot password/ }).click();
  await expect(page.getByText(/If an account exists for that email/)).toBeVisible();

  // Complete via the emailed link's fragment token (fixture recovery token).
  await page.goto("/reset#access_token=recovery-token-fixture&type=recovery");
  await page.getByLabel("New password").fill("brand-new-password-1");
  await page.getByLabel("Confirm password").fill("brand-new-password-1");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText("Password updated")).toBeVisible();

  // A bad/expired token is rejected honestly. (Navigate away first — a
  // fragment-only change would not remount the page.)
  await page.goto("/login");
  await page.goto("/reset#access_token=expired-recovery-token&type=recovery");
  await page.getByLabel("New password").fill("brand-new-password-1");
  await page.getByLabel("Confirm password").fill("brand-new-password-1");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText(/invalid or has expired/)).toBeVisible();
  await context.clearCookies();
});

test("practitioner sign-in and sign-out work via httpOnly cookie session", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Redirects home on success; the session endpoint reflects the cookie session.
  await page.waitForURL("**/");
  const session = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  expect(session?.data?.signedIn).toBe(true);
  expect(session?.data?.email).toBe("practitioner@fixture.local");

  // P1: the practitioner's organization is auto-selected at sign-in from
  // their own memberships — no env-based org in the session path.
  expect(session?.data?.orgId).toBe("org-fixture");
  const org = await page.evaluate(() => fetch("/api/auth/org").then((r) => r.json()));
  expect(org?.data?.activeOrgId).toBe("org-fixture");
  expect(org?.data?.organizations?.[0]?.name).toBe("Fixture Clinic");

  await page.goto("/login");
  await expect(page.getByText(/Signed in as/)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const after = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  expect(after?.data?.signedIn).toBe(false);
});

test("org members: roster, invite, honest guards, confirmed removal (admin-gated)", async ({ page }) => {
  // Member management is a cookie-session surface — sign in first.
  await page.goto("/login");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/");

  await page.goto("/settings");
  const card = page.getByTestId("org-members-card");
  await expect(card.getByText("Organization members")).toBeVisible();

  // Roster: own row is labeled and offers no self-removal control.
  const selfRow = card.locator("li", { hasText: "practitioner@fixture.local" });
  await expect(selfRow.getByText("(you)")).toBeVisible();
  await expect(selfRow.getByRole("button", { name: "Remove" })).toHaveCount(0);
  const colleagueRow = card.locator("li", { hasText: "colleague@fixture.local" });
  await expect(colleagueRow).toBeVisible();

  // Invite a brand-new email → the stub's invite-email path; honest notice +
  // the roster shows the pending state truthfully.
  await card.getByLabel("Invite by email").fill("new-nurse@fixture.local");
  await card.getByLabel("Role for the invitee").selectOption("staff");
  await card.getByRole("button", { name: "Invite" }).click();
  await expect(card.getByText("Invitation email sent to new-nurse@fixture.local.")).toBeVisible();
  const nurseRow = card.locator("li", { hasText: "new-nurse@fixture.local" });
  await expect(nurseRow.getByText("Invited — hasn't signed in yet")).toBeVisible();

  // Duplicate invite → the server-owned guard message reaches the UI verbatim.
  await card.getByLabel("Invite by email").fill("colleague@fixture.local");
  await card.getByRole("button", { name: "Invite" }).click();
  await expect(
    card.getByText("That person is already a member of this organization."),
  ).toBeVisible();

  // Role change round-trips.
  await nurseRow.getByLabel("Role for new-nurse@fixture.local").selectOption("practitioner");
  await expect(card.getByText(/Role updated to practitioner/)).toBeVisible();

  // Removal is destructive → explicit confirmation, then the row is gone.
  await colleagueRow.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Remove member?")).toBeVisible();
  await page.getByRole("button", { name: "Remove member" }).click();
  await expect(card.getByText("colleague@fixture.local removed from the organization.")).toBeVisible();
  await expect(card.locator("li", { hasText: "colleague@fixture.local" })).toHaveCount(0);

  // Restore the signed-out baseline for the remaining tests.
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("org substitution: a forged organization id is refused and the session org is unchanged", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/");

  // The org id is browser input here — the server must validate it against
  // the caller's OWN memberships, not trust it.
  const attackStatus = await page.evaluate(() =>
    fetch("/api/auth/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "org-evil" }),
    }).then((r) => r.status),
  );
  expect(attackStatus).toBe(403);

  const session = await page.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  expect(session?.data?.orgId).toBe("org-fixture");
  const org = await page.evaluate(() => fetch("/api/auth/org").then((r) => r.json()));
  const ids = (org?.data?.organizations ?? []).map(
    (o: { organizationId: string }) => o.organizationId,
  );
  expect(ids).not.toContain("org-evil");

  await page.goto("/login");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a signed-in user with no active memberships gets honest states, never tenant data", async ({ page }) => {
  // Covers both no-membership and disabled/suspended membership — under RLS
  // a non-active membership simply vanishes from organizations.mine.
  await page.goto("/login");
  await page.getByLabel("Email").fill("no-orgs@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/");

  const session = await page.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  expect(session?.data?.signedIn).toBe(true);
  expect(session?.data?.orgId).toBeNull();

  // Org-scoped reads are refused server-side for non-members no matter what
  // org id the client (or env fallback) presents — honest state, no data.
  await page.goto("/tasks");
  await expect(page.getByText("You don't have access to this record.")).toBeVisible();
  await expect(page.getByText("Recheck hs-CRP after abnormal result")).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByText("No memberships found")).toBeVisible();

  await page.goto("/login");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("multi-org: auto-select, validated switch clears org data, tabs agree, mid-session revocation is honest", async ({ page, context }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dual-org@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/");

  // Safe default: exactly-one-or-first membership auto-selected at sign-in.
  const session = await page.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  expect(session?.data?.orgId).toBe("org-fixture");

  await page.goto("/tasks");
  await expect(page.getByText("Recheck hs-CRP after abnormal result")).toBeVisible();

  // Switch to the second practice (server re-validates membership); the
  // switcher reflects the new org after the authoritative reload.
  await page.goto("/settings");
  await page.getByLabel("Switch organization").selectOption("org-second");
  await expect(page.getByLabel("Switch organization")).toHaveValue("org-second", { timeout: 15_000 });

  // No org-A records leak into org B after the switch.
  await page.goto("/tasks");
  await expect(page.getByText("No items match your filters")).toBeVisible();
  await expect(page.getByText("Recheck hs-CRP after abnormal result")).toHaveCount(0);

  // A second tab agrees on the active organization (one authoritative cookie).
  const tab2 = await context.newPage();
  await tab2.goto("/login");
  const tabSession = await tab2.evaluate(() => fetch("/api/auth/session").then((r) => r.json()));
  expect(tabSession?.data?.orgId).toBe("org-second");
  await tab2.close();

  // Membership revoked while the app is open → the very next read is refused.
  await page.request.post("http://127.0.0.1:3999/__control/revoke-memberships", {
    data: { bearer: "fixture-access-token--multi" },
  });
  await page.goto("/tasks");
  await expect(page.getByText("You don't have access to this record.")).toBeVisible();
  await expect(page.getByText("Recheck hs-CRP after abnormal result")).toHaveCount(0);

  await page.goto("/login");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("EMR: appointment → encounter → autosaved draft → recovery → sign → locked → addendum → timeline → audit", async ({ page }) => {
  // 1–2. Open the appointment and start the encounter from it.
  await page.goto("/calendar");
  const block = page.getByRole("button", { name: /Fixture Patient/ }).first();
  await block.waitFor();
  await block.click();
  await page.getByRole("button", { name: "Open encounter" }).click();
  await page.waitForURL("**/encounter/**");
  const encounterUrl = page.url();
  await expect(page.getByTestId("encounter-status")).toHaveText("In progress");

  // 3. Create a SOAP draft; autosave must confirm from the SERVER before "Saved".
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByLabel("Subjective").fill("Fatigue for two weeks.");
  await expect(page.getByTestId("save-state")).toHaveText(/Saved .*v1/, { timeout: 10_000 });
  await page.getByLabel("Objective").fill("BP 118/76. HR 64.");
  await expect(page.getByTestId("save-state")).toHaveText(/v2/, { timeout: 10_000 });

  // 4. Reload → the AUTHORITATIVE draft is recovered from the backend.
  await page.reload();
  await page.getByRole("button", { name: /SOAP/ }).first().click();
  await expect(page.getByLabel("Subjective")).toHaveValue("Fatigue for two weeks.");
  await expect(page.getByLabel("Objective")).toHaveValue("BP 118/76. HR 64.");

  // 5. Ready for review.
  await page.getByRole("button", { name: "Ready for review" }).click();
  await expect(page.getByText("Marked ready for review.")).toBeVisible();

  // 6. Sign with explicit confirmation → locked read-only view.
  await page.getByRole("button", { name: "Sign note" }).click();
  await page.getByRole("button", { name: "Sign and lock" }).click();
  await expect(page.getByTestId("signature-line")).toContainText("Signed at v2");

  // 7. Editing the signed note is blocked: the editor is gone, content is
  //    read-only, and the immutability lives in the database (proven by the
  //    rolled-back suite) — not just hidden controls.
  await expect(page.getByLabel("Subjective")).toHaveCount(0);
  await expect(page.getByText("Fatigue for two weeks.")).toBeVisible();
  await expect(page.getByText("Signed content is locked.")).toBeVisible();

  // 8–9. Append-only correction; the original text stays untouched.
  await page.getByLabel("Reason").fill("BP transcription");
  await page.getByLabel("Correction").fill("BP was 128/76, not 118/76.");
  await page.getByRole("button", { name: "Record addendum" }).click();
  await expect(page.getByText("Addendum recorded. The original note is unchanged.")).toBeVisible();
  await expect(page.getByTestId("addenda-list").getByText("BP was 128/76, not 118/76.")).toBeVisible();
  await expect(page.getByText("BP 118/76. HR 64.")).toBeVisible(); // original untouched

  // 10. Timeline shows the clinical chain (never security-audit rows).
  await page.goto("/patients/aaaaaaaa-1111-2222-3333-444444444401/timeline");
  const timeline = page.getByTestId("timeline-list");
  await expect(timeline.getByText(/Encounter started/).first()).toBeVisible();
  await expect(timeline.getByText("Note signed").first()).toBeVisible();
  await expect(timeline.getByText("Addendum added").first()).toBeVisible();

  // 11 & 13. The audit log carries server-owned events — and exactly ONE
  //          "Note signed" row (duplicate signing cannot duplicate audits;
  //          idempotency itself is DB-proven).
  await page.goto("/audit-log");
  await expect(page.getByText("Encounter started").first()).toBeVisible();
  await expect(page.getByText("Note signed")).toHaveCount(1);

  // 12. A signed-in user outside the organization cannot open the encounter.
  await page.goto("/login");
  await page.getByLabel("Email").fill("no-orgs@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/");
  await page.goto(encounterUrl);
  await expect(page.getByText(/isn't available|not available|access denied/i).first()).toBeVisible();
  await expect(page.getByTestId("encounter-status")).toHaveCount(0);
  await expect(page.getByText("Fatigue for two weeks.")).toHaveCount(0);

  await page.goto("/login");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("no console errors in the live flow", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto("/tasks", { waitUntil: "networkidle" });
  await page.goto("/patients/aaaaaaaa-1111-2222-3333-444444444401/labs", { waitUntil: "networkidle" });
  await page.goto("/calendar", { waitUntil: "networkidle" });
  await page.goto("/patients/aaaaaaaa-1111-2222-3333-444444444401/timeline", { waitUntil: "networkidle" });
  await page.goto("/audit-log", { waitUntil: "networkidle" });
  await page.goto("/settings", { waitUntil: "networkidle" });
  expect(errors).toEqual([]);
});
