import { telehealthLive } from "@/adapters/telehealth.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST start -> { visit, session } for the embedded Zoom meeting; refused without consent. */
export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AdapterError("invalid", "A JSON body is required.");
    }
    return telehealthLive.start(body as Parameters<typeof telehealthLive.start>[0], session.token);
  });
}
