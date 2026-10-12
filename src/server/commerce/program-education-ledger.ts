import { randomUUID } from 'node:crypto';
import {
  ENTITLEMENT_TRANSITIONS, PROGRAM_EDUCATION_ACCESS_CONTRACT, accessWindow, educationEnrollment, programClaim, programEntitlement,
  type EducationCurriculumRead, type EducationEnrollment, type EntitlementState, type PolicyEventKind, type ProgramClaim, type ProgramEntitlement,
} from '../../contracts/programEducationAccess';
import type { ProgramOrder } from '../../contracts/programCheckout';
import type { ProgramCheckoutLedger } from './program-checkout-ledger';

/**
 * The education access ledger: entitlements, claims and enrollments, in whichever store backs it.
 * The fictional one here shares a process with the fictional checkout ledger, which it reads for the
 * verified orders it settles; the SQL one (program-education-ledger-sql.ts) speaks to the BLOCKED
 * candidate through the API role. Both hold:
 *
 *   - settlement is idempotent per order: one entitlement per order, whichever path arrives first,
 *     and a repeated settlement finds it instead of making a second;
 *   - settlement requires a verified, paid order from the expected processor account; anything else
 *     is refused and visible, never silently skipped;
 *   - a claim is single-use, expiring, bound to one entitlement; using it binds the subject, opens the
 *     window from the saved duration, and creates the learner's enrollment, all in one step;
 *   - a claimed entitlement cannot be claimed again, by anyone; a second claim by the same subject is
 *     "already used", by another subject "already claimed by other", and neither changes anything;
 *   - every change raises the revision and follows ENTITLEMENT_TRANSITIONS; the order, offer and
 *     curriculum columns are immutable; policy events are appended, never edited;
 *   - the access read returns the subject's own rows only; an unclaimed entitlement belongs to nobody.
 */
export type EducationLedgerCategory = 'store_unavailable' | 'not_found' | 'transition_refused' | 'revision_stale' | 'settlement_refused' | 'request_invalid';
export class EducationLedgerError extends Error {
  constructor(readonly category: EducationLedgerCategory, readonly detail?: string) { super(category); this.name = 'EducationLedgerError'; }
}

export type SettlementReceipt = { entitlement: ProgramEntitlement; claim: ProgramClaim; created: boolean };
export type ClaimOutcome =
  | { outcome: 'claimed'; entitlement: ProgramEntitlement; enrollment: EducationEnrollment }
  | { outcome: 'refused'; reason: 'claim_invalid' | 'claim_expired' | 'claim_used' | 'claim_superseded' | 'entitlement_not_claimable' | 'already_claimed_by_other' };

export interface ProgramEducationLedger {
  /** Create the entitlement and its first claim for a verified order, or return the ones that exist. The token hash is the caller's; a fresh hash is issued only when nothing existed. */
  settle(order: ProgramOrder, tokenHash: string, claimExpiresAt: string, expectedAccountRef: string): Promise<SettlementReceipt>;
  /** Verified, paid orders with no entitlement yet: the durable admitted work a crashed settlement left behind. */
  unsettledOrders(limit: number): Promise<ProgramOrder[]>;
  claim(tokenHash: string, consumerSubject: string, at: string): Promise<ClaimOutcome>;
  readEntitlement(entitlementId: string): Promise<ProgramEntitlement | null>;
  entitlementForOrder(orderId: string): Promise<ProgramEntitlement | null>;
  /** The subject's own entitlements and enrollments. */
  access(consumerSubject: string): Promise<{ entitlements: ProgramEntitlement[]; enrollments: EducationEnrollment[] }>;
  recordPolicy(orderId: string, kind: PolicyEventKind, reference: string, at: string): Promise<ProgramEntitlement>;
  transition(entitlementId: string, expectedRevision: number, next: EntitlementState): Promise<ProgramEntitlement>;
  expireDue(at: string): Promise<ProgramEntitlement[]>;
  /** Everything about one clinic's program, for the staff status view: every order and entitlement state, never a subject's identity beyond its opaque form. */
  listForProgram(organizationId: string, programId: string): Promise<{ orders: ProgramOrder[]; entitlements: ProgramEntitlement[]; enrollments: EducationEnrollment[]; claims: ProgramClaim[] }>;
  /** The staff read of the exact purchased version for one of the clinic's entitlements. */
  staffCurriculum(actor: { personId: string; organizationId: string; identitySubject: string }, entitlementId: string): Promise<EducationCurriculumRead>;
}

export type FictionalEducationLedgerOptions = { orders: ProgramCheckoutLedger & { orders: Map<string, ProgramOrder> }; now?: () => Date; faults?: { before?: (operation: string) => void }; /** The fixture's published content by version id, for the staff read. */ content?: (binding: ProgramEntitlement['curriculum']) => Promise<{ title: string; phases: unknown[]; sourceDigest: string } | null> };

export function createFictionalEducationLedger(options: FictionalEducationLedgerOptions) {
  const now = options.now ?? (() => new Date());
  const stamp = () => now().toISOString();
  const entitlements = new Map<string, ProgramEntitlement>();
  const claims = new Map<string, ProgramClaim>();
  const enrollments = new Map<string, EducationEnrollment>();
  const events: { entitlementId: string; kind: PolicyEventKind | 'settled' | 'claimed' | 'expired' | 'transition'; reference: string | null; at: string }[] = [];
  const fault = (operation: string) => { try { options.faults?.before?.(operation); } catch { throw new EducationLedgerError('store_unavailable'); } };
  const byOrder = (orderId: string) => [...entitlements.values()].find(e => e.orderId === orderId) ?? null;
  const move = (entitlement: ProgramEntitlement, expectedRevision: number, next: EntitlementState, carry: Partial<ProgramEntitlement> = {}): ProgramEntitlement => {
    if (entitlement.revision !== expectedRevision) throw new EducationLedgerError('revision_stale');
    if (!ENTITLEMENT_TRANSITIONS[entitlement.state].includes(next)) throw new EducationLedgerError('transition_refused', `${entitlement.state} -> ${next}`);
    const updated = programEntitlement.parse({ ...entitlement, ...carry, state: next, revision: entitlement.revision + 1, updatedAt: stamp() });
    entitlements.set(updated.entitlementId, updated);
    events.push({ entitlementId: updated.entitlementId, kind: 'transition', reference: next, at: stamp() });
    return structuredClone(updated);
  };
  const ledger: ProgramEducationLedger & { entitlements: typeof entitlements; claims: typeof claims; enrollments: typeof enrollments; events: typeof events; reset(): void } = {
    entitlements, claims, enrollments, events,
    reset() { entitlements.clear(); claims.clear(); enrollments.clear(); events.length = 0; },
    async settle(order, tokenHash, claimExpiresAt, expectedAccountRef) {
      fault('settle');
      const existing = byOrder(order.orderId);
      if (existing) {
        const claim = [...claims.values()].find(c => c.entitlementId === existing.entitlementId && c.state === 'issued') ?? [...claims.values()].find(c => c.entitlementId === existing.entitlementId)!;
        return { entitlement: structuredClone(existing), claim: structuredClone(claim), created: false };
      }
      // The order is re-read from its own ledger: a caller's copy is not evidence.
      const current = options.orders.orders.get(order.orderId);
      if (!current || current.state !== 'payment_verified' || !current.verification) throw new EducationLedgerError('settlement_refused', 'order_not_verified');
      if (current.verification.paymentStatus !== 'paid') throw new EducationLedgerError('settlement_refused', 'payment_not_paid');
      if (current.verification.accountRef !== expectedAccountRef) throw new EducationLedgerError('settlement_refused', 'account_mismatch');
      if (current.processor?.mode !== 'test') throw new EducationLedgerError('settlement_refused', 'mode_mismatch');
      const at = stamp();
      const entitlement = programEntitlement.parse({
        contract: PROGRAM_EDUCATION_ACCESS_CONTRACT, entitlementId: randomUUID(), orderId: current.orderId, organizationId: current.organizationId, programId: current.programId,
        offerId: current.offerId, offerRevision: current.offerRevision, curriculum: current.curriculum, accessTermsVersion: current.accessTermsVersion, accessDurationDays: current.accessDurationDays,
        subject: { kind: 'unclaimed' }, state: 'awaiting_claim', revision: 1, window: null, settlement: { verificationEventId: current.verification.eventId, settledAt: at }, policy: null, createdAt: at, updatedAt: at,
      });
      const claim = programClaim.parse({ claimId: randomUUID(), entitlementId: entitlement.entitlementId, tokenHash, issuedAt: at, expiresAt: claimExpiresAt, state: 'issued', usedAt: null, usedBy: null });
      entitlements.set(entitlement.entitlementId, entitlement); claims.set(claim.claimId, claim);
      events.push({ entitlementId: entitlement.entitlementId, kind: 'settled', reference: current.orderId, at });
      return { entitlement: structuredClone(entitlement), claim: structuredClone(claim), created: true };
    },
    async unsettledOrders(limit) {
      fault('unsettledOrders');
      return [...options.orders.orders.values()].filter(o => o.state === 'payment_verified' && o.verification?.paymentStatus === 'paid' && !byOrder(o.orderId)).slice(0, limit).map(o => structuredClone(o));
    },
    async claim(tokenHash, consumerSubject, at) {
      fault('claim');
      const claim = [...claims.values()].find(c => c.tokenHash === tokenHash);
      if (!claim) return { outcome: 'refused', reason: 'claim_invalid' };
      const entitlement = entitlements.get(claim.entitlementId)!;
      if (claim.state === 'used') return { outcome: 'refused', reason: entitlement.subject.kind === 'claimed' && entitlement.subject.consumerSubject !== consumerSubject ? 'already_claimed_by_other' : 'claim_used' };
      if (claim.state === 'superseded') return { outcome: 'refused', reason: 'claim_superseded' };
      if (claim.state === 'expired' || Date.parse(claim.expiresAt) <= Date.parse(at)) {
        claims.set(claim.claimId, { ...claim, state: 'expired' });
        return { outcome: 'refused', reason: 'claim_expired' };
      }
      if (entitlement.state !== 'awaiting_claim' || entitlement.subject.kind !== 'unclaimed') return { outcome: 'refused', reason: entitlement.subject.kind === 'claimed' && entitlement.subject.consumerSubject !== consumerSubject ? 'already_claimed_by_other' : 'entitlement_not_claimable' };
      const window = accessWindow(entitlement.accessDurationDays, new Date(at));
      const claimed = move(entitlement, entitlement.revision, 'active', { subject: { kind: 'claimed', consumerSubject, claimedAt: at }, window });
      claims.set(claim.claimId, { ...claim, state: 'used', usedAt: at, usedBy: consumerSubject });
      const enrollment = educationEnrollment.parse({ enrollmentId: randomUUID(), entitlementId: claimed.entitlementId, consumerSubject, curriculum: claimed.curriculum, state: 'active', revision: 1, phaseIndex: 0, startedAt: at, updatedAt: at });
      enrollments.set(enrollment.enrollmentId, enrollment);
      events.push({ entitlementId: claimed.entitlementId, kind: 'claimed', reference: null, at });
      return { outcome: 'claimed', entitlement: claimed, enrollment: structuredClone(enrollment) };
    },
    async readEntitlement(entitlementId) { fault('readEntitlement'); const e = entitlements.get(entitlementId); return e ? structuredClone(e) : null; },
    async entitlementForOrder(orderId) { fault('entitlementForOrder'); const e = byOrder(orderId); return e ? structuredClone(e) : null; },
    async access(consumerSubject) {
      fault('access');
      const mine = [...entitlements.values()].filter(e => e.subject.kind === 'claimed' && e.subject.consumerSubject === consumerSubject);
      return { entitlements: mine.map(e => structuredClone(e)), enrollments: [...enrollments.values()].filter(n => n.consumerSubject === consumerSubject).map(n => structuredClone(n)) };
    },
    async recordPolicy(orderId, kind, reference, at) {
      fault('recordPolicy');
      const entitlement = byOrder(orderId);
      if (!entitlement) throw new EducationLedgerError('not_found');
      const target = kind === 'operator_release' ? 'active' : kind === 'operator_revoke' ? 'revoked' : kind === 'refund' ? 'held_refund' : kind === 'dispute' || kind === 'chargeback' ? 'held_dispute' : 'held_policy';
      // The event is recorded with the transition it causes, or not at all: a refused transition leaves no half-record, as the SQL transaction would not.
      const record = () => events.push({ entitlementId: entitlement.entitlementId, kind, reference, at });
      if (entitlement.state === target) { record(); return structuredClone(entitlement); }
      // A release of an unclaimed entitlement returns it to awaiting_claim, not to active: nobody holds it yet.
      const next = target === 'active' && entitlement.subject.kind === 'unclaimed' ? 'awaiting_claim' : target;
      if (next === 'awaiting_claim') {
        if (!['held_refund', 'held_dispute', 'held_policy'].includes(entitlement.state)) throw new EducationLedgerError('transition_refused');
        const updated = programEntitlement.parse({ ...entitlement, state: 'awaiting_claim', revision: entitlement.revision + 1, policy: { kind, reference, recordedAt: at }, updatedAt: stamp() });
        entitlements.set(updated.entitlementId, updated); record();
        return structuredClone(updated);
      }
      const moved = move(entitlement, entitlement.revision, next, { policy: { kind, reference, recordedAt: at } });
      record();
      return moved;
    },
    async transition(entitlementId, expectedRevision, next) {
      fault('transition');
      const entitlement = entitlements.get(entitlementId);
      if (!entitlement) throw new EducationLedgerError('not_found');
      return move(entitlement, expectedRevision, next);
    },
    async expireDue(at) {
      fault('expireDue');
      const due = [...entitlements.values()].filter(e => e.state === 'active' && e.window?.endsAt !== null && e.window !== null && Date.parse(e.window.endsAt!) <= Date.parse(at));
      return due.map(e => move(e, e.revision, 'expired'));
    },
    async listForProgram(organizationId, programId) {
      fault('listForProgram');
      const mine = [...entitlements.values()].filter(e => e.organizationId === organizationId && e.programId === programId);
      const ids = new Set(mine.map(e => e.entitlementId));
      const orders = [...options.orders.orders.values()].filter(o => o.organizationId === organizationId && o.programId === programId).map(o => structuredClone(o));
      return { orders, entitlements: mine.map(e => structuredClone(e)), enrollments: [...enrollments.values()].filter(n => ids.has(n.entitlementId)).map(n => structuredClone(n)), claims: [...claims.values()].filter(c => ids.has(c.entitlementId)).map(c => structuredClone(c)) };
    },
    async staffCurriculum(actor, entitlementId) {
      fault('staffCurriculum');
      const entitlement = entitlements.get(entitlementId);
      if (!entitlement || entitlement.organizationId !== actor.organizationId) return { outcome: 'withheld', entitlementId, reason: 'not_owner' };
      const content = options.content ? await options.content(entitlement.curriculum).catch(() => null) : null;
      if (!content) return { outcome: 'withheld', entitlementId, reason: 'version_missing' };
      if (content.sourceDigest !== entitlement.curriculum.sourceDigest) return { outcome: 'withheld', entitlementId, reason: 'digest_mismatch' };
      return { outcome: 'served', entitlementId, curriculum: entitlement.curriculum, title: content.title, phases: content.phases };
    },
  };
  return ledger;
}
