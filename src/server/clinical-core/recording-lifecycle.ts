if (typeof window !== 'undefined') throw new Error('recording-lifecycle is server-only');
import { z } from 'zod';
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';

import { recordingStartSchema, recordingStartReceiptSchema, recordingLifecycleCommandSchema,
  recordingRecoveryStateSchema, recordingLifecycleReceiptSchema,
  type RecordingRecoveryState, type RecordingLifecycleReceipt } from '@/contracts/encounterRecordingCapture';
export { recordingContentTypeSchema, recordingStartSchema, recordingStartReceiptSchema, recordingLifecycleCommandSchema,
  recordingRecoveryStateSchema, recordingLifecycleReceiptSchema } from '@/contracts/encounterRecordingCapture';
export type { RecordingLifecycleCommand, RecordingRecoveryState, RecordingLifecycleReceipt } from '@/contracts/encounterRecordingCapture';
const uuid = z.string().uuid();
export class RecordingLifecycleError extends Error {
  constructor(readonly code: 'request_invalid' | 'access_refused' | 'consent_required' | 'conflict' | 'service_unavailable') {
    super(code); this.name = 'RecordingLifecycleError';
  }
}

/** Internal repository only. A caller must authenticate fresh workforce identity;
 * this does not turn an old capture token into login or enable a public route.
 * No provider/storage network call is made while the encounter lock is held.
 */
export function createRecordingLifecycleRepository(database: ClinicalCoreDatabase) {
  async function query<T>(context: ProductionClinicalRequestContext, sql: string, parameters: unknown[], schema: z.ZodType<T>,
    correlate: (value: T) => boolean): Promise<T> {
    if (context.identityPool !== 'workforce' || context.purpose !== 'clinical_data' || context.environment !== 'production-clinical'
      || context.dataClassification !== 'clinical_phi' || context.productionBound !== true || context.containsPhi !== true || context.realPatientData !== true)
      throw new RecordingLifecycleError('access_refused');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool, context.identitySubject,
          context.purpose, context.environment, context.dataClassification,
        ]);
        const result = await tx.query<{ data: unknown }>(sql, parameters), raw = result.rows[0]?.data;
        const parsed = schema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
        if (!parsed.success || !correlate(parsed.data)) throw new RecordingLifecycleError('service_unavailable');
        return parsed.data;
      });
    } catch (error) {
      if (error instanceof RecordingLifecycleError) throw error;
      if (error instanceof ClinicalCoreDatabaseRejection) {
        if (['consent_required', 'conflict', 'request_invalid'].includes(error.category))
          throw new RecordingLifecycleError(error.category as 'consent_required' | 'conflict' | 'request_invalid');
        throw new RecordingLifecycleError('access_refused');
      }
      throw new RecordingLifecycleError('service_unavailable');
    }
  }
  return {
    start(context: ProductionClinicalRequestContext, input: unknown, captureReleaseId: string) {
      const parsed = recordingStartSchema.safeParse(input);
      if (!parsed.success || !uuid.safeParse(captureReleaseId).success) throw new RecordingLifecycleError('request_invalid');
      const r = parsed.data;
      return query(context, 'select clinical_private.start_qualified_recording_capture($1,$2,$3,$4) as data',
        [clinicalUuid(r.encounterId), clinicalUuid(captureReleaseId), clinicalUuid(r.commandId), r.contentType],
        recordingStartReceiptSchema, receipt => receipt.encounterId === r.encounterId && receipt.commandId === r.commandId && receipt.contentType === r.contentType);
    },
    state(context: ProductionClinicalRequestContext, recordingId: string): Promise<RecordingRecoveryState> {
      if (!uuid.safeParse(recordingId).success) throw new RecordingLifecycleError('request_invalid');
      return query(context, 'select clinical_private.get_recording_recovery_state($1) as data',
        [clinicalUuid(recordingId)], recordingRecoveryStateSchema, r => r.recordingId === recordingId);
    },
    command(context: ProductionClinicalRequestContext, input: unknown): Promise<RecordingLifecycleReceipt> {
      const parsed = recordingLifecycleCommandSchema.safeParse(input);
      if (!parsed.success) throw new RecordingLifecycleError('request_invalid');
      const r = parsed.data;
      return query(context, 'select clinical_private.command_recording_lifecycle($1,$2,$3,$4::bigint,$5) as data',
        [clinicalUuid(r.recordingId), clinicalUuid(r.commandId), r.action, r.expectedVersion, r.inventorySha256],
        recordingLifecycleReceiptSchema, receipt => receipt.recordingId === r.recordingId && receipt.commandId === r.commandId
          && receipt.action === r.action && receipt.credentialVersion === r.expectedVersion + 1
          && receipt.inventorySha256 === r.inventorySha256);
    },
  };
}
