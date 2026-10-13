import { z } from 'zod';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';

/**
 * Reviewer attestation of one clinic lab reading (lab-reading-attestation/1): a SEPARATE, default-disabled adapter over
 * the BLOCKED candidate infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql. Nothing routes
 * here; no identity API path reaches it. It exists so the request shape and the activation binding are reviewed as
 * source before anyone decides to enable them.
 *
 * The request has no "verified" boolean, no signature and no range: the reviewer is the authenticated workforce actor,
 * the outcome is a closed vocabulary, the reading is RESTATED so the server can compare it with what it holds, and the
 * document digest is the one the reviewer computed from the report they compared it against. Scope is the measured
 * value only; a reference range is never attested.
 */
/** SHA-256 of the two lab candidates as reviewed. Tests hold these equal to the files. */
export const LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256 = 'fa6ee162a03a85ab23543371d9d1dbaf8ee6dd486b4a8cc64b5545fc16be3b94';
export const LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256 = 'd0423bcec5067a668f3522bbba65d096f642f083c1ef95448da190b38494bb83';

const uuid = z.string().uuid();
export const labReadingAttestationRequest = z.object({
  statement: z.literal('lab-reading-attestation/1'),
  requestId: uuid,
  observationId: uuid,
  outcome: z.enum(['verified', 'refuted']),
  reading: z.object({
    marker: z.string().min(1).max(200), value: z.number().finite(), unit: z.string().min(1).max(80),
    observedAt: z.string().datetime({ offset: true }),
  }).strict(),
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The current attestation this one replaces, or null for the first. A stale view is refused by the database. */
  supersedes: uuid.nullable(),
}).strict();
export type LabReadingAttestationRequest = z.infer<typeof labReadingAttestationRequest>;
export const labReadingAttestationReceipt = z.object({
  attestationId: uuid, observationId: uuid, outcome: z.enum(['verified', 'refuted']), scope: z.literal('measured_value'),
  rangeVerified: z.literal(false), attestedAt: z.string().min(1), duplicate: z.boolean(),
}).strict();
export type LabReadingAttestationReceipt = z.infer<typeof labReadingAttestationReceipt>;

/** Activation evidence (lab-attestation-activation/1): a record of a review that happened elsewhere. Default disabled. */
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const labAttestationActivation = z.discriminatedUnion('enabled', [
  z.object({ contract: z.literal('lab-attestation-activation/1'), enabled: z.literal(false) }).strict(),
  z.object({
    contract: z.literal('lab-attestation-activation/1'), enabled: z.literal(true), target: z.literal('production-clinical'),
    transferCandidateSha256: digest, attestationCandidateSha256: digest, evidenceSha256: digest,
    reviewedBy: z.string().trim().min(1).max(200), reviewedAt: z.string().datetime({ offset: true }),
  }).strict(),
]);
export type LabAttestationActivation = z.infer<typeof labAttestationActivation>;
export const DISABLED_LAB_ATTESTATION_ACTIVATION: LabAttestationActivation = Object.freeze({ contract: 'lab-attestation-activation/1', enabled: false });

export function labAttestationActivationState(evidence: unknown): LabAttestationActivation {
  const parsed = labAttestationActivation.safeParse(evidence ?? DISABLED_LAB_ATTESTATION_ACTIVATION);
  if (!parsed.success) return DISABLED_LAB_ATTESTATION_ACTIVATION;
  if (parsed.data.enabled && (parsed.data.transferCandidateSha256 !== LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256
    || parsed.data.attestationCandidateSha256 !== LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256)) return DISABLED_LAB_ATTESTATION_ACTIVATION;
  return parsed.data;
}

export class LabAttestationError extends Error {
  constructor(readonly category: 'activation_refused' | 'identity_refused' | 'request_invalid' | 'conflict' | 'service_unavailable', readonly reason?: string) {
    super(category);
  }
}
const CONFLICTS = ['lab_attestation_stale', 'lab_attestation_mismatch', 'lab_attestation_document_unknown', 'lab_attestation_document_mismatch',
  'lab_attestation_unit_unknown', 'lab_attestation_reading_rejected', 'lab_attestation_conflict'] as const;

export function createLabObservationAttestation(deps: { database: ClinicalCoreDatabase; activation?: unknown }) {
  const activation = labAttestationActivationState(deps.activation);
  return async (context: ClinicalRequestContext, body: unknown): Promise<LabReadingAttestationReceipt> => {
    if (!activation.enabled) throw new LabAttestationError('activation_refused');
    if (context.identityPool !== 'workforce' || context.environment !== 'production-clinical' || context.dataClassification !== 'clinical_phi'
      || context.purpose !== 'clinical_data' || !('productionBound' in context) || context.productionBound !== true) throw new LabAttestationError('identity_refused');
    const parsed = labReadingAttestationRequest.safeParse(body);
    if (!parsed.success) throw new LabAttestationError('request_invalid');
    try {
      return await deps.database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool, context.identitySubject,
          context.purpose, context.environment, context.dataClassification]);
        const result = await tx.query<{ data: unknown }>('select clinical_core.attest_lab_observation($1::jsonb) as data', [JSON.stringify(parsed.data)]);
        const raw = result.rows[0]?.data;
        const receipt = labReadingAttestationReceipt.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
        if (!receipt.success || receipt.data.observationId !== parsed.data.observationId || receipt.data.outcome !== parsed.data.outcome) {
          throw new LabAttestationError('service_unavailable');
        }
        return receipt.data;
      });
    } catch (error) {
      if (error instanceof LabAttestationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const reason = CONFLICTS.find(code => message.includes(code));
      if (reason) throw new LabAttestationError('conflict', reason);
      if (error instanceof ClinicalCoreDatabaseRejection && error.category === 'request_invalid') throw new LabAttestationError('request_invalid');
      if (/lab_attestation_invalid/.test(message)) throw new LabAttestationError('request_invalid');
      if (/lab_attestation_refused|clinical_role_required|lab_attestation_disabled/.test(message)) throw new LabAttestationError('identity_refused');
      throw new LabAttestationError('service_unavailable');
    }
  };
}
