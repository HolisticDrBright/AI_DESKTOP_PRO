import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — approve a version — refused by the database if safety is unresolved. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.planVersionId !== "string" || !b.planVersionId) {
      throw new AdapterError("invalid", "planVersionId is required");
    }
    const session = await getRequestSession();
    return nutritionLive.approvePlanVersion(
      { planVersionId: b.planVersionId, note: typeof b.note === "string" ? b.note : null },
      session.orgId,
      session.token,
    );
  });
}
