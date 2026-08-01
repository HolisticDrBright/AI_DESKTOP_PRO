import { NextRequest } from "next/server";
import { productCatalogLive } from "@/adapters/product-catalog.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — one label in full.
 *
 * The response keeps the database's `clinical` / `commercial` split. It is not
 * merged here: a flat object is one spread away from an affiliate URL reaching
 * a clinical renderer.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { labelVersionId?: unknown };
    if (typeof b.labelVersionId !== "string" || !b.labelVersionId) {
      throw new AdapterError("invalid", "A label version id is required.");
    }
    const session = await getRequestSession();
    return productCatalogLive.labelDetail(b.labelVersionId, session.token);
  });
}
