import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const ACTIONS = ["assign", "queue", "priority", "category", "status", "follow_up"] as const;
type Action = (typeof ACTIONS)[number];

/** POST { conversationId, action, expectedVersion, value?, at?, note? }. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      conversationId?: unknown;
      action?: unknown;
      expectedVersion?: unknown;
      value?: unknown;
      at?: unknown;
      note?: unknown;
    };
    if (typeof b.conversationId !== "string" || !ACTIONS.includes(b.action as Action)) {
      throw new Error("conversationId and a known action are required");
    }
    if (typeof b.expectedVersion !== "number" || !Number.isFinite(b.expectedVersion)) {
      throw new Error("expectedVersion is required");
    }
    const session = await getRequestSession();
    return inboxLive.workflow(
      {
        conversationId: b.conversationId,
        action: b.action as Action,
        expectedVersion: b.expectedVersion,
        value: typeof b.value === "string" ? b.value : null,
        at: typeof b.at === "string" ? b.at : null,
        note: typeof b.note === "string" ? b.note : null,
      },
      session.token,
    );
  });
}
