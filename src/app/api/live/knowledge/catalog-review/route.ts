import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** GET — imported products that are not usable yet, and why not. */
export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return importReviewLive.reviewQueue(session.orgId, session.token);
  });
}

/**
 * POST — clear a restriction, or complete a review.
 *
 * Two actions on one route because they are two answers to the same screen,
 * and both are refused by the database without a stated reason.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.productId !== "string" || !b.productId) {
      throw new AdapterError("invalid", "A product id is required.");
    }
    if (typeof b.note !== "string" || !b.note.trim()) {
      throw new AdapterError("invalid", "A stated reason is required.");
    }
    const session = await getRequestSession();
    if (b.action === "clear_restriction") {
      return importReviewLive.clearRestriction(b.productId, b.note, session.token);
    }
    if (b.action === "complete_review") {
      return importReviewLive.completeReview(b.productId, b.note, session.token);
    }
    throw new AdapterError(
      "invalid",
      "Action must be clear_restriction or complete_review.",
    );
  });
}
