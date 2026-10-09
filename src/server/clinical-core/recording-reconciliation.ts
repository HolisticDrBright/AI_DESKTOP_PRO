if (typeof window !== 'undefined') throw new Error('recording-reconciliation is server-only');
import { z } from 'zod';
import { createRecordingStorageBudget } from './recording-storage-budget';
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { recordingSegmentReservationSchema, RecordingUploadError, validateRecordingStoredObject, validateReceipt,
  type RecordingSegmentReservation, type RecordingObjectStore } from './recording-segments';
import { recordingSegmentReceiptSchema, recordingStateRequestSchema, type RecordingReconciliationReceipt,
  type RecordingSegmentReceipt } from '@/contracts/encounterRecordingCapture';

export interface RecordingReconciliationRepository {
  prepare(context: ProductionClinicalRequestContext, recordingId: string): Promise<RecordingSegmentReservation | null>;
  complete(context: ProductionClinicalRequestContext, recordingId: string, segmentId: string, version: string): Promise<RecordingSegmentReceipt>;
}
export function createRecordingReconciliationRepository(database: ClinicalCoreDatabase): RecordingReconciliationRepository {
  async function query<T>(c: ProductionClinicalRequestContext, sql: string, args: unknown[], schema: z.ZodType<T>) {
    if (c.identityPool !== 'workforce' || c.purpose !== 'clinical_data' || c.environment !== 'production-clinical'
      || c.dataClassification !== 'clinical_phi' || c.productionBound !== true || c.containsPhi !== true || c.realPatientData !== true)
      throw new RecordingUploadError('access_refused');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
          [clinicalUuid(c.actorPersonId), clinicalUuid(c.organizationId), c.identityPool, c.identitySubject, c.purpose, c.environment, c.dataClassification]);
        const result = await tx.query<{ data: unknown }>(sql, args);
        if (result.rows.length !== 1 || !('data' in result.rows[0])) throw new RecordingUploadError('service_unavailable');
        const raw = result.rows[0].data;
        return schema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
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
    prepare(c, recordingId) {
      if (!recordingStateRequestSchema.safeParse({ recordingId }).success) throw new RecordingUploadError('request_invalid');
      return query(c, 'select clinical_private.prepare_recording_reconciliation($1) as data',
        [clinicalUuid(recordingId)], recordingSegmentReservationSchema.nullable());
    },
    complete(c, recordingId, segmentId, version) {
      if (!z.string().uuid().safeParse(recordingId).success || !z.string().uuid().safeParse(segmentId).success
        || !/^[A-Za-z0-9+/=._-]{1,1024}$/.test(version) || version === 'null') throw new RecordingUploadError('request_invalid');
      return query(c, 'select clinical_private.complete_recording_reconciliation($1,$2,$3) as data',
        [clinicalUuid(recordingId), clinicalUuid(segmentId), version], recordingSegmentReceiptSchema);
    },
  };
}

/** Metadata verification only. No PUT, GET body, LIST or DELETE capability.
 * A missing/unreadable/mismatched object remains unresolved, never erased.
 * SQL authority is checked both before and after the bounded S3 operation. */
export function createRecordingReconciler(repository: RecordingReconciliationRepository, storage: Pick<RecordingObjectStore, 'head'>,
  now: () => number = Date.now) {
  return async (context: ProductionClinicalRequestContext, input: unknown): Promise<RecordingReconciliationReceipt> => {
    const parsed = recordingStateRequestSchema.safeParse(input);
    if (!parsed.success) throw new RecordingUploadError('request_invalid');
    const { recordingId } = parsed.data;
    try {
      const raw = await repository.prepare(context, recordingId);
      if (raw === null) return { recordingId, outcome: 'no_pending_segment' };
      const r = recordingSegmentReservationSchema.parse(raw);
      const key = `encounter-recordings/${context.organizationId}/${recordingId}/${r.sessionId}/${r.sequence}-${r.sha256}`;
      if (r.recordingId !== recordingId || r.status !== 'reserved' || r.objectVersion !== null
        || r.objectKey !== key || r.bytes > r.storage.maxSegmentBytes) throw new RecordingUploadError('storage_unverified');
      const budget = createRecordingStorageBudget(r.acceptBefore, 10000, now);
      const head = await budget.run(signal => storage.head(r, undefined, signal));
      validateRecordingStoredObject(head, r);
      budget.check();
      const segment = validateReceipt(await repository.complete(context, recordingId, r.segmentId, head.version!), r);
      return { recordingId, outcome: 'stored', segment };
    } catch (error) {
      if (error instanceof RecordingUploadError) throw error;
      throw new RecordingUploadError('service_unavailable');
    }
  };
}
