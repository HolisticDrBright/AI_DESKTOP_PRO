import { NextRequest } from "next/server";
import { scheduleLive } from "@/adapters/schedule.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const TYPES = ["initial", "follow-up", "lab-review", "supplement", "telehealth", "group", "break"];

/** POST { practitionerUserId, appointmentType, startsAtIso, endsAtIso, patientId?, location? } */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

    const practitionerUserId = str(body.practitionerUserId);
    const appointmentType = str(body.appointmentType);
    const startsAtIso = str(body.startsAtIso);
    const endsAtIso = str(body.endsAtIso);
    if (!practitionerUserId) throw new AdapterError("invalid", "A practitioner is required.");
    if (!appointmentType || !TYPES.includes(appointmentType)) {
      throw new AdapterError("invalid", "A valid appointment type is required.");
    }
    if (
      !startsAtIso ||
      !endsAtIso ||
      Number.isNaN(Date.parse(startsAtIso)) ||
      Number.isNaN(Date.parse(endsAtIso))
    ) {
      throw new AdapterError("invalid", "A valid time range is required.");
    }

    const session = await getRequestSession();
    return scheduleLive.book(
      {
        practitionerUserId,
        appointmentType,
        startsAtIso,
        endsAtIso,
        patientId: str(body.patientId),
        location: str(body.location),
      },
      session.token,
      session.orgId,
    );
  });
}
