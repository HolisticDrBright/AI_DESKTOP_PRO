import type { ProgramOrder } from '@/contracts/programCheckout';
import type { EducationEnrollment, ProgramClaim, ProgramEntitlement } from '@/contracts/programEducationAccess';
import { formatAmount } from '@/contracts/programOffers';

/**
 * The staff purchase-status controller: every order and entitlement of one program as a row that
 * says what it is, with the states the handoff names kept distinct. A payment timestamp is never
 * "enrolled"; a claimed entitlement is education access and nothing clinical; a service failure
 * is a failure and not an empty list (the panel decides that from the read, not from here).
 */
export type PurchaseRowKind =
  | 'checkout_open' | 'checkout_unresolved' | 'checkout_unconfirmed' | 'checkout_closed' | 'payment_processing' | 'payment_failed' | 'order_refused'
  | 'paid_not_fulfilled' | 'code_delivery_pending' | 'code_delivery_unknown' | 'code_delivery_failed' | 'pending_account' | 'claim_expired' | 'access_active' | 'access_expired'
  | 'held_refund' | 'held_dispute' | 'held_policy' | 'revoked';

export type PurchaseRow = {
  orderId: string;
  kind: PurchaseRowKind;
  /** One sentence for the row: the state and what it means. */
  summary: string;
  terms: string;
  /** The exact purchased version, once an entitlement exists. */
  curriculumVersion: number | null;
  entitlementId: string | null;
  /** Education access is separate from clinical delivery: a learner is not yet a patient of anything. */
  clinicalDelivery: 'not_applicable' | 'pending_review' ;
  updatedAt: string;
};

export const PURCHASE_ROW_WORDS: Record<PurchaseRowKind, string> = {
  checkout_open: 'Checkout started; no payment confirmed yet.',
  checkout_unresolved: 'Checkout could not be completed cleanly; nothing was charged here, and the next start reconciles it.',
  checkout_unconfirmed: 'The processor could not confirm whether this checkout was opened, and its idempotency record has lapsed; held for an operator. It cannot take a payment.',
  checkout_closed: 'Checkout expired or was cancelled; nothing was charged.',
  payment_processing: 'The purchaser completed the checkout and the payment is still processing (a delayed payment method). Nothing is granted until the processor confirms it.',
  payment_failed: 'The processor reported the payment as not completed; nothing was granted.',
  order_refused: 'The checkout was refused before any charge.',
  paid_not_fulfilled: 'Payment verified by the processor, but no access has been prepared yet. The settlement worker retries this; if it stays here, the store or the account binding is the problem.',
  code_delivery_pending: 'Paid and access prepared; the one-time code is queued for delivery and has not reached the email provider yet. Nobody holds this access yet.',
  code_delivery_unknown: 'Paid and access prepared; a delivery attempt for the one-time code has an unknown outcome and is being retried under the same provider key. Nobody holds this access yet.',
  code_delivery_failed: 'Paid and access prepared, but delivery of the one-time code failed. The purchaser does not have a usable code; an operator can issue a replacement, which cancels every earlier code.',
  pending_account: 'Paid and access prepared; the email provider accepted the one-time code for the address the payment processor holds. Acceptance is not proof it arrived. Waiting for the purchaser to claim it. Nobody holds this access yet.',
  claim_expired: 'Paid and access prepared, but the claim code expired unused. The purchaser needs a new code; an operator can issue a replacement.',
  access_active: 'Claimed: the purchaser has education access to the exact version shown. This is not clinic membership, a chart, a consent or a protocol.',
  access_expired: 'Education access ended at the end of its window.',
  held_refund: 'Held: a refund was recorded by the processor. Access is withheld until the clinic decides.',
  held_dispute: 'Held: a dispute or chargeback was recorded. Access is withheld until the clinic decides.',
  held_policy: 'Held: a renewal was cancelled or its payment failed. Access is withheld until the clinic decides.',
  revoked: 'Revoked by a recorded clinic decision. Final.',
};

export function purchaseRows(input: { orders: ProgramOrder[]; entitlements: ProgramEntitlement[]; claims: ProgramClaim[]; enrollments: EducationEnrollment[] }, now: Date): PurchaseRow[] {
  const byOrder = new Map(input.entitlements.map(e => [e.orderId, e]));
  return input.orders.map(order => {
    const entitlement = byOrder.get(order.orderId) ?? null;
    const terms = `${formatAmount(order.pricing)}; ${order.accessDurationDays === null ? 'access duration undecided' : `${order.accessDurationDays} days of access`}; offer revision ${order.offerRevision}`;
    const row = (kind: PurchaseRowKind, updatedAt: string): PurchaseRow => ({
      orderId: order.orderId, kind, summary: PURCHASE_ROW_WORDS[kind], terms, curriculumVersion: entitlement?.curriculum.version ?? order.curriculum.version, entitlementId: entitlement?.entitlementId ?? null,
      clinicalDelivery: entitlement?.subject.kind === 'claimed' ? 'pending_review' : 'not_applicable', updatedAt,
    });
    if (!entitlement) {
      switch (order.state) {
        case 'admitted': case 'creation_pending': case 'checkout_open': return row('checkout_open', order.updatedAt);
        case 'creation_unresolved': return row('checkout_unresolved', order.updatedAt);
        case 'creation_unreconciled': return row('checkout_unconfirmed', order.updatedAt);
        case 'payment_processing': return row('payment_processing', order.updatedAt);
        case 'checkout_expired': case 'checkout_cancelled': return row('checkout_closed', order.updatedAt);
        case 'payment_failed': return row('payment_failed', order.updatedAt);
        case 'refused': return row('order_refused', order.updatedAt);
        case 'payment_verified': return row('paid_not_fulfilled', order.updatedAt);
      }
    }
    switch (entitlement.state) {
      case 'awaiting_claim': {
        const live = input.claims.find(c => c.entitlementId === entitlement.entitlementId && c.state === 'issued' && Date.parse(c.expiresAt) > now.getTime());
        if (!live) return row('claim_expired', entitlement.updatedAt);
        const kind: PurchaseRowKind = live.delivery.state === 'accepted' ? 'pending_account' : live.delivery.state === 'pending' ? 'code_delivery_pending' : live.delivery.state === 'provider_unknown' ? 'code_delivery_unknown' : 'code_delivery_failed';
        return row(kind, entitlement.updatedAt);
      }
      case 'active': return row(entitlement.window?.endsAt && Date.parse(entitlement.window.endsAt) <= now.getTime() ? 'access_expired' : 'access_active', entitlement.updatedAt);
      case 'expired': return row('access_expired', entitlement.updatedAt);
      case 'held_refund': return row('held_refund', entitlement.updatedAt);
      case 'held_dispute': return row('held_dispute', entitlement.updatedAt);
      case 'held_policy': return row('held_policy', entitlement.updatedAt);
      case 'revoked': return row('revoked', entitlement.updatedAt);
    }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Counts by kind, for the panel's header line; every kind the data holds, nothing projected. */
export function purchaseCounts(rows: PurchaseRow[]): Partial<Record<PurchaseRowKind, number>> {
  const counts: Partial<Record<PurchaseRowKind, number>> = {};
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  return counts;
}
