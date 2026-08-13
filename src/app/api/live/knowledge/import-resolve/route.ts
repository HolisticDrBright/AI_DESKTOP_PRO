import { NextRequest } from "next/server";
import { knowledgeImportLive } from "@/adapters/knowledge-import.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const RESOLUTIONS = ["keep_existing", "take_incoming", "skip"] as const;

/** POST — resolve one import conflict. A reason is mandatory. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.itemId !== "string" || !b.itemId) {
      throw new AdapterError("invalid", "An item id is required.");
    }
    if (
      typeof b.resolution !== "string" ||
      !RESOLUTIONS.includes(b.resolution as (typeof RESOLUTIONS)[number])
    ) {
      throw new AdapterError(
        "invalid",
        "Resolution must be keep_existing, take_incoming or skip.",
      );
    }
    if (typeof b.note !== "string" || !b.note.trim()) {
      throw new AdapterError(
        "invalid",
        "A conflict resolution requires a reason.",
      );
    }
    const session = await getRequestSession();
    return knowledgeImportLive.resolveConflict(
      b.itemId,
      b.resolution as (typeof RESOLUTIONS)[number],
      b.note,
      session.token,
    );
  });
}
