import { educationAccessRequest, type EducationAccessView, type EducationCurriculumRead, type ClaimRefusal, type ProgramEntitlement } from '../../contracts/programEducationAccess';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';
import { programCommerceActivationState } from './program-commerce-activation';
import type { createProgramSettlement } from './program-settlement';
import type { ConsumerCaller } from './program-commerce-authority';

/**
 * The narrowly admitted server bridge for a purchaser's own education access: the only way a
 * consumer identity reaches the settlement boundary. It is a service function in the shape the
 * identity API dispatches (context + body), so it can be mounted as `POST /clinical-core/consumer/education`
 * after review; it is NOT registered in the Lambda route table, the API template or the route
 * inventory by this source (that registration is in Codex's lane, named in the return document).
 *
 * Minimum fields and current authorization, and the tests hold each:
 *   - the consumer pool only, on the synthetic boundary only, with `clinical_data` purpose: a
 *     workforce identity, a production context or any other purpose is refused;
 *   - the caller is the context's verified person and identity subject, never a body field;
 *   - the body is exactly one of: `access` (own entitlements and enrollments), `claim` (the one-time
 *     token), `curriculum` (one entitlement id); nothing else is read;
 *   - activation evidence must name the candidates this source was built against, or every call is
 *     `activation_refused`; a disabled bridge is not a capability.
 * Nothing here reads a clinical table, creates a patient record, a membership or a consent, or
 * touches the clinical assignment service; a purchaser without a clinic connection is a learner and
 * only that.
 */
export class EducationAccessError extends Error {
  constructor(readonly category: 'activation_refused' | 'identity_refused' | 'request_invalid' | 'service_unavailable') { super(category); this.name = 'EducationAccessError'; }
}
export type EducationAccessResponse =
  | { action: 'access'; view: EducationAccessView }
  | { action: 'claim'; outcome: 'claimed'; entitlement: ProgramEntitlement }
  | { action: 'claim'; outcome: 'refused'; reason: ClaimRefusal }
  | { action: 'curriculum'; read: EducationCurriculumRead };

export type EducationAccessDependencies = { settlement: ReturnType<typeof createProgramSettlement>; activation?: unknown; checkoutCandidateSha256?: string; educationCandidateSha256?: string; expectedCheckoutSha256: string; expectedEducationSha256: string };

export function createEducationAccessService(deps: EducationAccessDependencies) {
  const activation = programCommerceActivationState(deps.activation);
  const enabled = activation.enabled && deps.checkoutCandidateSha256 === deps.expectedCheckoutSha256 && deps.educationCandidateSha256 === deps.expectedEducationSha256;
  return async (context: ClinicalRequestContext, body: unknown): Promise<EducationAccessResponse> => {
    if (!enabled) throw new EducationAccessError('activation_refused');
    if (context.identityPool !== 'consumer' || context.purpose !== 'clinical_data' || context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') throw new EducationAccessError('identity_refused');
    const parsed = educationAccessRequest.safeParse(body);
    if (!parsed.success) throw new EducationAccessError('request_invalid');
    const caller: ConsumerCaller = { kind: 'consumer', personId: context.actorPersonId, identitySubject: context.identitySubject };
    const request = parsed.data;
    if (request.action === 'access') {
      const view = await deps.settlement.access(caller);
      if (!view) throw new EducationAccessError('service_unavailable');
      return { action: 'access', view };
    }
    if (request.action === 'claim') {
      const result = await deps.settlement.claim(caller, request.token);
      if (result.outcome === 'refused' && result.reason === 'service_unavailable') throw new EducationAccessError('service_unavailable');
      return result.outcome === 'claimed' ? { action: 'claim', outcome: 'claimed', entitlement: result.entitlement } : { action: 'claim', outcome: 'refused', reason: result.reason };
    }
    const read = await deps.settlement.curriculum(caller, request.entitlementId);
    if (read.outcome === 'withheld' && read.reason === 'service_unavailable') throw new EducationAccessError('service_unavailable');
    return { action: 'curriculum', read };
  };
}

/** The route this service is shaped for, as a seam for review; not registered by this source. */
export const EDUCATION_ACCESS_ROUTE_SEAM = { route: 'POST /clinical-core/consumer/education', pool: 'consumer', purpose: 'clinical_data', operation: 'education_access', boundary: 'synthetic' } as const;
