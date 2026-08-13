/**
 * Shared backend isolation for the E2E battery.
 *
 * Every spec calls `resetBackend()` in `beforeAll`. That single call is what
 * makes the canonical one-process battery order-independent: a suite always
 * runs against exactly the state it was written for, regardless of what ran
 * before it.
 *
 * Before this existed, each suite reset only its own domain, so the whole
 * battery in one process left every later suite reading rows an earlier one
 * created. The symptom was always a later suite's first "honest empty state"
 * assertion failing — a harness defect wearing the costume of a product defect.
 *
 * The fix is isolation, NOT weakened assertions and NOT a fixed running order.
 * The empty-state assertions are the point of those suites; a battery that only
 * passes in one sequence is a battery that has stopped testing sequence.
 */

export const STUB_BASE = process.env.E2E_STUB_BASE ?? "http://127.0.0.1:3999";

/**
 * Restore the contract-fixture backend to its process-start state.
 *
 * Throws rather than resolving quietly if the reset does not land: a silent
 * failure here would surface later as an unrelated suite failing, which is the
 * exact diagnosis problem this helper exists to remove.
 */
export async function resetBackend(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${STUB_BASE}/__control/reset-all`, { method: "POST" });
  } catch (cause) {
    throw new Error(
      `Could not reach the fixture backend at ${STUB_BASE} to reset it. ` +
        `Start it with \`node scripts/live-stub-server.mjs\` before running ` +
        `the live battery.`,
      { cause },
    );
  }
  if (!res.ok) {
    throw new Error(
      `Fixture backend reset failed with HTTP ${res.status}. The battery ` +
        `cannot be trusted to be order-independent without it, so this is a ` +
        `hard failure rather than a warning.`,
    );
  }
}
