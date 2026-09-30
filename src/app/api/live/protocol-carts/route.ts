import { NextResponse } from 'next/server';
import { z } from 'zod';

import { protocolCartRequest } from '@/contracts/protocolCarts';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { protocolCartCall, ConsultWorkforceError } from '@/server/consult/consultWorkforceApi';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { getRequestSession } from '@/server/session';

import { liveGuard } from '../route-helpers';

/**
 * Compiling a cart from a published protocol.
 *
 * Compile, read and list. There is no send, here or anywhere: the manifest is what a delivery
 * step would read, and no delivery step exists. Every exclusion is decided in SQL.
 */
const json = (status: number, value: unknown) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: 'identity_refused' });
  const session = await getRequestSession(); if (!session.token) return json(401, { error: 'reauth_required' });
  let body: z.infer<typeof protocolCartRequest>;
  try {
    body = protocolCartRequest.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 65536, 5000))));
  } catch { return json(400, { error: 'request_invalid' }); }
  try {
    return json(200, { data: await protocolCartCall(session.token, request.signal)(body) });
  } catch (error) {
    if (error instanceof ConsultWorkforceError) {
      return json(error.status === 401 ? 401 : error.status, { error: 'protocol_cart_refused' });
    }
    return json(503, { error: 'service_unavailable' });
  }
}
