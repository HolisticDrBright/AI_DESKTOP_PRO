import { NextRequest } from "next/server";
import { tasksLive } from "@/adapters/tasks.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { itemId, note? } -> resolve the queue item + audit (atomic, idempotent). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as { itemId?: unknown; note?: unknown };
    if (typeof body.itemId !== "string" || !body.itemId) {
      throw new AdapterError("invalid", "A queue item id is required.");
    }
    const note = typeof body.note === "string" ? body.note : undefined;
    const session = await getRequestSession();
    return tasksLive.resolveItem(body.itemId, note, session.token);
  });
}
