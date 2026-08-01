import { NextRequest } from "next/server";
import { knowledgeImportLive } from "@/adapters/knowledge-import.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — abandon a staged batch. A reason is mandatory. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.batchId !== "string" || !b.batchId) {
      throw new AdapterError("invalid", "A batch id is required.");
    }
    if (typeof b.reason !== "string" || !b.reason.trim()) {
      throw new AdapterError("invalid", "A cancellation reason is required.");
    }
    const session = await getRequestSession();
    return knowledgeImportLive.cancel(b.batchId, b.reason, session.token);
  });
}
