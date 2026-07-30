import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { reviewId, decision } — the human gate on AI suggestions. Accepting
 * applies category/priority/routing through the guarded workflow, copies a
 * draft response into the CALLER'S editable draft, or creates the task
 * idempotently. It can never send, resolve, refill, diagnose, or sign.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      reviewId?: unknown;
      decision?: unknown;
    };
    if (typeof b.reviewId !== "string" || (b.decision !== "accept" && b.decision !== "dismiss")) {
      throw new Error("reviewId and a decision are required");
    }
    const session = await getRequestSession();
    return inboxLive.reviewAiSuggestion(b.reviewId, b.decision, session.token);
  });
}
