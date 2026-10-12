import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST as webhookRoute } from '../../app/api/live/commerce/webhook/route';
import { POST as myCoursesRoute } from '../../app/api/my-courses/route';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import { codeFromMessage, createFictionalClaimSealer, createFictionalContactAuthority, createFictionalDeliveryProvider } from './program-claim-delivery';
import { installAcceptanceCheckout, selectProgramCheckout } from './program-commerce-runtime';
import { installAcceptanceLearnerHost, __resetLearnerHost } from '../learner/learner-host';
import { ACCEPTANCE_FIXTURE, ACCEPTANCE_LEARNER_COOKIE, createFictionalIdentityIssuer, openSqlAcceptanceHost, publishAcceptanceOffer, type AcceptanceBoundaries, type SqlAcceptanceHost } from './sql-acceptance-host';
import { JOURNEY_COURSE_TITLE } from './journey-fixture';
import { createProgramSettlement } from './program-settlement';

/**
 * Hardening WP3: the purchase-to-learning path through the actual BLOCKED candidate chain, the SQL
 * ledger adapters and reduced database sessions, on an embedded database kept ON DISK, with the
 * real services above it and the real webhook and My courses route handlers mounted on it. The
 * processor, contacts, delivery provider, identity issuer and sealing key are named fictional
 * boundaries kept across restarts; nothing else survives a restart but the database directory.
 *
 * Restarts are of two kinds and are labelled as such: a FRESH INSTANCE (the host and its database
 * closed and a new one opened on the same directory, in this process) and a SEPARATE PROCESS (a child
 * process opens the directory, writes through the real progress service and exits).
 *
 * The embedded engine runs one connection and serializes every statement; nothing here is evidence
 * of real PostgreSQL lock contention, which is hosted acceptance.
 */
const SECRET = 'whsec_fixture_journey_only';
const origin = 'http://127.0.0.1:3000';
const env = (admitted = true) => {
  vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', '1'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CLINICAL_SUPABASE_URL', 'http://127.0.0.1:3999'); vi.stubEnv('APP_RUNTIME_ENV', ''); vi.stubEnv('CLINICAL_AWS_RUNTIME_MODE', '');
  vi.stubEnv('STRIPE_TEST_MODE_ENABLED', '1'); vi.stubEnv('STRIPE_TEST_SECRET_KEY', 'sk_test_fixture_journey_only'); vi.stubEnv('STRIPE_TEST_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('COMMERCE_JOURNEY_FIXTURE', ''); vi.stubEnv('COMMERCE_SQL_ACCEPTANCE', admitted ? '1' : '');
};
const sealerKey = { key: randomBytes(32), keyRef: 'fictional-sealer:acceptance' };
const boundaries: AcceptanceBoundaries = { processor: createFictionalCheckoutProcessor(), contacts: createFictionalContactAuthority(), provider: createFictionalDeliveryProvider(), identity: createFictionalIdentityIssuer(), sealerKey };
// The processor's own price list holds the fixture amount the offer was published with.
boundaries.processor.setPriceAmount('price_FictionalAccept01', 1234);
const operator = { kind: 'operator' as const, operatorId: 'op:fictional-acceptance-operator' };
const staff = { kind: 'staff' as const, personId: ACCEPTANCE_FIXTURE.staffPersonId, organizationId: ACCEPTANCE_FIXTURE.organizationId, identitySubject: 'wf:' + ACCEPTANCE_FIXTURE.staffPersonId };
const otherStaff = { kind: 'staff' as const, personId: ACCEPTANCE_FIXTURE.otherStaffPersonId, organizationId: ACCEPTANCE_FIXTURE.otherOrganizationId, identitySubject: 'wf:' + ACCEPTANCE_FIXTURE.otherStaffPersonId };
const lessonA = { phaseId: 'phase-1', itemId: 'lesson-a' }, habitB = { phaseId: 'phase-1', itemId: 'habit-b' }, lessonC = { phaseId: 'phase-2', itemId: 'lesson-c' };

let dir = '';
let host: SqlAcceptanceHost;
async function open() {
  host = await openSqlAcceptanceHost(dir, boundaries);
  installAcceptanceCheckout(host.selection);
  installAcceptanceLearnerHost(host.learnerHost);
  return host;
}
async function shut() { installAcceptanceCheckout(null); installAcceptanceLearnerHost(null); await host?.close(); }
/** A FRESH INSTANCE: nothing of the previous host is kept but the directory and the outside boundaries. */
async function restart() { await shut(); return open(); }
async function signedEvent(id: string, type: string, sessionRef: string) {
  const raw = JSON.stringify({ id, type, livemode: false, created: Math.floor(Date.now() / 1000), api_version: '2025-08-27.basil', data: { object: { object: 'checkout.session', id: sessionRef } } });
  const t = Math.floor(Date.now() / 1000);
  const response = await webhookRoute(new Request(`${origin}/api/live/commerce/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`, 'utf8').digest('hex')}` }, body: raw }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
async function myCourses(learner: 'a' | 'b' | null, body: unknown) {
  const cookie = learner ? `${ACCEPTANCE_LEARNER_COOKIE}=${boundaries.identity.signIn(learner)}` : '';
  const response = await myCoursesRoute(new Request(`${origin}/api/my-courses`, { method: 'POST', headers: { host: '127.0.0.1:3000', origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
  return { status: response.status, cache: response.headers.get('cache-control'), json: await response.json() as { data?: Record<string, unknown>; host?: string; error?: { code: string } } };
}
const lastCodeTo = (address: string) => codeFromMessage([...boundaries.provider.mailbox].reverse().find(m => m.to === address)!);
const addressFor = (orderId: string) => `purchaser+${orderId.slice(0, 8)}@acceptance.fictional.example`;
/** Start, pay and acknowledge one order through the services and the signed webhook route; the worker runs separately. */
async function startAndPay(attemptKey: string, outcome: 'paid' | 'processing') {
  const started = await host.checkout.start({ funnelSlug: 'fictional-acceptance', programBinding: { organizationId: ACCEPTANCE_FIXTURE.organizationId, programId: ACCEPTANCE_FIXTURE.programId }, attemptKey });
  if (!started.started) throw new Error('checkout held: ' + started.reason);
  // A lost creation reply: the same browser attempt, before paying, answers the same order and session.
  expect(await host.checkout.start({ funnelSlug: 'fictional-acceptance', programBinding: { organizationId: ACCEPTANCE_FIXTURE.organizationId, programId: ACCEPTANCE_FIXTURE.programId }, attemptKey })).toMatchObject({ started: true, orderId: started.orderId, checkoutUrl: started.checkoutUrl });
  const order = (await host.orders.readOrder(started.orderId))!;
  boundaries.processor.settle(order.processor!.sessionRef, outcome);
  boundaries.contacts.contacts.set(order.orderId, addressFor(order.orderId));
  expect((await signedEvent('evt_' + attemptKey, 'checkout.session.completed', order.processor!.sessionRef)).status).toBe(200);
  return { orderId: order.orderId, sessionRef: order.processor!.sessionRef, started };
}

beforeAll(async () => {
  env();
  dir = mkdtempSync(join(tmpdir(), 'alp-sql-acceptance-'));
  await open();
  await publishAcceptanceOffer(host);
}, 180_000);
afterAll(async () => { await shut(); __resetLearnerHost(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => env());
afterEach(() => { boundaries.contacts.setFailing(false); host.faults.down.clear(); host.faults.before = undefined; });

describe('the acceptance host is its own, separately gated test target', () => {
  it('without its flag it does not open, cannot be installed, and the routes do not see it', async () => {
    env(false);
    await expect(openSqlAcceptanceHost(join(dir, 'never'), boundaries)).rejects.toThrow('sql_acceptance_not_admitted');
    expect(() => installAcceptanceCheckout(host.selection)).toThrow('sql_acceptance_not_admitted');
    expect(selectProgramCheckout().kind).toBe('fictional');
    expect((await myCourses('a', { service: 'education', body: { action: 'access' } })).status).toBe(503);
  });
  it('built the whole chain once, and each authority is a session whose SESSION user is that role', async () => {
    expect(host.fresh).toBe(true);
    const who = await host.sessions.api.transaction(tx => tx.query<{ s: string; c: string }>('select session_user::text as s, current_user::text as c'));
    expect(who.rows[0]).toEqual({ s: 'clinical_core_api', c: 'clinical_core_api' });
    await expect(host.sessions.api.transaction(tx => tx.query('set role commercial_education_worker'))).rejects.toBeTruthy();
    await expect(host.sessions.api.transaction(tx => tx.query('select * from commercial_education.program_orders'))).rejects.toBeTruthy();
    await expect(host.sessions.delivery.transaction(tx => tx.query("select commercial_education.reissue_program_claim(gen_random_uuid(),gen_random_uuid(),repeat('a',64),now(),'{}'::jsonb,'op:x')"))).rejects.toBeTruthy();
  });
});

let orderA = '', entitlementA = '', enrollmentA = '', curriculumA: Record<string, unknown> = {};
describe('purchase to learning, recovered from the database after every acknowledgment', () => {
  it('admitted checkout and delayed payment, signed intake; a FRESH INSTANCE after each acknowledgment finishes the work', async () => {
    const first = await startAndPay('browser-a', 'processing');
    orderA = first.orderId;
    // Acknowledged and nothing else: the order has not moved.
    expect((await host.orders.readOrder(orderA))!.state).toBe('checkout_open');
    await restart();
    expect(host.fresh).toBe(false);
    await host.worker.runOnce();
    expect((await host.orders.readOrder(orderA))!.state).toBe('payment_processing');
    boundaries.processor.settle(first.sessionRef, 'succeeded_async');
    expect((await signedEvent('evt_browser-a-async', 'checkout.session.async_payment_succeeded', first.sessionRef)).status).toBe(200);
    // A duplicate delivery of the same event is a recorded duplicate.
    expect((await signedEvent('evt_browser-a-async', 'checkout.session.async_payment_succeeded', first.sessionRef)).body).toMatchObject({ outcome: 'duplicate' });
    await restart();
    const pass = await host.worker.runOnce();
    expect(pass.settlement).toMatchObject({ ok: true });
    expect(pass.delivery).toMatchObject({ ok: true, results: [{ state: 'accepted' }] });
    expect((await host.orders.readOrder(orderA))!.state).toBe('payment_verified');
    const status = await host.education.listForProgram(staff, ACCEPTANCE_FIXTURE.programId);
    expect(status).toMatchObject({ orders: [{ state: 'payment_verified' }], entitlements: [{ state: 'awaiting_claim' }] });
    // The code reached the purchaser's inbox; it is in no staff status.
    const code = lastCodeTo(addressFor(orderA));
    expect(JSON.stringify(status)).not.toContain(code);
  });
  it('a verified consumer claims once (a retry gets the same receipt, another account is refused); My courses serves exactly what was bought', async () => {
    const code = lastCodeTo(addressFor(orderA));
    const claim = (learner: 'a' | 'b') => host.accessService(host.contextFor(learner), { action: 'claim', token: code });
    expect(await claim('a')).toMatchObject({ action: 'claim', outcome: 'claimed' });
    expect(await claim('a')).toMatchObject({ outcome: 'claimed' });
    expect(await claim('b')).toMatchObject({ outcome: 'refused', reason: 'already_claimed_by_other' });
    const access = await myCourses('a', { service: 'education', body: { action: 'access' } });
    expect(access).toMatchObject({ status: 200, cache: 'no-store, private', json: { host: 'fictional_sql_fixture' } });
    const view = access.json.data!.view as { entitlements: { entitlementId: string; curriculum: Record<string, unknown> }[]; enrollments: { enrollmentId: string }[] };
    expect(view.entitlements).toHaveLength(1);
    expect(view.enrollments).toHaveLength(1);
    entitlementA = view.entitlements[0]!.entitlementId; enrollmentA = view.enrollments[0]!.enrollmentId; curriculumA = view.entitlements[0]!.curriculum;
    // Served by the database's own curriculum read, pinned to the purchased version and digest.
    expect((await myCourses('a', { service: 'education', body: { action: 'curriculum', entitlementId: entitlementA } })).json.data).toMatchObject({ read: { outcome: 'served', title: JOURNEY_COURSE_TITLE, curriculum: curriculumA } });
    expect((await myCourses('b', { service: 'education', body: { action: 'curriculum', entitlementId: entitlementA } })).json.data).toMatchObject({ read: { outcome: 'withheld', reason: 'not_owner' } });
    expect((await myCourses(null, { service: 'education', body: { action: 'access' } })).status).toBe(401);
  });
  const write = (action: 'complete' | 'position', lesson: typeof lessonA, expectedRevision: number, requestId = randomUUID(), curriculum = curriculumA) =>
    ({ action, entitlementId: entitlementA, enrollmentId: enrollmentA, curriculum, lesson, expectedRevision, requestId });
  it('repaired gap: without a curriculum read by the store itself, settlement over the SQL ledger could only say "version missing" for a course that was bought', async () => {
    const caller = { kind: 'consumer' as const, personId: ACCEPTANCE_FIXTURE.learners.a.personId, identitySubject: ACCEPTANCE_FIXTURE.learners.a.identitySubject };
    const without = createProgramSettlement({ ledger: { ...host.education, curriculumForCaller: undefined }, curriculumContent: async () => null, expectedAccountRef: ACCEPTANCE_FIXTURE.expected.accountRef, sealer: createFictionalClaimSealer(sealerKey) });
    expect(await without.curriculum(caller, entitlementA)).toEqual({ outcome: 'withheld', entitlementId: entitlementA, reason: 'version_missing' });
    expect(await host.settlement.curriculum(caller, entitlementA)).toMatchObject({ outcome: 'served', curriculum: curriculumA });
  });
  it('a completion survives a FRESH INSTANCE, and a save whose reply was lost is answered by the same receipt afterwards', async () => {
    const save = write('complete', lessonA, 0);
    const first = await myCourses('a', { service: 'progress', body: save });
    expect(first.json.data).toMatchObject({ outcome: { outcome: 'recorded', receipt: { revision: 1 } } });
    await restart();
    const retried = await myCourses('a', { service: 'progress', body: save });
    expect((retried.json.data as { outcome: { receipt: unknown } }).outcome.receipt).toEqual((first.json.data as { outcome: { receipt: unknown } }).outcome.receipt);
    expect((await myCourses('a', { service: 'progress', body: { action: 'read', entitlementId: entitlementA } })).json.data).toMatchObject({ read: { outcome: 'read', progress: { revision: 1, completed: [{ lesson: lessonA }] } } });
  });
  it('a SEPARATE PROCESS opens the saved database, records a place through the real service, and exits; this process then reads it', async () => {
    await shut();
    let out = '';
    try {
    out = execFileSync(process.execPath, ['node_modules/jiti/lib/jiti-cli.mjs', 'src/test-support/sql-acceptance-child.ts', dir, JSON.stringify({ learner: 'a', body: write('position', lessonC, 1) })], {
      env: { ...process.env, ACCEPTANCE_SEALER_KEY_HEX: sealerKey.key.toString('hex') }, encoding: 'utf8', timeout: 120_000,
    });
    } finally { await open(); }
    const child = JSON.parse(out.trim().split('\n').at(-1)!) as { pid: number; fresh: boolean; reply: unknown };
    expect(child.pid).not.toBe(process.pid);
    expect(child.fresh).toBe(false);
    expect(child.reply).toMatchObject({ action: 'position', outcome: { outcome: 'recorded', receipt: { revision: 2 } } });
    expect((await myCourses('a', { service: 'progress', body: { action: 'read', entitlementId: entitlementA } })).json.data).toMatchObject({ read: { progress: { revision: 2, position: lessonC, completed: [{ lesson: lessonA }] } } });
  }, 180_000);
  it('a save that is behind is refused with the saved record; another version, another lesson or another learner is refused', async () => {
    expect((await myCourses('a', { service: 'progress', body: write('complete', habitB, 0) })).json.data).toMatchObject({ outcome: { outcome: 'refused', reason: 'revision_stale', progress: { revision: 2 } } });
    expect((await myCourses('a', { service: 'progress', body: write('complete', habitB, 2, randomUUID(), { ...curriculumA, version: 2 }) })).json.data).toMatchObject({ outcome: { outcome: 'refused', reason: 'stale_version' } });
    expect((await myCourses('a', { service: 'progress', body: write('complete', { phaseId: 'phase-1', itemId: 'lesson-z' }, 2) })).json.data).toMatchObject({ outcome: { outcome: 'refused', reason: 'unknown_lesson' } });
    expect((await myCourses('b', { service: 'progress', body: write('complete', habitB, 2) })).json.data).toMatchObject({ outcome: { outcome: 'refused', reason: 'not_owner' } });
  });
  it('a policy hold closes the course and refuses progress until the operator releases it', async () => {
    await host.settlement.recordPolicy(operator, orderA, 'refund', 'acceptance-refund-1');
    expect((await myCourses('a', { service: 'education', body: { action: 'curriculum', entitlementId: entitlementA } })).json.data).toMatchObject({ read: { outcome: 'withheld', reason: 'not_active' } });
    expect((await myCourses('a', { service: 'progress', body: write('complete', habitB, 2) })).json.data).toMatchObject({ outcome: { outcome: 'refused', reason: 'not_active' } });
    await host.settlement.recordPolicy(operator, orderA, 'operator_release', 'acceptance-release-1');
    expect((await myCourses('a', { service: 'education', body: { action: 'curriculum', entitlementId: entitlementA } })).json.data).toMatchObject({ read: { outcome: 'served' } });
  });
});

describe('two learners, two clinics, and the delivery races', () => {
  let orderB = '';
  it('a second learner buys and claims their own course; neither sees the other; another clinic sees neither', async () => {
    orderB = (await startAndPay('browser-b', 'paid')).orderId;
    await host.worker.runOnce();
    expect(await host.accessService(host.contextFor('b'), { action: 'claim', token: lastCodeTo(addressFor(orderB)) })).toMatchObject({ outcome: 'claimed' });
    const b = (await myCourses('b', { service: 'education', body: { action: 'access' } })).json.data!.view as { entitlements: { entitlementId: string }[] };
    expect(b.entitlements.map(e => e.entitlementId)).not.toContain(entitlementA);
    expect((await myCourses('b', { service: 'progress', body: { action: 'read', entitlementId: b.entitlements[0]!.entitlementId } })).json.data).toMatchObject({ read: { progress: { revision: 0, completed: [] } } });
    expect((await host.education.listForProgram(staff, ACCEPTANCE_FIXTURE.programId)).orders).toHaveLength(2);
    // Another clinic's clinician: their own clinic holds none of these; naming this clinic is refused.
    expect(await host.education.listForProgram(otherStaff, ACCEPTANCE_FIXTURE.programId)).toMatchObject({ orders: [], entitlements: [], enrollments: [], claims: [] });
    await expect(host.education.listForProgram({ ...otherStaff, organizationId: ACCEPTANCE_FIXTURE.organizationId }, ACCEPTANCE_FIXTURE.programId)).rejects.toBeTruthy();
  });
  it('a delivery selected BEFORE its claim is replaced sends nothing usable and records no success; the replacement is the only working code', async () => {
    const { orderId } = await startAndPay('browser-c', 'paid');
    // Hold the delivery pass after it selected its due delivery, before it reads the purchaser contact.
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let selected!: () => void; const reached = new Promise<void>(resolve => { selected = resolve; });
    const contactFor = boundaries.contacts.contactFor;
    boundaries.contacts.contactFor = async id => { if (id === orderId) { selected(); await gate; } return contactFor(id); };
    try {
      const pass = host.worker.runOnce();
      await reached;
      const entitlement = (await host.education.entitlementForOrder(orderId))!;
      // The operator replaces the code while that delivery is in flight.
      expect(await host.settlement.reissue(operator, entitlement.entitlementId)).toMatchObject({ reissued: true, superseded: 1 });
      release();
      const report = await pass;
      // The only due delivery was the one selected before the replacement: its success is not recorded.
      expect(report.delivery).toMatchObject({ ok: true, results: [{ state: 'lost_race' }] });
      // The provider did carry the old code (provider acceptance is not proof of anything), but it is not a capability.
      const old = lastCodeTo(addressFor(orderId));
      expect(await host.accessService(host.contextFor('a'), { action: 'claim', token: old })).toMatchObject({ outcome: 'refused', reason: 'claim_superseded' });
      // The superseded claim's delivery stays withdrawn: nothing reports that it was delivered.
      const rows = (await host.bootstrap<{ claim: string; delivery: string }>('select c.state as claim, d.state as delivery from commercial_education.program_claim_deliveries d join commercial_education.program_claims c on c.id=d.claim_id join commercial_education.program_entitlements e on e.id=c.entitlement_id where e.order_id=$1 order by c.issued_at', [orderId])).rows;
      expect(rows).toEqual([{ claim: 'superseded', delivery: 'withdrawn' }, { claim: 'issued', delivery: 'pending' }]);
    } finally { boundaries.contacts.contactFor = contactFor; }
    // The next pass delivers the replacement, and only it works.
    const next = await host.worker.runOnce();
    expect(next.delivery).toMatchObject({ ok: true, results: [{ state: 'accepted' }] });
    const replacement = lastCodeTo(addressFor(orderId));
    expect(await host.accessService(host.contextFor('a'), { action: 'claim', token: replacement })).toMatchObject({ outcome: 'claimed' });
    // A claimed entitlement takes no further replacement.
    const entitlement = (await host.education.entitlementForOrder(orderId))!;
    expect(await host.settlement.reissue(operator, entitlement.entitlementId)).toMatchObject({ reissued: false });
  });
  it('a replacement made BEFORE the pass selects anything leaves only the replacement due; an aged claim is refused as expired', async () => {
    const { orderId } = await startAndPay('browser-d', 'paid');
    boundaries.contacts.setFailing(true); // the contact service is down for this pass: nothing is sent, the attempt is unknown and retried
    const held = await host.worker.runOnce();
    expect(held.delivery).toMatchObject({ ok: true, results: [{ state: 'provider_unknown' }] });
    boundaries.contacts.setFailing(false);
    const entitlement = (await host.education.entitlementForOrder(orderId))!;
    expect(await host.settlement.reissue(operator, entitlement.entitlementId)).toMatchObject({ reissued: true });
    const before = boundaries.provider.mailbox.length;
    // The unknown attempt is withdrawn with its claim; only the replacement is due, and it goes out now.
    const pass = await host.worker.runOnce();
    expect(pass.delivery).toMatchObject({ ok: true, results: [{ state: 'accepted' }] });
    expect(boundaries.provider.mailbox.length).toBe(before + 1);
    const rows = (await host.bootstrap<{ claim: string; delivery: string }>('select c.state as claim, d.state as delivery from commercial_education.program_claim_deliveries d join commercial_education.program_claims c on c.id=d.claim_id join commercial_education.program_entitlements e on e.id=c.entitlement_id where e.order_id=$1 order by c.issued_at', [orderId])).rows;
    expect(rows).toEqual([{ claim: 'superseded', delivery: 'withdrawn' }, { claim: 'issued', delivery: 'accepted' }]);
    // Time passing for this claim (the fixture's named stand-in for the clock): the code is refused as expired.
    await host.elapse("update commercial_education.program_claims set issued_at=issued_at-interval '8 days',expires_at=expires_at-interval '8 days' where entitlement_id=$1 and state='issued'", [entitlement.entitlementId]);
    expect(await host.accessService(host.contextFor('b'), { action: 'claim', token: lastCodeTo(addressFor(orderId)) })).toMatchObject({ outcome: 'refused', reason: 'claim_expired' });
  });
  it('a store outage is said as an outage, never as "no courses"', async () => {
    host.faults.down.add('clinical_core_api');
    const reply = await myCourses('a', { service: 'education', body: { action: 'access' } });
    expect(reply.status).toBe(503);
    expect(reply.json.data).toBeUndefined();
  });
});
