import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const OUTCOMES = ["completed", "arrived", "no_show", "late_cancel", "cancelled"];

/**
 * POST — settle a reserved credit after a visit outcome. What the outcome
 * MEANS is the organization's configured policy, not a default in this route.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.appointmentId !== "string" || !b.appointmentId) {
      throw new Error("appointmentId is required");
    }
    if (!OUTCOMES.includes(String(b.outcome))) {
      throw new Error("unknown appointment outcome");
    }
    const session = await getRequestSession();
    return plansLive.settleCredit(
      {
        appointmentId: b.appointmentId,
        outcome: String(b.outcome),
        reason: typeof b.reason === "string" ? b.reason : null,
      },
      session.orgId,
      session.token,
    );
  });
}
