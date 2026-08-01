import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — list the org template library. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { includeArchived?: unknown };
    const session = await getRequestSession();
    return nutritionLive.listTemplates(b.includeArchived === true, session.orgId, session.token);
  });
}
