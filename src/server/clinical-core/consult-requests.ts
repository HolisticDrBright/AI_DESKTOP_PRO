import {
  consultIntakeRequest, consultLinkAdminRequest, consultReviewRequest,
  parseConsultIntakeResponse, parseConsultLinkAdminResponse, parseConsultReviewResponse,
  type ConsultIntakeResponse, type ConsultLinkAdminResponse, type ConsultReviewResponse,
} from '../../contracts/consultRequests';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';

/**
 * The public consult link and the clinic's queue.
 *
 * The public adapter is the only one in this family that runs without a request context,
 * because a visitor has no identity to establish one from. Its authority is the slug, and
 * the database function it calls is confined to describing a link and adding one request.
 * That confinement is the whole security argument, so this adapter deliberately does no
 * more than carry the call: it cannot widen what the function will do, and it must not
 * appear to.
 */
export type ConsultErrorCategory = 'request_invalid' | 'identity_refused' | 'consent_required' | 'operation_refused' | 'conflict' | 'service_unavailable';
export class ConsultRequestError extends Error {
  constructor(readonly category: ConsultErrorCategory) { super(category); this.name = 'ConsultRequestError'; }
}
const rejection = (error: unknown): ConsultErrorCategory => {
  if (!(error instanceof ClinicalCoreDatabaseRejection)) return 'service_unavailable';
  switch (error.category) {
    case 'conflict': return 'conflict';
    case 'request_invalid': return 'request_invalid';
    case 'consent_required': return 'consent_required';
    case 'operation_refused': return 'operation_refused';
    default: return 'identity_refused';
  }
};

export function createPublicConsultIntake(database: ClinicalCoreDatabase) {
  return async (body: unknown): Promise<ConsultIntakeResponse> => {
    const parsed = consultIntakeRequest.safeParse(body);
    if (!parsed.success) throw new ConsultRequestError('request_invalid');
    try {
      return await database.transaction(async tx => {
        const result = await tx.query<{ data: unknown }>(
          'select clinical_core.consult_intake_public($1::jsonb) as data', [JSON.stringify(parsed.data)]);
        const raw = result.rows[0]?.data;
        return parseConsultIntakeResponse(parsed.data, typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) { throw new ConsultRequestError(rejection(error)); }
  };
}

/** Shared by the two workforce adapters: the same context assertion, made once. */
function workforceCall<Request, Response>(
  database: ClinicalCoreDatabase, routine: string,
  parse: (body: unknown) => { success: true; data: Request } | { success: false },
  bind: (request: Request, raw: unknown) => Response,
) {
  return async (context: ClinicalRequestContext, body: unknown): Promise<Response> => {
    // Not a production activation path.
    if (context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') {
      throw new ConsultRequestError('identity_refused');
    }
    if (context.identityPool !== 'workforce') throw new ConsultRequestError('identity_refused');
    const parsed = parse(body);
    if (!parsed.success) throw new ConsultRequestError('request_invalid');
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          { kind: 'uuid', value: context.actorPersonId }, { kind: 'uuid', value: context.organizationId },
          context.identityPool, context.identitySubject, context.purpose, context.environment,
          context.dataClassification,
        ]);
        const result = await tx.query<{ data: unknown }>(`select ${routine}($1::jsonb) as data`,
          [JSON.stringify(parsed.data)]);
        const raw = result.rows[0]?.data;
        return bind(parsed.data, typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) { throw new ConsultRequestError(rejection(error)); }
  };
}

export const createConsultLinkAdmin = (database: ClinicalCoreDatabase) =>
  workforceCall<Parameters<typeof parseConsultLinkAdminResponse>[0], ConsultLinkAdminResponse>(
    database, 'clinical_core.consult_link_admin',
    body => consultLinkAdminRequest.safeParse(body), parseConsultLinkAdminResponse);

export const createConsultRequestReview = (database: ClinicalCoreDatabase) =>
  workforceCall<Parameters<typeof parseConsultReviewResponse>[0], ConsultReviewResponse>(
    database, 'clinical_core.consult_request_review',
    body => consultReviewRequest.safeParse(body), parseConsultReviewResponse);
