import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — pause, resume, complete or discontinue a plan. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.planId !== "string" || !b.planId) throw new AdapterError("invalid", "planId is required");
    const allowed = ["pause", "resume", "complete", "discontinue"];
    if (typeof b.action !== "string" || !allowed.includes(b.action)) {
      throw new AdapterError("invalid", "action must be pause, resume, complete or discontinue");
    }
    if (b.action === "discontinue" && (typeof b.reason !== "string" || !b.reason.trim())) {
      throw new AdapterError("invalid", "discontinuing a plan requires a reason");
    }
    const session = await getRequestSession();
    return nutritionLive.setPlanLifecycle(
      { planId: b.planId, action: b.action, reason: typeof b.reason === "string" ? b.reason : null },
      session.orgId,
      session.token,
    );
  });
}
