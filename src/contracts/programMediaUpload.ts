import { z } from 'zod';
import { programMediaPrepareRequest, programMediaReadRequest, programMediaTextRequest,
  programMediaVersionRequest, programMediaReference } from './programMedia';

/** Browser-safe metadata only. Shared with the native host; no SDK, database,
 * credentials, receipt proof or provider upload identifier enters from a client. */
export const PROGRAM_MEDIA_HTTP_CONTRACT = 'program-media-control-http/1' as const;
export const PROGRAM_MEDIA_MULTIPART_REQUEST_CONTRACT = 'program-media-multipart-control/1' as const;
export const PROGRAM_MEDIA_PART_BYTES = 8_388_608;
export const PROGRAM_MEDIA_MAX_VIDEO_BYTES = 268_435_456;
const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const part = z.object({ partNumber: z.number().int().min(1).max(32),
  bytes: z.number().int().min(1).max(PROGRAM_MEDIA_PART_BYTES), sha256: digest }).strict();
/** Exactly ordered 8 MiB parts, with one possibly smaller final part. */
export const programMediaPartManifest = z.object({ totalBytes: z.number().int().safe().min(1).max(PROGRAM_MEDIA_MAX_VIDEO_BYTES),
  parts: z.array(part).min(1).max(32) }).strict().superRefine((m, c) => {
  const count = Math.ceil(m.totalBytes / PROGRAM_MEDIA_PART_BYTES);
  if (m.parts.length !== count || m.parts.some((p, i) => p.partNumber !== i + 1
    || p.bytes !== Math.min(PROGRAM_MEDIA_PART_BYTES, m.totalBytes - i * PROGRAM_MEDIA_PART_BYTES)))
    c.addIssue({ code: 'custom', message: 'program_media_part_manifest_mismatch' });
});
export type ProgramMediaPartManifest = z.infer<typeof programMediaPartManifest>;
export const programMediaControlCommand = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), request: programMediaPrepareRequest.refine(r => r.bytes <= (r.kind === 'image' ? 16_777_216 : PROGRAM_MEDIA_MAX_VIDEO_BYTES)) }).strict(),
  z.object({ operation: z.literal('reconcile'), request: programMediaReadRequest }).strict(),
  /** Read-only current-author inspection; no provider mutation or reconciliation. */
  z.object({ operation: z.literal('inspect'), request: programMediaReadRequest }).strict(),
  z.object({ operation: z.literal('attachText'), request: programMediaTextRequest }).strict(),
  z.object({ operation: z.literal('preview'), request: programMediaReadRequest }).strict(),
  z.object({ operation: z.literal('publish'), request: programMediaVersionRequest }).strict(),
  z.object({ operation: z.literal('retire'), request: programMediaVersionRequest }).strict(),
  z.object({ operation: z.literal('describeReference'), request: programMediaReference }).strict(),
  z.object({ operation: z.literal('cleanupOrphans'), request: z.object({ programId: uuid }).strict() }).strict(),
]);
export type ProgramMediaControlCommand = z.infer<typeof programMediaControlCommand>;
const reference = z.object({ artifactId: uuid }).strict(), write = reference.extend({ commandId: uuid });
const command = <O extends string, S extends z.ZodType>(operation: O, request: S) => z.object({ operation: z.literal(operation), request }).strict();
export const programMediaMultipartControlCommand = z.discriminatedUnion('operation', [
  command('start', write.extend({ manifest: programMediaPartManifest })), command('status', reference),
  command('create', write), command('part', write.extend({ partNumber: z.number().int().min(1).max(32) })),
  command('complete', write), command('reconcile', reference), command('cancel', reference), command('cleanup', reference),
]);
export type ProgramMediaMultipartControlCommand = z.infer<typeof programMediaMultipartControlCommand>;
export const programMediaMultipartView = z.object({
  artifactId: uuid, contentType: z.enum(['video/mp4', 'video/webm']), bytes: z.number().int().positive().max(PROGRAM_MEDIA_MAX_VIDEO_BYTES), sha256: digest,
  state: z.enum(['prepared', 'creation_admitted', 'uploading', 'completion_admitted', 'verifying', 'abort_requested', 'committed', 'aborted']),
  acceptBefore: z.string().datetime({ offset: true }), receivedParts: z.array(z.number().int().min(1).max(32)).max(32),
  pendingParts: z.array(z.number().int().min(1).max(32)).max(32), pendingWork: z.boolean(),
}).strict().superRefine((s, c) => {
  const count = Math.ceil(s.bytes / PROGRAM_MEDIA_PART_BYTES), received = new Set(s.receivedParts), pending = new Set(s.pendingParts);
  if (received.size !== s.receivedParts.length || pending.size !== s.pendingParts.length
    || [...received, ...pending].some(p => p > count) || [...pending].some(p => received.has(p))
    || (pending.size > 0 && !s.pendingWork) || (s.state === 'committed' && (s.pendingWork || received.size !== count))
    || (s.state === 'aborted' && s.pendingWork)) c.addIssue({ code: 'custom', message: 'program_media_progress_mismatch' });
});
export type ProgramMediaMultipartView = z.infer<typeof programMediaMultipartView>;
export const programMediaPartBodyAdmission = z.object({ totalBytes: z.number().int().positive().max(PROGRAM_MEDIA_MAX_VIDEO_BYTES),
  partNumber: z.number().int().min(1).max(32), sha256: digest }).strict();
