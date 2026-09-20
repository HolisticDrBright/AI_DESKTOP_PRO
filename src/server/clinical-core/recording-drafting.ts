if (typeof window !== 'undefined') throw new Error('recording-drafting is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { recordingStorageSchema } from './recording-segments';
import type { TranscriptionMediaStore } from './recording-transcription';
import { draftingListingSchema, draftingReceiptSchema, proposedNoteContentSchema, proposedNoteDocumentSchema, DRAFTING_SECTIONS,
  type DraftingListing, type DraftingReceipt, type DraftingNoteType, type ProposedNoteContent, type ProposedNoteDocument } from '@/contracts/encounterRecordingDrafting';

/** Review-only AI drafting from a stored transcript version. The provider sees
 * only the transcript text and the note structure; the result is a proposed
 * note stored as an immutable object with its digest in the database. Nothing
 * here reads or writes clinical notes. */
export class RecordingDraftingError extends Error {
  constructor(readonly code: 'request_invalid' | 'access_refused' | 'consent_required' | 'conflict' | 'refused' | 'legal_hold'
    | 'service_unavailable' | 'storage_unverified' | 'provider_unavailable' | 'provider_output_invalid') { super(code); this.name = 'RecordingDraftingError'; }
}
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const providerConfigurationSchema = z.object({ provider: z.literal('openai_responses'), model: z.string().min(3).max(100), promptSha256: hash,
  zeroDataRetention: z.literal(true) }).strict();
export const draftingInputSchema = z.object({ jobId: uuid, recordingId: uuid, organizationId: uuid, noteType: z.enum(['soap', 'narrative', 'follow_up', 'adime', 'patient_instructions']),
  status: z.literal('requested'), transcript: z.object({ transcriptId: uuid, version: z.number().int().positive(), objectKey: z.string().min(1).max(512), contentSha256: hash,
    byteLength: z.number().int().min(1).max(16777216) }).strict(), storage: recordingStorageSchema, provider: providerConfigurationSchema }).strict();
export type DraftingInput = z.infer<typeof draftingInputSchema>;
const objectSchema = z.object({ proposedNoteId: uuid, recordingId: uuid, transcriptId: uuid, noteType: z.string(), version: z.number().int().positive(),
  objectKey: z.string().min(1).max(512), contentSha256: hash, byteLength: z.number().int().positive(), storage: recordingStorageSchema }).strict();
const stateSchema = z.object({ jobId: uuid, status: z.string(), failureCode: z.string().nullable().optional(), replayed: z.boolean() }).passthrough();
const completionSchema = z.object({ jobId: uuid, status: z.enum(['completed', 'failed']), proposedNoteId: uuid.nullable(), version: z.number().nullable(),
  failureCode: z.string().optional(), contentSha256: hash.optional(), replayed: z.boolean() }).passthrough();
const artifactReceiptSchema = z.object({ artifactId: uuid, jobId: uuid, kind: z.literal('proposed_note'), replayed: z.boolean() }).strict();

export interface RecordingDraftingRepository {
  request(context: ProductionClinicalRequestContext, recordingId: string, transcriptId: string, commandId: string, releaseId: string, noteType: DraftingNoteType): Promise<DraftingReceipt>;
  input(context: ProductionClinicalRequestContext, jobId: string): Promise<DraftingInput>;
  fail(context: ProductionClinicalRequestContext, jobId: string, code: string): Promise<void>;
  complete(context: ProductionClinicalRequestContext, jobId: string, objectKey: string, sha256: string, bytes: number, sections: number, model: string): Promise<z.infer<typeof completionSchema>>;
  list(context: ProductionClinicalRequestContext, recordingId: string): Promise<DraftingListing>;
  object(context: ProductionClinicalRequestContext, proposedNoteId: string): Promise<z.infer<typeof objectSchema>>;
  registerArtifact(context: ProductionClinicalRequestContext, jobId: string, objectKey: string, objectVersion: string, sha256: string, bytes: number, proposedNoteId: string): Promise<z.infer<typeof artifactReceiptSchema>>;
}
export function createRecordingDraftingRepository(database: ClinicalCoreDatabase): RecordingDraftingRepository {
  async function query<T>(context: ProductionClinicalRequestContext, sql: string, parameters: unknown[], schema: z.ZodType<T>): Promise<T> {
    if (context.identityPool !== 'workforce' || context.purpose !== 'clinical_data' || context.environment !== 'production-clinical'
      || context.dataClassification !== 'clinical_phi' || context.productionBound !== true || context.containsPhi !== true || context.realPatientData !== true)
      throw new RecordingDraftingError('access_refused');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool, context.identitySubject,
          context.purpose, context.environment, context.dataClassification]);
        const result = await tx.query<{ data: unknown }>(sql, parameters), raw = result.rows[0]?.data;
        const parsed = schema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
        if (!parsed.success) throw new RecordingDraftingError('service_unavailable');
        return parsed.data;
      });
    } catch (error) {
      if (error instanceof RecordingDraftingError) throw error;
      if (error instanceof ClinicalCoreDatabaseRejection) {
        if (error.category === 'legal_hold') throw new RecordingDraftingError('legal_hold');
        if (error.category === 'operation_refused') throw new RecordingDraftingError('refused');
        if (['consent_required', 'conflict', 'request_invalid'].includes(error.category)) throw new RecordingDraftingError(error.category as 'consent_required' | 'conflict' | 'request_invalid');
        throw new RecordingDraftingError('access_refused');
      }
      throw new RecordingDraftingError('service_unavailable');
    }
  }
  const id = (value: string) => { if (!uuid.safeParse(value).success) throw new RecordingDraftingError('request_invalid'); return clinicalUuid(value); };
  return {
    request: async (c, recordingId, transcriptId, commandId, releaseId, noteType) => query(c, 'select clinical_private.request_recording_drafting($1,$2,$3,$4,$5) as data',
      [id(recordingId), id(transcriptId), id(commandId), id(releaseId), noteType], draftingReceiptSchema),
    input: async (c, jobId) => query(c, 'select clinical_private.get_recording_drafting_input($1) as data', [id(jobId)], draftingInputSchema),
    async fail(c, jobId, code) { await query(c, 'select clinical_private.fail_recording_drafting($1,$2) as data', [id(jobId), code.slice(0, 80)], stateSchema); },
    complete: async (c, jobId, objectKey, sha256, bytes, sections, model) => query(c, 'select clinical_private.complete_recording_drafting($1,$2,$3,$4::integer,$5::integer,$6) as data',
      [id(jobId), objectKey, sha256, bytes, sections, model], completionSchema),
    list: async (c, recordingId) => query(c, 'select clinical_private.list_recording_proposed_notes($1) as data', [id(recordingId)], draftingListingSchema),
    object: async (c, proposedNoteId) => query(c, 'select clinical_private.get_recording_proposed_note_object($1) as data', [id(proposedNoteId)], objectSchema),
    async registerArtifact(c, jobId, objectKey, objectVersion, sha256, bytes, proposedNoteId) {
      if (!/^[A-Za-z0-9+/=._-]{1,1024}$/.test(objectVersion) || objectVersion === 'null') throw new RecordingDraftingError('storage_unverified');
      return query(c, 'select clinical_private.register_recording_drafting_artifact($1,$2,$3,$4,$5::integer,$6) as data',
        [id(jobId), objectKey, objectVersion, sha256, bytes, id(proposedNoteId)], artifactReceiptSchema);
    },
  };
}

/** The only provider surface: transcript text in, structured sections out. */
export interface DraftingProvider {
  draft(input: { model: string; promptSha256: string; noteType: DraftingNoteType; sections: { key: string; label: string }[]; transcript: string; jobId: string },
    signal: AbortSignal): Promise<unknown>;
}
export const MAX_DRAFTING_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const providerOutputSchema = z.object({ sections: z.array(z.object({ key: z.string().min(1).max(8), text: z.string().max(20_000) }).strict()).min(1).max(8),
  cautions: z.array(z.string().min(1).max(400)).max(20) }).strict();
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const draftingPrefix = (input: Pick<DraftingInput, 'organizationId' | 'recordingId' | 'jobId'>) =>
  `encounter-recordings/${input.organizationId}/${input.recordingId}/drafting/${input.jobId}`;
/** Accepts only the exact section set of the requested note type, in order, with no extra keys. */
export function proposedNoteFromProvider(raw: unknown, input: DraftingInput, transcriptSha256: string): ProposedNoteDocument {
  const parsed = providerOutputSchema.safeParse(raw);
  if (!parsed.success) throw new RecordingDraftingError('provider_output_invalid');
  const expected = DRAFTING_SECTIONS[input.noteType];
  if (parsed.data.sections.length !== expected.length || parsed.data.sections.some((s, i) => s.key !== expected[i].key)) throw new RecordingDraftingError('provider_output_invalid');
  if (!parsed.data.sections.some(s => s.text.trim())) throw new RecordingDraftingError('provider_output_invalid');
  return proposedNoteDocumentSchema.parse({ contract: 'proposed-note/1', noteType: input.noteType, transcriptId: input.transcript.transcriptId, transcriptSha256,
    model: input.provider.model, promptSha256: input.provider.promptSha256,
    sections: parsed.data.sections.map((s, i) => ({ key: s.key, label: expected[i].label, text: s.text.trim() })), cautions: parsed.data.cautions.map(c => c.trim()).filter(Boolean) });
}
export function createRecordingDraftingProcessor(input: { repository: RecordingDraftingRepository; media: TranscriptionMediaStore; provider: DraftingProvider; releaseId: string;
  providerTimeoutMs?: number }) {
  const { repository, media, provider } = input;
  return {
    request(context: ProductionClinicalRequestContext, recordingId: string, transcriptId: string, commandId: string, noteType: DraftingNoteType) {
      return repository.request(context, recordingId, transcriptId, commandId, input.releaseId, noteType);
    },
    /** One bounded step: read and verify the transcript, call the provider once, store and register the proposed note. */
    async advance(context: ProductionClinicalRequestContext, recordingId: string): Promise<DraftingListing> {
      const listing = await repository.list(context, recordingId);
      if (!listing.job || listing.job.status !== 'requested') return listing;
      const job = await repository.input(context, listing.job.jobId);
      if (job.transcript.byteLength > MAX_DRAFTING_TRANSCRIPT_BYTES) { await repository.fail(context, job.jobId, 'transcript_too_large'); return repository.list(context, recordingId); }
      const read = await media.get(job.storage, job.transcript.objectKey, undefined, job.transcript.byteLength);
      if (read.bytes.length !== job.transcript.byteLength || sha256(read.bytes) !== job.transcript.contentSha256) throw new RecordingDraftingError('storage_unverified');
      const transcript = Buffer.from(read.bytes).toString('utf8');
      let raw: unknown;
      try {
        raw = await provider.draft({ model: job.provider.model, promptSha256: job.provider.promptSha256, noteType: job.noteType, sections: DRAFTING_SECTIONS[job.noteType],
          transcript, jobId: job.jobId }, AbortSignal.timeout(input.providerTimeoutMs ?? 25000));
      } catch { await repository.fail(context, job.jobId, 'provider_unavailable'); return repository.list(context, recordingId); }
      let document: ProposedNoteDocument;
      try { document = proposedNoteFromProvider(raw, job, job.transcript.contentSha256); }
      catch { await repository.fail(context, job.jobId, 'provider_output_invalid'); return repository.list(context, recordingId); }
      const bytes = Buffer.from(JSON.stringify(document), 'utf8');
      const version = (listing.versions.at(-1)?.version ?? 0) + 1;
      const key = `${draftingPrefix(job)}/proposed-v${version}.json`;
      // Authority is re-checked inside completion; the object is create-only and registered with its exact version.
      const written = await media.put(job.storage, key, bytes, 'application/json', { recordingId: job.recordingId, jobId: job.jobId, kind: 'proposed_note' });
      if (!written.version) throw new RecordingDraftingError('storage_unverified');
      const completion = await repository.complete(context, job.jobId, key, sha256(bytes), bytes.length, document.sections.length, job.provider.model);
      if (completion.status === 'completed' && completion.proposedNoteId)
        await repository.registerArtifact(context, job.jobId, key, written.version, sha256(bytes), bytes.length, completion.proposedNoteId);
      return repository.list(context, recordingId);
    },
    async read(context: ProductionClinicalRequestContext, proposedNoteId: string): Promise<ProposedNoteContent> {
      const object = await repository.object(context, proposedNoteId);
      const { bytes } = await media.get(object.storage, object.objectKey, undefined, object.byteLength);
      if (bytes.length !== object.byteLength || sha256(bytes) !== object.contentSha256) throw new RecordingDraftingError('storage_unverified');
      let document: unknown;
      try { document = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new RecordingDraftingError('storage_unverified'); }
      const parsed = proposedNoteDocumentSchema.safeParse(document);
      if (!parsed.success || parsed.data.transcriptId !== object.transcriptId || parsed.data.noteType !== object.noteType) throw new RecordingDraftingError('storage_unverified');
      return proposedNoteContentSchema.parse({ proposedNoteId: object.proposedNoteId, recordingId: object.recordingId, version: object.version,
        contentSha256: object.contentSha256, document: parsed.data });
    },
    list: (context: ProductionClinicalRequestContext, recordingId: string) => repository.list(context, recordingId),
  };
}
