import { createHash } from 'node:crypto';
import {
  CHECKOUT_HOLD_EXPLANATIONS, HANDLED_EVENT_TYPES, OPEN_ORDER_STATES, ORDER_TRANSITIONS, checkoutCreation, encodeCreationRequest, observePayment, redirectableCheckout, returnDestinations, verifySessionAgainstOrder,
  type CheckoutCreation, type CheckoutHoldReason, type IntakeRecord, type OrderState, type ProcessorSession, type ProgramOrder,
} from '../../contracts/programCheckout';
import { PURCHASE_HOLD_EXPLANATIONS, type PurchaseHoldReason } from '../../contracts/programOffers';
import type { VerifiedEvent } from '../stripe-boundary';
import { CheckoutLedgerError, type OrderCarry, type ProgramCheckoutLedger } from './program-checkout-ledger';
import { ProcessorError, creationOutcomeKnown, type ProgramCheckoutProcessor } from './program-checkout-processor';
import type { ProgramOfferLedger } from './program-offer-ledger';

/**
 * The program checkout boundary: from a visitor's "buy" on a funnel page to a verified payment,
 * over whichever ledger and processor the runtime selected.
 *
 * Start: the server resolves the offer and its terms itself (the browser named a page, nothing
 * more); refuses while the offer is unavailable, the public origin is unconfigured or the processor
 * is disabled; admits the order durably with its terms snapshot; records the COMPLETE creation
 * request (parameters, digest, destinations, expiry, key) durably; and only then sends exactly that
 * request. Every later attempt for the same order sends the same saved bytes under the same key, so
 * the processor answers the first session; a fresh clock never re-derives a field. An outcome the
 * processor cannot prove after its idempotency retention is a visible operator hold, never a second
 * key. Every session, new, reused, concurrent or reconciled, passes one binding against the saved
 * order (proven account, test mode, identity, price, amount, currency, billing mode, return
 * addresses, expiry) before it is recorded or a browser is sent anywhere.
 *
 * Intake: an event is admitted durably by id and acknowledged; nothing is processed in the request.
 * A bounded worker (program-commerce-worker.ts) processes admitted intake: the AUTHORITATIVE session
 * is retrieved and bound, and what it says (open, expired, processing, verified, failed) decides the
 * order, never which event arrived first. A duplicate or reversed event converges on the same
 * receipt; an observation that contradicts a decided order is a visible `conflict`, never applied.
 * Processor calls happen between ledger calls, never inside a ledger transaction. A browser
 * redirect never moves an order at all.
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

/** The complete creation request for an order, computed ONCE from the clock and the origin at the moment it is recorded. */
export function buildCreation(order: ProgramOrder, origin: string, now: Date, sessionMinutes: number): CheckoutCreation | null {
  const destinations = returnDestinations(origin, order.orderId);
  if (!destinations) return null;
  const request = {
    mode: order.pricing.billing.kind === 'one_time' ? 'payment' as const : 'subscription' as const,
    priceRef: order.providerPriceRef, quantity: 1 as const,
    successUrl: destinations.success, cancelUrl: destinations.cancel,
    clientReferenceId: order.orderId, metadataOrderId: order.orderId,
    expiresAtUnix: Math.floor(now.getTime() / 1000) + sessionMinutes * 60,
  };
  return checkoutCreation.parse({ idempotencyKey: idempotencyKeyFor(order.orderId), request, requestSha256: createHash('sha256').update(encodeCreationRequest(request)).digest('hex'), recordedAt: now.toISOString() });
}

/** What one reconciliation of an order did; the worker reports these, and nothing is swallowed. */
export type OrderReconciliation =
  | { orderId: string; outcome: 'open' | 'expired' | 'processing' | 'verified' | 'failed' | 'unchanged' | 'unreconciled' | 'refused' }
  | { orderId: string; outcome: 'retry'; detail: string };

export function createProgramCheckout(deps: CheckoutDependencies) {
  const now = deps.now ?? (() => new Date());
  const minutes = deps.sessionMinutes ?? 30;
  /** How many times one start may restart after a decided order (expired, refused) before it says so instead. */
  const MAX_RESTARTS = 1;

  /** The account the processor credential proves, or null when it cannot be proven or is not the configured one. */
  async function provenAccount(): Promise<string | null> {
    try {
      const authority = await deps.processor!.authority();
      return authority.livemode === false && authority.accountRef === deps.processor!.accountRef ? authority.accountRef : null;
    } catch { return null; }
  }

  /**
   * One transition that is never swallowed: the order it produced, or the order a peer produced first
   * when that peer already reached the same state, or a typed failure the caller turns into a hold.
   */
  async function move(order: ProgramOrder, next: OrderState, carry: OrderCarry = {}): Promise<{ ok: true; order: ProgramOrder; converged: boolean } | { ok: false; reason: 'store' | 'conflict'; current: ProgramOrder | null }> {
    try { return { ok: true, order: await deps.ledger.transition(order.orderId, order.revision, next, carry), converged: false }; }
    catch (error) {
      if (!(error instanceof CheckoutLedgerError) || (error.category !== 'revision_stale' && error.category !== 'transition_refused')) return { ok: false, reason: 'store', current: null };
      let current: ProgramOrder | null;
      try { current = await deps.ledger.readOrder(order.orderId); } catch { return { ok: false, reason: 'store', current: null }; }
      if (current && current.state === next) return { ok: true, order: current, converged: true };
      return { ok: false, reason: 'conflict', current };
    }
  }

  /** Send the saved creation request (first time or replay), bind what comes back, and answer a redirect or a hold. */
  async function sendSaved(order: ProgramOrder, account: string): Promise<{ result: CheckoutStart; order: ProgramOrder | null }> {
    const creation = order.creation!;
    const sentLongAgo = now().getTime() - Date.parse(creation.recordedAt) > deps.processor!.idempotencyRetentionHours * 3_600_000;
    if (order.state === 'creation_unresolved' || order.state === 'creation_unreconciled') {
      if (Date.parse(new Date(creation.request.expiresAtUnix * 1000).toISOString()) <= now().getTime()) {
        // Whatever the processor may hold for this request has expired: it can take no payment, so the order closes.
        const closed = await move(order, 'checkout_expired');
        return { result: closed.ok ? hold('attempt_in_progress') : hold('order_store_unavailable'), order: closed.ok ? closed.order : null };
      }
      if (sentLongAgo) {
        // Beyond the processor's retention a replay could create a second session; nobody can prove whether the first exists.
        if (order.state === 'creation_unresolved') { const held = await move(order, 'creation_unreconciled'); if (!held.ok) return { result: hold('order_store_unavailable'), order: null }; }
        return { result: hold('checkout_unconfirmed'), order: null };
      }
    }
    let session: ProcessorSession;
    try { session = await deps.processor!.createSession(creation); }
    catch (error) {
      const failure = error instanceof ProcessorError ? error.failure : 'unavailable';
      if (creationOutcomeKnown(failure)) {
        const refused = await move(order, 'refused');
        return { result: refused.ok ? hold('processor_refused') : hold('order_store_unavailable'), order: null };
      }
      if (failure === 'idempotency_mismatch') {
        // This source only ever sends the saved bytes; a mismatch means the key's history is not ours to explain. Held, never re-keyed.
        let current = order;
        if (current.state === 'creation_pending') { const unresolved = await move(current, 'creation_unresolved'); if (!unresolved.ok) return { result: hold('order_store_unavailable'), order: null }; current = unresolved.order; }
        if (current.state === 'creation_unresolved') { const held = await move(current, 'creation_unreconciled'); if (!held.ok) return { result: hold('order_store_unavailable'), order: null }; }
        return { result: hold('checkout_unconfirmed'), order: null };
      }
      if (order.state === 'creation_pending') { const unresolved = await move(order, 'creation_unresolved'); if (!unresolved.ok) return { result: hold('order_store_unavailable'), order: null }; }
      return { result: hold('processor_unavailable'), order: null };
    }
    const bound = verifySessionAgainstOrder(session, order, account);
    if (!bound.ok) {
      const refused = await move(order, 'refused');
      return { result: refused.ok ? hold('processor_refused') : hold('order_store_unavailable'), order: null };
    }
    const processor = { provider: 'stripe' as const, mode: 'test' as const, sessionRef: session.sessionRef, expiresAt: session.expiresAt, returnSuccess: creation.request.successUrl, returnCancel: creation.request.cancelUrl };
    const opened = await move(order, 'checkout_open', { processor });
    if (!opened.ok) {
      // A peer bound a session first: answer with it only if it is the same session (same key, same request).
      if (opened.reason === 'conflict' && opened.current?.state === 'checkout_open' && opened.current.processor?.sessionRef === session.sessionRef) return redirectTo(opened.current, session, account, true);
      return { result: opened.reason === 'store' ? hold('order_store_unavailable') : hold('attempt_in_progress'), order: null };
    }
    return redirectTo(opened.order, session, account, opened.converged);
  }

  function redirectTo(order: ProgramOrder, session: ProcessorSession, account: string, reused: boolean): { result: CheckoutStart; order: ProgramOrder } {
    const checked = redirectableCheckout(session, order, account, deps.processor!.checkoutHosts, now());
    if (!checked.ok) return { result: checked.refusal === 'not_open' ? hold('attempt_in_progress') : hold('processor_refused'), order };
    return { result: { started: true, orderId: order.orderId, checkoutUrl: checked.url, expiresAt: checked.expiresAt, reused }, order };
  }

  /** One step for an order the visitor's attempt key owns; `restarts` bounds how often a decided order leads to a new admission. */
  async function proceed(input: StartInput, order: ProgramOrder, reused: boolean, restarts: number): Promise<CheckoutStart> {
    const account = await provenAccount();
    if (!account) return hold('processor_refused');
    switch (order.state) {
      case 'admitted': {
        const creation = buildCreation(order, deps.publicOrigin!, now(), minutes);
        if (!creation) return hold('return_origin_unconfigured');
        const recorded = await move(order, 'creation_pending', { creation });
        if (!recorded.ok) {
          // A peer recorded the creation first: send ITS saved request, not ours.
          if (recorded.reason === 'conflict' && recorded.current && (OPEN_ORDER_STATES as readonly string[]).includes(recorded.current.state)) return proceed(input, recorded.current, true, restarts);
          return hold('order_store_unavailable');
        }
        return (await sendSaved(recorded.order, account)).result;
      }
      case 'creation_pending': case 'creation_unresolved': case 'creation_unreconciled': {
        const sent = await sendSaved(order, account);
        if (sent.order?.state === 'checkout_expired' && restarts < MAX_RESTARTS) return restart(input, restarts + 1);
        return sent.result;
      }
      case 'checkout_open': {
        if (!order.processor) return hold('order_store_unavailable');
        let session: ProcessorSession;
        try { session = await deps.processor!.retrieveSession(order.processor.sessionRef); } catch { return hold('processor_unavailable'); }
        const bound = verifySessionAgainstOrder(session, order, account);
        if (!bound.ok) return hold('processor_refused');
        if (session.status === 'expired' || Date.parse(session.expiresAt) <= now().getTime()) {
          const expired = await move(order, 'checkout_expired');
          if (!expired.ok) return expired.reason === 'store' ? hold('order_store_unavailable') : hold('attempt_in_progress');
          return restarts < MAX_RESTARTS ? restart(input, restarts + 1) : hold('attempt_in_progress');
        }
        if (session.status !== 'open') return hold('attempt_in_progress');
        return redirectTo(order, session, account, reused).result;
      }
      default:
        return restarts < MAX_RESTARTS ? restart(input, restarts + 1) : hold('attempt_in_progress');
    }
  }

  type StartInput = { funnelSlug: string; programBinding: { organizationId: string; programId: string } | null; attemptKey: string };
  async function admit(input: StartInput): Promise<{ hold: CheckoutStart } | { admitted: { order: ProgramOrder; reused: boolean } }> {
    const availability = await deps.offers.availability(input.programBinding!.organizationId, input.programBinding!.programId);
    if (!availability.available) return { hold: hold(availability.reason) };
    try {
      return { admitted: await deps.ledger.admitOrder({ attemptKeyHash: hashAttemptKey(input.attemptKey), funnelSlug: input.funnelSlug, organizationId: input.programBinding!.organizationId, programId: input.programBinding!.programId, offer: availability, providerPriceRef: availability.providerPriceRef }) };
    } catch { return { hold: hold('order_store_unavailable') }; }
  }
  async function restart(input: StartInput, restarts: number): Promise<CheckoutStart> {
    const next = await admit(input);
    if ('hold' in next) return next.hold;
    return proceed(input, next.admitted.order, next.admitted.reused, restarts);
  }

  /** Bring an order the worker found unresolved forward by exactly one bounded step; no browser is involved. */
  async function reconcileOrder(order: ProgramOrder): Promise<OrderReconciliation> {
    if (!deps.processor) return { orderId: order.orderId, outcome: 'retry', detail: 'processor unavailable' };
    const account = await provenAccount();
    if (!account) return { orderId: order.orderId, outcome: 'retry', detail: 'processor authority unproven' };
    if (order.state === 'creation_pending' || order.state === 'creation_unresolved' || order.state === 'creation_unreconciled') {
      const sent = await sendSaved(order, account);
      const after = sent.order ?? await deps.ledger.readOrder(order.orderId).catch(() => null);
      if (!after) return { orderId: order.orderId, outcome: 'retry', detail: 'order unreadable after reconciliation' };
      return { orderId: order.orderId, outcome: after.state === 'checkout_open' ? 'open' : after.state === 'checkout_expired' ? 'expired' : after.state === 'creation_unreconciled' ? 'unreconciled' : after.state === 'refused' ? 'refused' : 'unchanged' };
    }
    if (order.state === 'checkout_open' || order.state === 'payment_processing') {
      let session: ProcessorSession;
      try { session = await deps.processor.retrieveSession(order.processor!.sessionRef); } catch (error) { return { orderId: order.orderId, outcome: 'retry', detail: `retrieve: ${error instanceof ProcessorError ? error.failure : 'unavailable'}` }; }
      const applied = await applyObservation(order, session, account, null);
      return applied.kind === 'applied' ? { orderId: order.orderId, outcome: applied.observation === 'open' ? 'open' : applied.observation } : applied.kind === 'retry' ? { orderId: order.orderId, outcome: 'retry', detail: applied.detail } : { orderId: order.orderId, outcome: 'refused' };
    }
    return { orderId: order.orderId, outcome: 'unchanged' };
  }

  /**
   * Apply what the retrieved object says to the order. The observation decides; the event that asked
   * does not. Already there, or a peer got there first with the same evidence: the same receipt.
   * A decided order the observation contradicts: a conflict, visible and unapplied.
   */
  async function applyObservation(order: ProgramOrder, session: ProcessorSession, account: string, eventId: string | null):
    Promise<{ kind: 'applied'; observation: 'open' | 'expired' | 'processing' | 'verified' | 'failed'; detail: string } | { kind: 'refused'; detail: string } | { kind: 'conflict'; detail: string } | { kind: 'retry'; detail: string }> {
    const bound = verifySessionAgainstOrder(session, order, account);
    if (!bound.ok) return { kind: 'refused', detail: `binding: ${bound.refusal}` };
    const observation = observePayment(session);
    const target: OrderState | null = observation === 'expired' ? 'checkout_expired' : observation === 'processing' ? 'payment_processing' : observation === 'verified' ? 'payment_verified' : observation === 'failed' ? 'payment_failed' : null;
    if (target === null) return { kind: 'applied', observation: 'open', detail: 'session still open' };
    if (order.state === target) return { kind: 'applied', observation, detail: 'already recorded' };
    // A weaker observation than what is decided is a stale view of the same history, not a contradiction.
    if (target === 'payment_processing' && (order.state === 'payment_verified' || order.state === 'payment_failed')) return { kind: 'applied', observation, detail: `already decided: ${order.state}` };
    if (!ORDER_TRANSITIONS[order.state].includes(target)) return { kind: 'conflict', detail: `observed ${observation} while the order is ${order.state}` };
    const carry: OrderCarry = target === 'payment_verified' || target === 'payment_failed'
      ? { verification: { eventId, sessionRef: session.sessionRef, amountMinor: session.amountTotal ?? 0, currency: 'USD', paymentStatus: session.paymentStatus, accountRef: session.accountRef, verifiedAt: now().toISOString() } }
      : {};
    const moved = await move(order, target, carry);
    if (moved.ok) return { kind: 'applied', observation, detail: moved.converged ? `converged: ${target}` : target };
    if (moved.reason === 'store') return { kind: 'retry', detail: 'store: transition not recorded' };
    // A peer moved the order meanwhile: try once more from what it recorded, and otherwise say what disagrees.
    if (moved.current && ORDER_TRANSITIONS[moved.current.state].includes(target)) {
      const again = await move(moved.current, target, carry);
      if (again.ok) return { kind: 'applied', observation, detail: `after peer: ${target}` };
      if (again.reason === 'store') return { kind: 'retry', detail: 'store: transition not recorded' };
    }
    if (moved.current && target === 'payment_processing' && (moved.current.state === 'payment_verified' || moved.current.state === 'payment_failed')) return { kind: 'applied', observation, detail: `already decided: ${moved.current.state}` };
    return { kind: 'conflict', detail: `observed ${observation} while the order is ${moved.current?.state ?? 'unreadable'}` };
  }

  const api = {
    /** The visitor's start: the page they are on and their browser's attempt key; everything else is the server's. */
    async start(input: StartInput): Promise<CheckoutStart> {
      if (!input.programBinding) return hold('program_unbound');
      if (!deps.publicOrigin) return hold('return_origin_unconfigured');
      if (!deps.processor) return hold('checkout_unconfigured');
      const admitted = await admit(input);
      if ('hold' in admitted) return admitted.hold;
      try { return await proceed(input, admitted.admitted.order, admitted.admitted.reused, 0); }
      catch (error) { return error instanceof CheckoutLedgerError ? hold('order_store_unavailable') : hold('processor_unavailable'); }
    },

    reconcileOrder,

    /** What a returning browser is told. State only; the redirect proves nothing and changes nothing. */
    async returnStatus(orderId: string): Promise<{ state: ProgramOrder['state'] | 'unknown' }> {
      try { const order = await deps.ledger.readOrder(orderId); return { state: order?.state ?? 'unknown' }; } catch { return { state: 'unknown' }; }
    },

    /** Durable intake of a verified event. Returns what the webhook route answers; the route acknowledges only `admitted` or `duplicate`. */
    async admitEvent(event: VerifiedEvent & { account?: unknown; api_version?: unknown }, rawBody: string | Uint8Array, expected: { accountRef: string; apiVersion: string }): Promise<{ outcome: 'admitted' | 'duplicate' | 'refused' | 'store_unavailable'; detail: string }> {
      const accountRef = typeof event.account === 'string' ? event.account : null;
      const apiVersion = typeof event.api_version === 'string' ? event.api_version : null;
      if (accountRef !== null && accountRef !== expected.accountRef) return { outcome: 'refused', detail: 'account_mismatch' };
      if (apiVersion !== null && apiVersion !== expected.apiVersion) return { outcome: 'refused', detail: 'api_version_mismatch' };
      const object = event.data?.object ?? {};
      const sessionRef = typeof object.id === 'string' && /^cs_test_[A-Za-z0-9]{8,200}$/.test(object.id) ? object.id : null;
      try {
        const { record, duplicate } = await deps.ledger.admitIntake({ eventId: event.id, eventType: event.type, bodySha256: createHash('sha256').update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody).digest('hex'), accountRef, apiVersion, sessionRef });
        return { outcome: duplicate ? 'duplicate' : 'admitted', detail: record.state };
      } catch (error) {
        if (error instanceof CheckoutLedgerError && error.category === 'request_invalid') return { outcome: 'refused', detail: 'event_shape' };
        return { outcome: 'store_unavailable', detail: 'intake_not_recorded' };
      }
    },

    /** One bounded processing attempt for an admitted event; called by the worker, never inside the webhook request. */
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
      const account = await provenAccount();
      if (!account) return deps.ledger.settleIntake(eventId, { state: 'failed_retryable', detail: 'processor authority unproven', orderId: order.orderId, nextAttemptAt: retryAt() });
      let session: ProcessorSession;
      try { session = await deps.processor.retrieveSession(record.sessionRef); }
      catch (error) {
        const failure = error instanceof ProcessorError ? error.failure : 'unavailable';
        return deps.ledger.settleIntake(eventId, { state: failure === 'refused' ? 'refused' : 'failed_retryable', detail: `retrieve: ${failure}`, orderId: order.orderId, nextAttemptAt: failure === 'refused' ? null : retryAt() });
      }
      const applied = await applyObservation(order, session, account, record.eventId);
      if (applied.kind === 'refused') return deps.ledger.settleIntake(eventId, { state: 'refused', detail: applied.detail, orderId: order.orderId });
      if (applied.kind === 'conflict') return deps.ledger.settleIntake(eventId, { state: 'conflict', detail: applied.detail, orderId: order.orderId });
      if (applied.kind === 'retry' || applied.observation === 'open') return deps.ledger.settleIntake(eventId, { state: 'failed_retryable', detail: applied.kind === 'retry' ? applied.detail : 'session still open', orderId: order.orderId, nextAttemptAt: retryAt() });
      return deps.ledger.settleIntake(eventId, { state: 'processed', detail: applied.detail, orderId: order.orderId });
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
