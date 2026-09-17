import { z } from 'zod';

// Browser-safe wire contracts; no database, credentials, SDKs or provider access.
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().safe();
const date = z.string().datetime({ offset: true });
export const recordingContentTypeSchema = z.enum(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg']);
export const recordingStartSchema = z.object({ encounterId: uuid, commandId: uuid, contentType: recordingContentTypeSchema }).strict();
export const recordingStartReceiptSchema = z.object({ recordingId: uuid, sessionId: uuid, encounterId: uuid, commandId: uuid,
  contentType: recordingContentTypeSchema, status: z.enum(['capturing', 'paused', 'revoked', 'closed']), replayed: z.boolean(),
  captureToken: hash.nullable(), credentialVersion: counter, authorityEpoch: counter, expiresAt: date, deletionDeadline: date }).strict()
  .refine(r => r.replayed ? r.captureToken === null : r.captureToken !== null && r.status === 'capturing' && r.credentialVersion === 0);
const actions = z.enum(['pause', 'resume', 'renew', 'finish', 'discard']);
const closing = (action: string) => action === 'finish' || action === 'discard';
const credential = (action: string) => action === 'resume' || action === 'renew';
export const recordingLifecycleCommandSchema = z.object({ recordingId: uuid, commandId: uuid, action: actions,
  expectedVersion: counter.max(Number.MAX_SAFE_INTEGER - 1), inventorySha256: hash.nullable() }).strict()
  .refine(r => closing(r.action) === (r.inventorySha256 !== null));
export type RecordingLifecycleCommand = z.infer<typeof recordingLifecycleCommandSchema>;
export const recordingRecoveryStateSchema = z.object({ recordingId: uuid, sessionId: uuid,
  status: z.enum(['capturing', 'paused', 'revoked', 'closed']), credentialVersion: counter,
  authorityEpoch: counter, currentAuthorityEpoch: counter, tokenExpiresAt: date, deletionDeadline: date,
  storedSegments: counter.max(4096), pendingSegments: counter.max(1), reservedBytes: counter.max(2147483648),
  nextSequence: counter.max(4096), inventorySha256: hash, disposition: z.enum(['finish', 'discard']).nullable(),
  processingRequested: z.literal(false), audioDeleted: z.literal(false) }).strict()
  .refine(r => r.nextSequence === r.storedSegments + r.pendingSegments
    && r.currentAuthorityEpoch >= r.authorityEpoch && (r.status === 'closed') === (r.disposition !== null));
export type RecordingRecoveryState = z.infer<typeof recordingRecoveryStateSchema>;
export const recordingLifecycleReceiptSchema = z.object({ recordingId: uuid, commandId: uuid, action: actions,
  statusAtCommand: z.enum(['capturing', 'paused', 'closed']), credentialVersion: counter.min(1), expiresAt: date,
  inventorySha256: hash.nullable(), processingRequested: z.literal(false), audioDeleted: z.literal(false),
  replayed: z.boolean(), captureToken: hash.nullable(), requiresCredentialRecovery: z.boolean() }).strict()
  .refine(r => r.statusAtCommand === (closing(r.action) ? 'closed' : r.action === 'pause' ? 'paused' : 'capturing')
    && closing(r.action) === (r.inventorySha256 !== null)
    && (r.captureToken !== null) === (credential(r.action) && !r.replayed)
    && r.requiresCredentialRecovery === (credential(r.action) && r.replayed));
export type RecordingLifecycleReceipt = z.infer<typeof recordingLifecycleReceiptSchema>;

export const recordingStateRequestSchema = z.object({ recordingId: uuid }).strict();
export const recordingSegmentInputSchema = z.object({ recordingId: uuid, sessionId: uuid,
  captureToken: hash, sequence: z.number().int().min(0).max(4095), sha256: hash,
  bytes: z.number().int().min(1).max(4194304), contentType: recordingContentTypeSchema.optional() }).strict();
export type RecordingSegmentInput = z.infer<typeof recordingSegmentInputSchema>;
export const recordingSegmentReceiptSchema = z.object({ segmentId: uuid, recordingId: uuid,
  sequence: z.number().int().min(0).max(4095), sha256: hash, bytes: z.number().int().min(1).max(4194304),
  authorityEpoch: counter, status: z.literal('stored') }).strict();
export type RecordingSegmentReceipt = z.infer<typeof recordingSegmentReceiptSchema>;
export const recordingCaptureRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('start'), input: recordingStartSchema }).strict(),
  z.object({ operation: z.literal('state'), input: recordingStateRequestSchema }).strict(),
  z.object({ operation: z.literal('command'), input: recordingLifecycleCommandSchema }).strict(),
  z.object({ operation: z.literal('segment'), input: recordingSegmentInputSchema.extend({ contentType: recordingContentTypeSchema }) }).strict(),
]);
export type RecordingCaptureRequest = z.infer<typeof recordingCaptureRequestSchema>;

/** Do not accept a valid-looking receipt for a different record, command or
 * segment. Replay secrets and non-implemented processing/deletion claims fail
 * schema validation before they can be shown to a user. */
export function parseRecordingCaptureResponse(request: RecordingCaptureRequest, raw: unknown) {
  if (request.operation === 'start') {
    const result = z.object({ data: recordingStartReceiptSchema }).strict().parse(raw), r = result.data;
    if (r.encounterId !== request.input.encounterId || r.commandId !== request.input.commandId || r.contentType !== request.input.contentType)
      throw new Error('recording_response_mismatch');
    return result;
  }
  if (request.operation === 'state') {
    const result = z.object({ data: recordingRecoveryStateSchema }).strict().parse(raw);
    if (result.data.recordingId !== request.input.recordingId) throw new Error('recording_response_mismatch');
    return result;
  }
  if (request.operation === 'command') {
    const result = z.object({ data: recordingLifecycleReceiptSchema }).strict().parse(raw), r = result.data, q = request.input;
    if (r.recordingId !== q.recordingId || r.commandId !== q.commandId || r.action !== q.action
      || r.credentialVersion !== q.expectedVersion + 1 || r.inventorySha256 !== q.inventorySha256) throw new Error('recording_response_mismatch');
    return result;
  }
  const result = z.object({ data: recordingSegmentReceiptSchema }).strict().parse(raw), r = result.data, q = request.input;
  if (r.recordingId !== q.recordingId || r.sequence !== q.sequence || r.bytes !== q.bytes || r.sha256 !== q.sha256)
    throw new Error('recording_response_mismatch');
  return result;
}
