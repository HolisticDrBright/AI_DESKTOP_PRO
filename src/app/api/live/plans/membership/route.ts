import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import type { LiveMembershipAction } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const ACTIONS: LiveMembershipAction[] = [
  "pause", "resume", "cancel_at_period_end", "cancel_now", "reactivate",
];

/** POST — move a patient membership through its lifecycle. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.patientMembershipId !== "string" || !b.patientMembershipId) {
      throw new Error("patientMembershipId is required");
    }
    if (!ACTIONS.includes(b.action as LiveMembershipAction)) {
      throw new Error("unknown membership action");
    }
    if (typeof b.expectedVersion !== "number" || !Number.isFinite(b.expectedVersion)) {
      throw new Error("expectedVersion is required");
    }
    const session = await getRequestSession();
    return plansLive.setMembershipLifecycle(
      {
        patientMembershipId: b.patientMembershipId,
        action: b.action as LiveMembershipAction,
        expectedVersion: b.expectedVersion,
        reason: typeof b.reason === "string" ? b.reason : null,
      },
      session.orgId,
      session.token,
    );
  });
}
