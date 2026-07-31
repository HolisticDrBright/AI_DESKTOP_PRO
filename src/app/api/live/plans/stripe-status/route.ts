import { getStripeConfig, hasExecutedLiveTransaction } from "@/server/stripe-boundary";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — the Stripe boundary's real state, for an honest UI.
 *
 * `liveTransactionExecuted` is the important field: it is FALSE until this
 * deployment has actually completed a Stripe API transaction. Being
 * configured is not the same as having transacted, and no screen may present
 * configuration as proof that Stripe works.
 */
export async function POST() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const report = getStripeConfig();
    return {
      mode: report.mode,
      configured: report.configured,
      // Problem strings name VARIABLES, never their values.
      problems: report.problems,
      liveTransactionExecuted: hasExecutedLiveTransaction(),
    };
  });
}
