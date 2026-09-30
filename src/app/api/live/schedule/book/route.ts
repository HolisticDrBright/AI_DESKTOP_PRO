import { NextRequest } from "next/server";
import { scheduleLive } from "@/adapters/schedule.live";
import { AdapterError, isAdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** What to say when a practitioner's connected calendar is the reason, in their words. */
const EXTERNAL_CALENDAR_REFUSALS: ReadonlyArray<readonly [string, string]> = [
  ["external_busy_conflict",
    "Your connected calendar shows you are busy then. Pick another time, or change it in that calendar."],
  ["external_busy_unreadable",
    "Your connected calendar cannot be read right now, so this time could not be confirmed as free. Re-authorize it on the Calendar page, or disconnect it to book without it."],
  ["external_busy_stale",
    "Your connected calendar has not been checked recently enough to confirm this time. Refresh it on the Calendar page and try again."],
  ["external_busy_unknown",
    "Your connected calendar has not been checked for this time yet, so it could not be confirmed as free. Refresh it on the Calendar page and try again."],
];
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
    try {
      return await scheduleLive.book(
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
    } catch (error) {
      // A booking refused by the practitioner's own external calendar is not the same as
      // one refused by a clinic appointment, and it is certainly not the same as "we could
      // not tell". `detail` never crosses the wire, so the distinction has to be made here
      // as a safe message, or the screen tells them to pick another slot when the slot was
      // never the problem.
      const detail = isAdapterError(error)
        ? `${error.detail ?? ""} ${error.message}`
        : String(error instanceof Error ? error.message : error);
      const external = EXTERNAL_CALENDAR_REFUSALS.find(([name]) => detail.includes(name));
      if (external) throw new AdapterError("invalid", external[1], detail);
      throw error;
    }
  });
}
