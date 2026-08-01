import { NextRequest } from "next/server";
import { knowledgeImportLive } from "@/adapters/knowledge-import.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — read commercial disclosure for a label or protocol version.
 *
 * A SEPARATE route from every clinical read, on purpose. Commercial data
 * reaches the browser only when something explicitly asks for it, and it
 * arrives with the database's own disclaimer attached.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = await getRequestSession();

    if (typeof b.labelVersionId === "string" && b.labelVersionId) {
      return knowledgeImportLive.labelCommercialLinks(b.labelVersionId, session.token);
    }
    if (typeof b.protocolVersionId === "string" && b.protocolVersionId) {
      return knowledgeImportLive.protocolCommercialLinks(
        b.protocolVersionId,
        session.token,
      );
    }
    throw new AdapterError(
      "invalid",
      "Either a label version id or a protocol version id is required.",
    );
  });
}
