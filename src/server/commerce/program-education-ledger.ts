import { randomUUID } from 'node:crypto';
import {
  ENTITLEMENT_TRANSITIONS, PROGRAM_EDUCATION_ACCESS_CONTRACT, accessWindow, educationEnrollment, programClaim, programEntitlement,
  type DeliveryState, type EducationCurriculumRead, type EducationEnrollment, type EntitlementState, type PolicyEventKind, type ProgramClaim, type ProgramEntitlement,
} from '../../contracts/programEducationAccess';
import type { ProgramOrder } from '../../contracts/programCheckout';
import {
  PROGRAM_EDUCATION_PROGRESS_CONTRACT, courseLessons, educationProgress, sameLesson,
  type EducationProgress, type EducationProgressOutcome, type EducationProgressRead, type EducationProgressRequest, type LessonCompletion, type LessonRef, type ProgressReceipt,
} from '../../contracts/programEducationProgress';
import type { ProgramCheckoutLedger } from './program-checkout-ledger';
import { accessTermsHolds } from '../../contracts/programOffers';
import { FICTIONAL_ACCESS_TERMS, accessTermsRegistry, isConsumerCaller, isStaffCaller, type AccessTermsRegistry, type ConsumerCaller, type StaffCaller } from './program-commerce-authority';

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
 *   - a claimed entitlement cannot be claimed again by anyone else ("already claimed by other"); the
 *     same verified subject presenting its used code again (a retry after a lost reply) gets the same
 *     receipt and nothing changes: no second enrollment, no second window;
 *   - the code's digest is private to the ledger and appears in no reply; the code itself exists only
 *     SEALED in the delivery queue until delivery is accepted, fails for good, or the claim stops being
 *     usable, and is erased then;
 *   - a replacement code is an operator act: every issued claim of the entitlement is superseded and
 *     its delivery withdrawn in the same step the new claim and its delivery are created;
 *   - every change raises the revision and follows ENTITLEMENT_TRANSITIONS; the order, offer and
 *     curriculum columns are immutable; policy events are appended, never edited;
 *   - the access read returns the subject's own rows only; an unclaimed entitlement belongs to nobody;
 *   - the consumer methods take the verified caller, never a subject string; the staff read takes a
 *     clinician of that clinic; policy, transitions and replacement codes take an operator context;
 *   - a claim of an entitlement whose access terms are held (unreviewed, duration undecided, Core
 *     dependency, refund or renewal undecided) is refused `terms_undecided` and binds nothing.
 */
export type EducationLedgerCategory = 'store_unavailable' | 'not_found' | 'transition_refused' | 'revision_stale' | 'settlement_refused' | 'request_invalid';
export class EducationLedgerError extends Error {
  constructor(readonly category: EducationLedgerCategory, readonly detail?: string) { super(category); this.name = 'EducationLedgerError'; }
}

export type SettlementReceipt = { entitlement: ProgramEntitlement; claim: ProgramClaim; created: boolean };
/** A one-time code sealed for delivery: opaque to the ledger, opened only by the delivery step's key. */
export type SealedCode = { keyRef: string; iv: string; ciphertext: string; tag: string };
/** What settlement or a replacement hands the ledger: the claim's id, the code's digest, its expiry and the sealed code. Never the code. */
export type ClaimIssue = { claimId: string; tokenHash: string; claimExpiresAt: string; sealed: SealedCode };
/** One delivery as the delivery step sees it. `sealed` is null once there is nothing left to send. */
export type DeliveryRecord = {
  deliveryId: string; claimId: string; entitlementId: string; orderId: string; state: DeliveryState; sealed: SealedCode | null;
  attempts: number; nextAttemptAt: string | null; lastAttemptAt: string | null; acceptedAt: string | null; providerRef: string | null; lastOutcome: string | null; claimExpiresAt: string;
};
export type DeliveryOutcome = { state: 'accepted' | 'failed' | 'provider_unknown'; providerRef?: string | null; detail: string; nextAttemptAt?: string | null; at: string };
/** The trusted operator context the host resolves; a learner or the general API role never has one. */
export type OperatorContext = { kind: 'operator'; operatorId: string };
export const MAX_DELIVERY_ATTEMPTS = 6;
export type ClaimOutcome =
  | { outcome: 'claimed'; entitlement: ProgramEntitlement; enrollment: EducationEnrollment }
  | { outcome: 'refused'; reason: 'claim_invalid' | 'claim_expired' | 'claim_used' | 'claim_superseded' | 'entitlement_not_claimable' | 'already_claimed_by_other' | 'terms_undecided' };

export interface ProgramEducationLedger {
  /** Create the entitlement and its first claim for a verified order, or return the ones that exist. The token hash is the caller's; a fresh hash is issued only when nothing existed. */
  settle(order: ProgramOrder, issue: ClaimIssue, expectedAccountRef: string): Promise<SettlementReceipt>;
  /** Verified, paid orders with no entitlement yet: the durable admitted work a crashed settlement left behind. */
  unsettledOrders(limit: number): Promise<ProgramOrder[]>;
  /** The verified caller presents a code's digest; the ledger's clock decides expiry. */
  claim(tokenHash: string, caller: ConsumerCaller): Promise<ClaimOutcome>;
  /** Worker reads (settlement and status of one order); no request path reaches them. */
  readEntitlement(entitlementId: string): Promise<ProgramEntitlement | null>;
  entitlementForOrder(orderId: string): Promise<ProgramEntitlement | null>;
  /** The caller's own entitlements and enrollments, with the caller's own ended windows expired first. */
  access(caller: ConsumerCaller): Promise<{ entitlements: ProgramEntitlement[]; enrollments: EducationEnrollment[] }>;
  /** One entitlement, only when the caller owns it; null otherwise. */
  ownEntitlement(caller: ConsumerCaller, entitlementId: string): Promise<ProgramEntitlement | null>;
  recordPolicy(operator: OperatorContext, orderId: string, kind: PolicyEventKind, reference: string, at: string): Promise<ProgramEntitlement>;
  transition(operator: OperatorContext, entitlementId: string, expectedRevision: number, next: EntitlementState): Promise<ProgramEntitlement>;
  /** The worker's sweep: at most `limit` ended windows, by the ledger's own clock. */
  expireDue(limit: number): Promise<ProgramEntitlement[]>;
  /** Everything about the staff caller's clinic's program, for the status view: every order and entitlement state, never a subject's identity beyond its opaque form. */
  listForProgram(staff: StaffCaller, programId: string): Promise<{ orders: ProgramOrder[]; entitlements: ProgramEntitlement[]; enrollments: EducationEnrollment[]; claims: ProgramClaim[] }>;
  /** The staff read of the exact purchased version for one of the clinic's entitlements. */
  staffCurriculum(staff: StaffCaller, entitlementId: string): Promise<EducationCurriculumRead>;
  /**
   * The caller's own exact purchased curriculum, read and checked (owner, active window, version, digest)
   * by the store itself. A SQL store implements it (`education_curriculum_for_caller`); the in-memory
   * ledger does not, and settlement then reads content through its own callback as before.
   */
  curriculumForCaller?(caller: ConsumerCaller, entitlementId: string): Promise<EducationCurriculumRead>;
  /** Deliveries due now: pending or outcome-unknown, still usable, oldest first, bounded. Unusable ones are withdrawn on the way. */
  dueDeliveries(at: string, limit: number): Promise<DeliveryRecord[]>;
  /** Record one delivery attempt at the attempt count the caller read; a stale count is refused. */
  recordDelivery(deliveryId: string, expectedAttempts: number, outcome: DeliveryOutcome): Promise<DeliveryRecord>;
  /** Replace the code of an unclaimed entitlement: supersede every issued claim and withdraw its delivery, then issue the new one. Operator only. */
  reissueClaim(operator: OperatorContext, entitlementId: string, issue: ClaimIssue): Promise<{ claim: ProgramClaim; superseded: number }>;
  /** The caller's own progress through one of their courses (program-education-progress/1). */
  progress(caller: ConsumerCaller, entitlementId: string): Promise<EducationProgressRead>;
  /** One explicit write (a completion or a resume position) by the caller, revision-checked and idempotent per request id. */
  recordProgress(caller: ConsumerCaller, command: Extract<EducationProgressRequest, { action: 'complete' | 'position' }>): Promise<EducationProgressOutcome>;
}

export type FictionalEducationLedgerOptions = { orders: ProgramCheckoutLedger & { orders: Map<string, ProgramOrder> }; now?: () => Date; /** Reviewed access terms; the fixture entries by default, which read as fixtures. */ reviewedTerms?: AccessTermsRegistry; faults?: { before?: (operation: string) => void }; /** The fixture's published content by version id, for the staff read. */ content?: (binding: ProgramEntitlement['curriculum']) => Promise<{ title: string; phases: unknown[]; sourceDigest: string } | null> };

export function createFictionalEducationLedger(options: FictionalEducationLedgerOptions) {
  const now = options.now ?? (() => new Date());
  const stamp = () => now().toISOString();
  const reviewedTerms = options.reviewedTerms ?? accessTermsRegistry(FICTIONAL_ACCESS_TERMS);
  const operatorOnly = (operator: OperatorContext) => { if (operator?.kind !== 'operator' || !operator.operatorId) throw new EducationLedgerError('request_invalid'); };
  const consumerOnly = (caller: ConsumerCaller) => { if (!isConsumerCaller(caller)) throw new EducationLedgerError('request_invalid'); return caller.identitySubject; };
  const staffOnly = (staff: StaffCaller) => { if (!isStaffCaller(staff)) throw new EducationLedgerError('request_invalid'); };
  const entitlements = new Map<string, ProgramEntitlement>();
  const claims = new Map<string, Omit<ProgramClaim, 'delivery'> & { tokenHash: string }>();
  const deliveries = new Map<string, DeliveryRecord>();
  const enrollments = new Map<string, EducationEnrollment>();
  /** The claim as anyone outside the ledger sees it: no digest, its delivery state attached. */
  const claimView = (claim: Omit<ProgramClaim, 'delivery'> & { tokenHash: string }): ProgramClaim => {
    const { tokenHash: _private, ...rest } = claim;
    void _private;
    const delivery = [...deliveries.values()].find(d => d.claimId === claim.claimId);
    return programClaim.parse({ ...rest, delivery: delivery ? { state: delivery.state, attempts: delivery.attempts, lastAttemptAt: delivery.lastAttemptAt, acceptedAt: delivery.acceptedAt } : { state: 'withdrawn', attempts: 0, lastAttemptAt: null, acceptedAt: null } });
  };
  /** Stop sending a claim's code: nothing more will go out, and the sealed copy is erased. */
  const withdraw = (claimId: string, detail: string) => {
    for (const delivery of deliveries.values()) {
      if (delivery.claimId === claimId && (delivery.state === 'pending' || delivery.state === 'provider_unknown')) deliveries.set(delivery.deliveryId, { ...delivery, state: 'withdrawn', sealed: null, nextAttemptAt: null, lastOutcome: detail });
      else if (delivery.claimId === claimId) deliveries.set(delivery.deliveryId, { ...delivery, sealed: null });
    }
  };
  const queue = (claimId: string, entitlementId: string, orderId: string, sealed: SealedCode, claimExpiresAt: string) => {
    const delivery: DeliveryRecord = { deliveryId: randomUUID(), claimId, entitlementId, orderId, state: 'pending', sealed, attempts: 0, nextAttemptAt: stamp(), lastAttemptAt: null, acceptedAt: null, providerRef: null, lastOutcome: null, claimExpiresAt };
    deliveries.set(delivery.deliveryId, delivery);
  };
  type ProgressRecord = { revision: number; completed: LessonCompletion[]; position: LessonRef | null; updatedAt: string | null; receipts: Map<string, ProgressReceipt> };
  const progressRecords = new Map<string, ProgressRecord>();
  const progressOf = (entitlement: ProgramEntitlement, enrollment: EducationEnrollment): EducationProgress => {
    const record = progressRecords.get(enrollment.enrollmentId);
    return educationProgress.parse({
      contract: PROGRAM_EDUCATION_PROGRESS_CONTRACT, entitlementId: entitlement.entitlementId, enrollmentId: enrollment.enrollmentId, curriculum: entitlement.curriculum,
      revision: record?.revision ?? 0, completed: record?.completed ?? [], position: record?.position ?? null, updatedAt: record?.updatedAt ?? null,
    });
  };
  /** The caller's own entitlement and enrollment, or null: another owner's id reveals nothing. */
  const ownEnrollment = (subject: string, entitlementId: string) => {
    const entitlement = entitlements.get(entitlementId);
    if (!entitlement || entitlement.subject.kind !== 'claimed' || entitlement.subject.consumerSubject !== subject) return null;
    const enrollment = [...enrollments.values()].find(n => n.entitlementId === entitlementId && n.consumerSubject === subject);
    return enrollment ? { entitlement, enrollment } : null;
  };
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
  const ledger: ProgramEducationLedger & { entitlements: typeof entitlements; claims: typeof claims; deliveries: typeof deliveries; enrollments: typeof enrollments; events: typeof events; reset(): void } = {
    entitlements, claims, deliveries, enrollments, events,
    reset() { entitlements.clear(); claims.clear(); deliveries.clear(); enrollments.clear(); progressRecords.clear(); events.length = 0; },
    async settle(order, issue, expectedAccountRef) {
      fault('settle');
      const existing = byOrder(order.orderId);
      if (existing) {
        const claim = [...claims.values()].find(c => c.entitlementId === existing.entitlementId && c.state === 'issued') ?? [...claims.values()].filter(c => c.entitlementId === existing.entitlementId).at(-1)!;
        return { entitlement: structuredClone(existing), claim: claimView(claim), created: false };
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
      if ([...claims.values()].some(c => c.claimId === issue.claimId || c.tokenHash === issue.tokenHash)) throw new EducationLedgerError('request_invalid');
      const claim = { claimId: issue.claimId, entitlementId: entitlement.entitlementId, tokenHash: issue.tokenHash, issuedAt: at, expiresAt: issue.claimExpiresAt, state: 'issued' as const, usedAt: null, usedBy: null };
      // One step: the entitlement, its claim and the sealed delivery exist together or not at all.
      entitlements.set(entitlement.entitlementId, entitlement); claims.set(claim.claimId, claim);
      queue(claim.claimId, entitlement.entitlementId, current.orderId, issue.sealed, issue.claimExpiresAt);
      events.push({ entitlementId: entitlement.entitlementId, kind: 'settled', reference: current.orderId, at });
      return { entitlement: structuredClone(entitlement), claim: claimView(claim), created: true };
    },
    async unsettledOrders(limit) {
      fault('unsettledOrders');
      return [...options.orders.orders.values()].filter(o => o.state === 'payment_verified' && o.verification?.paymentStatus === 'paid' && !byOrder(o.orderId)).slice(0, limit).map(o => structuredClone(o));
    },
    async claim(tokenHash, caller) {
      fault('claim');
      const consumerSubject = consumerOnly(caller);
      const at = stamp();
      const claim = [...claims.values()].find(c => c.tokenHash === tokenHash);
      if (!claim) return { outcome: 'refused', reason: 'claim_invalid' };
      const entitlement = entitlements.get(claim.entitlementId)!;
      if (claim.state === 'used') {
        if (claim.usedBy !== consumerSubject) return { outcome: 'refused', reason: 'already_claimed_by_other' };
        // The winner retrying after a lost reply: the same receipt, nothing new.
        const enrollment = [...enrollments.values()].find(n => n.entitlementId === entitlement.entitlementId && n.consumerSubject === consumerSubject);
        if (!enrollment) throw new EducationLedgerError('store_unavailable');
        return { outcome: 'claimed', entitlement: structuredClone(entitlement), enrollment: structuredClone(enrollment) };
      }
      if (claim.state === 'superseded') return { outcome: 'refused', reason: 'claim_superseded' };
      if (claim.state === 'expired' || Date.parse(claim.expiresAt) <= Date.parse(at)) {
        claims.set(claim.claimId, { ...claim, state: 'expired' });
        withdraw(claim.claimId, 'claim expired');
        return { outcome: 'refused', reason: 'claim_expired' };
      }
      if (entitlement.state !== 'awaiting_claim' || entitlement.subject.kind !== 'unclaimed') return { outcome: 'refused', reason: entitlement.subject.kind === 'claimed' && entitlement.subject.consumerSubject !== consumerSubject ? 'already_claimed_by_other' : 'entitlement_not_claimable' };
      // Activation holds the same terms publication holds: whatever an older, looser artifact let through, nothing binds on undecided terms.
      const pricing = options.orders.orders.get(entitlement.orderId)?.pricing ?? null;
      if (accessTermsHolds({ accessTermsVersion: entitlement.accessTermsVersion, accessDurationDays: entitlement.accessDurationDays, pricing }, reviewedTerms(entitlement.accessTermsVersion)).length) return { outcome: 'refused', reason: 'terms_undecided' };
      const window = accessWindow(entitlement.accessDurationDays, new Date(at));
      const claimed = move(entitlement, entitlement.revision, 'active', { subject: { kind: 'claimed', consumerSubject, claimedAt: at }, window });
      claims.set(claim.claimId, { ...claim, state: 'used', usedAt: at, usedBy: consumerSubject });
      withdraw(claim.claimId, 'claim used');
      const enrollment = educationEnrollment.parse({ enrollmentId: randomUUID(), entitlementId: claimed.entitlementId, consumerSubject, curriculum: claimed.curriculum, state: 'active', revision: 1, phaseIndex: 0, startedAt: at, updatedAt: at });
      enrollments.set(enrollment.enrollmentId, enrollment);
      events.push({ entitlementId: claimed.entitlementId, kind: 'claimed', reference: null, at });
      return { outcome: 'claimed', entitlement: claimed, enrollment: structuredClone(enrollment) };
    },
    async readEntitlement(entitlementId) { fault('readEntitlement'); const e = entitlements.get(entitlementId); return e ? structuredClone(e) : null; },
    async entitlementForOrder(orderId) { fault('entitlementForOrder'); const e = byOrder(orderId); return e ? structuredClone(e) : null; },
    async access(caller) {
      fault('access');
      const consumerSubject = consumerOnly(caller);
      for (const e of [...entitlements.values()]) {
        if (e.state === 'active' && e.subject.kind === 'claimed' && e.subject.consumerSubject === consumerSubject && e.window?.endsAt && Date.parse(e.window.endsAt) <= now().getTime()) move(e, e.revision, 'expired');
      }
      const mine = [...entitlements.values()].filter(e => e.subject.kind === 'claimed' && e.subject.consumerSubject === consumerSubject);
      return { entitlements: mine.map(e => structuredClone(e)), enrollments: [...enrollments.values()].filter(n => n.consumerSubject === consumerSubject).map(n => structuredClone(n)) };
    },
    async ownEntitlement(caller, entitlementId) {
      fault('ownEntitlement');
      const consumerSubject = consumerOnly(caller);
      const e = entitlements.get(entitlementId);
      return e && e.subject.kind === 'claimed' && e.subject.consumerSubject === consumerSubject ? structuredClone(e) : null;
    },
    async recordPolicy(operator, orderId, kind, reference, at) {
      fault('recordPolicy');
      operatorOnly(operator);
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
    async transition(operator, entitlementId, expectedRevision, next) {
      fault('transition');
      operatorOnly(operator);
      const entitlement = entitlements.get(entitlementId);
      if (!entitlement) throw new EducationLedgerError('not_found');
      return move(entitlement, expectedRevision, next);
    },
    async expireDue(limit) {
      fault('expireDue');
      const at = now().getTime();
      const due = [...entitlements.values()].filter(e => e.state === 'active' && e.window?.endsAt !== null && e.window !== null && Date.parse(e.window.endsAt!) <= at)
        .sort((a, b) => a.window!.endsAt!.localeCompare(b.window!.endsAt!)).slice(0, Math.max(1, Math.min(limit, 100)));
      return due.map(e => move(e, e.revision, 'expired'));
    },
    async listForProgram(staff, programId) {
      fault('listForProgram');
      staffOnly(staff);
      const organizationId = staff.organizationId;
      const mine = [...entitlements.values()].filter(e => e.organizationId === organizationId && e.programId === programId);
      const ids = new Set(mine.map(e => e.entitlementId));
      const orders = [...options.orders.orders.values()].filter(o => o.organizationId === organizationId && o.programId === programId).map(o => structuredClone(o));
      return { orders, entitlements: mine.map(e => structuredClone(e)), enrollments: [...enrollments.values()].filter(n => ids.has(n.entitlementId)).map(n => structuredClone(n)), claims: [...claims.values()].filter(c => ids.has(c.entitlementId)).map(claimView) };
    },
    async dueDeliveries(at, limit) {
      fault('dueDeliveries');
      const due: DeliveryRecord[] = [];
      for (const delivery of [...deliveries.values()].sort((a, b) => (a.nextAttemptAt ?? '').localeCompare(b.nextAttemptAt ?? ''))) {
        // Due: never attempted, or its retry time has come.
        if ((delivery.state !== 'pending' && delivery.state !== 'provider_unknown') || !delivery.nextAttemptAt || (delivery.attempts > 0 && delivery.nextAttemptAt > at)) continue;
        const claim = claims.get(delivery.claimId)!;
        if (claim.state !== 'issued' || Date.parse(claim.expiresAt) <= Date.parse(at)) { withdraw(claim.claimId, claim.state === 'issued' ? 'claim expired' : `claim ${claim.state}`); continue; }
        due.push(structuredClone(deliveries.get(delivery.deliveryId)!));
        if (due.length >= Math.max(1, Math.min(limit, 100))) break;
      }
      return due;
    },
    async recordDelivery(deliveryId, expectedAttempts, outcome) {
      fault('recordDelivery');
      const delivery = deliveries.get(deliveryId);
      if (!delivery) throw new EducationLedgerError('not_found');
      if (delivery.attempts !== expectedAttempts) throw new EducationLedgerError('revision_stale');
      if (delivery.state !== 'pending' && delivery.state !== 'provider_unknown') throw new EducationLedgerError('transition_refused');
      const attempts = delivery.attempts + 1;
      const exhausted = outcome.state === 'provider_unknown' && attempts >= MAX_DELIVERY_ATTEMPTS;
      const state: DeliveryState = exhausted ? 'failed' : outcome.state;
      const keep = state === 'provider_unknown';
      const updated: DeliveryRecord = { ...delivery, state, attempts, lastAttemptAt: outcome.at, acceptedAt: state === 'accepted' ? outcome.at : null, providerRef: outcome.providerRef ?? delivery.providerRef,
        lastOutcome: exhausted ? 'attempts exhausted: ' + outcome.detail : outcome.detail, sealed: keep ? delivery.sealed : null, nextAttemptAt: keep ? outcome.nextAttemptAt ?? stamp() : null };
      deliveries.set(deliveryId, updated);
      return structuredClone(updated);
    },
    async reissueClaim(operator, entitlementId, issue) {
      fault('reissueClaim');
      operatorOnly(operator);
      const entitlement = entitlements.get(entitlementId);
      if (!entitlement) throw new EducationLedgerError('not_found');
      if (entitlement.state !== 'awaiting_claim' || entitlement.subject.kind !== 'unclaimed') throw new EducationLedgerError('transition_refused', 'entitlement_not_claimable');
      if ([...claims.values()].some(c => c.claimId === issue.claimId || c.tokenHash === issue.tokenHash)) throw new EducationLedgerError('request_invalid');
      let superseded = 0;
      for (const claim of [...claims.values()]) {
        if (claim.entitlementId === entitlementId && claim.state === 'issued') { claims.set(claim.claimId, { ...claim, state: 'superseded' }); withdraw(claim.claimId, 'claim superseded'); superseded += 1; }
      }
      const at = stamp();
      const claim = { claimId: issue.claimId, entitlementId, tokenHash: issue.tokenHash, issuedAt: at, expiresAt: issue.claimExpiresAt, state: 'issued' as const, usedAt: null, usedBy: null };
      claims.set(claim.claimId, claim);
      queue(claim.claimId, entitlementId, entitlement.orderId, issue.sealed, issue.claimExpiresAt);
      events.push({ entitlementId, kind: 'transition', reference: 'claim reissued by operator', at });
      return { claim: claimView(claim), superseded };
    },
    async progress(caller, entitlementId) {
      fault('progress');
      const own = ownEnrollment(consumerOnly(caller), entitlementId);
      if (!own) return { outcome: 'refused', reason: 'not_owner' };
      return { outcome: 'read', progress: progressOf(own.entitlement, own.enrollment) };
    },
    async recordProgress(caller, command) {
      fault('recordProgress');
      const own = ownEnrollment(consumerOnly(caller), command.entitlementId);
      if (!own) return { outcome: 'refused', reason: 'not_owner', progress: null };
      const { entitlement, enrollment } = own;
      if (enrollment.enrollmentId !== command.enrollmentId) return { outcome: 'refused', reason: 'enrollment_mismatch', progress: null };
      const record = progressRecords.get(enrollment.enrollmentId) ?? { revision: 0, completed: [], position: null, updatedAt: null, receipts: new Map<string, ProgressReceipt>() };
      // The same request id answers with the same receipt, whatever happened since: a retry converges on one result.
      const earlier = record.receipts.get(command.requestId);
      if (earlier) {
        if (earlier.action !== command.action || !sameLesson(earlier.lesson, command.lesson)) return { outcome: 'refused', reason: 'request_conflict', progress: null };
        return { outcome: 'recorded', receipt: { ...earlier }, progress: progressOf(entitlement, enrollment) };
      }
      const at = now();
      if (entitlement.state !== 'active' || enrollment.state !== 'active' || !entitlement.window || Date.parse(entitlement.window.startsAt) > at.getTime() || (entitlement.window.endsAt !== null && Date.parse(entitlement.window.endsAt) <= at.getTime())) {
        return { outcome: 'refused', reason: 'not_active', progress: null };
      }
      const pin = command.curriculum, bought = entitlement.curriculum;
      if (pin.versionId !== bought.versionId || pin.version !== bought.version || pin.sourceDigest !== bought.sourceDigest) return { outcome: 'refused', reason: 'stale_version', progress: null };
      const content = options.content ? await options.content(entitlement.curriculum).catch(() => null) : null;
      if (!content || content.sourceDigest !== bought.sourceDigest) return { outcome: 'refused', reason: 'service_unavailable', progress: null };
      const lesson = courseLessons(content.phases).lessons.find(entry => sameLesson(entry.ref, command.lesson));
      if (!lesson) return { outcome: 'refused', reason: 'unknown_lesson', progress: null };
      if (command.action === 'complete' && !lesson.completable) return { outcome: 'refused', reason: 'not_completable', progress: null };
      if (record.revision !== command.expectedRevision) return { outcome: 'refused', reason: 'revision_stale', progress: progressOf(entitlement, enrollment) };
      const recordedAt = at.toISOString();
      const revision = record.revision + 1;
      const completed = command.action === 'complete' && !record.completed.some(entry => sameLesson(entry.lesson, command.lesson))
        ? [...record.completed, { lesson: { ...command.lesson }, completedAt: recordedAt, requestId: command.requestId }] : record.completed;
      const receipt: ProgressReceipt = { requestId: command.requestId, action: command.action, lesson: { ...command.lesson }, recordedAt, revision };
      const receipts = new Map(record.receipts).set(command.requestId, receipt);
      progressRecords.set(enrollment.enrollmentId, { revision, completed, position: command.action === 'position' ? { ...command.lesson } : record.position, updatedAt: recordedAt, receipts });
      return { outcome: 'recorded', receipt: { ...receipt }, progress: progressOf(entitlement, enrollment) };
    },
    async staffCurriculum(staff, entitlementId) {
      fault('staffCurriculum');
      staffOnly(staff);
      const entitlement = entitlements.get(entitlementId);
      if (!entitlement || entitlement.organizationId !== staff.organizationId) return { outcome: 'withheld', entitlementId, reason: 'not_owner' };
      const content = options.content ? await options.content(entitlement.curriculum).catch(() => null) : null;
      if (!content) return { outcome: 'withheld', entitlementId, reason: 'version_missing' };
      if (content.sourceDigest !== entitlement.curriculum.sourceDigest) return { outcome: 'withheld', entitlementId, reason: 'digest_mismatch' };
      return { outcome: 'served', entitlementId, curriculum: entitlement.curriculum, title: content.title, phases: content.phases };
    },
  };
  return ledger;
}
