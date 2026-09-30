import {
  consultRetentionRequest, parseConsultRetentionResponse, type ConsultRetentionResponse,
} from '../../contracts/consultRetention';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';

/**
 * The practice's consult retention policy, and erasing an enquirer's contact details.
 *
 * Nothing here decides anything. Whether a request may be purged, whether a window has passed
 * and whether a purge leaves the row intact are all settled in SQL, in the same transaction as
 * the write. A refusal comes back as data rather than as an exception, so a screen shows the
 * reason instead of retrying a decision.
 */
export type ConsultRetentionCategory = 'request_invalid' | 'identity_refused'
  | 'operation_refused' | 'service_unavailable';
export class ConsultRetentionError extends Error {
  constructor(readonly category: ConsultRetentionCategory) { super(category); this.name = 'ConsultRetentionError'; }
}
const rejection = (error: unknown): ConsultRetentionCategory => {
  if (!(error instanceof ClinicalCoreDatabaseRejection)) return 'service_unavailable';
  switch (error.category) {
    case 'request_invalid': return 'request_invalid';
    case 'operation_refused': return 'operation_refused';
    default: return 'identity_refused';
  }
};

export const createConsultRetention = (database: ClinicalCoreDatabase) =>
  async (context: ClinicalRequestContext, body: unknown): Promise<ConsultRetentionResponse> => {
    if (context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') {
      throw new ConsultRetentionError('identity_refused');
    }
    // No consumer path exists: an enquirer has no account, and an unauthenticated erase-by-
    // contact endpoint would let anyone ask which addresses had written to a clinic.
    if (context.identityPool !== 'workforce') throw new ConsultRetentionError('identity_refused');
    const parsed = consultRetentionRequest.safeParse(body);
    if (!parsed.success) throw new ConsultRetentionError('request_invalid');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          { kind: 'uuid', value: context.actorPersonId }, { kind: 'uuid', value: context.organizationId },
          context.identityPool, context.identitySubject, context.purpose, context.environment,
          context.dataClassification,
        ]);
        const result = await tx.query<{ data: unknown }>(
          'select clinical_core.consult_contact_retention($1::jsonb) as data', [JSON.stringify(parsed.data)]);
        const raw = result.rows[0]?.data;
        return parseConsultRetentionResponse(parsed.data, typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) { throw new ConsultRetentionError(rejection(error)); }
  };
