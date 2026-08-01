import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — mark a check-in reviewed or needing follow-up. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.checkinId !== "string" || !b.checkinId) throw new AdapterError("invalid", "checkinId is required");
    if (b.state !== "reviewed" && b.state !== "needs_followup") {
      throw new AdapterError("invalid", "state must be reviewed or needs_followup");
    }
    const session = await getRequestSession();
    return nutritionLive.reviewCheckin(
      { checkinId: b.checkinId, state: b.state },
      session.orgId,
      session.token,
    );
  });
}
