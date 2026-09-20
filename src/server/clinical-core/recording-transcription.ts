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

export interface RecordingTranscriptionRepository {
  request(context: ProductionClinicalRequestContext, recordingId: string, commandId: string, releaseId: string): Promise<TranscriptionReceipt>;
  media(context: ProductionClinicalRequestContext, jobId: string): Promise<TranscriptionMedia>;
  markProcessing(context: ProductionClinicalRequestContext, jobId: string, providerJobName: string): Promise<void>;
  fail(context: ProductionClinicalRequestContext, jobId: string, code: string): Promise<void>;
  complete(context: ProductionClinicalRequestContext, jobId: string, objectKey: string, sha256: string, bytes: number, words: number): Promise<z.infer<typeof completionSchema>>;
  correct(context: ProductionClinicalRequestContext, recordingId: string, objectKey: string, sha256: string, bytes: number, words: number, reason: string): Promise<z.infer<typeof correctionSchema>>;
  list(context: ProductionClinicalRequestContext, recordingId: string): Promise<TranscriptionListing>;
  object(context: ProductionClinicalRequestContext, transcriptId: string): Promise<z.infer<typeof objectSchema>>;
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
  };
}

export type TranscriptionStorage = z.infer<typeof recordingStorageSchema>;
/** Bounded object access. Reads verify the digest the database recorded; writes
 * are create-only under the organization's recording prefix and KMS key. */
export interface TranscriptionMediaStore {
  get(storage: TranscriptionStorage, key: string, version: string | undefined, maxBytes: number): Promise<Uint8Array>;
  put(storage: TranscriptionStorage, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
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
      const bytes = await media.get(m.storage, segment.objectKey, segment.objectVersion, segment.bytes);
      if (bytes.length !== segment.bytes || sha256(bytes) !== segment.sha256) throw new RecordingTranscriptionError('storage_unverified');
      parts.push(bytes);
    }
    const joined = Buffer.concat(parts);
    const key = `${transcriptionPrefix(m)}/media.${MEDIA_FORMAT[m.contentType]}`;
    // Re-check authority after the reads: a withdrawal during assembly stops here.
    await repository.media(context, m.jobId);
    await media.put(m.storage, key, joined, m.contentType);
    return key;
  }
  return {
    request(context: ProductionClinicalRequestContext, recordingId: string, commandId: string) {
      return repository.request(context, recordingId, commandId, input.releaseId);
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
      const raw = await media.get(m.storage, `${transcriptionPrefix(m)}/provider.json`, undefined, 16 * 1024 * 1024);
      const text = providerTranscriptText(Buffer.from(raw).toString('utf8'));
      const bytes = Buffer.from(text, 'utf8');
      if (!bytes.length || bytes.length > 16 * 1024 * 1024) { await repository.fail(context, m.jobId, 'provider_transcript_invalid'); return repository.list(context, recordingId); }
      const key = `${transcriptionPrefix(m)}/transcript-v1.txt`;
      await media.put(m.storage, key, bytes, 'text/plain; charset=utf-8');
      await repository.complete(context, m.jobId, key, sha256(bytes), bytes.length, words(text));
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
      await media.put(object.storage, key, bytes, 'text/plain; charset=utf-8');
      return repository.correct(context, recordingId, key, digest, bytes.length, words(text), reason);
    },
    async read(context: ProductionClinicalRequestContext, transcriptId: string): Promise<TranscriptContent> {
      const object = await repository.object(context, transcriptId);
      const bytes = await media.get(object.storage, object.objectKey, undefined, object.byteLength);
      if (bytes.length !== object.byteLength || sha256(bytes) !== object.contentSha256) throw new RecordingTranscriptionError('storage_unverified');
      return transcriptContentSchema.parse({ transcriptId: object.transcriptId, recordingId: object.recordingId, version: object.version,
        contentSha256: object.contentSha256, text: Buffer.from(bytes).toString('utf8') });
    },
    list: (context: ProductionClinicalRequestContext, recordingId: string) => repository.list(context, recordingId),
  };
}
