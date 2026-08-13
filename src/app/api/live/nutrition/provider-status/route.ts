import { getCopilotConfig } from "@/server/nutrition-copilot";
import { getPassioConfig, hasExecutedLiveRequest } from "@/server/passio-boundary";
import type { LiveNutritionProviderStatus } from "@/adapters/live-types";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — the nutrition provider boundary as the browser is allowed to see it.
 *
 * Reports configuration and, separately, whether a request has ACTUALLY run.
 * Those are different facts, and conflating them is how a screen ends up
 * implying an integration is proven when nothing has ever been sent. No
 * licence key, customer id, or other secret is ever included.
 */
export async function POST() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const passio = getPassioConfig();
    const copilot = getCopilotConfig();
    const status: LiveNutritionProviderStatus = {
      mode: passio.mode,
      configured: passio.configured,
      problems: passio.problems,
      liveRequestExecuted: hasExecutedLiveRequest(),
      copilotEnabled: copilot.enabled,
      copilotProblems: copilot.problems,
    };
    return status;
  });
}
