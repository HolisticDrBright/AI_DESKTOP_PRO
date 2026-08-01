import { NextRequest } from "next/server";
import { knowledgeImportLive } from "@/adapters/knowledge-import.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — read a staged preview, including conflicts and reported removals. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { batchId?: unknown };
    if (typeof b.batchId !== "string" || !b.batchId) {
      throw new AdapterError("invalid", "A batch id is required.");
    }
    const session = await getRequestSession();
    return knowledgeImportLive.getPreview(b.batchId, session.token);
  });
}
