import { describe, expect, it } from 'vitest';
import { createFictionalProgramOfferLedger, ProgramOfferError, publishHolds, type CurriculumReader, type OfferActor } from './program-offer-ledger';
import { formatAmount, parseMajorAmount, programOffer, purchaseAvailability, PURCHASE_HOLD_EXPLANATIONS, type CurriculumBinding, type ProgramOffer } from '../../contracts/programOffers';
import { funnelTextIssue } from '../../funnels/schema';
import { FICTIONAL_ACCESS_TERMS } from './program-commerce-authority';

/**
 * The offer contract and the fictional ledger: the same invariants the candidate test proves in SQL,
 * here against the implementation the routes, the Studio and the funnel pages run on locally.
 */
const id = (n: number) => '70000000-0000-4000-8000-' + String(n).padStart(12, '0');
const org = id(1), otherOrg = id(2), staff = id(3), program = id(4), unpublished = id(5), foreign = id(6);
const v1: CurriculumBinding = { versionId: id(10), version: 1, sourceDigest: 'a'.repeat(64) };
const v2: CurriculumBinding = { versionId: id(11), version: 2, sourceDigest: 'b'.repeat(64) };
const me: OfferActor = { personId: staff, organizationId: org };
const paid = (over: Record<string, unknown> = {}) => ({ mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/2', accessDurationDays: null, ...over });
function harness(current: Record<string, CurriculumBinding | null> = { [program]: v1, [unpublished]: null }) {
  const state = { current };
  const curriculum: CurriculumReader = async (organizationId, programId) => organizationId === org && programId in state.current ? { programId, current: state.current[programId]! } : null;
  let clock = Date.parse('2026-10-11T12:00:00Z');
  return { state, ledger: createFictionalProgramOfferLedger({ curriculum, now: () => new Date((clock += 1000)) }) };
}
async function refusal(work: () => Promise<unknown>): Promise<ProgramOfferError> {
  try { await work(); } catch (error) { if (error instanceof ProgramOfferError) return error; throw error; }
  throw new Error('expected a refusal');
}
const offerOf = (result: unknown) => (result as { offer: ProgramOffer }).offer;

describe('the contract', () => {
  it('admits integer minor units in a supported currency with an explicit billing mode, and nothing else', () => {
    const base = { contract: 'program-offer/1', offerId: id(20), organizationId: org, programId: program, curriculum: v1, revision: 1, state: 'draft', name: 'x', accessTermsVersion: null, accessDurationDays: null, authoredBy: staff, authoredAt: '2026-10-11T12:00:00Z', mode: 'paid', providerPrice: null };
    expect(programOffer.safeParse({ ...base, pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } } }).success).toBe(true);
    expect(programOffer.safeParse({ ...base, pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'recurring', interval: 'month', intervalCount: 1 } } }).success).toBe(true);
    for (const pricing of [
      { currency: 'USD', amountMinor: 0, billing: { kind: 'one_time' } }, { currency: 'USD', amountMinor: -1, billing: { kind: 'one_time' } },
      { currency: 'USD', amountMinor: 19.99, billing: { kind: 'one_time' } }, { currency: 'USD', amountMinor: '1999', billing: { kind: 'one_time' } },
      { currency: 'USD', amountMinor: 1_000_001, billing: { kind: 'one_time' } }, { currency: 'EUR', amountMinor: 1999, billing: { kind: 'one_time' } },
      { currency: 'USD', amountMinor: 1999, billing: { kind: 'recurring' } }, { currency: 'USD', amountMinor: 1999, billing: { kind: 'recurring', interval: 'week', intervalCount: 1 } },
      { currency: 'USD', amountMinor: 1999, billing: { kind: 'lifetime' } }, { currency: 'USD', amountMinor: 1999 },
    ]) expect(programOffer.safeParse({ ...base, pricing }).success, JSON.stringify(pricing)).toBe(false);
    expect(programOffer.safeParse({ ...base, mode: 'free' }).success).toBe(false);
    expect(programOffer.safeParse({ ...base, pricing: null, providerPrice: { provider: 'stripe', mode: 'live', priceRef: 'price_FictionalAbc123', approval: null } }).success).toBe(false);
    expect(programOffer.safeParse({ ...base, pricing: null, providerPrice: { provider: 'stripe', mode: 'test', priceRef: 'anything', approval: null } }).success).toBe(false);
    expect(programOffer.safeParse({ ...base, pricing: null, state: 'published' }).success).toBe(false);
    expect(programOffer.safeParse({ ...base, accessDurationDays: 0 }).success).toBe(false);
  });
  it('turns typed amounts into minor units exactly, or refuses', () => {
    expect(parseMajorAmount('19.99', 'USD')).toBe(1999);
    expect(parseMajorAmount(' 20 ', 'USD')).toBe(2000);
    expect(parseMajorAmount('0.5', 'USD')).toBe(50);
    for (const text of ['', 'abc', '19.999', '-1', '0', '0.00', '1e3', '$19.99', '10001', '1,999']) expect(parseMajorAmount(text, 'USD'), text).toBeNull();
    expect(formatAmount({ currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } })).toBe('19.99 USD, one payment');
    expect(formatAmount({ currency: 'USD', amountMinor: 5, billing: { kind: 'recurring', interval: 'month', intervalCount: 1 } })).toBe('0.05 USD every month');
    expect(formatAmount({ currency: 'USD', amountMinor: 1_000_000, billing: { kind: 'recurring', interval: 'month', intervalCount: 3 } })).toBe('10000.00 USD every 3 months');
  });
  it('every hold explanation passes the funnel text rules and names no address, promise or price', () => {
    for (const [reason, text] of Object.entries(PURCHASE_HOLD_EXPLANATIONS)) {
      expect(funnelTextIssue(text), reason).toBeNull();
      expect(text, reason).not.toMatch(/\$|\d/);
    }
  });
  it('availability is a function of the stored offer and the program as it is now', () => {
    const published: ProgramOffer = programOffer.parse({ contract: 'program-offer/1', offerId: id(20), organizationId: org, programId: program, curriculum: v1, revision: 3, state: 'published', name: 'x', accessTermsVersion: 'education-access-terms/2', accessDurationDays: null, authoredBy: staff, authoredAt: '2026-10-11T12:00:00Z', mode: 'paid', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPrice: { provider: 'stripe', mode: 'test', priceRef: 'price_FictionalAbc123', approval: { by: staff, at: '2026-10-11T12:00:00Z' } } });
    // Reviewed terms that state access has no end: the only way a null duration is a decision.
    const reviewed = FICTIONAL_ACCESS_TERMS.find(t => t.version === 'education-access-terms/2')!;
    expect(purchaseAvailability(published, v1, reviewed)).toMatchObject({ available: true, offerId: id(20), revision: 3 });
    expect(purchaseAvailability(published, v2, reviewed)).toMatchObject({ available: false, reason: 'curriculum_changed' });
    expect(purchaseAvailability(published, null, reviewed)).toMatchObject({ available: false, reason: 'curriculum_unpublished' });
    expect(purchaseAvailability(null, v1, reviewed)).toMatchObject({ available: false, reason: 'offer_absent' });
    expect(purchaseAvailability({ ...published, state: 'draft' }, v1, reviewed)).toMatchObject({ available: false, reason: 'offer_draft' });
    expect(purchaseAvailability({ ...published, state: 'retired' }, v1, reviewed)).toMatchObject({ available: false, reason: 'offer_retired' });
    expect(publishHolds({ ...published, state: 'draft', pricing: null, providerPrice: null, accessTermsVersion: null } as ProgramOffer, null, reviewed)).toEqual(['no_pricing', 'provider_mapping_missing', 'no_access_terms', 'curriculum_unpublished']);
    // A version nobody reviewed, a duration the review contradicts: held, never purchasable on a default.
    expect(purchaseAvailability(published, v1, null)).toMatchObject({ available: false, reason: 'access_terms_unreviewed' });
    expect(purchaseAvailability({ ...published, accessDurationDays: 30 }, v1, reviewed)).toMatchObject({ available: false, reason: 'access_duration_undecided' });
  });
});

describe('the fictional ledger', () => {
  it('creates against the curriculum it read, refuses stale revisions and other clinics, and keeps an append-only log', async () => {
    const { ledger } = harness();
    const offer = offerOf(await ledger.execute(me, { action: 'create', programId: program, terms: paid() }));
    expect(offer).toMatchObject({ revision: 1, state: 'draft', curriculum: v1, authoredBy: staff });
    expect((await refusal(() => ledger.execute(me, { action: 'create', programId: unpublished, terms: paid() }))).category).toBe('curriculum_unpublished');
    expect((await refusal(() => ledger.execute(me, { action: 'create', programId: foreign, terms: paid() }))).category).toBe('program_not_found');
    expect((await refusal(() => ledger.execute({ personId: staff, organizationId: otherOrg }, { action: 'revise', offerId: offer.offerId, expectedRevision: 1, terms: paid() }))).category).toBe('offer_not_found');
    const revised = offerOf(await ledger.execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: 1, terms: paid({ name: 'Renamed' }) }));
    expect(revised.revision).toBe(2);
    expect((await refusal(() => ledger.execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: 1, terms: paid({ name: 'Stale' }) }))).category).toBe('revision_stale');
    expect((await ledger.read(me, offer.offerId))?.name).toBe('Renamed');
    expect(await ledger.read({ personId: staff, organizationId: otherOrg }, offer.offerId)).toBeNull();
    expect(ledger.revisions.map(r => r.revision)).toEqual([1, 2]);
    expect(ledger.audit.map(a => a.action)).toEqual(['create', 'revise']);
  });
  it('malformed paid terms are refused, incomplete ones stay a draft, and neither becomes complimentary', async () => {
    const { ledger } = harness();
    for (const terms of [paid({ pricing: { currency: 'USD', amountMinor: 0, billing: { kind: 'one_time' } } }), paid({ mode: 'free' }), paid({ providerPriceRef: 'price_live' }), paid({ extra: 1 })]) {
      expect((await refusal(() => ledger.execute(me, { action: 'create', programId: program, terms }))).category).toBe('request_invalid');
    }
    const draft = offerOf(await ledger.execute(me, { action: 'create', programId: program, terms: paid({ pricing: null, providerPriceRef: null, accessTermsVersion: null }) }));
    expect(draft).toMatchObject({ mode: 'paid', state: 'draft', pricing: null, providerPrice: null });
    const refused = await refusal(() => ledger.execute(me, { action: 'publish', offerId: draft.offerId, expectedRevision: 1 }));
    expect(refused.category).toBe('publish_refused');
    expect(refused.holds).toEqual(['no_pricing', 'provider_mapping_missing', 'no_access_terms']);
    expect(await ledger.availability(org, program)).toMatchObject({ available: false, reason: 'offer_draft' });
    expect(ledger.revisions.every(r => r.mode === 'paid')).toBe(true);
  });
  it('authorized complimentary access works and is never purchasable', async () => {
    const { ledger } = harness();
    const comp = offerOf(await ledger.execute(me, { action: 'create', programId: program, terms: { mode: 'complimentary', name: 'Arranged', reason: 'Fictional authorized reason for the review', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } }));
    expect(comp).toMatchObject({ mode: 'complimentary', authorization: { authorizedBy: staff, reason: 'Fictional authorized reason for the review' } });
    expect(offerOf(await ledger.execute(me, { action: 'publish', offerId: comp.offerId, expectedRevision: 1 })).state).toBe('published');
    expect(await ledger.availability(org, program)).toMatchObject({ available: false, reason: 'complimentary_mode' });
    expect((await refusal(() => ledger.execute(me, { action: 'create', programId: program, terms: { mode: 'complimentary', name: 'Arranged', reason: 'short', accessTermsVersion: null, accessDurationDays: null } }))).category).toBe('request_invalid');
  });
  it('publishes only when every hold is clear, keeps published terms immutable, allows one published offer, and withholds when the curriculum moves', async () => {
    const { ledger, state } = harness();
    const offer = offerOf(await ledger.execute(me, { action: 'create', programId: program, terms: paid() }));
    expect((await refusal(() => ledger.execute(me, { action: 'publish', offerId: offer.offerId, expectedRevision: 1 }))).holds).toEqual(['provider_mapping_unapproved']);
    const approved = offerOf(await ledger.execute(me, { action: 'approve_provider_mapping', offerId: offer.offerId, expectedRevision: 1 }));
    expect(approved.mode === 'paid' && approved.providerPrice?.approval).toMatchObject({ by: staff });
    const retyped = offerOf(await ledger.execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: 2, terms: paid({ providerPriceRef: 'price_FictionalOther9' }) }));
    expect(retyped.mode === 'paid' && retyped.providerPrice?.approval).toBeNull();
    const back = offerOf(await ledger.execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: 3, terms: paid() }));
    expect(back.mode === 'paid' && back.providerPrice?.approval).toBeNull();
    await ledger.execute(me, { action: 'approve_provider_mapping', offerId: offer.offerId, expectedRevision: 4 });
    const published = offerOf(await ledger.execute(me, { action: 'publish', offerId: offer.offerId, expectedRevision: 5 }));
    expect(published).toMatchObject({ state: 'published', revision: 6 });
    expect(await ledger.availability(org, program)).toMatchObject({ available: true, offerId: offer.offerId, revision: 6, pricing: { amountMinor: 1999 } });
    expect((await refusal(() => ledger.execute(me, { action: 'revise', offerId: offer.offerId, expectedRevision: 6, terms: paid({ pricing: { currency: 'USD', amountMinor: 1, billing: { kind: 'one_time' } } }) }))).category).toBe('state_invalid');
    const second = offerOf(await ledger.execute(me, { action: 'create', programId: program, terms: paid() }));
    await ledger.execute(me, { action: 'approve_provider_mapping', offerId: second.offerId, expectedRevision: 1 });
    expect((await refusal(() => ledger.execute(me, { action: 'publish', offerId: second.offerId, expectedRevision: 2 }))).holds).toEqual(['another_offer_published']);
    state.current[program] = v2;
    expect(await ledger.availability(org, program)).toMatchObject({ available: false, reason: 'curriculum_changed' });
    expect((await refusal(() => ledger.execute(me, { action: 'publish', offerId: second.offerId, expectedRevision: 2 }))).holds).toEqual(['curriculum_changed']);
    const retired = offerOf(await ledger.execute(me, { action: 'retire', offerId: offer.offerId, expectedRevision: 6, reason: 'Fictional retirement' }));
    expect(retired.state).toBe('retired');
    expect((await refusal(() => ledger.execute(me, { action: 'retire', offerId: offer.offerId, expectedRevision: 7, reason: 'again' }))).category).toBe('state_invalid');
    expect(await ledger.availability(org, program)).toMatchObject({ available: false, reason: 'offer_draft' });
    await ledger.execute(me, { action: 'retire', offerId: second.offerId, expectedRevision: 2, reason: 'Fictional retirement' });
    expect(await ledger.availability(org, program)).toMatchObject({ available: false, reason: 'offer_retired' });
    expect(await ledger.availability(org, foreign)).toMatchObject({ available: false, reason: 'offer_absent' });
  });
  it('a failing read answers "could not be checked", never "no offer"', async () => {
    const curriculum: CurriculumReader = async () => { throw new Error('fictional outage'); };
    const ledger = createFictionalProgramOfferLedger({ curriculum });
    expect(await ledger.availability(org, program)).toMatchObject({ available: false, reason: 'commerce_unverifiable' });
    expect((await refusal(() => ledger.execute(me, { action: 'list', programId: program }))).category).toBe('service_unavailable');
  });
});
