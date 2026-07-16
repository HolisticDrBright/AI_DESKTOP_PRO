import { NextRequest } from "next/server";
import { scheduleLive } from "@/adapters/schedule.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { fromIso, toIso } -> appointments + practitioners in the window. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as { fromIso?: unknown; toIso?: unknown };
    const fromIso = typeof body.fromIso === "string" ? body.fromIso : "";
    const toIso = typeof body.toIso === "string" ? body.toIso : "";
    if (!fromIso || !toIso || Number.isNaN(Date.parse(fromIso)) || Number.isNaN(Date.parse(toIso))) {
      throw new AdapterError("invalid", "A valid date range is required.");
    }
    const session = await getRequestSession();
    return scheduleLive.getCalendar(fromIso, toIso, session.token);
  });
}
