import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as fixtureRoute } from './route';
import { POST as checkoutRoute } from '../checkout/route';
import { POST as webhookRoute } from '../webhook/route';
import { __resetProgramCommerceRuntime } from '@/server/commerce/program-commerce-runtime';
import { JOURNEY_FIXTURE, __resetJourneySeed, resolvePublicFunnel } from '@/server/commerce/journey-fixture';
import { publishedFunnel, allFunnels } from '@/funnels';

/**
 * The journey fixture at route level: the same route handlers the browser journey mounts, called in
 * one process. The fixture exists only with the contract fixture AND its own flag; the real funnel
 * definitions are never published by it. The payment events are signed over their exact bytes and
 * go through the real webhook route; the real worker does every step after admission.
 */
const SECRET = 'whsec_fixture_journey_only';
const origin = 'http://127.0.0.1:3000';
const sign = (raw: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`, 'utf8').digest('hex')}`; };
const env = (journey: boolean) => {
  vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', '1'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CLINICAL_SUPABASE_URL', 'http://127.0.0.1:3999'); vi.stubEnv('APP_RUNTIME_ENV', ''); vi.stubEnv('CLINICAL_AWS_RUNTIME_MODE', '');
  vi.stubEnv('STRIPE_TEST_MODE_ENABLED', '1'); vi.stubEnv('STRIPE_TEST_SECRET_KEY', 'sk_test_fixture_journey_only'); vi.stubEnv('STRIPE_TEST_WEBHOOK_SECRET', SECRET);
  if (journey) vi.stubEnv('COMMERCE_JOURNEY_FIXTURE', '1');
};
async function fixture<T = Record<string, unknown>>(body: unknown): Promise<{ status: number; data: T }> {
  const response = await fixtureRoute(new Request(`${origin}/api/live/commerce/fixture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: response.status, data: ((await response.json()) as { data: T }).data };
}
async function buy(cookie = '') {
  const response = await checkoutRoute(new Request(`${origin}/api/live/commerce/checkout`, { method: 'POST', headers: { host: '127.0.0.1:3000', origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: `funnelSlug=${JOURNEY_FIXTURE.slug}` }));
  // A started checkout answers a same-site page linking to the processor; a hold answers a redirect back with the reason.
  const link = response.status === 200 ? /data-testid="checkout-continue-link" href="([^"]+)"/.exec(await response.text())?.[1]?.replace(/&amp;/g, '&') ?? '' : '';
  return { status: response.status, location: response.headers.get('location') ?? link, cookie: (response.headers.get('set-cookie') ?? cookie).split(';')[0]! };
}
async function event(id: string, type: string, sessionRef: string) {
  const raw = JSON.stringify({ id, type, livemode: false, created: Math.floor(Date.now() / 1000), api_version: '2025-08-27.basil', data: { object: { object: 'checkout.session', id: sessionRef } } });
  return webhookRoute(new Request(`${origin}/api/live/commerce/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) }, body: raw }));
}
const consumer = (learner: 'a' | 'b', service: 'access' | 'progress', body: unknown) => fixture<Record<string, unknown>>({ action: 'consumer', learner, service, body });
beforeEach(() => { __resetProgramCommerceRuntime(); __resetJourneySeed(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('the journey fixture is separate', () => {
  it('does not exist without its own flag, and never publishes a repository funnel', async () => {
    env(false);
    expect((await fixture({ action: 'work' })).status).toBe(404);
    expect(await resolvePublicFunnel(JOURNEY_FIXTURE.slug)).toBeNull();
    expect((await buy()).status).toBe(404);
    env(true);
    expect(await resolvePublicFunnel(JOURNEY_FIXTURE.slug)).toMatchObject({ slug: JOURNEY_FIXTURE.slug, approval: { by: 'FICTIONAL REVIEW FIXTURE' } });
    expect(allFunnels().every(funnel => funnel.status === 'draft' && funnel.programBinding === null)).toBe(true);
    expect(publishedFunnel(JOURNEY_FIXTURE.slug)).toBeNull();
    vi.unstubAllEnvs();
    vi.stubEnv('COMMERCE_JOURNEY_FIXTURE', '1');
    expect(await resolvePublicFunnel(JOURNEY_FIXTURE.slug)).toBeNull();
  });
});

describe('purchase to learning through the route handlers', () => {
  it('buy, delayed payment then success, delivered code, claim, exact course, a completion seen from a second device', async () => {
    env(true);
    await fixture({ action: 'reset' });
    const started = await buy();
    expect(started.status).toBe(200);
    expect(new URL(started.location).host).toBe('checkout.fictional.example');
    const again = await buy(started.cookie);
    expect(again.location).toBe(started.location);
    const staffBefore = await fixture<{ commercial: { orders: { orderId: string; state: string }[] } }>({ action: 'staff' });
    const orderId = staffBefore.data.commercial.orders[0]!.orderId;
    expect(staffBefore.data.commercial.orders).toHaveLength(1);
    const paid = await fixture<{ sessionRef: string }>({ action: 'pay', orderId, outcome: 'processing' });
    expect((await event('evt_journey_1', 'checkout.session.completed', paid.data.sessionRef)).status).toBe(200);
    // The webhook only admitted it; nothing moved until the worker ran.
    expect((await fixture<{ commercial: { orders: { state: string }[] } }>({ action: 'staff' })).data.commercial.orders[0]!.state).toBe('checkout_open');
    await fixture({ action: 'work' });
    expect((await fixture<{ commercial: { orders: { state: string }[]; entitlements: unknown[] } }>({ action: 'staff' })).data.commercial).toMatchObject({ orders: [{ state: 'payment_processing' }], entitlements: [] });
    await fixture({ action: 'pay', orderId, outcome: 'succeeded_async' });
    expect((await event('evt_journey_2', 'checkout.session.async_payment_succeeded', paid.data.sessionRef)).status).toBe(200);
    // A duplicate delivery of the same event is a recorded duplicate.
    expect(await (await event('evt_journey_2', 'checkout.session.async_payment_succeeded', paid.data.sessionRef)).json()).toMatchObject({ outcome: 'duplicate' });
    await fixture({ action: 'work' });
    const mail = await fixture<{ messages: { text: string }[] }>({ action: 'mailbox' });
    expect(mail.data.messages).toHaveLength(1);
    const code = /\b([A-Za-z0-9_-]{43})\b/.exec(mail.data.messages[0]!.text)![1]!;
    // Learner A claims; learner B, another account, cannot take it.
    expect((await consumer('a', 'access', { action: 'claim', token: code })).data).toMatchObject({ action: 'claim', outcome: 'claimed' });
    expect((await consumer('b', 'access', { action: 'claim', token: code })).data).toMatchObject({ action: 'claim', outcome: 'refused', reason: 'already_claimed_by_other' });
    const access = (await consumer('a', 'access', { action: 'access' })).data as { view: { entitlements: { entitlementId: string; curriculum: unknown }[]; enrollments: { enrollmentId: string }[] } };
    expect(access.view.entitlements).toHaveLength(1);
    expect(access.view.enrollments).toHaveLength(1);
    const entitlement = access.view.entitlements[0]!;
    expect((await consumer('a', 'access', { action: 'curriculum', entitlementId: entitlement.entitlementId })).data).toMatchObject({ read: { outcome: 'served', title: 'Fictional journey course (test fixture)' } });
    expect((await consumer('b', 'access', { action: 'curriculum', entitlementId: entitlement.entitlementId })).data).toMatchObject({ read: { outcome: 'withheld', reason: 'not_owner' } });
    // Device one completes lesson A; device two reads the same record.
    const write = { action: 'complete', entitlementId: entitlement.entitlementId, enrollmentId: access.view.enrollments[0]!.enrollmentId, curriculum: entitlement.curriculum, lesson: { phaseId: 'phase-1', itemId: 'lesson-a' }, expectedRevision: 0, requestId: '7e1a0000-0000-4000-8000-0000000000aa' };
    expect((await consumer('a', 'progress', write)).data).toMatchObject({ outcome: { outcome: 'recorded', receipt: { revision: 1 } } });
    expect((await consumer('a', 'progress', write)).data).toMatchObject({ outcome: { outcome: 'recorded', receipt: { revision: 1 } } });
    expect((await consumer('a', 'progress', { action: 'read', entitlementId: entitlement.entitlementId })).data).toMatchObject({ read: { outcome: 'read', progress: { revision: 1, completed: [{ lesson: { itemId: 'lesson-a' } }] } } });
    // Staff see one order, one entitlement, one enrollment and the delivery state, never the code.
    const staff = await fixture<{ commercial: Record<string, unknown[]> }>({ action: 'staff' });
    expect(staff.data.commercial).toMatchObject({ orders: [{ state: 'payment_verified' }], entitlements: [{ state: 'active' }], enrollments: [{}] });
    expect(JSON.stringify(staff.data)).not.toContain(code);
    // A refund hold stops progress and the course; the operator's release restores both.
    await fixture({ action: 'operator', op: 'refund', orderId });
    expect((await consumer('a', 'progress', { ...write, requestId: '7e1a0000-0000-4000-8000-0000000000ab', lesson: { phaseId: 'phase-1', itemId: 'habit-b' }, expectedRevision: 1 })).data).toMatchObject({ outcome: { outcome: 'refused', reason: 'not_active' } });
    expect((await consumer('a', 'access', { action: 'curriculum', entitlementId: entitlement.entitlementId })).data).toMatchObject({ read: { outcome: 'withheld', reason: 'not_active' } });
    await fixture({ action: 'operator', op: 'operator_release', orderId });
    expect((await consumer('a', 'access', { action: 'curriculum', entitlementId: entitlement.entitlementId })).data).toMatchObject({ read: { outcome: 'served' } });
  });
  it('a processor outage holds the start; a catalog outage is unverifiable, not "no offer"; a later version refuses new purchases while the bought one is kept', async () => {
    env(true);
    await fixture({ action: 'reset' });
    await fixture({ action: 'outage', target: 'processor', down: true });
    const held = await buy();
    expect(new URL(held.location).searchParams.get('hold')).toBe('processor_unavailable');
    await fixture({ action: 'outage', target: 'processor', down: false });
    await fixture({ action: 'outage', target: 'catalog', down: true });
    expect(new URL((await buy()).location).searchParams.get('hold')).toBe('commerce_unverifiable');
    await fixture({ action: 'outage', target: 'catalog', down: false });
    await fixture({ action: 'publish', variant: 'later' });
    expect(new URL((await buy()).location).searchParams.get('hold')).toBe('curriculum_changed');
  });
});
