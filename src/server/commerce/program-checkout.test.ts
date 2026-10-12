import { describe, expect, it } from 'vitest';
import { createProgramCheckout, hashAttemptKey, idempotencyKeyFor } from './program-checkout';
import { createFictionalCheckoutLedger } from './program-checkout-ledger';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import { createFictionalProgramOfferLedger, type OfferActor } from './program-offer-ledger';
import type { VerifiedEvent } from '../stripe-boundary';

/**
 * The checkout boundary over the fictional ledger and processor: the server selects everything,
 * the order is admitted before anything leaves, concurrent and repeated starts share one checkout,
 * a lost reply reconciles instead of charging twice, every transport failure is a named hold with
 * nothing charged, intake is durable before processing, unknown events stay unhandled, and the
 * order settles only from the retrieved object bound to it. A redirect changes nothing.
 */
const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222', staff = '33333333-3333-4333-8333-333333333333';
const binding = { organizationId: org, programId: program };
const curriculum = { versionId: '44444444-4444-4444-8444-444444444444', version: 1, sourceDigest: 'a'.repeat(64) };
const origin = 'https://clinic.fictional.example';
const me: OfferActor = { personId: staff, organizationId: org };
const paid = { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90 };

async function harness(options: { publish?: boolean; processor?: boolean; origin?: string | null } = {}) {
  let clock = Date.parse('2026-10-11T12:00:00Z');
  const now = () => new Date(clock);
  const tick = (ms: number) => { clock += ms; };
  const state = { current: curriculum as typeof curriculum | null };
  const offers = createFictionalProgramOfferLedger({ curriculum: async (o, p) => o === org && p === program ? { programId: p, current: state.current } : null, now });
  if (options.publish !== false) {
    const created = await offers.execute(me, { action: 'create', programId: program, terms: paid });
    const offerId = created.action === 'create' ? created.offer.offerId : '';
    await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
    await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
  }
  const ledger = createFictionalCheckoutLedger({ now });
  const processor = createFictionalCheckoutProcessor({ now });
  const checkout = createProgramCheckout({ offers, ledger, processor: options.processor === false ? null : processor, publicOrigin: options.origin === undefined ? origin : options.origin, now, sessionMinutes: 30 });
  const start = (attemptKey = 'browser-a') => checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey });
  return { offers, ledger, processor, checkout, start, tick, state, now };
}
const event = (over: Partial<VerifiedEvent & { account?: string; api_version?: string }> = {}, object: Record<string, unknown> = {}): VerifiedEvent & { account?: string; api_version?: string } =>
  ({ id: 'evt_fictional_1', type: 'checkout.session.completed', livemode: false, created: 1, data: { object: { object: 'checkout.session', ...object } }, ...over });
const expected = { accountRef: 'acct_FictionalAccount1', apiVersion: '2025-08-27.basil' };

describe('starting a checkout', () => {
  it('refuses before anything is admitted when the page is unbound, the origin is unconfigured, the processor is disabled or the offer is unavailable', async () => {
    const h = await harness({ publish: false });
    expect(await h.checkout.start({ funnelSlug: 'longevity-program', programBinding: null, attemptKey: 'x' })).toMatchObject({ started: false, reason: 'program_unbound' });
    const noOrigin = await harness({ origin: null });
    expect(await noOrigin.start()).toMatchObject({ started: false, reason: 'return_origin_unconfigured' });
    const noProcessor = await harness({ processor: false });
    expect(await noProcessor.start()).toMatchObject({ started: false, reason: 'checkout_unconfigured' });
    expect(await h.start()).toMatchObject({ started: false, reason: 'offer_absent' });
    expect(h.ledger.orders.size).toBe(0);
    expect(h.processor.requests).toHaveLength(0);
  });
  it('admits the order with the terms snapshot BEFORE the outbound call, tells the processor only the price and the opaque order id, and binds the session', async () => {
    const h = await harness();
    const result = await h.start();
    expect(result).toMatchObject({ started: true, reused: false });
    const orderId = result.started ? result.orderId : '';
    const order = h.ledger.orders.get(orderId)!;
    expect(order).toMatchObject({ state: 'checkout_open', revision: 3, offerRevision: 3, funnelSlug: 'longevity-program', pricing: { amountMinor: 1999 }, providerPriceRef: 'price_FictionalAbc123', curriculum, subject: { kind: 'unclaimed' }, attemptKeyHash: hashAttemptKey('browser-a') });
    // The creation request is recorded durably BEFORE it is sent, and what is sent is exactly what was recorded.
    expect(h.ledger.history.map(o => o.state)).toEqual(['admitted', 'creation_pending', 'checkout_open']);
    expect(h.ledger.history[1]!.creation).toEqual(order.creation);
    expect(h.processor.requests).toHaveLength(1);
    const request = h.processor.requests[0]!;
    expect(request).toEqual({
      idempotencyKey: idempotencyKeyFor(orderId),
      request: { mode: 'payment', priceRef: 'price_FictionalAbc123', quantity: 1, successUrl: `${origin}/buy/return?order=${orderId}&returned=success`, cancelUrl: `${origin}/buy/return?order=${orderId}&returned=cancel`, clientReferenceId: orderId, metadataOrderId: orderId, expiresAtUnix: Date.parse('2026-10-11T12:30:00Z') / 1000 },
      requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/), recordedAt: '2026-10-11T12:00:00.000Z',
    });
    expect(order.creation).toEqual(request);
    expect(JSON.stringify(request)).not.toMatch(/Fictional program|longevity|health|diagnos|1999/i);
    expect(order.processor).toMatchObject({ provider: 'stripe', mode: 'test', returnSuccess: request.request.successUrl, returnCancel: request.request.cancelUrl });
    expect(result.started && result.checkoutUrl).toMatch(/^https:\/\/checkout\.fictional\.example\//);
  });
  it('a repeated start from the same browser reuses the open checkout; another browser gets its own order', async () => {
    const h = await harness();
    const first = await h.start();
    const again = await h.start();
    expect(again).toMatchObject({ started: true, reused: true, orderId: first.started ? first.orderId : '' });
    expect(h.processor.requests).toHaveLength(1);
    const other = await h.start('browser-b');
    expect(other.started && other.orderId).not.toBe(first.started && first.orderId);
    expect(h.ledger.orders.size).toBe(2);
    const concurrent = await Promise.all([h.start('browser-c'), h.start('browser-c'), h.start('browser-c')]);
    expect(new Set(concurrent.map(c => c.started && c.orderId)).size).toBe(1);
  });
  it('an expired open checkout is closed and a fresh one started; a completed one is not restarted', async () => {
    const h = await harness();
    const first = await h.start();
    h.tick(31 * 60_000);
    const second = await h.start();
    expect(second).toMatchObject({ started: true, reused: false });
    expect(second.started && second.orderId).not.toBe(first.started && first.orderId);
    expect(h.ledger.orders.get(first.started ? first.orderId : '')!.state).toBe('checkout_expired');
    h.processor.settle(h.ledger.orders.get(second.started ? second.orderId : '')!.processor!.sessionRef, 'paid');
    expect(await h.start()).toMatchObject({ started: false, reason: 'attempt_in_progress' });
  });
  it.each(['unavailable', 'timeout', 'refused', 'malformed_reply', 'redirect_reply'] as const)('a %s reply from the processor is a named hold with nothing charged and the order not open; only a definitive refusal closes it, anything else is an unknown outcome kept for replay', async failure => {
    const h = await harness();
    h.processor.faults.createSession = failure;
    const result = await h.start();
    expect(result.started).toBe(false);
    expect(result.started ? '' : result.reason).toBe(failure === 'refused' ? 'processor_refused' : 'processor_unavailable');
    const order = [...h.ledger.orders.values()][0]!;
    expect(order.state).toBe(failure === 'refused' ? 'refused' : 'creation_unresolved');
    expect(order.creation).not.toBeNull();
    expect(order.processor).toBeNull();
  });
  it('a lost creation reply is reconciled by the idempotency key on the next start: one session, one order, no second charge', async () => {
    const h = await harness();
    h.processor.faults.createSession = 'lost_response';
    const lost = await h.start();
    expect(lost).toMatchObject({ started: false, reason: 'processor_unavailable' });
    const order = [...h.ledger.orders.values()][0]!;
    expect(order.state).toBe('creation_unresolved');
    expect(h.processor.sessions.size).toBe(1);
    const retry = await h.start();
    expect(retry).toMatchObject({ started: true, orderId: order.orderId });
    expect(h.processor.sessions.size).toBe(1);
    expect(h.ledger.orders.get(order.orderId)!).toMatchObject({ state: 'checkout_open', processor: { sessionRef: [...h.processor.sessions.keys()][0] } });
  });
  it.each(['live_object', 'other_account', 'wrong_order', 'extra_metadata'] as const)('a created session that is %s is refused and never bound', async fault => {
    const h = await harness();
    h.processor.faults.createSession = fault;
    expect(await h.start()).toMatchObject({ started: false, reason: 'processor_refused' });
    const order = [...h.ledger.orders.values()][0]!;
    expect(order).toMatchObject({ state: 'refused', processor: null });
  });
  it('a store that cannot admit the order never reaches the processor', async () => {
    const h = await harness();
    const ledger = createFictionalCheckoutLedger({ faults: { before: () => { throw new Error('fictional outage'); } } });
    const checkout = createProgramCheckout({ offers: h.offers, ledger, processor: h.processor, publicOrigin: origin });
    expect(await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'x' })).toMatchObject({ started: false, reason: 'order_store_unavailable' });
    expect(h.processor.requests).toHaveLength(0);
  });
  it('a retired or changed offer cannot start a checkout, and a returning browser learns the state only', async () => {
    const h = await harness();
    const started = await h.start();
    const orderId = started.started ? started.orderId : '';
    expect(await h.checkout.returnStatus(orderId)).toEqual({ state: 'checkout_open' });
    expect(await h.checkout.returnStatus('55555555-5555-4555-8555-555555555555')).toEqual({ state: 'unknown' });
    h.state.current = { ...curriculum, sourceDigest: 'b'.repeat(64) };
    expect(await h.start('browser-z')).toMatchObject({ started: false, reason: 'curriculum_changed' });
    h.state.current = curriculum;
    const listed = await h.offers.execute(me, { action: 'list', programId: program });
    const offer = listed.action === 'list' ? listed.offers[0]! : null;
    await h.offers.execute(me, { action: 'retire', offerId: offer!.offerId, expectedRevision: offer!.revision, reason: 'Fictional retirement' });
    expect(await h.start('browser-y')).toMatchObject({ started: false, reason: 'offer_retired' });
    // The earlier open order keeps its saved terms; retiring the offer does not touch it.
    expect(h.ledger.orders.get(orderId)!).toMatchObject({ state: 'checkout_open', pricing: { amountMinor: 1999 } });
  });
});

describe('intake and verification', () => {
  async function paidOrder(h: Awaited<ReturnType<typeof harness>>, attemptKey = 'browser-a') {
    const started = await h.start(attemptKey);
    const order = h.ledger.orders.get(started.started ? started.orderId : '')!;
    h.processor.settle(order.processor!.sessionRef, 'paid');
    return order;
  }
  it('admits an event durably before any processing, deduplicates by id, and refuses the wrong account or API version', async () => {
    const h = await harness();
    const order = await paidOrder(h);
    const e = event({}, { id: order.processor!.sessionRef });
    expect(await h.checkout.admitEvent(e, 'raw-body', expected)).toEqual({ outcome: 'admitted', detail: 'pending' });
    expect(h.ledger.intake.get('evt_fictional_1')).toMatchObject({ state: 'pending', attempts: 0, sessionRef: order.processor!.sessionRef, eventType: 'checkout.session.completed' });
    expect(h.ledger.orders.get(order.orderId)!.state).toBe('checkout_open');
    expect(await h.checkout.admitEvent(e, 'raw-body', expected)).toEqual({ outcome: 'duplicate', detail: 'pending' });
    expect(await h.checkout.admitEvent(event({ id: 'evt_2', account: 'acct_FictionalOther99' }), 'x', expected)).toMatchObject({ outcome: 'refused', detail: 'account_mismatch' });
    expect(await h.checkout.admitEvent(event({ id: 'evt_3', api_version: '2020-08-27' }), 'x', expected)).toMatchObject({ outcome: 'refused', detail: 'api_version_mismatch' });
    expect(h.ledger.intake.size).toBe(1);
  });
  it('a store that cannot record the event answers store_unavailable so the processor retries', async () => {
    const h = await harness();
    const ledger = createFictionalCheckoutLedger({ faults: { before: op => { if (op === 'admitIntake') throw new Error('fictional outage'); } } });
    const checkout = createProgramCheckout({ offers: h.offers, ledger, processor: h.processor, publicOrigin: origin });
    expect(await checkout.admitEvent(event(), 'raw', expected)).toMatchObject({ outcome: 'store_unavailable' });
  });
  it('settles the order only from the retrieved, bound object; unknown events stay unhandled', async () => {
    const h = await harness();
    const order = await paidOrder(h);
    await h.checkout.admitEvent(event({ id: 'evt_unknown', type: 'customer.created' }, { id: 'cus_x' }), 'raw', expected);
    expect(await h.checkout.processEvent('evt_unknown')).toMatchObject({ state: 'unhandled', attempts: 1 });
    await h.checkout.admitEvent(event({}, { id: order.processor!.sessionRef }), 'raw', expected);
    const processed = await h.checkout.processEvent('evt_fictional_1');
    expect(processed).toMatchObject({ state: 'processed', orderId: order.orderId, lastOutcome: 'payment_verified' });
    expect(h.ledger.orders.get(order.orderId)!).toMatchObject({ state: 'payment_verified', revision: 4, verification: { eventId: 'evt_fictional_1', amountMinor: 1999, currency: 'USD', paymentStatus: 'paid', accountRef: 'acct_FictionalAccount1', sessionRef: order.processor!.sessionRef } });
    // Processing again does nothing more; a second, distinct event for the same payment is processed as already settled.
    expect(await h.checkout.processEvent('evt_fictional_1')).toMatchObject({ state: 'processed', attempts: 1 });
    await h.checkout.admitEvent(event({ id: 'evt_async', type: 'checkout.session.async_payment_succeeded' }, { id: order.processor!.sessionRef }), 'raw', expected);
    expect(await h.checkout.processEvent('evt_async')).toMatchObject({ state: 'processed', lastOutcome: 'already recorded' });
    expect(h.ledger.orders.get(order.orderId)!.revision).toBe(4);
  });
  it.each(['amount_drift', 'other_account', 'live_object', 'wrong_order', 'extra_metadata'] as const)('a retrieved object that is %s is refused and the order does not move', async fault => {
    const h = await harness();
    const order = await paidOrder(h);
    await h.checkout.admitEvent(event({}, { id: order.processor!.sessionRef }), 'raw', expected);
    h.processor.faults.retrieveSession = fault;
    const record = await h.checkout.processEvent('evt_fictional_1');
    expect(record.state).toBe('refused');
    expect(record.lastOutcome).toMatch(/^binding: (amount_mismatch|account_mismatch|livemode|order_mismatch)$/);
    expect(h.ledger.orders.get(order.orderId)!.state).toBe('checkout_open');
  });
  it('a session the event names that we never opened is refused; a transport failure retrying is bounded and visible', async () => {
    const h = await harness();
    const order = await paidOrder(h);
    await h.checkout.admitEvent(event({ id: 'evt_stranger' }, { id: 'cs_test_strangerSession1' }), 'raw', expected);
    expect(await h.checkout.processEvent('evt_stranger')).toMatchObject({ state: 'refused', lastOutcome: 'no order for session' });
    await h.checkout.admitEvent(event({}, { id: order.processor!.sessionRef }), 'raw', expected);
    h.processor.faults.retrieveSession = 'unavailable';
    for (let attempt = 1; attempt < 8; attempt++) {
      const record = await h.checkout.processEvent('evt_fictional_1');
      expect(record).toMatchObject({ state: 'failed_retryable', attempts: attempt, lastOutcome: 'retrieve: unavailable' });
      expect(record.nextAttemptAt).not.toBeNull();
    }
    expect(await h.checkout.processEvent('evt_fictional_1')).toMatchObject({ state: 'exhausted', attempts: 8, nextAttemptAt: null });
    expect(h.ledger.orders.get(order.orderId)!.state).toBe('checkout_open');
  });
  it('the retry worker picks up due intake and settles it once the processor answers', async () => {
    const h = await harness();
    const order = await paidOrder(h);
    await h.checkout.admitEvent(event({}, { id: order.processor!.sessionRef }), 'raw', expected);
    h.processor.faults.retrieveSession = 'timeout';
    expect((await h.checkout.processDue())[0]).toMatchObject({ state: 'failed_retryable', attempts: 1 });
    expect(await h.checkout.processDue()).toEqual([]);
    h.tick(2 * 60_000);
    h.processor.faults.retrieveSession = undefined;
    expect((await h.checkout.processDue())[0]).toMatchObject({ state: 'processed', attempts: 2 });
    expect(h.ledger.orders.get(order.orderId)!.state).toBe('payment_verified');
  });
  it('out-of-order and delayed outcomes: expired then paid is a recorded conflict, an explicit failure settles failed, expiry settles expired', async () => {
    const h = await harness();
    const started = await h.start();
    const order = h.ledger.orders.get(started.started ? started.orderId : '')!;
    const ref = order.processor!.sessionRef;
    // Expiry first, then a late completed event: the order is terminal, the contradicting observation is a visible conflict, never applied.
    h.processor.settle(ref, 'expired');
    await h.checkout.admitEvent(event({ id: 'evt_expired', type: 'checkout.session.expired' }, { id: ref }), 'raw', expected);
    expect(await h.checkout.processEvent('evt_expired')).toMatchObject({ state: 'processed', lastOutcome: 'checkout_expired' });
    expect(h.ledger.orders.get(order.orderId)!.state).toBe('checkout_expired');
    h.processor.settle(ref, 'paid');
    await h.checkout.admitEvent(event({ id: 'evt_late' }, { id: ref }), 'raw', expected);
    const late = await h.checkout.processEvent('evt_late');
    expect(late).toMatchObject({ state: 'conflict', lastOutcome: 'observed verified while the order is checkout_expired' });
    expect(h.ledger.orders.get(order.orderId)!.state).toBe('checkout_expired');
    // An explicit asynchronous failure on another order settles failed with the verification recorded.
    const failed = await h.start('browser-f');
    const failedOrder = h.ledger.orders.get(failed.started ? failed.orderId : '')!;
    h.processor.settle(failedOrder.processor!.sessionRef, 'failed_async');
    await h.checkout.admitEvent(event({ id: 'evt_failed', type: 'checkout.session.async_payment_failed' }, { id: failedOrder.processor!.sessionRef }), 'raw', expected);
    expect(await h.checkout.processEvent('evt_failed')).toMatchObject({ state: 'processed', lastOutcome: 'payment_failed' });
    expect(h.ledger.orders.get(failedOrder.orderId)!).toMatchObject({ state: 'payment_failed', verification: { paymentStatus: 'unpaid' } });
    // A completed event whose session is still open (delayed payment) is retried, not settled.
    const open = await h.start('browser-o');
    const openOrder = h.ledger.orders.get(open.started ? open.orderId : '')!;
    await h.checkout.admitEvent(event({ id: 'evt_open' }, { id: openOrder.processor!.sessionRef }), 'raw', expected);
    expect(await h.checkout.processEvent('evt_open')).toMatchObject({ state: 'failed_retryable', lastOutcome: 'session still open' });
    expect(h.ledger.orders.get(openOrder.orderId)!.state).toBe('checkout_open');
  });
  it('a browser redirect, with or without a success URL, never moves an order', async () => {
    const h = await harness();
    const started = await h.start();
    const orderId = started.started ? started.orderId : '';
    expect(await h.checkout.returnStatus(orderId)).toEqual({ state: 'checkout_open' });
    expect(h.ledger.history).toHaveLength(3);
    expect(h.ledger.orders.get(orderId)!.verification).toBeNull();
  });
});
