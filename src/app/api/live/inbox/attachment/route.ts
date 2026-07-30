import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — register attachment METADATA only (no bytes, no URLs). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      conversationId?: unknown;
      fileName?: unknown;
      contentType?: unknown;
      byteSize?: unknown;
      messageId?: unknown;
    };
    if (typeof b.conversationId !== "string" || typeof b.fileName !== "string" || !b.fileName.trim()) {
      throw new Error("conversationId and fileName are required");
    }
    const session = await getRequestSession();
    return inboxLive.registerAttachment(
      {
        conversationId: b.conversationId,
        fileName: b.fileName.trim(),
        contentType: typeof b.contentType === "string" ? b.contentType : "application/octet-stream",
        byteSize:
          typeof b.byteSize === "number" && Number.isFinite(b.byteSize) ? b.byteSize : null,
        messageId: typeof b.messageId === "string" ? b.messageId : null,
      },
      session.token,
    );
  });
}
