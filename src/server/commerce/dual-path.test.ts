import { fictionalDelivery } from '../../test-support/commerceDelivery';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createProgramCheckout } from './program-checkout';
import { createFictionalCheckoutLedger } from './program-checkout-ledger';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import { createFictionalEducationLedger } from './program-education-ledger';
import { createProgramSettlement } from './program-settlement';
import { createFictionalProgramOfferLedger, type OfferActor } from './program-offer-ledger';
import type { VerifiedEvent } from '../stripe-boundary';

/**
 * The two paths a visitor may take are separate authorities and stay separate: a consultation
 * request means "requested" and reaches the consult domain only; a purchase reaches the commercial
 * domain only; neither module tree imports the other, and neither imports anything clinical. When
 * both happen for the same person, each produces exactly its own record: a race between a consult
 * request and a purchase cannot produce two entitlements, and a purchase cannot produce a consult
 * request, a clinic connection or a protocol step. The convergence journeys (consultation first and
 * an offer later; direct checkout pending verification; verified access; the explicit review before
 * anything clinical) are the boundary tests in program-checkout.test.ts, program-settlement.test.ts
 * and the candidate database tests; this file holds the separation and the race.
 */
function files(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) { const full = join(directory, entry); if (statSync(full).isDirectory()) out.push(...files(full)); else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full); }
  return out;
}
const imports = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]!);

describe('separation of the two paths', () => {
  it('commerce imports nothing from the consult domain and nothing clinical; the consult domain imports nothing commercial', () => {
    for (const file of files('src/server/commerce')) {
      // The identity request-context TYPE (aws-identity-consent) is the one clinical-core import the bridge needs; it carries no data.
      const bad = imports(file).filter(target => /\/(consult|consent|patient|encounter|telehealth|protocol)[A-Za-z-]*|program-assignments|programAssignments|aws-clinical-data/.test(target));
      expect(bad, file).toEqual([]);
    }
    for (const file of files('src/server/consult')) {
      const bad = imports(file).filter(target => /commerce|programOffers|programCheckout|programEducationAccess|stripe/.test(target));
      expect(bad, file).toEqual([]);
    }
    for (const file of ['src/app/api/live/commerce/checkout/route.ts', 'src/app/api/live/commerce/webhook/route.ts', 'src/app/buy/[slug]/page.tsx', 'src/app/buy/return/page.tsx']) {
      expect(imports(file).filter(target => /consult\/|server\/session/.test(target)), file).toEqual([]);
    }
    // The consult intake route is the one unauthenticated clinical route and stays what it was: it imports nothing commercial.
    expect(imports('src/app/api/public/consult/route.ts').filter(target => /commerce|checkout|offer/i.test(target))).toEqual([]);
  });
});

describe('a consultation and a purchase racing', () => {
  const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222', staff = '33333333-3333-4333-8333-333333333333';
  const curriculum = { versionId: '44444444-4444-4444-8444-444444444444', version: 1, sourceDigest: 'a'.repeat(64) };
  const me: OfferActor = { personId: staff, organizationId: org };
  it('produce exactly one entitlement and no clinical or consult record, whatever order their events arrive in', async () => {
    const offers = createFictionalProgramOfferLedger({ curriculum: async (o, p) => o === org && p === program ? { programId: p, current: curriculum } : null });
    const created = await offers.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } });
    const offerId = created.action === 'create' ? created.offer.offerId : '';
    await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
    await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
    const ledger = createFictionalCheckoutLedger();
    const processor = createFictionalCheckoutProcessor();
    const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: 'https://clinic.fictional.example' });
    const education = createFictionalEducationLedger({ orders: ledger });
    const delivery = fictionalDelivery(education);
    const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => null, expectedAccountRef: processor.accountRef, sealer: delivery.sealer });
    // The consult request is a separate authority with its own store; here it is represented by a counter that commerce cannot reach.
    const consultRequests: string[] = [];
    const requestConsultation = async () => { consultRequests.push('requested'); };
    const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey: 'browser-a' });
    const order = ledger.orders.get(started.started ? started.orderId : '')!;
    processor.settle(order.processor!.sessionRef, 'paid');
    const expected = { accountRef: processor.accountRef, apiVersion: '2025-08-27.basil' };
    const event = (id: string, type: string): VerifiedEvent => ({ id, type, livemode: false, created: 1, data: { object: { object: 'checkout.session', id: order.processor!.sessionRef } } });
    // Both event orders, a consult request in between, and settlement from three directions at once.
    await Promise.all([
      requestConsultation(),
      checkout.admitEvent(event('evt_a', 'checkout.session.async_payment_succeeded'), 'raw', expected),
      checkout.admitEvent(event('evt_b', 'checkout.session.completed'), 'raw', expected),
      requestConsultation(),
    ]);
    await Promise.all([checkout.processEvent('evt_b'), checkout.processEvent('evt_a')]);
    const passes = await Promise.all([settlement.settleDue(), settlement.settleOrder(order), settlement.settleDue(), settlement.settleOrder(order)]);
    // A worker pass is its outcomes, or the fact that the backlog could not be read; here it always could.
    const outcomes = passes.flatMap(pass => ('ok' in pass ? (pass.ok ? pass.outcomes : [expect.fail('backlog unreadable')]) : [pass]));
    expect(ledger.orders.get(order.orderId)!.state).toBe('payment_verified');
    expect(education.entitlements.size).toBe(1);
    expect(education.enrollments.size).toBe(0);
    expect(outcomes.filter(o => o.settled && o.delivery === 'queued').length).toBe(1);
    expect(education.deliveries.size).toBe(1);
    expect(consultRequests).toEqual(['requested', 'requested']);
    // Nothing in the commercial stores names a consultation, a clinic connection, a patient or a protocol.
    const everything = JSON.stringify({ orders: [...ledger.orders.values()], entitlements: [...education.entitlements.values()], events: education.events });
    expect(everything).not.toMatch(/consult|connection|patient|protocol|appointment/i);
  });
});
