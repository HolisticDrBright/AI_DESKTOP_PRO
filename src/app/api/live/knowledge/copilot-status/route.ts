import { getProtocolCopilotConfig } from "@/server/protocol-copilot";
import type { LiveProtocolCopilotStatus } from "@/adapters/live-types";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — the protocol copilot boundary as the browser is allowed to see it.
 *
 * Reports whether it is enabled and, when it is not, why. No secret is ever
 * included; the problems are operator-facing configuration statements.
 */
export async function POST() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const config = getProtocolCopilotConfig();
    const status: LiveProtocolCopilotStatus = {
      enabled: config.enabled,
      problems: config.problems,
    };
    return status;
  });
}
