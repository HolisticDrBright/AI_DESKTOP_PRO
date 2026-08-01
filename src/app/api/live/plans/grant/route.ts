import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — grant the entitlements a PAID invoice bought. Idempotent. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { invoiceId?: unknown };
    if (typeof b.invoiceId !== "string" || !b.invoiceId) throw new Error("invoiceId is required");
    const session = await getRequestSession();
    return plansLive.grantEntitlementsForInvoice(b.invoiceId, session.orgId, session.token);
  });
}
