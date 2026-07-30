import { NextRequest } from "next/server";
import { protocolsLive } from "@/adapters/protocols.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { includeArchived? } -> org protocol templates. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { includeArchived?: unknown };
    const session = await getRequestSession();
    return protocolsLive.listTemplates(
      b.includeArchived === true,
      session.orgId,
      session.token,
    );
  });
}
