import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";

/**
 * PHASE 6A, browser-level: the REAL patient-sync worker process
 * (scripts/sync/worker.mjs) driven against the committed contract fixture
 * backend. Every delivery in this suite happens because the actual worker
 * claimed the envelope over the service-role boundary, validated the
 * patient-sync/1 DTO, re-checked consent, and recorded the deterministic
 * fixture provider's evidence — the UI only ever reflects what the database
 * says afterward.
 *
 * The twenty proofs this suite carries:
 *
 *   1. fixture posture is loudly labeled and /api/health never depends on
 *      the worker
 *   2. linking a patient for worker-driven delivery (invitation, verify,
 *      scopes)
 *   3. queued means queued until the REAL worker runs; the success scenario
 *      delivers with fixture evidence that persists across reload
 *   4. PHI-free worker-cycle telemetry and circuit state in Integrations
 *   5. re-queueing the same version answers honestly; an empty cycle claims
 *      nothing
 *   6. a retryable failure backs off with the safe error; discard requires
 *      a reason
 *   7. an explicit re-share after discard mints a NEW envelope generation
 *   8. consent revoked before delivery cancels durably; re-granting never
 *      silently resends
 *   9. an explicit re-share after re-grant delivers; duplicate provider
 *      evidence dedupes
 *  10. a transient failure is retried with a reason and then succeeds
 *  11. a permanent rejection produces exactly ONE dead letter and is never
 *      auto-retried
 *  12. a contract violation dead-letters (never retried) after a reasoned
 *      ops retry
 *  13. the callback boundary verifies signatures BEFORE parsing; replays,
 *      oversize, and wrong content types are refused
 *  14. signed inbound data arrives for review — never written to the chart
 *  15. the fixture refuses every deployed environment with no override
 *  16. an unapproved provider (Phase 6B) is refused by the entry point
 *  17. SYNC_PROVIDER=none idles cleanly; the web app stays healthy
 *  18. a down backend fails the worker without fabricating any UI state
 *  19. worker RPCs are service-role only — client credentials are refused
 *  20. honest fixture labels everywhere; no PHI in logs; no off-origin
 *      requests
 *
 * Recipe (same stub + build as live-sync.spec.ts; restart the stub first):
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-sync-worker.spec.ts
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

const STUB = "http://127.0.0.1:3999";
const PATIENT_1 = "aaaaaaaa-1111-2222-3333-444444444401";
const SYNC_TAB = `/patients/${PATIENT_1}/app-sync`;
const APPOINTMENT_1 = "abababab-1111-2222-3333-444444444401";
const WORKER = path.join(process.cwd(), "scripts", "sync", "worker.mjs");
const CALLBACK_PORT = 3998;
const CALLBACK_SECRET = "e2e-callback-secret";
const CALLBACK_KEY_ID = "fixture-key-1";

// Markers the deploy guard recognizes — scrubbed from the spawn environment
// so the suite's own container never trips the refusal accidentally.
const DEPLOY_MARKERS = [
  "RAILWAY_ENVIRONMENT", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID",
  "FLY_APP_NAME", "FLY_MACHINE_ID", "VERCEL", "VERCEL_ENV", "NOW_REGION",
  "RENDER", "RENDER_SERVICE_ID", "HEROKU_APP_NAME", "DYNO", "K_SERVICE",
  "GAE_ENV", "AWS_EXECUTION_ENV", "ECS_CONTAINER_METADATA_URI",
  "AZURE_FUNCTIONS_ENVIRONMENT", "WEBSITE_INSTANCE_ID",
  "KUBERNETES_SERVICE_HOST", "DEPLOYMENT_ENV", "DEPLOY_ENV",
];

function workerEnv(overrides: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SYNC_PROVIDER: "fixture",
    SYNC_WORKER_SUPABASE_URL: STUB,
    SYNC_WORKER_SERVICE_ROLE_KEY: "service-role-fixture",
    SYNC_WORKER_ORG_ID: "org-fixture",
    NODE_ENV: "test",
  };
  for (const marker of DEPLOY_MARKERS) delete env[marker];
  return { ...env, ...overrides } as NodeJS.ProcessEnv;
}

/** Run the REAL worker entry point once and collect its exit code + output. */
function runWorker(overrides: Record<string, string> = {}, args: string[] = ["--once"]) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args], { env: workerEnv(overrides) });
    let output = "";
    child.stdout.on("data", (d) => { output += String(d); });
    child.stderr.on("data", (d) => { output += String(d); });
    child.on("close", (code) => resolve({ code, output }));
  });
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Sign a callback exactly as the patient-sync/1 scheme requires. */
function signCallback(rawBody: Buffer, timestamp: number, nonce: string) {
  const h = createHmac("sha256", CALLBACK_SECRET);
  h.update(`v1:${timestamp}:${nonce}:`, "utf8");
  h.update(rawBody);
  return h.digest("hex");
}

function callbackHeaders(rawBody: Buffer, nonce: string, timestamp = Date.now()) {
  return {
    "content-type": "application/json",
    "x-sync-signature": signCallback(rawBody, timestamp, nonce),
    "x-sync-key-id": CALLBACK_KEY_ID,
    "x-sync-timestamp": String(timestamp),
    "x-sync-nonce": nonce,
  };
}

let connectionId = "";
let callbackWorker: ChildProcess | null = null;

test.afterAll(() => {
  if (callbackWorker && !callbackWorker.killed) callbackWorker.kill();
});

test("1: fixture posture is loudly labeled; /api/health never depends on the worker", async ({ page }) => {
  // No worker process exists yet — the web application must be healthy.
  const health = await page.request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true });

  const reg = await page.request.post(`${STUB}/__control/sync-register-provider`, {
    data: { organizationId: "org-fixture", provider: "sync_contract_fixture" },
  });
  expect(reg.ok()).toBeTruthy();

  await page.goto("/integrations");
  await expect(page.getByTestId("sync-ops-provider-state")).toHaveText("Fixture test");
  await expect(page.getByTestId("sync-ops-fixture-note")).toContainText(
    "NOT a real AI Longevity Pro connection",
  );
  await expect(page.getByTestId("sync-ops-no-cycle")).toContainText(
    "does not depend on the worker",
  );
});

test("2: linking a patient for worker-driven delivery", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-connect").click();
  await expect(page.getByTestId("sync-one-time-token")).toBeVisible();
  const token = (await page.getByTestId("sync-token-value").textContent())?.trim() ?? "";
  const verify = await page.request.post(`${STUB}/__control/sync-verify`, {
    data: { token, subject: "alp-worker-e2e-subject" },
  });
  expect(verify.ok()).toBeTruthy();
  connectionId = ((await verify.json()) as { connectionId: string }).connectionId;
  expect(connectionId).toBeTruthy();

  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-connection").getByTestId("sync-state-verified")).toBeVisible();
  for (const scope of ["lab_summaries", "appointments", "symptoms_adherence"]) {
    await page.getByTestId("sync-grant-scope").selectOption(scope);
    await page.getByTestId("sync-grant-submit").click();
    await expect(page.getByTestId(`sync-scope-granted-${scope}`)).toBeVisible();
  }
});

test("3: queued means queued until the REAL worker runs; success delivers with fixture evidence", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-queue-type").selectOption("lab_summary");
  await page.getByTestId("sync-queue-submit").click();
  await expect(page.getByTestId("sync-outbound").getByTestId("sync-state-queued")).toBeVisible();
  await expect(page.getByTestId("sync-state-delivered")).toHaveCount(0);
  await expect(page.getByTestId("sync-state-acknowledged")).toHaveCount(0);

  // The actual worker process claims, validates, re-checks, and delivers.
  const run = await runWorker();
  expect(run.code).toBe(0);
  // The fixture identifies itself loudly on every run.
  expect(run.output).toContain(
    "Deterministic contract fixture (TEST — not a real AI Longevity Pro connection)",
  );
  expect(run.output).toContain('"event":"envelope_delivered"');

  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-outbound").getByTestId("sync-state-acknowledged")).toBeVisible();
  await expect(page.getByTestId("sync-resource-list").getByTestId("sync-state-acknowledged")).toBeVisible();
  await expect(page.getByTestId("sync-ack-evidence").first()).toContainText("ack");
});

test("4: PHI-free worker-cycle telemetry and circuit state in Integrations", async ({ page }) => {
  await page.goto("/integrations");
  const cycle = page.getByTestId("sync-ops-last-cycle");
  await expect(cycle).toContainText("claimed 1, succeeded 1");
  await expect(cycle).toContainText("provider sync_contract_fixture (patient-sync/1)");
  await expect(page.getByTestId("sync-ops-circuit")).toContainText("closed");
});

test("5: re-queueing the same version answers honestly; an empty cycle claims nothing", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-queue-type").selectOption("lab_summary");
  await page.getByTestId("sync-queue-submit").click();
  await expect(
    page.getByText("This resource version is already in the sync queue.").first(),
  ).toBeVisible();
  const run = await runWorker();
  expect(run.code).toBe(0);
  expect(run.output).toContain('"claimed":0');
  await page.goto(SYNC_TAB);
  // Still exactly one lab event; nothing was duplicated or re-sent.
  await expect(
    page.locator('[data-testid^="sync-event-"]', { hasText: "lab summary" }),
  ).toHaveCount(1);
});

test("6: a retryable failure backs off with the safe error; discard requires a reason", async ({ page }) => {
  // The stub seeds its appointment fixtures lazily from the calendar RPC.
  const now = Date.now();
  const seed = await page.request.post(`${STUB}/rest/v1/rpc/get_desktop_calendar`, {
    headers: { authorization: "Bearer fixture-access-token", "content-type": "application/json" },
    data: {
      _organization_id: "org-fixture",
      _from: new Date(now - 864e5).toISOString(),
      _to: new Date(now + 7 * 864e5).toISOString(),
    },
  });
  expect(seed.ok()).toBeTruthy();

  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-queue-type").selectOption("appointment_summary");
  await page.getByTestId("sync-queue-id").fill(APPOINTMENT_1);
  await page.getByTestId("sync-queue-submit").click();
  await expect(page.getByTestId("sync-outbound").getByTestId("sync-state-queued")).toBeVisible();

  const run = await runWorker({
    SYNC_FIXTURE_SCENARIOS: '{"appointment_summary":"retryable_429"}',
  });
  expect(run.code).toBe(0);
  expect(run.output).toContain('"event":"envelope_retryable_failure"');

  await page.goto(SYNC_TAB);
  const row = page.locator('[data-testid^="sync-event-"]', { hasText: "appointment summary" });
  await expect(row.getByTestId("sync-state-failed")).toBeVisible();
  // The worker records only the SAFE classification, never provider prose.
  await expect(row).toContainText("retryable: rate_limited");

  // Discard shares the reason field with retry — both refuse without one.
  const eventId = (await row.getAttribute("data-testid"))!.replace("sync-event-", "");
  await expect(page.getByTestId(`sync-cancel-${eventId}`)).toBeDisabled();
  await page.getByTestId("sync-retry-reason").fill("plan changed during the visit");
  await page.getByTestId(`sync-cancel-${eventId}`).click();
  await expect(row.getByTestId("sync-state-cancelled")).toBeVisible();
});

test("7: an explicit re-share after discard mints a NEW envelope generation", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-queue-type").selectOption("appointment_summary");
  await page.getByTestId("sync-queue-id").fill(APPOINTMENT_1);
  await page.getByTestId("sync-queue-submit").click();
  // NOT "already in the sync queue" — a cancelled envelope never blocks an
  // explicit re-share, and the re-share is a new envelope, never a resend.
  await expect(
    page.getByText("It is NOT delivered until the provider acknowledges it.").first(),
  ).toBeVisible();
  const rows = page.locator('[data-testid^="sync-event-"]', { hasText: "appointment summary" });
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('[data-testid="sync-state-queued"]')).toHaveCount(1);
  await expect(rows.locator('[data-testid="sync-state-cancelled"]')).toHaveCount(1);
});

test("8: consent revoked before delivery cancels durably; re-granting never silently resends", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-scope-revoke-appointments").click();
  await expect(page.getByTestId("sync-scope-off-appointments")).toHaveText("revoked");
  // The queued envelope was cancelled by the revocation itself.
  const rows = page.locator('[data-testid^="sync-event-"]', { hasText: "appointment summary" });
  await expect(rows.locator('[data-testid="sync-state-cancelled"]')).toHaveCount(2);
  await expect(page.getByText("consent revoked").first()).toBeVisible();

  // The worker finds nothing to hand to the provider.
  const run = await runWorker();
  expect(run.code).toBe(0);
  expect(run.output).toContain('"claimed":0');

  // Re-granting consent does NOT resurrect the cancelled work.
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-grant-scope").selectOption("appointments");
  await page.getByTestId("sync-grant-submit").click();
  await expect(page.getByTestId("sync-scope-granted-appointments")).toBeVisible();
  const rerun = await runWorker();
  expect(rerun.code).toBe(0);
  expect(rerun.output).toContain('"claimed":0');
  await page.goto(SYNC_TAB);
  await expect(rows.locator('[data-testid="sync-state-cancelled"]')).toHaveCount(2);
  await expect(rows.locator('[data-testid="sync-state-acknowledged"]')).toHaveCount(0);
});

test("9: an explicit re-share after re-grant delivers; duplicate provider evidence dedupes", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-queue-type").selectOption("appointment_summary");
  await page.getByTestId("sync-queue-id").fill(APPOINTMENT_1);
  await page.getByTestId("sync-queue-submit").click();
  await expect(
    page.getByText("It is NOT delivered until the provider acknowledges it.").first(),
  ).toBeVisible();

  // The fixture reports the SAME delivered evidence twice; state stays correct.
  const run = await runWorker({
    SYNC_FIXTURE_SCENARIOS: '{"appointment_summary":"duplicate_delivery"}',
  });
  expect(run.code).toBe(0);
  await page.goto(SYNC_TAB);
  const rows = page.locator('[data-testid^="sync-event-"]', { hasText: "appointment summary" });
  await expect(rows.locator('[data-testid="sync-state-acknowledged"]')).toHaveCount(1);
  await expect(rows.locator('[data-testid="sync-state-cancelled"]')).toHaveCount(2);
});

test("10: a transient failure is retried with a reason and then succeeds", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-withdraw-appointment_summary").click();
  await expect(page.getByText("Withdrawal queued; the resource no longer syncs.").first()).toBeVisible();

  const fail = await runWorker({
    SYNC_FIXTURE_SCENARIOS: '{"resource_withdrawal":"timeout"}',
  });
  expect(fail.code).toBe(0);
  await page.goto(SYNC_TAB);
  const row = page.locator('[data-testid^="sync-event-"]', { hasText: "resource withdrawal" });
  await expect(row.getByTestId("sync-state-failed")).toBeVisible();
  await expect(row).toContainText("retryable: timeout");

  const eventId = (await row.getAttribute("data-testid"))!.replace("sync-event-", "");
  await page.getByTestId("sync-retry-reason").fill("provider timeout resolved");
  await page.getByTestId(`sync-retry-${eventId}`).click();
  await expect(page.getByText("Requeued for delivery.").first()).toBeVisible();

  const ok = await runWorker({ SYNC_FIXTURE_SCENARIOS: '{"resource_withdrawal":"success"}' });
  expect(ok.code).toBe(0);
  await page.goto(SYNC_TAB);
  await expect(row.getByTestId("sync-state-acknowledged")).toBeVisible();
});

test("11: a permanent rejection produces exactly ONE dead letter and is never auto-retried", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await page.getByTestId("sync-withdraw-lab_summary").click();
  await expect(page.getByText("Withdrawal queued; the resource no longer syncs.").first()).toBeVisible();

  const run = await runWorker({
    SYNC_FIXTURE_SCENARIOS: '{"resource_withdrawal":"permanent_400"}',
  });
  expect(run.code).toBe(0);
  expect(run.output).toContain('"event":"envelope_dead_lettered"');

  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-outbound").getByTestId("sync-state-dead_letter")).toHaveCount(1);
  await page.goto("/tasks");
  await expect(page.getByText("Sync delivery dead-lettered: resource_withdrawal")).toBeVisible();
  await page.goto("/integrations");
  await expect(page.getByTestId("sync-ops-dead-letters")).toContainText("permanent: http_400");

  // Permanent means permanent: another cycle claims nothing and adds nothing.
  const rerun = await runWorker();
  expect(rerun.code).toBe(0);
  expect(rerun.output).toContain('"claimed":0');
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-outbound").getByTestId("sync-state-dead_letter")).toHaveCount(1);
});

test("12: a contract violation dead-letters (never retried) after a reasoned ops retry", async ({ page }) => {
  await page.goto("/integrations");
  const retryButton = page.locator('[data-testid^="sync-ops-retry-"]:not([data-testid="sync-ops-retry-reason"])').first();
  const eventId = (await retryButton.getAttribute("data-testid"))!.replace("sync-ops-retry-", "");
  await page.getByTestId("sync-ops-retry-reason").fill("reviewed; probing the contract path");
  await page.getByTestId(`sync-ops-retry-${eventId}`).click();
  await expect(page.getByText("Requeued for delivery.").first()).toBeVisible();

  const run = await runWorker({
    SYNC_FIXTURE_SCENARIOS: '{"resource_withdrawal":"invalid_contract_version"}',
  });
  expect(run.code).toBe(0);
  expect(run.output).toContain('"event":"envelope_dead_lettered"');
  expect(run.output).toContain('"errorClass":"contract"');

  await page.goto(SYNC_TAB);
  const row = page.locator('[data-testid^="sync-event-"]', { hasText: "resource withdrawal" })
    .filter({ hasText: "contract: unsupported_contract_version" });
  await expect(row.getByTestId("sync-state-dead_letter")).toBeVisible();
});

test("13: the callback boundary verifies signatures BEFORE parsing; replay/oversize/content-type refused", async ({ page }) => {
  // Start the real worker WITH its callback server, on a slow loop so the
  // boundary can be exercised while it runs.
  callbackWorker = spawn(process.execPath, [WORKER, "--callback-port", String(CALLBACK_PORT)], {
    env: workerEnv({
      SYNC_WORKER_INTERVAL_MS: "60000",
      SYNC_CALLBACK_SECRET: CALLBACK_SECRET,
      SYNC_CALLBACK_KEY_ID: CALLBACK_KEY_ID,
    }),
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("callback server did not start")), 15000);
    callbackWorker!.stdout!.on("data", (d) => {
      if (String(d).includes("callback_listening")) { clearTimeout(timer); resolve(); }
    });
  });
  const CALLBACK = `http://127.0.0.1:${CALLBACK_PORT}/sync/callback`;

  const payload = { symptom: "mild knee soreness after long runs", day: "2026-07-30" };
  const body = {
    connectionId,
    providerEventId: "cb-in-1",
    contractVersion: "patient-sync/1",
    resourceType: "symptom_report",
    payload,
    payloadHash: sha256(JSON.stringify(payload)),
    occurredAt: new Date().toISOString(),
  };
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");

  // Unsigned garbage is refused as a SIGNATURE failure — never parsed
  // (invalid JSON would be 400 if parsing came first).
  const unsigned = await page.request.post(CALLBACK, {
    headers: { "content-type": "application/json" },
    data: "{not json at all",
  });
  expect(unsigned.status()).toBe(401);

  // A tampered body fails the constant-time comparison.
  const nonceTampered = randomUUID();
  const tampered = await page.request.post(CALLBACK, {
    headers: callbackHeaders(rawBody, nonceTampered),
    data: rawBody.toString("utf8").replace("mild knee", "severe knee"),
  });
  expect(tampered.status()).toBe(401);

  // A stale timestamp is outside the tolerance window.
  const nonceStale = randomUUID();
  const stale = await page.request.post(CALLBACK, {
    headers: callbackHeaders(rawBody, nonceStale, Date.now() - 10 * 60_000),
    data: rawBody.toString("utf8"),
  });
  expect(stale.status()).toBe(401);

  // The valid signed callback is accepted...
  const nonce = randomUUID();
  const okHeaders = callbackHeaders(rawBody, nonce);
  const accepted = await page.request.post(CALLBACK, {
    headers: okHeaders, data: rawBody.toString("utf8"),
  });
  expect(accepted.status()).toBe(200);
  // ...and replaying the SAME nonce is refused.
  const replay = await page.request.post(CALLBACK, {
    headers: okHeaders, data: rawBody.toString("utf8"),
  });
  expect(replay.status()).toBe(409);

  // Oversize bodies and wrong content types never reach processing.
  const bigRaw = Buffer.from(JSON.stringify({ pad: "x".repeat(70000) }), "utf8");
  const oversize = await page.request.post(CALLBACK, {
    headers: callbackHeaders(bigRaw, randomUUID()), data: bigRaw.toString("utf8"),
  });
  expect(oversize.status()).toBe(413);
  const wrongType = await page.request.post(CALLBACK, {
    headers: { ...callbackHeaders(rawBody, randomUUID()), "content-type": "text/plain" },
    data: rawBody.toString("utf8"),
  });
  expect(wrongType.status()).toBe(415);

  const running = callbackWorker!;
  running.kill();
  await new Promise((resolve) => running.on("close", resolve));
  callbackWorker = null;
});

test("14: signed inbound data arrives for review — never written to the chart", async ({ page }) => {
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-inbound").getByTestId("sync-state-review_pending")).toBeVisible();
  const prov = page.getByTestId("sync-inbound-provenance").first();
  await expect(prov).toContainText("provider event cb-in-1");
  await expect(page.getByTestId("sync-inbound-payload").first()).toContainText(
    "mild knee soreness after long runs",
  );
  await page.goto("/tasks");
  await expect(page.getByText("Review inbound symptom report")).toBeVisible();
  // The chart itself carries none of it until a human acts.
  await page.goto(`/patients/${PATIENT_1}`);
  await expect(page.getByText("mild knee soreness after long runs")).toHaveCount(0);
  // Practitioner review settles it — as review work, not as chart content.
  await page.goto(SYNC_TAB);
  await page.locator('[data-testid^="sync-accept-"]').first().click();
  await expect(page.getByText("Accepted.").first()).toBeVisible();
});

test("15: the fixture refuses every deployed environment with no override", async () => {
  const deployed: Record<string, string>[] = [
    { RAILWAY_ENVIRONMENT: "production" },
    { FLY_APP_NAME: "prod-app" },
    { VERCEL: "1" },
    { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
    { DEPLOYMENT_ENV: "staging" },
    { NODE_ENV: "production" },
  ];
  for (const marker of deployed) {
    const run = await runWorker(marker);
    expect(run.code, `marker ${Object.keys(marker)[0]} must refuse`).toBe(1);
    expect(run.output).toContain("fixture_refused_deployed");
  }
});

test("16: an unapproved provider (Phase 6B) is refused by the entry point", async () => {
  const run = await runWorker({ SYNC_PROVIDER: "alp" });
  expect(run.code).toBe(1);
  expect(run.output).toContain('"event":"worker_refused"');
});

test("17: SYNC_PROVIDER=none idles cleanly; the web app stays healthy", async ({ page }) => {
  const run = await runWorker({ SYNC_PROVIDER: "none" });
  expect(run.code).toBe(0);
  expect(run.output).toContain('"event":"worker_idle"');
  // No worker is running now — the application is untouched by that fact.
  const health = await page.request.get("/api/health");
  expect(health.status()).toBe(200);
  await page.goto(SYNC_TAB);
  await expect(page.getByTestId("sync-panel")).toBeVisible();
});

test("18: a down backend fails the worker without fabricating any UI state", async ({ page }) => {
  const down = await runWorker({ SYNC_WORKER_SUPABASE_URL: "http://127.0.0.1:3997" });
  expect(down.code).toBe(1);
  expect(down.output).toContain('"event":"cycle_failed"');
  const noCreds = await runWorker({ SYNC_WORKER_SERVICE_ROLE_KEY: "" });
  expect(noCreds.code).toBe(1);
  expect(noCreds.output).toContain("missing_worker_credentials");
  // The UI still shows only real, database-backed state.
  await page.goto("/integrations");
  await expect(page.getByTestId("sync-ops")).toBeVisible();
  await expect(page.getByTestId("sync-ops-circuit")).toContainText("closed");
});

test("19: worker RPCs are service-role only — client credentials are refused", async ({ page }) => {
  for (const rpc of ["claim_sync_outbound", "record_sync_worker_cycle", "register_sync_callback_nonce"]) {
    const asClient = await page.request.post(`${STUB}/rest/v1/rpc/${rpc}`, {
      headers: { authorization: "Bearer fixture-access-token", "content-type": "application/json" },
      data: { _organization_id: "org-fixture" },
    });
    expect(asClient.status(), `${rpc} must refuse client credentials`).toBe(403);
    expect(await asClient.text()).toContain("42501");
  }
});

test("20: honest fixture labels everywhere; no PHI in logs; no off-origin requests", async ({ page }) => {
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
  await expect(page.getByTestId("sync-ops-provider-state")).toHaveText("Fixture test");
  await expect(page.getByTestId("sync-ops-fixture-note")).toContainText(
    "Deterministic contract fixture — TEST behavior only",
  );

  expect(offOrigin, `off-origin requests: ${offOrigin.join(", ")}`).toHaveLength(0);
  const joined = consoleText.join("\n");
  expect(joined).not.toContain("mild knee soreness");
  expect(joined).not.toContain("alp-worker-e2e-subject");

  // The worker's own logs are allowlisted: a full cycle prints no payload
  // content, no patient identifiers, and no credentials.
  const run = await runWorker();
  expect(run.code).toBe(0);
  expect(run.output).not.toContain("mild knee soreness");
  expect(run.output).not.toContain("appointmentId");
  expect(run.output).not.toContain(PATIENT_1);
  expect(run.output).not.toContain("service-role-fixture");
});
