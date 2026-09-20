import { z } from 'zod';

// Browser-safe wire contracts for review-only AI drafting. A proposed note is
// never a clinical note; the page inserts text into an editable note only
// through the composer's explicit insert path.
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime({ offset: true });
export const draftingNoteTypeSchema = z.enum(['soap', 'narrative', 'follow_up', 'adime', 'patient_instructions']);
export type DraftingNoteType = z.infer<typeof draftingNoteTypeSchema>;
export const DRAFTING_SECTIONS: Record<DraftingNoteType, { key: string; label: string }[]> = {
  soap: [{ key: 'S', label: 'Subjective' }, { key: 'O', label: 'Objective' }, { key: 'A', label: 'Assessment' }, { key: 'P', label: 'Plan' }],
  adime: [{ key: 'A', label: 'Assessment' }, { key: 'D', label: 'Diagnosis (nutrition)' }, { key: 'I', label: 'Intervention' }, { key: 'ME', label: 'Monitoring & evaluation' }],
  narrative: [{ key: 'text', label: 'Narrative' }],
  follow_up: [{ key: 'text', label: 'Follow-up note' }],
  patient_instructions: [{ key: 'text', label: 'Patient instructions (draft)' }],
};
export const draftingJobStatusSchema = z.enum(['requested', 'completed', 'failed', 'cancelled']);
export const draftingRequestSchema = z.object({ recordingId: uuid, transcriptId: uuid, commandId: uuid, noteType: draftingNoteTypeSchema }).strict();
export const draftingRecordingSchema = z.object({ recordingId: uuid }).strict();
export const draftingReadSchema = z.object({ proposedNoteId: uuid }).strict();
export const draftingOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('request'), input: draftingRequestSchema }).strict(),
  z.object({ operation: z.literal('advance'), input: draftingRecordingSchema }).strict(),
  z.object({ operation: z.literal('list'), input: draftingRecordingSchema }).strict(),
  z.object({ operation: z.literal('read'), input: draftingReadSchema }).strict(),
  z.object({ operation: z.literal('reconcile'), input: draftingRecordingSchema }).strict(),
]);
export type DraftingOperation = z.infer<typeof draftingOperationSchema>;
export const draftingReceiptSchema = z.object({ jobId: uuid, recordingId: uuid, transcriptId: uuid, commandId: uuid, noteType: draftingNoteTypeSchema,
  status: draftingJobStatusSchema, replayed: z.boolean() }).strict();
export type DraftingReceipt = z.infer<typeof draftingReceiptSchema>;
export const proposedNoteVersionSchema = z.object({ proposedNoteId: uuid, version: z.number().int().positive(), noteType: draftingNoteTypeSchema, transcriptId: uuid,
  contentSha256: hash, byteLength: z.number().int().positive(), sectionCount: z.number().int().min(1).max(8), model: z.string().min(3).max(100),
  createdBy: uuid, createdAt: date }).strict();
export const draftingListingSchema = z.object({ recordingId: uuid, status: z.enum(['capturing', 'paused', 'revoked', 'closed']),
  latestTranscript: z.object({ transcriptId: uuid, version: z.number().int().positive() }).strict().nullable(),
  job: z.object({ jobId: uuid, status: draftingJobStatusSchema, noteType: draftingNoteTypeSchema, transcriptId: uuid, failureCode: z.string().nullable(),
    createdAt: date, updatedAt: date }).strict().nullable(),
  versions: z.array(proposedNoteVersionSchema).max(200) }).strict();
export type DraftingListing = z.infer<typeof draftingListingSchema>;
export const proposedNoteSectionSchema = z.object({ key: z.string().min(1).max(8), label: z.string().min(1).max(80), text: z.string().max(20_000) }).strict();
/** The stored proposed-note document. `cautions` are the model's own flagged uncertainties; they are shown, never hidden. */
export const proposedNoteDocumentSchema = z.object({ contract: z.literal('proposed-note/1'), noteType: draftingNoteTypeSchema, transcriptId: uuid,
  transcriptSha256: hash, model: z.string().min(3).max(100), promptSha256: hash, sections: z.array(proposedNoteSectionSchema).min(1).max(8),
  cautions: z.array(z.string().min(1).max(400)).max(20) }).strict();
export type ProposedNoteDocument = z.infer<typeof proposedNoteDocumentSchema>;
export const proposedNoteContentSchema = z.object({ proposedNoteId: uuid, recordingId: uuid, version: z.number().int().positive(), contentSha256: hash,
  document: proposedNoteDocumentSchema }).strict();
export type ProposedNoteContent = z.infer<typeof proposedNoteContentSchema>;
export const draftingCapabilitiesSchema = z.object({ aiDrafting: z.literal(true), writesClinicalNotes: z.literal(false), reason: z.literal('review_only') }).strict();
export function parseDraftingResponse(request: DraftingOperation, raw: unknown) {
  const dataSchema = request.operation === 'request' ? draftingReceiptSchema : request.operation === 'read' ? proposedNoteContentSchema : draftingListingSchema;
  const result = z.object({ data: dataSchema, capabilities: draftingCapabilitiesSchema }).strict().parse(raw);
  if (request.operation === 'read') {
    if (!('document' in result.data) || result.data.proposedNoteId !== request.input.proposedNoteId) throw new Error('drafting_response_mismatch');
  } else {
    if (!('recordingId' in result.data) || result.data.recordingId !== request.input.recordingId) throw new Error('drafting_response_mismatch');
    if (request.operation === 'request' && (!('commandId' in result.data) || result.data.commandId !== request.input.commandId
      || result.data.transcriptId !== request.input.transcriptId || result.data.noteType !== request.input.noteType)) throw new Error('drafting_response_mismatch');
  }
  return result;
}
