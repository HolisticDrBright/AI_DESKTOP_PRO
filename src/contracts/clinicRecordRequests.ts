import { z } from 'zod';

/**
 * Clinic-record privacy: a patient asks a connected clinic for an authorized
 * copy of clinic-held records or for a correction of a signed note; the clinic
 * reviews, fulfils or refuses; the patient reads the fulfilled copy page by page.
 *
 * Mirrored field for field by the V2 app (expo/contracts/clinicRecordRequests.ts)
 * and by clinical_core.clinic_record_request(jsonb). Decisions visible in the shape:
 *
 * - The server derives the actor, the organization and the patient from the
 *   verified identity and the canonical patient connection. No patient id,
 *   clinic id or connection id is accepted from the client for a submission.
 * - A request id and a decision id are chosen by the client so a lost response
 *   is settled by replaying the SAME bytes (alreadyApplied), never by a second
 *   request or a second decision.
 * - A fulfilled copy is a snapshot taken at fulfilment (`asOf`), read by keyset.
 *   `coverage.completeClinicRecord` is always false: what was not included is
 *   named, never implied.
 * - A correction targets one disclosed signed note revision. Acceptance is an
 *   append-only addendum; the original signed content never changes. A decline
 *   records the disagreement beside the record. This is not deletion.
 */
export const CLINIC_RECORD_REQUEST_CONTRACT = 'clinic-record-requests/2' as const;
export const CLINIC_RECORD_COPY_CONTRACT = 'clinic-record-copy/1' as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const when = z.string().min(10).max(40);
const revision = z.number().int().min(1).max(2_147_483_647);
const statement = z.string().trim().min(1).max(2000);

export const clinicRecordSection = z.enum(['signed_notes', 'telehealth_visits', 'lab_observations', 'correspondence', 'protocols_programs', 'intake_checkins']);
export type ClinicRecordSection = z.infer<typeof clinicRecordSection>;
/** Sections the copy reader can page; the others are named exclusions. */
export const clinicRecordReadableSection = z.enum(['signed_notes', 'telehealth_visits', 'lab_observations']);
export const clinicRecordKind = z.enum(['copy', 'correction']);
export const clinicRecordStatus = z.enum(['submitted', 'in_review', 'fulfilled', 'refused', 'withdrawn', 'superseded']);
export const clinicRecordOutcome = z.enum(['copy_delivered', 'copy_refused', 'amended', 'declined']);
export const clinicRecordReasonCode = z.enum(['not_true_of_me', 'was_true_no_longer', 'never_discussed', 'disagree_with_conclusion', 'wrong_person', 'missing_context', 'other']);
export type ClinicRecordReasonCode = z.infer<typeof clinicRecordReasonCode>;
export const clinicRecordDecisionReasonCode = z.enum(['not_disclosable', 'identity_unverified', 'duplicate', 'out_of_scope', 'record_accurate', 'other']);
const sections = z.array(clinicRecordSection).min(1).max(8).refine((list) => new Set(list).size === list.length);

export const clinicRecordRequestRecord = z.object({
  requestId: uuid, kind: clinicRecordKind, status: clinicRecordStatus, revision,
  sections: z.array(clinicRecordSection).max(8),
  subject: z.object({ kind: z.literal('clinical_note'), id: uuid, revision }).strict().nullable(),
  reasonCode: clinicRecordReasonCode.nullable(), statement: statement.nullable(),
  submittedAt: when, updatedAt: when, decidedAt: when.nullable(),
  decisionReasonCode: z.string().max(40).nullable(), decisionReason: z.string().max(2000).nullable(),
  fulfillmentId: uuid.nullable(), supersededBy: uuid.nullable(), outcome: clinicRecordOutcome.nullable(),
  /** Workforce views only. */
  patientRecordId: uuid.optional(),
}).strict();
export type ClinicRecordRequestRecord = z.infer<typeof clinicRecordRequestRecord>;

export const clinicRecordEvent = z.object({
  seq: z.number().int().min(1), action: z.enum(['submitted', 'withdrawn', 'superseded', 'review_started', 'copy_fulfilled', 'refused', 'amended', 'declined']),
  actorPool: z.enum(['consumer', 'workforce']), fromStatus: clinicRecordStatus.nullable(), toStatus: clinicRecordStatus,
  reasonCode: z.string().max(40).nullable(), reason: z.string().max(2000).nullable(), decisionId: uuid.nullable(),
  detail: z.record(z.string(), z.unknown()), at: when,
}).strict();

const manifestSection = z.object({
  section: clinicRecordSection, included: z.boolean(), itemCount: z.number().int().min(0), byteTotal: z.number().int().min(0),
  omittedCount: z.number().int().min(0), exclusionReason: z.string().max(200).nullable(), excluded: z.record(z.string(), z.number().int().min(0)).nullable(),
}).strict();
export const clinicRecordCopyManifest = z.object({
  contract: z.literal(CLINIC_RECORD_COPY_CONTRACT), copyId: uuid, requestId: uuid, asOf: when,
  consistency: z.literal('snapshot_at_fulfillment'), releaseVersion: z.string().min(3).max(80),
  sections: z.array(manifestSection).max(8),
  coverage: z.object({ completeClinicRecord: z.literal(false), notIncluded: z.array(z.string().max(120)).max(12) }).strict(),
}).strict();
export type ClinicRecordCopyManifest = z.infer<typeof clinicRecordCopyManifest>;
export const clinicRecordCopySummary = z.object({
  copyId: uuid, asOf: when, manifest: clinicRecordCopyManifest, manifestSha256: hash.optional(),
  itemCount: z.number().int().min(0), byteTotal: z.number().int().min(0),
}).strict();

/**
 * Wire form of one copy item (clinic-record-requests/2): the EXACT UTF-8 text
 * the clinic digested at fulfilment, its digest and its byte length. A device
 * hashes the received text before parsing it, so a decimal written 1.20 or
 * 0.0000001 is verified and displayed as written; a re-serialized object is
 * never what is hashed. Nothing structured travels beside the text.
 */
export const clinicRecordCopyItem = z.object({
  seq: z.number().int().min(1), recordKind: z.enum(['clinical_note', 'telehealth_visit', 'lab_observation']), recordId: uuid, revision,
  payloadText: z.string().min(2).max(49152).refine((text) => text.startsWith('{') && text.endsWith('}')),
  payloadSha256: hash, byteLength: z.number().int().min(1).max(49152),
}).strict();

const connection = z.object({ connectionId: uuid, patientRecordId: uuid, state: z.enum(['verified', 'paused']), verifiedAt: when.nullable(), version: z.number().int().min(0) }).strict();
const registryEntry = z.object({ section: clinicRecordSection, readable: z.boolean(), exclusionReason: z.string().max(200).nullable(), projection: z.string().max(400) }).strict();

/* ------------------------------------------------------------ consumer */
export const clinicRecordConsumerRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('overview') }).strict(),
  z.object({ action: z.literal('submit_copy'), requestId: uuid, sections, supersedes: uuid.optional() }).strict(),
  z.object({ action: z.literal('submit_correction'), requestId: uuid, subjectKind: z.literal('clinical_note'), subjectId: uuid, subjectRevision: revision,
    reasonCode: clinicRecordReasonCode, statement }).strict(),
  z.object({ action: z.literal('get'), requestId: uuid }).strict(),
  z.object({ action: z.literal('withdraw'), requestId: uuid, expectedRevision: revision }).strict(),
  z.object({ action: z.literal('read_copy'), requestId: uuid, section: clinicRecordReadableSection, limit: z.number().int().min(1).max(50), after: z.number().int().min(1).optional() }).strict(),
]);
export type ClinicRecordConsumerRequest = z.infer<typeof clinicRecordConsumerRequest>;

export const clinicRecordConsumerResponse = z.discriminatedUnion('action', [
  z.object({ action: z.literal('overview'), connection: connection.nullable(), sections: z.array(registryEntry).max(8), requests: z.array(clinicRecordRequestRecord).max(50) }).strict(),
  z.object({ action: z.literal('submit_copy'), request: clinicRecordRequestRecord, alreadyApplied: z.boolean() }).strict(),
  z.object({ action: z.literal('submit_correction'), request: clinicRecordRequestRecord, alreadyApplied: z.boolean() }).strict(),
  z.object({ action: z.literal('get'), request: clinicRecordRequestRecord, events: z.array(clinicRecordEvent).max(64), copy: clinicRecordCopySummary.nullable() }).strict(),
  z.object({ action: z.literal('withdraw'), request: clinicRecordRequestRecord, alreadyApplied: z.boolean() }).strict(),
  z.object({ action: z.literal('read_copy'), requestId: uuid, copyId: uuid, section: clinicRecordReadableSection, asOf: when,
    items: z.array(clinicRecordCopyItem).max(50), next: z.number().int().min(1).nullable() }).strict(),
]);
export type ClinicRecordConsumerResponse = z.infer<typeof clinicRecordConsumerResponse>;

/* ----------------------------------------------------------- workforce */
const decision = { requestId: uuid, expectedRevision: revision, decisionId: uuid };
export const clinicRecordWorkforceRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('queue'), status: clinicRecordStatus.optional(), limit: z.number().int().min(1).max(100),
    after: z.object({ submittedAt: when, requestId: uuid }).strict().optional() }).strict(),
  z.object({ action: z.literal('review'), requestId: uuid }).strict(),
  z.object({ action: z.literal('begin_review'), ...decision }).strict(),
  z.object({ action: z.literal('fulfill'), ...decision, sections: z.array(clinicRecordReadableSection).min(1).max(8),
    excluded: z.array(z.object({ section: clinicRecordSection, reason: z.string().trim().min(1).max(200) }).strict()).max(8).optional() }).strict(),
  z.object({ action: z.literal('refuse'), ...decision, reasonCode: clinicRecordDecisionReasonCode, reason: statement }).strict(),
  z.object({ action: z.literal('amend'), ...decision, addendumReason: z.string().trim().min(1).max(500), addendumContent: z.string().min(1).max(65536), reason: statement.optional() }).strict(),
  z.object({ action: z.literal('decline'), ...decision, reasonCode: clinicRecordDecisionReasonCode, reason: statement }).strict(),
]);
export type ClinicRecordWorkforceRequest = z.infer<typeof clinicRecordWorkforceRequest>;

const previewEntry = z.object({ section: clinicRecordSection, readable: z.boolean(), exclusionReason: z.string().max(200).nullable(),
  includable: z.number().int().min(0), excluded: z.record(z.string(), z.number().int().min(0)) }).strict();
const decided = z.object({ request: clinicRecordRequestRecord, alreadyApplied: z.boolean() });
export const clinicRecordWorkforceResponse = z.discriminatedUnion('action', [
  z.object({ action: z.literal('queue'), requests: z.array(clinicRecordRequestRecord).max(100), next: z.object({ submittedAt: when, requestId: uuid }).strict().nullable() }).strict(),
  z.object({ action: z.literal('review'), request: clinicRecordRequestRecord, events: z.array(clinicRecordEvent).max(64), preview: z.array(previewEntry).max(8).nullable(),
    subjectNote: z.object({ noteId: uuid, status: z.string().max(40), currentVersion: z.number().int().min(0), signedAt: when.nullable(), addenda: z.number().int().min(0) }).strict().nullable(),
    release: z.object({ releaseVersion: z.string().min(3).max(80), sections: z.array(clinicRecordSection).max(8), approvedAt: when }).strict().nullable(),
    copy: clinicRecordCopySummary.nullable() }).strict(),
  decided.extend({ action: z.literal('begin_review') }).strict(),
  decided.extend({ action: z.literal('fulfill'), copy: clinicRecordCopySummary.optional() }).strict(),
  decided.extend({ action: z.literal('refuse') }).strict(),
  decided.extend({ action: z.literal('amend'), addendumId: uuid.optional() }).strict(),
  decided.extend({ action: z.literal('decline') }).strict(),
]);
export type ClinicRecordWorkforceResponse = z.infer<typeof clinicRecordWorkforceResponse>;

/** Binds a response to the request it answers: the action, the request id and, for a page, the section and cursor progress. */
export function parseClinicRecordConsumerResponse(request: ClinicRecordConsumerRequest, value: unknown): ClinicRecordConsumerResponse {
  const result = clinicRecordConsumerResponse.parse(value);
  if (result.action !== request.action) throw new Error('clinic_record_response_mismatch');
  if ('requestId' in request && 'request' in result && result.request.requestId !== request.requestId) throw new Error('clinic_record_response_mismatch');
  if (request.action === 'read_copy' && result.action === 'read_copy') {
    if (result.requestId !== request.requestId || result.section !== request.section || result.items.length > request.limit) throw new Error('clinic_record_response_mismatch');
    let last = request.after ?? 0;
    for (const item of result.items) { if (item.seq <= last) throw new Error('clinic_record_response_mismatch'); last = item.seq; }
    if (result.next !== null && (!result.items.length || result.next !== last)) throw new Error('clinic_record_response_mismatch');
  }
  if ((request.action === 'submit_copy' || request.action === 'submit_correction') && result.action === request.action
    && (result.request.kind !== (request.action === 'submit_copy' ? 'copy' : 'correction'))) throw new Error('clinic_record_response_mismatch');
  return result;
}
export function parseClinicRecordWorkforceResponse(request: ClinicRecordWorkforceRequest, value: unknown): ClinicRecordWorkforceResponse {
  const result = clinicRecordWorkforceResponse.parse(value);
  if (result.action !== request.action) throw new Error('clinic_record_response_mismatch');
  if ('requestId' in request && 'request' in result && result.request.requestId !== request.requestId) throw new Error('clinic_record_response_mismatch');
  if (request.action === 'queue' && result.action === 'queue') {
    if (result.requests.length > request.limit) throw new Error('clinic_record_response_mismatch');
    for (let i = 1; i < result.requests.length; i++) {
      const a = result.requests[i - 1], b = result.requests[i];
      if (a.submittedAt > b.submittedAt || a.submittedAt === b.submittedAt && a.requestId >= b.requestId) throw new Error('clinic_record_response_mismatch');
    }
    if (result.next && (!result.requests.length || result.next.requestId !== result.requests.at(-1)!.requestId)) throw new Error('clinic_record_response_mismatch');
  }
  return result;
}

/** What each decision means to the person reading it. */
export const CLINIC_RECORD_OUTCOME_LABEL: Record<z.infer<typeof clinicRecordOutcome>, string> = {
  copy_delivered: 'Your copy is ready to read in the app',
  copy_refused: 'The clinic did not release a copy through this request',
  amended: 'Your practitioner added a correction note; the original record stays as it was signed',
  declined: 'Your practitioner kept the record as signed; your disagreement is recorded with it',
};
export const CLINIC_RECORD_SECTION_LABEL: Record<ClinicRecordSection, string> = {
  signed_notes: 'Signed visit notes and their addenda',
  telehealth_visits: 'Telehealth visit records',
  lab_observations: 'Reviewed lab results',
  correspondence: 'Messages with the clinic',
  protocols_programs: 'Programs and protocols',
  intake_checkins: 'Intake forms and check-ins',
};
