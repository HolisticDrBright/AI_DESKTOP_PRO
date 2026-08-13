import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — append an amendment beside a frozen version. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.planVersionId !== "string" || !b.planVersionId) {
      throw new AdapterError("invalid", "planVersionId is required");
    }
    if (typeof b.body !== "string" || !b.body.trim()) throw new AdapterError("invalid", "body is required");
    if (typeof b.reason !== "string" || !b.reason.trim()) throw new AdapterError("invalid", "reason is required");
    const session = await getRequestSession();
    return nutritionLive.addAmendment(
      { planVersionId: b.planVersionId, body: b.body, reason: b.reason },
      session.orgId,
      session.token,
    );
  });
}
