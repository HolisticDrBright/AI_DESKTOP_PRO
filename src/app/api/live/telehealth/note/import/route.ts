import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../../route-helpers";
import { jsonBody } from "../../_shared";

/** POST import -> Zoom AI Companion summary stored as a NOT-REVIEWED note (unified summary kept as unreviewed text). */
export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const body = await jsonBody(request);
    return telehealthLive.importNote(String(body.appointmentId ?? ""), String(body.date ?? ""), String(body.timeZone ?? ""), session.token, session.orgId);
  });
}
