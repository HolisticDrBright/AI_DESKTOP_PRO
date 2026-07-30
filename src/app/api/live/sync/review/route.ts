import { NextRequest } from "next/server";
import { patientSyncLive } from "@/adapters/patient-sync.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { eventId, action: accept|reject, note? }  -> review inbound data, OR
 * POST { inboundEventId, overlay, reason }        -> record a correction overlay.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      eventId?: unknown;
      action?: unknown;
      note?: unknown;
      inboundEventId?: unknown;
      overlay?: unknown;
      reason?: unknown;
    };
    const session = await getRequestSession();
    if (typeof b.inboundEventId === "string") {
      if (typeof b.reason !== "string" || typeof b.overlay !== "object" || b.overlay === null) {
        throw new Error("overlay and reason are required for a correction");
      }
      return patientSyncLive.recordCorrection(
        {
          inboundEventId: b.inboundEventId,
          overlay: b.overlay as Record<string, unknown>,
          reason: b.reason,
        },
        session.token,
      );
    }
    if (typeof b.eventId !== "string" || (b.action !== "accept" && b.action !== "reject")) {
      throw new Error("eventId and action are required");
    }
    return patientSyncLive.reviewInbound(
      {
        eventId: b.eventId,
        action: b.action,
        note: typeof b.note === "string" ? b.note : null,
      },
      session.token,
    );
  });
}
