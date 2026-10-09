import { z } from 'zod';
/**
 * Program assignment: the authorized artifact that joins a published Desktop
 * program version to one patient, and the operations on it.
 *
 * Every mutation names the artifact (`sourceDigest`) and the state it believes it
 * is acting on (`expectedRevision`). The server applies it only if both still
 * hold, so a second device, a replayed request or a stale screen cannot win.
 * `phaseId` is never transition authority: the server reads its own phase order.
 */
export const PROGRAM_ASSIGNMENT_ACK = 'program-assignment/1' as const;
const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const programItem = z.object({
  id: key, title: text(240), kind: z.enum(['lesson', 'diet', 'habit', 'supplement']),
  instructions: z.string().max(4000), released: z.boolean(),
  product: z.object({
    id: key, ingredientKeys: z.array(key).min(1).max(40), dose: text(240),
    purchaseUrl: z.string().url().startsWith('https://').nullable(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  // A supplement without a governed product is not reviewable, and a product on a
  // lesson is a claim nobody approved.
  if ((value.kind === 'supplement') !== (value.product !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'program_product_identity_required' });
  }
});
export const programPhase = z.object({
  id: key, title: text(240), days: z.number().int().min(1).max(365),
  transition: z.enum(['scheduled', 'check_in', 'practitioner']),
  items: z.array(programItem).max(100),
}).strict();
export const programPhases = z.array(programPhase).min(1).max(52);
const owned = { enrollmentId: z.string().uuid(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: revision };
export const programAssignmentRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('read'), enrollmentId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('accept'), ...owned, planRevision: text(200) }).strict(),
  z.object({ action: z.literal('complete'), ...owned, itemId: key }).strict(),
  z.object({ action: z.literal('check_in'), ...owned }).strict(),
  z.object({ action: z.literal('advance'), ...owned }).strict(),
  z.object({ action: z.literal('pause'), ...owned }).strict(),
  z.object({ action: z.literal('resume'), ...owned }).strict(),
  z.object({ action: z.literal('withdraw'), ...owned }).strict(),
  // A request NAMES a published version; it does not describe one. Title, phases,
  // released flags, ingredient keys and purchase destinations are read from the
  // published artifact on the server, because a caller-supplied body is not evidence
  // that anything was approved — not even a body that hashes to a digest.
  z.object({ action: z.literal('assign'), connectionId: z.string().uuid(),
    programVersionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('programs') }).strict(),
  z.object({ action: z.literal('preview'), programVersionId: z.string().uuid() }).strict(),
  // No connection means the whole clinic, which is the scope a workforce panel works at.
  z.object({ action: z.literal('status'), connectionId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal('connections') }).strict(),
  z.object({ action: z.literal('release'), enrollmentId: z.string().uuid(), phaseId: key }).strict(),
]);
export type ProgramAssignmentRequest = z.infer<typeof programAssignmentRequest>;
const state = z.enum(['offered', 'active', 'paused', 'withdrawn']);
export const programReview = z.object({
  planRevision: z.string().min(1).max(200), inventoryComplete: z.boolean(),
  add: z.array(key), duplicate: z.array(key), held: z.array(key), conflicts: z.array(key),
}).strict();
const summary = z.object({
  enrollmentId: z.string().uuid(), title: text(240), state, revision, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  programVersion: key, phaseIndex: z.number().int().min(0), phaseCount: z.number().int().min(1), finished: z.boolean(),
  assignedAt: z.string().datetime({ offset: true }),
}).strict();
const applied = { enrollmentId: z.string().uuid(), revision };
export const programListing = z.object({
  programVersionId: z.string().uuid(), programId: z.string().uuid(), programVersion: key,
  programName: text(240), title: text(240), phaseCount: z.number().int().min(0),
  assignable: z.boolean(), publishedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export const programAssignmentResponse = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), assignments: z.array(summary).max(50) }).strict(),
  z.object({ action: z.literal('read'),
    assignment: z.object({ enrollmentId: z.string().uuid(), title: text(240), state, revision,
      sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), programVersion: key, phases: programPhases,
      phaseIndex: z.number().int().min(0), finished: z.boolean(),
      startedAt: z.string().datetime({ offset: true }).nullable(),
      phaseStartedAt: z.string().datetime({ offset: true }).nullable() }).strict(),
    completed: z.array(key), review: programReview,
    authorizations: z.array(z.object({ phaseId: key, kind: z.enum(['consumer_check_in', 'practitioner_release']) }).strict()),
  }).strict(),
  z.object({ action: z.literal('accept'), ...applied, state, duplicate: z.boolean() }).strict(),
  z.object({ action: z.literal('complete'), ...applied, itemId: key }).strict(),
  z.object({ action: z.literal('check_in'), ...applied, phaseId: key }).strict(),
  z.object({ action: z.literal('advance'), ...applied, phaseIndex: z.number().int().min(0), finished: z.boolean() }).strict(),
  z.object({ action: z.literal('pause'), ...applied, state }).strict(),
  z.object({ action: z.literal('resume'), ...applied, state }).strict(),
  z.object({ action: z.literal('withdraw'), ...applied, state }).strict(),
  z.object({ action: z.literal('assign'), enrollmentId: z.string().uuid(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), state, revision, duplicate: z.boolean() }).strict(),
  z.object({ action: z.literal('status'), assignments: z.array(z.object({
    enrollmentId: z.string().uuid(), title: text(240), state, revision,
    patientRecordId: z.string().uuid(), connectionId: z.string().uuid(),
    phaseIndex: z.number().int().min(0), phaseCount: z.number().int().min(1), finished: z.boolean(),
    completedCount: z.number().int().min(0), assignedAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }) }).strict()).max(50) }).strict(),
  z.object({ action: z.literal('connections'), connections: z.array(z.object({
    connectionId: z.string().uuid(), patientRecordId: z.string().uuid(),
    verifiedAt: z.string().datetime({ offset: true }) }).strict()).max(50) }).strict(),
  z.object({ action: z.literal('release'), enrollmentId: z.string().uuid(), phaseId: key }).strict(),
  z.object({ action: z.literal('programs'), programs: z.array(programListing).max(50) }).strict(),
  // The preview is the compiled published artifact and the review it would produce, so
  // a practitioner sees what a patient would see before anyone is offered anything.
  z.object({ action: z.literal('preview'), programVersionId: z.string().uuid(), programVersion: key,
    title: text(240), phases: programPhases, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    review: programReview }).strict(),
]);
export type ProgramAssignmentResponse = z.infer<typeof programAssignmentResponse>;
export function parseProgramAssignmentResponse(input: ProgramAssignmentRequest, value: unknown): ProgramAssignmentResponse {
  const result = programAssignmentResponse.parse(value);
  if (result.action !== input.action) throw new Error('program_response_mismatch');
  // A preview about a different version than the one asked about is not an answer.
  if (result.action === 'preview' && input.action === 'preview'
    && result.programVersionId !== input.programVersionId) throw new Error('program_response_mismatch');
  // A reply about a different enrollment than the one asked about is not an answer.
  const asked = 'enrollmentId' in input ? input.enrollmentId : null;
  const answered = 'enrollmentId' in result ? result.enrollmentId : null;
  if (asked && answered && asked !== answered) throw new Error('program_response_mismatch');
  if (result.action === 'read' && result.assignment.enrollmentId !== (input as { enrollmentId: string }).enrollmentId) {
    throw new Error('program_response_mismatch');
  }
  return result;
}
