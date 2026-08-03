import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — resolve one ordinary import conflict.
 *
 * Three governed answers: keep_existing (the row already in the file wins),
 * take_incoming (the newer row wins and the earlier one is skipped), skip
 * (neither row applies). Each answer requires a stated reason, checked by
 * the RPC. Restrictions are preserved on every outcome — the resolver only
 * touches change_kind + status + review_note, never restricted_flags.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.itemId !== "string" || !b.itemId) {
      throw new AdapterError("invalid", "An item id is required.");
    }
    if (b.resolution !== "keep_existing" && b.resolution !== "take_incoming" && b.resolution !== "skip") {
      throw new AdapterError(
        "invalid",
        "Resolution must be keep_existing, take_incoming, or skip.",
      );
    }
    if (typeof b.note !== "string" || !b.note.trim()) {
      throw new AdapterError("invalid", "A stated reason is required.");
    }
    const session = await getRequestSession();
    return importReviewLive.resolveConflict(
      { itemId: b.itemId, resolution: b.resolution, note: b.note },
      session.token,
    );
  });
}
