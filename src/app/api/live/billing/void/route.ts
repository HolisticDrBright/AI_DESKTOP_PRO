import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — void an UNPAID invoice with a reason, releasing its reservations.
 * A paid invoice is refused: refunds are the path once money has moved.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      invoiceId?: unknown;
      expectedVersion?: unknown;
      reason?: unknown;
    };
    if (typeof b.invoiceId !== "string" || !b.invoiceId) {
      throw new Error("invoiceId is required");
    }
    if (typeof b.expectedVersion !== "number" || !Number.isFinite(b.expectedVersion)) {
      throw new Error("expectedVersion is required");
    }
    const session = await getRequestSession();
    return billingLive.voidInvoice(
      {
        invoiceId: b.invoiceId,
        expectedVersion: b.expectedVersion,
        reason: typeof b.reason === "string" ? b.reason : "",
      },
      session.orgId,
      session.token,
    );
  });
}
