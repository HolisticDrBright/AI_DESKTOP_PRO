import {
  formatAmount, offerTerms, parseMajorAmount, SUPPORTED_CURRENCIES, PURCHASE_HOLD_EXPLANATIONS,
  type CurriculumBinding, type OfferPricing, type OfferTerms, type ProgramOffer, type PurchaseHoldReason,
} from '@/contracts/programOffers';

/**
 * The offer editor's controller: pure functions from what the practitioner typed to the command the
 * contract admits, and from what the ledger holds to the words the editor shows. Nothing here reads
 * a service or keeps state; the component owns the form and the request.
 *
 * Every choice is explicit. The billing mode starts unset and the form refuses to submit until one
 * is chosen; the amount is converted exactly or refused; a reference is admitted only in the typed
 * shape; and a draft may be saved with pricing left empty, which is a draft that cannot publish, not
 * a free offer.
 */
export type OfferForm = {
  mode: 'paid' | 'complimentary';
  name: string;
  /** Typed in major units ("19.99"); empty means no pricing yet. */
  amount: string;
  currency: (typeof SUPPORTED_CURRENCIES)[number];
  billing: '' | 'one_time' | 'monthly' | 'yearly';
  providerPriceRef: string;
  accessTermsVersion: string;
  accessDurationDays: string;
  reason: string;
};
export const EMPTY_OFFER_FORM: OfferForm = { mode: 'paid', name: '', amount: '', currency: 'USD', billing: '', providerPriceRef: '', accessTermsVersion: '', accessDurationDays: '', reason: '' };

export type FormOutcome = { ok: true; terms: OfferTerms } | { ok: false; problems: string[] };

export function termsFromForm(form: OfferForm): FormOutcome {
  const problems: string[] = [];
  const name = form.name.trim();
  if (!name) problems.push('Give the offer a name.');
  const accessTermsVersion = form.accessTermsVersion.trim() === '' ? null : form.accessTermsVersion.trim();
  if (accessTermsVersion !== null && !/^education-access-terms\/[1-9][0-9]{0,3}$/.test(accessTermsVersion)) problems.push('The access terms version is not a recorded terms version.');
  let accessDurationDays: number | null = null;
  if (form.accessDurationDays.trim() !== '') {
    accessDurationDays = /^\d{1,4}$/.test(form.accessDurationDays.trim()) ? Number(form.accessDurationDays.trim()) : Number.NaN;
    if (!Number.isInteger(accessDurationDays) || accessDurationDays < 1 || accessDurationDays > 3650) problems.push('Access duration is whole days, between 1 and 3650, or left empty while undecided.');
  }
  if (form.mode === 'complimentary') {
    if (form.reason.trim().length < 10) problems.push('Complimentary access needs a written reason of at least ten characters.');
    if (problems.length) return { ok: false, problems };
    const parsed = offerTerms.safeParse({ mode: 'complimentary', name, reason: form.reason.trim(), accessTermsVersion, accessDurationDays });
    return parsed.success ? { ok: true, terms: parsed.data } : { ok: false, problems: ['The terms could not be read as a complimentary offer.'] };
  }
  const amountTyped = form.amount.trim() !== '';
  const billingTyped = form.billing !== '';
  let pricing: OfferPricing | null = null;
  if (amountTyped || billingTyped) {
    const amountMinor = parseMajorAmount(form.amount, form.currency);
    if (amountMinor === null) problems.push('Enter the price as an exact amount in the currency (for example 19.99); zero and negative amounts are not prices.');
    if (!billingTyped) problems.push('Choose how the program is billed: one payment, monthly or yearly. No billing mode is assumed.');
    if (amountMinor !== null && billingTyped) {
      pricing = { currency: form.currency, amountMinor, billing: form.billing === 'one_time' ? { kind: 'one_time' } : { kind: 'recurring', interval: form.billing === 'monthly' ? 'month' : 'year', intervalCount: 1 } };
    }
  }
  const providerPriceRef = form.providerPriceRef.trim() === '' ? null : form.providerPriceRef.trim();
  if (providerPriceRef !== null && !/^price_[A-Za-z0-9]{8,64}$/.test(providerPriceRef)) problems.push('The processor price reference is not in the admitted shape (price_ followed by letters and digits).');
  if (problems.length) return { ok: false, problems };
  const parsed = offerTerms.safeParse({ mode: 'paid', name, pricing, providerPriceRef, accessTermsVersion, accessDurationDays });
  return parsed.success ? { ok: true, terms: parsed.data } : { ok: false, problems: ['The terms could not be read as a paid offer.'] };
}

export function formFromOffer(offer: ProgramOffer): OfferForm {
  const shared = { name: offer.name, accessTermsVersion: offer.accessTermsVersion ?? '', accessDurationDays: offer.accessDurationDays === null ? '' : String(offer.accessDurationDays) };
  if (offer.mode === 'complimentary') return { ...EMPTY_OFFER_FORM, ...shared, mode: 'complimentary', reason: offer.authorization.reason };
  const pricing = offer.pricing;
  return {
    ...EMPTY_OFFER_FORM, ...shared, mode: 'paid',
    amount: pricing ? formatAmount(pricing).split(' ')[0]! : '',
    currency: pricing?.currency ?? 'USD',
    billing: !pricing ? '' : pricing.billing.kind === 'one_time' ? 'one_time' : pricing.billing.interval === 'month' ? 'monthly' : 'yearly',
    providerPriceRef: offer.providerPrice?.priceRef ?? '',
  };
}

/** The holds and refusals, in the editor's words. Keys are the ledger's; the text names what is missing and never what to invent. */
export const AUTHORING_HOLD_WORDS: Record<string, string> = {
  no_pricing: 'No price is set. A paid offer publishes only with an exact amount and a billing mode.',
  provider_mapping_missing: 'No processor price reference is recorded.',
  provider_mapping_unapproved: 'The processor price reference has not been approved. Approval is a separate recorded act.',
  no_access_terms: 'No access terms version is named. None has been written yet; this is a decision for Brandon.',
  curriculum_unpublished: 'The program has no published patient-facing content to sell.',
  curriculum_changed: 'The program was published again after this offer was bound. Retire this offer and write a new one against the current version.',
  another_offer_published: 'Another offer for this program is already published. Retire it first.',
  revision_stale: 'This offer changed in another tab or session. Reload before saving again.',
  state_invalid: 'This change is not allowed in the offer\'s current state. A published offer can only be retired.',
  offer_not_found: 'This offer could not be found in this clinic.',
  program_not_found: 'This program could not be found in this clinic.',
  request_invalid: 'The terms were refused as invalid. Nothing was saved.',
  identity_refused: 'Your role in this clinic does not allow offer authoring.',
  activation_refused: 'Program commerce is not activated for this deployment.',
  commerce_disabled: 'Program commerce is not connected for this deployment. Offers cannot be saved here; nothing shown is a saved offer.',
  commerce_unverifiable: 'The program could not be read just now, so no offer can be bound to it. Try again.',
  service_unavailable: 'The offer service could not be reached. Nothing was saved.',
};

export function holdWords(holds: readonly string[]): string[] {
  return holds.map(hold => AUTHORING_HOLD_WORDS[hold] ?? `Refused: ${hold}.`);
}

export type OfferSummary = { line: string; state: ProgramOffer['state']; purchasable: boolean; holds: string[] };

/** One line per offer for the editor's list, and whether a visitor could buy it now against the program as it is. */
export function describeOffer(offer: ProgramOffer, current: CurriculumBinding | null): OfferSummary {
  const terms = offer.mode === 'complimentary'
    ? `complimentary, authorized with a recorded reason`
    : offer.pricing ? formatAmount(offer.pricing) : 'no price set';
  const duration = offer.accessDurationDays === null ? 'access duration undecided' : `${offer.accessDurationDays} days of access`;
  const holds: string[] = [];
  if (offer.state === 'draft') {
    if (offer.mode === 'paid') {
      if (!offer.pricing) holds.push('no_pricing');
      if (!offer.providerPrice) holds.push('provider_mapping_missing');
      else if (!offer.providerPrice.approval) holds.push('provider_mapping_unapproved');
    }
    if (!offer.accessTermsVersion) holds.push('no_access_terms');
  }
  if (!current) holds.push('curriculum_unpublished');
  else if (current.versionId !== offer.curriculum.versionId || current.sourceDigest !== offer.curriculum.sourceDigest) holds.push('curriculum_changed');
  const purchasable = offer.state === 'published' && offer.mode === 'paid' && holds.length === 0;
  return { line: `${offer.name}: ${terms}; ${duration}; bound to version ${offer.curriculum.version}; revision ${offer.revision}; ${offer.state}.`, state: offer.state, purchasable, holds: holdWords(holds) };
}

/** The visitor-facing explanation for a hold, so the editor shows what a visitor would read. */
export function visitorExplanation(reason: PurchaseHoldReason): string { return PURCHASE_HOLD_EXPLANATIONS[reason]; }
