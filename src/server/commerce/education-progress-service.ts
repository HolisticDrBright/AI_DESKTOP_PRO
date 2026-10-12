import { educationProgressRequest, type EducationProgressOutcome, type EducationProgressRead } from '../../contracts/programEducationProgress';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';
import { programCommerceActivationState } from './program-commerce-activation';
import type { ProgramEducationLedger } from './program-education-ledger';
import type { ConsumerCaller } from './program-commerce-authority';

/**
 * The narrowly admitted server bridge for a learner's own progress (program-education-progress/1).
 * Shaped like the education access bridge (context + body) so it can be mounted as
 * `POST /clinical-core/consumer/education/progress` after review; it is NOT registered in the Lambda
 * route table, the API template or the route inventory by this source.
 *
 *   - the consumer pool only, on the synthetic boundary only, with `clinical_data` purpose;
 *   - the caller is the context's verified person and identity subject, never a body field;
 *   - the body is exactly one of `read`, `complete`, `position`; nothing else is read;
 *   - activation evidence must name the progress candidate this source was built against.
 * Progress is the learner's bookkeeping. Nothing here reads or writes a clinical record, a check-in,
 * a practitioner phase, a supplement or a protocol, and nothing is completed by a read.
 */
export class EducationProgressError extends Error {
  constructor(readonly category: 'activation_refused' | 'identity_refused' | 'request_invalid' | 'service_unavailable') { super(category); this.name = 'EducationProgressError'; }
}
export type EducationProgressResponse = { action: 'read'; read: EducationProgressRead } | { action: 'complete' | 'position'; outcome: EducationProgressOutcome };

export type EducationProgressDependencies = { ledger: ProgramEducationLedger; activation?: unknown; progressCandidateSha256?: string; expectedProgressSha256: string };

export function createEducationProgressService(deps: EducationProgressDependencies) {
  const activation = programCommerceActivationState(deps.activation);
  const enabled = activation.enabled && deps.progressCandidateSha256 === deps.expectedProgressSha256;
  return async (context: ClinicalRequestContext, body: unknown): Promise<EducationProgressResponse> => {
    if (!enabled) throw new EducationProgressError('activation_refused');
    if (context.identityPool !== 'consumer' || context.purpose !== 'clinical_data' || context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') throw new EducationProgressError('identity_refused');
    const parsed = educationProgressRequest.safeParse(body);
    if (!parsed.success) throw new EducationProgressError('request_invalid');
    const caller: ConsumerCaller = { kind: 'consumer', personId: context.actorPersonId, identitySubject: context.identitySubject };
    const request = parsed.data;
    try {
      if (request.action === 'read') {
        const read = await deps.ledger.progress(caller, request.entitlementId);
        if (read.outcome === 'refused' && read.reason === 'service_unavailable') throw new EducationProgressError('service_unavailable');
        return { action: 'read', read };
      }
      const outcome = await deps.ledger.recordProgress(caller, request);
      if (outcome.outcome === 'refused' && outcome.reason === 'service_unavailable') throw new EducationProgressError('service_unavailable');
      return { action: request.action, outcome };
    } catch (error) {
      if (error instanceof EducationProgressError) throw error;
      throw new EducationProgressError('service_unavailable');
    }
  };
}

/** The route this service is shaped for, as a seam for review; not registered by this source. */
export const EDUCATION_PROGRESS_ROUTE_SEAM = { route: 'POST /clinical-core/consumer/education/progress', pool: 'consumer', purpose: 'clinical_data', operation: 'education_progress', boundary: 'synthetic' } as const;
