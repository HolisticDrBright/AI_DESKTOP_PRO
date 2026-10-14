import { NextResponse } from 'next/server';
import { z } from 'zod';

import { LAB_ATTESTATION_REVIEW, labAttestationReviewRequest } from '@/contracts/labAttestationReview';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { labAttestationReviewUpstream } from '@/server/lab-attestation-upstream';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { getRequestSession } from '@/server/session';

import { liveGuard } from '../../route-helpers';

/**
 * The reviewer's view of one clinic lab reading (lab-attestation-review/1), for the patient open on screen. A read,
 * sent as POST so the patient and reading never sit in a URL or a log line. The reviewer's identity, clinic and role
 * come from the session token on the service side; nothing in the body names them. Disabled unless activation
 * evidence is configured (see src/server/lab-attestation-upstream.ts).
 */
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store, private' } });
const browserRequest = z.object({ patientId: labAttestationReviewRequest.shape.patientRecordId,
  observationId: labAttestationReviewRequest.shape.observationId }).strict();

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: { code: 'lab_attestation_refused' } });
  const session = await getRequestSession(); if (!session.signedIn || !session.token) return json(401, { error: { code: 'reauth_required' } });
  let body: z.infer<typeof browserRequest>;
  try { body = browserRequest.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 1024, 5000)))); }
  catch { return json(400, { error: { code: 'lab_attestation_invalid' } }); }
  const outcome = await labAttestationReviewUpstream({ contract: LAB_ATTESTATION_REVIEW, patientRecordId: body.patientId,
    observationId: body.observationId }, session.token, request.signal);
  return outcome.ok ? json(200, { data: outcome.data }) : json(outcome.status, { error: { code: outcome.code } });
}
