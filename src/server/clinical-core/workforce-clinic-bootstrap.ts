if (typeof window !== 'undefined') throw new Error('workforce-clinic-bootstrap is server-only');
import { z } from 'zod';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from './database';
import { BOOTSTRAP_SUSPENSION_REASONS, clinicBootstrapAnswer, clinicBootstrapState, clinicBootstrapSubmission, type ClinicBootstrapAnswer,
  type ClinicBootstrapState, type ClinicBootstrapSubmission } from '@/contracts/workforceClinicBootstrap';

/**
 * The distinct door for a practitioner who creates a NEW clinic: on completing sign-up (a confirmed address and an
 * active MFA method, read from the identity provider), the verified subject becomes the active owner of a new, empty
 * clinic and can create and open patient records there at once, and nowhere else. Existing-clinic applicants are not
 * served here: a join request still waits for the clinic's approval.
 *
 * Disabled at every layer until the production security, agreement, privacy and PHI reviews:
 * - `WORKFORCE_CLINIC_BOOTSTRAP_RELEASE` is `blocked`, so the service refuses before it reads an account or a row;
 * - the SQL candidate (infra/aws-clinical-core/source-candidates/workforce-new-clinic-bootstrap.sql) is BLOCKED and
 *   unregistered, and even applied it refuses until its owner-only release row is switched on;
 * - no Lambda entrypoint, route host or Desktop surface is deployed.
 * The currently applied path (the approval-authority successor) still holds every new clinic, so immediate access is
 * neither implemented in a live system nor reachable.
 */
export const WORKFORCE_CLINIC_BOOTSTRAP_RELEASE: 'blocked' | 'qualification' = 'blocked';
export const WORKFORCE_CLINIC_BOOTSTRAP_CANDIDATE_SHA256 = '82efb74c41fe8da9934538332398101cfb25e73006d59fa306746f637f1d8eb1';
export const WORKFORCE_CLINIC_BOOTSTRAP_ROLLBACK_SHA256 = 'd0702843c5019f96687aa037a6cceb0c8a3b73886f822e4d2b93e91540499d6d';
/** The only assurance the service may attest, after reading the account itself. */
export const BOOTSTRAP_ASSURANCE = 'verified_email_and_mfa' as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
/** What the browser may send: a request id it generated (for retries) and a name. Never a clinic, person, role or flag. */
export const clinicBootstrapRequest = clinicBootstrapSubmission;
export type ClinicBootstrapRequest = ClinicBootstrapSubmission;
const bootstrapAnswer = clinicBootstrapAnswer;
const bootstrapState = clinicBootstrapState;
export type { ClinicBootstrapAnswer, ClinicBootstrapState };

export type ClinicBootstrapRefusal = 'not_released' | 'assurance_required' | 'request_invalid' | 'conflict' | 'already_bootstrapped'
  | 'proposal_pending' | 'applicant_refused' | 'service_unavailable';
export class ClinicBootstrapError extends Error {
  constructor(readonly code: ClinicBootstrapRefusal) { super(code); }
}
/**
 * The candidate's refusal names. The production data client (rds-data-database.ts, Codex's file) does not classify these
 * yet, so through it they arrive unclassified and answer `service_unavailable`; the classification it needs is recorded
 * in docs/new-clinic-bootstrap-2026-10-16.md. An address bound to another account and a registered operator are
 * refused without saying which.
 */
export const BOOTSTRAP_SQL_REFUSALS: Readonly<Record<string, ClinicBootstrapRefusal>> = {
  workforce_clinic_bootstrap_not_released: 'not_released',
  workforce_bootstrap_assurance_required: 'assurance_required',
  workforce_bootstrap_invalid: 'request_invalid',
  workforce_bootstrap_conflict: 'conflict',
  workforce_clinic_bootstrap_exists: 'already_bootstrapped',
  workforce_request_pending: 'proposal_pending',
  workforce_binding_conflict: 'applicant_refused',
  workforce_operator_refused: 'applicant_refused',
  workforce_subject_invalid: 'request_invalid',
};
const parse = (value: unknown) => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } };
const classify = (error: unknown): ClinicBootstrapError => {
  if (error instanceof ClinicBootstrapError) return error;
  if (error instanceof ClinicalCoreDatabaseRejection && error.reason && BOOTSTRAP_SQL_REFUSALS[error.reason]) return new ClinicBootstrapError(BOOTSTRAP_SQL_REFUSALS[error.reason]!);
  return new ClinicBootstrapError('service_unavailable');
};

export type ClinicBootstrapStore = {
  bootstrap(input: { requestId: string; subject: string; emailSha256: string; clinicLabel: string; assurance: typeof BOOTSTRAP_ASSURANCE }): Promise<ClinicBootstrapAnswer>;
  state(subject: string): Promise<ClinicBootstrapState | null>;
};
/** The connection must run as `clinical_workforce_application`, which can call only the applicant functions. */
export function createClinicBootstrapDatabaseStore(database: ClinicalCoreDatabase): ClinicBootstrapStore {
  return {
    bootstrap: input => database.transaction(async tx => {
      const { rows } = await tx.query<{ data: unknown }>('select clinical_private.bootstrap_workforce_clinic($1,$2,$3,$4,$5) as data',
        [clinicalUuid(input.requestId), input.subject, input.emailSha256, input.clinicLabel, input.assurance]);
      return bootstrapAnswer.parse(parse(rows[0]?.data));
    }),
    state: subject => database.transaction(async tx => {
      const { rows } = await tx.query<{ data: unknown }>('select clinical_private.workforce_clinic_bootstrap_for_subject($1) as data', [subject]);
      const value = parse(rows[0]?.data);
      return value === null || value === undefined ? null : bootstrapState.parse(value);
    }),
  };
}

/**
 * One bootstrap for an applicant the caller has already verified: the token's subject and address, and the account's
 * current confirmed address and MFA method read from the identity provider. The browser's request id and name are
 * validated in full first. An answer that is not exactly this subject's active owner membership is never passed on.
 */
export function createClinicBootstrapService(deps: { store: ClinicBootstrapStore; release?: 'blocked' | 'qualification' }) {
  const release = deps.release ?? WORKFORCE_CLINIC_BOOTSTRAP_RELEASE;
  return {
    async bootstrap(applicant: { subject: string; emailSha256: string; emailVerified: boolean; mfaActive: boolean }, body: unknown): Promise<ClinicBootstrapAnswer> {
      if (release !== 'qualification') throw new ClinicBootstrapError('not_released');
      const parsed = clinicBootstrapRequest.safeParse(body);
      if (!parsed.success) throw new ClinicBootstrapError('request_invalid');
      if (!applicant.emailVerified || !applicant.mfaActive) throw new ClinicBootstrapError('assurance_required');
      if (!/^[0-9a-f]{64}$/.test(applicant.emailSha256)) throw new ClinicBootstrapError('applicant_refused');
      let answer: ClinicBootstrapAnswer;
      try {
        answer = await deps.store.bootstrap({ requestId: parsed.data.requestId, subject: applicant.subject, emailSha256: applicant.emailSha256,
          clinicLabel: parsed.data.clinicLabel, assurance: BOOTSTRAP_ASSURANCE });
      } catch (error) { throw classify(error); }
      if (answer.requestId !== parsed.data.requestId) throw new ClinicBootstrapError('service_unavailable');
      return answer;
    },
    async state(applicant: { subject: string }): Promise<ClinicBootstrapState | null> {
      if (release !== 'qualification') throw new ClinicBootstrapError('not_released');
      try { return await deps.store.state(applicant.subject); } catch (error) { throw classify(error); }
    },
  };
}

export { BOOTSTRAP_SUSPENSION_REASONS };
export const clinicBootstrapSuspensionRequest = z.object({ organizationId: uuid, reason: z.enum(BOOTSTRAP_SUSPENSION_REASONS) }).strict();
const suspensionAnswer = z.object({ organizationId: uuid, status: z.literal('suspended'), reason: z.enum(BOOTSTRAP_SUSPENSION_REASONS), duplicate: z.boolean() }).strict();
export class ClinicBootstrapSuspensionError extends Error {
  constructor(readonly code: 'not_released' | 'operator_refused' | 'request_invalid' | 'not_found' | 'self_approval_refused' | 'service_unavailable') { super(code); }
}
const SUSPENSION_SQL_REFUSALS: Readonly<Record<string, ClinicBootstrapSuspensionError['code']>> = {
  workforce_operator_refused: 'operator_refused', workforce_bootstrap_suspension_invalid: 'request_invalid',
  workforce_clinic_bootstrap_not_found: 'not_found', workforce_self_approval_refused: 'self_approval_refused',
};

/**
 * A platform operator's revocation of a bootstrapped clinic. The operator subject comes only from the separate,
 * MFA-protected operator sign-in (platform-operator-authenticator.ts); the connection must run as
 * `clinical_workforce_operator`. BLOCKED with the rest of the bootstrap path.
 */
export function createClinicBootstrapSuspension(deps: {
  database: ClinicalCoreDatabase;
  verifiedOperatorSubject: (authorization: string) => Promise<string>;
  release?: 'blocked' | 'qualification';
}) {
  const release = deps.release ?? WORKFORCE_CLINIC_BOOTSTRAP_RELEASE;
  return async (authorization: string, body: unknown) => {
    if (release !== 'qualification') throw new ClinicBootstrapSuspensionError('not_released');
    const parsed = clinicBootstrapSuspensionRequest.safeParse(body);
    if (!parsed.success) throw new ClinicBootstrapSuspensionError('request_invalid');
    let operator: string;
    try { operator = await deps.verifiedOperatorSubject(authorization); } catch { throw new ClinicBootstrapSuspensionError('operator_refused'); }
    try {
      return await deps.database.transaction(async tx => {
        const { rows } = await tx.query<{ data: unknown }>('select clinical_private.suspend_bootstrapped_workforce_clinic($1,$2,$3) as data',
          [clinicalUuid(parsed.data.organizationId), operator, parsed.data.reason]);
        const answer = suspensionAnswer.parse(parse(rows[0]?.data));
        if (answer.organizationId !== parsed.data.organizationId) throw new ClinicBootstrapSuspensionError('service_unavailable');
        return answer;
      });
    } catch (error) {
      if (error instanceof ClinicBootstrapSuspensionError) throw error;
      if (error instanceof ClinicalCoreDatabaseRejection && error.reason && SUSPENSION_SQL_REFUSALS[error.reason]) throw new ClinicBootstrapSuspensionError(SUSPENSION_SQL_REFUSALS[error.reason]!);
      throw new ClinicBootstrapSuspensionError('service_unavailable');
    }
  };
}
