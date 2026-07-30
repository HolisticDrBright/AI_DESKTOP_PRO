import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { messageId, encounterId, section? } -> unsigned draft note append. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      messageId?: unknown;
      encounterId?: unknown;
      section?: unknown;
    };
    if (typeof b.messageId !== "string" || typeof b.encounterId !== "string") {
      throw new Error("messageId and encounterId are required");
    }
    const session = await getRequestSession();
    return inboxLive.appendToNote(
      {
        messageId: b.messageId,
        encounterId: b.encounterId,
        section: typeof b.section === "string" ? b.section : "subjective",
      },
      session.token,
    );
  });
}
