import { z } from 'zod';

/**
 * Patient-app lab transfer, lab-result/2. Byte-identical mirror between AI_DESKTOP_PRO src/contracts/ and
 * AI_LONGEVITY_PRO_V2 expo/contracts/; both suites pin the same digest.
 *
 * /2 is additive to lab-result/1 and carries where a reading came from and what the app claimed about it:
 *   - origin: an analysis of an uploaded report, an owner-entered value, or a personal import;
 *   - documents: the SHA-256 of each uploaded report the reading was read from (required for an uploaded report,
 *     absent otherwise), which is what a reviewer's attestation later binds to;
 *   - reportedVerification: the app's own mark, recorded as a CLAIM. It verifies nothing.
 * It never carries a status, a flag, an interpretation or a "verified" boolean. Every object is strict, so a field
 * that would carry one is refused rather than ignored. An app or analyzer classification ("critical", "high") is the
 * app's reading of an unreviewed result and is never a laboratory-issued flag; /2 has nowhere to put it.
 *
 * The server records verification 'needs_human_review' for every reading it receives. Only a reviewer's attestation
 * (infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql) moves a reading out of it, and only
 * for its measured value: no transfer and no attestation verifies a reference range.
 *
 * NOT ACCEPTED. While LAB_RESULT_TRANSFER_V2_ACCEPTED is false the Desktop refuses /2 before any database work and V2
 * keeps sending /1. Accepting it is a reviewed change on both sides, after the BLOCKED candidate
 * (infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql) is registered and activated.
 * lab-result/1 stays readable; every /1 reading is unverified and names no document.
 */
export const LAB_RESULT_TRANSFER_V1 = 'lab-result/1' as const;
export const LAB_RESULT_TRANSFER_V2 = 'lab-result/2' as const;
export const LAB_RESULT_TRANSFER_V2_ACCEPTED = false as boolean;
export const LAB_TRANSFER_ORIGINS = ['uploaded_report_analysis', 'owner_entered', 'personal_import'] as const;
export const LAB_TRANSFER_REPORTED_VERIFICATION = ['analysis_cross_checked', 'needs_human_review', 'not_recorded'] as const;
export type LabTransferOrigin = typeof LAB_TRANSFER_ORIGINS[number];
export type LabTransferReportedVerification = typeof LAB_TRANSFER_REPORTED_VERIFICATION[number];

const stamp = z.string().datetime({ offset: true });
const external = z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/);
const text = (max: number) => z.string().refine(value => value.trim().length >= 1 && value.length <= max);
export const labDocumentDigest = z.string().regex(/^[0-9a-f]{64}$/);

export const labTransferProvenance = z.object({
  origin: z.enum(LAB_TRANSFER_ORIGINS),
  documents: z.array(labDocumentDigest).max(20),
  reportedVerification: z.enum(LAB_TRANSFER_REPORTED_VERIFICATION),
}).strict().refine(p => new Set(p.documents).size === p.documents.length
  // A reading read from an uploaded report names the reports it was read from; any other origin names none.
  && (p.origin === 'uploaded_report_analysis') === (p.documents.length > 0));
export type LabTransferProvenance = z.infer<typeof labTransferProvenance>;

export const labResultTransferV2 = z.object({
  schemaVersion: z.literal(LAB_RESULT_TRANSFER_V2),
  provider: z.literal('alp_patient_sync'),
  providerEventId: z.string().regex(/^[A-Za-z0-9:_-]{8,160}$/),
  connectionId: z.string().uuid(),
  resourceVersion: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  occurredAt: stamp,
  source: z.object({ system: z.literal('ai_longevity_pro_v2'), recordType: z.literal('lab_panels'), panelId: external, markerId: external }).strict(),
  panel: z.object({ name: text(200), collectedAt: stamp, sourceLabel: text(200).optional() }).strict(),
  result: z.object({
    name: text(200), value: z.number().finite(), unit: text(80).optional(),
    referenceRange: z.object({ min: z.number().finite().optional(), max: z.number().finite().optional() }).strict()
      .refine(r => (r.min !== undefined || r.max !== undefined) && (r.min === undefined || r.max === undefined || r.min <= r.max)).optional(),
  }).strict(),
  provenance: labTransferProvenance,
}).strict();
export type LabResultTransferV2 = z.infer<typeof labResultTransferV2>;

/** What a reader may say about where a transferred reading came from. Never a laboratory flag: none was transferred. */
export type LabTransferProvenanceView = {
  contract: typeof LAB_RESULT_TRANSFER_V1 | typeof LAB_RESULT_TRANSFER_V2;
  origin: LabTransferOrigin | 'not_recorded';
  documents: string[];
  reportedVerification: LabTransferReportedVerification | 'not_recorded';
  verificationAtTransfer: 'needs_human_review';
  /** What the APP said about a /1 reading, when it said anything. Not the laboratory's flag. Always null for /2. */
  appAssessment: string | null;
  laboratoryFlag: null;
};

/** A legacy /1 reading stays readable: no provenance, no document, unverified, and its status named as the app's. */
export function legacyLabTransferProvenance(appAssessment: string | null | undefined): LabTransferProvenanceView {
  const assessment = typeof appAssessment === 'string' && appAssessment.trim() ? appAssessment.trim() : null;
  return { contract: LAB_RESULT_TRANSFER_V1, origin: 'not_recorded', documents: [], reportedVerification: 'not_recorded',
    verificationAtTransfer: 'needs_human_review', appAssessment: assessment, laboratoryFlag: null };
}

/** The provenance a /2 transfer carried, as a reader shows it. */
export function labTransferProvenanceView(transfer: Pick<LabResultTransferV2, 'provenance'>): LabTransferProvenanceView {
  return { contract: LAB_RESULT_TRANSFER_V2, origin: transfer.provenance.origin, documents: [...transfer.provenance.documents].sort(),
    reportedVerification: transfer.provenance.reportedVerification, verificationAtTransfer: 'needs_human_review',
    appAssessment: null, laboratoryFlag: null };
}
