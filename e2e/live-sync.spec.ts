import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * PHASE 5, browser-level: the Patient Delivery & Synchronization Gateway
 * against the committed contract fixture backend. The __control endpoints
 * stand in for the future service_role sync worker + AI Longevity Pro side
 * (the "test provider") and exercise the SAME envelope, token, evidence,
 * idempotency, and conflict contracts as the database.
 *
 * The twenty proofs this suite carries:
 *
 *   1. honest unlinked + not-configured state (chart tab AND Integrations)
 *   2. a scoped connection invitation with a ONE-TIME code and honest
 *      no-delivery copy
 *   3. token scope, expiry, supersession, and single-use behavior through
 *      the test provider
 *   4. verifying a patient connection binds the external subject
 *   5. independent data scopes; research consent fully separate
 *   6. queueing FAILS CLOSED without a provider (durable refusal), then
 *      queues a real resource once the provider is registered
 *   7. no delivery claim without acknowledgment — queued means queued
 *   8. provider acknowledgment persists across reload; duplicate callbacks
 *      dedupe
 *   9. adherence/check-in data ingests idempotently
 *  10. inbound data displays with full provenance, as untrusted plain text
 *  11. revoking ONE scope stops only that scope
 *  12. pause holds both directions; revocation blocks everything and
 *      re-linking needs a new invitation
 *  13. retry and dead-letter handling (bounded backoff, reasoned manual
 *      retry, Integrations dead-letter queue)
 *  14. a version conflict resolves without overwriting originals;
 *      corrections are versioned overlays
 *  15. real Today/Inbox review work from failed and inbound events
 *  16. cross-tenant access is rejected without leaking data
 *  17. the AI summary is honestly not configured (never fabricated)
 *  18. no mock identity or fixture-demo content appears anywhere
 *  19. keyboard and screen-reader behavior (labels, status roles, focus)
 *  20. no PHI in console logs and no off-origin requests
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-sync.spec.ts
 *
 * NOTE: the fixture backend is stateful in-memory — restart it between runs.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

/**
 * Isolation, not ordering. This restores the whole fixture backend so the
 * suite runs against exactly the state it was written for, wherever it lands
 * in the battery.
 */
test.beforeAll(resetBackend);

const STUB = "http://127.0.0.1:3999";

// This suite is written against a pristine sync domain; reset it up front so
// the battery is order-independent (other suites may have exercised sync).
test.beforeAll(async () => {
  await fetch(`${STUB}/__control/sync-reset`, { method: "POST" });
});
const PATIENT_1 = "aaaaaaaa-1111-2222-3333-444444444401";
const SYNC_TAB = `/patients/${PATIENT_1}/app-sync`;
const DEMO_FIXTURE_NAMES = ["Alexandra Morgan", "Michael Johnson", "Priya Sharma"];

let token = "";
let withdrawalEventId = "";

test("1: honest unlinked + not-configured state", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-panel")).toBeVisible();
  await expect(page.getByTestId("sync-provider-note")).toContainText(
    "AI Longevity Pro connection not configured",
  );
  await expect(page.getByTestId("sync-state-unlinked")).toBeVisible();
  await expect(page.getByText("never matching by email, name, phone, or date of birth")).toBeVisible();
  await expect(page.getByTestId("sync-connect")).toBeVisible();

  await page.goto("/integrations");
  await expect(page.getByTestId("sync-ops-provider-state")).toHaveText("not configured");
  await expect(page.getByTestId("sync-ops-connected")).toHaveText("0");
  await expect(page.getByTestId("sync-ops-not-configured")).toContainText("no environment flag");
});

test("2: a scoped invitation with a ONE-TIME code and honest no-delivery copy", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-connect").click();
  await expect(page.getByTestId("sync-one-time-token")).toBeVisible();
  await expect(page.getByTestId("sync-one-time-token")).toContainText("shown ONCE");
  await expect(page.getByTestId("sync-one-time-token")).toContainText(
    "this code was not transmitted anywhere",
  );
  token = (await page.getByTestId("sync-token-value").textContent())?.trim() ?? "";
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  // The code is one-time: a reload shows only the invitation facts, never the code.
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-state-invitation_pending")).toBeVisible();
  await expect(page.getByTestId("sync-invitation-facts")).toContainText("expires");
  await expect(page.getByTestId("sync-one-time-token")).toHaveCount(0);
});

test("3: token expiry, supersession, and unknown-token refusal via the test provider", async ({ page }) => {
  // Unknown token.
  const unknown = await page.request.post(`${STUB}/__control/sync-verify`, {
    data: { token: "f".repeat(64), subject: "alp-e2e-subject" },
  });
  expect(unknown.status()).toBe(404);

  // A new invitation supersedes the previous token.
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-reinvite").click();
  await expect(page.getByTestId("sync-one-time-token")).toBeVisible();
  const token2 = (await page.getByTestId("sync-token-value").textContent())?.trim() ?? "";
  const superseded = await page.request.post(`${STUB}/__control/sync-verify`, {
    data: { token, subject: "alp-e2e-subject" },
  });
  expect(superseded.status()).toBe(400);
  expect(await superseded.text()).toContain("superseded");

  // Expiry.
  await page.request.post(`${STUB}/__control/sync-expire-invitation`, { data: { token: token2 } });
  const expired = await page.request.post(`${STUB}/__control/sync-verify`, {
    data: { token: token2, subject: "alp-e2e-subject" },
  });
  expect(expired.status()).toBe(400);
  expect(await expired.text()).toContain("expired");

  // Issue a live one for verification.
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-reinvite").click();
  await expect(page.getByTestId("sync-one-time-token")).toBeVisible();
  token = (await page.getByTestId("sync-token-value").textContent())?.trim() ?? "";
});

test("4: verification binds the external subject; the token is single-use", async ({ page }) => {
  const ok = await page.request.post(`${STUB}/__control/sync-verify`, {
    data: { token, subject: "alp-e2e-subject" },
  });
  expect(ok.ok()).toBeTruthy();
  const replay = await page.request.post(`${STUB}/__control/sync-verify`, {
    data: { token, subject: "alp-e2e-other" },
  });
  expect(replay.status()).toBe(400);
  expect(await replay.text()).toContain("already used");

  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-connection").getByTestId("sync-state-verified")).toBeVisible();
});

test("5: independent data scopes; research consent fully separate", async ({ page }) => {
  await page.goto(SYNC_TAB);
  for (const scope of ["lab_summaries", "symptoms_adherence", "appointments"]) {
    await page.getByTestId("sync-grant-scope").selectOption(scope);
    await page.getByTestId("sync-grant-submit").click();
    await expect(page.getByTestId(`sync-scope-granted-${scope}`)).toBeVisible();
  }
  // Research participation is consented entirely separately — untouched.
  await expect(page.getByTestId("sync-scope-off-research_n_of_1")).toHaveText("not granted");
  await expect(page.getByText("Research participation is consented entirely separately")).toBeVisible();
});

test("6: queueing FAILS CLOSED without a provider, then queues once registered", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-queue-type").selectOption("lab_summary");
  await page.getByTestId("sync-queue-submit").click();
  await expect(page.getByTestId("sync-queue-outcome")).toHaveText(
    "AI Longevity Pro connection not configured. Nothing was queued or sent.",
  );
  await expect(page.getByTestId("sync-state-queued")).toHaveCount(0);

  // Registering the provider mirrors the reviewed operational act.
  const reg = await page.request.post(`${STUB}/__control/sync-register-provider`, {
    data: { organizationId: "org-fixture" },
  });
  expect(reg.ok()).toBeTruthy();
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-queue-type").selectOption("lab_summary");
  await page.getByTestId("sync-queue-submit").click();
  await expect(page.getByTestId("sync-outbound").getByTestId("sync-state-queued")).toBeVisible();
});

test("7: no delivery claim without acknowledgment — queued means queued", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-outbound").getByTestId("sync-state-queued")).toBeVisible();
  await expect(page.getByTestId("sync-resource-list").getByTestId("sync-state-pending")).toBeVisible();
  await expect(page.getByText("A resource shows delivered or acknowledged ONLY after the provider")).toBeVisible();
  await expect(page.getByTestId("sync-state-delivered")).toHaveCount(0);
  await expect(page.getByTestId("sync-state-acknowledged")).toHaveCount(0);
});

test("8: acknowledgment persists across reload; duplicate callbacks dedupe", async ({ page }) => {
  await page.goto(SYNC_TAB);
  const testId = await page
    .locator('[data-testid^="sync-event-"]')
    .first()
    .getAttribute("data-testid");
  const eventId = testId!.replace("sync-event-", "");

  const delivered = await page.request.post(`${STUB}/__control/sync-deliver`, {
    data: { eventId, providerEventId: "pe-e2e-1", kind: "delivered" },
  });
  expect(delivered.ok()).toBeTruthy();
  const acked = await page.request.post(`${STUB}/__control/sync-deliver`, {
    data: { eventId, providerEventId: "pe-e2e-2", kind: "acknowledged" },
  });
  expect(acked.ok()).toBeTruthy();
  const dup = await page.request.post(`${STUB}/__control/sync-deliver`, {
    data: { eventId, providerEventId: "pe-e2e-2", kind: "acknowledged" },
  });
  expect(await dup.json()).toMatchObject({ duplicate: true });

  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-outbound").getByTestId("sync-state-acknowledged")).toBeVisible();
  await expect(
    page.getByTestId("sync-resource-list").getByTestId("sync-state-acknowledged"),
  ).toBeVisible();
});

test("9: adherence ingests idempotently", async ({ page }) => {
  const first = await page.request.post(`${STUB}/__control/sync-inbound`, {
    data: {
      providerEventId: "in-e2e-1",
      resourceType: "supplement_adherence",
      payload: { adherence: "took the evening stack", day: "2026-07-29" },
      externalResourceId: "adh-e2e-day-1",
      resourceVersion: "2",
    },
  });
  expect(await first.json()).toMatchObject({ ok: true, duplicate: false });
  const replay = await page.request.post(`${STUB}/__control/sync-inbound`, {
    data: {
      providerEventId: "in-e2e-1",
      resourceType: "supplement_adherence",
      payload: { adherence: "took the evening stack", day: "2026-07-29" },
      externalResourceId: "adh-e2e-day-1",
      resourceVersion: "2",
    },
  });
  expect(await replay.json()).toMatchObject({ duplicate: true });

  await page.goto(SYNC_TAB);
  await expect(page.getByText("took the evening stack")).toHaveCount(1);
});

test("10: inbound data displays with full provenance, as untrusted plain text", async ({ page }) => {
  await page.goto(SYNC_TAB);
  const prov = page.getByTestId("sync-inbound-provenance").first();
  await expect(prov).toContainText("provider event in-e2e-1");
  await expect(prov).toContainText("scope symptoms_adherence");
  await expect(page.getByTestId("sync-inbound-payload").first()).toContainText(
    "adherence: took the evening stack",
  );
});

test("11: revoking ONE scope stops only that scope", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-scope-revoke-appointments").click();
  await expect(page.getByTestId("sync-scope-off-appointments")).toHaveText("revoked");
  // The revoked scope refuses...
  await page.getByTestId("sync-queue-type").selectOption("appointment_summary");
  await page.getByTestId("sync-queue-id").fill("abababab-1111-2222-3333-444444444401");
  await page.getByTestId("sync-queue-submit").click();
  await expect(page.getByText("You don't have access to this record.").first()).toBeVisible();
  // ...while another scope continues (idempotent re-queue answers honestly).
  await page.getByTestId("sync-queue-type").selectOption("lab_summary");
  await page.getByTestId("sync-queue-submit").click();
  await expect(page.getByText("This resource version is already in the sync queue.").first()).toBeVisible();
});

test("13: retry and dead-letter handling with reasoned manual retry", async ({ page }) => {
  // A withdrawal produces a fresh queued envelope to drive through failure.
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-withdraw-lab_summary").click();
  await expect(page.getByText("Withdrawal queued; the resource no longer syncs.").first()).toBeVisible();
  await page.goto(SYNC_TAB);
  const testId = await page
    .locator('[data-testid^="sync-event-"]')
    .first()
    .getAttribute("data-testid");
  withdrawalEventId = testId!.replace("sync-event-", "");

  // Transient failure -> bounded backoff, retry affordance.
  await page.request.post(`${STUB}/__control/sync-deliver`, {
    data: { eventId: withdrawalEventId, providerEventId: "pe-f1", kind: "failed", error: "transient provider error" },
  });
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-outbound").getByTestId("sync-state-failed")).toBeVisible();
  await expect(page.getByText("transient provider error").first()).toBeVisible();
  await page.getByTestId("sync-retry-reason").fill("provider outage resolved");
  await page.getByTestId(`sync-retry-${withdrawalEventId}`).click();
  await expect(page.getByText("Requeued for delivery.").first()).toBeVisible();

  // Terminal rejection -> dead letter + Integrations reconciliation queue.
  await page.request.post(`${STUB}/__control/sync-deliver`, {
    data: { eventId: withdrawalEventId, providerEventId: "pe-f2", kind: "rejected", error: "provider rejected the envelope" },
  });
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-outbound").getByTestId("sync-state-dead_letter")).toBeVisible();
  await page.goto("/integrations");
  await expect(page.getByTestId("sync-ops-dead-letters")).toContainText("provider rejected the envelope");
  await page.getByTestId("sync-ops-retry-reason").fill("reviewed and safe to retry");
  await page.getByTestId(`sync-ops-retry-${withdrawalEventId}`).click();
  await expect(page.getByText("Requeued for delivery.").first()).toBeVisible();
});

test("14: a version conflict resolves without overwriting originals; corrections are overlays", async ({ page }) => {
  // A STALE version of an already-recorded submission becomes a conflict.
  const stale = await page.request.post(`${STUB}/__control/sync-inbound`, {
    data: {
      providerEventId: "in-e2e-2",
      resourceType: "supplement_adherence",
      payload: { adherence: "missed the morning dose", day: "2026-07-28" },
      externalResourceId: "adh-e2e-day-1",
      resourceVersion: "1",
    },
  });
  expect(await stale.json()).toMatchObject({ state: "conflict" });

  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-conflicts").getByTestId("sync-state-open")).toBeVisible();
  await expect(page.getByTestId("sync-conflicts")).toContainText("stale or out-of-order");
  await page.getByTestId("sync-conflict-resolution").selectOption("resolved_keep_desktop");
  await page.getByTestId("sync-conflict-note").fill("newer submission already recorded");
  await page.locator('[data-testid^="sync-resolve-"]').click();
  await expect(page.getByText("Conflict resolved.").first()).toBeVisible();
  // BOTH originals remain visible and untouched.
  await expect(page.getByText("took the evening stack")).toBeVisible();
  await expect(page.getByText("missed the morning dose")).toBeVisible();

  // A correction is a versioned overlay over the original, never a mutation.
  const target = page.locator('[data-testid^="sync-inbound-"]', { hasText: "took the evening stack" }).first();
  await target.getByTestId("sync-correction-text").fill("patient clarified: omega-3 skipped");
  await target.getByTestId("sync-correction-reason").fill("phone follow-up");
  await target.locator('[data-testid^="sync-correct-"]').click();
  await expect(page.getByText("The original submission is unchanged.").first()).toBeVisible();
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-inbound-corrections").first()).toContainText(
    "Correction v1 (phone follow-up)",
  );
  await expect(page.getByText("took the evening stack")).toBeVisible();
});

test("15: real review-queue work from failed and inbound events", async ({ page }) => {
  // An urgent inbound symptom escalates to a HIGH-priority human review task.
  const urgent = await page.request.post(`${STUB}/__control/sync-inbound`, {
    data: {
      providerEventId: "in-e2e-3",
      resourceType: "symptom_report",
      payload: { symptom: "severe chest pain since this evening" },
    },
  });
  expect(await urgent.json()).toMatchObject({ state: "review_pending", urgent: true });

  await page.goto("/tasks");
  await expect(page.getByText("Review inbound symptom report")).toBeVisible();
  await expect(page.getByText("Sync delivery dead-lettered: resource_withdrawal")).toBeVisible();

  // Practitioner review settles the pending item.
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-inbound").getByTestId("sync-state-review_pending")).toBeVisible();
  await page.locator('[data-testid^="sync-accept-"]').first().click();
  await expect(page.getByText("Accepted.").first()).toBeVisible();
});

test("17: the AI summary is honestly not configured", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-ai-generate").click();
  await expect(page.getByTestId("sync-ai-not-configured")).toContainText("not configured");
  await expect(page.getByText("Human review continues without AI.")).toBeVisible();
});

test("16: cross-tenant access is rejected without leaking data", async ({ page }) => {
  const revoke = await page.request.post(`${STUB}/__control/revoke-memberships`, {
    data: { bearer: "fixture-access-token" },
  });
  expect(revoke.ok()).toBeTruthy();
  try {
    await page.goto(SYNC_TAB);
    await page.waitForLoadState("networkidle");
    // The server-side patient gate refuses before the panel can mount: the
    // page is a refusal (404/access), never the connection surface.
    const body = (await page.locator("body").innerText()).trim();
    expect(body).toMatch(/not found|could not be found|don.t have access|isn.t available|sign in/i);
    await expect(page.getByTestId("sync-connection")).toHaveCount(0);
    await expect(page.getByText("alp-e2e-subject")).toHaveCount(0);
  } finally {
    await page.request.post(`${STUB}/__control/restore-memberships`, {
      data: { bearer: "fixture-access-token" },
    });
  }
});

test("12: pause holds both directions; revocation blocks everything; re-linking needs a new invitation", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-pause").click();
  await expect(page.getByTestId("sync-connection").getByTestId("sync-state-paused")).toBeVisible();
  const held = await page.request.post(`${STUB}/__control/sync-inbound`, {
    data: { providerEventId: "in-e2e-4", resourceType: "supplement_adherence", payload: { a: 1 } },
  });
  expect(held.status()).toBe(400);
  expect(await held.text()).toContain("paused");
  await page.getByTestId("sync-resume").click();
  await expect(page.getByTestId("sync-connection").getByTestId("sync-state-verified")).toBeVisible();

  await page.getByTestId("sync-revoke-reason").fill("patient asked to disconnect");
  await page.getByTestId("sync-revoke").click();
  await expect(
    page.getByText("re-linking requires a new invitation", { exact: false }).first(),
  ).toBeVisible();
  const blocked = await page.request.post(`${STUB}/__control/sync-inbound`, {
    data: { providerEventId: "in-e2e-5", resourceType: "supplement_adherence", payload: { a: 1 } },
  });
  expect(blocked.ok()).toBeFalsy();
  // Re-linking starts over with a NEW explicit invitation on a fresh connection.
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-state-unlinked")).toBeVisible();
  await expect(page.getByTestId("sync-connect")).toBeVisible();
});

test("18: no mock identity or fixture-demo content anywhere on the sync surfaces", async ({ page }) => {
  await page.goto(SYNC_TAB);
  for (const name of DEMO_FIXTURE_NAMES) {
    await expect(page.getByText(name)).toHaveCount(0);
  }
  await page.goto("/integrations");
  for (const name of DEMO_FIXTURE_NAMES) {
    await expect(page.getByText(name)).toHaveCount(0);
  }
  await expect(page.getByText("never fakes a connector")).toBeVisible();
});

test("19: keyboard and screen-reader behavior", async ({ page }) => {
  await page.goto(SYNC_TAB);
  // Labeled controls (screen-reader accessible names).
  await expect(page.getByRole("button", { name: "Create connection invitation" })).toBeVisible();
  // Keyboard: the connect action is reachable and operable via keyboard.
  await page.getByTestId("sync-connect").focus();
  await expect(page.getByTestId("sync-connect")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sync-one-time-token")).toBeVisible();
  // Announcements land in a polite live region for screen readers.
  await expect(page.locator('[aria-live="polite"][role="status"]')).toHaveCount(1);
  // Revocation reason input carries an accessible label.
  await expect(page.getByLabel("Revocation reason")).toBeVisible();
});

test("20: no PHI in console logs and no off-origin requests", async ({ page }) => {
  const consoleText: string[] = [];
  const offOrigin: string[] = [];
  page.on("console", (m) => consoleText.push(m.text()));
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["localhost", "127.0.0.1"].includes(u.hostname)) offOrigin.push(r.url());
  });
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-panel")).toBeVisible();
  await page.goto("/integrations");
  await expect(page.getByTestId("sync-ops")).toBeVisible();

  expect(offOrigin, `off-origin requests: ${offOrigin.join(", ")}`).toHaveLength(0);
  const joined = consoleText.join("\n");
  expect(joined).not.toContain("Fixture Patient");
  expect(joined).not.toContain("took the evening stack");
  expect(joined).not.toContain("chest pain");
});
