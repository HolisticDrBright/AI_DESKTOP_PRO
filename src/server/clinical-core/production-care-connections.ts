if (typeof window !== 'undefined') throw new Error('production-care-connections is server-only');
import { createHash } from 'node:crypto';
import { careConnectionRequest, parseCareConnectionResponse } from '../../contracts/careConnections';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from './database';
export class CareConnectionError extends Error {
  constructor(readonly category: 'request_invalid' | 'identity_refused' | 'consent_required' | 'conflict' | 'account_deletion_write_blocked' | 'service_unavailable') { super(category); }
}
/** Unreleased port. Claims come from the independently verified gateway identity,
 * never the action body. No model, provider or device-store fallback is involved. */
export function createProductionCareConnections(database: ClinicalCoreDatabase) {
  return async (context: ProductionClinicalRequestContext, body: unknown) => {
    const parsed = careConnectionRequest.safeParse(body);
    if (!parsed.success) throw new CareConnectionError('request_invalid');
    const request = parsed.data, pool = request.action === 'issue' ? 'workforce' : 'consumer';
    const purpose = request.action === 'issue' ? 'clinical_data' : request.action === 'claim' ? 'identity_link' : 'consent_management';
    if (context.environment !== 'production-clinical' || context.dataClassification !== 'clinical_phi'
      || context.productionBound !== true || context.containsPhi !== true || context.realPatientData !== true
      || context.identityPool !== pool || context.purpose !== purpose) throw new CareConnectionError('identity_refused');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [clinicalUuid(context.actorPersonId),
          clinicalUuid(context.organizationId), context.identityPool, context.identitySubject, context.purpose, context.environment, context.dataClassification]);
        const result = await tx.query<{ data: unknown }>('select clinical_core.production_care_connection_request($1::jsonb) as data', [JSON.stringify(request)]);
        const raw = result.rows[0]?.data;
        const response = parseCareConnectionResponse(request, typeof raw === 'string' ? JSON.parse(raw) : raw);
        if ('artifact' in response && response.artifact && createHash('sha256').update(response.artifact.content, 'utf8').digest('hex') !== response.artifact.contentSha256)
          throw new Error('care_connection_response_invalid');
        return response;
      });
    } catch (error) {
      if (error instanceof ClinicalCoreDatabaseRejection) {
        const category = error.category;
        throw new CareConnectionError(['request_invalid', 'conflict', 'consent_required', 'account_deletion_write_blocked'].includes(category)
          ? category as 'request_invalid' | 'conflict' | 'consent_required' | 'account_deletion_write_blocked' : 'identity_refused');
      }
      throw new CareConnectionError('service_unavailable');
    }
  };
}
