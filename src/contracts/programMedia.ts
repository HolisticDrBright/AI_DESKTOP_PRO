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
/** Reservation states. `writing` and `cleaning` are durable leases: exactly one party may act on the object at a time. */
export const PROGRAM_MEDIA_RESERVATION_STATES = ['reserved', 'writing', 'error', 'cleaning', 'abandoned'] as const;
export const programMediaLease = z.object({
  holder: z.enum(['writer', 'cleanup']),
  token: z.string().min(16).max(128),
  until: date,
}).strict();
export type ProgramMediaLease = z.infer<typeof programMediaLease>;
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
  state: z.enum(PROGRAM_MEDIA_RESERVATION_STATES),
  acceptBefore: date,
  createdAt: date,
  /** True when this reservation was returned for a repeated command: the earlier one, not a second artifact. */
  replayed: z.boolean(),
  failure: z.string().max(80).nullable(),
  /** The durable lease a writer or cleanup holds on this reservation's object, or null. */
  lease: programMediaLease.nullable(),
  /** When the exact object was proven absent from the store. Only then may a reservation rest as abandoned. */
  absenceProvenAt: date.nullable(),
  /** True while bytes may exist in the store that no committed artifact and no absence proof accounts for. */
  unresolvedStorage: z.boolean(),
}).strict()
  .refine(r => (r.state === 'writing') === (r.lease?.holder === 'writer') && (r.state === 'cleaning') === (r.lease?.holder === 'cleanup'), { message: 'program_media_lease_state' })
  .refine(r => r.state !== 'abandoned' || r.absenceProvenAt !== null || r.unresolvedStorage, { message: 'program_media_abandoned_without_proof' });
export type ProgramMediaReservation = z.infer<typeof programMediaReservation>;

export const programMediaArtifact = z.object({
  ...identity,
  /** Increments on every change to the artifact's metadata; a publication names the exact one it saw. */
  version: counter.min(1),
  state: programMediaState,
  objectVersion: z.string().min(1).max(1024).nullable(),
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
  /** The ledger's identity for this publication. A reference without a recorded publication of this id is not a publication. */
  publicationId: uuid,
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
  /** The publication exactly as the ledger recorded it: never the caller's copy. */
  reference: programMediaReference,
  /** True when the artifact is retired: the reference stays truthful about what was published, and nothing new may cite it. */
  historical: z.boolean(),
  /** True when the artifact's metadata moved on after this publication (a later version exists). */
  superseded: z.boolean(),
  /** True only when the artifact is ready at exactly this version with exactly these bytes. */
  current: z.boolean(),
}).strict();

/** A bounded, short-lived read of an artifact for the author's preview. Not the published address, not a write. */
export const programMediaPreview = z.object({
  artifactId: uuid, version: counter.min(1), state: programMediaState, kind: programMediaKind, contentType: programMediaContentType,
  bytes: counter.min(1), sha256: hash, previewToken: z.string().min(16).max(512), previewUntil: date, historical: z.boolean(),
}).strict();
export type ProgramMediaPreview = z.infer<typeof programMediaPreview>;

export const PROGRAM_MEDIA_CLEANUP_OUTCOMES = [
  /** No object at the key; absence proven; reservation abandoned. */
  'abandoned_no_object',
  /** The reservation's own uncommitted object was removed by exact version and its absence proven afterwards. */
  'abandoned_object_removed',
  /** An object is present that is not the reservation's; held for review, nothing deleted. */
  'held_object_mismatch',
  /** A delete was issued but the exact version (or a delete marker, or a store error) still stands; nothing is certified. */
  'removal_unproven',
  /** A writer holds the reservation, or the lease could not be taken; nothing touched. */
  'claim_refused',
  /** A committed, retired or held artifact: never cleanup's to touch. */
  'kept_pending',
] as const;
export const programMediaCleanupReceipt = z.object({
  programId: uuid, checkedAt: date,
  actions: z.array(z.object({
    artifactId: uuid,
    outcome: z.enum(PROGRAM_MEDIA_CLEANUP_OUTCOMES),
    /** What was actually proven: the removed version and the time the exact key was read back absent. Present only on the two abandoned outcomes. */
    proof: z.object({ removedVersion: z.string().min(1).max(1024).nullable(), absenceProvenAt: date }).strict().nullable(),
    /** Why nothing was certified, for the other outcomes. */
    detail: z.string().max(120).nullable(),
  }).strict()).max(1000),
}).strict();
export type ProgramMediaCleanupReceipt = z.infer<typeof programMediaCleanupReceipt>;

export const PROGRAM_MEDIA_FAILURES = [
  'program_media_disabled', 'request_invalid', 'access_refused', 'not_found', 'conflict', 'not_ready', 'retired',
  'storage_unverified', 'service_unavailable', 'reservation_expired', 'text_source_refused',
] as const;
export type ProgramMediaFailure = typeof PROGRAM_MEDIA_FAILURES[number];
