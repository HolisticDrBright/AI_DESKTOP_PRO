import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../../route-helpers";
import { jsonBody } from "../../_shared";

/** POST sign -> practitioner notes + reviewed AI sections + action-item decisions, frozen; prior revision retained. */
export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const body = await jsonBody(request);
    return telehealthLive.signNote(body as unknown as Parameters<typeof telehealthLive.signNote>[0], session.token, session.orgId);
  });
}
