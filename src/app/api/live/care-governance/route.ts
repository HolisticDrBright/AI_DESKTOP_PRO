import { NextResponse } from 'next/server';
import { z } from 'zod';

import { disputeWorkforceRequest, revisionWorkforceRequest } from '@/contracts/clinicalDisputes';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { disputeQueueCall, revisionNoticeCall, ConsultWorkforceError } from '@/server/consult/consultWorkforceApi';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { getRequestSession } from '@/server/session';

import { liveGuard } from '../route-helpers';

/**
 * The clinic's side of a contested record and of a revision already announced.
 *
 * Both surfaces are behind one route because they are one job: seeing what the practice got
 * wrong or has changed, and answering for it. Nothing here decides anything — the browser's
 * vocabulary is the stored contract's, and every rule is in SQL.
 */
const json = (status: number, value: unknown) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

const browserRequest = z.union([
  z.object({ surface: z.literal('disputes'), request: disputeWorkforceRequest }).strict(),
  z.object({ surface: z.literal('revisions'), request: revisionWorkforceRequest }).strict(),
]);

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: 'identity_refused' });
  const session = await getRequestSession(); if (!session.token) return json(401, { error: 'reauth_required' });
  let body: z.infer<typeof browserRequest>;
  try {
    body = browserRequest.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 65536, 5000))));
  } catch { return json(400, { error: 'request_invalid' }); }
  try {
    const data = body.surface === 'disputes'
      ? await disputeQueueCall(session.token, request.signal)(body.request)
      : await revisionNoticeCall(session.token, request.signal)(body.request);
    return json(200, { data });
  } catch (error) {
    if (error instanceof ConsultWorkforceError) {
      return json(error.status === 401 ? 401 : error.status, { error: 'care_governance_refused' });
    }
    return json(503, { error: 'service_unavailable' });
  }
}
