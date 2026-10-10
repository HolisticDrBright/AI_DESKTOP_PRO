if (typeof window !== 'undefined') throw new Error('production-clinic-records is server-only');
import {
  clinicRecordConsumerRequest, clinicRecordWorkforceRequest, parseClinicRecordConsumerResponse, parseClinicRecordWorkforceResponse,
  type ClinicRecordConsumerRequest, type ClinicRecordConsumerResponse, type ClinicRecordWorkforceRequest, type ClinicRecordWorkforceResponse,
} from '../../contracts/clinicRecordRequests';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from './database';

export class ClinicRecordError extends Error {
  constructor(readonly category: 'request_invalid' | 'identity_refused' | 'connection_required' | 'subject_not_disclosed'
    | 'disclosure_release_required' | 'conflict' | 'not_found' | 'account_deletion_write_blocked' | 'service_unavailable') { super(category); }
}
/**
 * Unreleased port of clinic-record privacy requests. Identity comes from the
 * independently verified gateway claims, never the action body; the database
 * resolves the patient, the connection and the authority. Consumer actions run
 * under `consent_management`; workforce actions under `clinical_data`. A lost
 * mutation response is settled by replaying the same request id or decision id.
 */
function run<R>(database: ClinicalCoreDatabase, context: ProductionClinicalRequestContext, pool: 'consumer' | 'workforce',
  request: ClinicRecordConsumerRequest | ClinicRecordWorkforceRequest, parse: (raw: unknown) => R): Promise<R> {
  const purpose = pool === 'consumer' ? 'consent_management' : 'clinical_data';
  if (context.environment !== 'production-clinical' || context.dataClassification !== 'clinical_phi'
    || context.productionBound !== true || context.containsPhi !== true || context.realPatientData !== true
    || context.identityPool !== pool || context.purpose !== purpose) throw new ClinicRecordError('identity_refused');
  return database.transaction(async (tx) => {
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [clinicalUuid(context.actorPersonId),
      clinicalUuid(context.organizationId), context.identityPool, context.identitySubject, context.purpose, context.environment, context.dataClassification]);
    const result = await tx.query<{ data: unknown }>('select clinical_core.clinic_record_request($1::jsonb) as data', [JSON.stringify(request)]);
    const raw = result.rows[0]?.data;
    return parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
  }).catch((error: unknown) => {
    if (error instanceof ClinicRecordError) throw error;
    if (error instanceof ClinicalCoreDatabaseRejection) throw new ClinicRecordError(categoryOf(error));
    // The cause stays on the error for diagnostics; the category is all a caller is told.
    throw Object.assign(new ClinicRecordError('service_unavailable'), { cause: error });
  });
}
function categoryOf(error: ClinicalCoreDatabaseRejection): ClinicRecordError['category'] {
  switch (error.category) {
    case 'request_invalid': return 'request_invalid';
    case 'conflict': return 'conflict';
    case 'consent_required': return 'connection_required';
    case 'account_deletion_write_blocked': return 'account_deletion_write_blocked';
    case 'operation_refused': return 'not_found';
    case 'release_required': return 'disclosure_release_required';
    default: return 'identity_refused';
  }
}
export function createProductionClinicRecordsConsumer(database: ClinicalCoreDatabase) {
  return async (context: ProductionClinicalRequestContext, body: unknown): Promise<ClinicRecordConsumerResponse> => {
    const parsed = clinicRecordConsumerRequest.safeParse(body);
    if (!parsed.success) throw new ClinicRecordError('request_invalid');
    return run(database, context, 'consumer', parsed.data, (raw) => parseClinicRecordConsumerResponse(parsed.data, raw));
  };
}
export function createProductionClinicRecordsWorkforce(database: ClinicalCoreDatabase) {
  return async (context: ProductionClinicalRequestContext, body: unknown): Promise<ClinicRecordWorkforceResponse> => {
    const parsed = clinicRecordWorkforceRequest.safeParse(body);
    if (!parsed.success) throw new ClinicRecordError('request_invalid');
    return run(database, context, 'workforce', parsed.data, (raw) => parseClinicRecordWorkforceResponse(parsed.data, raw));
  };
}
