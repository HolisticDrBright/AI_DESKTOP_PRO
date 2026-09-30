import {z} from 'zod';
import {programPhases} from './programAssignments';
/**
 * Owner export, erasure and the erasure record for the messaging and program domains.
 *
 * Three decisions are visible in these shapes rather than only in the SQL.
 *
 * `settlementsRetained` with its reason exists because a cancellation tombstone is not
 * erased by a domain erase. The tombstone is what refuses the late admission of a request
 * the owner cancelled, so erasing it would give cancellation an expiry date.
 *
 * `threadsRetained` with its reason exists because a thread is shared. The owner's own
 * messages go; a thread still holding the clinic's messages is the clinic's record.
 *
 * `lateAdmissionRefusable` is false only after account closure, and the owner is told that
 * rather than left to infer it.
 */
export const CARE_DATA_LIFECYCLE_ACK = 'care-data-lifecycle/1' as const;
const cursor = z.string().min(1).max(200);
const when = z.string().datetime({offset: true});

export const careDataSection = z.enum(['threads', 'messages', 'settlements', 'assignments', 'completions', 'authorizations']);
export type CareDataSection = z.infer<typeof careDataSection>;
/** A domain erase keeps the cancellation refusal. Closure is the only thing that ends it. */
export const careDataEraseScope = z.enum(['domain', 'account_closure']);

export const careDataRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('export'), section: careDataSection,
    limit: z.number().int().min(1).max(100).optional(), after: cursor.optional(),
  }).strict(),
  z.object({action: z.literal('erase'), scope: careDataEraseScope}).strict(),
  z.object({action: z.literal('erasure_history')}).strict(),
]);
export type CareDataRequest = z.infer<typeof careDataRequest>;

const thread = z.object({threadId: z.string().uuid(), subject: z.string().min(1).max(120),
  createdAt: when, updatedAt: when}).strict();
const message = z.object({messageId: z.string().uuid(), threadId: z.string().uuid(),
  requestId: z.string().uuid(), body: z.string().min(1).max(4000), createdAt: when}).strict();
const settlement = z.object({requestId: z.string().uuid(), settledAt: when}).strict();
const assignment = z.object({enrollmentId: z.string().uuid(), title: z.string().min(1).max(240),
  state: z.enum(['offered', 'active', 'paused', 'withdrawn']), programVersionId: z.string().uuid(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), phaseIndex: z.number().int().min(0),
  finished: z.boolean(), assignedAt: when, phases: programPhases}).strict();
const completion = z.object({enrollmentId: z.string().uuid(), itemId: z.string().min(1).max(160), completedAt: when}).strict();
const authorization = z.object({enrollmentId: z.string().uuid(), phaseId: z.string().min(1).max(160),
  kind: z.enum(['consumer_check_in', 'practitioner_release']), authorizedAt: when}).strict();

const erasureCounts = {
  messagesErased: z.number().int().min(0), threadsErased: z.number().int().min(0),
  threadsRetained: z.number().int().min(0), assignmentsErased: z.number().int().min(0),
  settlementsErased: z.number().int().min(0), settlementsRetained: z.number().int().min(0),
  lateAdmissionRefusable: z.boolean(),
};

export const careDataResponse = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('export'), section: careDataSection, next: cursor.nullable(),
    items: z.array(z.union([thread, message, settlement, assignment, completion, authorization])).max(100),
  }).strict(),
  z.object({
    action: z.literal('erase'), scope: careDataEraseScope, erasureId: z.string().uuid(), ...erasureCounts,
    retainedReason: z.literal('cancellation_refusal_must_outlive_late_admission').nullable(),
    threadsRetainedReason: z.literal('thread_holds_another_participant_record').nullable(),
  }).strict(),
  z.object({
    action: z.literal('erasure_history'),
    erasures: z.array(z.object({erasureId: z.string().uuid(), scope: careDataEraseScope,
      ...erasureCounts, occurredAt: when}).strict()).max(50),
  }).strict(),
]);
export type CareDataResponse = z.infer<typeof careDataResponse>;

export function parseCareDataResponse(input: CareDataRequest, value: unknown): CareDataResponse {
  const result = careDataResponse.parse(value);
  if (result.action !== input.action) throw new Error('care_data_response_mismatch');
  if (result.action === 'export' && input.action === 'export' && result.section !== input.section) {
    throw new Error('care_data_response_mismatch');
  }
  if (result.action === 'erase' && input.action === 'erase' && result.scope !== input.scope) {
    throw new Error('care_data_response_mismatch');
  }
  // A domain erase that reported the refusal as ended, or a closure that reported it as
  // standing, is not an answer this caller can act on.
  if (result.action === 'erase' && result.lateAdmissionRefusable !== (result.scope === 'domain')) {
    throw new Error('care_data_response_mismatch');
  }
  if (result.action === 'erase' && result.scope === 'domain' && result.settlementsErased !== 0) {
    throw new Error('care_data_response_mismatch');
  }
  return result;
}
