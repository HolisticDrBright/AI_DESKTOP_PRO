if (typeof window !== 'undefined') throw new Error('Recording transcription is server-only.');
import { AdapterError, codeFromHttpStatus } from './errors';
import { transcriptionOperationSchema, parseTranscriptionResponse } from '@/contracts/encounterRecordingTranscription';
import { readBoundedRequestBody } from '@/server/bounded-request-body';

/** A distinct, configured transcription service. Never the consent or capture
 * endpoint, compatibility RPC or a fixture. Bearer identity is cookie-derived.
 * Transcript text passes through unlogged; no body or upstream error is kept. */
export async function recordingTranscriptionRequest(input: unknown, token: string | null, signal?: AbortSignal) {
  if (!token) throw new AdapterError('unauthenticated');
  const parsed = transcriptionOperationSchema.safeParse(input);
  if (!parsed.success) throw new AdapterError('invalid');
  let origin: URL;
  try { origin = new URL(process.env.RECORDING_TRANSCRIPTION_AWS_API_ORIGIN ?? ''); }
  catch { throw new AdapterError('unavailable'); }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
    || origin.username || origin.password || origin.port
    || !/^[a-z0-9]{10}\.execute-api\.us-(east|west)-[12]\.amazonaws\.com$/.test(origin.hostname))
    throw new AdapterError('unavailable');
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(35000)]);
  try {
    const response = await fetch(origin.origin + '/clinical-core/workforce/encounter-recording/transcription', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data), cache: 'no-store', redirect: 'error', signal: requestSignal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new AdapterError(response.status === 409 ? 'conflict' : response.status === 413 ? 'invalid'
        : response.status >= 300 && response.status < 400 ? 'unavailable' : codeFromHttpStatus(response.status));
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      void response.body?.cancel().catch(() => {});
      throw new AdapterError('unavailable');
    }
    const responseHeaders = new Headers(response.headers);
    if (responseHeaders.has('content-encoding')) responseHeaders.delete('content-length');
    // A transcript version is at most 2,000,000 characters of text plus envelope.
    const body = await readBoundedRequestBody({ body: response.body, headers: responseHeaders, signal: requestSignal }, 2_400_000, 20000);
    return parseTranscriptionResponse(parsed.data, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('unavailable');
  }
}
