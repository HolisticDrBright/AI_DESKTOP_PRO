import { z } from 'zod';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';
import { LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256, LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256 } from './lab-observation-attestation';
import {
  LAB_ATTESTATION_REFUSALS, labAttestationRefusalReason, labAttestationBoundReceipt, labAttestationBoundRequest, labAttestationReview, labAttestationReviewRequest,
  type LabAttestationBoundReceipt, type LabAttestationRefusal, type LabAttestationReview,
} from '../../contracts/labAttestationReview';

/**
 * The reviewer's bound view and bound attestation (lab-attestation-review/1): a default-disabled adapter over the BLOCKED
 * successor infra/aws-clinical-core/production-candidates/lab-attestation-review.sql, which itself calls the BLOCKED
 * lab-observation-attestation.sql. Nothing in the identity API routes here yet; `labAttestationReviewHttp` below is the
 * reviewed handler a registration would mount (Codex's AWS packet), and until then the Desktop's own route refuses
 * before any network call unless the same activation evidence is configured there.
 *
 * Disabled means disabled before anything is read: no activation evidence naming all three candidates exactly, no
 * database transaction. The database refuses again on its own activation rows, so evidence here is necessary and
 * never sufficient.
 */
export const LAB_ATTESTATION_REVIEW_CANDIDATE_SHA256 = '765b5b963824772d049b79030b439a54cda5ca715dbe371b4eb4258fe1aedbf3';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const labAttestationReviewActivation = z.discriminatedUnion('enabled', [
  z.object({ contract: z.literal('lab-attestation-review-activation/1'), enabled: z.literal(false) }).strict(),
  z.object({
    contract: z.literal('lab-attestation-review-activation/1'), enabled: z.literal(true), target: z.literal('production-clinical'),
    transferCandidateSha256: digest, attestationCandidateSha256: digest, reviewCandidateSha256: digest, evidenceSha256: digest,
    reviewedBy: z.string().trim().min(1).max(200), reviewedAt: z.string().datetime({ offset: true }),
  }).strict(),
]);
export type LabAttestationReviewActivation = z.infer<typeof labAttestationReviewActivation>;
export const DISABLED_LAB_ATTESTATION_REVIEW_ACTIVATION: LabAttestationReviewActivation = Object.freeze({
  contract: 'lab-attestation-review-activation/1', enabled: false });

/** Evidence names all three candidates as reviewed, or the flow stays disabled. A parse failure is disabled too. */
export function labAttestationReviewActivationState(evidence: unknown): LabAttestationReviewActivation {
  const parsed = labAttestationReviewActivation.safeParse(evidence ?? DISABLED_LAB_ATTESTATION_REVIEW_ACTIVATION);
  if (!parsed.success) return DISABLED_LAB_ATTESTATION_REVIEW_ACTIVATION;
  if (parsed.data.enabled && (parsed.data.transferCandidateSha256 !== LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256
    || parsed.data.attestationCandidateSha256 !== LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256
    || parsed.data.reviewCandidateSha256 !== LAB_ATTESTATION_REVIEW_CANDIDATE_SHA256)) return DISABLED_LAB_ATTESTATION_REVIEW_ACTIVATION;
  return parsed.data;
}
/** The evidence as configured for a process, by JSON in one variable. Absent or malformed is disabled. */
export function labAttestationReviewActivationFromEnvironment(value: string | undefined): LabAttestationReviewActivation {
  if (!value) return DISABLED_LAB_ATTESTATION_REVIEW_ACTIVATION;
  try { return labAttestationReviewActivationState(JSON.parse(value)); } catch { return DISABLED_LAB_ATTESTATION_REVIEW_ACTIVATION; }
}

export type LabAttestationReviewErrorCategory = 'activation_refused' | 'identity_refused' | 'request_invalid' | 'not_found' | 'conflict' | 'service_unavailable';
export class LabAttestationReviewError extends Error {
  constructor(readonly category: LabAttestationReviewErrorCategory, readonly reason?: LabAttestationRefusal) { super(category); }
}

/** A database refusal in the reviewer's vocabulary. Hosted errors arrive classified; embedded ones carry the token. */
function refusal(error: unknown): LabAttestationReviewError {
  if (error instanceof LabAttestationReviewError) return error;
  const reason = error instanceof ClinicalCoreDatabaseRejection && (LAB_ATTESTATION_REFUSALS as readonly string[]).includes(error.reason ?? '')
    ? error.reason as LabAttestationRefusal
    : labAttestationRefusalReason(error instanceof Error ? error.message : String(error))
      ?? (/\bclinical_role_required\b/.test(error instanceof Error ? error.message : '') ? 'clinical_role_required' : undefined);
  if (!reason) {
    if (/\b(request_context_refused|production_context_refused)\b/.test(error instanceof Error ? error.message : ''))
      return new LabAttestationReviewError('identity_refused', 'lab_attestation_refused');
    if (error instanceof ClinicalCoreDatabaseRejection && error.category === 'identity_refused') return new LabAttestationReviewError('identity_refused', 'lab_attestation_refused');
    if (error instanceof ClinicalCoreDatabaseRejection && error.category === 'request_invalid') return new LabAttestationReviewError('request_invalid', 'lab_attestation_invalid');
    return new LabAttestationReviewError('service_unavailable');
  }
  if (reason === 'lab_attestation_disabled') return new LabAttestationReviewError('activation_refused', reason);
  if (reason === 'lab_attestation_review_refused') return new LabAttestationReviewError('not_found', reason);
  if (reason === 'lab_attestation_refused' || reason === 'clinical_role_required') return new LabAttestationReviewError('identity_refused', reason);
  if (reason === 'lab_attestation_invalid') return new LabAttestationReviewError('request_invalid', reason);
  return new LabAttestationReviewError('conflict', reason);
}

export function createLabAttestationReview(deps: { database: ClinicalCoreDatabase; activation?: unknown }) {
  const activation = labAttestationReviewActivationState(deps.activation);
  const authorize = (context: ClinicalRequestContext) => {
    if (!activation.enabled) throw new LabAttestationReviewError('activation_refused', 'lab_attestation_disabled');
    if (context.identityPool !== 'workforce' || context.environment !== 'production-clinical' || context.dataClassification !== 'clinical_phi'
      || context.purpose !== 'clinical_data' || !('productionBound' in context) || context.productionBound !== true)
      throw new LabAttestationReviewError('identity_refused', 'lab_attestation_refused');
  };
  const run = async <T>(context: ClinicalRequestContext, sql: string, body: unknown, parse: (raw: unknown) => T): Promise<T> => {
    try {
      return await deps.database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool, context.identitySubject,
          context.purpose, context.environment, context.dataClassification]);
        const raw = (await tx.query<{ data: unknown }>(sql, [JSON.stringify(body)])).rows[0]?.data;
        return parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) { throw refusal(error); }
  };
  return {
    /** The reading as stored, for the patient the reviewer has open. Another patient's reading is "not found". */
    async review(context: ClinicalRequestContext, body: unknown): Promise<LabAttestationReview> {
      authorize(context);
      const request = labAttestationReviewRequest.safeParse(body);
      if (!request.success) throw new LabAttestationReviewError('request_invalid', 'lab_attestation_invalid');
      return run(context, 'select clinical_core.lab_attestation_review($1::jsonb) as data', request.data, raw => {
        const view = labAttestationReview.safeParse(raw);
        if (!view.success || view.data.patientRecordId !== request.data.patientRecordId || view.data.observationId !== request.data.observationId)
          throw new LabAttestationReviewError('service_unavailable');
        return view.data;
      });
    },
    /** One bound attestation. The receipt must echo what was asked, and carries the view as it stands afterwards. */
    async attest(context: ClinicalRequestContext, body: unknown): Promise<LabAttestationBoundReceipt> {
      authorize(context);
      const request = labAttestationBoundRequest.safeParse(body);
      if (!request.success) throw new LabAttestationReviewError('request_invalid', 'lab_attestation_invalid');
      return run(context, 'select clinical_core.attest_reviewed_lab_observation($1::jsonb) as data', request.data, raw => {
        const receipt = labAttestationBoundReceipt.safeParse(raw);
        if (!receipt.success || receipt.data.observationId !== request.data.attestation.observationId
          || receipt.data.patientRecordId !== request.data.patientRecordId || receipt.data.outcome !== request.data.attestation.outcome)
          throw new LabAttestationReviewError('service_unavailable');
        return receipt.data;
      });
    },
  };
}
export type LabAttestationReviewService = ReturnType<typeof createLabAttestationReview>;

/** HTTP status and body for each outcome, shared by the AWS handler and the Desktop route so both say the same thing. */
export function labAttestationHttpRefusal(error: unknown): { status: number; body: { error: { code: LabAttestationRefusal | 'service_unavailable' } } } {
  const e = error instanceof LabAttestationReviewError ? error : new LabAttestationReviewError('service_unavailable');
  const code = e.reason ?? 'service_unavailable';
  const status = e.category === 'activation_refused' ? 409 : e.category === 'identity_refused' ? 403 : e.category === 'request_invalid' ? 400
    : e.category === 'not_found' ? 404 : e.category === 'conflict' ? 409 : 503;
  return { status, body: { error: { code: status === 503 ? 'service_unavailable' : code } } };
}

/**
 * The reviewed AWS handler for the two workforce routes a registration would add:
 *   POST /clinical-core/workforce/lab-attestations/review  → the view
 *   POST /clinical-core/workforce/lab-attestations         → the bound receipt
 * Not mounted in the identity API: registering it, its two routes and the activation evidence is Codex's AWS work.
 */
export function labAttestationReviewHttp(service: LabAttestationReviewService) {
  return async (path: string, context: ClinicalRequestContext, body: unknown): Promise<{ status: number; body: unknown }> => {
    try {
      if (path === '/clinical-core/workforce/lab-attestations/review') return { status: 200, body: { data: await service.review(context, body) } };
      if (path === '/clinical-core/workforce/lab-attestations') return { status: 200, body: { data: await service.attest(context, body) } };
      return { status: 404, body: { error: { code: 'lab_attestation_review_refused' } } };
    } catch (error) { return labAttestationHttpRefusal(error); }
  };
}
