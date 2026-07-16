import { NextRequest } from "next/server";
import { labsLive } from "@/adapters/labs.live";
import { AdapterError } from "@/adapters/errors";
import type { ReviewDecision } from "@/adapters/live-types";
import { liveGuard, runLive } from "../../route-helpers";

const DECISIONS: ReviewDecision[] = ["accepted", "flagged", "rejected"];

/** POST { observationId, decision, note? } -> review the marker + audit (atomic). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      observationId?: unknown;
      decision?: unknown;
      note?: unknown;
    };
    if (typeof body.observationId !== "string" || !body.observationId) {
      throw new AdapterError("invalid", "A marker id is required.");
    }
    if (typeof body.decision !== "string" || !DECISIONS.includes(body.decision as ReviewDecision)) {
      throw new AdapterError("invalid", "That review action isn't recognized.");
    }
    const note = typeof body.note === "string" ? body.note : undefined;
    return labsLive.reviewMarker(body.observationId, body.decision as ReviewDecision, note);
  });
}
