import { NextRequest } from "next/server";
import { protocolsLive } from "@/adapters/protocols.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { query?, limit? } -> LiveCatalogSearch (real products, exact identity). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { query?: unknown; limit?: unknown };
    const query = typeof b.query === "string" && b.query.trim() ? b.query.trim() : null;
    const limit = typeof b.limit === "number" && Number.isFinite(b.limit) ? b.limit : 20;
    const session = await getRequestSession();
    return protocolsLive.searchCatalog(query, limit, session.orgId, session.token);
  });
}
