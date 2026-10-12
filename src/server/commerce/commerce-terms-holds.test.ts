import { describe, expect, it } from 'vitest';
import { createFictionalProgramOfferLedger, type OfferActor } from './program-offer-ledger';
import { createProgramCheckout } from './program-checkout';
import { createFictionalCheckoutLedger } from './program-checkout-ledger';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import { createFictionalEducationLedger } from './program-education-ledger';
import { createProgramSettlement } from './program-settlement';
import { fictionalDelivery } from '../../test-support/commerceDelivery';
import { isAccessActive } from '../../contracts/programEducationAccess';
import type { VerifiedEvent } from '../stripe-boundary';

/**
 * Work package 3, undecided commercial terms: an access-terms version nobody reviewed, an access
 * duration nobody decided, and a Core dependency nobody decided are holds, at publication and again
 * at activation. "No end" is a decision a reviewed policy states; null is the absence of one.
 */
const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222', staff = '33333333-3333-4333-8333-333333333333';
const curriculum = { versionId: '44444444-4444-4444-8444-444444444444', version: 1, sourceDigest: 'a'.repeat(64) };
const me: OfferActor = { personId: staff, organizationId: org };
const alice = 'sub:fictional-alice-0001';
const terms = (over: Record<string, unknown> = {}) => ({ mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30, ...over });

async function publishAttempt(over: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const offers = createFictionalProgramOfferLedger({ curriculum: async (o: string, p: string) => o === org && p === program ? { programId: p, current: curriculum } : null, ...options } as never);
  const created = await offers.execute(me, { action: 'create', programId: program, terms: terms(over) });
  const offerId = created.action === 'create' ? created.offer.offerId : '';
  await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
  const published = await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 }).catch(error => error);
  return { offers, published, availability: await offers.availability(org, program) };
}

describe('undecided terms are holds at publication', () => {
  it('an access-terms version nobody reviewed cannot publish, and the visitor sees the specific hold', async () => {
    const { published, availability } = await publishAttempt({ accessTermsVersion: 'education-access-terms/42' });
    expect(published).toMatchObject({ category: 'publish_refused', holds: expect.arrayContaining(['access_terms_unreviewed']) });
    expect(availability).toMatchObject({ available: false, reason: 'offer_draft' });
  });
  it('a null access duration is undecided, not "lifetime": it cannot publish unless the reviewed terms state that access has no end', async () => {
    const { published } = await publishAttempt({ accessDurationDays: null });
    expect(published).toMatchObject({ category: 'publish_refused', holds: expect.arrayContaining(['access_duration_undecided']) });
  });
});

describe('undecided terms are holds at activation', () => {
  it('an entitlement whose terms leave the duration undecided is never active without an end', async () => {
    // Bypass publication to model an order admitted under an older, looser artifact: activation must still hold.
    const offers = createFictionalProgramOfferLedger({ curriculum: async (o: string, p: string) => o === org && p === program ? { programId: p, current: curriculum } : null } as never);
    const ledger = createFictionalCheckoutLedger();
    const processor = createFictionalCheckoutProcessor();
    const checkout = createProgramCheckout({ offers: { ...offers, availability: async () => ({ available: true, offerId: '55555555-5555-4555-8555-555555555555', revision: 3, name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, curriculum, accessTermsVersion: 'education-access-terms/1', accessDurationDays: null, providerPriceRef: 'price_FictionalAbc123' }) } as never, ledger, processor, publicOrigin: 'https://clinic.fictional.example' });
    const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey: 'browser-a' });
    const order = ledger.orders.get(started.started ? started.orderId : '')!;
    processor.settle(order.processor!.sessionRef, 'paid');
    const event: VerifiedEvent = { id: 'evt_paid', type: 'checkout.session.completed', livemode: false, created: 1, data: { object: { object: 'checkout.session', id: order.processor!.sessionRef } } };
    await checkout.admitEvent(event, 'raw', { accountRef: processor.accountRef, apiVersion: '2025-08-27.basil' });
    await checkout.processEvent('evt_paid');
    const education = createFictionalEducationLedger({ orders: ledger });
    const delivery = fictionalDelivery(education);
    const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => null, expectedAccountRef: processor.accountRef, sealer: delivery.sealer });
    await settlement.settleOrder(ledger.orders.get(order.orderId)!);
    const code = await delivery.codeFor(order.orderId);
    const claimed = await settlement.claim({ kind: 'consumer', personId: '66666666-6666-4666-8666-000000000001', identitySubject: alice }, code);
    if (claimed.outcome === 'claimed') {
      // If it was ever granted, it must not be granted forever.
      expect(isAccessActive(claimed.entitlement, new Date('2036-01-01T00:00:00Z'))).toBe(false);
    }
    expect(claimed).toEqual({ outcome: 'refused', reason: 'terms_undecided' });
  });
});
