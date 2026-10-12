import { createHash, randomBytes } from 'node:crypto';
import {
  CLAIM_VALIDITY_DAYS, PROGRAM_EDUCATION_ACCESS_CONTRACT, educationAccessRequest, isAccessActive,
  type ClaimRefusal, type EducationAccessView, type EducationCurriculumRead, type PolicyEventKind, type ProgramEntitlement,
} from '../../contracts/programEducationAccess';
import type { CurriculumBinding } from '../../contracts/programOffers';
import { EducationLedgerError, type ProgramEducationLedger, type SettlementReceipt } from './program-education-ledger';

/**
 * Settlement: from a verified payment to one entitlement, one claim and, on claim, one enrollment.
 *
 * The durable admitted work is the order row in `payment_verified`; the receipt is the entitlement
 * row that references it (unique per order). A crash between the two leaves the order unsettled
 * and `settleDue` picks it up; a concurrent webhook, a second distinct event for the same payment
 * and a polling client all converge on the same row because the ledger's settlement is idempotent
 * per order. The claim token is generated here, hashed before storage, and handed to the delivery
 * dependency (an email to the processor-verified address) which this source does NOT implement: the
 * token leaves this function to the caller's chosen delivery and nowhere else.
 *
 * Nothing here reads a clinical table, creates a patient record, a membership, a consent or a
 * practitioner assignment, releases a product or touches anyone's protocol.
 */
export type SettlementDependencies = {
  ledger: ProgramEducationLedger;
  /** The published curriculum content for an entitlement's exact version, as this process can read it; null when it cannot. */
  curriculumContent: (binding: CurriculumBinding) => Promise<{ title: string; phases: unknown[]; sourceDigest: string } | null>;
  expectedAccountRef: string;
  /**
   * Where the one copy of a new claim token goes: the delivery to the processor-verified address. This
   * source implements no delivery; the fixture records it, and a real provider is a named dependency. A
   * failed delivery is reported, never retried with a second token here (the claim stays issued and
   * the operator sees it on the status view).
   */
  deliver?: (delivery: { orderId: string; entitlementId: string; claimToken: string; expiresAt: string }) => Promise<void>;
  now?: () => Date;
};

/**
 * What happened to the hand-off of a new claim to delivery: `none` when this call created nothing
 * (the receipt existed), `not_configured` when no delivery exists in this process, `handed_off`
 * when the delivery dependency accepted it, `failed` when it threw. A hand-off is not a delivery:
 * nothing here may say a code was sent. Durable delivery and recovery are work package 2.
 */
export type DeliveryHandOff = 'none' | 'not_configured' | 'handed_off' | 'failed';
export type SettlementOutcome =
  | { settled: true; receipt: SettlementReceipt; /** Present only when this call created the entitlement; the one copy of the token that ever exists. */ claimToken: string | null; delivery: DeliveryHandOff }
  | { settled: false; reason: 'order_not_verified' | 'payment_not_paid' | 'account_mismatch' | 'mode_mismatch' | 'store_unavailable' };
/** The worker's view of one settlement pass: the outcomes, or the plain fact that the backlog could not be read. */
export type SettlementPass = { ok: true; outcomes: SettlementOutcome[] } | { ok: false; reason: 'backlog_unavailable' };

export const hashClaimToken = (token: string) => createHash('sha256').update('claim:' + token).digest('hex');
export const newClaimToken = () => randomBytes(32).toString('base64url');

export function createProgramSettlement(deps: SettlementDependencies) {
  const now = deps.now ?? (() => new Date());
  const api = {
    /** Settle one verified order. Idempotent: a second call returns the existing receipt and no token. */
    async settleOrder(order: { orderId: string }): Promise<SettlementOutcome> {
      const token = newClaimToken();
      const expiresAt = new Date(now().getTime() + CLAIM_VALIDITY_DAYS * 86_400_000).toISOString();
      try {
        const receipt = await deps.ledger.settle(order as never, hashClaimToken(token), expiresAt, deps.expectedAccountRef);
        let delivery: DeliveryHandOff = 'none';
        if (receipt.created) {
          if (!deps.deliver) delivery = 'not_configured';
          else delivery = await deps.deliver({ orderId: receipt.entitlement.orderId, entitlementId: receipt.entitlement.entitlementId, claimToken: token, expiresAt }).then(() => 'handed_off' as const, () => 'failed' as const);
        }
        return { settled: true, receipt, claimToken: receipt.created ? token : null, delivery };
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
