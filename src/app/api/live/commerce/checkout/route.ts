import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { CHECKOUT_HOLD_REASONS, checkoutStartRequest } from '@/contracts/programCheckout';
import { resolvePublicFunnel } from '@/server/commerce/journey-fixture';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { resolvePurchaseRuntime } from '@/server/commerce/program-commerce-runtime';
import { liveGuard } from '../../route-helpers';

/**
 * A visitor's "buy the program": the purchase page posts the funnel slug here and nothing else.
 * Same-origin from this site's own page, a 1 KB bound, the slug held to its shape; the funnel must
 * be published; the attempt key is a server-issued, HttpOnly, same-site cookie so a repeated click
 * or a second tab finds the same checkout. The server chooses the offer, the amount, the price and
 * the return destinations. The answer is a short same-site page with ONE link to the processor's
 * hosted checkout, or a redirect back to the purchase page with the specific hold; outside the local
 * fixture it is always the latter, because no checkout is configured for this process.
 *
 * Why a page and not a redirect: the purchase page's policy is `form-action 'self'` (held by
 * src/lib/funnel-headers.test.ts), and browsers apply form-action to every redirect that follows a
 * form submission. A 303 from this route to the processor's host is therefore blocked in the
 * browser, so no visitor could ever reach the hosted page. The mounted journey found it. Following a
 * link is a navigation, not a form submission, so the policy stays as strict as it was.
 */
export const dynamic = 'force-dynamic';
const ATTEMPT_COOKIE = 'alp_checkout_attempt';
const slugOf = (value: string) => /^[a-z0-9][a-z0-9-]{2,79}$/.test(value) ? value : null;

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The one step between this site and the processor: no script, no form, no style, one link with no referrer. */
function continueToCheckout(checkoutUrl: string): NextResponse {
  const href = escapeHtml(checkoutUrl);
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">'
    + '<title>Continue to the secure checkout page</title></head><body><main data-testid="checkout-continue"><h1>Continue to the secure checkout page</h1>'
    + '<p>Payment is taken on a separate page run by the payment processor. No payment details are entered on this site.</p>'
    + `<p><a data-testid="checkout-continue-link" href="${href}" rel="noreferrer">Continue to the secure checkout page</a></p></main></body></html>`;
  return new NextResponse(html, { status: 200, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  } });
}

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
  const funnel = slug ? await resolvePublicFunnel(slug) : null;
  if (!funnel) return NextResponse.json({ error: { code: 'not_found', message: 'funnel_not_found' } }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const selection = await resolvePurchaseRuntime();
  if (selection.kind === 'disabled') return back(request, funnel.slug, selection.reason);
  const cookies = Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map(part => part.trim().split('=') as [string, string]).filter(([key]) => key));
  const existing = cookies[ATTEMPT_COOKIE];
  const attemptKey = existing && /^[a-f0-9]{48}$/.test(existing) ? existing : randomBytes(24).toString('hex');
  const result = await selection.checkout.start({ funnelSlug: funnel.slug, programBinding: funnel.programBinding, attemptKey });
  const response = result.started
    ? continueToCheckout(result.checkoutUrl)
    : back(request, funnel.slug, (CHECKOUT_HOLD_REASONS as readonly string[]).includes(result.reason) ? result.reason : result.reason);
  if (attemptKey !== existing) response.headers.append('Set-Cookie', `${ATTEMPT_COOKIE}=${attemptKey}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
  return response;
}
