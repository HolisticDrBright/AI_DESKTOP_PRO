import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — start a Stripe TEST-MODE card payment. This creates a PENDING row
 * and nothing more: no card data is collected, no processor is called from
 * the browser, and the response cannot report success. Settlement arrives
 * only through the service_role webhook boundary.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      invoiceId?: unknown;
      expectedVersion?: unknown;
      idempotencyKey?: unknown;
    };
    if (typeof b.invoiceId !== "string" || !b.invoiceId) {
      throw new Error("invoiceId is required");
    }
    if (typeof b.expectedVersion !== "number" || !Number.isFinite(b.expectedVersion)) {
      throw new Error("expectedVersion is required");
    }
    if (typeof b.idempotencyKey !== "string" || !b.idempotencyKey) {
      throw new Error("idempotencyKey is required");
    }
    const session = await getRequestSession();
    return billingLive.startCardPayment(
      {
        invoiceId: b.invoiceId,
        expectedVersion: b.expectedVersion,
        idempotencyKey: b.idempotencyKey,
      },
      session.orgId,
      session.token,
    );
  });
}
