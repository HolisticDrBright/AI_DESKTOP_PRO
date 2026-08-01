import { NextRequest } from "next/server";
import { productCatalogLive } from "@/adapters/product-catalog.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — the governed product catalog list, its counts, and the review queue. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      query?: unknown;
      status?: unknown;
      limit?: unknown;
    };
    const session = await getRequestSession();
    return productCatalogLive.list(
      {
        query: typeof b.query === "string" ? b.query : null,
        status: typeof b.status === "string" ? b.status : null,
        limit: typeof b.limit === "number" ? b.limit : null,
      },
      null,
      session.token,
    );
  });
}
