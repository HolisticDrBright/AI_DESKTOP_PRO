import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — restore spent credit. Refund authority + a reason are required. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.entitlementId !== "string" || !b.entitlementId) {
      throw new Error("entitlementId is required");
    }
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!reason) throw new Error("A manual restoration needs a reason.");
    const session = await getRequestSession();
    return plansLive.restoreCredit(
      {
        entitlementId: b.entitlementId,
        quantity: typeof b.quantity === "number" ? b.quantity : 1,
        reason,
      },
      session.orgId,
      session.token,
    );
  });
}
