if (typeof window !== 'undefined') throw new Error('production-care-messaging is server-only');
import { careMessageRequest, parseCareMessageResponse, type CareMessageResponse } from '../../contracts/careMessages';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from './database';
import { careMessageExportRequest, parseCareMessageExportResponse } from '../../contracts/careMessageExport';

export class ProductionCareMessageError extends Error {
  constructor(readonly category: 'request_invalid' | 'identity_refused' | 'consent_required' | 'conflict' | 'account_deletion_write_blocked' | 'service_unavailable') { super(category); }
}
/** Retained clinic correspondence is not erased by a consumer feature request.
 * Privacy copies remain accessible after sharing withdrawal, with no caller-
 * selected owner and no practitioner draft, hash or audit-payload export. */
export function createProductionCareMessageExport(database: ClinicalCoreDatabase) {
  return async (context: ProductionClinicalRequestContext, body: unknown) => {
    if (context.environment !== 'production-clinical' || context.dataClassification !== 'clinical_phi'
      || context.productionBound !== true || context.containsPhi !== true || context.realPatientData !== true
      || context.purpose !== 'consent_management' || context.identityPool !== 'consumer') throw new ProductionCareMessageError('identity_refused');
    const parsed = careMessageExportRequest.safeParse(body);
    if (!parsed.success) throw new ProductionCareMessageError('request_invalid');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool, context.identitySubject,
          context.purpose, context.environment, context.dataClassification,
        ]);
        const result = await tx.query<{ data: unknown }>('select clinical_core.production_care_message_export($1::jsonb) as data', [JSON.stringify(parsed.data)]);
        const raw = result.rows[0]?.data;
        return parseCareMessageExportResponse(parsed.data, typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) {
      if (error instanceof ClinicalCoreDatabaseRejection) throw new ProductionCareMessageError(error.category === 'request_invalid' ? 'request_invalid' : 'identity_refused');
      throw new ProductionCareMessageError('service_unavailable');
    }
  };
}
export function createProductionCareMessaging(database: ClinicalCoreDatabase) {
  return async (context: ProductionClinicalRequestContext, body: unknown): Promise<CareMessageResponse> => {
    if (context.environment !== 'production-clinical' || context.dataClassification !== 'clinical_phi'
      || context.productionBound !== true || context.containsPhi !== true || context.realPatientData !== true
      || context.purpose !== 'clinical_data' || !['consumer', 'workforce'].includes(context.identityPool)) {
      throw new ProductionCareMessageError('identity_refused');
    }
    const parsed = careMessageRequest.safeParse(body);
    if (!parsed.success) throw new ProductionCareMessageError('request_invalid');
    const request = parsed.data;
    if ((request.action === 'receipt' || request.action === 'settle') && context.identityPool !== 'consumer') {
      throw new ProductionCareMessageError('identity_refused');
    }
    if (request.action === 'send' && (request.threadId ? request.subject !== undefined : !request.subject)) {
      throw new ProductionCareMessageError('request_invalid');
    }
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool, context.identitySubject,
          context.purpose, context.environment, context.dataClassification,
        ]);
        const operation = request.action === 'receipt' || request.action === 'settle' ? 'resolve' : 'request';
        const result = await tx.query<{ data: unknown }>(`select clinical_core.production_care_message_${operation}($1::jsonb) as data`, [JSON.stringify(request)]);
        const raw = result.rows[0]?.data;
        return parseCareMessageResponse(request, typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) {
      if (error instanceof ClinicalCoreDatabaseRejection) {
        const category = error.category;
        throw new ProductionCareMessageError(category === 'request_invalid' || category === 'conflict' || category === 'consent_required'
          || category === 'account_deletion_write_blocked' ? category : 'identity_refused');
      }
      throw new ProductionCareMessageError('service_unavailable');
    }
  };
}
