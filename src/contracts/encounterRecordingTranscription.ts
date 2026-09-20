import { z } from 'zod';

// Browser-safe wire contracts for encounter transcription. No provider or storage access.
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime({ offset: true });
export const transcriptionJobStatusSchema = z.enum(['requested', 'processing', 'completed', 'failed', 'cancelled']);
export const transcriptionRequestSchema = z.object({ recordingId: uuid, commandId: uuid }).strict();
export const transcriptionRecordingSchema = z.object({ recordingId: uuid }).strict();
export const transcriptionCorrectionSchema = z.object({ recordingId: uuid, text: z.string().min(1).max(2_000_000), reason: z.string().trim().min(1).max(400) }).strict();
export const transcriptionReadSchema = z.object({ transcriptId: uuid }).strict();
export const transcriptionOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('request'), input: transcriptionRequestSchema }).strict(),
  z.object({ operation: z.literal('advance'), input: transcriptionRecordingSchema }).strict(),
  z.object({ operation: z.literal('list'), input: transcriptionRecordingSchema }).strict(),
  z.object({ operation: z.literal('correct'), input: transcriptionCorrectionSchema }).strict(),
  z.object({ operation: z.literal('read'), input: transcriptionReadSchema }).strict(),
]);
export type TranscriptionOperation = z.infer<typeof transcriptionOperationSchema>;
export const transcriptionReceiptSchema = z.object({ jobId: uuid, recordingId: uuid, commandId: uuid, status: transcriptionJobStatusSchema,
  segmentCount: z.number().int().min(1).max(4096), inventorySha256: hash, replayed: z.boolean() }).strict();
export type TranscriptionReceipt = z.infer<typeof transcriptionReceiptSchema>;
export const transcriptVersionSchema = z.object({ transcriptId: uuid, version: z.number().int().positive(), kind: z.enum(['provider', 'correction']),
  contentSha256: hash, byteLength: z.number().int().positive(), wordCount: z.number().int().nonnegative(), supersedesId: uuid.nullable(),
  authorId: uuid, reason: z.string().nullable(), createdAt: date }).strict();
export const transcriptionListingSchema = z.object({ recordingId: uuid, status: z.enum(['capturing', 'paused', 'revoked', 'closed']),
  job: z.object({ jobId: uuid, status: transcriptionJobStatusSchema, providerJobName: z.string().nullable(), failureCode: z.string().nullable(),
    segmentCount: z.number().int().min(1), inventorySha256: hash, createdAt: date, updatedAt: date }).strict().nullable(),
  versions: z.array(transcriptVersionSchema).max(500) }).strict();
export type TranscriptionListing = z.infer<typeof transcriptionListingSchema>;
export const transcriptContentSchema = z.object({ transcriptId: uuid, recordingId: uuid, version: z.number().int().positive(), contentSha256: hash,
  text: z.string().max(2_000_000) }).strict();
export type TranscriptContent = z.infer<typeof transcriptContentSchema>;
export const transcriptionCapabilitiesSchema = z.object({ transcription: z.literal(true), aiDrafting: z.literal(false),
  reason: z.literal('ai_drafting_not_configured') }).strict();
/** Refuse a well-formed result for a different recording or transcript, any
 * drafting claim, and any field the contract does not name. */
export function parseTranscriptionResponse(request: TranscriptionOperation, raw: unknown) {
  const dataSchema = request.operation === 'request' ? transcriptionReceiptSchema
    : request.operation === 'read' ? transcriptContentSchema : transcriptionListingSchema;
  const result = z.object({ data: dataSchema, capabilities: transcriptionCapabilitiesSchema }).strict().parse(raw);
  if (request.operation === 'read') {
    if (!('text' in result.data) || result.data.transcriptId !== request.input.transcriptId) throw new Error('transcription_response_mismatch');
  } else {
    if (!('recordingId' in result.data) || result.data.recordingId !== request.input.recordingId) throw new Error('transcription_response_mismatch');
    if (request.operation === 'request' && (!('commandId' in result.data) || result.data.commandId !== request.input.commandId)) throw new Error('transcription_response_mismatch');
  }
  return result;
}
export type TranscriptionResponse = ReturnType<typeof parseTranscriptionResponse>;
