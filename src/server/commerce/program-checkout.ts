import { createHash } from 'node:crypto';
import {
  CHECKOUT_HOLD_EXPLANATIONS, HANDLED_EVENT_TYPES, allowedReturnUrl, returnDestinations, verifySessionAgainstOrder,
  type CheckoutHoldReason, type IntakeRecord, type ProcessorSession, type ProgramOrder,
} from '../../contracts/programCheckout';
import { PURCHASE_HOLD_EXPLANATIONS, type PurchaseHoldReason } from '../../contracts/programOffers';
import type { VerifiedEvent } from '../stripe-boundary';
import { CheckoutLedgerError, type ProgramCheckoutLedger } from './program-checkout-ledger';
import { ProcessorError, type ProgramCheckoutProcessor } from './program-checkout-processor';
import type { ProgramOfferLedger } from './program-offer-ledger';

/**
 * The program checkout boundary: from a visitor's "buy" on a funnel page to a verified payment,
 * over whichever ledger and processor the runtime selected.
 *
 * Start: the server resolves the offer and its terms itself (the browser named a page, nothing
 * more); refuses while the offer is unavailable, the public origin is unconfigured or the processor
 * is disabled; admits the order durably with its terms snapshot BEFORE creating anything outbound;
 * creates the hosted session under an idempotency key derived from the order; records the binding;
 * and answers the processor's URL. A repeated start from the same browser reuses the open order and
 * its session; a lost creation reply leaves the order `creation_unresolved`, which the next start
 * reconciles by the idempotency key rather than creating a second charge.
 *
 * Intake: an event is admitted durably by id, and acknowledged only then; processing runs after,
 * bounded, retryable and visible. Unknown event shapes are recorded `unhandled`, never fulfilled.
 * A handled event names a session; the AUTHORITATIVE session is retrieved from the processor and
 * bound to the saved order, offer, amount, currency, mode, account and price before the order moves.
 * A browser redirect never moves an order at all.
 */
export type CheckoutDependencies = {
  offers: ProgramOfferLedger;
  ledger: ProgramCheckoutLedger;
  processor: ProgramCheckoutProcessor | null;
  /** The configured public https origin, or null: return destinations exist only on it. */
  publicOrigin: string | null;
  now?: () => Date;
  /** How long a hosted session may stay open, in minutes. */
  sessionMinutes?: number;
};

export type CheckoutStart =
  | { started: true; orderId: string; checkoutUrl: string; expiresAt: string; reused: boolean }
  | { started: false; reason: PurchaseHoldReason | CheckoutHoldReason; explanation: string };

const explain = (reason: PurchaseHoldReason | CheckoutHoldReason) => (reason in CHECKOUT_HOLD_EXPLANATIONS ? CHECKOUT_HOLD_EXPLANATIONS[reason as CheckoutHoldReason] : PURCHASE_HOLD_EXPLANATIONS[reason as PurchaseHoldReason]);
const hold = (reason: PurchaseHoldReason | CheckoutHoldReason): CheckoutStart => ({ started: false, reason, explanation: explain(reason) });

export const hashAttemptKey = (attemptKey: string) => createHash('sha256').update('attempt:' + attemptKey).digest('hex');
export const idempotencyKeyFor = (orderId: string) => `program-order:${orderId}`;

export function createProgramCheckout(deps: CheckoutDependencies) {
  const now = deps.now ?? (() => new Date());
  const minutes = deps.sessionMinutes ?? 30;

  async function bindSession(order: ProgramOrder, session: ProcessorSession, origin: string): Promise<ProgramOrder> {
    const destinations = returnDestinations(origin, order.orderId)!;
    const processor = { provider: 'stripe' as const, mode: 'test' as const, sessionRef: session.sessionRef, expiresAt: session.expiresAt, returnSuccess: destinations.success, returnCancel: destinations.cancel };
    return deps.ledger.transition(order.orderId, order.revision, 'checkout_open', { processor });
  }

  /** Another start for the same browser may have opened this order meanwhile; answer with its session rather than a second one. */
  async function openedMeanwhile(orderId: string): Promise<CheckoutStart | null> {
    const current = await deps.ledger.readOrder(orderId).catch(() => null);
    if (!current || current.state !== 'checkout_open' || !current.processor) return null;
    try { const session = await deps.processor!.retrieveSession(current.processor.sessionRef); return { started: true, orderId, checkoutUrl: session.url, expiresAt: session.expiresAt, reused: true }; }
    catch { return hold('processor_unavailable'); }
  }

  async function createOrReconcile(order: ProgramOrder, origin: string): Promise<CheckoutStart> {
    const processor = deps.processor!;
    const destinations = returnDestinations(origin, order.orderId)!;
    const key = idempotencyKeyFor(order.orderId);
    let session: ProcessorSession | null = null;
    if (order.state === 'creation_unresolved') {
      try { session = await processor.findSessionByIdempotencyKey(key); } catch { return hold('processor_unavailable'); }
    }
    if (!session) {
      try {
        session = await processor.createSession({ orderId: order.orderId, providerPriceRef: order.providerPriceRef, pricing: order.pricing, successUrl: destinations.success, cancelUrl: destinations.cancel, idempotencyKey: key, expiresAt: new Date(now().getTime() + minutes * 60_000).toISOString() });
      } catch (error) {
        const failure = error instanceof ProcessorError ? error.failure : 'unavailable';
        if (failure === 'lost_response' || failure === 'timeout') {
          // The processor may hold a session for this key now; the order says so and the next start reconciles it.
          if (order.state === 'admitted') await deps.ledger.transition(order.orderId, order.revision, 'creation_unresolved').catch(() => undefined);
          return hold('processor_unavailable');
        }
        if (failure === 'refused') {
          if (order.state === 'admitted') await deps.ledger.transition(order.orderId, order.revision, 'refused').catch(() => undefined);
          return hold('processor_refused');
        }
        return hold('processor_unavailable');
      }
    }
    // The reply is checked before it is trusted: not live, our account, our order, our price, our destinations.
    if (session.livemode || session.accountRef !== processor.accountRef || session.clientReferenceId !== order.orderId || session.metadata.order_id !== order.orderId || Object.keys(session.metadata).length !== 1
      || session.priceRefs.length !== 1 || session.priceRefs[0] !== order.providerPriceRef || !allowedReturnUrl(destinations.success, origin) || !allowedReturnUrl(destinations.cancel, origin)) {
      await deps.ledger.transition(order.orderId, order.revision, 'refused').catch(() => undefined);
      return hold('processor_refused');
    }
    try {
      const bound = await bindSession(order, session, origin);
      return { started: true, orderId: bound.orderId, checkoutUrl: session.url, expiresAt: session.expiresAt, reused: false };
    } catch (error) {
      if (error instanceof CheckoutLedgerError && (error.category === 'revision_stale' || error.category === 'transition_refused')) return (await openedMeanwhile(order.orderId)) ?? hold('attempt_in_progress');
      throw error;
    }
  }

  const api = {
    /** The visitor's start: the page they are on and their browser's attempt key; everything else is the server's. */
    start: async function start(input: { funnelSlug: string; programBinding: { organizationId: string; programId: string } | null; attemptKey: string }): Promise<CheckoutStart> {
      if (!input.programBinding) return hold('program_unbound');
      if (!deps.publicOrigin) return hold('return_origin_unconfigured');
      if (!deps.processor) return hold('checkout_unconfigured');
      const availability = await deps.offers.availability(input.programBinding.organizationId, input.programBinding.programId);
      if (!availability.available) return hold(availability.reason);
      let admitted: { order: ProgramOrder; reused: boolean };
      try {
        admitted = await deps.ledger.admitOrder({ attemptKeyHash: hashAttemptKey(input.attemptKey), funnelSlug: input.funnelSlug, organizationId: input.programBinding.organizationId, programId: input.programBinding.programId, offer: availability, providerPriceRef: availability.providerPriceRef });
      } catch { return hold('order_store_unavailable'); }
      const { order, reused } = admitted;
      if (reused && order.state === 'checkout_open' && order.processor) {
        if (Date.parse(order.processor.expiresAt) <= now().getTime()) {
          await deps.ledger.transition(order.orderId, order.revision, 'checkout_expired').catch(() => undefined);
          return api.start(input);
        }
        try {
          const session = await deps.processor.retrieveSession(order.processor.sessionRef);
          if (session.status === 'open') return { started: true, orderId: order.orderId, checkoutUrl: session.url, expiresAt: session.expiresAt, reused: true };
          if (session.status === 'expired') { await deps.ledger.transition(order.orderId, order.revision, 'checkout_expired').catch(() => undefined); return api.start(input); }
          return hold('attempt_in_progress');
        } catch { return hold('processor_unavailable'); }
      }
      try { return await createOrReconcile(order, deps.publicOrigin); }
      catch (error) { return error instanceof CheckoutLedgerError ? hold('order_store_unavailable') : hold('processor_unavailable'); }
    },

    /** What a returning browser is told. State only; the redirect proves nothing and changes nothing. */
    async returnStatus(orderId: string): Promise<{ state: ProgramOrder['state'] | 'unknown' }> {
      try { const order = await deps.ledger.readOrder(orderId); return { state: order?.state ?? 'unknown' }; } catch { return { state: 'unknown' }; }
    },

    /** Durable intake of a verified event. Returns what the webhook route answers; the route acknowledges only `admitted` or `duplicate`. */
    async admitEvent(event: VerifiedEvent & { account?: unknown; api_version?: unknown }, rawBody: string, expected: { accountRef: string; apiVersion: string }): Promise<{ outcome: 'admitted' | 'duplicate' | 'refused' | 'store_unavailable'; detail: string }> {
      const accountRef = typeof event.account === 'string' ? event.account : null;
      const apiVersion = typeof event.api_version === 'string' ? event.api_version : null;
      if (accountRef !== null && accountRef !== expected.accountRef) return { outcome: 'refused', detail: 'account_mismatch' };
      if (apiVersion !== null && apiVersion !== expected.apiVersion) return { outcome: 'refused', detail: 'api_version_mismatch' };
      const object = event.data?.object ?? {};
      const sessionRef = typeof object.id === 'string' && /^cs_test_[A-Za-z0-9]{8,200}$/.test(object.id) ? object.id : null;
      try {
        const { record, duplicate } = await deps.ledger.admitIntake({ eventId: event.id, eventType: event.type, bodySha256: createHash('sha256').update(rawBody, 'utf8').digest('hex'), accountRef, apiVersion, sessionRef });
        return { outcome: duplicate ? 'duplicate' : 'admitted', detail: record.state };
      } catch (error) {
        if (error instanceof CheckoutLedgerError && error.category === 'request_invalid') return { outcome: 'refused', detail: 'event_shape' };
        return { outcome: 'store_unavailable', detail: 'intake_not_recorded' };
      }
    },

    /** One bounded processing attempt for an admitted event; never called before the acknowledgement. */
    async processEvent(eventId: string): Promise<IntakeRecord> {
      const record = await deps.ledger.readIntake(eventId);
      if (!record) throw new CheckoutLedgerError('order_not_found');
      if (record.state !== 'pending' && record.state !== 'failed_retryable') return record;
      const retryAt = () => new Date(now().getTime() + Math.min(60, 2 ** record.attempts) * 60_000).toISOString();
      if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(record.eventType)) return deps.ledger.settleIntake(eventId, { state: 'unhandled', detail: 'event type not handled by this build' });
      if (!record.sessionRef) return deps.ledger.settleIntake(eventId, { state: 'refused', detail: 'no session reference' });
      if (!deps.processor) return deps.ledger.settleIntake(eventId, { state: 'failed_retryable', detail: 'processor unavailable', nextAttemptAt: retryAt() });
      const order = await deps.ledger.findOrderBySession(record.sessionRef);
      if (!order) return deps.ledger.settleIntake(eventId, { state: 'refused', detail: 'no order for session' });
      let session: ProcessorSession;
      try { session = await deps.processor.retrieveSession(record.sessionRef); }
      catch (error) {
        const failure = error instanceof ProcessorError ? error.failure : 'unavailable';
        return deps.ledger.settleIntake(eventId, { state: failure === 'refused' ? 'refused' : 'failed_retryable', detail: `retrieve: ${failure}`, orderId: order.orderId, nextAttemptAt: failure === 'refused' ? null : retryAt() });
      }
      const bound = verifySessionAgainstOrder(session, order, deps.processor.accountRef);
      if (!bound.ok) return deps.ledger.settleIntake(eventId, { state: 'refused', detail: `binding: ${bound.refusal}`, orderId: order.orderId });
      const verification = { eventId: record.eventId, sessionRef: session.sessionRef, amountMinor: session.amountTotal ?? 0, currency: 'USD' as const, paymentStatus: session.paymentStatus, accountRef: session.accountRef, verifiedAt: now().toISOString() };
      const target: ProgramOrder['state'] | null = session.status === 'expired' ? 'checkout_expired' : session.status === 'complete' && session.paymentStatus === 'paid' ? 'payment_verified' : session.status === 'complete' ? 'payment_failed' : null;
      if (target === null) return deps.ledger.settleIntake(eventId, { state: 'failed_retryable', detail: 'session still open', orderId: order.orderId, nextAttemptAt: retryAt() });
      if (order.state === target) return deps.ledger.settleIntake(eventId, { state: 'processed', detail: 'already settled by an earlier event', orderId: order.orderId });
      try {
        await deps.ledger.transition(order.orderId, order.revision, target, target === 'checkout_expired' ? {} : { verification });
        return deps.ledger.settleIntake(eventId, { state: 'processed', detail: target, orderId: order.orderId });
      } catch (error) {
        const category = error instanceof CheckoutLedgerError ? error.category : 'store_unavailable';
        // A terminal order that disagrees with the event is a decided conflict, recorded and visible; a store fault is retried.
        if (category === 'transition_refused' || category === 'revision_stale') return deps.ledger.settleIntake(eventId, { state: 'refused', detail: `transition: ${category} from ${order.state} to ${target}`, orderId: order.orderId });
        return deps.ledger.settleIntake(eventId, { state: 'failed_retryable', detail: `store: ${category}`, orderId: order.orderId, nextAttemptAt: retryAt() });
      }
    },

    /** The retry worker: every due intake gets one attempt. */
    async processDue(limit = 25): Promise<IntakeRecord[]> {
      const due = await deps.ledger.dueIntake(now().toISOString(), limit);
      const results: IntakeRecord[] = [];
      for (const record of due) results.push(await api.processEvent(record.eventId));
      return results;
    },
  };
  return api;
}
