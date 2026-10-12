import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { CHECKOUT_HOLD_REASONS, checkoutStartRequest } from '@/contracts/programCheckout';
import { allFunnels } from '@/funnels';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { selectProgramCheckout } from '@/server/commerce/program-commerce-runtime';
import { liveGuard } from '../../route-helpers';

/**
 * A visitor's "buy the program": the purchase page posts the funnel slug here and nothing else.
 * Same-origin from this site's own page, a 1 KB bound, the slug held to its shape; the funnel must
 * be published; the attempt key is a server-issued, HttpOnly, same-site cookie so a repeated click
 * or a second tab finds the same checkout. The server chooses the offer, the amount, the price and
 * the return destinations. The answer is a redirect to the processor's hosted page, or back to the
 * purchase page with the specific hold; outside the local fixture it is always the latter, because
 * no checkout is configured for this process.
 */
export const dynamic = 'force-dynamic';
const ATTEMPT_COOKIE = 'alp_checkout_attempt';
const slugOf = (value: string) => /^[a-z0-9][a-z0-9-]{2,79}$/.test(value) ? value : null;

function back(request: Request, slug: string | null, reason: string): NextResponse {
  const location = new URL(slug ? `/buy/${slug}` : '/', request.url);
  location.searchParams.set('hold', reason);
  return NextResponse.redirect(location, { status: 303, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return NextResponse.json({ error: { code: 'forbidden', message: 'identity_refused' } }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  let slug: string | null = null;
  try {
    const raw = new TextDecoder().decode(await readBoundedRequestBody(request, 1024, 5000));
    const contentType = request.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    slug = slugOf(checkoutStartRequest.parse(body).funnelSlug);
  } catch {
    return NextResponse.json({ error: { code: 'invalid', message: 'request_invalid' } }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  const funnel = allFunnels().find(item => item.slug === slug && item.status === 'published') ?? null;
  if (!funnel) return NextResponse.json({ error: { code: 'not_found', message: 'funnel_not_found' } }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const selection = selectProgramCheckout();
  if (selection.kind === 'disabled') return back(request, funnel.slug, selection.reason);
  const cookies = Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map(part => part.trim().split('=') as [string, string]).filter(([key]) => key));
  const existing = cookies[ATTEMPT_COOKIE];
  const attemptKey = existing && /^[a-f0-9]{48}$/.test(existing) ? existing : randomBytes(24).toString('hex');
  const result = await selection.checkout.start({ funnelSlug: funnel.slug, programBinding: funnel.programBinding, attemptKey });
  const response = result.started
    ? NextResponse.redirect(result.checkoutUrl, { status: 303, headers: { 'Cache-Control': 'no-store' } })
    : back(request, funnel.slug, (CHECKOUT_HOLD_REASONS as readonly string[]).includes(result.reason) ? result.reason : result.reason);
  if (attemptKey !== existing) response.headers.append('Set-Cookie', `${ATTEMPT_COOKIE}=${attemptKey}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
  return response;
}
