import { z } from 'zod';
import { curriculumBinding, offerPricing, type OfferPricing } from './programOffers';

/**
 * The program checkout contract (program-checkout/1): one order per purchase attempt, admitted
 * durably BEFORE anything leaves for the processor, bound to the exact offer revision and curriculum
 * it was priced against, and settled only from the processor's own authoritative object.
 *
 * What a browser may say is one thing: which program page it is on. The server selects the offer,
 * the amount, the currency, the processor price and the return destinations; an order identifier is
 * opaque; the processor receives the price reference and the order id and nothing about a person's
 * health. A redirect back is not payment evidence: the order moves to `payment_verified` only after
 * the authoritative session was retrieved and every field bound to the saved order.
 *
 * Orders start unclaimed. The Desktop's public pages carry no consumer session, so a purchase is not
 * attributed to a person by an email string, an order number or a success URL; fulfilment waits for
 * a separately verified, expiring, one-time claim (unit 3). The state vocabulary here ends at
 * verification; settlement states follow in the settlement contract.
 */
export const PROGRAM_CHECKOUT_CONTRACT = 'program-checkout/1' as const;
const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const ORDER_STATES = ['admitted', 'checkout_open', 'creation_unresolved', 'checkout_expired', 'checkout_cancelled', 'payment_verified', 'payment_failed', 'refused'] as const;
export type OrderState = (typeof ORDER_STATES)[number];
/** Every transition the order may make; anything else is refused by both ledgers. */
export const ORDER_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  admitted: ['checkout_open', 'creation_unresolved', 'refused'],
  creation_unresolved: ['checkout_open', 'checkout_expired', 'refused'],
  checkout_open: ['checkout_expired', 'checkout_cancelled', 'payment_verified', 'payment_failed'],
  checkout_expired: [],
  checkout_cancelled: [],
  payment_verified: [],
  payment_failed: [],
  refused: [],
};

/** The processor session reference shape this source admits: a Stripe TEST Checkout Session only. */
export const sessionRef = z.string().regex(/^cs_test_[A-Za-z0-9]{8,200}$/);
export const accountRef = z.string().regex(/^acct_[A-Za-z0-9]{8,64}$/);

export const processorBinding = z.object({
  provider: z.literal('stripe'),
  mode: z.literal('test'),
  sessionRef,
  expiresAt: timestamp,
  /** The destinations the server chose; stored so a reply can be checked against what was asked. */
  returnSuccess: z.string().url().refine(value => value.startsWith('https://'), 'https only'),
  returnCancel: z.string().url().refine(value => value.startsWith('https://'), 'https only'),
}).strict();

export const paymentVerification = z.object({
  eventId: z.string().regex(/^[A-Za-z0-9_.:-]{3,255}$/).nullable(),
  sessionRef,
  amountMinor: z.number().int().min(0),
  currency: z.enum(['USD']),
  paymentStatus: z.enum(['paid', 'unpaid', 'no_payment_required']),
  accountRef,
  verifiedAt: timestamp,
}).strict();

export const orderSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unclaimed') }).strict(),
  z.object({ kind: z.literal('claimed'), consumerSubject: z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/), claimedAt: timestamp }).strict(),
]);

export const programOrder = z.object({
  contract: z.literal(PROGRAM_CHECKOUT_CONTRACT),
  orderId: uuid,
  organizationId: uuid,
  programId: uuid,
  offerId: uuid,
  offerRevision: z.number().int().min(1),
  /** The page the purchase started from; the return page links back to it. Never sent to the processor. */
  funnelSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
  curriculum: curriculumBinding,
  /** The terms snapshot the purchaser saw; settlement follows this, not today's offer. */
  pricing: offerPricing,
  providerPriceRef: z.string().regex(/^price_[A-Za-z0-9]{8,64}$/),
  accessTermsVersion: z.string().regex(/^education-access-terms\/[1-9][0-9]{0,3}$/),
  accessDurationDays: z.number().int().min(1).max(3650).nullable(),
  /** SHA-256 of the browser's attempt key, so a repeated start from the same browser reuses one checkout. */
  attemptKeyHash: sha256,
  subject: orderSubject,
  state: z.enum(ORDER_STATES),
  revision: z.number().int().min(1),
  processor: processorBinding.nullable(),
  verification: paymentVerification.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();
export type ProgramOrder = z.infer<typeof programOrder>;

/* ------------------------------------------------------------------ intake */

export const HANDLED_EVENT_TYPES = ['checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'] as const;
export const INTAKE_STATES = ['pending', 'processed', 'unhandled', 'refused', 'failed_retryable', 'exhausted'] as const;
export type IntakeState = (typeof INTAKE_STATES)[number];
export const MAX_INTAKE_ATTEMPTS = 8;

export const intakeRecord = z.object({
  eventId: z.string().regex(/^[A-Za-z0-9_.:-]{3,255}$/),
  eventType: z.string().regex(/^[a-z0-9_.]{3,160}$/),
  receivedAt: timestamp,
  bodySha256: sha256,
  accountRef: accountRef.nullable(),
  apiVersion: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:\.[a-z]+)?$/).nullable(),
  sessionRef: sessionRef.nullable(),
  state: z.enum(INTAKE_STATES),
  attempts: z.number().int().min(0),
  nextAttemptAt: timestamp.nullable(),
  lastOutcome: z.string().max(200).nullable(),
  orderId: uuid.nullable(),
}).strict();
export type IntakeRecord = z.infer<typeof intakeRecord>;

/* --------------------------------------------------------------- requests */

/** What a browser may send to start a checkout: which program page. Nothing else is read. */
export const checkoutStartRequest = z.object({ funnelSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/) }).strict();

export const CHECKOUT_HOLD_REASONS = ['checkout_unconfigured', 'return_origin_unconfigured', 'processor_unavailable', 'processor_refused', 'order_store_unavailable', 'attempt_in_progress'] as const;
export type CheckoutHoldReason = (typeof CHECKOUT_HOLD_REASONS)[number];
export const CHECKOUT_HOLD_EXPLANATIONS: Record<CheckoutHoldReason, string> = {
  checkout_unconfigured: 'Online payment is not set up for this site.',
  return_origin_unconfigured: 'Online payment is not set up for this site.',
  processor_unavailable: 'The payment service could not be reached. Nothing was charged. Please try again later.',
  processor_refused: 'The payment service did not accept the request. Nothing was charged.',
  order_store_unavailable: 'The purchase could not be recorded. Nothing was charged. Please try again later.',
  attempt_in_progress: 'A checkout you already started is still open. Please finish or wait for it to expire.',
};

/* --------------------------------------------------------- return addresses */

/**
 * The only return destinations a checkout may carry: the opaque return page on the configured
 * public https origin, with the order id and the outcome kind as its only query keys. The path
 * names no program, so the processor learns nothing about what was bought from the address it
 * redirects to. Anything else, from a browser or from a processor reply, is refused.
 */
export const RETURN_PATH = '/buy/return';
export function returnDestinations(origin: string, orderId: string): { success: string; cancel: string } | null {
  if (!/^https:\/\/[^/?#]+$/.test(origin) || !uuid.safeParse(orderId).success) return null;
  const base = `${origin}${RETURN_PATH}?order=${orderId}&returned=`;
  return { success: `${base}success`, cancel: `${base}cancel` };
}

export function allowedReturnUrl(candidate: string, origin: string): boolean {
  let url: URL;
  try { url = new URL(candidate); } catch { return false; }
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  if (url.pathname !== RETURN_PATH) return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes('order') || !keys.includes('returned')) return false;
  if (!uuid.safeParse(url.searchParams.get('order')).success) return false;
  return url.searchParams.get('returned') === 'success' || url.searchParams.get('returned') === 'cancel';
}

/** The whole of what the processor is told about an order. */
export type ProcessorSessionRequest = {
  orderId: string;
  providerPriceRef: string;
  pricing: OfferPricing;
  successUrl: string;
  cancelUrl: string;
  /** The idempotency key the processor deduplicates on, derived from the order and nothing else. */
  idempotencyKey: string;
  expiresAt: string;
};

export const processorSession = z.object({
  sessionRef,
  url: z.string().url().refine(value => value.startsWith('https://'), 'checkout url is https'),
  expiresAt: timestamp,
  status: z.enum(['open', 'complete', 'expired']),
  paymentStatus: z.enum(['paid', 'unpaid', 'no_payment_required']),
  mode: z.enum(['payment', 'subscription']),
  livemode: z.boolean(),
  amountTotal: z.number().int().min(0).nullable(),
  currency: z.string().regex(/^[a-z]{3}$/).nullable(),
  clientReferenceId: z.string().max(200).nullable(),
  metadata: z.record(z.string(), z.string()),
  priceRefs: z.array(z.string()),
  accountRef,
}).strict();
export type ProcessorSession = z.infer<typeof processorSession>;

/** The reasons an order fails verification against the retrieved object: each is a binding the handoff names. */
export const VERIFICATION_REFUSALS = ['session_mismatch', 'order_mismatch', 'amount_mismatch', 'currency_mismatch', 'mode_mismatch', 'livemode', 'account_mismatch', 'price_mismatch', 'return_mismatch', 'unknown_payment_status'] as const;
export type VerificationRefusal = (typeof VERIFICATION_REFUSALS)[number];

export function verifySessionAgainstOrder(session: ProcessorSession, order: ProgramOrder, expectedAccount: string): { ok: true } | { ok: false; refusal: VerificationRefusal } {
  if (!order.processor || session.sessionRef !== order.processor.sessionRef) return { ok: false, refusal: 'session_mismatch' };
  if (session.clientReferenceId !== order.orderId || session.metadata.order_id !== order.orderId || Object.keys(session.metadata).some(key => key !== 'order_id')) return { ok: false, refusal: 'order_mismatch' };
  if (session.livemode) return { ok: false, refusal: 'livemode' };
  if (session.accountRef !== expectedAccount) return { ok: false, refusal: 'account_mismatch' };
  const expectedMode = order.pricing.billing.kind === 'one_time' ? 'payment' : 'subscription';
  if (session.mode !== expectedMode) return { ok: false, refusal: 'mode_mismatch' };
  if (session.currency !== order.pricing.currency.toLowerCase()) return { ok: false, refusal: 'currency_mismatch' };
  if (session.amountTotal !== order.pricing.amountMinor) return { ok: false, refusal: 'amount_mismatch' };
  if (session.priceRefs.length !== 1 || session.priceRefs[0] !== order.providerPriceRef) return { ok: false, refusal: 'price_mismatch' };
  if (!['paid', 'unpaid'].includes(session.paymentStatus)) return { ok: false, refusal: 'unknown_payment_status' };
  return { ok: true };
}
