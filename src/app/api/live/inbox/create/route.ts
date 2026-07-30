import { NextRequest } from "next/server";
import { inboxLive } from "@/adapters/inbox.live";
import type { LiveThreadCategory, LiveThreadPriority } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { patientId, subject, category?, priority? } -> new thread. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      patientId?: unknown;
      subject?: unknown;
      category?: unknown;
      priority?: unknown;
    };
    if (typeof b.patientId !== "string" || typeof b.subject !== "string" || !b.subject.trim()) {
      throw new Error("patientId and subject are required");
    }
    const session = await getRequestSession();
    return inboxLive.createThread(
      {
        patientId: b.patientId,
        subject: b.subject.trim(),
        category: typeof b.category === "string" ? (b.category as LiveThreadCategory) : undefined,
        priority: typeof b.priority === "string" ? (b.priority as LiveThreadPriority) : undefined,
      },
      session.orgId,
      session.token,
    );
  });
}
