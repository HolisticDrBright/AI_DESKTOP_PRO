import { z } from 'zod';

/**
 * Education access (program-education-access/1): what a verified program purchase becomes, and
 * nothing more.
 *
 * A verified order settles into ONE entitlement: the right of one subject to the exact purchased
 * curriculum (version id, number and digest) on the saved terms. It starts `awaiting_claim` with no
 * subject, because the Desktop's public checkout carries no consumer session; it binds to a subject
 * only when a separately delivered, expiring, one-time claim token is presented by a verified
 * consumer account. Possession of an email, an order number or a success address is not a claim.
 *
 * An entitlement is commercial access to education content. It is not clinic membership, not a
 * patient chart, not a practitioner assignment, not consent to share data, not a supplement release
 * and not a step in anyone's protocol; the enrollment it opens is a learner's own progress through
 * the purchased lessons and habits. A later bridge into the clinical protocol is the existing
 * assignment service's authority, with its connection, consent, Core checks, review and explicit
 * acceptance; nothing here calls it.
 *
 * The one-time code is delivered to the purchaser contact the payment processor holds, never to an
 * address a browser typed. Using it binds the subject once; the same verified subject presenting it
 * again (a retry after a lost reply) receives the same receipt, and anyone else is refused. A new
 * code replaces every earlier one atomically, and only an operator can ask for one.
 *
 * Policy events (refund, dispute, chargeback, renewal changes) move an entitlement to a HELD state
 * that is visible to the operator; no automatic refund, revocation, renewal charge or deletion is
 * decided by this contract. Expiry follows the saved access duration. A null duration is "no end"
 * only when the reviewed terms state it; otherwise it is undecided and the claim is refused.
 */
export const PROGRAM_EDUCATION_ACCESS_CONTRACT = 'program-education-access/1' as const;
const uuid = z.string().uuid();
/** The exact published curriculum an entitlement covers: the same binding the offer and the order carry (program-offer/1). This file is mirrored byte for byte into the consumer app, so the binding is spelled here rather than imported. */
export const curriculumBinding = z.object({ versionId: uuid, version: z.number().int().min(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type CurriculumBinding = z.infer<typeof curriculumBinding>;
const timestamp = z.string().datetime({ offset: true });
/** The consumer identity subject as the identity API verifies it: opaque, never contact information. */
export const consumerSubject = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);

export const ENTITLEMENT_STATES = ['awaiting_claim', 'active', 'expired', 'held_refund', 'held_dispute', 'held_policy', 'revoked'] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];
/** Monotonic in the sense that matters: nothing returns to awaiting_claim, and expired and revoked are final. */
export const ENTITLEMENT_TRANSITIONS: Readonly<Record<EntitlementState, readonly EntitlementState[]>> = {
  awaiting_claim: ['active', 'held_refund', 'held_dispute', 'held_policy', 'revoked', 'expired'],
  active: ['expired', 'held_refund', 'held_dispute', 'held_policy', 'revoked'],
  held_refund: ['active', 'revoked', 'expired'],
  held_dispute: ['active', 'revoked', 'expired'],
  held_policy: ['active', 'revoked', 'expired'],
  expired: [],
  revoked: [],
};

export const POLICY_EVENT_KINDS = ['refund', 'dispute', 'chargeback', 'renewal_cancelled', 'renewal_payment_failed', 'operator_release', 'operator_revoke'] as const;
export type PolicyEventKind = (typeof POLICY_EVENT_KINDS)[number];
/** Where a policy event sends an entitlement. Every money-related kind is a hold; release and revoke are the operator's recorded decisions. */
export const POLICY_EVENT_TARGET: Readonly<Record<PolicyEventKind, EntitlementState>> = {
  refund: 'held_refund', dispute: 'held_dispute', chargeback: 'held_dispute', renewal_cancelled: 'held_policy', renewal_payment_failed: 'held_policy',
  operator_release: 'active', operator_revoke: 'revoked',
};

export const entitlementSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unclaimed') }).strict(),
  z.object({ kind: z.literal('claimed'), consumerSubject, claimedAt: timestamp }).strict(),
]);

export const programEntitlement = z.object({
  contract: z.literal(PROGRAM_EDUCATION_ACCESS_CONTRACT),
  entitlementId: uuid,
  orderId: uuid,
  organizationId: uuid,
  programId: uuid,
  offerId: uuid,
  offerRevision: z.number().int().min(1),
  curriculum: curriculumBinding,
  accessTermsVersion: z.string().regex(/^education-access-terms\/[1-9][0-9]{0,3}$/),
  accessDurationDays: z.number().int().min(1).max(3650).nullable(),
  subject: entitlementSubject,
  state: z.enum(ENTITLEMENT_STATES),
  revision: z.number().int().min(1),
  /** Set at claim: when access started and, from the saved duration, when it ends; a null end exists only where the reviewed terms state that access has no end. */
  window: z.object({ startsAt: timestamp, endsAt: timestamp.nullable() }).strict().nullable(),
  /** The receipt this entitlement settled from. */
  settlement: z.object({ verificationEventId: z.string().nullable(), settledAt: timestamp }).strict(),
  /** The last policy event recorded, if any; the history is append-only in the ledger. */
  policy: z.object({ kind: z.enum(POLICY_EVENT_KINDS), reference: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/), recordedAt: timestamp }).strict().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((row, context) => {
  // The state machine binds the subject and opens the window at claim; an "active" row with neither is not a row of this contract.
  if (row.state === 'active' && (row.subject.kind !== 'claimed' || row.window === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'active_requires_claimed_subject_and_window', path: ['state'] });
  }
});
export type ProgramEntitlement = z.infer<typeof programEntitlement>;

export const CLAIM_STATES = ['issued', 'used', 'expired', 'superseded'] as const;
/**
 * Where delivery of a claim's one-time code stands. `pending`: queued and not yet attempted, or due
 * again; `provider_unknown`: an attempt was made and its outcome is unknown (retried under the same
 * provider key); `accepted`: the provider accepted the message, which is NOT proof it arrived;
 * `failed`: the provider refused it for good; `withdrawn`: the claim stopped being usable (used,
 * expired or superseded) before delivery finished, and nothing more will be sent.
 */
export const DELIVERY_STATES = ['pending', 'provider_unknown', 'accepted', 'failed', 'withdrawn'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export const claimDelivery = z.object({
  state: z.enum(DELIVERY_STATES),
  attempts: z.number().int().min(0),
  lastAttemptAt: timestamp.nullable(),
  acceptedAt: timestamp.nullable(),
}).strict();
/**
 * A claim as anyone outside the ledger sees it: its state and its delivery state. Neither the code
 * nor any digest of it is part of this shape; the ledger keeps the digest privately to recognise the
 * code, and the code itself exists only sealed for delivery.
 */
export const programClaim = z.object({
  claimId: uuid,
  entitlementId: uuid,
  issuedAt: timestamp,
  expiresAt: timestamp,
  state: z.enum(CLAIM_STATES),
  usedAt: timestamp.nullable(),
  usedBy: consumerSubject.nullable(),
  delivery: claimDelivery,
}).strict();
export type ProgramClaim = z.infer<typeof programClaim>;
/** How long a claim token stays valid. A decision for Brandon; the source value is a bound, not a policy. */
export const CLAIM_VALIDITY_DAYS = 7;

export const ENROLLMENT_STATES = ['active', 'paused', 'completed', 'withdrawn', 'withheld'] as const;
export const educationEnrollment = z.object({
  enrollmentId: uuid,
  entitlementId: uuid,
  consumerSubject,
  curriculum: curriculumBinding,
  state: z.enum(ENROLLMENT_STATES),
  revision: z.number().int().min(1),
  /** The learner's own position; never the clinical phase authority. */
  phaseIndex: z.number().int().min(0),
  startedAt: timestamp,
  updatedAt: timestamp,
}).strict();
export type EducationEnrollment = z.infer<typeof educationEnrollment>;

/* -------------------------------------------------------------- the reads */

/** What the owner's app may read: their entitlements and enrollments, nothing of anyone else's, and nothing clinical. */
export const educationAccessView = z.object({
  contract: z.literal(PROGRAM_EDUCATION_ACCESS_CONTRACT),
  consumerSubject,
  readAt: timestamp,
  entitlements: z.array(programEntitlement),
  enrollments: z.array(educationEnrollment),
}).strict();
export type EducationAccessView = z.infer<typeof educationAccessView>;

/** The exact purchased curriculum, pinned to the entitlement's version and digest, or the reason it cannot be served. */
export const educationCurriculumRead = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('served'), entitlementId: uuid, curriculum: curriculumBinding, title: z.string().min(1).max(240), phases: z.array(z.unknown()).min(1) }).strict(),
  z.object({ outcome: z.literal('withheld'), entitlementId: uuid, reason: z.enum(['not_active', 'not_owner', 'version_missing', 'digest_mismatch', 'service_unavailable']) }).strict(),
]);
export type EducationCurriculumRead = z.infer<typeof educationCurriculumRead>;

/** The clinic's commercial status for one program, under its own key: orders (program-checkout/1, parsed by the reader that holds that contract), entitlements, claims, enrollments. Nothing clinical. */
export const commercialStatus = z.object({
  orders: z.array(z.unknown()),
  entitlements: z.array(programEntitlement),
  claims: z.array(programClaim),
  enrollments: z.array(educationEnrollment),
  readAt: timestamp,
}).strict();
export type CommercialStatus = z.infer<typeof commercialStatus>;

export const educationAccessRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('access') }).strict(),
  z.object({ action: z.literal('claim'), token: z.string().regex(/^[A-Za-z0-9_-]{43,64}$/) }).strict(),
  z.object({ action: z.literal('curriculum'), entitlementId: uuid }).strict(),
]);
export type EducationAccessRequest = z.infer<typeof educationAccessRequest>;

/** `terms_undecided`: the access terms this entitlement was sold under are not (or no longer) a reviewed decision; nothing binds until they are. */
export const CLAIM_REFUSALS = ['claim_invalid', 'claim_expired', 'claim_used', 'claim_superseded', 'entitlement_not_claimable', 'already_claimed_by_other', 'terms_undecided', 'service_unavailable'] as const;
export type ClaimRefusal = (typeof CLAIM_REFUSALS)[number];

/** Whether the window this entitlement would open from `at` has an end, from the saved duration and nothing else. */
export function accessWindow(accessDurationDays: number | null, at: Date): { startsAt: string; endsAt: string | null } {
  return { startsAt: at.toISOString(), endsAt: accessDurationDays === null ? null : new Date(at.getTime() + accessDurationDays * 86_400_000).toISOString() };
}

export function isAccessActive(entitlement: Pick<ProgramEntitlement, 'state' | 'window'>, at: Date): boolean {
  if (entitlement.state !== 'active' || !entitlement.window) return false;
  return entitlement.window.endsAt === null || Date.parse(entitlement.window.endsAt) > at.getTime();
}

