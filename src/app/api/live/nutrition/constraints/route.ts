import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — replace the assessment constraints on a draft version. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.planVersionId !== "string" || !b.planVersionId) {
      throw new Error("planVersionId is required");
    }
    const session = await getRequestSession();
    return nutritionLive.setConstraints(
      { planVersionId: b.planVersionId, constraints: Array.isArray(b.constraints) ? b.constraints : [] },
      session.orgId,
      session.token,
    );
  });
}
