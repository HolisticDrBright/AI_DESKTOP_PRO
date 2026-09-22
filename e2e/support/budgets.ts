/**
 * How long a browser assertion may wait, in one place.
 *
 * Under `E2E_DEV_SERVER=1` the app is served by `next dev`, so the first navigation to a route compiles it, and by the
 * end of a 300-test single-process battery that one dev server is carrying several GiB of heap and compiles slowly.
 * These budgets exist to cover that, not to tolerate flake: `retries` stays 0 and no assertion is relaxed, an app that
 * renders the wrong thing still fails — just later. Specs that need a longer wait for a particular step import the same
 * numbers rather than writing their own, so raising the budget once raises it everywhere it means the same thing.
 */
const DEV_SERVER = process.env.E2E_DEV_SERVER === "1";

/** Every `expect(...)` retry budget, and the default for a spec's own explicit timeout. */
export const EXPECT_TIMEOUT_MS = DEV_SERVER ? 45_000 : 5_000;

/** A whole test, which has to fit several of the above. */
export const TEST_TIMEOUT_MS = DEV_SERVER ? 120_000 : 30_000;
