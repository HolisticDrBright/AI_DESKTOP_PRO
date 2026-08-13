import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** GET — the append-only record of what an import created, and from where. */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const url = new URL(req.url);
    return importReviewLive.provenance(
      {
        refType: url.searchParams.get("refType"),
        refId: url.searchParams.get("refId"),
        limit: Number(url.searchParams.get("limit") ?? 50),
      },
      session.orgId,
      session.token,
    );
  });
}
