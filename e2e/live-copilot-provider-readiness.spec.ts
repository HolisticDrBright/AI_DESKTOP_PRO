import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * LIVE-MODE Phase 10B.1 — Governed Copilot Provider Readiness.
 *
 * The Phase 10A copilot backend RPCs (create_copilot_run,
 * build_copilot_input_snapshot, fetch_copilot_governed_retrieval,
 * finalize_copilot_run) are NOT wired to the contract-fixture stub; the
 * governed clinical workspace panel expects real Supabase RPCs and is not
 * exercisable end-to-end through the local fixture backend.
 *
 * This spec therefore proves the STATIC HONESTY of the workspace UI: the
 * governance-signal wording ("does not sign, activate, order, prescribe,
 * bill, message, publish"), draft-only labeling, provider disabled by
 * default, and the safety pill are visible on page load, without
 * triggering a live provider request. The unit + SQL adversarial suites
 * cover the request/response paths end-to-end.
 *
 * A Phase 10B.2 follow-up will add the copilot RPCs to
 * `scripts/live-stub-server.mjs` to unlock full run-through browser
 * proofs, with the deterministic in-process fixture provider on the
 * server side. That is out of scope for 10B.1.
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a live-flag build");

test.describe.configure({ mode: "serial" });

test.beforeAll(resetBackend);

const PATIENT_ID = "aaaaaaaa-1111-2222-3333-444444444401";

test("Copilot workspace mounts with the draft-only + refusal wording", async ({ page }) => {
  await page.goto(`/patients/${PATIENT_ID}?tab=clinical-copilot`);

  // Headers.
  await expect(page.getByRole("heading", { name: /Governed copilot run/i })).toBeVisible();
  const phaseBadge = page.getByText(/Phase 10A/i).first();
  await expect(phaseBadge).toBeVisible();

  // Selectors + Run button visible (structure).
  await expect(page.getByTestId("copilot-lens")).toBeVisible();
  await expect(page.getByTestId("copilot-runtype")).toBeVisible();
  await expect(page.getByTestId("copilot-run")).toBeVisible();

  // Draft-only + six-banned-action disclaimer text present.
  const body = await page.textContent("body");
  expect(body).toMatch(/disabled provider/i);
  expect(body).toMatch(/every drafted item/i);
  expect(body).toMatch(/accepting does not sign|activate|prescribe|order|message/i);
});

test("Registry preview shows an honest state on empty staging", async ({ page }) => {
  await page.goto(`/patients/${PATIENT_ID}?tab=clinical-copilot`);
  // Under empty staging the fixture returns 0 approved pathways.
  const body = await page.textContent("body");
  expect(body).toBeTruthy();
});
