import { NextResponse } from 'next/server';
import { z } from 'zod';

import { consultRetentionRequest } from '@/contracts/consultRetention';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { consultRetentionCall, ConsultWorkforceError } from '@/server/consult/consultWorkforceApi';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { getRequestSession } from '@/server/session';

import { liveGuard } from '../route-helpers';

/**
 * Erasing the contact details of someone who enquired and never became a patient, and the
 * retention window that decides when it happens without being asked.
 *
 * Practitioner-only by design. An enquirer has no account, so there is no consumer route here —
 * an unauthenticated erase-by-contact endpoint would be a way to ask a clinic which addresses
 * had written to it.
 */
const json = (status: number, value: unknown) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: 'identity_refused' });
  const session = await getRequestSession(); if (!session.token) return json(401, { error: 'reauth_required' });
  let body: z.infer<typeof consultRetentionRequest>;
  try {
    body = consultRetentionRequest.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 65536, 5000))));
  } catch { return json(400, { error: 'request_invalid' }); }
  try {
    return json(200, { data: await consultRetentionCall(session.token, request.signal)(body) });
  } catch (error) {
    if (error instanceof ConsultWorkforceError) {
      return json(error.status === 401 ? 401 : error.status, { error: 'consult_retention_refused' });
    }
    return json(503, { error: 'service_unavailable' });
  }
}
