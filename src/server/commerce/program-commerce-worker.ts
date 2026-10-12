import type { IntakeRecord, OrderState } from '../../contracts/programCheckout';
import type { CheckoutWorkStatus, ProgramCheckoutLedger } from './program-checkout-ledger';
import type { OrderReconciliation, createProgramCheckout } from './program-checkout';
import type { SettlementPass, createProgramSettlement } from './program-settlement';

/**
 * The commerce worker: the only place admitted work is processed. The webhook route admits an event
 * durably and acknowledges it; nothing runs in that request after the reply. This worker, constructed
 * independently over the same durable ledgers (in another process, after a restart, with no visitor
 * present), takes one bounded pass:
 *
 *   1. due intake, oldest first, one attempt each (the ledger bounds attempts and schedules backoff);
 *   2. reconciliation of orders whose outcome is not yet decided (a saved creation not yet confirmed,
 *      a payment still processing, an open checkout past its expiry): one bounded step each;
 *   3. settlement of verified orders into entitlements (idempotent per order);
 *   4. the operator status: counts by state and the oldest unresolved item.
 *
 * Every step reports its own failure: an unreadable list is `unavailable`, never "no work"; an item
 * that throws is reported with its id, never dropped. Processor calls are made by the boundary
 * between ledger calls, never inside a ledger transaction. There is no lease: every step is safe to
 * run twice at once (transitions are revision-checked and converge; intake settles once), and a
 * lease expiry would not prove a processor call had stopped anyway. Scheduling this pass (how often,
 * where, with which alarms) is the host's decision and is not made here.
 */
export type WorkerLimits = { intake: number; reconcile: number; settle: number };
export type WorkerReport = {
  intake: { ok: true; results: { eventId: string; state: IntakeRecord['state'] | 'error'; detail: string | null }[] } | { ok: false; reason: 'intake_unavailable' };
  reconcile: { ok: true; results: (OrderReconciliation | { orderId: string; outcome: 'error'; detail: string })[] } | { ok: false; reason: 'orders_unavailable' };
  settlement: SettlementPass;
  status: { ok: true; checkout: CheckoutWorkStatus } | { ok: false; reason: 'status_unavailable' };
};

/** Orders whose outcome is not decided and that a pass may move forward without a visitor. */
export const RECONCILABLE_ORDER_STATES = ['creation_pending', 'creation_unresolved', 'payment_processing', 'checkout_open'] as const satisfies readonly OrderState[];

export function createCommerceWorker(deps: {
  ledger: ProgramCheckoutLedger;
  checkout: ReturnType<typeof createProgramCheckout>;
  settlement: ReturnType<typeof createProgramSettlement>;
  now?: () => Date;
  limits?: Partial<WorkerLimits>;
  /** An open checkout is reconciled only once its saved expiry has passed (its events normally arrive on their own). */
  reconcileOpenAfterExpiry?: boolean;
}) {
  const now = deps.now ?? (() => new Date());
  const limits: WorkerLimits = { intake: 25, reconcile: 25, settle: 25, ...deps.limits };
  const errorText = (error: unknown) => (error instanceof Error ? error.name + ': ' + error.message : 'unknown').slice(0, 200);
  return {
    async runOnce(): Promise<WorkerReport> {
      let intake: WorkerReport['intake'];
      try {
        const due = await deps.ledger.dueIntake(now().toISOString(), limits.intake);
        const results: Extract<WorkerReport['intake'], { ok: true }>['results'] = [];
        for (const record of due) {
          try { const after = await deps.checkout.processEvent(record.eventId); results.push({ eventId: record.eventId, state: after.state, detail: after.lastOutcome }); }
          catch (error) { results.push({ eventId: record.eventId, state: 'error', detail: errorText(error) }); }
        }
        intake = { ok: true, results };
      } catch { intake = { ok: false, reason: 'intake_unavailable' }; }

      let reconcile: WorkerReport['reconcile'];
      try {
        const candidates = await deps.ledger.ordersInStates(RECONCILABLE_ORDER_STATES, limits.reconcile);
        const results: Extract<WorkerReport['reconcile'], { ok: true }>['results'] = [];
        for (const order of candidates) {
          if (order.state === 'checkout_open' && (deps.reconcileOpenAfterExpiry ?? true) && (!order.processor || Date.parse(order.processor.expiresAt) > now().getTime())) continue;
          try { results.push(await deps.checkout.reconcileOrder(order)); }
          catch (error) { results.push({ orderId: order.orderId, outcome: 'error', detail: errorText(error) }); }
        }
        reconcile = { ok: true, results };
      } catch { reconcile = { ok: false, reason: 'orders_unavailable' }; }

      const settlement = await deps.settlement.settleDue(limits.settle);

      let status: WorkerReport['status'];
      try { status = { ok: true, checkout: await deps.ledger.workStatus() }; } catch { status = { ok: false, reason: 'status_unavailable' }; }
      return { intake, reconcile, settlement, status };
    },
    /** The operator's view without doing any work. */
    async status(): Promise<WorkerReport['status']> {
      try { return { ok: true, checkout: await deps.ledger.workStatus() }; } catch { return { ok: false, reason: 'status_unavailable' }; }
    },
  };
}
