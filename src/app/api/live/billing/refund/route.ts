import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — refund a manual payment with a reason. A refund NEVER restocks
 * inventory: returning goods is a separate, explicit decision recorded
 * through `billing/inventory` with a condition.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      paymentId?: unknown;
      amountMinor?: unknown;
      reason?: unknown;
      method?: unknown;
    };
    if (typeof b.paymentId !== "string" || !b.paymentId) {
      throw new Error("paymentId is required");
    }
    if (typeof b.amountMinor !== "number" || !Number.isFinite(b.amountMinor)) {
      throw new Error("amountMinor is required");
    }
    const session = await getRequestSession();
    return billingLive.refundPayment(
      {
        paymentId: b.paymentId,
        amountMinor: b.amountMinor,
        reason: typeof b.reason === "string" ? b.reason : "",
        method: typeof b.method === "string" ? b.method : null,
      },
      session.orgId,
      session.token,
    );
  });
}
