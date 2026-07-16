import { NextRequest } from "next/server";
import { scheduleLive } from "@/adapters/schedule.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const TARGETS = ["confirmed", "arrived", "completed", "cancelled", "no_show"];

/** POST { appointmentId, status } -> audited status transition. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      appointmentId?: unknown;
      status?: unknown;
    };
    if (typeof body.appointmentId !== "string" || !body.appointmentId) {
      throw new AdapterError("invalid", "An appointment id is required.");
    }
    if (typeof body.status !== "string" || !TARGETS.includes(body.status)) {
      throw new AdapterError("invalid", "That status change isn't recognized.");
    }
    const session = await getRequestSession();
    return scheduleLive.updateStatus(body.appointmentId, body.status, session.token);
  });
}
