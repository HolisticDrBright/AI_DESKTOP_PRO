import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — raise a practitioner safety flag. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.planVersionId !== "string" || !b.planVersionId) {
      throw new Error("planVersionId is required");
    }
    if (typeof b.kind !== "string" || !b.kind) throw new Error("kind is required");
    if (typeof b.detail !== "string" || !b.detail.trim()) throw new Error("detail is required");
    const session = await getRequestSession();
    return nutritionLive.raiseSafetyFlag(
      {
        planVersionId: b.planVersionId,
        kind: b.kind,
        severity: b.severity === "blocking" ? "blocking" : "review",
        detail: b.detail,
      },
      session.orgId,
      session.token,
    );
  });
}
