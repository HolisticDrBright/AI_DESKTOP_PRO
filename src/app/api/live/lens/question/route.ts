import { NextRequest } from "next/server";
import {
  lensLive,
  type QuestionFeedbackKind,
  type QuestionLifecycleAction,
} from "@/adapters/lens.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const LIFECYCLE: QuestionLifecycleAction[] = ["accepted", "asked", "deferred", "skipped"];
const FEEDBACK_KINDS: QuestionFeedbackKind[] = [
  "helpful", "not_relevant", "unsafe", "incorrect", "duplicate", "other",
];

/** GET ?questionId= → every answer version (corrections preserve originals). */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const questionId = req.nextUrl.searchParams.get("questionId");
    if (!questionId) throw new AdapterError("invalid", "A question is required.");
    const session = await getRequestSession();
    return lensLive.answers(questionId, session.token);
  });
}

/**
 * POST { action: status | dismiss | answer | correctAnswer | noteUse | feedback, ... }
 * Accepting a question NEVER writes into a note — `noteUse` is the separate,
 * explicit, audited add-to-note action.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const questionId = typeof body.questionId === "string" ? body.questionId : "";
    if (!questionId) throw new AdapterError("invalid", "A question is required.");
    const session = await getRequestSession();

    if (action === "status") {
      const to = typeof body.to === "string" ? body.to : "";
      if (!LIFECYCLE.includes(to as QuestionLifecycleAction)) {
        throw new AdapterError("invalid", "Choose a valid question action.");
      }
      const reason = typeof body.reason === "string" && body.reason ? body.reason : undefined;
      return lensLive.questionAction(
        { questionId, action: to as QuestionLifecycleAction, reason },
        session.token,
      );
    }

    if (action === "dismiss") {
      const feedbackKind = typeof body.feedbackKind === "string" ? body.feedbackKind : "";
      if (!FEEDBACK_KINDS.includes(feedbackKind as QuestionFeedbackKind)) {
        throw new AdapterError("invalid", "Dismissing requires structured feedback.");
      }
      const comment = typeof body.comment === "string" && body.comment ? body.comment : undefined;
      return lensLive.dismiss(
        { questionId, feedbackKind: feedbackKind as QuestionFeedbackKind, comment },
        session.token,
      );
    }

    if (action === "answer" || action === "correctAnswer") {
      const value = body.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AdapterError("invalid", "An answer value is required.");
      }
      if (action === "answer") {
        return lensLive.answer({ questionId, value: value as Record<string, unknown> }, session.token);
      }
      const reason = typeof body.reason === "string" && body.reason ? body.reason : undefined;
      return lensLive.correctAnswer(
        { questionId, value: value as Record<string, unknown>, reason },
        session.token,
      );
    }

    if (action === "noteUse") {
      const noteId = typeof body.noteId === "string" ? body.noteId : "";
      if (!noteId) throw new AdapterError("invalid", "A draft note is required.");
      return lensLive.recordNoteUse({ questionId, noteId }, session.token);
    }

    if (action === "feedback") {
      const kind = typeof body.kind === "string" ? body.kind : "";
      if (!FEEDBACK_KINDS.includes(kind as QuestionFeedbackKind)) {
        throw new AdapterError("invalid", "Choose a feedback kind.");
      }
      const comment = typeof body.comment === "string" && body.comment ? body.comment : undefined;
      return lensLive.feedback({ questionId, kind: kind as QuestionFeedbackKind, comment }, session.token);
    }

    throw new AdapterError("invalid", "Unknown question action.");
  });
}
