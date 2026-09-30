import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';

import { publicConsultBrowserRequest } from '@/contracts/consultRequests';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { prepareConsultSubmission, contactDigestFor } from '@/server/consult/consultContactEnvelope';
import { createConsultContactKeyResolver, ConsultKeyError } from '@/server/consult/consultContactKey';
import { consultPublicCall, ConsultPublicApiError } from '@/server/consult/consultPublicApi';
import { sameBrowserOrigin } from '@/server/same-browser-origin';

import { liveGuard } from '../../live/route-helpers';

/**
 * The public consult form's own route.
 *
 * This is the only route in the application that answers without a session, and the only
 * place a visitor's plaintext name and address exist. They are sealed here and the sealed
 * form is what travels onward, so the clinical API's public route cannot receive plaintext
 * contact details even if something upstream tried to send them.
 *
 * The origin check stays, even without a session to protect: this route exists to serve the
 * page on this site, and a form posted from somewhere else is not that. A clinic that wants
 * the form on its own website links to the page rather than reposting to this endpoint.
 *
 * Nothing about the request is logged. A refusal is answered with a code and no detail,
 * including for an unavailable link, so this cannot be used to find out which clinics exist.
 */
const json = (status: number, value: unknown) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: 'origin_refused' });
  let body: unknown;
  try {
    body = publicConsultBrowserRequest.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 16384, 5000))));
  } catch { return json(400, { error: 'request_invalid' }); }
  const parsed = body as ReturnType<typeof publicConsultBrowserRequest.parse>;
  try {
    const call = consultPublicCall(request.signal);
    // Only a submission needs the key. Describing a link needs nothing, and a withdrawal
    // needs a digest of the visitor's own address, which is a hash and not a decryption.
    if (parsed.action === 'describe') return json(200, { data: await call(parsed) });
    if (parsed.action === 'withdraw') {
      return json(200, { data: await call({
        action: 'withdraw', reference: parsed.reference, contactDigest: contactDigestFor(parsed.email),
      }) });
    }
    const key = await createConsultContactKeyResolver({
      environment: process.env as Record<string, string | undefined>,
      secrets: new SecretsManagerClient({}),
    })();
    return json(200, { data: await call(prepareConsultSubmission(key, parsed)) });
  } catch (error) {
    // A missing or wrong key is a configuration answer, not a visitor's fault, and the form
    // must say so rather than appearing to have accepted the request.
    if (error instanceof ConsultKeyError) return json(503, { error: 'consult_not_configured' });
    if (error instanceof ConsultPublicApiError) {
      return json(error.status === 503 ? 503 : error.status, { error: 'consult_request_refused' });
    }
    return json(503, { error: 'service_unavailable' });
  }
}
