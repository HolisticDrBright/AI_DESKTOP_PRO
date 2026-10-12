import { z } from 'zod';
import { curriculumBinding, offerPricing } from './programOffers';

/**
 * The program checkout contract (program-checkout/2): one order per purchase attempt, admitted
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
 *
 * Revision 2 (reliability work package 1) adds what recovery needs and nothing commercial:
 *   - the complete outbound creation request is recorded on the order (`creation`) BEFORE the
 *     processor is contacted, with its exact parameter digest, the destinations and the expiry it
 *     names; every replay sends those saved bytes under the same key, never fresh clock-derived
 *     fields, and an unknown outcome beyond the processor's idempotency retention is a visible
 *     `creation_unreconciled` hold, never a second key;
 *   - a completed checkout whose payment is still processing is `payment_processing`, not failed;
 *     it settles from the retrieved object (payment intent status), never from event arrival order;
 *   - an observation that contradicts a decided order is a visible `conflict` intake, never
 *     silently dropped and never applied.
 */
export const PROGRAM_CHECKOUT_CONTRACT = 'program-checkout/2' as const;
const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const ORDER_STATES = ['admitted', 'creation_pending', 'creation_unresolved', 'creation_unreconciled', 'checkout_open', 'payment_processing', 'checkout_expired', 'checkout_cancelled', 'payment_verified', 'payment_failed', 'refused'] as const;
export type OrderState = (typeof ORDER_STATES)[number];
/** Orders a returning browser's attempt key still owns: another start answers these instead of admitting a second order. */
export const OPEN_ORDER_STATES = ['admitted', 'creation_pending', 'creation_unresolved', 'creation_unreconciled', 'checkout_open'] as const satisfies readonly OrderState[];
/**
 * Every transition the order may make; anything else is refused by both ledgers.
 *   admitted               the terms snapshot is durable; nothing has left
 *   creation_pending       the exact creation request is durable; it may now be sent, and only it
 *   creation_unresolved    the request was sent and its outcome is unknown (timeout, lost reply, 5xx)
 *   creation_unreconciled  the outcome is still unknown and the processor can no longer prove it; operator hold
 *   checkout_open          a session bound to the saved request exists
 *   payment_processing     the session completed and its payment is still processing (delayed method)
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  admitted: ['creation_pending', 'refused'],
  creation_pending: ['checkout_open', 'creation_unresolved', 'refused'],
  creation_unresolved: ['checkout_open', 'creation_unreconciled', 'checkout_expired', 'refused'],
  creation_unreconciled: ['checkout_open', 'checkout_expired', 'refused'],
  checkout_open: ['checkout_expired', 'checkout_cancelled', 'payment_processing', 'payment_verified', 'payment_failed'],
  payment_processing: ['payment_verified', 'payment_failed'],
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

/**
 * The complete outbound creation request, recorded before the processor is contacted. `request` is
 * exactly what the processor receives (form fields in this order); `requestSha256` is the digest of
 * its canonical encoding, so a replay can prove it sent the same bytes. The processor learns the
 * price reference, the opaque order id and the two return addresses, and nothing else.
 */
export const checkoutCreationRequest = z.object({
  mode: z.enum(['payment', 'subscription']),
  priceRef: z.string().regex(/^price_[A-Za-z0-9]{8,64}$/),
  quantity: z.literal(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  clientReferenceId: uuid,
  metadataOrderId: uuid,
  /** Whole seconds since the epoch: the processor's own unit, so nothing is rounded on replay. */
  expiresAtUnix: z.number().int().positive(),
}).strict();
export type CheckoutCreationRequest = z.infer<typeof checkoutCreationRequest>;
export const checkoutCreation = z.object({
  idempotencyKey: z.string().regex(/^program-order:[0-9a-f-]{36}$/),
  request: checkoutCreationRequest,
  requestSha256: sha256,
  recordedAt: timestamp,
}).strict();
export type CheckoutCreation = z.infer<typeof checkoutCreation>;
/** The canonical encoding the processor receives and the digest is taken over: fixed key order, form-encoded. */
export function encodeCreationRequest(request: CheckoutCreationRequest): string {
  const form = new URLSearchParams();
  form.append('mode', request.mode);
  form.append('line_items[0][price]', request.priceRef);
  form.append('line_items[0][quantity]', String(request.quantity));
  form.append('success_url', request.successUrl);
  form.append('cancel_url', request.cancelUrl);
  form.append('client_reference_id', request.clientReferenceId);
  form.append('metadata[order_id]', request.metadataOrderId);
  form.append('expires_at', String(request.expiresAtUnix));
  return form.toString();
}

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
  /** The exact creation request, recorded before the processor was contacted; null only while `admitted` or `refused` before it. */
  creation: checkoutCreation.nullable(),
  processor: processorBinding.nullable(),
  verification: paymentVerification.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();
export type ProgramOrder = z.infer<typeof programOrder>;

/* ------------------------------------------------------------------ intake */

export const HANDLED_EVENT_TYPES = ['checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'] as const;
/** `conflict`: an authoritative observation contradicts a decided order; held for an operator, never applied. */
export const INTAKE_STATES = ['pending', 'processed', 'unhandled', 'refused', 'failed_retryable', 'exhausted', 'conflict'] as const;
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

export const CHECKOUT_HOLD_REASONS = ['checkout_unconfigured', 'return_origin_unconfigured', 'processor_unavailable', 'processor_refused', 'order_store_unavailable', 'attempt_in_progress', 'checkout_unconfirmed'] as const;
export type CheckoutHoldReason = (typeof CHECKOUT_HOLD_REASONS)[number];
export const CHECKOUT_HOLD_EXPLANATIONS: Record<CheckoutHoldReason, string> = {
  checkout_unconfigured: 'Online payment is not set up for this site.',
  return_origin_unconfigured: 'Online payment is not set up for this site.',
  processor_unavailable: 'The payment service could not be reached. Nothing was charged. Please try again later.',
  processor_refused: 'The payment service did not accept the request. Nothing was charged.',
  order_store_unavailable: 'The purchase could not be recorded. Nothing was charged. Please try again later.',
  attempt_in_progress: 'A checkout you already started is still open. Please finish or wait for it to expire.',
  checkout_unconfirmed: 'A checkout you started could not be confirmed by the payment service. It has been held for review and cannot take a payment.',
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

/** The whole of what the processor is told about an order: the saved creation, sent as recorded. */
export type ProcessorSessionRequest = CheckoutCreation;

/** Payment intent statuses as the processor reports them for a payment-mode session; null where the processor returned none. */
export const PAYMENT_INTENT_STATUSES = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'canceled', 'succeeded'] as const;
export const processorSession = z.object({
  sessionRef,
  /** The hosted page address; null when the processor returned none (a completed or expired session has none). Never filled in here. */
  url: z.string().url().refine(value => value.startsWith('https://'), 'checkout url is https').nullable(),
  expiresAt: timestamp,
  status: z.enum(['open', 'complete', 'expired']),
  paymentStatus: z.enum(['paid', 'unpaid', 'no_payment_required']),
  paymentIntentStatus: z.enum(PAYMENT_INTENT_STATUSES).nullable(),
  successUrl: z.string().nullable(),
  cancelUrl: z.string().nullable(),
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
export const VERIFICATION_REFUSALS = ['session_mismatch', 'order_mismatch', 'amount_mismatch', 'currency_mismatch', 'mode_mismatch', 'livemode', 'account_mismatch', 'price_mismatch', 'return_mismatch', 'expiry_mismatch', 'unknown_payment_status', 'no_creation_record'] as const;
export type VerificationRefusal = (typeof VERIFICATION_REFUSALS)[number];

/**
 * The one binding every session must pass before it is recorded, redirected to or believed: the
 * account the processor credential proved (not a configured label), test mode, the saved order and
 * session identity, exactly one line of the saved price, the snapshot's amount, currency and billing
 * mode, and the return addresses and expiry the saved creation request named. `sessionRef` is null
 * when a new session is being bound to an order that has none yet.
 */
export function verifySessionAgainstOrder(session: ProcessorSession, order: ProgramOrder, provenAccount: string): { ok: true } | { ok: false; refusal: VerificationRefusal } {
  if (!order.creation) return { ok: false, refusal: 'no_creation_record' };
  if (order.processor && session.sessionRef !== order.processor.sessionRef) return { ok: false, refusal: 'session_mismatch' };
  if (session.clientReferenceId !== order.orderId || session.metadata.order_id !== order.orderId || Object.keys(session.metadata).some(key => key !== 'order_id')) return { ok: false, refusal: 'order_mismatch' };
  if (session.livemode) return { ok: false, refusal: 'livemode' };
  if (session.accountRef !== provenAccount) return { ok: false, refusal: 'account_mismatch' };
  const expectedMode = order.pricing.billing.kind === 'one_time' ? 'payment' : 'subscription';
  if (session.mode !== expectedMode || order.creation.request.mode !== expectedMode) return { ok: false, refusal: 'mode_mismatch' };
  if (session.currency !== order.pricing.currency.toLowerCase()) return { ok: false, refusal: 'currency_mismatch' };
  if (session.amountTotal !== order.pricing.amountMinor) return { ok: false, refusal: 'amount_mismatch' };
  if (session.priceRefs.length !== 1 || session.priceRefs[0] !== order.providerPriceRef) return { ok: false, refusal: 'price_mismatch' };
  if (session.successUrl !== order.creation.request.successUrl || session.cancelUrl !== order.creation.request.cancelUrl) return { ok: false, refusal: 'return_mismatch' };
  if (Math.floor(Date.parse(session.expiresAt) / 1000) !== order.creation.request.expiresAtUnix) return { ok: false, refusal: 'expiry_mismatch' };
  if (!['paid', 'unpaid'].includes(session.paymentStatus)) return { ok: false, refusal: 'unknown_payment_status' };
  return { ok: true };
}

/** A session a browser may be sent to: bound, open, unexpired, with an address on one of the processor's own checkout hosts. */
export function redirectableCheckout(session: ProcessorSession, order: ProgramOrder, provenAccount: string, checkoutHosts: readonly string[], now: Date): { ok: true; url: string; expiresAt: string } | { ok: false; refusal: VerificationRefusal | 'not_open' | 'expired' | 'no_address' | 'foreign_address' } {
  const bound = verifySessionAgainstOrder(session, order, provenAccount);
  if (!bound.ok) return bound;
  if (session.status !== 'open') return { ok: false, refusal: 'not_open' };
  if (Date.parse(session.expiresAt) <= now.getTime()) return { ok: false, refusal: 'expired' };
  if (!session.url) return { ok: false, refusal: 'no_address' };
  let url: URL;
  try { url = new URL(session.url); } catch { return { ok: false, refusal: 'foreign_address' }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !checkoutHosts.includes(url.hostname)) return { ok: false, refusal: 'foreign_address' };
  return { ok: true, url: url.toString(), expiresAt: session.expiresAt };
}

/**
 * What the retrieved object says happened, independent of which event asked: open, expired,
 * verified (complete and paid), processing (complete, unpaid, the payment not decided), or failed
 * (complete, unpaid, and the payment intent says it will not succeed). A generic unpaid status is
 * never a grant and never, on its own, a failure.
 */
export type PaymentObservation = 'open' | 'expired' | 'verified' | 'processing' | 'failed';
export function observePayment(session: ProcessorSession): PaymentObservation {
  if (session.status === 'open') return 'open';
  if (session.status === 'expired') return 'expired';
  if (session.paymentStatus === 'paid') return session.paymentIntentStatus === null || session.paymentIntentStatus === 'succeeded' ? 'verified' : 'processing';
  if (session.paymentIntentStatus === 'requires_payment_method' || session.paymentIntentStatus === 'canceled') return 'failed';
  return 'processing';
}
