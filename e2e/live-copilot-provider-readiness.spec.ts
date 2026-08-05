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
 * TWO RUNTIME POSTURES, BOTH EXERCISED IN CI
 * ------------------------------------------
 * The copilot's process-level mode is an environment posture that is fixed
 * when the server boots, so one server cannot show both the default-off
 * posture and the live state machine. CI therefore runs this file twice:
 *
 *   - job `e2e-live-fixture`      — default env (no CLINICAL_COPILOT_MODE).
 *                                   Runs the "default disabled posture" block.
 *   - job `e2e-copilot-readiness` — CLINICAL_COPILOT_MODE=live.
 *                                   Runs the "live state machine" block.
 *
 * Neither block is skipped in CI; each runs in the job whose posture it is
 * about, and the union covers every required proof. The guard below is a
 * posture selector, not a way to avoid running.
 *
 * WHY THE SYNTHETIC PROVIDER IS GOVERNED, NOT ENV-DRIVEN
 * ------------------------------------------------------
 * The e2e server runs `next start`, so NODE_ENV=production and the
 * deployed-runtime detector correctly refuses CLINICAL_COPILOT_MODE=fixture.
 * Rather than weaken that refusal to obtain browser coverage, the
 * deterministic provider is reached through the governed record the schema
 * already models: registry kind `synthetic_fixture` plus organization
 * activation `approved_for_synthetic`, with no PHI in the snapshot.
 *
 * ZERO EXTERNAL REQUESTS. Every test runs under `assertNoExternalTraffic`,
 * which fails the test if the browser attempts any host other than the
 * local app and the local fixture backend.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a live-flag build");

test.describe.configure({ mode: "serial" });

/**
 * The three postures are mutually exclusive, so exactly one describe block
 * runs per CI job. An earlier version keyed only on "is it live", which
 * meant the fixture job also ran the default-posture block and failed on a
 * screen that was behaving correctly.
 */
const COPILOT_MODE = (process.env.CLINICAL_COPILOT_MODE ?? "disabled").toLowerCase();
const LIVE_MODE = COPILOT_MODE === "live";
const FIXTURE_MODE = COPILOT_MODE === "fixture";
const DEFAULT_MODE = !LIVE_MODE && !FIXTURE_MODE;

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

async function runOnce(page: Page) {
  const next = (attempts.get(page) ?? 0) + 1;
  attempts.set(page, next);
  await page.getByTestId("copilot-run").click();
  await expect(page.getByTestId("copilot-run-identity")).toContainText(`attempt ${next}`);
}

test.beforeAll(resetBackend);

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

/**
 * PROOF 19 helper — nothing secret-shaped is reachable from the page.
 *
 * Checks the rendered DOM, every loaded script body, and the serialized
 * client payload. A single grep over `body` text would miss a key that was
 * inlined into a chunk, which is the way this actually leaks.
 */
async function assertBundleIsClean(page: Page): Promise<void> {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ["OpenAI key", /\bsk-[A-Za-z0-9_-]{16,}/],
    ["bearer header", /Authorization:\s*Bearer\s+\S+/i],
    ["secrets ARN value", /arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:/],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["AWS signature", /AWS4-HMAC-SHA256/],
    ["service role key", /service_role/],
    ["system prompt body", /You are a governed clinical copilot/],
  ];

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
