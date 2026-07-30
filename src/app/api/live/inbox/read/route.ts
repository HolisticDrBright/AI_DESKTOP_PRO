import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { conversationId } -> mark unread inbound messages read (idempotent). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { conversationId?: unknown };
    if (typeof b.conversationId !== "string" || !b.conversationId) {
      throw new Error("conversationId is required");
    }
    const session = await getRequestSession();
    return inboxLive.markRead(b.conversationId, session.token);
  });
}
