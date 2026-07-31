import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — open a checkout draft for a patient. When an appointment is given,
 * the booked service joins the draft automatically if its type matches an
 * active catalog service by name; one live invoice per appointment.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      patientId?: unknown;
      appointmentId?: unknown;
      locationId?: unknown;
    };
    if (typeof b.patientId !== "string" || !b.patientId) {
      throw new Error("patientId is required");
    }
    const session = await getRequestSession();
    return billingLive.createDraft(
      {
        patientId: b.patientId,
        appointmentId: typeof b.appointmentId === "string" ? b.appointmentId : null,
        locationId: typeof b.locationId === "string" ? b.locationId : null,
      },
      session.orgId,
      session.token,
    );
  });
}
