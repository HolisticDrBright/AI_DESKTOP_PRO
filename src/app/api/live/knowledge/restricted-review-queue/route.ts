import { importReviewLive } from "@/adapters/import-review.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * GET — unified restricted-review queue across preview items, catalog
 * products, and governed knowledge references.
 *
 * Phase 9E-A.1 continuation. Every row carries a `subjectType`
 * discriminator so the workspace can label it correctly. The RPC
 * deliberately omits raw source text — that stays behind the preview
 * detail path with its own audit.
 */
export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return importReviewLive.restrictedReviewQueue(session.orgId, session.token);
  });
}
