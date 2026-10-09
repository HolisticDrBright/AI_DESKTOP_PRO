import { NextResponse } from 'next/server';
import { z } from 'zod';

import { outcomeLedgerRequest, outcomeReportRequest } from '@/contracts/practiceOutcomes';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { outcomeLedgerCall, outcomeReportCall, ConsultWorkforceError } from '@/server/consult/consultWorkforceApi';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { getRequestSession } from '@/server/session';

import { liveGuard } from '../route-helpers';

/**
 * The practice outcome ledger, and the aggregate report over it.
 *
 * Both surfaces are behind one route because they are one job: recording what happened, and
 * counting it. Nothing here bands an age or suppresses a cell — the clinic does both, and the
 * API role it calls through cannot read the underlying rows at all.
 */
const json = (status: number, value: unknown) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

const browserRequest = z.union([
  z.object({ surface: z.literal('ledger'), request: outcomeLedgerRequest }).strict(),
  z.object({ surface: z.literal('report'), request: outcomeReportRequest }).strict(),
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
    const data = body.surface === 'ledger'
      ? await outcomeLedgerCall(session.token, request.signal)(body.request)
      : await outcomeReportCall(session.token, request.signal)(body.request);
    return json(200, { data });
  } catch (error) {
    if (error instanceof ConsultWorkforceError) {
      return json(error.status === 401 ? 401 : error.status, { error: 'practice_outcome_refused' });
    }
    return json(503, { error: 'service_unavailable' });
  }
}
