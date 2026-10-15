if (typeof window !== 'undefined') throw new Error('workforce-join-review is server-only');
import { createHash } from 'node:crypto';
import {
  JOIN_APPROVAL_REASON, joinReviewResponse, type JoinReviewRefusal, type JoinReviewRequest, type JoinReviewResponse,
} from '../../contracts/workforceJoinReview';
import type { CurrentWorkforcePrincipal } from './aws-identity-consent';
import { bindCurrentWorkforceContext, CurrentMembershipRefusal, currentMembershipSetterBound } from './current-membership-workforce';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';

/**
 * A clinic administrator's review of join requests under the unactivated `database_current` authority. Source only and
 * BLOCKED: it reaches the database only through the BLOCKED, unregistered approval-authority candidate
 * (infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql), after the unregistered
 * current-membership setter. While either is absent or differs from the reviewed text, every request answers
 * `not_released` and no operation runs.
 *
 * In one transaction: the setter binds the signed-in subject and the one selected clinic from current rows; the caller
 * must be that clinic's current owner or admin; then exactly one reasoned function runs. The database repeats every
 * check and decides; this layer never decides on the database's behalf, and it never sees or sends a person id, a role
 * or a clinic other than the session's selection.
 */
/** SHA-256 of the BLOCKED candidate and its rollback; the approval-authority database test holds them to the files, so a
 * changed candidate cannot be served against a review of another. */
export const WORKFORCE_APPROVAL_AUTHORITY_CANDIDATE_SHA256 = 'd33f398e3f31ac66b28f88e18c6f7332ce3ce98b9a9b19a28298fe6e42e5815f';
export const WORKFORCE_APPROVAL_AUTHORITY_ROLLBACK_SHA256 = '28590e2678da6c10b87da85696a75a6792bb44e2774a9aa11cf313454b34f70c';
/** prosrc SHA-256 of each reviewed function as the candidate defines it; a database test holds them to the file. */
export const WORKFORCE_JOIN_REVIEW_FUNCTIONS = {
  list: { signature: 'clinical_core.list_workforce_join_requests()', prosrcSha256: '5cf9f785be055b762801464de4f4ead54df0f23e3422e833cfc744aef2bc6527' },
  decide: { signature: 'clinical_core.review_workforce_join_request_v2(uuid,boolean,text,text)', prosrcSha256: '8be8f5168a79f5ce08796f938959da341e806793f613eb2d7efe71b56417a74b' },
  revoke: { signature: 'clinical_core.revoke_workforce_membership(uuid,text)', prosrcSha256: '204a96b3ff7ed7478ebf67a50fc32ce7ad2e308f21f7cc799e9f8f9b01bc93f0' },
} as const satisfies Record<string, { signature: string; prosrcSha256: string }>;

/**
 * The SQL refusal names of the candidate, and what each means to an administrator. The production data client
 * (rds-data-database.ts, Codex's file) does not classify any of them yet, so through it they arrive as an unclassified
 * failure and answer `service_unavailable`. The classification it would need is the source-interface request recorded in
 * docs/practitioner-onboarding-approval-2026-10-15.md: each name below as a ClinicalCoreDatabaseRejection whose
 * `reason` is the name.
 */
export const JOIN_REVIEW_SQL_REFUSALS: Readonly<Record<string, JoinReviewRefusal>> = {
  workforce_review_invalid: 'request_invalid',
  workforce_revocation_invalid: 'request_invalid',
  workforce_application_not_found: 'not_found',
  membership_not_found: 'not_found',
  workforce_review_conflict: 'conflict',
  workforce_review_applicant_mismatch: 'applicant_mismatch',
  workforce_self_approval_refused: 'self_approval_refused',
  self_suspension_refused: 'self_approval_refused',
  workforce_already_member: 'already_member',
  workforce_clinic_unavailable: 'clinic_unavailable',
  workforce_binding_conflict: 'conflict',
  organization_admin_required: 'identity_refused',
  owner_role_required: 'identity_refused',
  last_owner_protected: 'conflict',
};

export class WorkforceJoinReviewError extends Error {
  constructor(readonly code: JoinReviewRefusal) { super(code); }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Whether every reviewed function is present with its reviewed body, SECURITY DEFINER, an empty search_path, callable by
 * the API role and never by PUBLIC, and the parent review function is no longer callable by the API role. */
export async function joinReviewFunctionsBound(tx: ClinicalCoreTransaction): Promise<boolean> {
  const entries = Object.values(WORKFORCE_JOIN_REVIEW_FUNCTIONS);
  if (entries.some(entry => !/^[a-f0-9]{64}$/.test(entry.prosrcSha256))) return false;
  const { rows } = await tx.query<{ valid: boolean }>(`select coalesce(bool_and(coalesce((select p.prosecdef and p.prokind='f'
      and p.proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.digest
      and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE')
    from pg_proc p where p.oid=to_regprocedure(f.signature)),false)),false)
    and coalesce(not has_function_privilege('clinical_core_api',
      to_regprocedure('clinical_core.review_workforce_join_request(uuid,boolean)'),'EXECUTE'),false) as valid
    from unnest($1::text[],$2::text[]) as f(signature,digest)`,
  [entries.map(entry => entry.signature), entries.map(entry => entry.prosrcSha256)]);
  return rows[0]?.valid === true;
}

function refusalOf(error: unknown): WorkforceJoinReviewError {
  if (error instanceof WorkforceJoinReviewError) return error;
  if (error instanceof CurrentMembershipRefusal) return new WorkforceJoinReviewError(error.code === 'reauth_required' ? 'reauth_required' : 'identity_refused');
  if (error instanceof ClinicalCoreDatabaseRejection) {
    const named = error.reason ? JOIN_REVIEW_SQL_REFUSALS[error.reason] : undefined;
    if (named) return new WorkforceJoinReviewError(named);
    if (error.category === 'identity_refused') return new WorkforceJoinReviewError('identity_refused');
    if (error.category === 'request_invalid') return new WorkforceJoinReviewError('request_invalid');
    if (error.category === 'conflict') return new WorkforceJoinReviewError('conflict');
  }
  return new WorkforceJoinReviewError('service_unavailable');
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

export function createWorkforceJoinReview(deps: { database: ClinicalCoreDatabase }) {
  return async (principal: CurrentWorkforcePrincipal, request: JoinReviewRequest): Promise<JoinReviewResponse> => {
    try {
      return await deps.database.transaction(async tx => {
        if (!(await currentMembershipSetterBound(tx)) || !(await joinReviewFunctionsBound(tx))) throw new WorkforceJoinReviewError('not_released');
        const { role } = await bindCurrentWorkforceContext(tx, principal, 'clinical_data');
        // Current rows, read by the setter in this transaction; the database repeats the check under its own lock.
        if (role !== 'owner' && role !== 'admin') throw new WorkforceJoinReviewError('identity_refused');
        if (request.action === 'list') {
          const { rows } = await tx.query<{ data: unknown }>('select clinical_core.list_workforce_join_requests() as data');
          return joinReviewResponse.parse({ action: 'list', requests: json(rows[0]?.data) });
        }
        if (request.action === 'revoke') {
          const { rows } = await tx.query<{ data: unknown }>('select clinical_core.revoke_workforce_membership($1,$2) as data',
            [clinicalUuid(request.membershipId), request.reason]);
          const row = json(rows[0]?.data) as Record<string, unknown> | null;
          return joinReviewResponse.parse({ action: 'revoke', membershipId: row?.membershipId, status: row?.status, reason: row?.reason, duplicate: row?.duplicate });
        }
        const approving = request.action === 'approve';
        const { rows } = await tx.query<{ data: unknown }>('select clinical_core.review_workforce_join_request_v2($1,$2,$3,$4) as data', [
          clinicalUuid(request.requestId), approving, approving ? JOIN_APPROVAL_REASON : request.reason,
          // The address leaves this function only as its digest.
          approving ? sha256(request.applicantEmail.trim().toLowerCase()) : null,
        ]);
        const row = json(rows[0]?.data) as Record<string, unknown> | null;
        return approving
          ? joinReviewResponse.parse({ action: 'approve', requestId: request.requestId, status: row?.status, membershipId: row?.membershipId, duplicate: row?.duplicate })
          : joinReviewResponse.parse({ action: 'reject', requestId: request.requestId, status: row?.status, reason: row?.decisionReason, duplicate: row?.duplicate });
      });
    } catch (error) {
      throw refusalOf(error);
    }
  };
}
