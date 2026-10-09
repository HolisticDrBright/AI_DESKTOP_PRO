import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { jsonBody } from "../_shared";

/** POST end -> durable shutdown intent; `ended` only once the provider confirmed, else `ending` with the shutdown state. */
export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const body = await jsonBody(request);
    return telehealthLive.end(body as unknown as Parameters<typeof telehealthLive.end>[0], session.token, session.orgId);
  });
}
