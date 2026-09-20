import { AdapterError, codeFromHttpStatus } from '@/adapters/errors';
import { transcriptionOperationSchema, parseTranscriptionResponse, type TranscriptionOperation } from '@/contracts/encounterRecordingTranscription';
import { readBoundedRequestBody } from '@/server/bounded-request-body';

/** Explicit calls only through the same-origin proxy; no automatic replay, no
 * stored text, no provider access. A request write keeps its command ID. */
export async function requestRecordingTranscription(request: TranscriptionOperation, signal: AbortSignal) {
  const parsed = transcriptionOperationSchema.safeParse(request);
  if (!parsed.success) throw new AdapterError('invalid');
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  try {
    const response = await fetch('/api/live/scribe/transcription', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data), signal: requestSignal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new AdapterError(response.status === 409 ? 'conflict' : codeFromHttpStatus(response.status));
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      void response.body?.cancel().catch(() => {}); throw new AdapterError('unavailable');
    }
    const responseHeaders = new Headers(response.headers);
    if (responseHeaders.has('content-encoding')) responseHeaders.delete('content-length');
    const body = await readBoundedRequestBody({ body: response.body, headers: responseHeaders, signal: requestSignal }, 2_400_000, 20000);
    return parseTranscriptionResponse(parsed.data, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('unavailable');
  }
}
