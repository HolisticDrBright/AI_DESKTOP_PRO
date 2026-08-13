import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — revoke UNSPENT credit after a refund. A visit already received is
 * never clawed back, and never silently restored either.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.invoiceId !== "string" || !b.invoiceId) throw new Error("invoiceId is required");
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!reason) throw new Error("A revocation needs a reason.");
    const session = await getRequestSession();
    return plansLive.revokeForRefund({ invoiceId: b.invoiceId, reason }, session.orgId, session.token);
  });
}
