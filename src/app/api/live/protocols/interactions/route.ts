import { NextRequest } from "next/server";
import { protocolsLive } from "@/adapters/protocols.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { versionId } -> LiveInteractionCheck. Read-only; writes nothing. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { versionId?: unknown };
    if (typeof b.versionId !== "string" || !b.versionId) {
      throw new AdapterError("invalid", "A protocol version id is required.");
    }
    const session = await getRequestSession();
    return protocolsLive.checkInteractions(b.versionId, session.token);
  });
}
