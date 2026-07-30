import { NextRequest } from "next/server";
import { frontDeskLive } from "@/adapters/frontdesk.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import type { LiveAppointmentStatus } from "@/adapters/live-types";
import { liveGuard, runLive } from "../../route-helpers";

const STATUSES: LiveAppointmentStatus[] = [
  "confirmed", "arrived", "in_encounter", "completed", "cancelled", "no_show",
];

/** POST { appointmentId, toStatus, expectedVersion?, idempotencyKey?, reason? } */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.appointmentId !== "string" || !b.appointmentId) {
      throw new AdapterError("invalid", "An appointment id is required.");
    }
    if (!STATUSES.includes(b.toStatus as LiveAppointmentStatus)) {
      throw new AdapterError("invalid", "Unknown appointment status.");
    }
    const session = await getRequestSession();
    return frontDeskLive.transition(
      {
        appointmentId: b.appointmentId,
        toStatus: b.toStatus as LiveAppointmentStatus,
        expectedVersion: typeof b.expectedVersion === "number" ? b.expectedVersion : null,
        idempotencyKey: typeof b.idempotencyKey === "string" ? b.idempotencyKey : null,
        reason: typeof b.reason === "string" ? b.reason : null,
      },
      session.token,
    );
  });
}
