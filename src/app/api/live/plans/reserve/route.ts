import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — hold a credit for an appointment. A concurrent second reservation
 * for the same appointment is refused by a unique index, not by app logic.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.entitlementId !== "string" || !b.entitlementId) {
      throw new Error("entitlementId is required");
    }
    if (typeof b.appointmentId !== "string" || !b.appointmentId) {
      throw new Error("appointmentId is required");
    }
    const session = await getRequestSession();
    return plansLive.reserveCredit(
      {
        entitlementId: b.entitlementId,
        appointmentId: b.appointmentId,
        quantity: typeof b.quantity === "number" ? b.quantity : 1,
      },
      session.orgId,
      session.token,
    );
  });
}
