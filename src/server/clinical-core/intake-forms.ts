import {
  intakeFormAdminRequest, intakePacketConsumerRequest, intakePacketWorkforceRequest,
  parseIntakeFormAdminResponse, parseIntakePacketConsumerResponse, parseIntakePacketWorkforceResponse,
  type IntakeFormAdminResponse, type IntakePacketConsumerResponse, type IntakePacketWorkforceResponse,
} from '../../contracts/intakeForms';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';

/**
 * Pre-visit forms and signatures.
 *
 * Authoring and assignment are workforce work; answering and signing are the patient's. The
 * separation is enforced in SQL by two different functions with two different pool
 * requirements, and mirrored here so a route cannot accidentally offer a patient the
 * clinic's vocabulary or the reverse.
 *
 * Nothing here validates form content or answers. That belongs in the database, where the
 * published version being answered is the same row the answer is written against; a check
 * made here would be a second opinion that could disagree.
 */
export type IntakeErrorCategory = 'request_invalid' | 'identity_refused' | 'consent_required' | 'operation_refused' | 'conflict' | 'service_unavailable';
export class IntakeFormError extends Error {
  constructor(readonly category: IntakeErrorCategory) { super(category); this.name = 'IntakeFormError'; }
}
const rejection = (error: unknown): IntakeErrorCategory => {
  if (!(error instanceof ClinicalCoreDatabaseRejection)) return 'service_unavailable';
  switch (error.category) {
    case 'conflict': return 'conflict';
    case 'request_invalid': return 'request_invalid';
    case 'consent_required': return 'consent_required';
    case 'operation_refused': return 'operation_refused';
    default: return 'identity_refused';
  }
};

function intakeCall<Request, Response>(input: {
  database: ClinicalCoreDatabase; routine: string; pool: 'workforce' | 'consumer';
  parse: (body: unknown) => { success: true; data: Request } | { success: false };
  bind: (request: Request, raw: unknown) => Response;
}) {
  return async (context: ClinicalRequestContext, body: unknown): Promise<Response> => {
    if (context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') {
      throw new IntakeFormError('identity_refused');
    }
    if (context.identityPool !== input.pool) throw new IntakeFormError('identity_refused');
    const parsed = input.parse(body);
    if (!parsed.success) throw new IntakeFormError('request_invalid');
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
    } catch (error) { throw new IntakeFormError(rejection(error)); }
  };
}

export const createIntakeFormAdmin = (database: ClinicalCoreDatabase) =>
  intakeCall<Parameters<typeof parseIntakeFormAdminResponse>[0], IntakeFormAdminResponse>({
    database, routine: 'clinical_core.intake_form_admin', pool: 'workforce',
    parse: body => intakeFormAdminRequest.safeParse(body), bind: parseIntakeFormAdminResponse,
  });

export const createIntakePacketWorkforce = (database: ClinicalCoreDatabase) =>
  intakeCall<Parameters<typeof parseIntakePacketWorkforceResponse>[0], IntakePacketWorkforceResponse>({
    database, routine: 'clinical_core.intake_packet_workforce', pool: 'workforce',
    parse: body => intakePacketWorkforceRequest.safeParse(body), bind: parseIntakePacketWorkforceResponse,
  });

export const createIntakePacketConsumer = (database: ClinicalCoreDatabase) =>
  intakeCall<Parameters<typeof parseIntakePacketConsumerResponse>[0], IntakePacketConsumerResponse>({
    database, routine: 'clinical_core.intake_packet_consumer', pool: 'consumer',
    parse: body => intakePacketConsumerRequest.safeParse(body), bind: parseIntakePacketConsumerResponse,
  });
