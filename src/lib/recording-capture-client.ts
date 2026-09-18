import { AdapterError, codeFromHttpStatus } from '@/adapters/errors';
import { recordingCaptureRequestSchema, parseRecordingCaptureResponse, type RecordingCaptureRequest } from '@/contracts/encounterRecordingCapture';
import { readBoundedRequestBody } from '@/server/bounded-request-body';

/** Explicit calls only; no automatic replay, microphone, local-storage token or
 * provider fallback. An ambiguous write must retain its original command ID. */
export async function requestRecordingCapture(request: RecordingCaptureRequest, signal: AbortSignal, bytes?: ArrayBuffer) {
  const parsed = recordingCaptureRequestSchema.safeParse(request);
  if (!parsed.success) throw new AdapterError('invalid');
  const q = parsed.data;
  if (q.operation === 'segment' ? !bytes || bytes.byteLength !== q.input.bytes : bytes !== undefined) throw new AdapterError('invalid');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (q.operation === 'segment') Object.assign(headers, { 'Content-Type': q.input.contentType,
    'x-alp-recording-id': q.input.recordingId, 'x-alp-session-id': q.input.sessionId,
    'x-alp-capture-token': q.input.captureToken, 'x-alp-sequence': String(q.input.sequence), 'x-alp-sha256': q.input.sha256 });
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  try {
    const response = await fetch('/api/live/scribe/capture/' + q.operation, { method: 'POST', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', headers, body: q.operation === 'segment' ? bytes : JSON.stringify(q.input), signal: requestSignal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new AdapterError(response.status === 409 ? 'conflict' : codeFromHttpStatus(response.status));
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      void response.body?.cancel().catch(() => {}); throw new AdapterError('unavailable');
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
