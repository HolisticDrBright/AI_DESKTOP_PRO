import { NextResponse } from 'next/server';
import { z } from 'zod';

import { noteTemplateAdminRequest, noteDraftingContextRequest } from '@/contracts/noteTemplates';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { noteTemplateCall, noteDraftingContextCall, ConsultWorkforceError } from '@/server/consult/consultWorkforceApi';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { getRequestSession } from '@/server/session';

import { liveGuard } from '../route-helpers';

/**
 * The practice's own note templates and house style, and a preview of what drafting is handed.
 *
 * Both surfaces are behind one route because they are one job: deciding what a draft should
 * look like, and seeing exactly what the model will be given. Nothing here decides anything;
 * the browser's vocabulary is the stored contract's and every rule is in SQL.
 */
const json = (status: number, value: unknown) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

const browserRequest = z.union([
  z.object({ surface: z.literal('templates'), request: noteTemplateAdminRequest }).strict(),
  z.object({ surface: z.literal('drafting_context'), request: noteDraftingContextRequest }).strict(),
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
    const data = body.surface === 'templates'
      ? await noteTemplateCall(session.token, request.signal)(body.request)
      : await noteDraftingContextCall(session.token, request.signal)(body.request);
    return json(200, { data });
  } catch (error) {
    if (error instanceof ConsultWorkforceError) {
      return json(error.status === 401 ? 401 : error.status, { error: 'note_template_refused' });
    }
    return json(503, { error: 'service_unavailable' });
  }
}
