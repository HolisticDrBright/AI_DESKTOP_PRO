import { randomUUID } from 'node:crypto';
import {
  INTAKE_STATES, MAX_INTAKE_ATTEMPTS, OPEN_ORDER_STATES, ORDER_STATES, ORDER_TRANSITIONS, PROGRAM_CHECKOUT_CONTRACT, intakeRecord, programOrder,
  type IntakeRecord, type IntakeState, type OrderState, type ProgramOrder,
} from '../../contracts/programCheckout';
import type { PurchaseAvailability } from '../../contracts/programOffers';

/**
 * The checkout ledger: orders and webhook intake, in whichever store backs it. The fictional one
 * here is what the tests and the local fixture run on; the SQL one (program-checkout-ledger-sql.ts)
 * speaks to the BLOCKED candidate through the API role and is disabled until reviewed. Both hold:
 *
 *   - an order is admitted durably with its terms snapshot before any outbound call; the admission
 *     is unique per (attempt key, offer revision) while the order is still admitted or open, so a
 *     repeated start from the same browser finds the same order;
 *   - every change raises the order revision and follows ORDER_TRANSITIONS; the snapshot, the
 *     subject binding and the identity columns are immutable;
 *   - the complete creation request is recorded once, before anything is sent, and never changes;
 *   - a processor binding is recorded once, with the return destinations the server chose;
 *   - verification is recorded once, from the authoritative object, with the event that caused it;
 *   - intake is deduplicated by event id, admitted before acknowledgement, and processed under a
 *     bounded number of attempts with a next-attempt time; a processing failure is visible and
 *     retryable, never silently dropped and never a success.
 */
export type LedgerCategory = 'store_unavailable' | 'order_not_found' | 'transition_refused' | 'revision_stale' | 'duplicate' | 'request_invalid';
export class CheckoutLedgerError extends Error {
  constructor(readonly category: LedgerCategory) { super(category); this.name = 'CheckoutLedgerError'; }
}

export type OrderAdmission = {
  attemptKeyHash: string;
  funnelSlug: string;
  organizationId: string;
  programId: string;
  offer: Extract<PurchaseAvailability, { available: true }>;
  providerPriceRef: string;
};

export type IntakeAdmission = Pick<IntakeRecord, 'eventId' | 'eventType' | 'bodySha256' | 'accountRef' | 'apiVersion' | 'sessionRef'>;

/** What an operator (and the worker) sees of the work this ledger holds: counts by state, and the oldest unresolved item. */
export type CheckoutWorkStatus = {
  orders: Record<OrderState, number>;
  intake: Record<IntakeState, number>;
  oldestUnresolvedAt: string | null;
};
export type OrderCarry = { creation?: ProgramOrder['creation']; processor?: ProgramOrder['processor']; verification?: ProgramOrder['verification'] };

export interface ProgramCheckoutLedger {
  /** Admit a new order, or return the still-open order the same attempt key already admitted for this offer revision. */
  admitOrder(admission: OrderAdmission): Promise<{ order: ProgramOrder; reused: boolean }>;
  readOrder(orderId: string): Promise<ProgramOrder | null>;
  findOrderBySession(sessionRef: string): Promise<ProgramOrder | null>;
  /** Move an order to a new state at an expected revision, recording the processor binding or verification the step carries. */
  transition(orderId: string, expectedRevision: number, next: OrderState, carry?: OrderCarry): Promise<ProgramOrder>;
  /** Orders in the given states, oldest change first, bounded; the worker's reconciliation list. */
  ordersInStates(states: readonly OrderState[], limit: number): Promise<ProgramOrder[]>;
  /** Counts for the operator status. A failure to read is an error, never zeros. */
  workStatus(): Promise<CheckoutWorkStatus>;
  /** Durable intake before acknowledgement; a repeated event id is a recorded duplicate. */
  admitIntake(admission: IntakeAdmission): Promise<{ record: IntakeRecord; duplicate: boolean }>;
  readIntake(eventId: string): Promise<IntakeRecord | null>;
  /** Record one processing attempt's outcome; `failed_retryable` schedules the next attempt until the bound is exhausted. */
  settleIntake(eventId: string, outcome: { state: Exclude<IntakeState, 'pending'>; detail: string | null; orderId?: string | null; nextAttemptAt?: string | null }): Promise<IntakeRecord>;
  /** Intake due for another attempt, oldest first. */
  dueIntake(now: string, limit: number): Promise<IntakeRecord[]>;
}

export type FictionalCheckoutLedgerOptions = { now?: () => Date; faults?: { before?: (operation: string) => void } };

export function createFictionalCheckoutLedger(options: FictionalCheckoutLedgerOptions = {}) {
  const now = options.now ?? (() => new Date());
  const stamp = () => now().toISOString();
  const orders = new Map<string, ProgramOrder>();
  const intake = new Map<string, IntakeRecord>();
  const history: ProgramOrder[] = [];
  const fault = (operation: string) => { try { options.faults?.before?.(operation); } catch { throw new CheckoutLedgerError('store_unavailable'); } };
  const ledger: ProgramCheckoutLedger & { orders: Map<string, ProgramOrder>; intake: Map<string, IntakeRecord>; history: ProgramOrder[]; reset(): void } = {
    orders, intake, history,
    reset() { orders.clear(); intake.clear(); history.length = 0; },
    async admitOrder(admission) {
      fault('admitOrder');
      const open = [...orders.values()].find(o => o.attemptKeyHash === admission.attemptKeyHash && o.offerId === admission.offer.offerId && o.offerRevision === admission.offer.revision && (OPEN_ORDER_STATES as readonly string[]).includes(o.state));
      if (open) return { order: structuredClone(open), reused: true };
      const at = stamp();
      const order = programOrder.parse({
        contract: PROGRAM_CHECKOUT_CONTRACT, orderId: randomUUID(), organizationId: admission.organizationId, programId: admission.programId,
        offerId: admission.offer.offerId, offerRevision: admission.offer.revision, funnelSlug: admission.funnelSlug, curriculum: admission.offer.curriculum, pricing: admission.offer.pricing,
        providerPriceRef: admission.providerPriceRef, accessTermsVersion: admission.offer.accessTermsVersion, accessDurationDays: admission.offer.accessDurationDays,
        attemptKeyHash: admission.attemptKeyHash, subject: { kind: 'unclaimed' }, state: 'admitted', revision: 1, creation: null, processor: null, verification: null, createdAt: at, updatedAt: at,
      });
      orders.set(order.orderId, order); history.push(structuredClone(order));
      return { order: structuredClone(order), reused: false };
    },
    async readOrder(orderId) { fault('readOrder'); const order = orders.get(orderId); return order ? structuredClone(order) : null; },
    async findOrderBySession(sessionRef) { fault('findOrderBySession'); const order = [...orders.values()].find(o => o.processor?.sessionRef === sessionRef); return order ? structuredClone(order) : null; },
    async transition(orderId, expectedRevision, next, carry = {}) {
      fault('transition');
      const order = orders.get(orderId);
      if (!order) throw new CheckoutLedgerError('order_not_found');
      if (order.revision !== expectedRevision) throw new CheckoutLedgerError('revision_stale');
      if (!ORDER_TRANSITIONS[order.state].includes(next)) throw new CheckoutLedgerError('transition_refused');
      if (carry.creation && (order.creation || next !== 'creation_pending')) throw new CheckoutLedgerError('transition_refused');
      if (next === 'creation_pending' && !carry.creation) throw new CheckoutLedgerError('transition_refused');
      if (carry.processor && order.processor) throw new CheckoutLedgerError('transition_refused');
      if (carry.verification && order.verification) throw new CheckoutLedgerError('transition_refused');
      if (next === 'checkout_open' && !(carry.processor ?? order.processor)) throw new CheckoutLedgerError('transition_refused');
      if ((next === 'payment_verified' || next === 'payment_failed') && !carry.verification) throw new CheckoutLedgerError('transition_refused');
      if (carry.verification && next !== 'payment_verified' && next !== 'payment_failed') throw new CheckoutLedgerError('transition_refused');
      const updated = programOrder.parse({ ...order, state: next, revision: order.revision + 1, creation: carry.creation ?? order.creation, processor: carry.processor ?? order.processor, verification: carry.verification ?? order.verification, updatedAt: stamp() });
      orders.set(orderId, updated); history.push(structuredClone(updated));
      return structuredClone(updated);
    },
    async ordersInStates(states, limit) {
      fault('ordersInStates');
      return [...orders.values()].filter(o => states.includes(o.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, Math.max(1, Math.min(limit, 100))).map(o => structuredClone(o));
    },
    async workStatus() {
      fault('workStatus');
      const orderCounts = Object.fromEntries(ORDER_STATES.map(state => [state, 0])) as Record<OrderState, number>;
      for (const order of orders.values()) orderCounts[order.state] += 1;
      const intakeCounts = Object.fromEntries(INTAKE_STATES.map(state => [state, 0])) as Record<IntakeState, number>;
      for (const record of intake.values()) intakeCounts[record.state] += 1;
      const unresolved = [
        ...[...orders.values()].filter(o => ['creation_pending', 'creation_unresolved', 'creation_unreconciled', 'payment_processing'].includes(o.state)).map(o => o.updatedAt),
        ...[...intake.values()].filter(r => ['pending', 'failed_retryable', 'exhausted', 'conflict'].includes(r.state)).map(r => r.receivedAt),
      ].sort();
      return { orders: orderCounts, intake: intakeCounts, oldestUnresolvedAt: unresolved[0] ?? null };
    },
    async admitIntake(admission) {
      fault('admitIntake');
      const existing = intake.get(admission.eventId);
      if (existing) return { record: structuredClone(existing), duplicate: true };
      const record = intakeRecord.parse({ ...admission, receivedAt: stamp(), state: 'pending', attempts: 0, nextAttemptAt: stamp(), lastOutcome: null, orderId: null });
      intake.set(record.eventId, record);
      return { record: structuredClone(record), duplicate: false };
    },
    async readIntake(eventId) { fault('readIntake'); const record = intake.get(eventId); return record ? structuredClone(record) : null; },
    async settleIntake(eventId, outcome) {
      fault('settleIntake');
      const record = intake.get(eventId);
      if (!record) throw new CheckoutLedgerError('order_not_found');
      if (record.state !== 'pending' && record.state !== 'failed_retryable') throw new CheckoutLedgerError('transition_refused');
      const attempts = record.attempts + 1;
      const exhausted = outcome.state === 'failed_retryable' && attempts >= MAX_INTAKE_ATTEMPTS;
      const updated = intakeRecord.parse({ ...record, state: exhausted ? 'exhausted' : outcome.state, attempts, lastOutcome: outcome.detail, orderId: outcome.orderId ?? record.orderId, nextAttemptAt: outcome.state === 'failed_retryable' && !exhausted ? outcome.nextAttemptAt ?? null : null });
      intake.set(eventId, updated);
      return structuredClone(updated);
    },
    async dueIntake(at, limit) {
      fault('dueIntake');
      return [...intake.values()].filter(r => (r.state === 'pending' || r.state === 'failed_retryable') && r.nextAttemptAt !== null && r.nextAttemptAt <= at).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(0, limit).map(r => structuredClone(r));
    },
  };
  return ledger;
}
