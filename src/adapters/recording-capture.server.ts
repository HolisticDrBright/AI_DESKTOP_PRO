if (typeof window !== 'undefined') throw new Error('Recording capture is server-only.');
import { createHash } from 'node:crypto';
import { AdapterError, codeFromHttpStatus } from './errors';
import { recordingCaptureRequestSchema, parseRecordingCaptureResponse } from '@/contracts/encounterRecordingCapture';
import { readBoundedRequestBody } from '@/server/bounded-request-body';

/** A distinct, configured capture service. Never falls back to the consent
 * endpoint, compatibility RPC or fixtures. Bearer identity is cookie-derived. */
export async function recordingCaptureRequest(input: unknown, token: string | null, bytes?: ArrayBuffer, signal?: AbortSignal) {
  if (!token) throw new AdapterError('unauthenticated');
  const parsed = recordingCaptureRequestSchema.safeParse(input);
  if (!parsed.success) throw new AdapterError('invalid');
  const q = parsed.data;
  if (q.operation === 'segment' ? !bytes || bytes.byteLength !== q.input.bytes
    || createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== q.input.sha256 : bytes !== undefined)
    throw new AdapterError('invalid');
  let origin: URL;
  try { origin = new URL(process.env.RECORDING_CAPTURE_AWS_API_ORIGIN ?? ''); }
  catch { throw new AdapterError('unavailable'); }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
    || origin.username || origin.password || origin.port
    || !/^[a-z0-9]{10}\.execute-api\.us-(east|west)-[12]\.amazonaws\.com$/.test(origin.hostname))
    throw new AdapterError('unavailable');
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(35000)]);
  const headers: Record<string, string> = { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' };
  if (q.operation === 'segment') Object.assign(headers, { 'Content-Type': q.input.contentType,
    'x-alp-recording-id': q.input.recordingId, 'x-alp-session-id': q.input.sessionId,
    'x-alp-capture-token': q.input.captureToken, 'x-alp-sequence': String(q.input.sequence), 'x-alp-sha256': q.input.sha256 });
  try {
    const response = await fetch(origin.origin + '/clinical-core/workforce/encounter-recording/' + q.operation, {
      method: 'POST', headers, body: q.operation === 'segment' ? bytes : JSON.stringify(q.input),
      cache: 'no-store', redirect: 'error', signal: requestSignal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new AdapterError(response.status === 409 ? 'conflict' : codeFromHttpStatus(response.status));
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      void response.body?.cancel().catch(() => {});
      throw new AdapterError('unavailable');
    }
    const responseHeaders = new Headers(response.headers);
    if (responseHeaders.has('content-encoding')) responseHeaders.delete('content-length');
    const body = await readBoundedRequestBody({ body: response.body, headers: responseHeaders, signal: requestSignal }, 16000, 5000);
    return parseRecordingCaptureResponse(q, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('unavailable');
  }
}
