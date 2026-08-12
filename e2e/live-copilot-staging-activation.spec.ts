import { expect, test, type Page, type Request } from "@playwright/test";
import { resetBackend, STUB_BASE } from "./support/backend";

/**
 * LIVE-MODE Phase 10B.2 — Controlled Live-Provider Staging Activation.
 *
 * Proves the operator governance surface and the patient-facing phase
 * statement through the REAL UI and the REAL API routes.
 *
 * WHAT THIS SUITE DOES NOT PROVE. It does not prove a real OpenAI call,
 * because none was made: this environment has no AWS credentials and no
 * OpenAI secret reference, so the bounded live verification is blocked on
 * an external prerequisite and is recorded as NOT RUN. Every assertion
 * below is about the controls that would gate such a call, and about the
 * honesty of the surfaces that describe it.
 *
 * ZERO EXTERNAL REQUESTS, asserted on every test.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a live-flag build");

/**
 * This surface is posture-independent — the governance screen reads
 * governed rows and reports process facts whatever the copilot's mode is.
 * It therefore runs in the DEFAULT-posture live job only, once, rather
 * than repeating identically in all four copilot jobs. It is not skipped
 * in CI; `e2e-live-fixture` matches it with its `live-` filter.
 */
const POSTURE = (process.env.E2E_COPILOT_POSTURE ?? "default").toLowerCase();
test.skip(POSTURE !== "default", "runs once, in the default-posture live job");

test.describe.configure({ mode: "serial" });

const GOVERNANCE_URL = "/settings/governance?tab=activation";
const PATIENT_ID = "aaaaaaaa-1111-2222-3333-444444444401";
const COPILOT_URL = `/patients/${PATIENT_ID}/labs?view=copilot`;

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);

function assertNoExternalTraffic(page: Page): { external: string[] } {
  const external: string[] = [];
  page.on("request", (req: Request) => {
    let host = "";
    try {
      host = new URL(req.url()).hostname;
    } catch {
      return;
    }
    if (!ALLOWED_HOSTS.has(host)) external.push(req.url());
  });
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

async function openGovernance(page: Page) {
  await page.goto(GOVERNANCE_URL);
  await expect(page.getByTestId("copilot-activation-screen")).toBeVisible();
}

test.beforeAll(async () => {
  await resetBackend();
  // Compile the route once so the first assertion is not racing a cold
  // `next dev` build. Harmless under `next start`.
  const base = `http://localhost:${process.env.E2E_PORT ?? 3114}`;
  for (const p of [GOVERNANCE_URL, "/api/live/copilot/governance"]) {
    try {
      await fetch(`${base}${p}`);
    } catch {
      /* the tests themselves report a genuinely broken route */
    }
  }
});

test.describe("AI governance — provider activation surface", () => {
  test("B2-UI-1 — the phase statement is unconditional and names its limits", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("approved_synthetic");
    await openGovernance(page);

    const banner = page.getByTestId("gov-phase-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/Synthetic staging verification only/i);
    await expect(banner).toContainText(/Real-patient use and production activation are\s+not available/i);
    await expect(banner).toContainText(/No compliance status and no provider\s+link is asserted/i);
    expect(traffic.external).toEqual([]);
  });

  test("B2-UI-2 — legal posture reads 'Not verified', never a green claim", async ({ page }) => {
    await setScenario("approved_synthetic");
    await openGovernance(page);

    // `unknown` must not be rendered as approval, and must be
    // distinguishable from `not_approved`.
    await expect(page.getByTestId("gov-posture-openai-baa")).toHaveAttribute("data-status", "unknown");
    await expect(page.getByTestId("gov-posture-openai-baa")).toContainText("Not verified");
    await expect(page.getByTestId("gov-posture-zdr-modified-abuse-monitoring")).toHaveAttribute(
      "data-status",
      "unknown",
    );

    const body = (await page.textContent("body")) ?? "";
    expect(body.toLowerCase()).not.toContain("hipaa-ready");
    expect(body.toLowerCase()).not.toContain("hipaa compliant");
    expect(body).not.toMatch(/\bprovider connected\b/i);
  });

  test("B2-UI-3 — environment and approved use default to the refusing values", async ({ page }) => {
    await setScenario("approved_synthetic");
    await openGovernance(page);
    await expect(page.getByTestId("gov-environment")).toHaveText("unset");
    await expect(page.getByTestId("gov-approved-use")).toHaveText("none");
    await expect(page.getByTestId("gov-data-scope")).toHaveText("synthetic only");
  });

  test("B2-UI-4 — the secret reference is reported as presence, never as a value", async ({ page }) => {
    await setScenario("approved_synthetic");
    await openGovernance(page);
    await expect(page.getByTestId("gov-has-secret-ref")).toHaveText(/^(yes|no)$/);

    // Nothing secret-shaped is reachable from the page or the API body.
    const rendered = await page.evaluate(() => document.body.innerText);
    const api = await page.evaluate(async () => {
      try {
        return await (await fetch("/api/live/copilot/governance")).text();
      } catch {
        return "";
      }
    });
    const haystack = `${rendered}\n${api}`;
    for (const [label, pattern] of [
      ["OpenAI key", /\bsk-[A-Za-z0-9_-]{16,}/],
      ["secrets ARN", /arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:/],
      ["kms uri", /kms:\/\//],
      ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
      ["bearer header", /Authorization:\s*Bearer\s+\S+/i],
      ["service role", /service_role/],
      ["system prompt", /You are a governed clinical copilot/],
    ] as Array<[string, RegExp]>) {
      expect(haystack, `${label} must not be reachable`).not.toMatch(pattern);
    }
  });

  test("B2-UI-5 — request and budget limits are displayed as facts", async ({ page }) => {
    await setScenario("approved_synthetic");
    await openGovernance(page);
    await expect(page.getByTestId("gov-budget-calls")).toContainText("/ 10");
    await expect(page.getByTestId("gov-budget-tokens")).toContainText("/ 50000");
    await expect(page.getByTestId("gov-budget-cost")).toContainText("/ $5.00");
    // Never transacted is stated as such, not left blank.
    await expect(page.getByTestId("gov-last-verification")).toHaveText("Never");
  });

  test("B2-UI-6 — the kill switch requires a reason in BOTH directions", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("approved_synthetic");
    await openGovernance(page);

    await expect(page.getByTestId("gov-kill-switch-state")).toHaveText("clear");
    // Release is disabled while the switch is already clear.
    await expect(page.getByTestId("gov-kill-switch-release")).toBeDisabled();

    // Engaging with no reason is refused client-side and never reaches the
    // server; the server refuses it too (B2.12 in the SQL suite).
    await page.getByTestId("gov-kill-switch-engage").click();
    await expect(page.getByTestId("gov-kill-switch-error")).toContainText(/reason is required/i);
    await expect(page.getByTestId("gov-kill-switch-state")).toHaveText("clear");
    expect(traffic.external).toEqual([]);
  });

  test("B2-UI-7 — engaging the kill switch blocks calls and is recorded in history", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("approved_synthetic");
    await openGovernance(page);

    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("gov-kill-switch-reason").fill("incident drill — phase 10B.2");
    await page.getByTestId("gov-kill-switch-engage").click();

    await expect(page.getByTestId("gov-kill-switch-state")).toContainText("new calls blocked");
    // Engage is now the disabled one; release is offered.
    await expect(page.getByTestId("gov-kill-switch-engage")).toBeDisabled();
    await expect(page.getByTestId("gov-kill-switch-release")).toBeEnabled();

    // The change is on the append-only history with its reason.
    const history = page.getByTestId("gov-history");
    await expect(history).toContainText("kill_switch_engaged");
    await expect(history).toContainText("incident drill — phase 10B.2");
    expect(traffic.external).toEqual([]);
  });

  test("B2-UI-8 — releasing the kill switch also demands a reason and is recorded", async ({ page }) => {
    await setScenario("approved_synthetic");
    await openGovernance(page);

    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("gov-kill-switch-reason").fill("engage for drill");
    await page.getByTestId("gov-kill-switch-engage").click();
    await expect(page.getByTestId("gov-kill-switch-state")).toContainText("blocked");

    // Releasing is the more consequential direction and is not cheaper.
    await page.getByTestId("gov-kill-switch-release").click();
    await expect(page.getByTestId("gov-kill-switch-error")).toContainText(/reason is required/i);
    await expect(page.getByTestId("gov-kill-switch-state")).toContainText("blocked");

    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("gov-kill-switch-reason").fill("drill complete — releasing");
    await page.getByTestId("gov-kill-switch-release").click();
    await expect(page.getByTestId("gov-kill-switch-state")).toHaveText("clear");
    await expect(page.getByTestId("gov-history")).toContainText("kill_switch_released");
  });

  test("B2-UI-9 — the build's request contract and governed models are shown", async ({ page }) => {
    await setScenario("approved_synthetic");
    await openGovernance(page);
    // Process facts, so an operator can see a mismatch between what was
    // approved and what is actually deployed.
    await expect(page.getByTestId("gov-contract-version")).toHaveText("10b2.responses.v1");
    await expect(page.getByTestId("gov-schema-version")).toHaveText("copilot_output_v1");
    await expect(page.getByTestId("gov-staging-posture")).toHaveText(/^(yes|no)$/);
  });
});

test.describe("the patient copilot states the phase limit", () => {
  test("B2-UI-10 — the chart panel says synthetic staging verification only", async ({ page }) => {
    const traffic = assertNoExternalTraffic(page);
    await setScenario("approved_synthetic");
    await page.goto(COPILOT_URL);
    await expect(page.getByRole("heading", { name: /Governed copilot run/i })).toBeVisible();

    const notice = page.getByTestId("copilot-phase-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/Synthetic staging verification only/i);
    await expect(notice).toContainText(/Real patient activation is not available/i);
    await expect(notice).toContainText(/may be used for the care of a real patient/i);
    expect(traffic.external).toEqual([]);
  });
});
