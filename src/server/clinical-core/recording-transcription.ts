if (typeof window !== 'undefined') throw new Error('recording-transcription is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { recordingStorageSchema } from './recording-segments';
import { transcriptionListingSchema, transcriptionReceiptSchema, transcriptContentSchema,
  type TranscriptionListing, type TranscriptionReceipt, type TranscriptContent } from '@/contracts/encounterRecordingTranscription';

/** Transcription of a finished encounter recording. Every provider and storage
 * step is bounded and re-authorized through the database: consent, holds and
 * cleanup are checked when the job is requested, when media is assembled and
 * when the transcript is stored. Text is stored as an immutable object per
 * version; the database holds digests, never transcript content. */
export class RecordingTranscriptionError extends Error {
  constructor(readonly code: 'request_invalid' | 'access_refused' | 'consent_required' | 'conflict' | 'refused' | 'legal_hold'
    | 'service_unavailable' | 'storage_unverified' | 'media_too_large') { super(code); this.name = 'RecordingTranscriptionError'; }
}
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const providerConfigurationSchema = z.object({ provider: z.literal('aws_transcribe'), region: z.string().regex(/^us-(east|west)-[12]$/),
  languageCode: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/) }).strict();
export const transcriptionMediaSchema = z.object({ jobId: uuid, recordingId: uuid, organizationId: uuid,
  contentType: z.enum(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg']), status: z.enum(['requested', 'processing']),
  providerJobName: z.string().nullable(), storage: recordingStorageSchema, provider: providerConfigurationSchema,
  segments: z.array(z.object({ sequence: z.number().int().min(0).max(4095), objectKey: z.string().min(1).max(512), objectVersion: z.string().min(1),
    sha256: hash, bytes: z.number().int().min(1).max(4194304) }).strict()).min(1).max(4096) }).strict();
export type TranscriptionMedia = z.infer<typeof transcriptionMediaSchema>;
const objectSchema = z.object({ transcriptId: uuid, recordingId: uuid, version: z.number().int().positive(), objectKey: z.string().min(1).max(512),
  contentSha256: hash, byteLength: z.number().int().positive(), storage: recordingStorageSchema }).strict();
const stateSchema = z.object({ jobId: uuid, status: z.string(), providerJobName: z.string().nullable().optional(), failureCode: z.string().nullable().optional(),
  replayed: z.boolean() }).passthrough();
const completionSchema = z.object({ jobId: uuid, status: z.enum(['completed', 'failed']), transcriptId: uuid.nullable(), version: z.number().nullable(),
  failureCode: z.string().optional(), contentSha256: hash.optional(), replayed: z.boolean() }).passthrough();
const correctionSchema = z.object({ transcriptId: uuid, jobId: uuid, version: z.number().int().min(2), supersedesId: uuid, contentSha256: hash }).strict();
const artifactReceiptSchema = z.object({ artifactId: uuid, jobId: uuid, kind: z.enum(['media', 'provider', 'transcript']), replayed: z.boolean() }).strict();
/** Every object kind the recording services write under a recording prefix; cleanup verifies each by kind. */
export type TranscriptionArtifactKind = z.infer<typeof artifactReceiptSchema>['kind'] | 'proposed_note';

export interface RecordingTranscriptionRepository {
  request(context: ProductionClinicalRequestContext, recordingId: string, commandId: string, releaseId: string): Promise<TranscriptionReceipt>;
  media(context: ProductionClinicalRequestContext, jobId: string): Promise<TranscriptionMedia>;
  markProcessing(context: ProductionClinicalRequestContext, jobId: string, providerJobName: string): Promise<void>;
  fail(context: ProductionClinicalRequestContext, jobId: string, code: string): Promise<void>;
  complete(context: ProductionClinicalRequestContext, jobId: string, objectKey: string, sha256: string, bytes: number, words: number): Promise<z.infer<typeof completionSchema>>;
  correct(context: ProductionClinicalRequestContext, recordingId: string, objectKey: string, sha256: string, bytes: number, words: number, reason: string): Promise<z.infer<typeof correctionSchema>>;
  list(context: ProductionClinicalRequestContext, recordingId: string): Promise<TranscriptionListing>;
  object(context: ProductionClinicalRequestContext, transcriptId: string): Promise<z.infer<typeof objectSchema>>;
  /** Expected transcription and drafting objects that have no artifact row yet. */
  unregistered(context: ProductionClinicalRequestContext, recordingId: string): Promise<UnregisteredObject[]>;
  /** Registers an object the processor wrote or read back so hold-aware cleanup can verify and delete it. */
  registerArtifact(context: ProductionClinicalRequestContext, jobId: string, kind: Exclude<TranscriptionArtifactKind, 'proposed_note'>, objectKey: string, objectVersion: string,
    sha256: string, bytes: number, transcriptId?: string): Promise<z.infer<typeof artifactReceiptSchema>>;
}
export function createRecordingTranscriptionRepository(database: ClinicalCoreDatabase): RecordingTranscriptionRepository {
  async function query<T>(context: ProductionClinicalRequestContext, sql: string, parameters: unknown[], schema: z.ZodType<T>): Promise<T> {
    if (context.identityPool !== 'workforce' || context.purpose !== 'clinical_data' || context.environment !== 'production-clinical'
      || context.dataClassification !== 'clinical_phi' || context.productionBound !== true || context.containsPhi !== true || context.realPatientData !== true)
      throw new RecordingTranscriptionError('access_refused');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool, context.identitySubject,
          context.purpose, context.environment, context.dataClassification]);
        const result = await tx.query<{ data: unknown }>(sql, parameters), raw = result.rows[0]?.data;
        const parsed = schema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
        if (!parsed.success) throw new RecordingTranscriptionError('service_unavailable');
        return parsed.data;
      });
    } catch (error) {
      if (error instanceof RecordingTranscriptionError) throw error;
      if (error instanceof ClinicalCoreDatabaseRejection) {
        // The database layer forwards a category only; SQL detail never leaves it.
        if (error.category === 'legal_hold') throw new RecordingTranscriptionError('legal_hold');
        if (error.category === 'operation_refused') throw new RecordingTranscriptionError('refused');
        if (['consent_required', 'conflict', 'request_invalid'].includes(error.category)) throw new RecordingTranscriptionError(error.category as 'consent_required' | 'conflict' | 'request_invalid');
        throw new RecordingTranscriptionError('access_refused');
      }
      throw new RecordingTranscriptionError('service_unavailable');
    }
  }
  const id = (value: string) => { if (!uuid.safeParse(value).success) throw new RecordingTranscriptionError('request_invalid'); return clinicalUuid(value); };
  return {
    // Every method is async so identifier validation rejects instead of throwing synchronously.
    request: async (c, recordingId, commandId, releaseId) => query(c, 'select clinical_private.request_recording_transcription($1,$2,$3) as data',
      [id(recordingId), id(commandId), id(releaseId)], transcriptionReceiptSchema),
    media: async (c, jobId) => query(c, 'select clinical_private.get_recording_transcription_media($1) as data', [id(jobId)], transcriptionMediaSchema),
    async markProcessing(c, jobId, providerJobName) {
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(providerJobName)) throw new RecordingTranscriptionError('request_invalid');
      await query(c, 'select clinical_private.mark_recording_transcription_processing($1,$2) as data', [id(jobId), providerJobName], stateSchema);
    },
    async fail(c, jobId, code) {
      await query(c, 'select clinical_private.fail_recording_transcription($1,$2) as data', [id(jobId), code.slice(0, 80)], stateSchema);
    },
    complete: async (c, jobId, objectKey, sha256, bytes, words) => query(c, 'select clinical_private.complete_recording_transcription($1,$2,$3,$4::integer,$5::integer) as data',
      [id(jobId), objectKey, sha256, bytes, words], completionSchema),
    correct: async (c, recordingId, objectKey, sha256, bytes, words, reason) => query(c, 'select clinical_private.correct_recording_transcript($1,$2,$3,$4::integer,$5::integer,$6) as data',
      [id(recordingId), objectKey, sha256, bytes, words, reason], correctionSchema),
    list: async (c, recordingId) => query(c, 'select clinical_private.list_recording_transcripts($1) as data', [id(recordingId)], transcriptionListingSchema),
    object: async (c, transcriptId) => query(c, 'select clinical_private.get_recording_transcript_object($1) as data', [id(transcriptId)], objectSchema),
    unregistered: async (c, recordingId) => query(c, 'select clinical_private.list_unregistered_recording_objects($1) as data', [id(recordingId)], z.array(unregisteredObjectSchema).max(512)),
    async registerArtifact(c, jobId, kind, objectKey, objectVersion, sha256, bytes, transcriptId) {
      if (!/^[A-Za-z0-9+/=._-]{1,1024}$/.test(objectVersion) || objectVersion === 'null') throw new RecordingTranscriptionError('storage_unverified');
      return query(c, 'select clinical_private.register_recording_transcription_artifact($1,$2,$3,$4,$5,$6::integer,$7) as data',
        [id(jobId), kind, objectKey, objectVersion, sha256, bytes, transcriptId ? id(transcriptId) : null], artifactReceiptSchema);
    },
  };
}

export type TranscriptionStorage = z.infer<typeof recordingStorageSchema>;
/** Bounded object access. Reads verify the digest the database recorded; writes
 * are create-only under the organization's recording prefix and KMS key. */
export type TranscriptionObjectTags = { recordingId: string; jobId: string; kind: TranscriptionArtifactKind };
export interface TranscriptionMediaStore {
  /** Returns the bytes and the exact object version read; a versionless store cannot be cleaned up and is refused. */
  get(storage: TranscriptionStorage, key: string, version: string | undefined, maxBytes: number): Promise<{ bytes: Uint8Array; version: string | null }>;
  /** Create-only write with a full-object SHA-256 checksum and provenance metadata; returns the version created. */
  put(storage: TranscriptionStorage, key: string, bytes: Uint8Array, contentType: string, tags: TranscriptionObjectTags): Promise<{ version: string | null }>;
  /** Current version, size and full-object SHA-256 (when S3 reports one) of an object, or null when it does not exist. */
  head(storage: TranscriptionStorage, key: string): Promise<{ version: string | null; bytes: number; sha256: string | null } | null>;
}
export const unregisteredObjectSchema = z.object({ kind: z.enum(['media', 'provider', 'transcript', 'proposed_note']), jobId: uuid, objectKey: z.string().min(1).max(512),
  sha256: hash.nullable(), bytes: z.number().int().min(1).max(268435456).nullable(), transcriptId: uuid.nullable(), proposedNoteId: uuid.nullable() }).strict();
export type UnregisteredObject = z.infer<typeof unregisteredObjectSchema>;
/** Registers every expected object that exists but has no artifact row: exact
 * version and size from HEAD, digest from HEAD when S3 reports one or from a
 * bounded read otherwise. Objects that do not exist are skipped; the database
 * verifies each registration. Never writes or deletes an object. */
export async function reconcileRecordingArtifacts(input: { media: TranscriptionMediaStore; storage: TranscriptionStorage; objects: UnregisteredObject[];
  register: (object: UnregisteredObject, version: string, sha256: string, bytes: number) => Promise<void> }): Promise<{ registered: number; skipped: number }> {
  let registered = 0, skipped = 0;
  for (const object of input.objects.slice(0, 64)) {
    const head = await input.media.head(input.storage, object.objectKey);
    if (!head || !head.version) { skipped += 1; continue; }
    if (object.bytes !== null && head.bytes !== object.bytes) throw new RecordingTranscriptionError('storage_unverified');
    let digest = head.sha256;
    if (!digest) {
      if (head.bytes > 16 * 1024 * 1024) throw new RecordingTranscriptionError('storage_unverified');
      const read = await input.media.get(input.storage, object.objectKey, head.version, head.bytes);
      if (read.bytes.length !== head.bytes) throw new RecordingTranscriptionError('storage_unverified');
      digest = createHash('sha256').update(read.bytes).digest('hex');
    }
    if (object.sha256 !== null && digest !== object.sha256) throw new RecordingTranscriptionError('storage_unverified');
    await input.register(object, head.version, digest, head.bytes);
    registered += 1;
  }
  return { registered, skipped };
}
export interface TranscriptionProvider {
  start(input: { jobName: string; storage: TranscriptionStorage; mediaKey: string; contentType: string; outputKey: string; languageCode: string }): Promise<void>;
  status(jobName: string, storage: TranscriptionStorage): Promise<{ state: 'queued' | 'processing' | 'completed' | 'failed'; failure?: string }>;
}
export const MAX_TRANSCRIPTION_MEDIA_BYTES = 256 * 1024 * 1024;
const MEDIA_FORMAT: Record<TranscriptionMedia['contentType'], string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3' };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const words = (text: string) => text.trim() ? text.trim().split(/\s+/).length : 0;
export const transcriptionPrefix = (media: Pick<TranscriptionMedia, 'organizationId' | 'recordingId' | 'jobId'>) =>
  `encounter-recordings/${media.organizationId}/${media.recordingId}/transcription/${media.jobId}`;
/** Extracts the transcript text from a provider result document. Only the
 * documented AWS Transcribe shape is accepted; anything else is a failure. */
export function providerTranscriptText(raw: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new RecordingTranscriptionError('storage_unverified'); }
  const schema = z.object({ results: z.object({ transcripts: z.array(z.object({ transcript: z.string().max(2_000_000) }).passthrough()).min(1) }).passthrough() }).passthrough();
  const result = schema.safeParse(parsed);
  if (!result.success) throw new RecordingTranscriptionError('storage_unverified');
  return result.data.results.transcripts.map(t => t.transcript).join('\n');
}
export function createRecordingTranscriptionProcessor(input: { repository: RecordingTranscriptionRepository; media: TranscriptionMediaStore;
  provider: TranscriptionProvider; releaseId: string }) {
  const { repository, media, provider } = input;
  async function assemble(context: ProductionClinicalRequestContext, m: TranscriptionMedia): Promise<string> {
    const total = m.segments.reduce((sum, s) => sum + s.bytes, 0);
    if (total > MAX_TRANSCRIPTION_MEDIA_BYTES) throw new RecordingTranscriptionError('media_too_large');
    const parts: Uint8Array[] = [];
    for (const [index, segment] of m.segments.entries()) {
      if (segment.sequence !== index) throw new RecordingTranscriptionError('storage_unverified');
      const { bytes } = await media.get(m.storage, segment.objectKey, segment.objectVersion, segment.bytes);
      if (bytes.length !== segment.bytes || sha256(bytes) !== segment.sha256) throw new RecordingTranscriptionError('storage_unverified');
      parts.push(bytes);
    }
    const joined = Buffer.concat(parts);
    const key = `${transcriptionPrefix(m)}/media.${MEDIA_FORMAT[m.contentType]}`;
    // Re-check authority after the reads: a withdrawal during assembly stops here.
    await repository.media(context, m.jobId);
    const written = await media.put(m.storage, key, joined, m.contentType, { recordingId: m.recordingId, jobId: m.jobId, kind: 'media' });
    await register(context, m.jobId, 'media', key, written.version, sha256(joined), joined.length);
    return key;
  }
  /** Every object under the transcription prefix is registered with its exact version and digest before the step returns. */
  async function register(context: ProductionClinicalRequestContext, jobId: string, kind: Exclude<TranscriptionArtifactKind, 'proposed_note'>, key: string, version: string | null,
    digest: string, bytes: number, transcriptId?: string) {
    if (!version) throw new RecordingTranscriptionError('storage_unverified');
    await repository.registerArtifact(context, jobId, kind, key, version, digest, bytes, transcriptId);
  }
  /** Transcription-side objects only; proposed notes are reconciled by the drafting processor. */
  async function reconcile(context: ProductionClinicalRequestContext, recordingId: string, storage: TranscriptionStorage) {
    const objects = (await repository.unregistered(context, recordingId)).filter(o => o.kind !== 'proposed_note');
    if (!objects.length) return;
    await reconcileRecordingArtifacts({ media, storage, objects, register: (o, version, digest, bytes) =>
      repository.registerArtifact(context, o.jobId, o.kind as Exclude<TranscriptionArtifactKind, 'proposed_note'>, o.objectKey, version, digest, bytes, o.transcriptId ?? undefined).then(() => undefined) });
  }
  return {
    request(context: ProductionClinicalRequestContext, recordingId: string, commandId: string) {
      return repository.request(context, recordingId, commandId, input.releaseId);
    },
    /** Registers any object written before a crash prevented its registration. Storage coordinates come from a transcript object the owner can read. */
    async reconcile(context: ProductionClinicalRequestContext, recordingId: string): Promise<void> {
      const listing = await repository.list(context, recordingId);
      const latest = listing.versions.at(-1);
      if (!latest) return;
      const object = await repository.object(context, latest.transcriptId);
      await reconcile(context, recordingId, object.storage);
    },
    /** One bounded step per call: assemble and start, or poll and store. */
    async advance(context: ProductionClinicalRequestContext, recordingId: string): Promise<TranscriptionListing> {
      const listing = await repository.list(context, recordingId);
      const job = listing.job;
      if (!job || !['requested', 'processing'].includes(job.status)) return listing;
      const m = await repository.media(context, job.jobId);
      const jobName = `alp-${m.jobId}`;
      if (m.status === 'requested') {
        const mediaKey = await assemble(context, m);
        await provider.start({ jobName, storage: m.storage, mediaKey, contentType: m.contentType, outputKey: `${transcriptionPrefix(m)}/provider.json`, languageCode: m.provider.languageCode });
        await repository.markProcessing(context, m.jobId, jobName);
        return repository.list(context, recordingId);
      }
      const state = await provider.status(m.providerJobName ?? jobName, m.storage);
      if (state.state === 'failed') { await repository.fail(context, m.jobId, `provider_failed:${(state.failure ?? 'unknown').slice(0, 40)}`); return repository.list(context, recordingId); }
      if (state.state !== 'completed') return listing;
      const providerKey = `${transcriptionPrefix(m)}/provider.json`;
      const raw = await media.get(m.storage, providerKey, undefined, 16 * 1024 * 1024);
      // The provider wrote this object; register it before anything derived from it exists.
      await register(context, m.jobId, 'provider', providerKey, raw.version, sha256(raw.bytes), raw.bytes.length);
      const text = providerTranscriptText(Buffer.from(raw.bytes).toString('utf8'));
      const bytes = Buffer.from(text, 'utf8');
      if (!bytes.length || bytes.length > 16 * 1024 * 1024) { await repository.fail(context, m.jobId, 'provider_transcript_invalid'); return repository.list(context, recordingId); }
      const key = `${transcriptionPrefix(m)}/transcript-v1.txt`;
      const written = await media.put(m.storage, key, bytes, 'text/plain; charset=utf-8', { recordingId: m.recordingId, jobId: m.jobId, kind: 'transcript' });
      const completion = await repository.complete(context, m.jobId, key, sha256(bytes), bytes.length, words(text));
      if (completion.status === 'completed' && completion.transcriptId)
        await register(context, m.jobId, 'transcript', key, written.version, sha256(bytes), bytes.length, completion.transcriptId);
      // Anything an earlier interrupted step wrote but could not register is picked up now.
      await reconcile(context, recordingId, m.storage);
      return repository.list(context, recordingId);
    },
    async correct(context: ProductionClinicalRequestContext, recordingId: string, text: string, reason: string) {
      const listing = await repository.list(context, recordingId);
      const latest = listing.versions.at(-1);
      if (!latest || !listing.job) throw new RecordingTranscriptionError('refused');
      const bytes = Buffer.from(text, 'utf8');
      if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new RecordingTranscriptionError('request_invalid');
      const digest = sha256(bytes);
      if (digest === latest.contentSha256) throw new RecordingTranscriptionError('conflict');
      const object = await repository.object(context, latest.transcriptId);
      const key = `${object.objectKey.replace(/\/transcript-v\d+\.txt$/, '')}/transcript-v${latest.version + 1}.txt`;
      const written = await media.put(object.storage, key, bytes, 'text/plain; charset=utf-8', { recordingId, jobId: listing.job.jobId, kind: 'transcript' });
      const corrected = await repository.correct(context, recordingId, key, digest, bytes.length, words(text), reason);
      await register(context, corrected.jobId, 'transcript', key, written.version, digest, bytes.length, corrected.transcriptId);
      return corrected;
    },
    async read(context: ProductionClinicalRequestContext, transcriptId: string): Promise<TranscriptContent> {
      const object = await repository.object(context, transcriptId);
      const { bytes } = await media.get(object.storage, object.objectKey, undefined, object.byteLength);
      if (bytes.length !== object.byteLength || sha256(bytes) !== object.contentSha256) throw new RecordingTranscriptionError('storage_unverified');
      return transcriptContentSchema.parse({ transcriptId: object.transcriptId, recordingId: object.recordingId, version: object.version,
        contentSha256: object.contentSha256, text: Buffer.from(bytes).toString('utf8') });
    },
    list: (context: ProductionClinicalRequestContext, recordingId: string) => repository.list(context, recordingId),
  };
}
