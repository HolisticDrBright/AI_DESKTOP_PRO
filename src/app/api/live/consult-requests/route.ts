import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { consultLinkAdminRequest, consultReviewRequest } from '@/contracts/consultRequests';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { openVisitorContact } from '@/server/consult/consultContactEnvelope';
import { createConsultContactKeyResolver, ConsultKeyError } from '@/server/consult/consultContactKey';
import { consultLinkCall, consultReviewCall, ConsultWorkforceError } from '@/server/consult/consultWorkforceApi';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { getRequestSession } from '@/server/session';

import { liveGuard } from '../route-helpers';

/**
 * The clinic's own side of the consult link: publishing links, working the queue, and
 * reading the contact details behind one request.
 *
 * The browser's vocabulary is narrower than the stored contract's in one important way: a
 * page asks to *open* a request and is given the name and address, never the sealed envelope
 * and never the key. The opening happens here, and the clinical API records that it happened.
 */
const json = (status: number, value: unknown) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

const browserRequest = z.union([
  z.object({ surface: z.literal('links'), request: consultLinkAdminRequest }).strict(),
  z.object({ surface: z.literal('queue'), request: consultReviewRequest }).strict(),
  z.object({ surface: z.literal('contact'), requestId: z.string().uuid() }).strict(),
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
    if (body.surface === 'links') return json(200, { data: await consultLinkCall(session.token, request.signal)(body.request) });
    if (body.surface === 'queue') return json(200, { data: await consultReviewCall(session.token, request.signal)(body.request) });
    const opened = await consultReviewCall(session.token, request.signal)({ action: 'open', requestId: body.requestId });
    if (opened.action !== 'open') return json(503, { error: 'service_unavailable' });
    const key = await createConsultContactKeyResolver({
      environment: process.env as Record<string, string | undefined>,
      secrets: new SecretsManagerClient({}),
    })();
    const contact = openVisitorContact(key, opened);
    return json(200, { data: { action: 'contact', requestId: opened.requestId, reference: opened.reference, contact } });
  } catch (error) {
    if (error instanceof ConsultKeyError) return json(503, { error: 'consult_not_configured' });
    if (error instanceof ConsultWorkforceError) {
      return json(error.status === 401 ? 401 : error.status === 503 ? 503 : error.status, { error: 'consult_request_refused' });
    }
    // A sealed contact that will not open is a real answer and must not be softened into an
    // empty name: something about that row is wrong and a person has to look at it.
    return json(409, { error: 'consult_contact_unreadable' });
  }
}
