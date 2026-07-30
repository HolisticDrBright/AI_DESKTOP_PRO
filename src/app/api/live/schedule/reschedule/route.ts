import { NextRequest } from "next/server";
import { scheduleLive } from "@/adapters/schedule.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { appointmentId, startsAtIso, endsAtIso } -> audited reschedule. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const appointmentId =
      typeof body.appointmentId === "string" ? body.appointmentId.trim() : "";
    const startsAtIso =
      typeof body.startsAtIso === "string" ? body.startsAtIso.trim() : "";
    const endsAtIso =
      typeof body.endsAtIso === "string" ? body.endsAtIso.trim() : "";
    const startsAt = Date.parse(startsAtIso);
    const endsAt = Date.parse(endsAtIso);

    if (!appointmentId || appointmentId.length > 64) {
      throw new AdapterError("invalid", "An appointment id is required.");
    }
    if (
      !startsAtIso
      || !endsAtIso
      || Number.isNaN(startsAt)
      || Number.isNaN(endsAt)
      || endsAt <= startsAt
      || endsAt - startsAt > 8 * 60 * 60 * 1000
    ) {
      throw new AdapterError("invalid", "A valid appointment time is required.");
    }

    const session = await getRequestSession();
    return scheduleLive.reschedule(
      appointmentId,
      startsAtIso,
      endsAtIso,
      session.token,
    );
  });
}
