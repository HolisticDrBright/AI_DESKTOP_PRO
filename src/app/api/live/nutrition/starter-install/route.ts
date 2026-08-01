import { installStarterTemplates } from "@/adapters/nutrition.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — install the starter diet templates into this organization.
 *
 * Idempotent: a template whose content has not changed comes back `unchanged`
 * rather than gaining a version that differs in nothing.
 */
export async function POST() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const results = await installStarterTemplates(session.orgId, session.token);
    return { installed: results };
  });
}
