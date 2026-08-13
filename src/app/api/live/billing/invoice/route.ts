import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — one invoice with its lines, payments, refunds, and history. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { invoiceId?: unknown };
    if (typeof b.invoiceId !== "string" || !b.invoiceId) {
      throw new Error("invoiceId is required");
    }
    const session = await getRequestSession();
    return billingLive.getInvoice(b.invoiceId, session.orgId, session.token);
  });
}
