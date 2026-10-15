if (typeof window !== 'undefined') throw new Error('current-membership-program-assignments is server-only');
import { programAssignmentRequest, parseProgramAssignmentResponse, PROGRAM_REFUSAL_REASONS, type ProgramAssignmentResponse, type ProgramRefusalReason } from '../../contracts/programAssignments';
import type { CurrentWorkforcePrincipal } from './aws-identity-consent';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import { bindCurrentWorkforceContext, CurrentMembershipRefusal, currentMembershipSetterBound } from './current-membership-workforce';
import { activationState, boundaryActivationState, ProductionProgramAssignmentError } from './production-program-assignments';

/**
 * The practitioner side of the production program family under the unactivated `database_current` authority:
 * `assign`, `status`, `release`, `connections`, `programs` and `preview`, decided in the clinic the request selected by
 * the practitioner's current membership there, never by a token claim.
 *
 * A separate entry point beside the production adapter (production-program-assignments.ts), which keeps its claim
 * context; the patient app's actions stay on that adapter, decided by the patient's own token and current connection.
 * Nothing here is wired into a deployed handler: no host serves the production program family yet.
 *
 * It needs everything the production adapter needs before any request: the operator's activation evidence naming the
 * reviewed program candidate, and the consumer boundary's own evidence naming the boundary candidate (the only way into
 * the family, which withholds every purchase destination at the database). Then one transaction checks the
 * current-membership setter's reviewed body, binds the current membership of the signed-in subject in the selected
 * clinic (the UNREGISTERED setter, rows locked for the transaction) and runs `production_program_bounded_request`
 * under its own `has_clinical_role`, published-version, connection and revision checks. `set_request_context` is never
 * called. The destination lock is applied a second time here, on every projection that carries phases.
 */
const WORKFORCE_ONLY = new Set(['assign', 'status', 'release', 'connections', 'programs', 'preview']);
type ProgramPhases = Extract<ProgramAssignmentResponse, { action: 'read' }>['assignment']['phases'];

export function createCurrentMembershipProgramAssignments(deps: { database: ClinicalCoreDatabase; activation?: unknown; boundaryActivation?: unknown }) {
  const activation = activationState(deps.activation), boundary = boundaryActivationState(deps.boundaryActivation);
  return async (principal: CurrentWorkforcePrincipal, body: unknown): Promise<ProgramAssignmentResponse> => {
    if (!activation.enabled || !boundary.enabled) throw new ProductionProgramAssignmentError('activation_refused');
    const parsed = programAssignmentRequest.safeParse(body);
    if (!parsed.success) throw new ProductionProgramAssignmentError('request_invalid');
    const request = parsed.data;
    // A patient's action is the patient's own: it is never taken on a practitioner's membership.
    if (!WORKFORCE_ONLY.has(request.action)) throw new ProductionProgramAssignmentError('identity_refused');
    try {
      return await deps.database.transaction(async tx => {
        if (!await currentMembershipSetterBound(tx)) throw new ProductionProgramAssignmentError('service_unavailable');
        await bindCurrentWorkforceContext(tx, principal, 'clinical_data');
        const result = await tx.query<{ data: unknown }>('select clinical_core.production_program_bounded_request($1::jsonb) as data', [JSON.stringify(request)]);
        const raw = result.rows[0]?.data;
        const answer = parseProgramAssignmentResponse(request, typeof raw === 'string' ? JSON.parse(raw) : raw);
        const withheld = (phases: ProgramPhases) => phases.map(phase => ({ ...phase,
          items: phase.items.map(item => item.product ? { ...item, product: { ...item.product, purchaseUrl: null } } : item) }));
        if (answer.action === 'read') return { ...answer, assignment: { ...answer.assignment, phases: withheld(answer.assignment.phases) } };
        if (answer.action === 'preview') return { ...answer, phases: withheld(answer.phases) };
        return answer;
      });
    } catch (error) {
      if (error instanceof ProductionProgramAssignmentError) throw error;
      if (error instanceof CurrentMembershipRefusal) throw new ProductionProgramAssignmentError('identity_refused');
      if (error instanceof ClinicalCoreDatabaseRejection) {
        const reason = error.category === 'conflict' && (PROGRAM_REFUSAL_REASONS as readonly string[]).includes(error.reason ?? '') ? error.reason as ProgramRefusalReason : undefined;
        throw new ProductionProgramAssignmentError(error.category === 'conflict' ? 'conflict' : error.category === 'request_invalid' ? 'request_invalid'
          : error.category === 'consent_required' ? 'consent_refused' : 'identity_refused', reason);
      }
      throw new ProductionProgramAssignmentError('service_unavailable');
    }
  };
}
