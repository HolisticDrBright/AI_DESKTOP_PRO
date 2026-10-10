import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { jsonBody } from "../_shared";

/** POST start -> { visit, session } for the embedded Zoom meeting; the appointment is resolved server-side and consent authority is checked by the boundary. */
export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const body = await jsonBody(request);
    return telehealthLive.start(body as unknown as Parameters<typeof telehealthLive.start>[0], session.token, session.orgId);
  });
}
