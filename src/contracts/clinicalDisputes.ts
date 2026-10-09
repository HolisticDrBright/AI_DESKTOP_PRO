import { z } from 'zod';
/**
 * Contesting a record, and being told when a delivered one was corrected.
 *
 * Two surfaces that belong together: both are about what happens after something is already
 * wrong or already out of date.
 *
 * The shape encodes two rules the database enforces and a screen must not contradict. A
 * resolution always carries the clinician's answer, because a resolution without one is a
 * dismissal wearing a decision's clothes. And a resolved dispute is still reported by
 * `summary` — an upheld disagreement stays attached to the item, so a screen that only drew
 * open ones would hide exactly the case that matters.
 */
export const CLINICAL_DISPUTE_ACK = 'clinical-disputes/1' as const;
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const statement = z.string().trim().min(1).max(2000);
export const disputeSubjectKind = z.enum(['program_assignment', 'lab_observation', 'intake_response']);
export const disputeReasonCode = z.enum(['not_true_of_me', 'was_true_no_longer', 'never_discussed',
  'disagree_with_conclusion', 'wrong_person', 'missing_context', 'other']);
export const disputeStatus = z.enum(['open', 'acknowledged', 'resolved', 'withdrawn']);
/** `corrected` is the only one that means the clinician agreed. `upheld` records the disagreement. */
export const disputeResolution = z.enum(['corrected', 'upheld', 'declined']);
export const revisionClass = z.enum(['safety_withdrawal', 'correction', 'enhancement']);
export const revisionNoticeStatus = z.enum(['pending', 'delivered', 'acknowledged']);

const disputeStatement = z.object({ body: statement, statedAt: z.string() }).strict();
const disputeRecord = z.object({
  disputeId: z.string().uuid(), subjectKind: disputeSubjectKind, subjectId: z.string().uuid(),
  reasonCode: disputeReasonCode, status: disputeStatus, resolution: disputeResolution.nullable(),
  clinicianResponse: statement.nullable(), raisedAt: z.string(),
  acknowledgedAt: z.string().nullable(), resolvedAt: z.string().nullable(), revision,
  statements: z.array(disputeStatement).max(50),
});

export const disputeConsumerRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({
    // No connection id: the server derives it from the subject, searching only the
    // connections this account owns.
    action: z.literal('raise'), subjectKind: disputeSubjectKind, subjectId: z.string().uuid(),
    reasonCode: disputeReasonCode, statement,
  }).strict(),
  z.object({ action: z.literal('add_statement'), disputeId: z.string().uuid(), statement }).strict(),
  z.object({ action: z.literal('withdraw'), disputeId: z.string().uuid(), expectedRevision: revision }).strict(),
]);
export type DisputeConsumerRequest = z.infer<typeof disputeConsumerRequest>;

export const disputeConsumerResponse = z.union([
  z.object({ action: z.literal('list'), disputes: z.array(disputeRecord.strict()).max(200) }).strict(),
  z.object({ action: z.literal('raise'), disputeId: z.string().uuid(), status: z.literal('open'), revision }).strict(),
  z.object({ action: z.literal('add_statement'), disputeId: z.string().uuid(), status: disputeStatus }).strict(),
  z.object({ action: z.literal('withdraw'), disputeId: z.string().uuid(), status: z.literal('withdrawn'), revision }).strict(),
]);
export type DisputeConsumerResponse = z.infer<typeof disputeConsumerResponse>;

export const disputeWorkforceRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), status: disputeStatus.optional() }).strict(),
  z.object({
    action: z.literal('summary'), subjectKind: disputeSubjectKind,
    subjectIds: z.array(z.string().uuid()).max(200),
  }).strict(),
  z.object({ action: z.literal('acknowledge'), disputeId: z.string().uuid(), expectedRevision: revision }).strict(),
  z.object({
    action: z.literal('resolve'), disputeId: z.string().uuid(), expectedRevision: revision,
    resolution: disputeResolution, clinicianResponse: statement,
  }).strict(),
]);
export type DisputeWorkforceRequest = z.infer<typeof disputeWorkforceRequest>;

export const disputeWorkforceResponse = z.union([
  z.object({
    action: z.literal('list'),
    disputes: z.array(disputeRecord.extend({ connectionId: z.string().uuid() }).strict()).max(200),
  }).strict(),
  z.object({
    action: z.literal('summary'), subjectKind: disputeSubjectKind,
    subjects: z.array(z.object({
      subjectId: z.string().uuid(), disputeId: z.string().uuid(), status: disputeStatus,
      resolution: disputeResolution.nullable(), raisedAt: z.string(),
    }).strict()).max(200),
  }).strict(),
  z.object({ action: z.literal('acknowledge'), disputeId: z.string().uuid(), status: z.literal('acknowledged'), revision }).strict(),
  z.object({
    action: z.literal('resolve'), disputeId: z.string().uuid(), status: z.literal('resolved'),
    resolution: disputeResolution, revision,
  }).strict(),
]);
export type DisputeWorkforceResponse = z.infer<typeof disputeWorkforceResponse>;

export const revisionWorkforceRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), status: revisionNoticeStatus.optional() }).strict(),
  z.object({ action: z.literal('preview'), toVersionId: z.string().uuid() }).strict(),
  z.object({
    action: z.literal('publish_notices'), toVersionId: z.string().uuid(),
    revisionClass, statement: statement.nullish(),
  }).strict(),
]);
export type RevisionWorkforceRequest = z.infer<typeof revisionWorkforceRequest>;

export const revisionWorkforceResponse = z.union([
  z.object({
    action: z.literal('list'), notices: z.array(z.object({
      noticeId: z.string().uuid(), connectionId: z.string().uuid(), assignmentId: z.string().uuid(),
      revisionClass, itemsAdded: z.number().int().min(0), itemsRemoved: z.number().int().min(0),
      itemsChanged: z.number().int().min(0), statement: statement.nullable(),
      status: revisionNoticeStatus, createdAt: z.string(), acknowledgedAt: z.string().nullable(),
    }).strict()).max(500),
  }).strict(),
  z.object({
    action: z.literal('preview'), toVersionId: z.string().uuid(), affected: z.number().int().min(0),
    assignments: z.array(z.object({
      assignmentId: z.string().uuid(), connectionId: z.string().uuid(),
      fromVersion: z.number().int().positive(), itemsAdded: z.number().int().min(0),
      itemsRemoved: z.number().int().min(0), itemsChanged: z.number().int().min(0),
    }).strict()).max(500),
  }).strict(),
  z.object({
    action: z.literal('publish_notices'), toVersionId: z.string().uuid(), revisionClass,
    noticesCreated: z.number().int().min(0),
  }).strict(),
]);
export type RevisionWorkforceResponse = z.infer<typeof revisionWorkforceResponse>;

export const revisionConsumerRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('acknowledge'), noticeId: z.string().uuid() }).strict(),
]);
export type RevisionConsumerRequest = z.infer<typeof revisionConsumerRequest>;

export const revisionConsumerResponse = z.union([
  z.object({
    action: z.literal('list'), notices: z.array(z.object({
      noticeId: z.string().uuid(), assignmentId: z.string().uuid(), title: z.string(),
      revisionClass, itemsAdded: z.number().int().min(0), itemsRemoved: z.number().int().min(0),
      itemsChanged: z.number().int().min(0), statement: statement.nullable(),
      status: revisionNoticeStatus, createdAt: z.string(),
      // A safety withdrawal is not satisfied by being displayed.
      requiresAcknowledgement: z.boolean(),
    }).strict()).max(200),
  }).strict(),
  z.object({ action: z.literal('acknowledge'), noticeId: z.string().uuid(), status: z.literal('acknowledged') }).strict(),
]);
export type RevisionConsumerResponse = z.infer<typeof revisionConsumerResponse>;

const bind = <Request extends { action: string }, Response extends { action: string }>(
  schema: z.ZodType<Response>, request: Request, raw: unknown,
): Response => {
  const parsed = schema.parse(raw);
  if (parsed.action !== request.action) throw new Error('response_action_mismatch');
  return parsed;
};
export const parseDisputeConsumerResponse = (request: DisputeConsumerRequest, raw: unknown) =>
  bind(disputeConsumerResponse, request, raw);
export const parseDisputeWorkforceResponse = (request: DisputeWorkforceRequest, raw: unknown) =>
  bind(disputeWorkforceResponse, request, raw);
export const parseRevisionWorkforceResponse = (request: RevisionWorkforceRequest, raw: unknown) =>
  bind(revisionWorkforceResponse, request, raw);
export const parseRevisionConsumerResponse = (request: RevisionConsumerRequest, raw: unknown) =>
  bind(revisionConsumerResponse, request, raw);
