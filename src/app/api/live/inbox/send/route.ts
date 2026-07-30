import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import type { LiveMessageChannel } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { messageId, channel? } — fail-closed send. With no registered
 * provider the database returns an honest refusal and keeps the draft.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      messageId?: unknown;
      channel?: unknown;
      idempotencyKey?: unknown;
    };
    if (typeof b.messageId !== "string" || !b.messageId) {
      throw new Error("messageId is required");
    }
    const session = await getRequestSession();
    return inboxLive.send(
      {
        messageId: b.messageId,
        channel: typeof b.channel === "string" ? (b.channel as LiveMessageChannel) : undefined,
        idempotencyKey: typeof b.idempotencyKey === "string" ? b.idempotencyKey : null,
      },
      session.token,
    );
  });
}
