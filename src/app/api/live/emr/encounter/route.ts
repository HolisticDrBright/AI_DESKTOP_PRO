import { NextRequest } from "next/server";
import { encountersLive } from "@/adapters/encounters.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const VISIT_TYPES = ["initial", "follow-up", "lab-review", "supplement", "telehealth", "acute", "administrative"];
const STATUSES = ["completed", "cancelled", "entered_in_error"];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** GET ?encounterId= → encounter + its notes. ?patientId= → encounter list. */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const encounterId = req.nextUrl.searchParams.get("encounterId");
    const patientId = req.nextUrl.searchParams.get("patientId");
    const session = await getRequestSession();
    if (encounterId) {
      if (!UUID.test(encounterId)) throw new AdapterError("invalid", "A valid encounter is required.");
      return encountersLive.get(encounterId, session.token);
    }
    if (patientId) {
      if (!UUID.test(patientId)) throw new AdapterError("invalid", "A valid patient is required.");
      return encountersLive.forPatient(patientId, session.token);
    }
    throw new AdapterError("invalid", "An encounter or patient is required.");
  });
}

/** POST { patientId, visitType, appointmentId? } → start (idempotent per appointment). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const patientId = typeof body.patientId === "string" ? body.patientId : "";
    const visitType = typeof body.visitType === "string" ? body.visitType : "follow-up";
    const appointmentId = typeof body.appointmentId === "string" && body.appointmentId ? body.appointmentId : undefined;
    if (!UUID.test(patientId)) throw new AdapterError("invalid", "A valid patient is required.");
    if (appointmentId && !UUID.test(appointmentId)) {
      throw new AdapterError("invalid", "A valid appointment is required.");
    }
    if (!VISIT_TYPES.includes(visitType)) throw new AdapterError("invalid", "Choose a valid visit type.");
    const session = await getRequestSession();
    return encountersLive.start({ patientId, visitType, appointmentId }, session.token, session.orgId);
  });
}

/** PATCH { encounterId, status, reason? } → explicit state transition. */
export async function PATCH(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const encounterId = typeof body.encounterId === "string" ? body.encounterId : "";
    const status = typeof body.status === "string" ? body.status : "";
    const reason = typeof body.reason === "string" && body.reason ? body.reason.trim() : undefined;
    if (!UUID.test(encounterId)) throw new AdapterError("invalid", "A valid encounter is required.");
    if (!STATUSES.includes(status)) throw new AdapterError("invalid", "Choose a valid status.");
    if (reason && reason.length > 500) throw new AdapterError("invalid", "This reason is too long.");
    const session = await getRequestSession();
    return encountersLive.setStatus(
      { encounterId, status: status as "completed" | "cancelled" | "entered_in_error", reason },
      session.token,
    );
  });
}
