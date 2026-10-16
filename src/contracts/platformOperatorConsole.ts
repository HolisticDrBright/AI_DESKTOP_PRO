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

export type OperatorProposal = z.infer<typeof operatorProposal>;
export type OperatorProposalDecision = z.infer<typeof operatorProposalDecision>;
export type BootstrappedClinic = z.infer<typeof bootstrappedClinic>;
export type BootstrappedClinicSuspension = z.infer<typeof bootstrappedClinicSuspension>;

/** Every refusal the operator routes may give by name. Anything else is `platform_operator_unavailable`. */
export const PLATFORM_OPERATOR_REFUSALS = ['platform_operator_not_released', 'platform_operator_sign_in_not_released',
  'platform_operator_refused', 'operator_sign_in_required', 'request_invalid', 'not_found', 'conflict',
  'operator_self_approval_refused', 'platform_operator_unavailable', 'operator_service_not_configured', 'identity_refused',
  'platform_operator_rate_limited'] as const;
export type PlatformOperatorRefusal = typeof PLATFORM_OPERATOR_REFUSALS[number];
