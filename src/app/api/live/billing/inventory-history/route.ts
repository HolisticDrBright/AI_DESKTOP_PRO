import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — the append-only movement ledger for one product. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      productId?: unknown;
      locationId?: unknown;
      limit?: unknown;
    };
    if (typeof b.productId !== "string" || !b.productId) {
      throw new Error("productId is required");
    }
    const session = await getRequestSession();
    return billingLive.getInventoryHistory(
      {
        productId: b.productId,
        locationId: typeof b.locationId === "string" ? b.locationId : null,
        limit: typeof b.limit === "number" && Number.isFinite(b.limit) ? b.limit : 50,
      },
      session.orgId,
      session.token,
    );
  });
}
