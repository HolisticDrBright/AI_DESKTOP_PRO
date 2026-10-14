import { z } from 'zod';

/**
 * A reviewer's attestation of one clinic lab reading, as the Desktop asks for it (lab-attestation-review/1).
 *
 * Two shapes travel. The REVIEW is what the reviewer is shown: the clinic's reading exactly as the database stores it
 * (marker, the value as stored and as text, unit, draw time), the transfer's recorded document digests, the review
 * state, the verification history and a reading revision. The BOUND REQUEST is what they send from it: the patient
 * they had open, that reading revision, and the reviewed lab-reading-attestation/1 statement, in which they restate
 * the four fields and name the SHA-256 of the report they compared it against.
 *
 * What it cannot carry: a "verified" boolean, a signature, a range, a laboratory flag, a status. Every object is
 * strict, so a field that would carry one is refused rather than ignored. A /1 reading's stored status is the app's
 * assessment and is shown only under that name; no transfer carries a laboratory flag, so none is ever shown.
 *
 * Nothing the client holds says a reading is verified. Only the server's view, read back after the receipt, can:
 * `verifiedByView` is the one test a screen may use, and it needs the receipt's attestation to be the current one.
 *
 * Served by the BLOCKED candidate infra/aws-clinical-core/production-candidates/lab-attestation-review.sql over the
 * BLOCKED lab-observation-attestation.sql. While either activation is off every request is refused.
 */
export const LAB_ATTESTATION_REVIEW = 'lab-attestation-review/1' as const;
export const LAB_READING_ATTESTATION = 'lab-reading-attestation/1' as const;

const uuid = z.string().uuid();
/** A record id in the shape the database itself checks (8-4-4-4-12 hex), for the patient and reading the view names. */
const recordId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.string().datetime({ offset: true });

/** The reviewed statement. Restated fields, an outcome from a closed vocabulary, the document and the CAS anchor. */
export const labReadingAttestationStatement = z.object({
  statement: z.literal(LAB_READING_ATTESTATION),
  requestId: uuid,
  observationId: uuid,
  outcome: z.enum(['verified', 'refuted']),
  reading: z.object({
    marker: z.string().min(1).max(200), value: z.number().finite(), unit: z.string().min(1).max(80),
    observedAt: instant,
  }).strict(),
  documentSha256: digest,
  /** The current attestation this one replaces, or null for the first. A stale view is refused by the database. */
  supersedes: uuid.nullable(),
}).strict();
export type LabReadingAttestationStatement = z.infer<typeof labReadingAttestationStatement>;

export const labReadingAttestationReceipt = z.object({
  attestationId: uuid, observationId: uuid, outcome: z.enum(['verified', 'refuted']), scope: z.literal('measured_value'),
  rangeVerified: z.literal(false), attestedAt: z.string().min(1), duplicate: z.boolean(),
}).strict();
export type LabReadingAttestationReceipt = z.infer<typeof labReadingAttestationReceipt>;

export const labAttestationReviewRequest = z.object({
  contract: z.literal(LAB_ATTESTATION_REVIEW), patientRecordId: recordId, observationId: recordId,
}).strict();
export type LabAttestationReviewRequest = z.infer<typeof labAttestationReviewRequest>;

export const LAB_ATTESTATION_BLOCKERS = ['reading_rejected', 'reading_superseded', 'document_unknown', 'unit_unknown'] as const;
const history = z.object({
  attestationId: uuid, outcome: z.enum(['verified', 'refuted']), scope: z.literal('measured_value'), documentSha256: digest,
  reviewerRole: z.enum(['owner', 'admin', 'practitioner']), supersedes: uuid.nullable(), attestedAt: z.string().min(1),
}).strict();

export const labAttestationReview = z.object({
  contract: z.literal(LAB_ATTESTATION_REVIEW),
  patientRecordId: recordId,
  observationId: recordId,
  /** Exactly as stored. `valueText` is the database's own rendering of the stored number; show it, not a reformat. */
  reading: z.object({
    marker: z.string().min(1).max(200), value: z.number().finite(), valueText: z.string().min(1).max(64),
    unit: z.string().min(1).max(80).nullable(), observedAt: instant,
  }).strict(),
  reviewStatus: z.enum(['unreviewed', 'accepted', 'flagged', 'rejected']),
  transfer: z.object({
    contract: z.enum(['lab-result/1', 'lab-result/2']),
    origin: z.enum(['uploaded_report_analysis', 'owner_entered', 'personal_import', 'not_recorded']),
    documents: z.array(digest).max(20),
    reportedVerification: z.enum(['analysis_cross_checked', 'needs_human_review', 'not_recorded']),
    /** What the APP said about a /1 reading. Never the laboratory's flag. Always null for /2. */
    appAssessment: z.string().min(1).max(40).nullable(),
    laboratoryFlag: z.null(),
  }).strict(),
  supersededBy: recordId.nullable(),
  verification: z.object({
    observationId: recordId, state: z.enum(['verified', 'refuted', 'needs_human_review']), current: uuid.nullable(),
    rangeVerified: z.literal(false), history: z.array(history).max(50),
  }).strict(),
  attestable: z.boolean(),
  blockedBy: z.enum(LAB_ATTESTATION_BLOCKERS).nullable(),
  readingRevision: digest,
}).strict().superRefine((view, c) => {
  if (view.verification.observationId !== view.observationId) c.addIssue({ code: 'custom', message: 'verification_other_reading' });
  if (view.attestable !== (view.blockedBy === null)) c.addIssue({ code: 'custom', message: 'attestable_mismatch' });
  if (view.transfer.contract === 'lab-result/1'
    && (view.transfer.origin !== 'not_recorded' || view.transfer.documents.length > 0 || view.transfer.reportedVerification !== 'not_recorded'))
    c.addIssue({ code: 'custom', message: 'legacy_transfer_claims_provenance' });
  if (view.transfer.contract === 'lab-result/2' && view.transfer.appAssessment !== null) c.addIssue({ code: 'custom', message: 'v2_transfer_carries_status' });
  // A verified or refuted state names its current attestation, and that attestation is in the history shown.
  if (view.verification.state !== 'needs_human_review' && (view.verification.current === null
    || !view.verification.history.some(h => h.attestationId === view.verification.current)))
    c.addIssue({ code: 'custom', message: 'verification_current_missing' });
  if (view.attestable && (view.transfer.documents.length === 0 || view.reading.unit === null || view.supersededBy !== null))
    c.addIssue({ code: 'custom', message: 'attestable_without_binding' });
});
export type LabAttestationReview = z.infer<typeof labAttestationReview>;

export const labAttestationBoundRequest = z.object({
  contract: z.literal(LAB_ATTESTATION_REVIEW), patientRecordId: recordId, readingRevision: digest,
  attestation: labReadingAttestationStatement,
}).strict();
export type LabAttestationBoundRequest = z.infer<typeof labAttestationBoundRequest>;

export const labAttestationBoundReceipt = labReadingAttestationReceipt.extend({
  patientRecordId: recordId, view: labAttestationReview,
}).strict().superRefine((receipt, c) => {
  if (receipt.view.observationId !== receipt.observationId || receipt.view.patientRecordId !== receipt.patientRecordId)
    c.addIssue({ code: 'custom', message: 'receipt_other_reading' });
});
export type LabAttestationBoundReceipt = z.infer<typeof labAttestationBoundReceipt>;

/** What a refusal may be called on screen. Anything else is the service being unavailable. */
export const LAB_ATTESTATION_REFUSALS = [
  'lab_attestation_disabled', 'lab_attestation_review_refused', 'lab_attestation_refused', 'clinical_role_required',
  'lab_attestation_invalid', 'lab_attestation_stale', 'lab_attestation_reading_superseded', 'lab_attestation_mismatch',
  'lab_attestation_document_unknown', 'lab_attestation_document_mismatch', 'lab_attestation_unit_unknown',
  'lab_attestation_reading_rejected', 'lab_attestation_conflict',
] as const;
export type LabAttestationRefusal = typeof LAB_ATTESTATION_REFUSALS[number];
export const labAttestationRefusal = z.enum(LAB_ATTESTATION_REFUSALS);

/** The refusal a database message names, by its token alone. The rest of the message never leaves the caller. */
export function labAttestationRefusalReason(message: string): LabAttestationRefusal | undefined {
  const match = /\b(lab_attestation_[a-z_]+)\b/.exec(message);
  return match && (LAB_ATTESTATION_REFUSALS as readonly string[]).includes(match[1]!) ? match[1] as LabAttestationRefusal : undefined;
}

/** The only test for "verified" a screen may use: the server's view names this receipt's attestation as current. */
export function verifiedByView(view: LabAttestationReview, receipt?: Pick<LabReadingAttestationReceipt, 'attestationId' | 'outcome'>): boolean {
  if (view.verification.state !== 'verified' || view.verification.current === null) return false;
  return receipt === undefined || (receipt.outcome === 'verified' && view.verification.current === receipt.attestationId);
}

/** Build the bound request from the view the reviewer saw. Never from anything the screen computed about the value. */
export function boundAttestation(view: LabAttestationReview, input: {
  requestId: string; outcome: 'verified' | 'refuted';
  restated: { marker: string; value: number; unit: string; observedAt: string }; documentSha256: string;
}): LabAttestationBoundRequest {
  return labAttestationBoundRequest.parse({
    contract: LAB_ATTESTATION_REVIEW, patientRecordId: view.patientRecordId, readingRevision: view.readingRevision,
    attestation: { statement: LAB_READING_ATTESTATION, requestId: input.requestId, observationId: view.observationId,
      outcome: input.outcome, reading: input.restated, documentSha256: input.documentSha256, supersedes: view.verification.current },
  });
}
