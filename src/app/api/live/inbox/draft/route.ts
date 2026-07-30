import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { conversationId, body, messageId?, expectedVersion?, cancel? }.
 * The sender is the authenticated caller — there is nothing to spoof.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      conversationId?: unknown;
      body?: unknown;
      messageId?: unknown;
      expectedVersion?: unknown;
      cancel?: unknown;
    };
    const session = await getRequestSession();
    if (b.cancel === true) {
      if (typeof b.messageId !== "string" || !b.messageId) {
        throw new Error("messageId is required");
      }
      return inboxLive.cancelDraft(b.messageId, session.token);
    }
    if (typeof b.conversationId !== "string" || typeof b.body !== "string") {
      throw new Error("conversationId and body are required");
    }
    return inboxLive.saveDraft(
      {
        conversationId: b.conversationId,
        body: b.body,
        messageId: typeof b.messageId === "string" ? b.messageId : null,
        expectedVersion:
          typeof b.expectedVersion === "number" && Number.isFinite(b.expectedVersion)
            ? b.expectedVersion
            : null,
      },
      session.token,
    );
  });
}
