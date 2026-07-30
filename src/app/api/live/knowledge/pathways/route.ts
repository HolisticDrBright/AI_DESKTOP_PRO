import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { knowledgeLive } from "@/adapters/knowledge.live";
import { liveGuard, runLive } from "../../route-helpers";

export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    if (!session.orgId) throw new AdapterError("forbidden", "An active organization is required.");
    return knowledgeLive.pathways(session.orgId, session.token);
  });
}
