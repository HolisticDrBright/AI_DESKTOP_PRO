import { NextRequest } from "next/server";
import { patientSyncLive } from "@/adapters/patient-sync.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { eventId, reason, action? } — reasoned manual retry (default) or a
 * reasoned cancel/discard of queued/failed/dead-letter work.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      eventId?: unknown;
      reason?: unknown;
      action?: unknown;
    };
    if (typeof b.eventId !== "string" || typeof b.reason !== "string") {
      throw new Error("eventId and reason are required");
    }
    const session = await getRequestSession();
    if (b.action === "cancel") {
      return patientSyncLive.cancelEvent(b.eventId, b.reason, session.token);
    }
    return patientSyncLive.retryEvent(b.eventId, b.reason, session.token);
  });
}
