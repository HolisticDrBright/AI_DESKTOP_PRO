import { getCopilotConfig } from "@/server/nutrition-copilot";
import type { LiveNutritionProviderStatus } from "@/adapters/live-types";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — the nutrition provider boundary as the browser is allowed to see it.
 *
 * The external food-database vendor (Passio) was retired. Consumer food lookup
 * is served by the V2 patient API's in-house USDA catalog; Desktop has no
 * outbound food-database boundary, so it reports "disabled" honestly rather
 * than implying an integration exists. No secret is ever included.
 */
export async function POST() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const copilot = getCopilotConfig();
    const status: LiveNutritionProviderStatus = {
      mode: "disabled",
      configured: false,
      problems: ["External food-database provider retired; consumer food lookup is served by the V2 in-house USDA catalog. Desktop has no food lookup boundary."],
      liveRequestExecuted: false,
      copilotEnabled: copilot.enabled,
      copilotProblems: copilot.problems,
    };
    return status;
  });
}
