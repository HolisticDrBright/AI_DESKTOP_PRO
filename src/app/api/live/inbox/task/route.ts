import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { messageId, title?, priority? } -> real review-queue task (idempotent). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      messageId?: unknown;
      title?: unknown;
      priority?: unknown;
    };
    if (typeof b.messageId !== "string" || !b.messageId) {
      throw new Error("messageId is required");
    }
    const session = await getRequestSession();
    return inboxLive.createTask(
      {
        messageId: b.messageId,
        title: typeof b.title === "string" ? b.title : null,
        priority:
          b.priority === "low" || b.priority === "high" ? b.priority : "medium",
      },
      session.token,
    );
  });
}
