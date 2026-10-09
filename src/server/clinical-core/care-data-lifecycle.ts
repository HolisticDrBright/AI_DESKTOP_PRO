import {
  careDataRequest, parseCareDataResponse,
  type CareDataRequest, type CareDataResponse,
} from '../../contracts/careDataLifecycle';
import {ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase} from './database';
import type {ClinicalRequestContext} from './aws-identity-consent';
/**
 * Owner export and erasure for the messaging and program domains.
 *
 * Consumer only, and the owner is the request context rather than anything in the body.
 * The three SQL functions are separate so each one's argument shape is checked where it is
 * used; this carries the request to the right one and refuses a reply not bound to it.
 */
export class CareDataError extends Error {
  constructor(readonly category: 'request_invalid' | 'identity_refused' | 'conflict' | 'service_unavailable') { super(category); }
}
const FUNCTIONS: Record<CareDataRequest['action'], string> = {
  export: 'clinical_core.care_data_export',
  erase: 'clinical_core.care_data_erase',
  erase_request: 'clinical_core.care_data_erasure_request',
  erase_receipt: 'clinical_core.care_data_erasure_request',
  settle_erasure: 'clinical_core.care_data_erasure_request',
  erasure_history: 'clinical_core.care_data_erasure_history',
};
export function createCareDataLifecycle(database: ClinicalCoreDatabase) {
  return async (context: ClinicalRequestContext, body: unknown): Promise<CareDataResponse> => {
    // Synthetic-only, like the domains it covers. A production lifecycle needs the
    // production-shaped tables to exist first, and they do not.
    if (context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') {
      throw new CareDataError('identity_refused');
    }
    if (context.identityPool !== 'consumer') throw new CareDataError('identity_refused');
    const parsed = careDataRequest.safeParse(body);
    if (!parsed.success) throw new CareDataError('request_invalid');
    const request: CareDataRequest = parsed.data;
    // Old clients cannot create an uncorrelated destructive request. Historical
    // receipts remain readable; only the ID-bound action is admitted now.
    if (request.action === 'erase') throw new CareDataError('request_invalid');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          {kind: 'uuid', value: context.actorPersonId}, {kind: 'uuid', value: context.organizationId},
          context.identityPool, context.identitySubject, 'consent_management',
          context.environment, context.dataClassification,
        ]);
        const result = await tx.query<{data: unknown}>(`select ${FUNCTIONS[request.action]}($1::jsonb) as data`, [JSON.stringify(request)]);
        const raw = result.rows[0]?.data;
        return parseCareDataResponse(request, typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) {
      if (error instanceof ClinicalCoreDatabaseRejection) {
        throw new CareDataError(error.category === 'conflict' ? 'conflict'
          : error.category === 'request_invalid' ? 'request_invalid' : 'identity_refused');
      }
      throw new CareDataError('service_unavailable');
    }
  };
}
