import { NextRequest } from "next/server";
import { patientSyncLive } from "@/adapters/patient-sync.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { eventId, reason } -> manual retry of a failed/dead-letter event. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { eventId?: unknown; reason?: unknown };
    if (typeof b.eventId !== "string" || typeof b.reason !== "string") {
      throw new Error("eventId and reason are required");
    }
    const session = await getRequestSession();
    return patientSyncLive.retryEvent(b.eventId, b.reason, session.token);
  });
}
