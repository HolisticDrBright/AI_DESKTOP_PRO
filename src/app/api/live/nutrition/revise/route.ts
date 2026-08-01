import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — copy an approved version into a new draft, leaving it untouched. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.planVersionId !== "string" || !b.planVersionId) {
      throw new AdapterError("invalid", "planVersionId is required");
    }
    if (typeof b.reason !== "string" || !b.reason.trim()) throw new AdapterError("invalid", "reason is required");
    const session = await getRequestSession();
    return nutritionLive.revisePlanVersion(
      { planVersionId: b.planVersionId, reason: b.reason },
      session.orgId,
      session.token,
    );
  });
}
