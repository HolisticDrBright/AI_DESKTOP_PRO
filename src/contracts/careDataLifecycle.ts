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
const requestUuid = z.string().uuid().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);

export const careDataSection = z.enum(['threads', 'messages', 'settlements', 'assignments', 'completions',
  'authorizations', 'intake_packets', 'intake_responses', 'signatures', 'consult_requests']);
export type CareDataSection = z.infer<typeof careDataSection>;
/** A domain erase keeps the cancellation refusal. Closure is the only thing that ends it. */
export const careDataEraseScope = z.enum(['domain', 'account_closure']);

export const careDataRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('export'), section: careDataSection,
    limit: z.number().int().min(1).max(100).optional(), after: cursor.optional(),
  }).strict(),
  z.object({action: z.literal('erase'), scope: careDataEraseScope}).strict(),
  z.object({action: z.enum(['erase_request', 'erase_receipt', 'settle_erasure']),
    scope: careDataEraseScope, requestId: requestUuid}).strict(),
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

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const intakePacket = z.object({packetId: z.string().uuid(), label: z.string().min(1).max(160),
  status: z.enum(['open', 'completed', 'cancelled']), dueBefore: when.nullable(), assignedAt: when,
  completedAt: when.nullable(),
  forms: z.array(z.object({itemId: z.string().uuid(), position: z.number().int().positive(),
    required: z.boolean(), formKey: z.string().min(3).max(49), version: z.number().int().positive(),
    title: z.string().min(1).max(160), kind: z.enum(['questionnaire', 'consent_document']),
    contentSha256: digest}).strict()).max(20)}).strict();
const intakeResponse = z.object({responseId: z.string().uuid(), packetItemId: z.string().uuid(),
  formKey: z.string().min(3).max(49), version: z.number().int().positive(), title: z.string().min(1).max(160),
  formContentSha256: digest, answers: z.record(z.string(), z.unknown()), answersSha256: digest,
  submittedAt: when}).strict();
/**
 * A signed document, in full.
 *
 * The document body and the agreement sentence travel with the signature because a copy of
 * what they signed is the thing a person most needs to be able to keep; a digest alone would
 * let them prove nothing to anybody.
 */
const signature = z.object({signatureId: z.string().uuid(), packetItemId: z.string().uuid(),
  formKey: z.string().min(3).max(49), version: z.number().int().positive(), title: z.string().min(1).max(160),
  document: z.record(z.string(), z.unknown()), formContentSha256: digest,
  agreementStatement: z.string().min(20).max(1000), agreementSha256: digest,
  signerName: z.string().min(2).max(120),
  signerAuthority: z.enum(['self', 'guardian', 'healthcare_proxy', 'legal_representative']),
  signedAt: when}).strict();
const consultRequest = z.object({requestId: z.string().uuid(), reference: z.string().regex(/^[A-HJ-NP-Z2-9]{10}$/),
  visitType: z.enum(['initial', 'follow_up', 'urgent_question']),
  reasonCode: z.enum(['new_consultation', 'lab_review', 'follow_up_care', 'supplement_question',
    'program_question', 'insurance_question', 'other']),
  status: z.enum(['received', 'accepted', 'declined', 'withdrawn', 'converted']),
  preferredWindows: z.array(z.object({from: when, to: when}).strict()).max(5),
  timeZone: z.string().min(3).max(64).nullable(), receivedAt: when, decidedAt: when.nullable(),
  declineReason: z.enum(['outside_scope', 'not_accepting', 'duplicate_request', 'unreachable']).nullable(),
  convertedAt: when.nullable()}).strict();

const erasureCounts = {
  messagesErased: z.number().int().min(0), threadsErased: z.number().int().min(0),
  threadsRetained: z.number().int().min(0), assignmentsErased: z.number().int().min(0),
  settlementsErased: z.number().int().min(0), settlementsRetained: z.number().int().min(0),
  responsesErased: z.number().int().min(0),
  packetsRetained: z.number().int().min(0), packetsErased: z.number().int().min(0),
  signaturesRetained: z.number().int().min(0), signaturesErased: z.number().int().min(0),
  consultRequestsErased: z.number().int().min(0),
  disputeStatementsErased: z.number().int().min(0),
  disputesRetained: z.number().int().min(0), disputesErased: z.number().int().min(0),
  revisionNoticesErased: z.number().int().min(0),
  lateAdmissionRefusable: z.boolean(),
};

export const careDataEraseReceipt = z.object({
  action: z.literal('erase'), scope: careDataEraseScope, erasureId: z.string().uuid(), ...erasureCounts,
  retainedReason: z.literal('cancellation_refusal_must_outlive_late_admission').nullable(),
  threadsRetainedReason: z.literal('thread_holds_another_participant_record').nullable(),
  packetsRetainedReason: z.literal('packet_is_the_clinic_record_of_what_was_asked').nullable(),
  signaturesRetainedReason: z.literal('signature_is_the_recorded_basis_for_care_already_given').nullable(),
  disputesRetainedReason: z.literal('dispute_records_a_decision_and_the_disagreement_with_it').nullable(),
}).strict();
export const careDataErasureResult = z.object({
  action: z.enum(['erase_request', 'erase_receipt', 'settle_erasure']),
  scope: careDataEraseScope, requestId: requestUuid,
  outcome: z.enum(['erased', 'cancelled', 'unresolved']), receipt: careDataEraseReceipt.nullable(),
}).strict();
export type CareDataErasureResult = z.infer<typeof careDataErasureResult>;

export const careDataResponse = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('export'), section: careDataSection, next: cursor.nullable(),
    items: z.array(z.union([thread, message, settlement, assignment, completion, authorization,
      intakePacket, intakeResponse, signature, consultRequest])).max(100),
  }).strict(),
  careDataEraseReceipt,
  careDataErasureResult,
  z.object({
    action: z.literal('erasure_history'),
    erasures: z.array(z.object({erasureId: z.string().uuid(), scope: careDataEraseScope,
      ...erasureCounts, occurredAt: when}).strict()).max(50),
  }).strict(),
]);
export type CareDataResponse = z.infer<typeof careDataResponse>;
const sectionRow={threads:thread,messages:message,settlements:settlement,assignments:assignment,
  completions:completion,authorizations:authorization,intake_packets:intakePacket,
  intake_responses:intakeResponse,signatures:signature,consult_requests:consultRequest};

export function parseCareDataResponse(input: CareDataRequest, value: unknown): CareDataResponse {
  const result = careDataResponse.parse(value);
  if (result.action !== input.action) throw new Error('care_data_response_mismatch');
  if ('requestId' in result && 'requestId' in input) {
    if (result.requestId !== input.requestId || result.scope !== input.scope
      || (result.outcome === 'erased') !== (result.receipt !== null)
      || (result.outcome === 'unresolved' && result.action !== 'erase_receipt')) {
      throw new Error('care_data_response_mismatch');
    }
    if (result.receipt) parseCareDataResponse({action: 'erase', scope: input.scope}, result.receipt);
  }
  if (result.action === 'export' && input.action === 'export' && result.section !== input.section) {
    throw new Error('care_data_response_mismatch');
  }
  if(result.action==='export'&&input.action==='export'){
    if(result.items.length>(input.limit??100))throw new Error('care_data_response_mismatch');
    for(const item of result.items)if(!sectionRow[input.section].safeParse(item).success)throw new Error('care_data_response_mismatch');
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
