import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import type { LivePlanType } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — assign a complimentary plan. The database requires the separate
 * comp.assign permission and a reason, and records a zero-amount invoice so
 * the gift is visible. It creates no clinical record.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.patientId !== "string" || !b.patientId) throw new Error("patientId is required");
    if (b.planType !== "package" && b.planType !== "membership") {
      throw new Error("planType must be package or membership");
    }
    if (typeof b.versionId !== "string" || !b.versionId) throw new Error("versionId is required");
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!reason) throw new Error("A complimentary assignment needs a reason.");
    const session = await getRequestSession();
    return plansLive.assignComplimentary(
      {
        patientId: b.patientId,
        planType: b.planType as LivePlanType,
        versionId: b.versionId,
        reason,
        expiresAt: typeof b.expiresAt === "string" ? b.expiresAt : null,
      },
      session.orgId,
      session.token,
    );
  });
}
