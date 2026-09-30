import {
  externalCalendarRequest,
  parseExternalCalendarResponse,
  type ExternalCalendarRequest,
  type ExternalCalendarResponse,
} from '../../contracts/externalCalendar';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';
/**
 * External calendar connection adapter. Ownership, the scope allowlist, the
 * authorization window and the erasure on disconnect all live in SQL; this carries
 * the request across, refuses a reply not bound to what was asked, and never logs.
 */
export class ExternalCalendarError extends Error {
  constructor(readonly category: 'request_invalid' | 'identity_refused' | 'conflict' | 'service_unavailable') { super(category); }
}
export function createExternalCalendarConnections(database: ClinicalCoreDatabase) {
  return async (context: ClinicalRequestContext, body: unknown): Promise<ExternalCalendarResponse> => {
    // Not a production activation path. No provider is configured either, so this
    // is reachable only against the synthetic target.
    if (context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') {
      throw new ExternalCalendarError('identity_refused');
    }
    // A calendar connection belongs to a practitioner. There is no consumer action here.
    if (context.identityPool !== 'workforce') throw new ExternalCalendarError('identity_refused');
    const parsed = externalCalendarRequest.safeParse(body);
    if (!parsed.success) throw new ExternalCalendarError('request_invalid');
    const request: ExternalCalendarRequest = parsed.data;
    try {
      return await database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          { kind: 'uuid', value: context.actorPersonId }, { kind: 'uuid', value: context.organizationId },
          context.identityPool, context.identitySubject, context.purpose, context.environment, context.dataClassification,
        ]);
        // Busy time has its own function so its argument shape is checked where it is
        // used, rather than widening the connection function's vocabulary.
        const routine = request.action === 'busy_sync'
          ? 'clinical_core.external_calendar_busy_sync'
          : 'clinical_core.external_calendar_request';
        const result = await tx.query<{ data: unknown }>(`select ${routine}($1::jsonb) as data`, [JSON.stringify(request)]);
        const raw = result.rows[0]?.data;
        return parseExternalCalendarResponse(request, typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) {
      if (error instanceof ClinicalCoreDatabaseRejection) {
        throw new ExternalCalendarError(error.category === 'conflict' ? 'conflict'
          : error.category === 'request_invalid' ? 'request_invalid' : 'identity_refused');
      }
      throw new ExternalCalendarError('service_unavailable');
    }
  };
}
