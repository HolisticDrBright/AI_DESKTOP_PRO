import { reviewedAccessTerms, type ReviewedAccessTerms } from '../../contracts/programOffers';

/**
 * Who may call what in program commerce, as the source states it. The SQL successor
 * (infra/aws-clinical-core/source-candidates/program-commerce-authority.sql, BLOCKED) enforces the
 * same split with database roles; the types here make the request path name its caller.
 *
 *   consumer  a verified consumer identity: its OWN claim, access and entitlement reads. The subject
 *             is the verified request context, never a request body and never an argument the API
 *             path chooses.
 *   staff     a verified workforce identity of one clinic: that clinic's commercial status and the
 *             exact version a purchaser was sold.
 *   operator  a trusted operator context the host resolves: policy holds, release, revocation,
 *             entitlement transitions, replacement codes, recording a reviewed access-terms entry.
 *   worker    the background host: intake, observation, settlement, bounded expiry. It is not a
 *             caller type: it is a separate database session (commercial_education_worker), so a
 *             request handler cannot reach its functions even by passing the right shape.
 */
export type ConsumerCaller = { kind: 'consumer'; personId: string; identitySubject: string };
export type StaffCaller = { kind: 'staff'; personId: string; organizationId: string; identitySubject: string };

export const isConsumerCaller = (value: unknown): value is ConsumerCaller =>
  !!value && typeof value === 'object' && (value as ConsumerCaller).kind === 'consumer' && typeof (value as ConsumerCaller).personId === 'string' && /^[A-Za-z0-9:_-]{8,128}$/.test((value as ConsumerCaller).identitySubject ?? '');
export const isStaffCaller = (value: unknown): value is StaffCaller =>
  !!value && typeof value === 'object' && (value as StaffCaller).kind === 'staff' && typeof (value as StaffCaller).personId === 'string' && typeof (value as StaffCaller).organizationId === 'string' && typeof (value as StaffCaller).identitySubject === 'string';

/** SHA-256 of infra/aws-clinical-core/source-candidates/program-commerce-authority.sql (successor; parent: the delivery successor), held equal to the file by its test. */
export const PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 = '11e53bc2e7ff13d1aa66c219fc9da1c4e768faef8ea42e1ebc44ed375a8c6c62';

/** Looks up the reviewed entry for an access-terms version; null when nobody reviewed it. */
export type AccessTermsRegistry = (version: string) => ReviewedAccessTerms | null;

/**
 * The reviewed access terms this source ships: NONE. Each entry is a decision (duration policy, Core
 * dependency, refund and renewal policy) that only Brandon's review can record; until then every
 * paid offer stays held at publication and at activation.
 */
export const REVIEWED_ACCESS_TERMS: readonly ReviewedAccessTerms[] = [];

/** The reviewer name every fixture entry carries, so no screen, log or test can mistake one for a decision. */
export const FICTIONAL_REVIEW_FIXTURE = 'FICTIONAL REVIEW FIXTURE';
/** Fixture terms for the fictional ledgers and tests only. Never in the registry above. */
export const FICTIONAL_ACCESS_TERMS: readonly ReviewedAccessTerms[] = [reviewedAccessTerms.parse({
  version: 'education-access-terms/1', durationPolicy: 'fixed_days', corePolicy: 'not_required',
  refundPolicyRef: 'fictional-refund-policy/1', renewalPolicyRef: 'fictional-renewal-policy/1',
  reviewedBy: FICTIONAL_REVIEW_FIXTURE, evidenceSha256: 'f'.repeat(64),
}), reviewedAccessTerms.parse({
  // The only way a null duration means "no end": a reviewed entry that says so.
  version: 'education-access-terms/2', durationPolicy: 'indefinite', corePolicy: 'not_required',
  refundPolicyRef: 'fictional-refund-policy/1', renewalPolicyRef: 'fictional-renewal-policy/1',
  reviewedBy: FICTIONAL_REVIEW_FIXTURE, evidenceSha256: 'f'.repeat(64),
})];

export function accessTermsRegistry(entries: readonly ReviewedAccessTerms[]): AccessTermsRegistry {
  const byVersion = new Map(entries.map(entry => [entry.version, reviewedAccessTerms.parse(entry)]));
  return version => byVersion.get(version) ?? null;
}
