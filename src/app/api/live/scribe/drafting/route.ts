import { liveGuard } from '../../route-helpers';
import { getRequestSession } from '@/server/session';
import { recordingDraftingRequest } from '@/adapters/recording-drafting.server';
import { draftingOperationSchema } from '@/contracts/encounterRecordingDrafting';
import { AdapterError, HTTP_STATUS } from '@/adapters/errors';
import { BoundedBodyError, readBoundedRequestBody } from '@/server/bounded-request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
/** Same-origin proxy for the review-only drafting authority. Identity is only
 * the request-scoped workforce cookie; the client cannot pick a release, model,
 * prompt, actor or organization, and nothing here writes a clinical note. */
export async function POST(request: Request) {
  const guard = liveGuard(); if (guard) { guard.headers.set('cache-control', 'no-store'); return guard; }
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin
      || request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin') throw new AdapterError('forbidden');
    const session = await getRequestSession();
    if (!session.signedIn || !session.token) throw new AdapterError('unauthenticated');
    if (new URL(request.url).search || request.headers.has('content-encoding')
      || request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new AdapterError('invalid');
    const body = await readBoundedRequestBody(request, 10000, 5000);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { throw new AdapterError('invalid'); }
    const parsed = draftingOperationSchema.safeParse(input);
    if (!parsed.success) throw new AdapterError('invalid');
    return Response.json(await recordingDraftingRequest(parsed.data, session.token, request.signal), { headers });
  } catch (error) {
    const safe = error instanceof AdapterError ? error : new AdapterError(error instanceof BoundedBodyError ? 'invalid' : 'unavailable');
    return Response.json(safe.toJSON(), { status: HTTP_STATUS[safe.code], headers });
  }
}
