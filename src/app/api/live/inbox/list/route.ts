import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import type { LiveInboxFilters } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST LiveInboxFilters -> LiveInbox (persisted rows + persisted counts only). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as LiveInboxFilters;
    const session = await getRequestSession();
    return inboxLive.list(
      {
        query: typeof b.query === "string" && b.query.trim() ? b.query.trim() : null,
        category: b.category ?? null,
        priority: b.priority ?? null,
        status: b.status ?? null,
        queue: b.queue ?? null,
        assignedToMe: b.assignedToMe === true,
        unreadOnly: b.unreadOnly === true,
        dueOnly: b.dueOnly === true,
        limit: typeof b.limit === "number" && Number.isFinite(b.limit) ? b.limit : 50,
      },
      session.orgId,
      session.token,
    );
  });
}
