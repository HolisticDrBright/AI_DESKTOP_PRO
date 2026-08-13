import { NextRequest } from "next/server";
import { protocolTemplateLive } from "@/adapters/product-catalog.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const OUTCOMES = ["passed", "concerns", "blocked"] as const;

/**
 * POST — append a safety review.
 *
 * Append, never set: the underlying table refuses UPDATE and DELETE, so a
 * changed conclusion becomes a new review and the earlier one stays readable.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      versionId?: unknown;
      outcome?: unknown;
      note?: unknown;
    };
    if (typeof b.versionId !== "string" || !b.versionId) {
      throw new AdapterError("invalid", "A template version id is required.");
    }
    if (
      typeof b.outcome !== "string" ||
      !(OUTCOMES as readonly string[]).includes(b.outcome)
    ) {
      throw new AdapterError(
        "invalid",
        "A safety review outcome must be passed, concerns or blocked.",
      );
    }
    if (typeof b.note !== "string" || !b.note.trim()) {
      throw new AdapterError(
        "invalid",
        "Say what you checked. A safety review with no note records nothing.",
      );
    }
    const session = await getRequestSession();
    return protocolTemplateLive.recordSafetyReview(
      b.versionId,
      b.outcome as (typeof OUTCOMES)[number],
      b.note,
      session.token,
    );
  });
}
