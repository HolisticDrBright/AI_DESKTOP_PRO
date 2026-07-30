import { NextRequest } from "next/server";
import { protocolsLive } from "@/adapters/protocols.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { itemId, note? } -> LiveInteractionReviewResult.
 * The practitioner's explicit interaction sign-off. The database refuses this
 * on anything but a draft version and audits every recorded review.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { itemId?: unknown; note?: unknown };
    if (typeof b.itemId !== "string" || !b.itemId) {
      throw new AdapterError("invalid", "A protocol item id is required.");
    }
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
    const session = await getRequestSession();
    return protocolsLive.reviewItemInteractions(b.itemId, note, session.token);
  });
}
