import { NextRequest } from "next/server";
import { scribeLive } from "@/adapters/scribe.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const CONTENT_TYPES = ["audio/webm", "audio/ogg", "audio/wav", "audio/mp4", "audio/mpeg"];

/**
 * GET ?recordingId= [&view=deletion] → recording status + transitions, or the
 * durable-deletion status (jobs, attempts, proof) for the verified-deletion UI.
 */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const recordingId = req.nextUrl.searchParams.get("recordingId");
    const encounterId = req.nextUrl.searchParams.get("encounterId");
    const session = await getRequestSession();
    if (encounterId) {
      // Recovery/second-tab discovery: recordings for the encounter, plus the
      // capture session of the newest live one (if any).
      const recordings = await scribeLive.recordingsForEncounter(encounterId, session.token);
      const live = recordings.find((r) =>
        ["authorized", "capturing", "paused", "uploading"].includes(r.status),
      );
      const captureSession = live ? await scribeLive.captureSession(live.id, session.token) : null;
      return { recordings, liveRecordingId: live?.id ?? null, captureSession };
    }
    if (!recordingId) throw new AdapterError("invalid", "A recording is required.");
    if (req.nextUrl.searchParams.get("view") === "deletion") {
      return scribeLive.deletionStatus(recordingId, session.token);
    }
    return scribeLive.recording(recordingId, session.token);
  });
}

/** POST { encounterId, contentType } → begin (server-authorized; provider server-resolved). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const encounterId = typeof body.encounterId === "string" ? body.encounterId : "";
    const contentType = typeof body.contentType === "string" ? body.contentType : "";
    if (!encounterId) throw new AdapterError("invalid", "An encounter is required.");
    if (!CONTENT_TYPES.includes(contentType)) throw new AdapterError("invalid", "Unsupported audio format.");
    const session = await getRequestSession();
    return scribeLive.beginRecording({ encounterId, contentType }, session.token);
  });
}

/**
 * PATCH { action, ... } — capture lifecycle:
 *   heartbeat { sessionId }            → consent revalidation + token rotation
 *   resume { sessionId }               → after a pause (late join, recovery)
 *   completionToken { sessionId }      → single-use completion authorization
 *   complete { recordingId, completionToken, durationMs } → finish the upload
 *   queue { recordingId }              → queue transcription
 *   requestDeletion { recordingId }    → durable deletion workflow
 */
export async function PATCH(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const session = await getRequestSession();

    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const recordingId = typeof body.recordingId === "string" ? body.recordingId : "";

    if (action === "heartbeat") {
      if (!sessionId) throw new AdapterError("invalid", "A capture session is required.");
      return scribeLive.heartbeat(sessionId, session.token);
    }
    if (action === "resume") {
      if (!sessionId) throw new AdapterError("invalid", "A capture session is required.");
      return scribeLive.resume(sessionId, session.token);
    }
    if (action === "completionToken") {
      if (!sessionId) throw new AdapterError("invalid", "A capture session is required.");
      return scribeLive.issueCompletionAuthorization(sessionId, session.token);
    }
    if (action === "complete") {
      const completionToken = typeof body.completionToken === "string" ? body.completionToken : "";
      const durationMs = Number(body.durationMs ?? 0);
      if (!recordingId) throw new AdapterError("invalid", "A recording is required.");
      if (!completionToken) throw new AdapterError("invalid", "A completion authorization is required.");
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new AdapterError("invalid", "A recording duration is required.");
      }
      return scribeLive.completeUpload({ recordingId, completionToken, durationMs }, session.token);
    }
    if (action === "queue") {
      if (!recordingId) throw new AdapterError("invalid", "A recording is required.");
      return scribeLive.queueTranscription(recordingId, session.token);
    }
    if (action === "requestDeletion") {
      if (!recordingId) throw new AdapterError("invalid", "A recording is required.");
      return scribeLive.requestDeletion(recordingId, session.token);
    }
    throw new AdapterError("invalid", "Unknown recording action.");
  });
}
