import { describe, expect, it } from 'vitest';
import { AUTHORING_HOLD_WORDS, describeOffer, EMPTY_OFFER_FORM, formFromOffer, holdWords, termsFromForm, type OfferForm } from './offerAuthoring';
import { programOffer, PURCHASE_HOLD_EXPLANATIONS, PURCHASE_HOLD_REASONS, type ProgramOffer } from '@/contracts/programOffers';
import { funnelTextIssue } from '@/funnels/schema';

/**
 * The offer editor's controller: typed input becomes an exact command or a named problem; nothing
 * is assumed for the practitioner; and an offer is described in words that say what is missing.
 */
const id = (n: number) => '80000000-0000-4000-8000-' + String(n).padStart(12, '0');
const form = (over: Partial<OfferForm> = {}): OfferForm => ({ ...EMPTY_OFFER_FORM, name: 'Fictional program', ...over });
const offer = (over: Record<string, unknown> = {}): ProgramOffer => programOffer.parse(Object.fromEntries(Object.entries({
  contract: 'program-offer/1', offerId: id(1), organizationId: id(2), programId: id(3), curriculum: { versionId: id(4), version: 2, sourceDigest: 'a'.repeat(64) },
  revision: 3, state: 'draft', name: 'Fictional program', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90, authoredBy: id(5), authoredAt: '2026-10-11T12:00:00Z',
  mode: 'paid', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPrice: { provider: 'stripe', mode: 'test', priceRef: 'price_FictionalAbc123', approval: { by: id(5), at: '2026-10-11T12:00:00Z' } }, ...over,
}).filter(([, value]) => value !== undefined)));

describe('from the form to the command', () => {
  it('converts a complete paid form exactly', () => {
    expect(termsFromForm(form({ amount: '19.99', billing: 'one_time', providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: '90' })))
      .toEqual({ ok: true, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90 } });
    expect(termsFromForm(form({ amount: '49', billing: 'monthly' }))).toMatchObject({ ok: true, terms: { pricing: { amountMinor: 4900, billing: { kind: 'recurring', interval: 'month', intervalCount: 1 } }, providerPriceRef: null, accessTermsVersion: null, accessDurationDays: null } });
    expect(termsFromForm(form({ amount: '120', billing: 'yearly' }))).toMatchObject({ ok: true, terms: { pricing: { billing: { kind: 'recurring', interval: 'year', intervalCount: 1 } } } });
  });
  it('saves a paid draft with no pricing at all, which is a draft and not a free offer', () => {
    expect(termsFromForm(form())).toEqual({ ok: true, terms: { mode: 'paid', name: 'Fictional program', pricing: null, providerPriceRef: null, accessTermsVersion: null, accessDurationDays: null } });
  });
  it.each<[string, Partial<OfferForm>, RegExp]>([
    ['an amount without a billing mode', { amount: '19.99' }, /Choose how the program is billed/],
    ['a billing mode without an amount', { billing: 'one_time' }, /exact amount/],
    ['a zero amount', { amount: '0', billing: 'one_time' }, /zero and negative/],
    ['a negative amount', { amount: '-5', billing: 'one_time' }, /exact amount/],
    ['too many decimals', { amount: '19.999', billing: 'one_time' }, /exact amount/],
    ['garbage', { amount: 'nineteen', billing: 'one_time' }, /exact amount/],
    ['a reference in the wrong shape', { providerPriceRef: 'prod_123' }, /price_ followed by/],
    ['a live-looking reference', { providerPriceRef: 'price_live_x' }, /price_ followed by/],
    ['a terms version nobody recorded', { accessTermsVersion: 'v1' }, /not a recorded terms version/],
    ['a fractional duration', { accessDurationDays: '1.5' }, /whole days/],
    ['a zero duration', { accessDurationDays: '0' }, /whole days/],
    ['no name', { name: '  ' }, /Give the offer a name/],
    ['a complimentary offer with no reason', { mode: 'complimentary', reason: 'short' }, /written reason/],
  ])('refuses %s with a named problem and never a default', (_name, over, problem) => {
    const outcome = termsFromForm(form(over));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.problems.join(' ')).toMatch(problem);
  });
  it('builds a complimentary command only with its reason, and never carries pricing', () => {
    expect(termsFromForm(form({ mode: 'complimentary', reason: 'Fictional authorized reason for review', amount: '19.99', billing: 'one_time' })))
      .toEqual({ ok: true, terms: { mode: 'complimentary', name: 'Fictional program', reason: 'Fictional authorized reason for review', accessTermsVersion: null, accessDurationDays: null } });
  });
  it('round-trips a stored offer into the form', () => {
    expect(formFromOffer(offer())).toEqual({ ...EMPTY_OFFER_FORM, name: 'Fictional program', amount: '19.99', currency: 'USD', billing: 'one_time', providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: '90' });
    expect(formFromOffer(offer({ pricing: { currency: 'USD', amountMinor: 4900, billing: { kind: 'recurring', interval: 'month', intervalCount: 1 } } }))).toMatchObject({ amount: '49.00', billing: 'monthly' });
    expect(formFromOffer(offer({ pricing: null, providerPrice: null, accessTermsVersion: null, accessDurationDays: null }))).toMatchObject({ amount: '', billing: '', providerPriceRef: '', accessTermsVersion: '', accessDurationDays: '' });
    expect(formFromOffer(offer({ mode: 'complimentary', pricing: undefined, providerPrice: undefined, authorization: { authorizedBy: id(5), authorizedAt: '2026-10-11T12:00:00Z', reason: 'Fictional authorized reason for review' } }))).toMatchObject({ mode: 'complimentary', reason: 'Fictional authorized reason for review', amount: '' });
  });
});

describe('describing an offer', () => {
  const current = { versionId: id(4), version: 2, sourceDigest: 'a'.repeat(64) };
  it('says the terms, the binding and the state, and whether a visitor could buy it now', () => {
    const published = describeOffer(offer({ state: 'published' }), current);
    expect(published.line).toBe('Fictional program: 19.99 USD, one payment; 90 days of access; bound to version 2; revision 3; published.');
    expect(published).toMatchObject({ purchasable: true, holds: [] });
    expect(describeOffer(offer(), current)).toMatchObject({ purchasable: false, holds: [] });
    expect(describeOffer(offer({ pricing: null, providerPrice: null, accessTermsVersion: null, accessDurationDays: null }), current)).toMatchObject({
      line: expect.stringContaining('no price set; access duration undecided'),
      holds: [AUTHORING_HOLD_WORDS.no_pricing, AUTHORING_HOLD_WORDS.provider_mapping_missing, AUTHORING_HOLD_WORDS.no_access_terms],
    });
    expect(describeOffer(offer({ providerPrice: { provider: 'stripe', mode: 'test', priceRef: 'price_FictionalAbc123', approval: null } }), current).holds).toEqual([AUTHORING_HOLD_WORDS.provider_mapping_unapproved]);
    expect(describeOffer(offer({ state: 'published' }), { ...current, sourceDigest: 'b'.repeat(64) })).toMatchObject({ purchasable: false, holds: [AUTHORING_HOLD_WORDS.curriculum_changed] });
    expect(describeOffer(offer({ state: 'published' }), null)).toMatchObject({ purchasable: false, holds: [AUTHORING_HOLD_WORDS.curriculum_unpublished] });
    expect(describeOffer(offer({ mode: 'complimentary', pricing: undefined, providerPrice: undefined, state: 'published', authorization: { authorizedBy: id(5), authorizedAt: '2026-10-11T12:00:00Z', reason: 'Fictional authorized reason for review' } }), current)).toMatchObject({ purchasable: false, line: expect.stringContaining('complimentary, authorized with a recorded reason') });
  });
  it('has words for every ledger refusal and every visitor hold, none of them inventing a term', () => {
    for (const category of ['request_invalid', 'program_not_found', 'offer_not_found', 'revision_stale', 'state_invalid', 'curriculum_unpublished', 'curriculum_changed', 'publish_refused', 'identity_refused', 'activation_refused', 'service_unavailable', 'commerce_disabled', 'commerce_unverifiable', 'another_offer_published']) {
      if (category === 'publish_refused') continue;
      expect(AUTHORING_HOLD_WORDS[category], category).toBeDefined();
    }
    expect(holdWords(['no_pricing', 'something_new'])).toEqual([AUTHORING_HOLD_WORDS.no_pricing, 'Refused: something_new.']);
    for (const reason of PURCHASE_HOLD_REASONS) expect(funnelTextIssue(PURCHASE_HOLD_EXPLANATIONS[reason]), reason).toBeNull();
    for (const text of Object.values(AUTHORING_HOLD_WORDS)) expect(text).not.toMatch(/\$\d|free of charge|lifetime|refund/i);
  });
});
