import { describe, expect, it } from 'vitest';
import { createProgramCheckout } from './program-checkout';
import { createFictionalCheckoutLedger } from './program-checkout-ledger';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import { createFictionalEducationLedger } from './program-education-ledger';
import { createProgramSettlement, hashClaimToken, newClaimToken } from './program-settlement';
import { createFictionalProgramOfferLedger, type OfferActor } from './program-offer-ledger';
import { ENTITLEMENT_TRANSITIONS, ENTITLEMENT_STATES, isAccessActive } from '../../contracts/programEducationAccess';
import type { VerifiedEvent } from '../stripe-boundary';

/**
 * Settlement over the fictional ledgers: one entitlement per verified order whichever path arrives
 * first, a one-time expiring claim that binds the subject and opens the enrollment, cross-owner and
 * receipt-substitution isolation, the wrong account or mode refused, policy events held and
 * visible, expiry applied on read, retry after a crash, and nothing clinical touched.
 */
const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222', staff = '33333333-3333-4333-8333-333333333333';
const curriculum = { versionId: '44444444-4444-4444-8444-444444444444', version: 1, sourceDigest: 'a'.repeat(64) };
const me: OfferActor = { personId: staff, organizationId: org };
const alice = 'sub:fictional-alice-0001', bob = 'sub:fictional-bob-00002';
const expected = { accountRef: 'acct_FictionalAccount1', apiVersion: '2025-08-27.basil' };
const event = (id: string, sessionRef: string, type = 'checkout.session.completed'): VerifiedEvent => ({ id, type, livemode: false, created: 1, data: { object: { object: 'checkout.session', id: sessionRef } } });

async function harness(accessDurationDays: number | null = 30) {
  let clock = Date.parse('2026-10-11T12:00:00Z');
  const now = () => new Date(clock);
  const tick = (ms: number) => { clock += ms; };
  const content = { title: 'Fictional guide', phases: [{ id: 'phase-1', title: 'Phase one', days: 1, transition: 'scheduled', items: [] }], sourceDigest: curriculum.sourceDigest };
  const offers = createFictionalProgramOfferLedger({ curriculum: async (o, p) => o === org && p === program ? { programId: p, current: curriculum } : null, now });
  const created = await offers.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays } });
  const offerId = created.action === 'create' ? created.offer.offerId : '';
  await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
  await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
  const ledger = createFictionalCheckoutLedger({ now });
  const processor = createFictionalCheckoutProcessor({ now });
  const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: 'https://clinic.fictional.example', now });
  const education = createFictionalEducationLedger({ orders: ledger, now });
  const settlement = createProgramSettlement({ ledger: education, curriculumContent: async binding => binding.versionId === curriculum.versionId ? content : null, expectedAccountRef: expected.accountRef, now });
  async function verifiedOrder(attemptKey = 'browser-a', eventId = 'evt_' + attemptKey) {
    const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey });
    const order = ledger.orders.get(started.started ? started.orderId : '')!;
    processor.settle(order.processor!.sessionRef, 'paid');
    await checkout.admitEvent(event(eventId, order.processor!.sessionRef), 'raw', expected);
    await checkout.processEvent(eventId);
    return ledger.orders.get(order.orderId)!;
  }
  return { offers, ledger, processor, checkout, education, settlement, verifiedOrder, tick, now, content };
}

describe('settlement', () => {
  it('turns one verified order into one entitlement and one claim, idempotently, and never an unverified one', async () => {
    const h = await harness();
    const open = await h.checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey: 'browser-open' });
    expect(await h.settlement.settleOrder({ orderId: open.started ? open.orderId : '' })).toEqual({ settled: false, reason: 'order_not_verified' });
    const order = await h.verifiedOrder();
    expect(order.state).toBe('payment_verified');
    const first = await h.settlement.settleOrder(order);
    expect(first.settled && first.receipt.created).toBe(true);
    expect(first.settled && first.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.settled && first.receipt.entitlement).toMatchObject({ orderId: order.orderId, state: 'awaiting_claim', subject: { kind: 'unclaimed' }, curriculum, offerRevision: 3, accessDurationDays: 30, settlement: { verificationEventId: 'evt_browser-a' } });
    const again = await h.settlement.settleOrder(order);
    expect(again.settled && again.receipt.created).toBe(false);
    expect(again.settled && again.claimToken).toBeNull();
    expect(h.education.entitlements.size).toBe(1);
    expect(h.education.claims.size).toBe(1);
    // The claim is stored hashed; the token exists only in the first reply.
    expect([...h.education.claims.values()][0]!.tokenHash).toBe(hashClaimToken(first.settled ? first.claimToken! : ''));
  });
  it('a crash between verification and settlement is recovered by the worker; concurrent settlements converge on one row', async () => {
    const h = await harness();
    const a = await h.verifiedOrder('browser-a');
    const b = await h.verifiedOrder('browser-b');
    const outcomes = await Promise.all([h.settlement.settleOrder(a), h.settlement.settleOrder(a), h.settlement.settleDue()]);
    expect(h.education.entitlements.size).toBe(2);
    expect(outcomes[0].settled && outcomes[1].settled).toBe(true);
    expect([outcomes[0], outcomes[1]].filter(o => o.settled && o.claimToken).length).toBe(1);
    expect((await h.education.unsettledOrders(10)).length).toBe(0);
    expect((await h.education.entitlementForOrder(b.orderId))?.state).toBe('awaiting_claim');
  });
  it('refuses settlement of a payment from another processor account, and a failed payment', async () => {
    const h = await harness();
    const order = await h.verifiedOrder();
    const other = createProgramSettlement({ ledger: h.education, curriculumContent: async () => null, expectedAccountRef: 'acct_FictionalOther99', now: h.now });
    expect(await other.settleOrder(order)).toEqual({ settled: false, reason: 'account_mismatch' });
    const failed = await h.checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey: 'browser-f' });
    const failedOrder = h.ledger.orders.get(failed.started ? failed.orderId : '')!;
    h.processor.settle(failedOrder.processor!.sessionRef, 'failed');
    await h.checkout.admitEvent(event('evt_f', failedOrder.processor!.sessionRef, 'checkout.session.async_payment_failed'), 'raw', expected);
    await h.checkout.processEvent('evt_f');
    expect(h.ledger.orders.get(failedOrder.orderId)!.state).toBe('payment_failed');
    expect(await h.settlement.settleOrder(failedOrder)).toEqual({ settled: false, reason: 'order_not_verified' });
    expect(h.education.entitlements.size).toBe(0);
  });
});

describe('the claim', () => {
  it('binds the first verified subject, opens the window from the saved duration, creates one enrollment, and is single-use', async () => {
    const h = await harness();
    const order = await h.verifiedOrder();
    const settled = await h.settlement.settleOrder(order);
    const token = settled.settled ? settled.claimToken! : '';
    expect(await h.settlement.access(alice)).toMatchObject({ entitlements: [], enrollments: [] });
    const claimed = await h.settlement.claim(alice, token);
    expect(claimed).toMatchObject({ outcome: 'claimed', entitlement: { state: 'active', subject: { kind: 'claimed', consumerSubject: alice }, window: { startsAt: '2026-10-11T12:00:00.000Z', endsAt: '2026-11-10T12:00:00.000Z' } } });
    const access = await h.settlement.access(alice);
    expect(access?.entitlements).toHaveLength(1);
    expect(access?.enrollments).toHaveLength(1);
    expect(access?.enrollments[0]).toMatchObject({ consumerSubject: alice, state: 'active', phaseIndex: 0, curriculum });
    expect(await h.settlement.claim(alice, token)).toEqual({ outcome: 'refused', reason: 'claim_used' });
    expect(await h.settlement.claim(bob, token)).toEqual({ outcome: 'refused', reason: 'already_claimed_by_other' });
    expect(await h.settlement.access(bob)).toMatchObject({ entitlements: [], enrollments: [] });
    expect(h.education.enrollments.size).toBe(1);
  });
  it('refuses a forged, expired or malformed token, and an order number or receipt is not a claim', async () => {
    const h = await harness();
    const order = await h.verifiedOrder();
    const settled = await h.settlement.settleOrder(order);
    const token = settled.settled ? settled.claimToken! : '';
    expect(await h.settlement.claim(bob, newClaimToken())).toEqual({ outcome: 'refused', reason: 'claim_invalid' });
    expect(await h.settlement.claim(bob, order.orderId)).toEqual({ outcome: 'refused', reason: 'claim_invalid' });
    expect(await h.settlement.claim(bob, order.processor!.sessionRef)).toEqual({ outcome: 'refused', reason: 'claim_invalid' });
    expect(await h.settlement.claim(bob, 'x'.repeat(100))).toEqual({ outcome: 'refused', reason: 'claim_invalid' });
    h.tick(8 * 86_400_000);
    expect(await h.settlement.claim(alice, token)).toEqual({ outcome: 'refused', reason: 'claim_expired' });
    expect((await h.education.entitlementForOrder(order.orderId))!.state).toBe('awaiting_claim');
    expect(h.education.enrollments.size).toBe(0);
  });
  it('serves the exact purchased curriculum to the active owner only, and withholds for everyone and everything else', async () => {
    const h = await harness();
    const order = await h.verifiedOrder();
    const settled = await h.settlement.settleOrder(order);
    const entitlementId = settled.settled ? settled.receipt.entitlement.entitlementId : '';
    expect(await h.settlement.curriculum(alice, entitlementId)).toEqual({ outcome: 'withheld', entitlementId, reason: 'not_owner' });
    await h.settlement.claim(alice, settled.settled ? settled.claimToken! : '');
    expect(await h.settlement.curriculum(alice, entitlementId)).toMatchObject({ outcome: 'served', curriculum, title: 'Fictional guide' });
    expect(await h.settlement.curriculum(bob, entitlementId)).toEqual({ outcome: 'withheld', entitlementId, reason: 'not_owner' });
    h.content.sourceDigest = 'b'.repeat(64);
    expect(await h.settlement.curriculum(alice, entitlementId)).toEqual({ outcome: 'withheld', entitlementId, reason: 'digest_mismatch' });
    h.content.sourceDigest = curriculum.sourceDigest;
    h.tick(31 * 86_400_000);
    expect(await h.settlement.curriculum(alice, entitlementId)).toEqual({ outcome: 'withheld', entitlementId, reason: 'not_active' });
    const access = await h.settlement.access(alice);
    expect(access?.entitlements[0]).toMatchObject({ state: 'expired' });
  });
});

describe('policy, expiry and the table', () => {
  it('a refund, dispute or renewal event holds the entitlement visibly; release and revoke are recorded operator decisions; nothing is deleted', async () => {
    const h = await harness(null);
    const order = await h.verifiedOrder();
    const settled = await h.settlement.settleOrder(order);
    await h.settlement.claim(alice, settled.settled ? settled.claimToken! : '');
    const held = await h.settlement.recordPolicy(order.orderId, 'refund', 're_fictional_1');
    expect(held).toMatchObject({ state: 'held_refund', policy: { kind: 'refund', reference: 're_fictional_1' } });
    expect(isAccessActive(held!, h.now())).toBe(false);
    expect(await h.settlement.curriculum(alice, held!.entitlementId)).toMatchObject({ outcome: 'withheld', reason: 'not_active' });
    expect((await h.settlement.access(alice))?.entitlements[0]).toMatchObject({ state: 'held_refund' });
    const released = await h.settlement.recordPolicy(order.orderId, 'operator_release', 'review-fictional-1');
    expect(released).toMatchObject({ state: 'active' });
    expect(await h.settlement.recordPolicy(order.orderId, 'dispute', 'dp_fictional_1')).toMatchObject({ state: 'held_dispute' });
    expect(await h.settlement.recordPolicy(order.orderId, 'operator_revoke', 'review-fictional-2')).toMatchObject({ state: 'revoked' });
    expect(await h.settlement.recordPolicy(order.orderId, 'operator_release', 'review-fictional-3')).toBeNull();
    expect(h.education.events.map(e => e.kind)).toEqual(['settled', 'transition', 'claimed', 'transition', 'refund', 'transition', 'operator_release', 'transition', 'dispute', 'transition', 'operator_revoke']);
    expect(h.education.entitlements.size).toBe(1);
    // An entitlement with no decided duration never expires on its own.
    const open = await h.verifiedOrder('browser-b');
    const second = await h.settlement.settleOrder(open);
    await h.settlement.claim(bob, second.settled ? second.claimToken! : '');
    h.tick(400 * 86_400_000);
    expect((await h.settlement.access(bob))?.entitlements[0]).toMatchObject({ state: 'active', window: { endsAt: null } });
  });
  it('the transition table is monotonic: nothing returns to awaiting_claim, expired and revoked are final', () => {
    for (const state of ENTITLEMENT_STATES) expect(ENTITLEMENT_TRANSITIONS[state]).not.toContain('awaiting_claim');
    expect(ENTITLEMENT_TRANSITIONS.expired).toEqual([]);
    expect(ENTITLEMENT_TRANSITIONS.revoked).toEqual([]);
  });
  it('a store failure is reported, never a success or an empty access', async () => {
    const h = await harness();
    const order = await h.verifiedOrder();
    const broken = createFictionalEducationLedger({ orders: h.ledger, faults: { before: () => { throw new Error('fictional outage'); } } });
    const settlement = createProgramSettlement({ ledger: broken, curriculumContent: async () => null, expectedAccountRef: expected.accountRef });
    expect(await settlement.settleOrder(order)).toEqual({ settled: false, reason: 'store_unavailable' });
    expect(await settlement.access(alice)).toBeNull();
    expect(await settlement.claim(alice, newClaimToken())).toEqual({ outcome: 'refused', reason: 'service_unavailable' });
    expect(await settlement.curriculum(alice, '55555555-5555-4555-8555-555555555555')).toMatchObject({ outcome: 'withheld', reason: 'service_unavailable' });
  });
});
