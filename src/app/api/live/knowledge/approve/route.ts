import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { knowledgeLive } from "@/adapters/knowledge.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as { versionId?: unknown };
    if (typeof body.versionId !== "string") {
      throw new AdapterError("invalid", "A pathway version is required.");
    }
    const session = await getRequestSession();
    if (!session.orgId) throw new AdapterError("forbidden", "An active organization is required.");
    return knowledgeLive.approve(session.orgId, body.versionId, session.token);
  });
}
