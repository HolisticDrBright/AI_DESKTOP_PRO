import { z } from 'zod';
import type { ProgramAssignmentRequest, ProgramAssignmentResponse } from './programAssignments';

/**
 * Completing a program step against the review the person was shown (program-bound-completion/1).
 *
 * The pinned program-assignment/1 completion names the artifact (`sourceDigest`) and the assignment revision
 * (`expectedRevision`). This successor adds the review's plan revision, and it is mandatory: the production boundary
 * (infra/aws-clinical-core/production-candidates/production-program-consumer-boundary.sql) refuses a completion that
 * does not name the plan revision of the service's CURRENT review, before anything is written, even when the step is
 * still listed as available. A new or corrected lab result, a changed plan or a consent change moves the plan
 * revision; a completion from a second device moves the assignment revision.
 *
 * Mirrored byte for byte in AI_LONGEVITY_PRO_V2 (expo/contracts/programCompletion.ts) and pinned in both.
 *
 * PROGRAM_BOUND_COMPLETION_ACCEPTED is false. The service the app reaches today (the synthetic program family) answers
 * the pinned request and would refuse this one, so the app keeps sending the pinned request. It is turned on in the
 * same reviewed change that activates the production family with its boundary, which refuses the pinned request: an
 * app that was not updated fails closed (nothing is completed), it never completes against a review it did not see.
 */
export const PROGRAM_BOUND_COMPLETION = 'program-bound-completion/1' as const;
export const PROGRAM_BOUND_COMPLETION_ACCEPTED: boolean = false;

const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const programBoundCompletionRequest = z.object({
  action: z.literal('complete'), enrollmentId: z.string().uuid(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: revision, planRevision: z.string().trim().min(1).max(200), itemId: key,
}).strict();
export type ProgramBoundCompletionRequest = z.infer<typeof programBoundCompletionRequest>;

type Read = Extract<ProgramAssignmentResponse, { action: 'read' }>;
/** The completion for one step, bound to exactly the read the person is looking at: its artifact, its assignment
 * revision and its review's plan revision. Nothing is taken from anywhere else. */
export function boundCompletionFor(read: Read, itemId: string): ProgramBoundCompletionRequest {
  return programBoundCompletionRequest.parse({ action: 'complete', enrollmentId: read.assignment.enrollmentId,
    sourceDigest: read.assignment.sourceDigest, expectedRevision: read.assignment.revision,
    planRevision: read.review.planRevision, itemId });
}
/** The same completion as the pinned request shape, which the pinned response parser checks the answer against. */
export function pinnedCompletionOf(request: ProgramBoundCompletionRequest): Extract<ProgramAssignmentRequest, { action: 'complete' }> {
  const { planRevision: _bound, ...pinned } = request;
  return pinned;
}
