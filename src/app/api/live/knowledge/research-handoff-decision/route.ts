import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { knowledgeImportLive } from "@/adapters/knowledge-import.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — record ONE practitioner verdict on ONE research-handoff item.
 *
 * One item per call, by design: there is no bulk decision path on this
 * surface. The RPC keeps the item at 'needs_review' (a verdict is a
 * recorded claim, not an apply) and refuses without a substantive note.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      itemId?: unknown;
      verdict?: unknown;
      note?: unknown;
    };
    if (typeof body.itemId !== "string" || !body.itemId) {
      throw new AdapterError("invalid", "item_id_required");
    }
    if (body.verdict !== "verified" && body.verdict !== "blocked") {
      throw new AdapterError("invalid", "verdict_must_be_verified_or_blocked");
    }
    if (typeof body.note !== "string" || body.note.trim().length < 10) {
      throw new AdapterError("invalid", "substantive_note_required");
    }
    const session = await getRequestSession();
    return knowledgeImportLive.recordResearchHandoffReview(
      body.itemId,
      body.verdict,
      body.note.trim(),
      session.token,
    );
  });
}
