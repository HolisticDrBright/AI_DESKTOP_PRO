import { liveGuard } from '../../../route-helpers';
import { getRequestSession } from '@/server/session';
import { recordingCaptureRequest } from '@/adapters/recording-capture.server';
import { recordingCaptureRequestSchema } from '@/contracts/encounterRecordingCapture';
import { AdapterError, HTTP_STATUS } from '@/adapters/errors';
import { BoundedBodyError, readBoundedRequestBody } from '@/server/bounded-request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const uploadHeaders = ['x-alp-recording-id', 'x-alp-session-id', 'x-alp-capture-token', 'x-alp-sequence', 'x-alp-sha256'];
export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  const guard = liveGuard(); if (guard) { guard.headers.set('cache-control', 'no-store'); return guard; }
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin
      || request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin') throw new AdapterError('forbidden');
    const session = await getRequestSession();
    if (!session.signedIn || !session.token) throw new AdapterError('unauthenticated');
    const { operation } = await context.params;
    if (!['start', 'state', 'command', 'segment'].includes(operation) || new URL(request.url).search
      || request.headers.has('content-encoding')
      || [...request.headers.keys()].some(k => k.startsWith('x-alp-') && (operation !== 'segment' || !uploadHeaders.includes(k))))
      throw new AdapterError('invalid');
    let input: unknown, bytes: ArrayBuffer | undefined;
    if (operation === 'segment') {
      const sequence = request.headers.get('x-alp-sequence') ?? '';
      if (!/^(0|[1-9][0-9]{0,3})$/.test(sequence)) throw new AdapterError('invalid');
      bytes = await readBoundedRequestBody(request, 4194304, 10000);
      input = { recordingId: request.headers.get('x-alp-recording-id'), sessionId: request.headers.get('x-alp-session-id'),
        captureToken: request.headers.get('x-alp-capture-token'), sequence: Number(sequence), sha256: request.headers.get('x-alp-sha256'),
        contentType: request.headers.get('content-type'), bytes: bytes.byteLength };
    } else {
      if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new AdapterError('invalid');
      const body = await readBoundedRequestBody(request, 10000, 5000);
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { throw new AdapterError('invalid'); }
    }
    const parsed = recordingCaptureRequestSchema.safeParse({ operation, input });
    if (!parsed.success) throw new AdapterError('invalid');
    return Response.json(await recordingCaptureRequest(parsed.data, session.token, bytes, request.signal), { headers });
  } catch (error) {
    const safe = error instanceof AdapterError ? error : new AdapterError(error instanceof BoundedBodyError ? 'invalid' : 'unavailable');
    return Response.json(safe.toJSON(), { status: HTTP_STATUS[safe.code], headers });
  }
}
