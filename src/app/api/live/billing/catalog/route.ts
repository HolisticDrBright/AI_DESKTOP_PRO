import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — products with stock, plus suppliers, locations, and tax rates. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      query?: unknown;
      kind?: unknown;
      supplierId?: unknown;
      locationId?: unknown;
      stockFilter?: unknown;
      includeArchived?: unknown;
      limit?: unknown;
    };
    const stockFilter = b.stockFilter === "low" || b.stockFilter === "out" ? b.stockFilter : null;
    const session = await getRequestSession();
    return billingLive.listCatalog(
      {
        query: typeof b.query === "string" && b.query ? b.query : null,
        kind: typeof b.kind === "string" && b.kind ? b.kind : null,
        supplierId: typeof b.supplierId === "string" ? b.supplierId : null,
        locationId: typeof b.locationId === "string" ? b.locationId : null,
        stockFilter,
        includeArchived: b.includeArchived === true,
        limit: typeof b.limit === "number" && Number.isFinite(b.limit) ? b.limit : 100,
      },
      session.orgId,
      session.token,
    );
  });
}
