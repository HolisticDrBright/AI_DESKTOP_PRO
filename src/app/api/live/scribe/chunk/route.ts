import { NextRequest } from "next/server";
import { scribeLive } from "@/adapters/scribe.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { BoundedBodyError, readBoundedRequestBody } from "@/server/bounded-request-body";
import { liveGuard, runLive } from "../../route-helpers";

const MAX_CHUNK_BYTES = 5 * 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;
const RECORDING_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

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
    if (!RECORDING_ID.test(recordingId)) throw new AdapterError("invalid", "A recording is required.");
    if (!captureToken.trim() || captureToken.length > 4096) throw new AdapterError("invalid", "A capture authorization is required.");
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    let bytes: ArrayBuffer;
    try { bytes = await readBoundedRequestBody(req, MAX_CHUNK_BYTES, BODY_READ_TIMEOUT_MS); }
    catch (error) {
      if (!(error instanceof BoundedBodyError)) throw error;
      if (error.reason === "too_large") throw new AdapterError("invalid", "The recording chunk was too large.");
      if (error.reason === "empty") throw new AdapterError("invalid", "Empty audio chunk.");
      if (error.reason === "invalid_length") throw new AdapterError("invalid", "The recording chunk length was invalid.");
      throw new AdapterError("unavailable", "The recording chunk was not fully received. No partial audio was forwarded.");
    }
    return scribeLive.uploadChunk({ recordingId, captureToken, bytes }, token);
  });
}
