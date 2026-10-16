import { z } from 'zod';
import { PROPOSED_CLINIC_NAME } from './workforceApplication';

/**
 * A practitioner creating a NEW clinic (workforce-clinic-bootstrap/1), shared by the BLOCKED bootstrap service
 * (src/server/clinical-core/workforce-clinic-bootstrap.ts), its Desktop route (src/app/api/onboarding/clinic-bootstrap)
 * and the applicant journey.
 *
 * The browser names a request id (a retry key, not authority) and a clinic name, and nothing else: never a clinic, a
 * person, a role, a subject, an address, an assurance or a flag. The service takes the subject and the address digest
 * from the current identity-provider account, and only it may attest that the address is confirmed and MFA is active.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
export const CLINIC_BOOTSTRAP_NAME = PROPOSED_CLINIC_NAME;
export const clinicBootstrapSubmission = z.object({ requestId: uuid, clinicLabel: CLINIC_BOOTSTRAP_NAME }).strict();
export type ClinicBootstrapSubmission = z.infer<typeof clinicBootstrapSubmission>;

export const BOOTSTRAP_SUSPENSION_REASONS = ['security_concern', 'identity_not_verified', 'agreement_not_accepted', 'operator_request'] as const;
export type BootstrapSuspensionReason = typeof BOOTSTRAP_SUSPENSION_REASONS[number];
export const clinicBootstrapAnswer = z.object({
  requestId: uuid, organizationId: uuid, membershipId: uuid, status: z.enum(['active', 'suspended']),
  clinicalAccess: z.enum(['available', 'not_available']), duplicate: z.boolean(),
}).strict();
export const clinicBootstrapState = z.object({
  requestId: uuid, organizationId: uuid, status: z.enum(['active', 'suspended']),
  suspensionReason: z.enum(BOOTSTRAP_SUSPENSION_REASONS).nullable(),
  clinicalAccess: z.enum(['available', 'not_available']), createdAt: z.string().max(40),
}).strict();
export type ClinicBootstrapAnswer = z.infer<typeof clinicBootstrapAnswer>;
export type ClinicBootstrapState = z.infer<typeof clinicBootstrapState>;

/**
 * Every answer the bootstrap route may give the browser by name. Each is about the signed-in account's own state;
 * none says anything about another account, address or clinic. Anything else reaches the browser as
 * `workforce_application_unavailable`.
 */
export const CLINIC_BOOTSTRAP_REFUSALS = ['workforce_clinic_bootstrap_not_released', 'workforce_applicant_refused',
  'workforce_applicant_mfa_required', 'workforce_applicant_email_unverified', 'workforce_clinic_bootstrap_conflict',
  'workforce_clinic_bootstrap_exists', 'workforce_application_already_pending', 'workforce_application_rate_limited',
  'workforce_application_unavailable', 'identity_unavailable', 'request_invalid', 'application_service_not_configured',
  'reauth_required', 'identity_refused'] as const;
export type ClinicBootstrapReply = typeof CLINIC_BOOTSTRAP_REFUSALS[number];
