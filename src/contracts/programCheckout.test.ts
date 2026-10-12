import { describe, expect, it } from 'vitest';
import { ORDER_STATES, ORDER_TRANSITIONS, allowedReturnUrl, checkoutStartRequest, encodeCreationRequest, observePayment, processorSession, programOrder, redirectableCheckout, returnDestinations, verifySessionAgainstOrder, type ProcessorSession, type ProgramOrder } from './programCheckout';
import { funnelTextIssue } from '../funnels/schema';
import { CHECKOUT_HOLD_EXPLANATIONS } from './programCheckout';

/**
 * The checkout contract: the return allow-list, the order shape, the transition table and the
 * binding of a retrieved processor object to a saved order.
 */
const origin = 'https://clinic.fictional.example';
const orderId = '11111111-1111-4111-8111-111111111111';
const session = (over: Partial<ProcessorSession> = {}): ProcessorSession => processorSession.parse({ sessionRef: 'cs_test_fictional12345', url: 'https://checkout.fictional.example/c/x', expiresAt: '2026-10-11T12:30:00Z', status: 'complete', paymentStatus: 'paid', paymentIntentStatus: 'succeeded', successUrl: `${origin}/buy/return?order=${orderId}&returned=success`, cancelUrl: `${origin}/buy/return?order=${orderId}&returned=cancel`, mode: 'payment', livemode: false, amountTotal: 1999, currency: 'usd', clientReferenceId: orderId, metadata: { order_id: orderId }, priceRefs: ['price_FictionalAbc123'], accountRef: 'acct_FictionalAccount1', ...over });
const order = (over: Partial<ProgramOrder> = {}): ProgramOrder => programOrder.parse({
  contract: 'program-checkout/2', orderId, organizationId: '22222222-2222-4222-8222-222222222222', programId: '33333333-3333-4333-8333-333333333333', offerId: '44444444-4444-4444-8444-444444444444', offerRevision: 3, funnelSlug: 'longevity-program',
  curriculum: { versionId: '55555555-5555-4555-8555-555555555555', version: 1, sourceDigest: 'a'.repeat(64) }, pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123',
  accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90, attemptKeyHash: 'b'.repeat(64), subject: { kind: 'unclaimed' }, state: 'checkout_open', revision: 3,
  creation: { idempotencyKey: `program-order:${orderId}`, request: { mode: 'payment', priceRef: 'price_FictionalAbc123', quantity: 1, successUrl: `${origin}/buy/return?order=${orderId}&returned=success`, cancelUrl: `${origin}/buy/return?order=${orderId}&returned=cancel`, clientReferenceId: orderId, metadataOrderId: orderId, expiresAtUnix: Date.parse('2026-10-11T12:30:00Z') / 1000 }, requestSha256: 'c'.repeat(64), recordedAt: '2026-10-11T12:00:00Z' },
  processor: { provider: 'stripe', mode: 'test', sessionRef: 'cs_test_fictional12345', expiresAt: '2026-10-11T12:30:00Z', returnSuccess: `${origin}/buy/return?order=${orderId}&returned=success`, returnCancel: `${origin}/buy/return?order=${orderId}&returned=cancel` },
  verification: null, createdAt: '2026-10-11T12:00:00Z', updatedAt: '2026-10-11T12:00:00Z', ...over,
});

describe('return destinations', () => {
  it('are built only on the configured https origin under the funnel purchase page, with the order id and outcome as the only keys', () => {
    expect(returnDestinations(origin, orderId)).toEqual({ success: `${origin}/buy/return?order=${orderId}&returned=success`, cancel: `${origin}/buy/return?order=${orderId}&returned=cancel` });
    expect(returnDestinations('http://clinic.fictional.example', orderId)).toBeNull();
    expect(returnDestinations(origin + '/', orderId)).toBeNull();
    expect(returnDestinations(origin, 'order-1')).toBeNull();
    // The address names no program: the processor learns nothing about what was bought from where it sends the visitor.
    expect(JSON.stringify(returnDestinations(origin, orderId))).not.toMatch(/longevity|diabetes|weight/);
  });
  it.each([
    [`${origin}/buy/return?order=${orderId}&returned=success`, true],
    [`${origin}/buy/return?returned=cancel&order=${orderId}`, true],
    [`https://evil.example/buy/return?order=${orderId}&returned=success`, false],
    [`http://clinic.fictional.example/buy/return?order=${orderId}&returned=success`, false],
    [`${origin}/buy/longevity-program?order=${orderId}&returned=success`, false],
    [`${origin}/learn/return?order=${orderId}&returned=success`, false],
    [`${origin}/buy/return/extra?order=${orderId}&returned=success`, false],
    [`${origin}/buy/return?order=${orderId}&returned=success&next=https://evil.example`, false],
    [`${origin}/buy/return?order=${orderId}&returned=paid`, false],
    [`${origin}/buy/return?order=1&returned=success`, false],
    [`${origin}/buy/return?order=${orderId}&returned=success#token`, false],
    [`https://user:pw@clinic.fictional.example/buy/return?order=${orderId}&returned=success`, false],
    [`${origin}@evil.example/buy/return?order=${orderId}&returned=success`, false],
    ['javascript:alert(1)', false],
    ['', false],
  ])('%s is allowed: %s', (candidate, allowed) => {
    expect(allowedReturnUrl(candidate, origin)).toBe(allowed);
  });
});

describe('the order and its transitions', () => {
  it('admits exactly the contract: opaque id, snapshot, unclaimed subject, no person and no health field', () => {
    expect(order().subject).toEqual({ kind: 'unclaimed' });
    expect(programOrder.safeParse({ ...order(), email: 'a@b' }).success).toBe(false);
    expect(programOrder.safeParse({ ...order(), pricing: { currency: 'USD', amountMinor: 0, billing: { kind: 'one_time' } } }).success).toBe(false);
    expect(programOrder.safeParse({ ...order(), providerPriceRef: 'price_live' }).success).toBe(false);
    expect(programOrder.safeParse({ ...order(), processor: { ...order().processor!, sessionRef: 'cs_live_fictional12345' } }).success).toBe(false);
    expect(programOrder.safeParse({ ...order(), processor: { ...order().processor!, returnSuccess: 'javascript:alert(1)' } }).success).toBe(false);
    expect(checkoutStartRequest.safeParse({ funnelSlug: 'longevity-program' }).success).toBe(true);
    expect(checkoutStartRequest.safeParse({ funnelSlug: 'longevity-program', amountMinor: 1 }).success).toBe(false);
    expect(checkoutStartRequest.safeParse({ funnelSlug: '../x' }).success).toBe(false);
  });
  it('every state is in the table, terminal states lead nowhere, and nothing returns to admitted', () => {
    for (const state of ORDER_STATES) expect(ORDER_TRANSITIONS[state]).toBeDefined();
    for (const terminal of ['checkout_expired', 'checkout_cancelled', 'payment_verified', 'payment_failed', 'refused'] as const) expect(ORDER_TRANSITIONS[terminal]).toEqual([]);
    for (const state of ORDER_STATES) expect(ORDER_TRANSITIONS[state]).not.toContain('admitted');
    expect(ORDER_TRANSITIONS.checkout_open).not.toContain('checkout_open');
  });
  it('the hold explanations pass the funnel text rules and promise nothing', () => {
    for (const text of Object.values(CHECKOUT_HOLD_EXPLANATIONS)) { expect(funnelTextIssue(text)).toBeNull(); expect(text).not.toMatch(/\$|\d/); }
  });
});

describe('binding a retrieved object to the order', () => {
  it('accepts the exact object and refuses each substitution by name', () => {
    expect(verifySessionAgainstOrder(session(), order(), 'acct_FictionalAccount1')).toEqual({ ok: true });
    expect(verifySessionAgainstOrder(session({ sessionRef: 'cs_test_otherSession999' }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'session_mismatch' });
    // An order with no recorded creation request cannot have a session; one with a request but no session yet may bind the one that matches it.
    expect(verifySessionAgainstOrder(session(), order({ processor: null, creation: null, state: 'admitted', revision: 1 }), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'no_creation_record' });
    expect(verifySessionAgainstOrder(session(), order({ processor: null, state: 'creation_pending', revision: 2 }), 'acct_FictionalAccount1')).toEqual({ ok: true });
    expect(verifySessionAgainstOrder(session({ successUrl: `https://evil.example/buy/return?order=${orderId}&returned=success` }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'return_mismatch' });
    expect(verifySessionAgainstOrder(session({ cancelUrl: null }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'return_mismatch' });
    expect(verifySessionAgainstOrder(session({ expiresAt: '2026-10-11T13:30:00Z' }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'expiry_mismatch' });
    expect(verifySessionAgainstOrder(session({ clientReferenceId: '66666666-6666-4666-8666-666666666666' }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'order_mismatch' });
    expect(verifySessionAgainstOrder(session({ metadata: { order_id: orderId, patient: 'x' } }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'order_mismatch' });
    expect(verifySessionAgainstOrder(session({ livemode: true }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'livemode' });
    expect(verifySessionAgainstOrder(session(), order(), 'acct_FictionalOther99')).toEqual({ ok: false, refusal: 'account_mismatch' });
    expect(verifySessionAgainstOrder(session({ mode: 'subscription' }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'mode_mismatch' });
    expect(verifySessionAgainstOrder(session({ currency: 'eur' }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'currency_mismatch' });
    expect(verifySessionAgainstOrder(session({ amountTotal: 1998 }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'amount_mismatch' });
    expect(verifySessionAgainstOrder(session({ amountTotal: null }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'amount_mismatch' });
    expect(verifySessionAgainstOrder(session({ priceRefs: ['price_FictionalOther9'] }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'price_mismatch' });
    expect(verifySessionAgainstOrder(session({ priceRefs: ['price_FictionalAbc123', 'price_FictionalOther9'] }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'price_mismatch' });
    expect(verifySessionAgainstOrder(session({ paymentStatus: 'no_payment_required' }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'unknown_payment_status' });
    const recurring = order({ pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'recurring', interval: 'month', intervalCount: 1 } }, creation: { ...order().creation!, request: { ...order().creation!.request, mode: 'subscription' } } });
    expect(verifySessionAgainstOrder(session({ mode: 'subscription' }), recurring, 'acct_FictionalAccount1')).toEqual({ ok: true });
    expect(verifySessionAgainstOrder(session(), recurring, 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'mode_mismatch' });
  });
});

describe('the creation request, the redirect and the payment observation', () => {
  it('encodes the saved request in one fixed order, naming the price and the opaque order id and nothing about a person', () => {
    const encoded = encodeCreationRequest(order().creation!.request);
    expect([...new URLSearchParams(encoded).keys()]).toEqual(['mode', 'line_items[0][price]', 'line_items[0][quantity]', 'success_url', 'cancel_url', 'client_reference_id', 'metadata[order_id]', 'expires_at']);
    expect(encodeCreationRequest(structuredClone(order().creation!.request))).toBe(encoded);
    expect(encoded).not.toMatch(/email|name|program|health|1999/i);
  });
  it('sends a browser only to an open, unexpired, bound session on one of the processor\'s own hosts', () => {
    const open = session({ status: 'open', paymentStatus: 'unpaid', paymentIntentStatus: null });
    const at = new Date('2026-10-11T12:05:00Z');
    expect(redirectableCheckout(open, order(), 'acct_FictionalAccount1', ['checkout.fictional.example'], at)).toEqual({ ok: true, url: 'https://checkout.fictional.example/c/x', expiresAt: '2026-10-11T12:30:00Z' });
    expect(redirectableCheckout(session(), order(), 'acct_FictionalAccount1', ['checkout.fictional.example'], at)).toEqual({ ok: false, refusal: 'not_open' });
    expect(redirectableCheckout(open, order(), 'acct_FictionalAccount1', ['checkout.fictional.example'], new Date('2026-10-11T12:31:00Z'))).toEqual({ ok: false, refusal: 'expired' });
    expect(redirectableCheckout({ ...open, url: null }, order(), 'acct_FictionalAccount1', ['checkout.fictional.example'], at)).toEqual({ ok: false, refusal: 'no_address' });
    for (const url of ['https://evil.example/c/x', 'https://checkout.fictional.example.evil.example/c/x', 'https://user@checkout.fictional.example/c/x', 'https://checkout.fictional.example:8443/c/x']) {
      expect(redirectableCheckout({ ...open, url }, order(), 'acct_FictionalAccount1', ['checkout.fictional.example'], at)).toEqual({ ok: false, refusal: 'foreign_address' });
    }
    expect(redirectableCheckout(open, order(), 'acct_FictionalOther99', ['checkout.fictional.example'], at)).toEqual({ ok: false, refusal: 'account_mismatch' });
  });
  it.each([
    ['open', { status: 'open', paymentStatus: 'unpaid', paymentIntentStatus: null }, 'open'],
    ['expired', { status: 'expired', paymentStatus: 'unpaid', paymentIntentStatus: null }, 'expired'],
    ['complete and paid', { status: 'complete', paymentStatus: 'paid', paymentIntentStatus: 'succeeded' }, 'verified'],
    ['complete and paid without an intent', { status: 'complete', paymentStatus: 'paid', paymentIntentStatus: null }, 'verified'],
    ['complete, paid, but the intent still processing', { status: 'complete', paymentStatus: 'paid', paymentIntentStatus: 'processing' }, 'processing'],
    ['complete and unpaid, processing', { status: 'complete', paymentStatus: 'unpaid', paymentIntentStatus: 'processing' }, 'processing'],
    ['complete and unpaid, no intent status', { status: 'complete', paymentStatus: 'unpaid', paymentIntentStatus: null }, 'processing'],
    ['complete and unpaid, requires action', { status: 'complete', paymentStatus: 'unpaid', paymentIntentStatus: 'requires_action' }, 'processing'],
    ['complete and unpaid, payment method failed', { status: 'complete', paymentStatus: 'unpaid', paymentIntentStatus: 'requires_payment_method' }, 'failed'],
    ['complete and unpaid, canceled', { status: 'complete', paymentStatus: 'unpaid', paymentIntentStatus: 'canceled' }, 'failed'],
  ] as const)('a session that is %s is observed as %s; a generic unpaid status is never a grant and never on its own a failure', (_name, over, observed) => {
    expect(observePayment(session(over as Partial<ProcessorSession>))).toBe(observed);
  });
  it('a completed checkout under a paid offer that needed no payment is refused, not granted', () => {
    expect(verifySessionAgainstOrder(session({ paymentStatus: 'no_payment_required', paymentIntentStatus: null }), order(), 'acct_FictionalAccount1')).toEqual({ ok: false, refusal: 'unknown_payment_status' });
  });
});
