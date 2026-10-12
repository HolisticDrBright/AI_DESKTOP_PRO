import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CLAIM_VALIDITY_DAYS, PROGRAM_EDUCATION_ACCESS_CONTRACT, educationAccessRequest, isAccessActive,
  type ClaimRefusal, type EducationAccessView, type EducationCurriculumRead, type PolicyEventKind, type ProgramEntitlement,
} from '../../contracts/programEducationAccess';
import type { CurriculumBinding } from '../../contracts/programOffers';
import { EducationLedgerError, type OperatorContext, type ProgramEducationLedger, type SettlementReceipt } from './program-education-ledger';
import type { ClaimSealer } from './program-claim-delivery';

/**
 * Settlement: from a verified payment to one entitlement, one claim and, on claim, one enrollment.
 *
 * The durable admitted work is the order row in `payment_verified`; the receipt is the entitlement
 * row that references it (unique per order). A crash between the two leaves the order unsettled
 * and `settleDue` picks it up; a concurrent webhook, a second distinct event for the same payment
 * and a polling client all converge on the same row because the ledger's settlement is idempotent
 * per order. The claim code is generated here, and only two things leave this function with it: its
 * digest (how the ledger recognises it) and its SEALED form, queued for delivery in the same ledger
 * step that creates the entitlement. No return value, log or report ever carries the code; the
 * delivery step (program-claim-delivery.ts) opens it at the moment it sends it.
 *
 * Nothing here reads a clinical table, creates a patient record, a membership, a consent or a
 * practitioner assignment, releases a product or touches anyone's protocol.
 */
export type SettlementDependencies = {
  ledger: ProgramEducationLedger;
  /** The published curriculum content for an entitlement's exact version, as this process can read it; null when it cannot. */
  curriculumContent: (binding: CurriculumBinding) => Promise<{ title: string; phases: unknown[]; sourceDigest: string } | null>;
  expectedAccountRef: string;
  /** Seals each new code for the delivery queue. Without it nothing can be delivered, so nothing is issued. */
  sealer: ClaimSealer | null;
  now?: () => Date;
};

/** `queued`: this call created the entitlement and its sealed delivery; `none`: the receipt already existed. Nothing here says a code was sent. */
export type DeliveryQueued = 'queued' | 'none';
export type SettlementOutcome =
  | { settled: true; receipt: SettlementReceipt; delivery: DeliveryQueued }
  | { settled: false; reason: 'order_not_verified' | 'payment_not_paid' | 'account_mismatch' | 'mode_mismatch' | 'store_unavailable' | 'sealer_unavailable' };
export type ReissueOutcome = { reissued: true; claimId: string; superseded: number } | { reissued: false; reason: 'not_found' | 'not_claimable' | 'sealer_unavailable' | 'store_unavailable' | 'not_operator' };
/** The worker's view of one settlement pass: the outcomes, or the plain fact that the backlog could not be read. */
export type SettlementPass = { ok: true; outcomes: SettlementOutcome[] } | { ok: false; reason: 'backlog_unavailable' };

export const hashClaimToken = (token: string) => createHash('sha256').update('claim:' + token).digest('hex');
export const newClaimToken = () => randomBytes(32).toString('base64url');

export function createProgramSettlement(deps: SettlementDependencies) {
  const now = deps.now ?? (() => new Date());
  const api = {
    /** Settle one verified order. Idempotent: a second call returns the existing receipt and queues nothing. */
    async settleOrder(order: { orderId: string }): Promise<SettlementOutcome> {
      if (!deps.sealer) return { settled: false, reason: 'sealer_unavailable' };
      const claimId = randomUUID();
      const token = newClaimToken();
      const expiresAt = new Date(now().getTime() + CLAIM_VALIDITY_DAYS * 86_400_000).toISOString();
      let sealed;
      try { sealed = await deps.sealer.seal(token, claimId); } catch { return { settled: false, reason: 'sealer_unavailable' }; }
      try {
        const receipt = await deps.ledger.settle(order as never, { claimId, tokenHash: hashClaimToken(token), claimExpiresAt: expiresAt, sealed }, deps.expectedAccountRef);
        return { settled: true, receipt, delivery: receipt.created ? 'queued' : 'none' };
      } catch (error) {
        if (error instanceof EducationLedgerError && error.category === 'settlement_refused') return { settled: false, reason: (error.detail as Exclude<Extract<SettlementOutcome, { settled: false }>['reason'], 'store_unavailable'>) ?? 'order_not_verified' };
        return { settled: false, reason: 'store_unavailable' };
      }
    },
    /** The recovery worker: every verified, unsettled order gets one settlement attempt. An unreadable backlog is said, never "no work". */
    async settleDue(limit = 25): Promise<SettlementPass> {
      let due: { orderId: string }[];
      try { due = await deps.ledger.unsettledOrders(limit); } catch { return { ok: false, reason: 'backlog_unavailable' }; }
      const outcomes: SettlementOutcome[] = [];
      for (const order of due) outcomes.push(await api.settleOrder(order));
      return { ok: true, outcomes };
    },
    /** An operator's replacement code: every earlier code of the entitlement stops working in the same step. Learners and the general API never reach this. */
    async reissue(operator: OperatorContext, entitlementId: string): Promise<ReissueOutcome> {
      if (operator?.kind !== 'operator' || !operator.operatorId) return { reissued: false, reason: 'not_operator' };
      if (!deps.sealer) return { reissued: false, reason: 'sealer_unavailable' };
      const claimId = randomUUID();
      const token = newClaimToken();
      let sealed;
      try { sealed = await deps.sealer.seal(token, claimId); } catch { return { reissued: false, reason: 'sealer_unavailable' }; }
      try {
        const result = await deps.ledger.reissueClaim(operator, entitlementId, { claimId, tokenHash: hashClaimToken(token), claimExpiresAt: new Date(now().getTime() + CLAIM_VALIDITY_DAYS * 86_400_000).toISOString(), sealed });
        return { reissued: true, claimId: result.claim.claimId, superseded: result.superseded };
      } catch (error) {
        if (error instanceof EducationLedgerError && error.category === 'not_found') return { reissued: false, reason: 'not_found' };
        if (error instanceof EducationLedgerError && error.category === 'transition_refused') return { reissued: false, reason: 'not_claimable' };
        return { reissued: false, reason: 'store_unavailable' };
      }
    },
    /** A verified consumer presents the one-time token. The subject comes from the verified identity, never from the body. */
    async claim(consumerSubject: string, token: string): Promise<{ outcome: 'claimed'; entitlement: ProgramEntitlement } | { outcome: 'refused'; reason: ClaimRefusal }> {
      const parsed = educationAccessRequest.safeParse({ action: 'claim', token });
      if (!parsed.success) return { outcome: 'refused', reason: 'claim_invalid' };
      try {
        const result = await deps.ledger.claim(hashClaimToken(token), consumerSubject, now().toISOString());
        return result.outcome === 'claimed' ? { outcome: 'claimed', entitlement: result.entitlement } : { outcome: 'refused', reason: result.reason };
      } catch { return { outcome: 'refused', reason: 'service_unavailable' }; }
    },
    /** The owner's own access, as of now; expiry is applied on read so a cached positive is never served past its end. */
    async access(consumerSubject: string): Promise<EducationAccessView | null> {
      try {
        await deps.ledger.expireDue(now().toISOString());
        const { entitlements, enrollments } = await deps.ledger.access(consumerSubject);
        return { contract: PROGRAM_EDUCATION_ACCESS_CONTRACT, consumerSubject, readAt: now().toISOString(), entitlements, enrollments };
      } catch { return null; }
    },
    /** The exact purchased curriculum for an active entitlement the subject owns; withheld otherwise, with the reason. */
    async curriculum(consumerSubject: string, entitlementId: string): Promise<EducationCurriculumRead> {
      let entitlement: ProgramEntitlement | null;
      try { entitlement = await deps.ledger.readEntitlement(entitlementId); } catch { return { outcome: 'withheld', entitlementId, reason: 'service_unavailable' }; }
      if (!entitlement || entitlement.subject.kind !== 'claimed' || entitlement.subject.consumerSubject !== consumerSubject) return { outcome: 'withheld', entitlementId, reason: 'not_owner' };
      if (!isAccessActive(entitlement, now())) return { outcome: 'withheld', entitlementId, reason: 'not_active' };
      const content = await deps.curriculumContent(entitlement.curriculum).catch(() => null);
      if (!content) return { outcome: 'withheld', entitlementId, reason: 'version_missing' };
      if (content.sourceDigest !== entitlement.curriculum.sourceDigest) return { outcome: 'withheld', entitlementId, reason: 'digest_mismatch' };
      return { outcome: 'served', entitlementId, curriculum: entitlement.curriculum, title: content.title, phases: content.phases };
    },
    /** A policy event from the processor or the operator: held and visible, never an automatic refund or deletion. */
    async recordPolicy(orderId: string, kind: PolicyEventKind, reference: string): Promise<ProgramEntitlement | null> {
      try { return await deps.ledger.recordPolicy(orderId, kind, reference, now().toISOString()); } catch { return null; }
    },
    async expireDue(): Promise<ProgramEntitlement[]> {
      try { return await deps.ledger.expireDue(now().toISOString()); } catch { return []; }
    },
  };
  return api;
}
