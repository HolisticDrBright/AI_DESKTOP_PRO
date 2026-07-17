import { NextRequest } from "next/server";
import { scribeLive } from "@/adapters/scribe.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const NOTE_TYPES = ["soap", "narrative", "follow_up", "adime", "patient_instructions"];

/** GET ?recordingId= → layered transcript (raw ASR / revisions / corrections), or null. */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const recordingId = req.nextUrl.searchParams.get("recordingId");
    if (!recordingId) throw new AdapterError("invalid", "A recording is required.");
    const session = await getRequestSession();
    const transcript = await scribeLive.transcript(recordingId, session.token);
    if (transcript) {
      // Viewing a transcript is a security-access event (separate log domain);
      // a logging failure must never block the clinical read.
      try {
        await scribeLive.logAccess({ transcriptId: transcript.transcriptId, kind: "accessed" }, session.token);
      } catch {
        console.error("[live] transcript access log failed");
      }
    }
    return transcript;
  });
}

/**
 * POST { action, ... }:
 *   correct { segmentId, correctedText, reason? }  → practitioner overlay
 *   review { transcriptId }                        → mark under review
 *   finalize { transcriptId }                      → freeze the transcript
 *   generateDraft { transcriptId, noteType }       → NEW proposed scribe note
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const session = await getRequestSession();

    if (action === "correct") {
      const segmentId = typeof body.segmentId === "string" ? body.segmentId : "";
      const correctedText = typeof body.correctedText === "string" ? body.correctedText.trim() : "";
      const reason = typeof body.reason === "string" && body.reason ? body.reason : undefined;
      if (!segmentId) throw new AdapterError("invalid", "A segment is required.");
      if (!correctedText) throw new AdapterError("invalid", "Corrected text is required.");
      return scribeLive.correctSegment({ segmentId, correctedText, reason }, session.token);
    }
    if (action === "review" || action === "finalize") {
      const transcriptId = typeof body.transcriptId === "string" ? body.transcriptId : "";
      if (!transcriptId) throw new AdapterError("invalid", "A transcript is required.");
      return action === "review"
        ? scribeLive.setReview(transcriptId, session.token)
        : scribeLive.finalizeTranscript(transcriptId, session.token);
    }
    if (action === "generateDraft") {
      const transcriptId = typeof body.transcriptId === "string" ? body.transcriptId : "";
      const noteType = typeof body.noteType === "string" ? body.noteType : "";
      if (!transcriptId) throw new AdapterError("invalid", "A transcript is required.");
      if (!NOTE_TYPES.includes(noteType)) throw new AdapterError("invalid", "Choose a note type.");
      return scribeLive.generateDraft({ transcriptId, noteType }, session.token);
    }
    throw new AdapterError("invalid", "Unknown transcript action.");
  });
}
