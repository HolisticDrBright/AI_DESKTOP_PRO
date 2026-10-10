if (typeof window !== 'undefined') throw Error('production-telehealth-consent is server-only');
import { createHash } from 'node:crypto';
import { telehealthConsentRequest, parseTelehealthConsentResponse } from '../../contracts/telehealthConsent';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { CareConnectionError } from './production-care-connections';

/** Exact-copy, consumer-only port. Database must be separately artifact-bound. */
export function createProductionTelehealthConsent(database: ClinicalCoreDatabase) {
  return async (context: ProductionClinicalRequestContext, body: unknown) => {
    const parsed = telehealthConsentRequest.safeParse(body);
    if (!parsed.success) throw new CareConnectionError('request_invalid');
    if (context.environment !== 'production-clinical' || context.dataClassification !== 'clinical_phi'
      || context.productionBound !== true || context.containsPhi !== true || context.realPatientData !== true
      || context.identityPool !== 'consumer' || context.purpose !== 'consent_management') throw new CareConnectionError('identity_refused');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [clinicalUuid(context.actorPersonId),
          clinicalUuid(context.organizationId), context.identityPool, context.identitySubject, context.purpose,
          context.environment, context.dataClassification]);
        const result = await tx.query<{ data: unknown }>('select clinical_core.production_telehealth_consent_request($1::jsonb) as data', [JSON.stringify(parsed.data)]);
        const raw = result.rows[0]?.data;
        const response = parseTelehealthConsentResponse(parsed.data, typeof raw === 'string' ? JSON.parse(raw) : raw);
        if ('artifact' in response && response.artifact) {
          const content = response.artifact.content;
          if (!content.trim() || content.includes('\0') || Buffer.byteLength(content, 'utf8') > 16000
            || Buffer.from(content, 'utf8').toString('utf8') !== content
            || createHash('sha256').update(content, 'utf8').digest('hex') !== response.artifact.contentSha256)
            throw Error('telehealth_consent_response_invalid');
        }
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
