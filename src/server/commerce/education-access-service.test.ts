import { describe, expect, it } from 'vitest';
import { createEducationAccessService, EducationAccessError, EDUCATION_ACCESS_ROUTE_SEAM } from './education-access-service';
import { createProgramCheckout } from './program-checkout';
import { createFictionalCheckoutLedger } from './program-checkout-ledger';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import { createFictionalEducationLedger } from './program-education-ledger';
import { createProgramSettlement } from './program-settlement';
import { createFictionalProgramOfferLedger, type OfferActor } from './program-offer-ledger';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from './program-commerce-activation';
import type { ClinicalRequestContext, SyntheticRequestContext } from '../clinical-core/aws-identity-consent';
import type { VerifiedEvent } from '../stripe-boundary';
import { readFileSync } from 'node:fs';

/**
 * The consumer education bridge: disabled without exact evidence, the consumer pool on the synthetic
 * boundary only, the subject from the verified context and never the body, three actions and no
 * more, and no registration of its route anywhere in this source.
 */
const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222', staff = '33333333-3333-4333-8333-333333333333';
const curriculum = { versionId: '44444444-4444-4444-8444-444444444444', version: 1, sourceDigest: 'a'.repeat(64) };
const me: OfferActor = { personId: staff, organizationId: org };
const CHECKOUT_SHA = 'c'.repeat(64), EDUCATION_SHA = 'd'.repeat(64);
const evidence = () => ({ contract: 'program-commerce-activation/1', enabled: true, target: 'synthetic-staging', schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-11T00:00:00Z' });
const consumer = (subject: string, over: Partial<SyntheticRequestContext> = {}): ClinicalRequestContext => ({ actorPersonId: '55555555-5555-4555-8555-555555555555', organizationId: org, identityPool: 'consumer', identitySubject: subject, purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false, ...over });
const alice = 'sub:fictional-alice-0001', bob = 'sub:fictional-bob-00002';

async function harness() {
  const offers = createFictionalProgramOfferLedger({ curriculum: async (o, p) => o === org && p === program ? { programId: p, current: curriculum } : null });
  const created = await offers.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: null } });
  const offerId = created.action === 'create' ? created.offer.offerId : '';
  await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
  await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
  const ledger = createFictionalCheckoutLedger();
  const processor = createFictionalCheckoutProcessor();
  const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: 'https://clinic.fictional.example' });
  const education = createFictionalEducationLedger({ orders: ledger });
  const deliveries: { claimToken: string }[] = [];
  const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => ({ title: 'Fictional guide', phases: [{ id: 'p' }], sourceDigest: curriculum.sourceDigest }), expectedAccountRef: processor.accountRef, deliver: async d => { deliveries.push(d); } });
  const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey: 'browser-a' });
  const order = ledger.orders.get(started.started ? started.orderId : '')!;
  processor.settle(order.processor!.sessionRef, 'paid');
  const event: VerifiedEvent = { id: 'evt_1', type: 'checkout.session.completed', livemode: false, created: 1, data: { object: { object: 'checkout.session', id: order.processor!.sessionRef } } };
  await checkout.admitEvent(event, 'raw', { accountRef: processor.accountRef, apiVersion: '2025-08-27.basil' });
  await checkout.processEvent('evt_1');
  await settlement.settleDue();
  const service = (over: Partial<Parameters<typeof createEducationAccessService>[0]> = {}) => createEducationAccessService({ settlement, activation: evidence(), checkoutCandidateSha256: CHECKOUT_SHA, educationCandidateSha256: EDUCATION_SHA, expectedCheckoutSha256: CHECKOUT_SHA, expectedEducationSha256: EDUCATION_SHA, ...over });
  return { service, token: deliveries[0]!.claimToken, order };
}
async function refusal(work: () => Promise<unknown>): Promise<EducationAccessError> {
  try { await work(); } catch (error) { if (error instanceof EducationAccessError) return error; throw error; }
  throw new Error('expected a refusal');
}

describe('the education access bridge', () => {
  it('is disabled without exact activation evidence, and refuses every identity but a consumer on the synthetic boundary', async () => {
    const h = await harness();
    expect((await refusal(() => h.service({ activation: undefined })(consumer(alice), { action: 'access' }))).category).toBe('activation_refused');
    expect((await refusal(() => h.service({ educationCandidateSha256: 'f'.repeat(64) })(consumer(alice), { action: 'access' }))).category).toBe('activation_refused');
    expect((await refusal(() => h.service({ checkoutCandidateSha256: 'f'.repeat(64) })(consumer(alice), { action: 'access' }))).category).toBe('activation_refused');
    expect((await refusal(() => h.service()(consumer(alice, { identityPool: 'workforce' }), { action: 'access' }))).category).toBe('identity_refused');
    expect((await refusal(() => h.service()(consumer(alice, { purpose: 'consent_management' }), { action: 'access' }))).category).toBe('identity_refused');
    const production = { actorPersonId: '55555555-5555-4555-8555-555555555555', organizationId: org, identityPool: 'consumer', identitySubject: alice, purpose: 'clinical_data', environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true } as const;
    expect((await refusal(() => h.service()(production, { action: 'access' }))).category).toBe('identity_refused');
  });
  it('reads only the three actions, takes the subject from the context and never the body, and binds the claim to the verified subject', async () => {
    const h = await harness();
    const service = h.service();
    for (const body of [{ action: 'settle' }, { action: 'access', consumerSubject: bob }, { action: 'claim' }, { action: 'claim', token: h.order.orderId }, { action: 'curriculum' }, null, 'access']) {
      expect((await refusal(() => service(consumer(alice), body))).category, JSON.stringify(body)).toBe('request_invalid');
    }
    expect(await service(consumer(alice), { action: 'access' })).toMatchObject({ action: 'access', view: { consumerSubject: alice, entitlements: [], enrollments: [] } });
    const claimed = await service(consumer(alice), { action: 'claim', token: h.token });
    expect(claimed).toMatchObject({ action: 'claim', outcome: 'claimed', entitlement: { subject: { kind: 'claimed', consumerSubject: alice }, state: 'active' } });
    const entitlementId = claimed.action === 'claim' && claimed.outcome === 'claimed' ? claimed.entitlement.entitlementId : '';
    expect(await service(consumer(bob), { action: 'claim', token: h.token })).toMatchObject({ action: 'claim', outcome: 'refused', reason: 'already_claimed_by_other' });
    expect(await service(consumer(bob), { action: 'access' })).toMatchObject({ action: 'access', view: { consumerSubject: bob, entitlements: [] } });
    expect(await service(consumer(bob), { action: 'curriculum', entitlementId })).toMatchObject({ action: 'curriculum', read: { outcome: 'withheld', reason: 'not_owner' } });
    expect(await service(consumer(alice), { action: 'curriculum', entitlementId })).toMatchObject({ action: 'curriculum', read: { outcome: 'served', title: 'Fictional guide' } });
  });
  it('names its route as a seam and registers it nowhere in this source', () => {
    expect(EDUCATION_ACCESS_ROUTE_SEAM.route).toBe('POST /clinical-core/consumer/education');
    for (const path of ['src/server/clinical-core/aws-identity-api.ts', 'scripts/check-aws-authenticated-api.mjs', 'infra/aws-clinical-core/identity-api-extension.json']) {
      expect(readFileSync(path, 'utf8'), path).not.toContain('consumer/education');
    }
  });
});
