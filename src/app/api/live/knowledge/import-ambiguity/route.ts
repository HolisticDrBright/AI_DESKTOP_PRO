import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — resolve an ambiguous row.
 *
 * The candidate check is the database's: `same_as_existing` must name a
 * product the row itself raised. Repeating that here would give two places to
 * change it and one place to forget.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.itemId !== "string" || !b.itemId) {
      throw new AdapterError("invalid", "An import item id is required.");
    }
    if (
      b.resolution !== "new_product"
      && b.resolution !== "same_as_existing"
      && b.resolution !== "skip"
    ) {
      throw new AdapterError(
        "invalid",
        "Resolution must be new_product, same_as_existing or skip.",
      );
    }
    if (typeof b.note !== "string" || !b.note.trim()) {
      throw new AdapterError("invalid", "Resolving an ambiguity requires a stated reason.");
    }
    const session = await getRequestSession();
    return importReviewLive.resolveAmbiguity(
      {
        itemId: b.itemId,
        resolution: b.resolution,
        note: b.note,
        existingProductId:
          typeof b.existingProductId === "string" ? b.existingProductId : null,
      },
      session.token,
    );
  });
}
