import { NextRequest } from "next/server";
import { frontDeskLive } from "@/adapters/frontdesk.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import type { LiveAppointmentStatus } from "@/adapters/live-types";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { appointmentId, toStatus, reason, expectedVersion? }
 * The admin-only correction path out of a terminal status. A reason is
 * mandatory here as well as in the RPC.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.appointmentId !== "string" || !b.appointmentId) {
      throw new AdapterError("invalid", "An appointment id is required.");
    }
    if (typeof b.toStatus !== "string") {
      throw new AdapterError("invalid", "A target status is required.");
    }
    if (typeof b.reason !== "string" || !b.reason.trim()) {
      throw new AdapterError("invalid", "A correction reason is required.");
    }
    const session = await getRequestSession();
    return frontDeskLive.correct(
      {
        appointmentId: b.appointmentId,
        toStatus: b.toStatus as LiveAppointmentStatus,
        reason: b.reason,
        expectedVersion: typeof b.expectedVersion === "number" ? b.expectedVersion : null,
      },
      session.token,
    );
  });
}
