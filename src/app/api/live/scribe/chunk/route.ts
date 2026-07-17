import { NextRequest } from "next/server";
import { scribeLive } from "@/adapters/scribe.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const MAX_CHUNK_BYTES = 5 * 1024 * 1024;

/**
 * POST — one audio chunk (raw body). Headers: x-recording-id, x-capture-token.
 * The backend revalidates the bound authorization, the ACTIVE session, and
 * all-participant consent on EVERY chunk — a 409 from here means capture is
 * no longer authorized and the client must stop the recorder immediately.
 * Audio bytes pass through; they are never logged or persisted by this route.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const recordingId = req.headers.get("x-recording-id") ?? "";
    const captureToken = req.headers.get("x-capture-token") ?? "";
    if (!recordingId) throw new AdapterError("invalid", "A recording is required.");
    if (!captureToken) throw new AdapterError("invalid", "A capture authorization is required.");
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength === 0) throw new AdapterError("invalid", "Empty audio chunk.");
    if (bytes.byteLength > MAX_CHUNK_BYTES) throw new AdapterError("invalid", "The recording chunk was too large.");
    const session = await getRequestSession();
    return scribeLive.uploadChunk({ recordingId, captureToken, bytes }, session.token);
  });
}
