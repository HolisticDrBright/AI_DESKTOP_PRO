import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as learnerRoute } from './route';
import { POST as fixtureRoute } from '../live/commerce/fixture/route';
import { POST as checkoutRoute } from '../live/commerce/checkout/route';
import { POST as webhookRoute } from '../live/commerce/webhook/route';
import { __resetProgramCommerceRuntime, selectProgramCheckout } from '@/server/commerce/program-commerce-runtime';
import { JOURNEY_FIXTURE, __resetJourneySeed } from '@/server/commerce/journey-fixture';
import { FIXTURE_LEARNER_COOKIE, __resetLearnerHost, installLearnerHost, selectLearnerHost, type LearnerHost } from '@/server/learner/learner-host';
import { EducationProgressError } from '@/server/commerce/education-progress-service';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import { AUTH_COOKIES } from '@/adapters/auth.server';

/**
 * My courses, server side (hardening WP2): the learner route reads and writes only through a learner
 * host. Without one it is unavailable and constructs nothing; with the journey fixture's host it
 * runs the real access and progress services for a fixture learner; with a reviewed host it trusts
 * that host's identity and re-checks it after every service call. Fictional values only.
 */
const origin = 'http://127.0.0.1:3000';
const SECRET = 'whsec_fixture_journey_only';
const sign = (raw: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`, 'utf8').digest('hex')}`; };
const fixtureEnv = () => {
  vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', '1'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CLINICAL_SUPABASE_URL', 'http://127.0.0.1:3999'); vi.stubEnv('APP_RUNTIME_ENV', ''); vi.stubEnv('CLINICAL_AWS_RUNTIME_MODE', '');
  vi.stubEnv('STRIPE_TEST_MODE_ENABLED', '1'); vi.stubEnv('STRIPE_TEST_SECRET_KEY', 'sk_test_fixture_journey_only'); vi.stubEnv('STRIPE_TEST_WEBHOOK_SECRET', SECRET); vi.stubEnv('COMMERCE_JOURNEY_FIXTURE', '1');
};
const sameOrigin = { host: '127.0.0.1:3000', origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
async function learner(body: unknown, cookie = '', headers: Record<string, string> = sameOrigin) {
  const response = await learnerRoute(new Request(`${origin}/api/my-courses`, { method: 'POST', headers: { ...headers, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
  return { status: response.status, cache: response.headers.get('cache-control'), json: await response.json() as { data?: Record<string, unknown>; host?: string; error?: { code: string } } };
}
async function fixture<T = Record<string, unknown>>(body: unknown) {
  const response = await fixtureRoute(new Request(`${origin}/api/live/commerce/fixture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: response.status, data: ((await response.json()) as { data: T }).data, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0]! };
}
async function event(id: string, type: string, sessionRef: string) {
  const raw = JSON.stringify({ id, type, livemode: false, created: Math.floor(Date.now() / 1000), api_version: '2025-08-27.basil', data: { object: { object: 'checkout.session', id: sessionRef } } });
  return webhookRoute(new Request(`${origin}/api/live/commerce/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) }, body: raw }));
}
/** The returned journey: buy, pay, the worker settles and delivers, learner A claims through the real access service. */
async function purchasedAndClaimed() {
  await fixture({ action: 'reset' });
  const started = await checkoutRoute(new Request(`${origin}/api/live/commerce/checkout`, { method: 'POST', headers: { ...sameOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: `funnelSlug=${JOURNEY_FIXTURE.slug}` }));
  expect(started.status, 'checkout started').toBe(200);
  const orders = (await fixture<{ commercial: { orders: { orderId: string }[] } }>({ action: 'staff' })).data.commercial.orders;
  expect(orders, 'one order').toHaveLength(1);
  const orderId = orders[0]!.orderId;
  const paid = await fixture<{ sessionRef: string }>({ action: 'pay', orderId, outcome: 'paid' });
  expect((await event('evt_learner_1', 'checkout.session.completed', paid.data.sessionRef)).status, 'event admitted').toBe(200);
  const pass = await fixture<{ settlement: unknown; delivery: unknown }>({ action: 'work' });
  const messages = (await fixture<{ messages: { text: string }[] }>({ action: 'mailbox' })).data.messages;
  expect(messages, `one delivered code after one worker pass: ${JSON.stringify(pass.data)}`).toHaveLength(1);
  const code = /^([A-Za-z0-9_-]{43})$/m.exec(messages[0]!.text)![1]!;
  expect((await fixture({ action: 'consumer', learner: 'a', service: 'access', body: { action: 'claim', token: code } })).data).toMatchObject({ outcome: 'claimed' });
  return { orderId };
}
const context = (subject: string): ClinicalRequestContext => ({ actorPersonId: '7e1a0000-0000-4000-8000-0000000000c1', organizationId: JOURNEY_FIXTURE.organizationId, identityPool: 'consumer', identitySubject: subject,
  purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false });
beforeEach(() => { __resetProgramCommerceRuntime(); __resetJourneySeed(); __resetLearnerHost(); });
afterEach(() => { vi.unstubAllEnvs(); __resetLearnerHost(); });

describe('without a reviewed host, My courses is unavailable and constructs nothing', () => {
  it('answers learner_host_unavailable, privately, and no fictional ledger exists', async () => {
    const reply = await learner({ service: 'education', body: { action: 'access' } });
    expect(reply).toMatchObject({ status: 503, cache: 'no-store, private', json: { error: { code: 'learner_host_unavailable' } } });
    expect(selectLearnerHost()).toBeNull();
    expect(selectProgramCheckout().kind).toBe('disabled');
  });
  it('the contract fixture alone is not the journey fixture: still no host', async () => {
    fixtureEnv(); vi.stubEnv('COMMERCE_JOURNEY_FIXTURE', '');
    expect(selectLearnerHost()).toBeNull();
    expect((await learner({ service: 'education', body: { action: 'access' } })).status).toBe(503);
  });
  it('refuses a request that is not same-origin before anything else', async () => {
    fixtureEnv();
    for (const headers of [{ 'content-type': 'application/json' }, { ...sameOrigin, 'sec-fetch-site': 'cross-site' }, { ...sameOrigin, origin: 'https://elsewhere.example' }]) {
      expect(await learner({ service: 'education', body: { action: 'access' } }, '', headers)).toMatchObject({ status: 403, cache: 'no-store, private' });
    }
  });
});

describe('who the learner is comes from the host, never from the browser or a workforce session', () => {
  it('no learner session, a workforce session, or a made-up session token is not a learner', async () => {
    fixtureEnv();
    await purchasedAndClaimed();
    for (const cookie of ['', `${AUTH_COOKIES.access}=fictional-workforce-token; ${AUTH_COOKIES.refresh}=fictional-refresh`, `${FIXTURE_LEARNER_COOKIE}=${'x'.repeat(43)}`]) {
      expect(await learner({ service: 'education', body: { action: 'access' } }, cookie)).toMatchObject({ status: 401, cache: 'no-store, private', json: { error: { code: 'learner_signin_required' } } });
    }
  });
  it('a subject, person or clinic in the body is refused, and a claim is not taken here', async () => {
    fixtureEnv();
    const { cookie } = await fixture({ action: 'learner_session', learner: 'a' });
    expect((await learner({ service: 'education', body: { action: 'access' }, identitySubject: JOURNEY_FIXTURE.learners.b.identitySubject }, cookie)).status).toBe(400);
    expect((await learner({ service: 'education', body: { action: 'access', personId: JOURNEY_FIXTURE.learners.b.personId } }, cookie)).status).toBe(400);
    expect((await learner({ service: 'education', body: { action: 'claim', token: 'a'.repeat(43) } }, cookie)).status).toBe(400);
  });
});

describe('the fixture host runs the real services for a fixture learner', () => {
  it('learner A reads the exact purchased course and saves progress; learner B sees nothing of it; a revoked session reads nothing', async () => {
    fixtureEnv();
    await purchasedAndClaimed();
    const a = (await fixture({ action: 'learner_session', learner: 'a' })).cookie;
    const b = (await fixture({ action: 'learner_session', learner: 'b' })).cookie;
    expect(a).toMatch(new RegExp(`^${FIXTURE_LEARNER_COOKIE}=[A-Za-z0-9_-]{43}$`));
    const access = await learner({ service: 'education', body: { action: 'access' } }, a);
    expect(access).toMatchObject({ status: 200, cache: 'no-store, private', json: { host: 'fictional_fixture', data: { action: 'access' } } });
    const view = access.json.data!.view as { entitlements: { entitlementId: string; curriculum: unknown }[]; enrollments: { enrollmentId: string }[] };
    const entitlement = view.entitlements[0]!;
    expect((await learner({ service: 'education', body: { action: 'curriculum', entitlementId: entitlement.entitlementId } }, a)).json.data).toMatchObject({ read: { outcome: 'served', title: 'Fictional journey course (test fixture)' } });
    const write = { action: 'complete', entitlementId: entitlement.entitlementId, enrollmentId: view.enrollments[0]!.enrollmentId, curriculum: entitlement.curriculum, lesson: { phaseId: 'phase-1', itemId: 'lesson-a' }, expectedRevision: 0, requestId: '7e1a0000-0000-4000-8000-0000000000d1' };
    expect((await learner({ service: 'progress', body: write }, a)).json.data).toMatchObject({ outcome: { outcome: 'recorded', receipt: { revision: 1 } } });
    // B is another account: no course listed, the curriculum withheld, a write refused.
    expect((await learner({ service: 'education', body: { action: 'access' } }, b)).json.data).toMatchObject({ view: { entitlements: [] } });
    expect((await learner({ service: 'education', body: { action: 'curriculum', entitlementId: entitlement.entitlementId } }, b)).json.data).toMatchObject({ read: { outcome: 'withheld', reason: 'not_owner' } });
    expect((await learner({ service: 'progress', body: { ...write, requestId: '7e1a0000-0000-4000-8000-0000000000d2' } }, b)).json.data).toMatchObject({ outcome: { outcome: 'refused', reason: 'not_owner' } });
    // Signed out elsewhere: the same cookie now reads nothing.
    await fixture({ action: 'learner_revoke', learner: 'a' });
    expect(await learner({ service: 'education', body: { action: 'access' } }, a)).toMatchObject({ status: 401, json: { error: { code: 'learner_signin_required' } } });
  });
});

describe('a reviewed host: identity is re-checked after every service call', () => {
  function reviewedHost() {
    let who: ClinicalRequestContext | null = context('sub:fictional-reviewed-a');
    let release: () => void = () => undefined;
    const barrier = () => new Promise<void>(resolve => { release = resolve; });
    const progress = vi.fn(async (_context: ClinicalRequestContext, _body: unknown) => ({ action: 'read' as const, read: { outcome: 'refused' as const, reason: 'not_active' as const } }));
    const host: LearnerHost = { kind: 'reviewed', identify: async () => who, services: () => ({ education: async () => { throw new Error('unused'); }, progress }) };
    installLearnerHost(host);
    return { set: (next: ClinicalRequestContext | null) => { who = next; }, barrier, release: () => release(), progress };
  }
  const read = { service: 'progress', body: { action: 'read', entitlementId: '7e1a0000-0000-4000-8000-0000000000e1' } };
  it('a reply finished after the learner was signed out or replaced is discarded, not returned', async () => {
    const host = reviewedHost();
    expect(await learner(read)).toMatchObject({ status: 200, json: { host: 'reviewed', data: { action: 'read' } } });
    host.progress.mockClear();
    for (const lapse of [null, context('sub:fictional-reviewed-b')]) {
      host.set(context('sub:fictional-reviewed-a'));
      const gate = host.barrier();
      host.progress.mockImplementationOnce(async () => { await gate; return { action: 'read', read: { outcome: 'refused', reason: 'not_active' } }; });
      const pending = learner(read);
      await vi.waitFor(() => expect(host.progress).toHaveBeenCalled());
      host.set(lapse);
      host.release();
      const reply = await pending;
      expect(reply).toMatchObject({ status: 401, cache: 'no-store, private', json: { error: { code: 'learner_signin_required' } } });
      expect(reply.json.data).toBeUndefined();
      host.progress.mockClear();
    }
  });
  it('discards an in-flight reply when the same learner changes clinic or data boundary', async () => {
    const host = reviewedHost();
    for (const changed of [
      { ...context('sub:fictional-reviewed-a'), organizationId: '7e1a0000-0000-4000-8000-0000000000f1' },
      { ...context('sub:fictional-reviewed-a'), purpose: 'consent_management' as const },
      { ...context('sub:fictional-reviewed-a'), environment: 'production-clinical' as const, dataClassification: 'clinical_phi' as const, containsPhi: true as const, realPatientData: true as const, productionBound: true as const },
    ]) {
      host.set(context('sub:fictional-reviewed-a'));
      const gate = host.barrier();
      host.progress.mockImplementationOnce(async () => { await gate; return { action: 'read', read: { outcome: 'refused', reason: 'not_active' } }; });
      const pending = learner(read);
      await vi.waitFor(() => expect(host.progress).toHaveBeenCalled());
      host.set(changed);
      host.release();
      const reply = await pending;
      expect(reply).toMatchObject({ status: 401, cache: 'no-store, private', json: { error: { code: 'learner_signin_required' } } });
      expect(reply.json.data).toBeUndefined();
      host.progress.mockClear();
    }
  });
  it('a service refusal is reported as itself while the learner is still verified, and as sign-in when not', async () => {
    const host = reviewedHost();
    host.progress.mockRejectedValueOnce(new EducationProgressError('request_invalid'));
    expect((await learner(read)).status).toBe(400);
    host.progress.mockRejectedValueOnce(new EducationProgressError('identity_refused'));
    expect((await learner(read)).status).toBe(403);
    host.progress.mockImplementationOnce(async () => { host.set(null); throw new EducationProgressError('service_unavailable'); });
    expect((await learner(read)).status).toBe(401);
  });
  it('does not accept workforce or unrelated-purpose identity from a reviewed learner host', async () => {
    const host = reviewedHost();
    for (const invalid of [
      { ...context('sub:fictional-reviewed-a'), identityPool: 'workforce' as const },
      { ...context('sub:fictional-reviewed-a'), purpose: 'identity_link' as const },
    ]) {
      host.set(invalid);
      expect(await learner(read)).toMatchObject({ status: 401, json: { error: { code: 'learner_signin_required' } } });
    }
    expect(host.progress).not.toHaveBeenCalled();
  });
  it('only a reviewed host may be installed, once', () => {
    expect(() => installLearnerHost({ kind: 'fictional_fixture' } as LearnerHost)).toThrow('learner_host_must_be_reviewed');
    reviewedHost();
    expect(() => installLearnerHost({ kind: 'reviewed', identify: async () => null, services: () => { throw new Error('x'); } })).toThrow('learner_host_already_installed');
  });
});
