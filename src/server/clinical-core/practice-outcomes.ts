import {
  outcomeLedgerRequest, outcomeReportRequest,
  parseOutcomeLedgerResponse, parseOutcomeReportResponse,
  type OutcomeLedgerResponse, type OutcomeReportResponse,
} from '../../contracts/practiceOutcomes';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';

/**
 * The practice outcome ledger.
 *
 * Nothing here aggregates, bands or suppresses anything. The age band, the small-cell threshold
 * and the complementary suppression are all in SQL, and the API role cannot read the rows at all,
 * so this layer could not re-implement them even if it wanted to. That is the point: a second
 * implementation of suppression is a second chance to get it wrong.
 */
export type PracticeOutcomeCategory = 'request_invalid' | 'identity_refused'
  | 'consent_required' | 'operation_refused' | 'service_unavailable';
export class PracticeOutcomeError extends Error {
  constructor(readonly category: PracticeOutcomeCategory) { super(category); this.name = 'PracticeOutcomeError'; }
}
const rejection = (error: unknown): PracticeOutcomeCategory => {
  if (!(error instanceof ClinicalCoreDatabaseRejection)) return 'service_unavailable';
  switch (error.category) {
    case 'request_invalid': return 'request_invalid';
    case 'consent_required': return 'consent_required';
    case 'operation_refused': return 'operation_refused';
    default: return 'identity_refused';
  }
};

function outcomeCall<Request, Response>(input: {
  database: ClinicalCoreDatabase; routine: string;
  parse: (body: unknown) => { success: true; data: Request } | { success: false };
  bind: (request: Request, raw: unknown) => Response;
}) {
  return async (context: ClinicalRequestContext, body: unknown): Promise<Response> => {
    if (context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') {
      throw new PracticeOutcomeError('identity_refused');
    }
    // An outcome is the practitioner's judgement of what happened. A patient session writing
    // directly into the counted ledger would make the counts mean two things at once.
    if (context.identityPool !== 'workforce') throw new PracticeOutcomeError('identity_refused');
    const parsed = input.parse(body);
    if (!parsed.success) throw new PracticeOutcomeError('request_invalid');
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
    } catch (error) { throw new PracticeOutcomeError(rejection(error)); }
  };
}

export const createOutcomeLedgerWorkforce = (database: ClinicalCoreDatabase) =>
  outcomeCall<Parameters<typeof parseOutcomeLedgerResponse>[0], OutcomeLedgerResponse>({
    database, routine: 'clinical_core.outcome_ledger_workforce',
    parse: body => outcomeLedgerRequest.safeParse(body), bind: parseOutcomeLedgerResponse,
  });
export const createOutcomeReport = (database: ClinicalCoreDatabase) =>
  outcomeCall<Parameters<typeof parseOutcomeReportResponse>[0], OutcomeReportResponse>({
    database, routine: 'clinical_core.outcome_report',
    parse: body => outcomeReportRequest.safeParse(body), bind: parseOutcomeReportResponse,
  });
