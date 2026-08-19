import { expect, test, type Page, type Request } from "@playwright/test";
import { resetBackend, STUB_BASE } from "./support/backend";

/**
 * LIVE-MODE Phase 10B.1 — Governed Copilot Provider Readiness.
 *
 * This suite proves the provider-readiness behaviour through the REAL UI,
 * the REAL API routes, and the REAL persistence path. It replaces the
 * earlier placeholder spec, which asserted only that some static wording
 * was on screen and was then deleted when it failed. It had failed for a
 * mundane reason worth recording: it navigated to `?tab=clinical-copilot`,
 * but the copilot lives at `/patients/{id}/labs?view=copilot`. The
 * conclusion drawn at the time — that the fixture backend could not
 * support these proofs — was wrong.
 *
 * FOUR RUNTIME POSTURES, ALL EXERCISED IN CI
 * ------------------------------------------
 * The copilot's process-level mode and the runtime's deployment posture are
 * both fixed when the server boots, so one server cannot show all of them.
 * CI therefore runs this file four times, each job declaring which block it
 * is about via `E2E_COPILOT_POSTURE`:
 *
 *   default          job `e2e-live-fixture`             — no CLINICAL_COPILOT_MODE.
 *   live_local       job `e2e-copilot-readiness`        — mode=live, dev server,
 *                                                         contract fixture allowed.
 *   deployed_fixture job `e2e-copilot-fixture-refusal`  — mode=fixture + deployed markers.
 *   deployed_live    job `e2e-copilot-deployed-live`    — mode=live + deployed markers,
 *                                                         org approved_for_synthetic.
 *
 * No block is skipped in CI; each runs in the job whose posture it is
 * about, and the union covers every required proof. The guard below is a
 * posture selector, not a way to avoid running. The posture is declared by
 * the job rather than inferred from CLINICAL_COPILOT_MODE, because two of
 * the four jobs share a mode and differ only in deployment markers the
 * browser cannot see.
 *
 * WHERE THE DETERMINISTIC PROVIDER IS ALLOWED TO EXIST
 * ----------------------------------------------------
 * Nowhere deployed. A governed record (`synthetic_fixture` +
 * `approved_for_synthetic`, no PHI) is NECESSARY but not SUFFICIENT: the
 * runtime must also pass the isolated local contract-fixture boundary in
 * `src/server/runtime/contractFixture.ts` — explicit opt-in, a loopback
 * backend, not the clinical project, and not a deployed runtime.
 *
 * `next start` forces NODE_ENV=production and so counts as deployed. Rather
 * than weaken that categorical refusal for the sake of coverage, the
 * live_local job runs against `next dev` (E2E_DEV_SERVER=1), where the
 * fixture is legitimately permitted. The deployed_live job then proves the
 * other half: the same governed record produces NOTHING once a deployment
 * marker is present.
 *
 * ZERO EXTERNAL REQUESTS. Every test runs under `assertNoExternalTraffic`,
 * which fails the test if the browser attempts any host other than the
 * local app and the local fixture backend.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a live-flag build");

test.describe.configure({ mode: "serial" });

/**
 * The four postures are mutually exclusive, so exactly one describe block
 * runs per CI job. An earlier version keyed only on "is it live", which
 * meant the fixture job also ran the default-posture block and failed on a
 * screen that was behaving correctly. Deriving it from the mode is no
 * longer possible either: `live_local` and `deployed_live` share
 * CLINICAL_COPILOT_MODE=live and differ only in server-side deployment
 * markers, which the browser cannot observe. The job declares its posture.
 */
const POSTURE = (process.env.E2E_COPILOT_POSTURE ?? "default").toLowerCase();
const DEFAULT_MODE = POSTURE === "default";
const LIVE_MODE = POSTURE === "live_local";
const FIXTURE_MODE = POSTURE === "deployed_fixture";
const DEPLOYED_LIVE_MODE = POSTURE === "deployed_live";

if (![DEFAULT_MODE, LIVE_MODE, FIXTURE_MODE, DEPLOYED_LIVE_MODE].some(Boolean)) {
  // A typo in a job's env must fail loudly rather than silently running
  // nothing and reporting green.
  throw new Error(
    `E2E_COPILOT_POSTURE="${POSTURE}" is not one of ` +
      `default | live_local | deployed_fixture | deployed_live.`,
  );
}

const PATIENT_ID = "aaaaaaaa-1111-2222-3333-444444444401";
const COPILOT_URL = `/patients/${PATIENT_ID}/labs?view=copilot`;

/** Hosts this application is allowed to talk to during a deterministic run. */
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Fail the test if the page reaches any external host.
 *
 * This is the browser-side half of the "zero external AI requests" claim.
 * It watches every request the page makes, including ones a bug might add
 * later, rather than asserting against a list of calls we expected.
 */
function assertNoExternalTraffic(page: Page): { external: string[] } {
  const external: string[] = [];
  const onRequest = (req: Request) => {
    let host = "";
    try {
      host = new URL(req.url()).hostname;
    } catch {
      return;
    }
    if (!ALLOWED_HOSTS.has(host)) external.push(req.url());
  };
  page.on("request", onRequest);
  return { external };
}

async function setScenario(scenario: string): Promise<void> {
  const res = await fetch(`${STUB_BASE}/__control/copilot-scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario }),
  });
  if (!res.ok) throw new Error(`copilot scenario ${scenario} failed: HTTP ${res.status}`);
}

async function requestLog(): Promise<{ scenario: string; calls: Array<{ path: string }> }> {
  const res = await fetch(`${STUB_BASE}/__control/copilot-request-log`);
  return (await res.json()) as { scenario: string; calls: Array<{ path: string }> };
}

async function forceStale(): Promise<void> {
  await fetch(`${STUB_BASE}/__control/copilot-force-stale`, { method: "POST" });
}

async function effects(): Promise<{
  noteAppends: Array<{ noteStatus: string; signed: boolean }>;
  protocolDrafts: Array<{ status: string; active: boolean }>;
  reviewTasks: Array<{ status: string }>;
  runs: Array<{ id: string; status: string; disposition: string | null; outputHash: string | null }>;
}> {
  const res = await fetch(`${STUB_BASE}/rest/v1/rpc/__copilot_effects`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer fixture-access-token" },
    body: "{}",
  });
  return await res.json();
}

/**
 * Attempts completed on each page, so `runOnce` can wait for THIS run
 * rather than for an envelope a previous run already left on screen.
 *
 * Waiting on `copilot-envelope` alone silently passed the moment a second
 * run was requested: the element was already visible, so the assertion
 * resolved before the request had been sent. The panel renders the attempt
 * counter for exactly this reason.
 */
const attempts = new WeakMap<Page, number>();

async function openCopilot(page: Page) {
  await page.goto(COPILOT_URL);
  await expect(page.getByRole("heading", { name: /Governed copilot run/i })).toBeVisible();
  attempts.set(page, 0); // the panel's own counter resets on mount
}

async function openCopilotOrExpectWorkforceDenial(page: Page): Promise<"panel" | "sign-in"> {
  await page.goto(COPILOT_URL);
  const signIn = page.getByRole("heading", { name: /Practitioner sign-in/i });
  const panel = page.getByRole("heading", { name: /Governed copilot run/i });
  await expect(signIn.or(panel)).toBeVisible({ timeout: 15_000 });
  if (await signIn.isVisible()) {
    await expect(panel).toHaveCount(0);
    return "sign-in";
  }
  attempts.set(page, 0);
  return "panel";
}

async function runOnce(page: Page) {
  const next = (attempts.get(page) ?? 0) + 1;
  attempts.set(page, next);
  await page.getByTestId("copilot-run").click();
  await expect(page.getByTestId("copilot-run-identity")).toContainText(`attempt ${next}`);
}

/**
 * Compile the routes this suite drives before the first assertion runs.
 *
 * `next dev` compiles a route the first time it is requested, and the
 * provider-status API is fetched by the panel a moment after the page
 * mounts — so the very first test would otherwise race a cold compile and
 * read "Reading provider posture…".
 *
 * This is a warm-up, not a relaxation: no timeout is raised and no
 * assertion is weakened. Under `next start` the routes are already built
 * and this costs one no-op request each. A failure to warm is ignored on
 * purpose — the tests themselves are the thing that must fail if a route
 * is broken, not this helper.
 */
async function warmRoutes(): Promise<void> {
  const base = `http://localhost:${process.env.E2E_PORT ?? 3114}`;
  for (const path of [COPILOT_URL, "/api/live/copilot/provider-status"]) {
    try {
      await fetch(`${base}${path}`);
    } catch {
      /* the suite's own assertions report a genuinely broken route */
    }
  }
}

test.beforeAll(async () => {
  await resetBackend();
  await warmRoutes();
});

/* ===================================================================== */
/* DEFAULT DISABLED POSTURE — runs in the default-env CI job              */
/* ===================================================================== */

test.describe(DEFAULT_MODE ? "default disabled posture" : "skip: default posture (other jobs)", () => {
  test.skip(!DEFAULT_MODE, "covered by the default-env CI job");

  test("PROOF 1 — the default posture makes no provider or secret request", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("unconfigured");
    await openCopilot(page);
    await expect(page.getByTestId("copilot-provider-posture")).toBeVisible();

    // The disabled path returns before consulting the registry at all.
    const log = await requestLog();
    expect(log.calls.map((c) => c.path)).not.toContain("provider_registry");
    expect(log.calls.map((c) => c.path)).not.toContain("get_copilot_activation");
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 2 — disabled mode says 'Not configured' honestly", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await openCopilot(page);
    await expect(page.getByTestId("copilot-posture-state")).toHaveText("disabled");
    await expect(page.getByTestId("copilot-posture-label")).toHaveText("Not configured");
    const detail = await page.getByTestId("copilot-posture-detail").textContent();
    expect(detail).toMatch(/External AI is disabled/i);
    expect(detail).toMatch(/No provider was contacted/i);
    // It must not claim connectivity or compliance.
    expect(detail?.toLowerCase()).not.toContain("hipaa-ready");
    expect(detail?.toLowerCase()).not.toMatch(/\bconnected\b/);
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 9 — configured and transacted are separate, both negative here", async ({ page }) => {
    await openCopilot(page);
    await expect(page.getByTestId("copilot-posture-configured")).toContainText("no");
    await expect(page.getByTestId("copilot-posture-transacted")).toContainText("never");
  });

  test("PROOF 1b — a run under the disabled posture drafts nothing", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await openCopilot(page);
    await runOnce(page);
    await expect(page.getByTestId("copilot-status")).toContainText("unavailable");
    await expect(page.getByTestId("copilot-message")).toContainText(/provider was NOT called/i);
    // No draft body was fabricated to fill the space.
    await expect(page.getByText("Draft (JSON, structural only)")).toHaveCount(0);
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 19 — no secret, ARN, auth header, or prompt reaches the browser", async ({ page }) => {
    await openCopilot(page);
    await assertBundleIsClean(page);
  });

  test("PROOF 20 — zero external requests across the whole disabled flow", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await openCopilot(page);
    await runOnce(page);
    await page.getByTestId("copilot-gates-toggle").click();
    expect(traffic.external).toEqual([]);
  });
});

/* ===================================================================== */
/* LIVE STATE MACHINE — runs in the CLINICAL_COPILOT_MODE=live CI job     */
/* ===================================================================== */

test.describe(LIVE_MODE ? "live state machine" : "skip: live state machine (default job)", () => {
  test.skip(!LIVE_MODE, "covered by the e2e-copilot-readiness CI job");

  test("PROOF 3 — an org with no provider reads Not configured, not 'unavailable'", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("unconfigured");
    await openCopilot(page);
    await expect(page.getByTestId("copilot-posture-state")).toHaveText("disabled");
    await expect(page.getByTestId("copilot-posture-label")).toHaveText("Not configured");
    await expect(page.getByTestId("copilot-posture-detail")).toContainText(
      /no secret was requested/i,
    );
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 6 — live mode with no approved provider refuses the run", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("unconfigured");
    await openCopilot(page);
    await runOnce(page);
    await expect(page.getByTestId("copilot-status")).toContainText("unavailable");
    await expect(page.getByTestId("copilot-envelope")).not.toContainText("Draft (JSON");
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 7 — configured but no organizational approval refuses", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("configured_no_org_approval");
    await openCopilot(page);

    await expect(page.getByTestId("copilot-posture-state")).toHaveText("configured_unapproved");
    await expect(page.getByTestId("copilot-posture-configured")).toContainText("yes");
    await page.getByTestId("copilot-gates-toggle").click();
    // Every vendor-side record is in place; the ORG never opted in.
    await expect(page.getByTestId("copilot-gate-openai_baa_verified")).toHaveAttribute(
      "data-status",
      "approved",
    );
    await expect(page.getByTestId("copilot-gate-organization_opt_in")).toHaveAttribute(
      "data-status",
      "not_approved",
    );

    await runOnce(page);
    await expect(page.getByTestId("copilot-status")).toContainText("unavailable");
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 8 — every sign-off but no BAA record still refuses", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("approved_no_baa");
    await openCopilot(page);

    await expect(page.getByTestId("copilot-posture-state")).toHaveText("configured_unapproved");
    await page.getByTestId("copilot-gates-toggle").click();
    await expect(page.getByTestId("copilot-gate-openai_baa_verified")).toHaveAttribute(
      "data-status",
      "not_run",
    );
    // A retention claim without the agreement that grants it is not approval.
    await expect(page.getByTestId("copilot-gate-abuse_monitoring_or_zdr")).toHaveAttribute(
      "data-status",
      "not_run",
    );
    // The org DID opt in and DID approve PHI — one missing record still refuses.
    await expect(page.getByTestId("copilot-gate-organization_opt_in")).toHaveAttribute(
      "data-status",
      "approved",
    );

    await runOnce(page);
    await expect(page.getByTestId("copilot-status")).toContainText("unavailable");
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 9 — configured and transacted are displayed as separate facts", async ({ page }) => {
    await setScenario("configured_no_org_approval");
    await openCopilot(page);
    await expect(page.getByTestId("copilot-posture-configured")).toContainText("yes");
    await expect(page.getByTestId("copilot-posture-transacted")).toContainText("never");
    await page.getByTestId("copilot-gates-toggle").click();
    await expect(page.getByTestId("copilot-gate-live_transaction_executed")).toHaveAttribute(
      "data-status",
      "not_run",
    );
  });

  test("PROOFS 10 + 11 — a successful deterministic response stays a DRAFT with governed citations", async ({
    page,
  }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("approved_synthetic");
    await openCopilot(page);

    await expect(page.getByTestId("copilot-posture-state")).toHaveText("fixture_test_mode");
    await runOnce(page);

    await expect(page.getByTestId("copilot-status")).toContainText("completed");
    await expect(page.getByTestId("copilot-provider")).toContainText("fixture:governed-synthetic");
    // It is a draft, and the screen says so unambiguously.
    await expect(page.getByTestId("copilot-envelope")).toContainText(/does\s+not\s+sign/i);

    // PROOF 11: every citation came from the governed retrieval envelope.
    const draftJson = await page.locator("[data-testid='copilot-envelope'] pre").textContent();
    expect(draftJson).toBeTruthy();
    const citedIds: string[] = JSON.parse(draftJson!).allowedCitations ?? [];
    for (const id of citedIds) expect(id).toMatch(/^kr-fixture-00[12]$/);
    await expect(page.getByTestId("copilot-rejected-citations")).toHaveCount(0);

    // It is persisted as a completed run with an output hash.
    const after = await effects();
    expect(after.runs.some((r) => r.status === "completed" && r.outputHash)).toBe(true);
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 12 — a hallucinated citation fails the run closed", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("approved_synthetic_adversarial");
    await openCopilot(page);
    await runOnce(page);

    await expect(page.getByTestId("copilot-status")).toContainText("failed");
    await expect(page.getByTestId("copilot-failure-category")).toContainText("citation_validation");
    await expect(page.getByTestId("copilot-rejected-citations")).toBeVisible();
    // Fail CLOSED: no draft body survives a citation outside the envelope.
    await expect(page.getByText("Draft (JSON, structural only)")).toHaveCount(0);

    const after = await effects();
    expect(after.runs.every((r) => r.status !== "completed")).toBe(true);
    expect(after.runs.every((r) => r.outputHash === null)).toBe(true);
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 13 — safety items are pinned and identical across every lens", async ({ page }) => {
    await setScenario("approved_synthetic");
    await openCopilot(page);

    const summaries = new Set<string>();
    for (const lens of ["western", "functional", "naturopathy", "tcm", "biohacking", "synergistic"]) {
      await page.getByTestId("copilot-lens").selectOption(lens);
      await runOnce(page);
      await expect(page.getByTestId("copilot-status")).toContainText("completed");
      const safety = page.getByTestId("copilot-safety");
      summaries.add((await safety.count()) === 0 ? "(none)" : ((await safety.textContent()) ?? ""));
    }
    // One distinct safety summary across all six lenses: the lens changes
    // framing, never what is escalated.
    expect(summaries.size).toBe(1);
  });

  test("PROOF 14 — accepting a draft causes no clinical side effect", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("approved_synthetic");
    await openCopilot(page);
    await runOnce(page);
    await expect(page.getByTestId("copilot-status")).toContainText("completed");

    await page.getByTestId("copilot-disposition-accepted").click();
    await expect(page.getByTestId("copilot-disposition-message")).toContainText(
      /No note was signed/i,
    );

    const after = await effects();
    // Nothing was signed, activated, ordered, charged, messaged, or synced.
    expect(after.noteAppends.every((n) => n.signed === false)).toBe(true);
    expect(after.noteAppends.every((n) => n.noteStatus === "draft_unsigned")).toBe(true);
    expect(after.protocolDrafts.every((p) => p.active === false)).toBe(true);
    expect(after.protocolDrafts.every((p) => p.status === "draft")).toBe(true);
    expect(after.reviewTasks.every((t) => t.status === "open")).toBe(true);
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 16 — retrying does not duplicate a run or a disposition", async ({ page }) => {
    await setScenario("approved_synthetic");
    await openCopilot(page);

    await runOnce(page);
    await page.getByTestId("copilot-disposition-accepted").click();
    await expect(page.getByTestId("copilot-disposition-final")).toContainText("accepted");
    // A second disposition is not offered.
    await expect(page.getByTestId("copilot-disposition-dismissed")).toBeDisabled();

    const afterFirst = await effects();
    const firstCompleted = afterFirst.runs.filter((r) => r.status === "completed");
    expect(firstCompleted).toHaveLength(1);
    expect(firstCompleted[0]!.disposition).toBe("accepted");

    // Re-running produces a NEW run; it never mutates the finalized one.
    await runOnce(page);
    const afterRetry = await effects();
    expect(afterRetry.runs.filter((r) => r.status === "completed")).toHaveLength(2);
    const original = afterRetry.runs.find((r) => r.id === firstCompleted[0]!.id)!;
    expect(original.disposition).toBe("accepted");
  });

  test("PROOF 17 — a stale input snapshot cannot silently finalize", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("approved_synthetic");
    await openCopilot(page);

    // The chart moves underneath the run between create and finalize.
    await forceStale();
    await page.getByTestId("copilot-run").click();

    // The screen reports a failure rather than a quietly finalized answer.
    await expect(page.getByTestId("copilot-error")).toBeVisible();

    const after = await effects();
    expect(after.runs.every((r) => r.status !== "completed")).toBe(true);
    expect(after.runs.some((r) => r.status === "stale")).toBe(true);
    expect(after.runs.every((r) => r.outputHash === null)).toBe(true);
    expect(traffic.external).toEqual([]);
  });

  test("PROOF 15 — a failed run reports a category, never raw provider text", async ({ page }) => {
    await setScenario("approved_synthetic_adversarial");
    await openCopilot(page);
    await runOnce(page);
    await expect(page.getByTestId("copilot-status")).toContainText("failed");

    const envelopeText = (await page.getByTestId("copilot-envelope").textContent()) ?? "";

    // A PHI-safe category is present…
    expect(envelopeText).toMatch(/citation_validation/);

    // …and none of the provider's RESPONSE BODY is echoed onto the screen.
    // The model identifier ("fixture-copilot-v1") is deliberately NOT in
    // this list: provider name and model are allowlisted operational
    // metadata that the run row is supposed to record. What must not
    // appear is anything the provider generated.
    for (const bodyField of ["producedBy", "deterministic", "allowedCitations", "shape"]) {
      expect(envelopeText, `provider response body field "${bodyField}" must not render`).not.toContain(
        bodyField,
      );
    }
    expect(envelopeText).not.toMatch(/You are a governed clinical copilot/);
    // The offending refId is reported as a count, not as prose to read.
    expect(envelopeText).not.toContain("hallucinated-reference-not-in-envelope");
    expect(envelopeText).toMatch(/1 hallucinated citation\(s\) rejected/);
  });

  test("PROOF 19 — no secret, ARN, auth header, prompt, or PHI in the browser", async ({ page }) => {
    await setScenario("approved_synthetic");
    await openCopilot(page);
    await runOnce(page);
    await assertBundleIsClean(page);
  });

  test("PROOF 20 — zero external requests across the whole live state machine", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    for (const scenario of [
      "unconfigured",
      "configured_unapproved",
      "configured_no_org_approval",
      "approved_no_baa",
      "approved_synthetic",
    ]) {
      await setScenario(scenario);
      await openCopilot(page);
      await runOnce(page);
    }
    expect(traffic.external).toEqual([]);
  });
});

/* ===================================================================== */
/* DEPLOYED FIXTURE REFUSAL — runs in the CLINICAL_COPILOT_MODE=fixture job */
/* ===================================================================== */

test.describe(
  FIXTURE_MODE ? "deployed fixture refusal" : "skip: deployed fixture refusal (other jobs)",
  () => {
    test.skip(!FIXTURE_MODE, "covered by the e2e-copilot-fixture-refusal CI job");

    test("PROOF 4 — fixture mode is refused under a deployed-runtime marker", async ({ page }) => {
      const traffic = assertNoExternalTraffic(page);
      await setScenario("approved_synthetic");
      await openCopilot(page);

      // The server refuses to resolve the mode at all, so the panel reports
      // an honest unavailable state…
      await expect(page.getByTestId("copilot-posture-unavailable")).toBeVisible();
      const detail = await page.getByTestId("copilot-posture-detail").textContent();
      expect(detail).toMatch(/no example content is shown/i);

      // …and crucially it does NOT render fixture content instead.
      const body = (await page.textContent("body")) ?? "";
      expect(body).not.toContain("fixture-copilot-v1");
      expect(body).not.toContain("fixture:governed-synthetic");
      expect(traffic.external).toEqual([]);
    });

    test("PROOF 5 — no environment flag overrides the deployed refusal", async ({ page }) => {
      // This job deliberately sets NEXT_PUBLIC_APP_ENV and APP_RUNTIME_ENV
      // alongside CLINICAL_COPILOT_MODE=fixture. A client-shipped
      // NEXT_PUBLIC_* value can never re-open the fixture path, and setting
      // the mode explicitly does not either — a deployed process has to be
      // reconfigured, not persuaded.
      await setScenario("approved_synthetic");
      await openCopilot(page);
      await expect(page.getByTestId("copilot-posture-unavailable")).toBeVisible();

      // The run path refuses on the same grounds, not just the status panel.
      await page.getByTestId("copilot-run").click();
      await expect(page.getByTestId("copilot-error")).toBeVisible();
      const body = (await page.textContent("body")) ?? "";
      expect(body).not.toContain("fixture-copilot-v1");

      const after = await effects();
      expect(after.runs.every((r) => r.status !== "completed")).toBe(true);
    });
  },
);

/* ===================================================================== */
/* DEPLOYED + LIVE + approved_for_synthetic — the categorical refusal      */
/* ===================================================================== */

test.describe(
  DEPLOYED_LIVE_MODE
    ? "governed synthetic refused in a deployed runtime"
    : "skip: deployed governed-synthetic refusal (other jobs)",
  () => {
    test.skip(!DEPLOYED_LIVE_MODE, "covered by the e2e-copilot-deployed-live CI job");

    test("PROOF 4b — approved_for_synthetic produces nothing in a deployed runtime", async ({
      page,
    }) => {
      // The organization has the governed record. The registry row is
      // `synthetic_fixture`, the activation is `approved_for_synthetic`, the
      // snapshot carries no PHI, and the mode is `live` — every condition
      // that makes the synthetic provider reachable locally. The ONLY
      // difference from the passing live_local job is that this server
      // carries deployment markers, and that alone must be decisive.
      const traffic = assertNoExternalTraffic(page);
      await setScenario("approved_synthetic");
      const access = await openCopilotOrExpectWorkforceDenial(page);

      if (access === "panel") {
        // If this isolated test build renders its fixture shell, the
        // deployed-runtime guard must still keep the provider unavailable.
        await expect(page.getByTestId("copilot-posture-state")).not.toHaveText("fixture_test_mode");
        const detail = (await page.getByTestId("copilot-posture-detail").textContent()) ?? "";
        expect(detail).toMatch(/not available in this runtime/i);
        expect(detail).toMatch(/no example content is shown/i);
        await runOnce(page);
        await expect(page.getByTestId("copilot-status")).toContainText("unavailable");
      }

      // Whether workforce auth refuses the page first or the isolated shell
      // renders its refusal panel, no synthetic content can be produced.
      const body = (await page.textContent("body")) ?? "";
      expect(body).not.toContain("fixture-copilot-v1");
      expect(body).not.toContain("fixture:governed-synthetic");
      await expect(page.getByText("Draft (JSON, structural only)")).toHaveCount(0);

      // Nothing synthetic was persisted either.
      const after = await effects();
      expect(after.runs.every((r) => r.status !== "completed")).toBe(true);
      expect(after.runs.every((r) => r.outputHash === null)).toBe(true);
      expect(traffic.external).toEqual([]);
    });

    test("PROOF 4c — the adversarial synthetic identity is equally unreachable", async ({
      page,
    }) => {
      // A distinctly-named registry row is still just a row. The refusal is
      // about the runtime, so it cannot be routed around by registering a
      // different synthetic provider.
      await setScenario("approved_synthetic_adversarial");
      const access = await openCopilotOrExpectWorkforceDenial(page);
      if (access === "panel") {
        await runOnce(page);
        await expect(page.getByTestId("copilot-status")).toContainText("unavailable");
      }
      const body = (await page.textContent("body")) ?? "";
      expect(body).not.toContain("fixture:governed-synthetic-adversarial");
      expect(body).not.toContain("hallucinated-reference-not-in-envelope");
    });

    test("PROOF 19 — no secret, ARN, auth header, or prompt reaches the browser", async ({
      page,
    }) => {
      await setScenario("approved_synthetic");
      await openCopilotOrExpectWorkforceDenial(page);
      await assertBundleIsClean(page);
    });
  },
);

/**
 * PROOF 19 — nothing secret-shaped is reachable from the browser.
 *
 * The proof has two halves, and they are about two different artifacts:
 *
 *   RUNTIME  — what this application PRODUCED for this page: the rendered
 *              DOM and the copilot API response bodies. Checked in every
 *              posture, including the dev-server job.
 *   SHIPPED  — what the build EMITTED: every loaded script body. Checked
 *              wherever the server is a production build, which is three
 *              of the four CI jobs, and independently by
 *              `npm run check:clinical-bundle` in the `checks` job.
 *
 * The split is not a relaxation. `next dev` serves unminified modules with
 * their source COMMENTS intact, so a comment in `src/adapters/index.ts`
 * that merely mentions the words "service_role worker boundary" appears in
 * a dev chunk and in no production chunk. Scanning dev chunks therefore
 * measures the wrong artifact: it fails on prose that is never shipped
 * while proving nothing about what is. The shipped half runs against the
 * build it is actually about.
 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["OpenAI key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["bearer header", /Authorization:\s*Bearer\s+\S+/i],
  ["secrets ARN value", /arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["AWS signature", /AWS4-HMAC-SHA256/],
  ["service role key", /service_role/],
  ["system prompt body", /You are a governed clinical copilot/],
];

/** True unless this job deliberately runs `next dev`. */
const PRODUCTION_BUILD = process.env.E2E_DEV_SERVER !== "1";

async function assertBundleIsClean(page: Page): Promise<void> {
  // --- RUNTIME half: what the application produced, in every posture.
  const rendered = await page.evaluate(() => document.body.innerText);
  const apiBody = await page.evaluate(async () => {
    try {
      return await (await fetch("/api/live/copilot/provider-status")).text();
    } catch {
      return "";
    }
  });
  for (const [label, pattern] of FORBIDDEN) {
    expect(
      `${rendered}\n${apiBody}`,
      `${label} must not appear in the rendered page or an API response`,
    ).not.toMatch(pattern);
  }

  if (!PRODUCTION_BUILD) return;

  // --- SHIPPED half: what the build emitted.
  const html = await page.content();
  const scriptBodies = await page.evaluate(async () => {
    const srcs = Array.from(document.querySelectorAll("script[src]"))
      .map((s) => (s as HTMLScriptElement).src)
      .filter((s) => s.startsWith(window.location.origin));
    const inline = Array.from(document.querySelectorAll("script:not([src])")).map(
      (s) => s.textContent ?? "",
    );
    const fetched = await Promise.all(
      srcs.map(async (src) => {
        try {
          return await (await fetch(src)).text();
        } catch {
          return "";
        }
      }),
    );
    return [...inline, ...fetched].join("\n");
  });

  const haystack = `${html}\n${scriptBodies}`;
  for (const [label, pattern] of FORBIDDEN) {
    expect(haystack, `${label} must not be reachable from the browser`).not.toMatch(pattern);
  }
}
