if (typeof window !== 'undefined') throw new Error('workforce-clinic-proposal-review is server-only');
import { z } from 'zod';
import { PROPOSAL_APPROVAL_REASON, PROPOSAL_REJECTION_REASONS } from '../../contracts/workforceJoinReview';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from './database';

/**
 * The platform operator's review of new-clinic proposals. Source only and BLOCKED, with no route, no Desktop surface and
 * no deployed caller: how a platform operator signs in, and who adds a subject to the operator registry, are owner
 * decisions not yet made (docs/practitioner-onboarding-approval-2026-10-15.md). So the operator's subject reaches this
 * module only through `verifiedOperatorSubject`, which a reviewed authenticator must supply, and the database connection
 * must run as `clinical_workforce_operator`, which can call only the two proposal functions.
 *
 * An approval creates the clinic with its owner membership `pending` under an activation hold: the answer says
 * `activation: 'held'`, and nothing here, in the database or on the Desktop can release it. Approving a proposal is not
 * patient access for anyone.
 */
export const WORKFORCE_CLINIC_PROPOSAL_REVIEW_RELEASE: 'blocked' | 'qualification' = 'blocked';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
export const clinicProposalReviewRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('approve'), requestId: uuid }).strict(),
  z.object({ action: z.literal('reject'), requestId: uuid, reason: z.enum(PROPOSAL_REJECTION_REASONS) }).strict(),
]);
export type ClinicProposalReviewRequest = z.infer<typeof clinicProposalReviewRequest>;
const proposal = z.object({
  id: uuid, status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']), createdAt: z.string().max(40), decidedAt: z.string().max(40).nullable(),
  proposedLabel: z.string().min(3).max(120), decisionReason: z.string().max(64).nullable(),
}).strict();
const decision = z.object({
  status: z.enum(['approved', 'rejected']), organizationId: uuid.nullable(), membershipId: uuid.nullable(),
  decisionReason: z.string().max(64), activation: z.literal('held').nullable(), duplicate: z.boolean(),
}).strict();
export type ClinicProposalReviewResponse =
  | { action: 'list'; proposals: z.infer<typeof proposal>[] }
  | ({ action: 'approve' | 'reject'; requestId: string } & z.infer<typeof decision>);

export class ClinicProposalReviewError extends Error {
  constructor(readonly code: 'not_released' | 'operator_refused' | 'request_invalid' | 'not_found' | 'conflict' | 'self_approval_refused' | 'service_unavailable') { super(code); }
}
const SQL_REFUSALS: Readonly<Record<string, ClinicProposalReviewError['code']>> = {
  workforce_operator_refused: 'operator_refused', workforce_review_invalid: 'request_invalid',
  workforce_application_not_found: 'not_found', workforce_review_conflict: 'conflict',
  workforce_self_approval_refused: 'self_approval_refused', workforce_binding_conflict: 'conflict',
};
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const parse = (value: unknown) => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } };

export function createClinicProposalReview(deps: {
  /** The operator connection (`clinical_workforce_operator`). */
  database: ClinicalCoreDatabase;
  /** A reviewed operator authenticator: the verified operator subject for this request, or a throw. Not yet decided. */
  verifiedOperatorSubject: (authorization: string) => Promise<string>;
  release?: 'blocked' | 'qualification';
}) {
  const release = deps.release ?? WORKFORCE_CLINIC_PROPOSAL_REVIEW_RELEASE;
  return async (authorization: string, request: ClinicProposalReviewRequest): Promise<ClinicProposalReviewResponse> => {
    if (release !== 'qualification') throw new ClinicProposalReviewError('not_released');
    let operator: string;
    try { operator = await deps.verifiedOperatorSubject(authorization); } catch { throw new ClinicProposalReviewError('operator_refused'); }
    if (typeof operator !== 'string' || !SUBJECT.test(operator)) throw new ClinicProposalReviewError('operator_refused');
    try {
      return await deps.database.transaction(async tx => {
        if (request.action === 'list') {
          const { rows } = await tx.query<{ data: unknown }>('select clinical_private.list_workforce_clinic_proposals($1) as data', [operator]);
          return { action: 'list' as const, proposals: z.array(proposal).max(50).parse(parse(rows[0]?.data)) };
        }
        const approving = request.action === 'approve';
        const { rows } = await tx.query<{ data: unknown }>('select clinical_private.review_workforce_clinic_proposal_v2($1,$2,$3,$4) as data',
          [clinicalUuid(request.requestId), approving, operator, approving ? PROPOSAL_APPROVAL_REASON : request.reason]);
        const answer = decision.parse(parse(rows[0]?.data));
        // An approval that is not held would be patient access by review; it is never accepted as an answer.
        if (approving && (answer.status !== 'approved' || answer.activation !== 'held')) throw new ClinicProposalReviewError('service_unavailable');
        return { action: request.action, requestId: request.requestId, ...answer };
      });
    } catch (error) {
      if (error instanceof ClinicProposalReviewError) throw error;
      if (error instanceof ClinicalCoreDatabaseRejection && error.reason && SQL_REFUSALS[error.reason]) throw new ClinicProposalReviewError(SQL_REFUSALS[error.reason]!);
      if (error instanceof ClinicalCoreDatabaseRejection && error.category === 'identity_refused') throw new ClinicProposalReviewError('operator_refused');
      throw new ClinicProposalReviewError('service_unavailable');
    }
  };
}
