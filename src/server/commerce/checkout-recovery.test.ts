import { describe, expect, it } from 'vitest';
import { createProgramCheckout } from './program-checkout';
import { createFictionalCheckoutLedger } from './program-checkout-ledger';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import { createStripeCheckoutProcessor } from './program-checkout-stripe';
import { createFictionalProgramOfferLedger, type OfferActor } from './program-offer-ledger';
import { createFictionalEducationLedger } from './program-education-ledger';
import { createProgramSettlement } from './program-settlement';
import { createCommerceWorker } from './program-commerce-worker';
import type { VerifiedEvent } from '../stripe-boundary';

/**
 * Work package 1 of the reliability handoff (808c2da2/5823c2dc): checkout and background recovery.
 * Each case reproduces one observation the handoff names, against the fictional ledger and either
 * the fictional processor or the Stripe test-mode transport over a fictional fetch that behaves the
 * way Stripe's documentation says it does (same key + same parameters answers the first result;
 * same key + different parameters is an idempotency error; keys are forgotten after the retention
 * window; events arrive duplicated and out of order). Nothing here contacts Stripe.
 */
const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222', staff = '33333333-3333-4333-8333-333333333333';
const binding = { organizationId: org, programId: program };
const curriculum = { versionId: '44444444-4444-4444-8444-444444444444', version: 1, sourceDigest: 'a'.repeat(64) };
const origin = 'https://clinic.fictional.example';
const me: OfferActor = { personId: staff, organizationId: org };
const terms = { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90 };
const ACCOUNT = 'acct_FictionalAccount1';
const expected = { accountRef: ACCOUNT, apiVersion: '2025-08-27.basil' };

async function published(now: () => Date) {
  const offers = createFictionalProgramOfferLedger({ curriculum: async (o, p) => o === org && p === program ? { programId: p, current: curriculum } : null, now });
  const created = await offers.execute(me, { action: 'create', programId: program, terms });
  const offerId = created.action === 'create' ? created.offer.offerId : '';
  await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
  await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
  return offers;
}
function clock(start = '2026-10-11T12:00:00Z') {
  let at = Date.parse(start);
  return { now: () => new Date(at), tick: (ms: number) => { at += ms; } };
}
/** Overwrite what the processor holds for a session, the way the hosted page or a substitution would change it. */
const mutate = (processor: { sessions: Map<string, unknown> }, ref: string, patch: Record<string, unknown>) => { processor.sessions.set(ref, { ...(processor.sessions.get(ref) as object), ...patch }); };
const event = (id: string, type: string, sessionRef: string): VerifiedEvent => ({ id, type, livemode: false, created: 1, data: { object: { object: 'checkout.session', id: sessionRef } } });

/* A fictional Stripe: the documented behaviour of Checkout Sessions, idempotent requests and account retrieval, over an injected clock. */
function fictionalStripe(now: () => Date, options: { retentionHours?: number } = {}) {
  const retention = (options.retentionHours ?? 24) * 3_600_000;
  const keys = new Map<string, { body: string; id: string; at: number }>();
  const sessions = new Map<string, Record<string, unknown>>();
  const creates: string[] = [];
  let dropNextReply = false;
  let seq = 0;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (url.pathname === '/v1/account' && init.method === 'GET') return reply(200, { id: ACCOUNT, object: 'account' });
    if (url.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
      const body = String(init.body);
      const key = headers.get('idempotency-key') ?? '';
      const kept = keys.get(key);
      if (kept && now().getTime() - kept.at <= retention) {
        if (kept.body !== body) return reply(400, { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } });
        return reply(200, sessions.get(kept.id));
      }
      creates.push(body);
      const form = new URLSearchParams(body);
      const id = 'cs_test_fictionalStripe' + String(++seq).padStart(6, '0');
      const object = {
        id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: Number(form.get('expires_at')), status: 'open', payment_status: 'unpaid',
        mode: form.get('mode'), livemode: false, amount_total: 1999, currency: 'usd', client_reference_id: form.get('client_reference_id'),
        metadata: { order_id: form.get('metadata[order_id]') }, success_url: form.get('success_url'), cancel_url: form.get('cancel_url'),
        line_items: { object: 'list', data: [{ price: { id: form.get('line_items[0][price]') } }] }, payment_intent: null,
      };
      sessions.set(id, object); keys.set(key, { body, id, at: now().getTime() });
      if (dropNextReply) { dropNextReply = false; throw new TypeError('fetch failed'); }
      return reply(200, object);
    }
    const match = /^\/v1\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (match && init.method === 'GET') return sessions.has(match[1]!) ? reply(200, sessions.get(match[1]!)) : reply(404, { error: { type: 'invalid_request_error' } });
    return reply(404, { error: { type: 'invalid_request_error' } });
  };
  return { fetchImpl, creates, sessions, dropNext() { dropNextReply = true; } };
}

describe('finding 1: a completed, unpaid checkout is processing, not failed', () => {
  it('fulfils once when the delayed payment later succeeds, whichever event arrives first, and never from a generic unpaid status', async () => {
    const t = clock();
    const offers = await published(t.now);
    const ledger = createFictionalCheckoutLedger({ now: t.now });
    const processor = createFictionalCheckoutProcessor({ now: t.now });
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now });
    const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    const order = ledger.orders.get(started.started ? started.orderId : '')!;
    const ref = order.processor!.sessionRef;
    // The visitor finished the hosted page with a delayed method: complete, unpaid, the payment still processing.
    // Stripe's shape for a delayed method: the session is complete and its payment status is still unpaid.
    mutate(processor, ref, { status: 'complete', paymentStatus: 'unpaid' });
    await checkout.admitEvent(event('evt_completed', 'checkout.session.completed', ref), 'raw', expected);
    await checkout.processEvent('evt_completed');
    expect(ledger.orders.get(order.orderId)!.state).toBe('payment_processing');
    expect(ledger.orders.get(order.orderId)!.verification).toBeNull();
    // Later the payment succeeds; a duplicate of the first event is also redelivered after the success.
    mutate(processor, ref, { status: 'complete', paymentStatus: 'paid', paymentIntentStatus: 'succeeded' });
    await checkout.admitEvent(event('evt_async_ok', 'checkout.session.async_payment_succeeded', ref), 'raw', expected);
    await checkout.processEvent('evt_async_ok');
    await checkout.admitEvent(event('evt_completed_redelivered', 'checkout.session.completed', ref), 'raw', expected);
    await checkout.processEvent('evt_completed_redelivered');
    const settled = ledger.orders.get(order.orderId)!;
    expect(settled.state).toBe('payment_verified');
    expect(settled.verification).toMatchObject({ paymentStatus: 'paid', amountMinor: 1999 });
    const education = createFictionalEducationLedger({ orders: ledger });
    const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => null, expectedAccountRef: ACCOUNT, now: t.now });
    await settlement.settleOrder(settled); await settlement.settleOrder(settled);
    expect(education.entitlements.size).toBe(1);
  });
  it('an explicit asynchronous failure settles failed; reversed delivery of success then a stale "completed" does not undo it', async () => {
    const t = clock();
    const offers = await published(t.now);
    const ledger = createFictionalCheckoutLedger({ now: t.now });
    const processor = createFictionalCheckoutProcessor({ now: t.now });
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now });
    const a = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-f' });
    const failing = ledger.orders.get(a.started ? a.orderId : '')!;
    mutate(processor, failing.processor!.sessionRef, { status: 'complete', paymentStatus: 'unpaid', paymentIntentStatus: 'requires_payment_method' });
    await checkout.admitEvent(event('evt_failed', 'checkout.session.async_payment_failed', failing.processor!.sessionRef), 'raw', expected);
    await checkout.processEvent('evt_failed');
    expect(ledger.orders.get(failing.orderId)!.state).toBe('payment_failed');
    const b = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-r' });
    const reversed = ledger.orders.get(b.started ? b.orderId : '')!;
    mutate(processor, reversed.processor!.sessionRef, { status: 'complete', paymentStatus: 'paid', paymentIntentStatus: 'succeeded' });
    await checkout.admitEvent(event('evt_ok_first', 'checkout.session.async_payment_succeeded', reversed.processor!.sessionRef), 'raw', expected);
    await checkout.admitEvent(event('evt_completed_late', 'checkout.session.completed', reversed.processor!.sessionRef), 'raw', expected);
    await checkout.processEvent('evt_ok_first'); await checkout.processEvent('evt_completed_late');
    expect(ledger.orders.get(reversed.orderId)!.state).toBe('payment_verified');
    expect(ledger.intake.get('evt_completed_late')!.state).toBe('processed');
  });
});

describe('finding 2: a lost creation reply is replayed from the saved request, never re-derived from the clock', () => {
  it('replays byte-identical parameters under the same key after a lost reply and a clock advance, and gets the first session', async () => {
    const t = clock();
    const offers = await published(t.now);
    const ledger = createFictionalCheckoutLedger({ now: t.now });
    const stripe = fictionalStripe(t.now);
    const processor = createStripeCheckoutProcessor({ secretKey: 'sk_test_fictional', accountRef: ACCOUNT, apiVersion: '2025-08-27.basil' }, stripe.fetchImpl);
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now });
    stripe.dropNext();
    const first = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    expect(first).toMatchObject({ started: false });
    expect(stripe.creates).toHaveLength(1);
    t.tick(5 * 60_000);
    const retried = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    expect(retried).toMatchObject({ started: true });
    expect(stripe.creates).toHaveLength(1);
    const order = ledger.orders.get(retried.started ? retried.orderId : '')!;
    expect(order.processor!.sessionRef).toBe('cs_test_fictionalStripe000001');
    expect(ledger.orders.size).toBe(1);
  });
  it('beyond the retention window an unknown creation is never replayed blind and never given a second key; it settles as expired or held', async () => {
    const t = clock();
    const offers = await published(t.now);
    const ledger = createFictionalCheckoutLedger({ now: t.now });
    const stripe = fictionalStripe(t.now);
    const processor = createStripeCheckoutProcessor({ secretKey: 'sk_test_fictional', accountRef: ACCOUNT, apiVersion: '2025-08-27.basil' }, stripe.fetchImpl);
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now });
    stripe.dropNext();
    const first = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    const lostOrderId = [...ledger.orders.keys()][0]!;
    expect(first).toMatchObject({ started: false });
    t.tick(25 * 3_600_000);
    await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    // No second creation was ever sent for the lost order's key.
    const lostKey = `program-order:${lostOrderId}`;
    expect(stripe.creates.filter(body => new URLSearchParams(body).get('client_reference_id') === lostOrderId)).toHaveLength(1);
    expect(['checkout_expired', 'creation_unreconciled']).toContain(ledger.orders.get(lostOrderId)!.state);
    expect(lostKey).toMatch(/^program-order:/);
  });
});

describe('finding 3: every redirect passes the full saved-order binding', () => {
  const substitutions: [string, (session: Record<string, unknown>) => Record<string, unknown>][] = [
    ['another account', () => ({ accountRef: 'acct_FictionalOther99' })],
    ['another amount', s => ({ amountTotal: (s.amountTotal as number) + 1 })],
    ['another currency', () => ({ currency: 'eur' })],
    ['another price', () => ({ priceRefs: ['price_FictionalOther99'] })],
    ['another billing mode', () => ({ mode: 'subscription' })],
    ['another order', () => ({ clientReferenceId: '00000000-0000-4000-8000-000000000000', metadata: { order_id: '00000000-0000-4000-8000-000000000000' } })],
    ['extra metadata', s => ({ metadata: { ...(s.metadata as object), note: 'fictional' } })],
    ['a live object', () => ({ livemode: true })],
    ['another session', () => ({ sessionRef: 'cs_test_fictionalSubstituted01' })],
    ['a foreign checkout host', s => ({ url: `https://pay.evil.example/c/${s.sessionRef as string}` })],
    ['no checkout address', () => ({ url: undefined })],
    ['another expiry', s => ({ expiresAt: new Date(Date.parse(s.expiresAt as string) + 3_600_000).toISOString() })],
    ['a completed session', () => ({ status: 'complete', paymentStatus: 'paid' })],
  ];
  it.each(substitutions)('a reused open session that comes back with %s is refused before any redirect', async (_name, change) => {
    const t = clock();
    const offers = await published(t.now);
    const ledger = createFictionalCheckoutLedger({ now: t.now });
    const processor = createFictionalCheckoutProcessor({ now: t.now });
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now });
    const first = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    expect(first).toMatchObject({ started: true });
    const ref = ledger.orders.get(first.started ? first.orderId : '')!.processor!.sessionRef;
    mutate(processor, ref, change(processor.sessions.get(ref) as Record<string, unknown>));
    const again = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    expect(again.started).toBe(false);
    expect(JSON.stringify(again)).not.toMatch(/https:\/\//);
  });
});

describe('finding 6: failed transitions are visible and bounded; two processors converge', () => {
  it('a failure to record expiry is a visible hold, not an unbounded restart loop', async () => {
    const t = clock();
    const offers = await published(t.now);
    let admits = 0;
    let failTransitions = false;
    const ledger = createFictionalCheckoutLedger({ now: t.now, faults: { before: op => { if (op === 'admitOrder' && ++admits > 20) throw new Error('runaway'); if (op === 'transition' && failTransitions) throw new Error('store down'); } } });
    const processor = createFictionalCheckoutProcessor({ now: t.now });
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now, sessionMinutes: 30 });
    await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    t.tick(31 * 60_000);
    failTransitions = true;
    const held = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    expect(held).toMatchObject({ started: false, reason: 'order_store_unavailable' });
    expect(admits).toBeLessThanOrEqual(3);
  });
  it('two processors restarting the same expired attempt produce one new order and one new session', async () => {
    const t = clock();
    const offers = await published(t.now);
    const ledger = createFictionalCheckoutLedger({ now: t.now });
    const processor = createFictionalCheckoutProcessor({ now: t.now });
    const a = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now, sessionMinutes: 30 });
    const b = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now, sessionMinutes: 30 });
    await a.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    t.tick(31 * 60_000);
    const [ra, rb] = await Promise.all([a.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' }), b.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' })]);
    expect(ledger.orders.size).toBe(2);
    expect(processor.sessions.size).toBe(2);
    const ids = [ra, rb].filter(r => r.started).map(r => r.started ? r.orderId : '');
    expect(new Set(ids).size).toBeLessThanOrEqual(1);
  });
});

describe('finding 7: a failed backlog read and a failed delivery are reported, not hidden', () => {
  it('settleDue reports an unreadable backlog instead of "no work", and settleOrder reports a failed delivery hand-off', async () => {
    const t = clock();
    const offers = await published(t.now);
    const ledger = createFictionalCheckoutLedger({ now: t.now });
    let backlogDown = true;
    const education = createFictionalEducationLedger({ orders: ledger, faults: { before: op => { if (op === 'unsettledOrders' && backlogDown) throw new Error('down'); } } });
    const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => null, expectedAccountRef: ACCOUNT, now: t.now, deliver: async () => { throw new Error('provider down'); } });
    expect(await settlement.settleDue()).toEqual({ ok: false, reason: 'backlog_unavailable' });
    backlogDown = false;
    const processor = createFictionalCheckoutProcessor({ now: t.now });
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now });
    const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    const order = ledger.orders.get(started.started ? started.orderId : '')!;
    processor.settle(order.processor!.sessionRef, 'paid');
    await checkout.admitEvent(event('evt_paid', 'checkout.session.completed', order.processor!.sessionRef), 'raw', expected);
    await checkout.processEvent('evt_paid');
    const pass = await settlement.settleDue();
    expect(pass).toMatchObject({ ok: true, outcomes: [{ settled: true, delivery: 'failed' }] });
  });
});

describe('the worker: admitted work finishes with no visitor, and every step says when it could not', () => {
  async function system(options: { retentionHours?: number } = {}) {
    const t = clock();
    const offers = await published(t.now);
    const ledger = createFictionalCheckoutLedger({ now: t.now });
    const processor = createFictionalCheckoutProcessor({ now: t.now, retentionHours: options.retentionHours });
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now });
    const education = createFictionalEducationLedger({ orders: ledger });
    const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => null, expectedAccountRef: ACCOUNT, now: t.now });
    const worker = () => createCommerceWorker({ ledger, checkout: createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now }), settlement, now: t.now });
    return { t, ledger, processor, checkout, education, worker };
  }
  it('a lost creation reply is reconciled by a later worker pass from the saved request: one session, the order open, no visitor needed', async () => {
    const h = await system();
    h.processor.faults.createSession = 'lost_response';
    expect(await h.checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' })).toMatchObject({ started: false, reason: 'processor_unavailable' });
    const order = [...h.ledger.orders.values()][0]!;
    expect(order.state).toBe('creation_unresolved');
    h.t.tick(10 * 60_000);
    const report = await h.worker().runOnce();
    expect(report.reconcile).toMatchObject({ ok: true, results: [{ orderId: order.orderId, outcome: 'open' }] });
    expect(h.ledger.orders.get(order.orderId)!.state).toBe('checkout_open');
    expect(h.processor.creations).toHaveLength(1);
    expect(h.processor.requests.every(r => JSON.stringify(r) === JSON.stringify(h.processor.requests[0]))).toBe(true);
  });
  it('a payment whose events were all lost is still decided: the worker reconciles a processing order and an expired open one from the processor', async () => {
    const h = await system();
    const a = await h.checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    const processing = h.ledger.orders.get(a.started ? a.orderId : '')!;
    h.processor.settle(processing.processor!.sessionRef, 'processing');
    await h.checkout.admitEvent(event('evt_completed', 'checkout.session.completed', processing.processor!.sessionRef), 'raw', expected);
    await h.worker().runOnce();
    expect(h.ledger.orders.get(processing.orderId)!.state).toBe('payment_processing');
    // The success event never arrives. A later pass asks the processor anyway.
    h.processor.settle(processing.processor!.sessionRef, 'succeeded_async');
    const b = await h.checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-b' });
    const abandoned = h.ledger.orders.get(b.started ? b.orderId : '')!;
    h.t.tick(31 * 60_000);
    const report = await h.worker().runOnce();
    expect(report.reconcile).toMatchObject({ ok: true });
    expect(h.ledger.orders.get(processing.orderId)!.state).toBe('payment_verified');
    expect(h.ledger.orders.get(abandoned.orderId)!.state).toBe('checkout_expired');
    expect(report.settlement).toMatchObject({ ok: true, outcomes: [{ settled: true }] });
    expect(h.education.entitlements.size).toBe(1);
  });
  it('two workers processing the same events at once converge on one verification and one entitlement', async () => {
    const h = await system();
    const a = await h.checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    const order = h.ledger.orders.get(a.started ? a.orderId : '')!;
    h.processor.settle(order.processor!.sessionRef, 'paid');
    await h.checkout.admitEvent(event('evt_1', 'checkout.session.completed', order.processor!.sessionRef), 'raw', expected);
    await h.checkout.admitEvent(event('evt_2', 'checkout.session.async_payment_succeeded', order.processor!.sessionRef), 'raw', expected);
    const [one, two] = await Promise.all([h.worker().runOnce(), h.worker().runOnce()]);
    const settled = h.ledger.orders.get(order.orderId)!;
    expect(settled.state).toBe('payment_verified');
    expect(settled.revision).toBe(4);
    expect(h.education.entitlements.size).toBe(1);
    const intakeStates = [...h.ledger.intake.values()].map(r => r.state);
    expect(intakeStates.every(state => state === 'processed')).toBe(true);
    expect([one, two].every(r => r.intake.ok && r.settlement.ok)).toBe(true);
  });
  it('each step reports its own unavailability; nothing is reported as "no work" when it could not be read', async () => {
    const t = clock();
    const offers = await published(t.now);
    const ledger = createFictionalCheckoutLedger({ now: t.now, faults: { before: op => { if (['dueIntake', 'ordersInStates', 'workStatus'].includes(op)) throw new Error('down'); } } });
    const processor = createFictionalCheckoutProcessor({ now: t.now });
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now });
    const education = createFictionalEducationLedger({ orders: ledger, faults: { before: op => { if (op === 'unsettledOrders') throw new Error('down'); } } });
    const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => null, expectedAccountRef: ACCOUNT, now: t.now });
    expect(await createCommerceWorker({ ledger, checkout, settlement, now: t.now }).runOnce()).toEqual({
      intake: { ok: false, reason: 'intake_unavailable' }, reconcile: { ok: false, reason: 'orders_unavailable' }, settlement: { ok: false, reason: 'backlog_unavailable' }, status: { ok: false, reason: 'status_unavailable' },
    });
  });
});

describe('processor authority is the credential\'s own account, not the configured label', () => {
  it('a key that belongs to another account creates nothing and redirects nowhere', async () => {
    const t = clock();
    const offers = await published(t.now);
    const ledger = createFictionalCheckoutLedger({ now: t.now });
    const processor = createFictionalCheckoutProcessor({ now: t.now, credentialAccountRef: 'acct_FictionalOther99' });
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now: t.now });
    expect(await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' })).toMatchObject({ started: false, reason: 'processor_refused' });
    expect(processor.requests).toHaveLength(0);
    processor.faults.authority = 'unavailable';
    expect(await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-b' })).toMatchObject({ started: false, reason: 'processor_refused' });
    expect(processor.requests).toHaveLength(0);
  });
});
