import { z } from 'zod';

/**
 * A clinic administrator's review of practitioners asking to join the clinic their session selected
 * (workforce-join-review/1), shared by the Desktop caller and the service. The closed reason vocabularies are the BLOCKED
 * approval-authority candidate's (infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql):
 * no free text, because a narrative is where an email address or a health detail ends up.
 *
 * Approval carries the applicant's email address as the administrator knows it. The service turns it into a SHA-256 of
 * the normalized address and the database compares it with the digest of the applicant's verified account; the address
 * itself is never stored, logged or returned, and the queue never shows who applied.
 */
export const JOIN_APPROVAL_REASON = 'identity_confirmed_by_clinic' as const;
export const JOIN_REJECTION_REASONS = ['not_known_to_clinic', 'credentials_not_verified', 'clinic_not_accepting', 'duplicate_request'] as const;
export const REVOCATION_REASONS = ['left_clinic', 'credentials_lapsed', 'access_no_longer_needed', 'security_concern'] as const;
export const PROPOSAL_APPROVAL_REASON = 'clinic_proposal_verified' as const;
export const PROPOSAL_REJECTION_REASONS = ['clinic_proposal_incomplete', 'clinic_proposal_declined', 'duplicate_request'] as const;
export const DECISION_REASONS = [JOIN_APPROVAL_REASON, ...JOIN_REJECTION_REASONS, PROPOSAL_APPROVAL_REASON,
  'clinic_proposal_incomplete', 'clinic_proposal_declined'] as const;
export type JoinRejectionReason = typeof JOIN_REJECTION_REASONS[number];
export type RevocationReason = typeof REVOCATION_REASONS[number];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const email = z.string().max(320).transform(value => value.trim().toLowerCase())
  .pipe(z.string().min(3).max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/));
const timestamp = z.string().min(10).max(40);

export const joinReviewRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('approve'), requestId: uuid, applicantEmail: email }).strict(),
  z.object({ action: z.literal('reject'), requestId: uuid, reason: z.enum(JOIN_REJECTION_REASONS) }).strict(),
  z.object({ action: z.literal('revoke'), membershipId: uuid, reason: z.enum(REVOCATION_REASONS) }).strict(),
]);
export type JoinReviewRequest = z.infer<typeof joinReviewRequest>;

export const joinRequestEntry = z.object({
  id: uuid,
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
  createdAt: timestamp,
  decidedAt: timestamp.nullable(),
  decisionReason: z.enum(DECISION_REASONS).nullable(),
  membershipId: uuid.nullable(),
}).strict();
export type JoinRequestEntry = z.infer<typeof joinRequestEntry>;

export const joinReviewResponse = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), requests: z.array(joinRequestEntry).max(50) }).strict(),
  z.object({ action: z.literal('approve'), requestId: uuid, status: z.literal('approved'), membershipId: uuid, duplicate: z.boolean() }).strict(),
  z.object({ action: z.literal('reject'), requestId: uuid, status: z.literal('rejected'), reason: z.enum(JOIN_REJECTION_REASONS), duplicate: z.boolean() }).strict(),
  z.object({ action: z.literal('revoke'), membershipId: uuid, status: z.literal('suspended'), reason: z.enum(REVOCATION_REASONS), duplicate: z.boolean() }).strict(),
]);
export type JoinReviewResponse = z.infer<typeof joinReviewResponse>;

/** The answer to `request`, or a throw: an answer for another action or another record is not this request's answer. */
export function parseJoinReviewResponse(request: JoinReviewRequest, value: unknown): JoinReviewResponse {
  const answer = joinReviewResponse.parse(value);
  if (answer.action !== request.action) throw new Error('join_review_response_mismatch');
  if ((answer.action === 'approve' || answer.action === 'reject') && 'requestId' in request && answer.requestId !== request.requestId) throw new Error('join_review_response_mismatch');
  if (answer.action === 'revoke' && request.action === 'revoke' && answer.membershipId !== request.membershipId) throw new Error('join_review_response_mismatch');
  if (answer.action === 'reject' && request.action === 'reject' && answer.reason !== request.reason) {
    // A retried rejection answers the stored decision, which may carry the first reviewer's reason.
    if (!answer.duplicate) throw new Error('join_review_response_mismatch');
  }
  return answer;
}

/** Refusals the service names. Everything else is `service_unavailable`, never a guess. */
export const JOIN_REVIEW_REFUSALS = ['not_released', 'reauth_required', 'identity_refused', 'request_invalid', 'not_found',
  'conflict', 'applicant_mismatch', 'self_approval_refused', 'already_member', 'clinic_unavailable', 'service_unavailable'] as const;
export type JoinReviewRefusal = typeof JOIN_REVIEW_REFUSALS[number];
