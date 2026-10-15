import { z } from 'zod';
import { DECISION_REASONS } from './workforceJoinReview';

/**
 * A practitioner's own application to join a clinic or to propose one (workforce-application/1), shared by the BLOCKED
 * applicant API (src/server/clinical-core/aws-workforce-applications-api.ts) and the Desktop applicant journey.
 *
 * The applicant names a request id (a retry key, not authority) and either the clinic they were given a code for or a
 * proposed clinic name. Never a person, a role, a clinic authority, an email or a production flag: the service takes
 * the subject and the email digest from the current Cognito account.
 *
 * `clinicalAccess` is the database's answer, for an approved request, to whether the current-membership sign-in would
 * admit this account to that clinic now. A service that does not report it says nothing about access, so it is
 * `unknown`; it is never read as available.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
export const PROPOSED_CLINIC_NAME = z.string().transform(value => value.trim())
  .pipe(z.string().min(3).max(120).regex(/^[^\u0000-\u001f\u007f]+$/));

export const applicationSubmission = z.discriminatedUnion('kind', [
  z.object({ requestId: uuid, kind: z.literal('join'), organizationId: uuid }).strict(),
  z.object({ requestId: uuid, kind: z.literal('create_clinic'), proposedLabel: PROPOSED_CLINIC_NAME }).strict(),
]);
export type ApplicationSubmission = z.infer<typeof applicationSubmission>;
export const applicationWithdrawal = z.object({ requestId: uuid }).strict();

export const CLINICAL_ACCESS = ['available', 'held_for_clinic_activation', 'not_available', 'unknown'] as const;
export type ClinicalAccess = typeof CLINICAL_ACCESS[number];
export const applicationEntry = z.object({
  id: uuid,
  kind: z.enum(['join', 'create_clinic']),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
  createdAt: z.string().min(10).max(40),
  organizationId: uuid.nullable(),
  decisionReason: z.enum(DECISION_REASONS).nullable(),
  clinicalAccess: z.enum(CLINICAL_ACCESS).nullable(),
}).strict().superRefine((entry, context) => {
  // Access is a property of an approved request only; any other pairing is not an answer.
  if ((entry.status === 'approved') !== (entry.clinicalAccess !== null)) context.addIssue({ code: 'custom', message: 'clinical_access_mismatch' });
});
export type ApplicationEntry = z.infer<typeof applicationEntry>;
export const applicationStatus = z.array(applicationEntry).max(50);

/** What a status row from either the onboarding parent or the approval-authority successor becomes, or a throw. */
export function normalizeApplicationRows(rows: unknown): ApplicationEntry[] {
  if (!Array.isArray(rows) || rows.length > 50) throw new Error('application_status_invalid');
  return applicationStatus.parse(rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const value = row as Record<string, unknown>;
    return { ...value, decisionReason: value.decisionReason ?? null,
      clinicalAccess: value.status === 'approved' ? value.clinicalAccess ?? 'unknown' : value.clinicalAccess ?? null };
  }));
}

/** The applicant API's refusals. Each is about the signed-in account's own state, never about a clinic's. */
export const APPLICATION_REFUSALS = ['workforce_application_not_released', 'workforce_applicant_refused', 'workforce_applicant_mfa_required',
  'workforce_applicant_email_unverified', 'workforce_application_already_pending', 'workforce_application_not_found',
  'workforce_application_already_decided', 'workforce_application_rate_limited', 'workforce_application_unavailable',
  'identity_unavailable', 'request_invalid'] as const;
export type ApplicationRefusal = typeof APPLICATION_REFUSALS[number];
