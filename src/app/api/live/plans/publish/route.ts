import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import type { LivePlanType } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — publish a draft version, freezing its terms permanently. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (b.planType !== "package" && b.planType !== "membership") {
      throw new Error("planType must be package or membership");
    }
    if (typeof b.versionId !== "string" || !b.versionId) {
      throw new Error("versionId is required");
    }
    const session = await getRequestSession();
    return plansLive.publishPlanVersion(
      { planType: b.planType as LivePlanType, versionId: b.versionId },
      session.orgId,
      session.token,
    );
  });
}
