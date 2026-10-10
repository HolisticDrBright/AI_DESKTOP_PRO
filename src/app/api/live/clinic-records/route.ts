import { NextResponse } from 'next/server';
import { z } from 'zod';

import { clinicRecordWorkforceRequest } from '@/contracts/clinicRecordRequests';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { clinicRecordsWorkforceCall, ConsultWorkforceError } from '@/server/consult/consultWorkforceApi';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { getRequestSession } from '@/server/session';

import { liveGuard } from '../route-helpers';

/**
 * The clinic's side of a patient's request for their clinic-held records or
 * for a correction. The browser's vocabulary is the stored contract's; every
 * rule (authority, disclosure release, idempotent decisions, append-only
 * amendment) is in SQL behind the workforce route. Nothing here decides.
 */
const json = (status: number, value: unknown) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const browserRequest = z.object({ request: clinicRecordWorkforceRequest }).strict();

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: 'identity_refused' });
  const session = await getRequestSession(); if (!session.token) return json(401, { error: 'reauth_required' });
  let body: z.infer<typeof browserRequest>;
  try {
    body = browserRequest.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 131072, 5000))));
  } catch { return json(400, { error: 'request_invalid' }); }
  try {
    return json(200, { data: await clinicRecordsWorkforceCall(session.token, request.signal)(body.request) });
  } catch (error) {
    if (error instanceof ConsultWorkforceError) {
      // Known decided codes are relayed so the screen can say what happened; anything else is a refusal.
      const known = ['conflict', 'disclosure_release_required', 'not_found', 'request_invalid', 'identity_refused'];
      return json(error.status === 401 ? 401 : error.status, { error: known.includes(error.code ?? '') ? error.code : 'clinic_records_refused' });
    }
    return json(503, { error: 'service_unavailable' });
  }
}
