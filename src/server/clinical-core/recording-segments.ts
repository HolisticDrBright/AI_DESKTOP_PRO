if (typeof window !== 'undefined') throw new Error('recording-segments is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createRecordingStorageBudget } from './recording-storage-budget';
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { recordingSegmentInputSchema, recordingSegmentReceiptSchema,
  type RecordingSegmentInput, type RecordingSegmentReceipt } from '@/contracts/encounterRecordingCapture';
export { recordingSegmentInputSchema, recordingSegmentReceiptSchema } from '@/contracts/encounterRecordingCapture';
export type { RecordingSegmentInput, RecordingSegmentReceipt } from '@/contracts/encounterRecordingCapture';

const uuid = z.string().uuid();
const version = z.string().min(1).max(1024).regex(/^[A-Za-z0-9+/=._-]+$/).refine(v => v !== 'null');
export const recordingStorageSchema = z.object({ bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  expectedBucketOwner: z.string().regex(/^\d{12}$/), region: z.string().regex(/^us-(east|west)-[12]$/),
  kmsKeyArn: z.string(), maxSegmentBytes: z.number().int().min(1).max(4194304) }).strict()
  .refine(s => new RegExp(`^arn:aws:kms:${s.region}:${s.expectedBucketOwner}:key/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(s.kmsKeyArn));
export const recordingSegmentReservationSchema = recordingSegmentReceiptSchema.omit({ status: true }).extend({
  sessionId: uuid, status: z.enum(['reserved', 'stored']), objectVersion: version.nullable(),
  objectKey: z.string().max(512), acceptBefore: z.string().datetime({ offset: true }),
  contentType: z.enum(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg']), storage: recordingStorageSchema,
}).strict().refine(r => (r.status === 'stored') === (r.objectVersion !== null));
export type RecordingSegmentReservation = z.infer<typeof recordingSegmentReservationSchema>;
export class RecordingUploadError extends Error {
  constructor(readonly code: 'request_invalid' | 'access_refused' | 'consent_required' | 'conflict' | 'service_unavailable' | 'storage_unverified') {
    super(code); this.name = 'RecordingUploadError';
  }
}
export interface RecordingSegmentRepository {
  reserve(context: ProductionClinicalRequestContext, input: RecordingSegmentInput): Promise<RecordingSegmentReservation>;
  complete(context: ProductionClinicalRequestContext, input: RecordingSegmentInput, segmentId: string, objectVersion: string): Promise<RecordingSegmentReceipt>;
}
export function createRecordingSegmentRepository(database: ClinicalCoreDatabase): RecordingSegmentRepository {
  async function command<T>(context: ProductionClinicalRequestContext, input: RecordingSegmentInput, sql: string,
    args: unknown[], schema: z.ZodType<T>): Promise<T> {
    if (context.identityPool !== 'workforce' || context.purpose !== 'clinical_data' || context.environment !== 'production-clinical'
      || context.dataClassification !== 'clinical_phi' || context.productionBound !== true || context.containsPhi !== true || context.realPatientData !== true)
      throw new RecordingUploadError('access_refused');
    if (!recordingSegmentInputSchema.safeParse(input).success) throw new RecordingUploadError('request_invalid');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool, context.identitySubject,
          context.purpose, context.environment, context.dataClassification,
        ]);
        const result = await tx.query<{ data: unknown }>(sql, args);
        const raw = result.rows[0]?.data;
        const parsed = schema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
        if (!parsed.success) throw new RecordingUploadError('service_unavailable');
        return parsed.data;
      });
    } catch (error) {
      if (error instanceof RecordingUploadError) throw error;
      if (error instanceof ClinicalCoreDatabaseRejection) {
        if (['consent_required', 'conflict', 'request_invalid'].includes(error.category))
          throw new RecordingUploadError(error.category as 'consent_required' | 'conflict' | 'request_invalid');
        throw new RecordingUploadError('access_refused');
      }
      throw new RecordingUploadError('service_unavailable');
    }
  }
  return {
    reserve: (c, r) => command(c, r, 'select clinical_private.reserve_recording_segment($1,$2,$3,$4::integer,$5,$6::integer) as data',
      [clinicalUuid(r.recordingId), clinicalUuid(r.sessionId), r.captureToken, r.sequence, r.sha256, r.bytes], recordingSegmentReservationSchema),
    complete: (c, r, id, v) => {
      if (!uuid.safeParse(id).success || !version.safeParse(v).success) throw new RecordingUploadError('request_invalid');
      return command(c, r, 'select clinical_private.complete_recording_segment($1,$2,$3,$4,$5,$6::integer,$7) as data',
        [clinicalUuid(r.recordingId), clinicalUuid(r.sessionId), r.captureToken, clinicalUuid(id), r.sha256, r.bytes, v], recordingSegmentReceiptSchema);
    },
  };
}

export type RecordingStoredObject = { version?: string; bytes?: number; contentType?: string; checksum?: string;
  checksumType?: string; encryption?: string; kmsKeyArn?: string; metadata?: Record<string, string>; deleteMarker?: boolean };
export interface RecordingObjectStore {
  put(reservation: RecordingSegmentReservation, bytes: Uint8Array, signal: AbortSignal): Promise<{ version?: string }>;
  head(reservation: RecordingSegmentReservation, objectVersion: string | undefined, signal: AbortSignal): Promise<RecordingStoredObject>;
}

/** Internal binary service, not a browser-callable receipt-creation API.
 * Unknown outcomes leave the durable reservation pending for retry/reconciliation.
 * Never delete on an uncertain write: reviewed retention/holds must govern cleanup.
 */
export function createRecordingSegmentUploader(repository: RecordingSegmentRepository, storage: RecordingObjectStore,
  now: () => number = Date.now) {
  return async (context: ProductionClinicalRequestContext, input: unknown, bytes: Uint8Array): Promise<RecordingSegmentReceipt> => {
    const parsed = recordingSegmentInputSchema.safeParse(input);
    if (!parsed.success || !(bytes instanceof Uint8Array) || bytes.byteLength !== parsed.data.bytes
      || createHash('sha256').update(bytes).digest('hex') !== parsed.data.sha256) throw new RecordingUploadError('request_invalid');
    const r = parsed.data;
    try {
      const reserved = recordingSegmentReservationSchema.parse(await repository.reserve(context, r));
      const key = `encounter-recordings/${context.organizationId}/${r.recordingId}/${r.sessionId}/${r.sequence}-${r.sha256}`;
      if (reserved.recordingId !== r.recordingId || reserved.sessionId !== r.sessionId || reserved.sequence !== r.sequence
        || reserved.sha256 !== r.sha256 || reserved.bytes !== r.bytes || reserved.objectKey !== key || r.bytes > reserved.storage.maxSegmentBytes
        || r.contentType !== undefined && r.contentType !== reserved.contentType)
        throw new RecordingUploadError('storage_unverified');
      if (reserved.status === 'stored') {
        // Revalidate consent in the database even for a retry of a saved receipt.
        return validateReceipt(await repository.complete(context, r, reserved.segmentId, reserved.objectVersion!), reserved);
      }
      const budget = createRecordingStorageBudget(reserved.acceptBefore, 20000, now);
      let storedVersion: string | undefined;
      try { storedVersion = (await budget.run(signal => storage.put(reserved, bytes, signal))).version; }
      catch { /* Conditional conflict or lost response: prove the existing object, never overwrite it. */ }
      const head = await budget.run(signal => storage.head(reserved, storedVersion, signal));
      validateRecordingStoredObject(head, reserved, storedVersion);
      budget.check();
      // A separate transaction rechecks live consent/epoch/token/release after upload.
      return validateReceipt(await repository.complete(context, r, reserved.segmentId, head.version!), reserved);
    } catch (error) {
      if (error instanceof RecordingUploadError) throw error;
      throw new RecordingUploadError('service_unavailable');
    }
  };
}
export function validateRecordingStoredObject(head: RecordingStoredObject, reserved: RecordingSegmentReservation, expectedVersion?: string) {
  if (!version.safeParse(head.version).success || expectedVersion !== undefined && head.version !== expectedVersion
    || head.bytes !== reserved.bytes || head.contentType !== reserved.contentType
    || head.checksum !== Buffer.from(reserved.sha256, 'hex').toString('base64') || head.checksumType !== 'FULL_OBJECT'
    || head.encryption !== 'aws:kms' || head.kmsKeyArn !== reserved.storage.kmsKeyArn || head.deleteMarker === true
    || head.metadata?.['segment-id'] !== reserved.segmentId || head.metadata?.['recording-id'] !== reserved.recordingId
    || head.metadata?.['session-id'] !== reserved.sessionId || head.metadata?.['authority-epoch'] !== String(reserved.authorityEpoch))
    throw new RecordingUploadError('storage_unverified');
}
export function validateReceipt(value: unknown, reserved: RecordingSegmentReservation): RecordingSegmentReceipt {
  const parsed = recordingSegmentReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.segmentId !== reserved.segmentId || parsed.data.recordingId !== reserved.recordingId
    || parsed.data.sequence !== reserved.sequence || parsed.data.sha256 !== reserved.sha256
    || parsed.data.bytes !== reserved.bytes || parsed.data.authorityEpoch !== reserved.authorityEpoch)
    throw new RecordingUploadError('storage_unverified');
  return parsed.data;
}
