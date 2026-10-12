import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const funnels = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
vi.mock('@/funnels', async () => {
  const actual = await vi.importActual<typeof import('@/funnels')>('@/funnels');
  // The route resolves a public funnel by slug; the test's list stands in for the repository's.
  return { ...actual, allFunnels: () => funnels.list, publishedFunnel: (slug: string) => (funnels.list as { slug: string; status: string }[]).find(f => f.slug === slug && f.status === 'published') ?? null };
});
import { POST } from './route';
import { __resetProgramCommerceRuntime, selectProgramCheckout, selectProgramOfferLedger } from '@/server/commerce/program-commerce-runtime';
import type { OfferActor } from '@/server/commerce/program-offer-ledger';

/**
 * The visitor's checkout start: same-origin only, a bounded body holding the funnel slug and nothing
 * else, a published funnel, an honest redirect back with the hold outside the fixture, and under
 * the fixture a same-site page with one link to the processor's page with a server-issued HttpOnly attempt cookie that makes
 * a repeated post find the same checkout.
 */
const host = '127.0.0.1:3000';
const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222', version = '33333333-3333-4333-8333-333333333333';
function req(body: string | Record<string, string>, headers: Record<string, string> = {}) {
  const form = typeof body === 'string' ? body : new URLSearchParams(body).toString();
  return new Request('http://127.0.0.1:3000/api/live/commerce/checkout', { method: 'POST', headers: { host, origin: 'http://' + host, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form });
}
const funnel = (over: Record<string, unknown> = {}) => ({ slug: 'longevity-program', status: 'published', consultSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, ...over });
const fixture = () => { vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', '1'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CLINICAL_SUPABASE_URL', 'http://127.0.0.1:3999'); vi.stubEnv('APP_RUNTIME_ENV', ''); vi.stubEnv('CLINICAL_AWS_RUNTIME_MODE', ''); };
async function publishedOffer() {
  const selection = selectProgramOfferLedger();
  if (selection.kind !== 'fictional') throw new Error('fixture expected');
  selection.registerCurriculum(org, program, { versionId: version, version: 1, sourceDigest: 'a'.repeat(64) });
  const me: OfferActor = { personId: '44444444-4444-4444-8444-444444444444', organizationId: org };
  const created = await selection.ledger.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90 } });
  const offerId = created.action === 'create' ? created.offer.offerId : '';
  await selection.ledger.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
  await selection.ledger.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
}
beforeEach(() => { __resetProgramCommerceRuntime(); funnels.list = [funnel()]; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('the guard', () => {
  it.each<Record<string, string>>([{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }])('refuses an unsafe origin: %o', async headers => {
    expect((await POST(req({ funnelSlug: 'longevity-program' }, headers))).status).toBe(403);
  });
  it.each([['an extra field', { funnelSlug: 'longevity-program', amountMinor: '1' }], ['a malformed slug', { funnelSlug: '../x' }], ['no slug', {}], ['an oversized body', { funnelSlug: 'longevity-program', pad: 'x'.repeat(2000) }]])('refuses %s with 400', async (_name, body) => {
    expect((await POST(req(body as Record<string, string>))).status).toBe(400);
  });
  it('answers not-found for a draft or unknown funnel, so a draft page cannot be bought from', async () => {
    funnels.list = [funnel({ status: 'draft' })];
    expect((await POST(req({ funnelSlug: 'longevity-program' }))).status).toBe(404);
    expect((await POST(req({ funnelSlug: 'no-such-program' }))).status).toBe(404);
  });
  it('outside the fixture sends the visitor back to the purchase page with checkout_unconfigured and sets no cookie', async () => {
    const response = await POST(req({ funnelSlug: 'longevity-program' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://127.0.0.1:3000/buy/longevity-program?hold=checkout_unconfigured');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('under the local fixture', () => {
  beforeEach(fixture);
  it('sends the visitor back with the offer hold when nothing is for sale, and with program_unbound for an unbound page', async () => {
    const response = await POST(req({ funnelSlug: 'longevity-program' }));
    expect(response.headers.get('location')).toBe('http://127.0.0.1:3000/buy/longevity-program?hold=offer_absent');
    funnels.list = [funnel({ programBinding: null })];
    expect((await POST(req({ funnelSlug: 'longevity-program' }))).headers.get('location')).toContain('hold=program_unbound');
  });
  it('answers a same-site page linking to the processor page, issues an HttpOnly same-site attempt cookie, and a repeated post with it reuses the checkout', async () => {
    await publishedOffer();
    const first = await POST(req({ funnelSlug: 'longevity-program' }));
    expect(first.status).toBe(200);
    // Never a redirect off this site: the purchase page's form-action 'self' applies to the redirects after a submission, so a 303 to the processor is blocked in the browser.
    expect(first.headers.get('location')).toBeNull();
    expect(first.headers.get('content-security-policy')).toContain("form-action 'none'");
    expect(first.headers.get('referrer-policy')).toBe('no-referrer');
    const firstHtml = await first.text();
    expect(firstHtml).not.toMatch(/<script|<form|<style|style=/i);
    const firstHref = /data-testid="checkout-continue-link" href="([^"]+)"/.exec(firstHtml)?.[1] ?? '';
    expect(firstHref).toMatch(/^https:\/\/checkout\.fictional\.example\//);
    const cookie = first.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^alp_checkout_attempt=[a-f0-9]{48}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400$/);
    const selection = selectProgramCheckout();
    expect(selection.kind === 'fictional' && selection.ledger.orders.size).toBe(1);
    const again = await POST(req({ funnelSlug: 'longevity-program' }, { cookie: cookie.split(';')[0]! }));
    expect(/href="([^"]+)"/.exec(await again.text())?.[1]).toBe(firstHref);
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(selection.kind === 'fictional' && selection.ledger.orders.size).toBe(1);
    const other = await POST(req({ funnelSlug: 'longevity-program' }));
    expect(/href="([^"]+)"/.exec(await other.text())?.[1]).not.toBe(firstHref);
    expect(selection.kind === 'fictional' && selection.ledger.orders.size).toBe(2);
    // A JSON body is accepted on the same terms.
    const json = await POST(new Request('http://127.0.0.1:3000/api/live/commerce/checkout', { method: 'POST', headers: { host, origin: 'http://' + host, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ funnelSlug: 'longevity-program' }) }));
    expect(json.status).toBe(200);
  });
  it('a forged attempt cookie is replaced, never trusted', async () => {
    await publishedOffer();
    const response = await POST(req({ funnelSlug: 'longevity-program' }, { cookie: 'alp_checkout_attempt=not-a-key' }));
    expect(response.headers.get('set-cookie')).toMatch(/^alp_checkout_attempt=[a-f0-9]{48};/);
  });
});
