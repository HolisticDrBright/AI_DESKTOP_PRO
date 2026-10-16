import { z } from 'zod';
import { PROPOSAL_REJECTION_REASONS } from './workforceJoinReview';
import { BOOTSTRAP_SUSPENSION_REASONS } from './workforceClinicBootstrap';

/**
 * The platform operator's console (platform-operator-console/1), shared by the BLOCKED operator API candidate
 * (src/server/clinical-core/platform-operator-console.ts), its Desktop routes (src/app/api/operator) and the /operator
 * page.
 *
 * An operator reviews new-clinic proposals (approval is held: it creates a clinic and gives nobody patient access) and
 * may suspend a bootstrapped clinic with a closed-vocabulary reason. Every decision is recorded with its reason, and
 * the deciding operator appears only as a fingerprint. No reinstatement is defined, so none is offered. The browser
 * names only a request or clinic id and a reason from these lists; the operator's identity comes from the separate,
 * MFA-protected operator sign-in, never from the browser or a practitioner token.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const stamp = z.string().min(1).max(40);

export const operatorProposal = z.object({
  id: uuid, status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']), createdAt: stamp, decidedAt: stamp.nullable(),
  proposedLabel: z.string().min(3).max(120), decisionReason: z.string().max(64).nullable(),
}).strict();
export const operatorProposalDecisionRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), requestId: uuid }).strict(),
  z.object({ action: z.literal('reject'), requestId: uuid, reason: z.enum(PROPOSAL_REJECTION_REASONS) }).strict(),
]);
export const operatorProposalDecision = z.object({
  action: z.enum(['approve', 'reject']), requestId: uuid, status: z.enum(['approved', 'rejected']), organizationId: uuid.nullable(),
  membershipId: uuid.nullable(), decisionReason: z.string().max(64), activation: z.literal('held').nullable(), duplicate: z.boolean(),
}).strict();

export const bootstrappedClinicEvent = z.object({
  action: z.enum(['bootstrapped', 'suspended']), reason: z.enum(BOOTSTRAP_SUSPENSION_REASONS).nullable(), occurredAt: stamp,
  operator: z.string().regex(/^[0-9a-f]{16}$/).nullable(), byCaller: z.boolean(),
}).strict();
export const bootstrappedClinic = z.object({
  organizationId: uuid, clinicLabel: z.string().min(3).max(120), status: z.enum(['active', 'suspended']), createdAt: stamp,
  suspendedAt: stamp.nullable(), suspensionReason: z.enum(BOOTSTRAP_SUSPENSION_REASONS).nullable(), events: z.array(bootstrappedClinicEvent).max(10),
}).strict();
export const bootstrappedClinicSuspensionRequest = z.object({ organizationId: uuid, reason: z.enum(BOOTSTRAP_SUSPENSION_REASONS) }).strict();
export const bootstrappedClinicSuspension = z.object({
  organizationId: uuid, status: z.literal('suspended'), reason: z.enum(BOOTSTRAP_SUSPENSION_REASONS), duplicate: z.boolean(),
}).strict();

/**
 * The emergency revocation of one practitioner's login (workforce-identity-emergency-revocation/1, BLOCKED): a reasoned
 * decision that disables the workforce identity in every clinic, a different operator's approval or review, and the
 * identity provider's sign-out as a separate, pending-until-confirmed step. There is no restore: a wrongly revoked
 * practitioner is given a separately verified replacement credential, never the old login back.
 */
export const IDENTITY_REVOCATION_REASONS = ['suspected_compromise', 'credential_exposed', 'device_lost_or_stolen', 'practitioner_request', 'security_review'] as const;
const workforceSubject = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
export const identityRevocationRequest = z.object({
  requestId: uuid, identitySubject: workforceSubject, reason: z.enum(IDENTITY_REVOCATION_REASONS),
}).strict();
export const identityRevocationDecisionRequest = z.object({
  proposalId: uuid, decision: z.enum(['approve', 'decline', 'confirm', 'dispute']),
}).strict();
export const identityRevocationSummary = z.object({
  proposalId: uuid, requestId: uuid, reason: z.enum(IDENTITY_REVOCATION_REASONS),
  approvalMode: z.enum(['second_operator_before', 'independent_review_after']), proposedAt: stamp,
  state: z.enum(['awaiting_approval', 'declined', 'revoked']),
  review: z.enum(['awaiting_independent_approval', 'awaiting_independent_review', 'approved', 'declined', 'confirmed', 'disputed']),
  revocationId: uuid.nullable(), effect: z.enum(['disabled', 'already_disabled']).nullable(), revokedAt: stamp.nullable(),
  provider: z.enum(['not_started', 'pending', 'failed', 'complete']),
  duplicate: z.boolean().optional(), providerUsername: workforceSubject.nullable().optional(),
}).strict();
export const identityRevocationOutcome = z.object({
  summary: identityRevocationSummary,
  provider: z.array(z.object({ step: z.enum(['disable_user', 'global_sign_out']), outcome: z.enum(['succeeded', 'failed']),
    failure: z.enum(['not_found', 'throttled', 'unavailable', 'access_denied', 'timeout', 'unknown']).optional() }).strict()).max(2),
}).strict();
export type IdentityRevocationSummary = z.infer<typeof identityRevocationSummary>;

export type OperatorProposal = z.infer<typeof operatorProposal>;
export type OperatorProposalDecision = z.infer<typeof operatorProposalDecision>;
export type BootstrappedClinic = z.infer<typeof bootstrappedClinic>;
export type BootstrappedClinicSuspension = z.infer<typeof bootstrappedClinicSuspension>;

/** Every refusal the operator routes may give by name. Anything else is `platform_operator_unavailable`. */
export const PLATFORM_OPERATOR_REFUSALS = ['platform_operator_not_released', 'platform_operator_sign_in_not_released',
  'platform_operator_refused', 'operator_sign_in_required', 'request_invalid', 'not_found', 'conflict',
  'operator_self_approval_refused', 'platform_operator_unavailable', 'operator_service_not_configured', 'identity_refused',
  'platform_operator_rate_limited', 'operator_independent_approval_required'] as const;
export type PlatformOperatorRefusal = typeof PLATFORM_OPERATOR_REFUSALS[number];
