import { NextRequest } from "next/server";
import { reasoningLive } from "@/adapters/reasoning.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { hypothesisId, action, note? } -> LiveHypothesisReviewResult.
 * The RPC persists the review row, hypothesis state, and audit event in one
 * transaction. Accepting never inserts into a note or care plan.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      hypothesisId?: unknown;
      action?: unknown;
      note?: unknown;
    };
    if (typeof body.hypothesisId !== "string" || !body.hypothesisId) {
      throw new AdapterError("invalid", "A hypothesis id is required.");
    }
    if (
      body.action !== "accepted" &&
      body.action !== "rejected" &&
      body.action !== "needs_data"
    ) {
      throw new AdapterError("invalid", "Review action must be accepted, rejected, or needs_data.");
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      throw new AdapterError("invalid", "The review note must be text.");
    }
    const session = await getRequestSession();
    return reasoningLive.reviewHypothesis(
      body.hypothesisId,
      body.action,
      typeof body.note === "string" ? body.note : null,
      session.token,
    );
  });
}
