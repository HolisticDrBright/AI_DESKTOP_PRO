import { NextRequest } from "next/server";
import { programsLive } from "@/adapters/programs.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const KINDS = ["lesson_completed", "check_in", "quiz_response", "adherence"] as const;
type ProgressKind = (typeof KINDS)[number];

/**
 * POST { action: "record" | "review", ... }. Progress is append-only, only on
 * active enrollments, and only against the enrollment's pinned version.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      enrollmentId?: unknown;
      kind?: unknown;
      lessonId?: unknown;
      blockId?: unknown;
      payload?: unknown;
      needsReview?: unknown;
      progressId?: unknown;
    };
    const session = await getRequestSession();
    if (b.action === "record") {
      if (typeof b.enrollmentId !== "string" || !b.enrollmentId) {
        throw new Error("enrollmentId is required");
      }
      if (!KINDS.includes(b.kind as ProgressKind)) {
        throw new Error("unknown progress kind");
      }
      return programsLive.recordProgress(
        {
          enrollmentId: b.enrollmentId,
          kind: b.kind as ProgressKind,
          lessonId: typeof b.lessonId === "string" ? b.lessonId : null,
          blockId: typeof b.blockId === "string" ? b.blockId : null,
          payload:
            b.payload !== null && typeof b.payload === "object"
              ? (b.payload as Record<string, unknown>)
              : {},
          needsReview: b.needsReview === true,
        },
        session.token,
      );
    }
    if (b.action === "review") {
      if (typeof b.progressId !== "string" || !b.progressId) {
        throw new Error("progressId is required");
      }
      return programsLive.reviewProgress(b.progressId, session.token);
    }
    throw new Error("unknown progress action");
  });
}
