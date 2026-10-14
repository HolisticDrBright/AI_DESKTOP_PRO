import { NextResponse } from 'next/server';

import { labAttestationBoundRequest, type LabAttestationBoundRequest } from '@/contracts/labAttestationReview';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { labAttestationUpstream } from '@/server/lab-attestation-upstream';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { getRequestSession } from '@/server/session';

import { liveGuard } from '../route-helpers';

/**
 * One reviewer attestation, bound to the patient on screen, the reading revision the reviewer saw and the report
 * they compared it against (lab-attestation-review/1 carrying lab-reading-attestation/1). The body is the contract
 * itself, parsed strictly: a "verified" boolean, a signature, a range or a flag is refused here, before anything
 * leaves the process. The receipt is relayed only after it is parsed and found to be about this exact reading; the
 * screen still reads the view back before it says anything is verified. Disabled unless activation evidence is
 * configured (see src/server/lab-attestation-upstream.ts).
 */
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store, private' } });

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: { code: 'lab_attestation_refused' } });
  const session = await getRequestSession(); if (!session.signedIn || !session.token) return json(401, { error: { code: 'reauth_required' } });
  let body: LabAttestationBoundRequest;
  try { body = labAttestationBoundRequest.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 8192, 5000)))); }
  catch { return json(400, { error: { code: 'lab_attestation_invalid' } }); }
  const outcome = await labAttestationUpstream(body, session.token, request.signal);
  return outcome.ok ? json(200, { data: outcome.data }) : json(outcome.status, { error: { code: outcome.code } });
}
