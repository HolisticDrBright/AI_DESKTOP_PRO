import { z } from 'zod';

/**
 * The program offer contract (program-offer/1): what a clinic sells when it sells a built program.
 *
 * An offer is a versioned commercial record bound to one organization, one program and the EXACT
 * published curriculum version it was priced against (version id, number and the source digest the
 * assignment service computes over the patient-facing phases). A slug or a display name is not a
 * product identity, and neither is a program id alone: a program whose published version changes
 * after the offer was written is a different thing from what was priced, and the offer says so.
 *
 * Money is an integer count of minor units in one explicitly supported currency, with an explicit
 * billing mode. Nothing here invents a recurring frequency, a lifetime term, a refund policy or an
 * access duration: a term that was not written is absent, and an absent term makes the offer not
 * purchasable, never purchasable on a default.
 *
 * Two modes exist and they are different intentions, chosen by name: `paid`, which needs explicit
 * positive pricing and an approved processor mapping before anyone may buy; and `complimentary`,
 * which needs an authorizer and a written reason. Malformed paid input is refused as invalid; it
 * never lands as complimentary, free, zero or open. This module decides shape and purchasability
 * only; it reads no table and performs no payment.
 */
export const PROGRAM_OFFER_CONTRACT = 'program-offer/1' as const;

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);

/** The currencies this contract admits. Adding one is a reviewed change, not a free-text field. */
export const SUPPORTED_CURRENCIES = ['USD'] as const;
/** Largest amount admitted, in minor units: 10,000.00 in a two-decimal currency. Above it is a typo or an attack, not a price. */
export const MAX_AMOUNT_MINOR = 1_000_000;
/** Minor units per major unit for every supported currency; the authoring form converts with this and nothing else. */
export const MINOR_UNITS_PER_MAJOR: Record<(typeof SUPPORTED_CURRENCIES)[number], number> = { USD: 100 };

export const offerBilling = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('one_time') }).strict(),
  /** A recurring charge is a decision with an interval; there is no default interval. */
  z.object({ kind: z.literal('recurring'), interval: z.enum(['month', 'year']), intervalCount: z.number().int().min(1).max(12) }).strict(),
]);
export type OfferBilling = z.infer<typeof offerBilling>;

export const offerPricing = z.object({
  currency: z.enum(SUPPORTED_CURRENCIES),
  /** Integer minor units, strictly positive. A paid offer at zero is not a price; a complimentary offer carries no pricing at all. */
  amountMinor: z.number().int().min(1).max(MAX_AMOUNT_MINOR),
  billing: offerBilling,
}).strict();
export type OfferPricing = z.infer<typeof offerPricing>;

/** The processor price this offer charges through. The reference alone is a string somebody typed; the approval is a separate recorded act. */
export const providerPriceMapping = z.object({
  provider: z.literal('stripe'),
  /** Test mode only in this source. A live mapping is refused by shape. */
  mode: z.literal('test'),
  priceRef: z.string().regex(/^price_[A-Za-z0-9]{8,64}$/),
  approval: z.object({ by: uuid, at: timestamp }).strict().nullable(),
}).strict();
export type ProviderPriceMapping = z.infer<typeof providerPriceMapping>;

export const curriculumBinding = z.object({
  versionId: uuid,
  version: z.number().int().min(1),
  /** The digest the assignment service computes over the published patient-facing phases. */
  sourceDigest: digest,
}).strict();
export type CurriculumBinding = z.infer<typeof curriculumBinding>;

export const complimentaryAuthorization = z.object({
  authorizedBy: uuid,
  authorizedAt: timestamp,
  reason: z.string().trim().min(10).max(600),
}).strict();

export const OFFER_STATES = ['draft', 'published', 'retired'] as const;
export type OfferState = (typeof OFFER_STATES)[number];

const base = {
  contract: z.literal(PROGRAM_OFFER_CONTRACT),
  offerId: uuid,
  organizationId: uuid,
  programId: uuid,
  curriculum: curriculumBinding,
  /** Raised by every change; a command naming an older revision is stale and is refused. */
  revision: z.number().int().min(1),
  state: z.enum(OFFER_STATES),
  name: text(120),
  /** The version of the access terms the purchaser agrees to. None exists yet; purchase needs one. */
  accessTermsVersion: z.string().regex(/^education-access-terms\/[1-9][0-9]{0,3}$/).nullable(),
  /** Access duration in days, or null meaning no duration has been decided. Null is not "forever". */
  accessDurationDays: z.number().int().min(1).max(3650).nullable(),
  authoredBy: uuid,
  authoredAt: timestamp,
};

export const programOffer = z.discriminatedUnion('mode', [
  z.object({ ...base, mode: z.literal('paid'), pricing: offerPricing.nullable(), providerPrice: providerPriceMapping.nullable() }).strict(),
  z.object({ ...base, mode: z.literal('complimentary'), authorization: complimentaryAuthorization }).strict(),
]).superRefine((offer, ctx) => {
  if (offer.state === 'published' && offer.mode === 'paid') {
    if (!offer.pricing) ctx.addIssue({ code: 'custom', message: 'a published paid offer carries explicit pricing' });
    if (!offer.providerPrice?.approval) ctx.addIssue({ code: 'custom', message: 'a published paid offer carries an approved provider mapping' });
    if (!offer.accessTermsVersion) ctx.addIssue({ code: 'custom', message: 'a published offer names its access terms version' });
  }
});
export type ProgramOffer = z.infer<typeof programOffer>;

/* --------------------------------------------------------------- commands */

/** What authoring may write. Everything else about the offer is set by the ledger from who asked and what the program says. */
export const offerTerms = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('paid'),
    name: text(120),
    pricing: offerPricing.nullable(),
    providerPriceRef: z.string().regex(/^price_[A-Za-z0-9]{8,64}$/).nullable(),
    accessTermsVersion: base.accessTermsVersion,
    accessDurationDays: base.accessDurationDays,
  }).strict(),
  z.object({
    mode: z.literal('complimentary'),
    name: text(120),
    reason: z.string().trim().min(10).max(600),
    accessTermsVersion: base.accessTermsVersion,
    accessDurationDays: base.accessDurationDays,
  }).strict(),
]);
export type OfferTerms = z.infer<typeof offerTerms>;

export const programOfferCommand = z.discriminatedUnion('action', [
  /** Create a draft for a program against its CURRENT published curriculum, which the ledger reads; the caller cannot name a version. */
  z.object({ action: z.literal('create'), programId: uuid, terms: offerTerms }).strict(),
  /** Rewrite a draft's terms at a known revision; a newer revision refuses. */
  z.object({ action: z.literal('revise'), offerId: uuid, expectedRevision: z.number().int().min(1), terms: offerTerms }).strict(),
  /** Record the approval of the typed provider price by the person asking; a second person is not required by this contract, which is a decision named in the doc. */
  z.object({ action: z.literal('approve_provider_mapping'), offerId: uuid, expectedRevision: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal('publish'), offerId: uuid, expectedRevision: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal('retire'), offerId: uuid, expectedRevision: z.number().int().min(1), reason: z.string().trim().min(1).max(600) }).strict(),
  z.object({ action: z.literal('list'), programId: uuid }).strict(),
]);
export type ProgramOfferCommand = z.infer<typeof programOfferCommand>;

/** What the ledger answers a command with; shared with the browser facade as a type only. */
export type ProgramOfferResult =
  | { action: 'create' | 'revise' | 'approve_provider_mapping' | 'publish' | 'retire'; offer: ProgramOffer }
  | { action: 'list'; offers: ProgramOffer[]; curriculum: CurriculumBinding | null };

/* ----------------------------------------------------------- availability */

export const PURCHASE_HOLD_REASONS = [
  'offer_absent', 'offer_draft', 'offer_retired', 'complimentary_mode', 'no_pricing', 'provider_mapping_missing', 'provider_mapping_unapproved',
  'no_access_terms', 'curriculum_unpublished', 'curriculum_changed', 'commerce_disabled', 'commerce_unverifiable', 'checkout_unconfigured', 'program_unbound',
] as const;
export type PurchaseHoldReason = (typeof PURCHASE_HOLD_REASONS)[number];

/** What a visitor is told when direct purchase is not available. Plain words, no address, no promise; checked by the funnel text rules. */
export const PURCHASE_HOLD_EXPLANATIONS: Record<PurchaseHoldReason, string> = {
  offer_absent: 'No price has been set for this program yet.',
  offer_draft: 'The price for this program is still being prepared.',
  offer_retired: 'This program is not being sold at the moment.',
  complimentary_mode: 'This program is not sold directly; access is arranged by the clinic.',
  no_pricing: 'No price has been set for this program yet.',
  provider_mapping_missing: 'Payment for this program has not been set up yet.',
  provider_mapping_unapproved: 'Payment for this program has not been approved yet.',
  no_access_terms: 'The terms of access for this program have not been written yet.',
  curriculum_unpublished: 'This program has no published content to buy yet.',
  curriculum_changed: 'This program was updated after it was priced, and the price has not been confirmed for the new version.',
  commerce_disabled: 'Direct purchase is not switched on for this site.',
  commerce_unverifiable: 'Direct purchase could not be checked just now. Please try again later.',
  checkout_unconfigured: 'Online payment is not set up for this site.',
  program_unbound: 'This page is not linked to a program that can be bought yet.',
};

export type PurchaseAvailability =
  | { available: true; offerId: string; revision: number; name: string; pricing: OfferPricing; curriculum: CurriculumBinding; accessTermsVersion: string; accessDurationDays: number | null; /** Server-side only: the approved processor price the checkout charges through. Never printed. */ providerPriceRef: string }
  | { available: false; reason: PurchaseHoldReason; explanation: string };

export const unavailable = (reason: PurchaseHoldReason): PurchaseAvailability => ({ available: false, reason, explanation: PURCHASE_HOLD_EXPLANATIONS[reason] });

/**
 * Whether this offer, as stored, may start a checkout against the program's CURRENT published curriculum.
 * The current curriculum is supplied by the caller from the program, never from the offer: an offer that
 * still names an older published version is "changed", whatever its own state says.
 */
export function purchaseAvailability(offer: ProgramOffer | null, currentCurriculum: CurriculumBinding | null): PurchaseAvailability {
  if (!offer) return unavailable('offer_absent');
  if (offer.state === 'retired') return unavailable('offer_retired');
  if (offer.state === 'draft') return unavailable('offer_draft');
  if (offer.mode === 'complimentary') return unavailable('complimentary_mode');
  if (!offer.pricing) return unavailable('no_pricing');
  if (!offer.providerPrice) return unavailable('provider_mapping_missing');
  if (!offer.providerPrice.approval) return unavailable('provider_mapping_unapproved');
  if (!offer.accessTermsVersion) return unavailable('no_access_terms');
  if (!currentCurriculum) return unavailable('curriculum_unpublished');
  if (currentCurriculum.versionId !== offer.curriculum.versionId || currentCurriculum.version !== offer.curriculum.version || currentCurriculum.sourceDigest !== offer.curriculum.sourceDigest) {
    return unavailable('curriculum_changed');
  }
  return { available: true, offerId: offer.offerId, revision: offer.revision, name: offer.name, pricing: offer.pricing, curriculum: offer.curriculum, accessTermsVersion: offer.accessTermsVersion, accessDurationDays: offer.accessDurationDays, providerPriceRef: offer.providerPrice.priceRef };
}

/** Money for people: "19.99 USD". The only place a minor-unit amount becomes a decimal, and it never parses one. */
export function formatAmount(pricing: OfferPricing): string {
  const per = MINOR_UNITS_PER_MAJOR[pricing.currency];
  const major = Math.floor(pricing.amountMinor / per);
  const minor = String(pricing.amountMinor % per).padStart(String(per).length - 1, '0');
  const amount = `${major}.${minor} ${pricing.currency}`;
  if (pricing.billing.kind === 'one_time') return `${amount}, one payment`;
  const unit = pricing.billing.intervalCount === 1 ? pricing.billing.interval : `${pricing.billing.intervalCount} ${pricing.billing.interval}s`;
  return `${amount} every ${unit}`;
}

/**
 * The authoring form's one conversion: a typed decimal amount to integer minor units, or null when the text
 * is not an exact amount in the currency (no rounding, no clamping, no coercion of blank or garbage to 0).
 */
export function parseMajorAmount(text: string, currency: (typeof SUPPORTED_CURRENCIES)[number]): number | null {
  const per = MINOR_UNITS_PER_MAJOR[currency];
  const places = String(per).length - 1;
  const match = new RegExp(`^\\s*(\\d{1,7})(?:\\.(\\d{1,${places}}))?\\s*$`).exec(text);
  if (!match) return null;
  const major = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(places, '0');
  const minor = major * per + Number(fraction || '0');
  if (!Number.isSafeInteger(minor) || minor < 1 || minor > MAX_AMOUNT_MINOR) return null;
  return minor;
}
