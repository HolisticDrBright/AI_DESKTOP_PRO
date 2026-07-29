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
    const str = (v: unknown, max = 128) => {
      if (typeof v !== "string") return undefined;
      const value = v.trim();
      if (!value || value.length > max) return undefined;
      return value;
    };

    const practitionerUserId = str(body.practitionerUserId, 64);
    const appointmentType = str(body.appointmentType, 32);
    const startsAtIso = str(body.startsAtIso, 64);
    const endsAtIso = str(body.endsAtIso, 64);
    if (typeof body.location === "string" && body.location.trim().length > 200) {
      throw new AdapterError("invalid", "Location must be 200 characters or fewer.");
    }
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
        patientId: str(body.patientId, 64),
        location: str(body.location, 200),
      },
      session.token,
      session.orgId,
    );
  });
}
