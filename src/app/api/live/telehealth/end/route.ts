import { telehealthLive } from "@/adapters/telehealth.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST end -> visit record with flags + quick notes stored. */
export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AdapterError("invalid", "A JSON body is required.");
    }
    return telehealthLive.end(body as Parameters<typeof telehealthLive.end>[0], session.token);
  });
}
