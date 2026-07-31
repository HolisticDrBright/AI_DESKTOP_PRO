import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — finalize a draft: assign its number and RESERVE tracked stock. A
 * concurrent checkout that would oversell is refused as a typed conflict;
 * stock never goes negative.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      invoiceId?: unknown;
      expectedVersion?: unknown;
    };
    if (typeof b.invoiceId !== "string" || !b.invoiceId) {
      throw new Error("invoiceId is required");
    }
    if (typeof b.expectedVersion !== "number" || !Number.isFinite(b.expectedVersion)) {
      throw new Error("expectedVersion is required");
    }
    const session = await getRequestSession();
    return billingLive.finalize(
      { invoiceId: b.invoiceId, expectedVersion: b.expectedVersion },
      session.orgId,
      session.token,
    );
  });
}
