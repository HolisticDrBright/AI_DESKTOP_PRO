import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => vi.fn());
vi.mock('@/server/session', () => ({ getRequestSession: session }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
import { POST } from './route';
import { __resetProgramCommerceRuntime, selectProgramCheckout, selectProgramOfferLedger } from '@/server/commerce/program-commerce-runtime';
import type { OfferActor } from '@/server/commerce/program-offer-ledger';

/**
 * The commercial status route: same-origin and the practitioner's cookie, the clinic from the
 * session, an exact body, 503 `commerce_disabled` outside the fixture (never an empty list), and
 * under the fixture the clinic's own orders and entitlements under the `commercial` key, with the
 * exact purchased version read for its own entitlement and withheld for another clinic's.
 */
const host = '127.0.0.1:3000';
const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222', version = '33333333-3333-4333-8333-333333333333';
const req = (body: unknown, headers: Record<string, string> = {}) => new Request('http://127.0.0.1:3000/api/live/commerce/status', { method: 'POST', headers: { host, origin: 'http://' + host, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const fixture = () => { vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', '1'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CLINICAL_SUPABASE_URL', 'http://127.0.0.1:3999'); vi.stubEnv('APP_RUNTIME_ENV', ''); vi.stubEnv('CLINICAL_AWS_RUNTIME_MODE', ''); };
const body = async (response: Response) => response.json() as Promise<{ data?: { commercial: Record<string, unknown> }; error?: { message: string } }>;
beforeEach(() => { vi.clearAllMocks(); __resetProgramCommerceRuntime(); session.mockResolvedValue({ token: 'fictional-token', orgId: org, email: 'practitioner@fictional.example' }); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('the guard', () => {
  it('refuses an unsafe origin, a missing session, an unknown action and an oversized body', async () => {
    expect((await POST(req({ action: 'status', programId: program }, { origin: 'https://evil.example' }))).status).toBe(403);
    session.mockResolvedValue({ token: null, orgId: null, email: null });
    expect((await POST(req({ action: 'status', programId: program }))).status).toBe(401);
    session.mockResolvedValue({ token: 'fictional-token', orgId: org, email: 'practitioner@fictional.example' });
    expect((await POST(req({ action: 'orders', programId: program }))).status).toBe(400);
    expect((await POST(req({ action: 'status', programId: program, organizationId: 'other' }))).status).toBe(400);
    expect((await POST(req({ action: 'status', programId: program, pad: 'x'.repeat(2000) }))).status).toBe(400);
  });
  it('answers 503 commerce_disabled outside the fixture', async () => {
    const response = await POST(req({ action: 'status', programId: program }));
    expect(response.status).toBe(503);
    expect((await body(response)).error?.message).toBe('commerce_disabled');
  });
});

describe('under the local fixture', () => {
  beforeEach(fixture);
  it('returns the clinic\'s orders and entitlements under the commercial key, and reads the exact purchased version for its own entitlement only', async () => {
    const offers = selectProgramOfferLedger();
    if (offers.kind !== 'fictional') throw new Error('fixture expected');
    offers.registerCurriculum(org, program, { versionId: version, version: 1, sourceDigest: 'a'.repeat(64) }, { title: 'Fictional guide', phases: [{ title: 'Phase one' }] });
    const me: OfferActor = { personId: '44444444-4444-4444-8444-444444444444', organizationId: org };
    const created = await offers.ledger.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } });
    const offerId = created.action === 'create' ? created.offer.offerId : '';
    await offers.ledger.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
    await offers.ledger.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
    const empty = await body(await POST(req({ action: 'status', programId: program })));
    expect(empty.data?.commercial).toMatchObject({ orders: [], entitlements: [], claims: [], enrollments: [] });
    const selection = selectProgramCheckout();
    if (selection.kind !== 'fictional') throw new Error('fixture expected');
    const started = await selection.checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey: 'browser-a' });
    const order = selection.ledger.orders.get(started.started ? started.orderId : '')!;
    selection.processor.settle(order.processor!.sessionRef, 'paid');
    await selection.checkout.admitEvent({ id: 'evt_1', type: 'checkout.session.completed', livemode: false, created: 1, data: { object: { object: 'checkout.session', id: order.processor!.sessionRef } } }, 'raw', selection.expected);
    await selection.checkout.processEvent('evt_1');
    await selection.settlement.settleDue();
    const status = await body(await POST(req({ action: 'status', programId: program })));
    const commercial = status.data!.commercial as { orders: { state: string }[]; entitlements: { entitlementId: string; state: string }[]; claims: { state: string }[] };
    expect(commercial.orders.map(o => o.state)).toEqual(['payment_verified']);
    expect(commercial.entitlements.map(e => e.state)).toEqual(['awaiting_claim']);
    expect(commercial.claims.map(c => c.state)).toEqual(['issued']);
    expect(JSON.stringify(status)).not.toContain('claimToken');
    expect(JSON.stringify(status)).not.toContain(selection.deliveries[0]!.claimToken);
    const read = await body(await POST(req({ action: 'curriculum', entitlementId: commercial.entitlements[0]!.entitlementId })));
    expect(read.data?.commercial.curriculum).toMatchObject({ outcome: 'served', title: 'Fictional guide' });
    session.mockResolvedValue({ token: 'fictional-token', orgId: '55555555-5555-4555-8555-555555555555', email: 'other@fictional.example' });
    const stranger = await body(await POST(req({ action: 'curriculum', entitlementId: commercial.entitlements[0]!.entitlementId })));
    expect(stranger.data?.commercial.curriculum).toMatchObject({ outcome: 'withheld', reason: 'not_owner' });
    expect((await body(await POST(req({ action: 'status', programId: program })))).data?.commercial).toMatchObject({ orders: [], entitlements: [] });
  });
});
