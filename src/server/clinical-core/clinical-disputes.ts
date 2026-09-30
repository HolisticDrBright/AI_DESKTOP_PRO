import {
  disputeConsumerRequest, disputeWorkforceRequest, revisionConsumerRequest, revisionWorkforceRequest,
  parseDisputeConsumerResponse, parseDisputeWorkforceResponse,
  parseRevisionConsumerResponse, parseRevisionWorkforceResponse,
  type DisputeConsumerResponse, type DisputeWorkforceResponse,
  type RevisionConsumerResponse, type RevisionWorkforceResponse,
} from '../../contracts/clinicalDisputes';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';

/**
 * Contesting a record, and being told a delivered one was corrected.
 *
 * Nothing here decides anything. Whether a subject may be contested, whether a resolution
 * carries an answer, and which assignments a revision affects are all settled in SQL, in the
 * same transaction as the write. A second opinion at this layer could only disagree with the
 * one that counts.
 */
export type ClinicalDisputeCategory = 'request_invalid' | 'identity_refused' | 'consent_required'
  | 'operation_refused' | 'conflict' | 'service_unavailable';
export class ClinicalDisputeError extends Error {
  constructor(readonly category: ClinicalDisputeCategory) { super(category); this.name = 'ClinicalDisputeError'; }
}
const rejection = (error: unknown): ClinicalDisputeCategory => {
  if (!(error instanceof ClinicalCoreDatabaseRejection)) return 'service_unavailable';
  switch (error.category) {
    case 'conflict': return 'conflict';
    case 'request_invalid': return 'request_invalid';
    case 'consent_required': return 'consent_required';
    case 'operation_refused': return 'operation_refused';
    default: return 'identity_refused';
  }
};

function disputeCall<Request, Response>(input: {
  database: ClinicalCoreDatabase; routine: string; pool: 'workforce' | 'consumer';
  parse: (body: unknown) => { success: true; data: Request } | { success: false };
  bind: (request: Request, raw: unknown) => Response;
}) {
  return async (context: ClinicalRequestContext, body: unknown): Promise<Response> => {
    if (context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') {
      throw new ClinicalDisputeError('identity_refused');
    }
    if (context.identityPool !== input.pool) throw new ClinicalDisputeError('identity_refused');
    const parsed = input.parse(body);
    if (!parsed.success) throw new ClinicalDisputeError('request_invalid');
    try {
      return await input.database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          { kind: 'uuid', value: context.actorPersonId }, { kind: 'uuid', value: context.organizationId },
          context.identityPool, context.identitySubject, context.purpose, context.environment,
          context.dataClassification,
        ]);
        const result = await tx.query<{ data: unknown }>(`select ${input.routine}($1::jsonb) as data`,
          [JSON.stringify(parsed.data)]);
        const raw = result.rows[0]?.data;
        return input.bind(parsed.data, typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) { throw new ClinicalDisputeError(rejection(error)); }
  };
}

export const createDisputeConsumer = (database: ClinicalCoreDatabase) =>
  disputeCall<Parameters<typeof parseDisputeConsumerResponse>[0], DisputeConsumerResponse>({
    database, routine: 'clinical_core.clinical_dispute_consumer', pool: 'consumer',
    parse: body => disputeConsumerRequest.safeParse(body), bind: parseDisputeConsumerResponse,
  });
export const createDisputeWorkforce = (database: ClinicalCoreDatabase) =>
  disputeCall<Parameters<typeof parseDisputeWorkforceResponse>[0], DisputeWorkforceResponse>({
    database, routine: 'clinical_core.clinical_dispute_workforce', pool: 'workforce',
    parse: body => disputeWorkforceRequest.safeParse(body), bind: parseDisputeWorkforceResponse,
  });
export const createRevisionWorkforce = (database: ClinicalCoreDatabase) =>
  disputeCall<Parameters<typeof parseRevisionWorkforceResponse>[0], RevisionWorkforceResponse>({
    database, routine: 'clinical_core.content_revision_workforce', pool: 'workforce',
    parse: body => revisionWorkforceRequest.safeParse(body), bind: parseRevisionWorkforceResponse,
  });
export const createRevisionConsumer = (database: ClinicalCoreDatabase) =>
  disputeCall<Parameters<typeof parseRevisionConsumerResponse>[0], RevisionConsumerResponse>({
    database, routine: 'clinical_core.content_revision_consumer', pool: 'consumer',
    parse: body => revisionConsumerRequest.safeParse(body), bind: parseRevisionConsumerResponse,
  });
