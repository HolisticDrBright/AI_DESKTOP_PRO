import { NextResponse } from 'next/server';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { campaignApiCall, campaignEngineEnabled } from '@/server/campaign-api';

/**
 * RFC 8058 one-click unsubscribe: the address in every campaign email's `List-Unsubscribe` header. A mail provider
 * POSTs `List-Unsubscribe=One-Click` here, from its own servers (so no browser origin is expected), with the sealed
 * token in the query. It takes effect at once and answers 200 with no page. Only that exact body is accepted.
 */
export async function POST(request: Request) {
  if (!campaignEngineEnabled()) return new NextResponse(null, { status: 404 });
  const token = new URL(request.url).searchParams.get('t') ?? '';
  let body = '';
  try { body = new TextDecoder().decode(await readBoundedRequestBody(request, 256, 5000)).trim(); }
  catch { return new NextResponse(null, { status: 400 }); }
  if (body !== 'List-Unsubscribe=One-Click' || !/^[A-Za-z0-9_-]{40,600}$/.test(token)) return new NextResponse(null, { status: 400 });
  try {
    const { outcome } = await campaignApiCall<{ outcome: string }>({ method: 'POST', path: '/campaigns/public/unsubscribe', body: { token } });
    return new NextResponse(null, { status: outcome === 'unsubscribed' ? 200 : 400, headers: { 'cache-control': 'no-store' } });
  } catch { return new NextResponse(null, { status: 503 }); }
}
