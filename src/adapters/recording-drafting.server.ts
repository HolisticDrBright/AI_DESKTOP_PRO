if (typeof window !== 'undefined') throw new Error('Recording drafting is server-only.');
import { AdapterError, codeFromHttpStatus } from './errors';
import { draftingOperationSchema, parseDraftingResponse } from '@/contracts/encounterRecordingDrafting';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { CLINIC_MEMBERSHIP_REFUSAL, CLINIC_MEMBERSHIP_REFUSAL_MESSAGE, refusedUnderClinicMembership } from '@/server/clinic-authority-families';

/** A distinct, configured drafting service. Never the consent, capture or
 * transcription endpoint, compatibility RPC or a fixture. Bearer identity is
 * cookie-derived. Proposed text passes through unlogged. */
export async function recordingDraftingRequest(input: unknown, token: string | null, signal?: AbortSignal) {
  if (!token) throw new AdapterError('unauthenticated');
  // Not converted to clinic-membership sign-in: refused before the token leaves (src/server/clinic-authority-families.ts).
  if (refusedUnderClinicMembership('encounter_recording')) throw new AdapterError('unavailable', CLINIC_MEMBERSHIP_REFUSAL_MESSAGE, CLINIC_MEMBERSHIP_REFUSAL);
  const parsed = draftingOperationSchema.safeParse(input);
  if (!parsed.success) throw new AdapterError('invalid');
  let origin: URL;
  try { origin = new URL(process.env.RECORDING_DRAFTING_AWS_API_ORIGIN ?? ''); }
  catch { throw new AdapterError('unavailable'); }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
    || origin.username || origin.password || origin.port
    || !/^[a-z0-9]{10}\.execute-api\.us-(east|west)-[12]\.amazonaws\.com$/.test(origin.hostname))
    throw new AdapterError('unavailable');
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(35000)]);
  try {
    const response = await fetch(origin.origin + '/clinical-core/workforce/encounter-recording/drafting', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data), cache: 'no-store', redirect: 'error', signal: requestSignal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new AdapterError(response.status === 409 ? 'conflict' : response.status >= 300 && response.status < 400 ? 'unavailable' : codeFromHttpStatus(response.status));
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      void response.body?.cancel().catch(() => {});
      throw new AdapterError('unavailable');
    }
    const responseHeaders = new Headers(response.headers);
    if (responseHeaders.has('content-encoding')) responseHeaders.delete('content-length');
    const body = await readBoundedRequestBody({ body: response.body, headers: responseHeaders, signal: requestSignal }, 1_200_000, 20000);
    return parseDraftingResponse(parsed.data, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('unavailable');
  }
}
