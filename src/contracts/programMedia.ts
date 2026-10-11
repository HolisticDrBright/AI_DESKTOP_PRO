import { z } from 'zod';

/**
 * `program-media/1`: the lifecycle of a governed lesson-media artifact for the patient program
 * a version carries. Browser-safe wire contracts; no database, credentials, SDKs or provider.
 *
 * Today the program contract's media slot is an https address (`programItemEducation.media`,
 * mirrored byte-for-byte in V2). An address proves nothing about who owns the bytes or whether
 * they were reviewed. This contract is the authoring side that address will come from once a
 * reviewed dedicated store exists: an artifact is prepared, admitted within bounds, committed
 * with its integrity recorded, and published by exact identity and version. The mirrored slot
 * is not changed here; the publication reference is what a successor slot would carry.
 *
 * Purpose is educational media only. No patient data is ever an input; the clinical recording
 * store is never reused; no browser calls a provider; a caption or transcript is supplied
 * material with its source declared, never generated here.
 */
export const PROGRAM_MEDIA_CONTRACT = 'program-media/1' as const;
export const PROGRAM_MEDIA_REFERENCE_CONTRACT = 'program-media-reference/1' as const;

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().safe();
const date = z.string().datetime({ offset: true });

export const PROGRAM_MEDIA_KINDS = ['video', 'image'] as const;
export const programMediaKind = z.enum(PROGRAM_MEDIA_KINDS);
export type ProgramMediaKind = z.infer<typeof programMediaKind>;

/** The only content types admitted, with the extension the object key must carry for each. */
export const PROGRAM_MEDIA_CONTENT_TYPES: Readonly<Record<ProgramMediaKind, Readonly<Record<string, string>>>> = {
  video: { 'video/mp4': 'mp4', 'video/webm': 'webm' },
  image: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' },
};
export const programMediaContentType = z.enum(['video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/webp']);
export type ProgramMediaContentType = z.infer<typeof programMediaContentType>;
export function programMediaExtension(kind: ProgramMediaKind, contentType: string): string | null {
  return PROGRAM_MEDIA_CONTENT_TYPES[kind][contentType] ?? null;
}

/** A file name the author supplied: letters, digits, dot, dash and underscore, one extension that matches the content type. */
export const programMediaFileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,118}\.[a-z0-9]{2,5}$/);

/** The storage an authoring runtime may be given. Declared values; a store that is not dedicated to educational media is refused by shape. */
export const programMediaStorageSchema = z.object({
  purpose: z.literal('educational_media'),
  phiAllowed: z.literal(false),
  dedicated: z.literal(true),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  expectedBucketOwner: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^us-(east|west)-[12]$/),
  kmsKeyArn: z.string(),
  maxImageBytes: counter.min(1).max(16_777_216),
  maxVideoBytes: counter.min(1).max(268_435_456),
  /** The https origin published references are served from. Never the bucket's own address. */
  publicOrigin: z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password && !/amazonaws\.com$/.test(url.hostname); }),
}).strict()
  .refine(s => new RegExp(`^arn:aws:kms:${s.region}:${s.expectedBucketOwner}:key/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(s.kmsKeyArn), { message: 'program_media_kms_key_mismatch' })
  .refine(s => !/recording|voice|encounter|transcript|phi|patient/.test(s.bucket), { message: 'program_media_bucket_not_dedicated' });
export type ProgramMediaStorage = z.infer<typeof programMediaStorageSchema>;

export const PROGRAM_MEDIA_STATES = ['reserved', 'ready', 'held', 'error', 'abandoned', 'retired'] as const;
export const programMediaState = z.enum(PROGRAM_MEDIA_STATES);
export type ProgramMediaState = z.infer<typeof programMediaState>;

/** Where a caption or transcript came from. Only supplied material is admitted; there is no generated source. */
export const PROGRAM_MEDIA_TEXT_SOURCES = ['supplied_by_author', 'supplied_vendor_file'] as const;
export const programMediaText = z.object({
  text: z.string().min(1).max(200_000),
  source: z.enum(PROGRAM_MEDIA_TEXT_SOURCES),
  format: z.enum(['plain', 'vtt']),
  sha256: hash,
}).strict();
export type ProgramMediaText = z.infer<typeof programMediaText>;

export const programMediaPrepareRequest = z.object({
  commandId: uuid,
  programId: uuid,
  kind: programMediaKind,
  contentType: programMediaContentType,
  bytes: counter.min(1),
  sha256: hash,
  fileName: programMediaFileName,
}).strict().refine(r => programMediaExtension(r.kind, r.contentType) !== null && r.fileName.endsWith('.' + programMediaExtension(r.kind, r.contentType)), { message: 'program_media_type_mismatch' });
export type ProgramMediaPrepareRequest = z.infer<typeof programMediaPrepareRequest>;

/** The identity of one artifact. Everything below carries it unchanged. */
const identity = {
  artifactId: uuid, clinic: uuid, programId: uuid, kind: programMediaKind, contentType: programMediaContentType,
  bytes: counter.min(1), sha256: hash, objectKey: z.string().min(1).max(512),
};
export const programMediaReservation = z.object({
  ...identity,
  commandId: uuid,
  state: z.enum(['reserved', 'error', 'abandoned']),
  acceptBefore: date,
  createdAt: date,
  /** True when this reservation was returned for a repeated command: the earlier one, not a second artifact. */
  replayed: z.boolean(),
  failure: z.string().max(80).nullable(),
}).strict();
export type ProgramMediaReservation = z.infer<typeof programMediaReservation>;

export const programMediaArtifact = z.object({
  ...identity,
  /** Increments on every change to the artifact's metadata; a publication names the exact one it saw. */
  version: counter.min(1),
  state: programMediaState,
  objectVersion: z.string().min(1).max(1024).refine(v => v !== 'null').nullable(),
  committedAt: date.nullable(),
  retiredAt: date.nullable(),
  failure: z.string().max(80).nullable(),
  caption: programMediaText.nullable(),
  transcript: programMediaText.nullable(),
}).strict().refine(a => (a.state === 'ready' || a.state === 'retired') === (a.objectVersion !== null && a.committedAt !== null), { message: 'program_media_state_inconsistent' })
  .refine(a => (a.state === 'retired') === (a.retiredAt !== null), { message: 'program_media_retirement_inconsistent' })
  .refine(a => a.caption === null || a.kind === 'video' || a.caption.format === 'plain', { message: 'program_media_caption_format' })
  .refine(a => a.transcript === null || a.kind === 'video', { message: 'program_media_transcript_kind' });
export type ProgramMediaArtifact = z.infer<typeof programMediaArtifact>;

export const programMediaAdmitRequest = z.object({ artifactId: uuid, sha256: hash, bytes: counter.min(1) }).strict();
export const programMediaTextRequest = z.object({
  artifactId: uuid, expectedVersion: counter.min(1), slot: z.enum(['caption', 'transcript']),
  text: z.string().min(1).max(200_000), source: z.enum(PROGRAM_MEDIA_TEXT_SOURCES), format: z.enum(['plain', 'vtt']),
}).strict();
export const programMediaVersionRequest = z.object({ artifactId: uuid, expectedVersion: counter.min(1) }).strict();
export const programMediaReadRequest = z.object({ artifactId: uuid }).strict();

/** What a published program step would carry: exact artifact, exact version, exact bytes, and where it came from. */
export const programMediaReference = z.object({
  contractVersion: z.literal(PROGRAM_MEDIA_REFERENCE_CONTRACT),
  artifactId: uuid, version: counter.min(1), sha256: hash, kind: programMediaKind, contentType: programMediaContentType, bytes: counter.min(1),
  origin: z.object({ clinic: uuid, programId: uuid }).strict(),
  /** The https address a patient app would load, under the dedicated public origin. */
  url: z.string().url(),
  publishedAt: date,
  caption: z.object({ source: z.enum(PROGRAM_MEDIA_TEXT_SOURCES), sha256: hash }).strict().nullable(),
  transcript: z.object({ source: z.enum(PROGRAM_MEDIA_TEXT_SOURCES), sha256: hash, format: z.enum(['plain', 'vtt']) }).strict().nullable(),
}).strict();
export type ProgramMediaReference = z.infer<typeof programMediaReference>;

/** A reference read later: still exact, and honest about whether the artifact has since been retired. */
export const programMediaReferenceStatus = z.object({
  reference: programMediaReference,
  /** True when the artifact is retired: the reference stays truthful about what was published, and nothing new may cite it. */
  historical: z.boolean(),
  /** False when the artifact's current bytes or version no longer match the reference. */
  current: z.boolean(),
}).strict();

/** A bounded, short-lived read of an artifact for the author's preview. Not the published address, not a write. */
export const programMediaPreview = z.object({
  artifactId: uuid, version: counter.min(1), state: programMediaState, kind: programMediaKind, contentType: programMediaContentType,
  bytes: counter.min(1), sha256: hash, previewToken: z.string().min(16).max(512), previewUntil: date, historical: z.boolean(),
}).strict();
export type ProgramMediaPreview = z.infer<typeof programMediaPreview>;

export const programMediaCleanupReceipt = z.object({
  programId: uuid, checkedAt: date,
  proofs: z.array(z.object({ artifactId: uuid, claimId: uuid, objectKey: z.string().min(1).max(512),
    checkedAt: date, complete: z.literal(true), remainingVersions: z.literal(0),
    removedVersions: z.array(z.string().min(1).max(1024)).max(1000),
  }).strict()).max(1000).default([]),
  actions: z.array(z.object({
    artifactId: uuid,
    outcome: z.enum(['abandoned_no_object', 'abandoned_object_removed', 'held_object_mismatch', 'recovered_ready', 'kept_pending']),
  }).strict()).max(1000),
}).strict().superRefine((receipt, ctx) => {
  if (new Set(receipt.actions.map(a => a.artifactId)).size !== receipt.actions.length
    || new Set(receipt.proofs.map(p => p.artifactId)).size !== receipt.proofs.length)
    ctx.addIssue({ code: 'custom', message: 'program_media_receipt_duplicate' });
  for (const action of receipt.actions) {
    const proof = receipt.proofs.find(p => p.artifactId === action.artifactId);
    const success = action.outcome === 'abandoned_no_object' || action.outcome === 'abandoned_object_removed';
    if (success !== !!proof || (proof && ((action.outcome === 'abandoned_no_object') !== (proof.removedVersions.length === 0)
      || new Set(proof.removedVersions).size !== proof.removedVersions.length)))
      ctx.addIssue({ code: 'custom', message: 'program_media_absence_unproven' });
  }
  if (receipt.proofs.some(p => !receipt.actions.some(a => a.artifactId === p.artifactId)))
    ctx.addIssue({ code: 'custom', message: 'program_media_receipt_unbound' });
});
export type ProgramMediaCleanupReceipt = z.infer<typeof programMediaCleanupReceipt>;

export const PROGRAM_MEDIA_FAILURES = [
  'program_media_disabled', 'request_invalid', 'access_refused', 'not_found', 'conflict', 'not_ready', 'retired',
  'storage_unverified', 'service_unavailable', 'reservation_expired', 'text_source_refused',
] as const;
export type ProgramMediaFailure = typeof PROGRAM_MEDIA_FAILURES[number];
