import { z } from 'zod';
/**
 * Pre-visit questionnaires and signed documents.
 *
 * The content shapes here mirror the database's own validators field for field. Two
 * validators that disagree are worse than one, because the disagreement shows up as a form
 * that can be drafted and never published, or published and never rendered.
 *
 * A signature carries the digest of the document it was shown and the digest of the
 * sentence it agreed to, and the typed name travels sealed. "The patient agreed" is only
 * worth recording if which words they agreed to is recoverable afterwards.
 */
export const INTAKE_FORM_ACK = 'intake-forms/1' as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,38}$/);
export const intakeFormKey = z.string().regex(/^[a-z][a-z0-9_-]{2,48}$/);
export const intakeFormKind = z.enum(['questionnaire', 'consent_document']);
export const intakeFormStatus = z.enum(['draft', 'published', 'retired']);
export const intakePacketStatus = z.enum(['open', 'completed', 'cancelled']);
export const signerAuthority = z.enum(['self', 'guardian', 'healthcare_proxy', 'legal_representative']);
/** The name the patient typed, normalised for whitespace before it is sent. */
export const signerName = z.string().trim().min(2).max(120);

const option = z.object({ value: identifier, label: z.string().min(1).max(200) }).strict();
const question = z.discriminatedUnion('type', [
  z.object({ id: identifier, prompt: z.string().min(1).max(500), required: z.boolean(),
    type: z.literal('single_choice'), options: z.array(option).min(2).max(20) }).strict(),
  z.object({ id: identifier, prompt: z.string().min(1).max(500), required: z.boolean(),
    type: z.literal('multi_choice'), options: z.array(option).min(2).max(20) }).strict(),
  z.object({ id: identifier, prompt: z.string().min(1).max(500), required: z.boolean(),
    type: z.literal('scale'), min: z.number().int(), max: z.number().int() }).strict()
    .refine(value => value.max > value.min && value.max - value.min <= 10, 'scale_bounds_invalid'),
  z.object({ id: identifier, prompt: z.string().min(1).max(500), required: z.boolean(),
    type: z.literal('short_text'), maxLength: z.number().int().min(1).max(500) }).strict(),
  z.object({ id: identifier, prompt: z.string().min(1).max(500), required: z.boolean(),
    type: z.literal('boolean') }).strict(),
]);
export type IntakeQuestion = z.infer<typeof question>;
export const questionnaireContent = z.object({
  sections: z.array(z.object({
    id: identifier, title: z.string().min(1).max(160), questions: z.array(question).min(1).max(40),
  }).strict()).min(1).max(20),
}).strict();
export type QuestionnaireContent = z.infer<typeof questionnaireContent>;
export const consentDocumentContent = z.object({
  body: z.array(z.object({
    heading: z.string().min(1).max(200), paragraphs: z.array(z.string().min(1).max(4000)).min(1).max(40),
  }).strict()).min(1).max(40),
  // A document that does not ask for a typed name would record an agreement with nothing
  // attached to it, so the flag is required rather than merely allowed.
  agreement: z.object({
    statement: z.string().min(20).max(1000), requiresTypedName: z.literal(true),
  }).strict(),
}).strict();
export type ConsentDocumentContent = z.infer<typeof consentDocumentContent>;
export const intakeFormContent = z.union([questionnaireContent, consentDocumentContent]);

export const intakeAnswers = z.record(identifier,
  z.union([z.string().max(500), z.number(), z.boolean(), z.array(identifier).max(20), z.null()]));
export type IntakeAnswers = z.infer<typeof intakeAnswers>;

export const intakeFormAdminRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), status: intakeFormStatus.optional() }).strict(),
  z.object({
    action: z.literal('draft'), formKey: intakeFormKey, title: z.string().trim().min(1).max(160),
    kind: intakeFormKind, content: intakeFormContent,
  }).strict(),
  z.object({
    action: z.literal('update'), formVersionId: z.string().uuid(),
    title: z.string().trim().min(1).max(160).optional(), content: intakeFormContent,
  }).strict(),
  z.object({ action: z.literal('publish'), formVersionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('retire'), formVersionId: z.string().uuid() }).strict(),
]);
export type IntakeFormAdminRequest = z.infer<typeof intakeFormAdminRequest>;

export const intakeFormAdminResponse = z.union([
  z.object({
    action: z.literal('list'), forms: z.array(z.object({
      formVersionId: z.string().uuid(), formKey: intakeFormKey, version: z.number().int().positive(),
      title: z.string(), kind: intakeFormKind, status: intakeFormStatus, contentSha256: digest,
      agreementSha256: digest.nullable(), createdAt: z.string(), publishedAt: z.string().nullable(),
      assignable: z.boolean(),
    }).strict()),
  }).strict(),
  z.object({
    action: z.literal('draft'), formVersionId: z.string().uuid(), formKey: intakeFormKey,
    version: z.number().int().positive(), status: z.literal('draft'), contentSha256: digest,
  }).strict(),
  z.object({
    action: z.literal('update'), formVersionId: z.string().uuid(), version: z.number().int().positive(),
    status: z.literal('draft'), contentSha256: digest,
  }).strict(),
  z.object({
    action: z.literal('publish'), formVersionId: z.string().uuid(), formKey: intakeFormKey,
    version: z.number().int().positive(), status: z.literal('published'), contentSha256: digest,
  }).strict(),
  z.object({ action: z.literal('retire'), formVersionId: z.string().uuid(), status: z.literal('retired') }).strict(),
]);
export type IntakeFormAdminResponse = z.infer<typeof intakeFormAdminResponse>;

export const intakePacketWorkforceRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('assign'), connectionId: z.string().uuid(),
    label: z.string().trim().min(1).max(160),
    forms: z.array(z.object({ formVersionId: z.string().uuid(), required: z.boolean() }).strict()).min(1).max(20),
    dueBefore: z.string().datetime({ offset: true }).nullish(),
    consultRequestId: z.string().uuid().nullish(),
  }).strict(),
  z.object({
    action: z.literal('list'), connectionId: z.string().uuid().nullish(),
    status: intakePacketStatus.optional(),
  }).strict(),
  z.object({ action: z.literal('open'), packetId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('cancel'), packetId: z.string().uuid(), expectedRevision: revision }).strict(),
]);
export type IntakePacketWorkforceRequest = z.infer<typeof intakePacketWorkforceRequest>;

const packetSummary = z.object({
  packetId: z.string().uuid(), label: z.string(), status: intakePacketStatus,
  dueBefore: z.string().nullable(), createdAt: z.string(), revision,
  outstanding: z.number().int().min(0),
});
export const intakePacketWorkforceResponse = z.union([
  z.object({
    action: z.literal('assign'), packetId: z.string().uuid(), status: z.literal('open'), revision,
    items: z.array(z.object({
      formVersionId: z.string().uuid(), formKey: intakeFormKey, version: z.number().int().positive(),
      kind: intakeFormKind, position: z.number().int().positive(), contentSha256: digest,
    }).strict()),
  }).strict(),
  z.object({
    action: z.literal('list'), packets: z.array(packetSummary.extend({
      connectionId: z.string().uuid(), completedAt: z.string().nullable(),
      consultRequestId: z.string().uuid().nullable(), required: z.number().int().min(0),
    }).strict()),
  }).strict(),
  z.object({
    action: z.literal('open'), packetId: z.string().uuid(), label: z.string(),
    status: intakePacketStatus, connectionId: z.string().uuid(), dueBefore: z.string().nullable(), revision,
    items: z.array(z.object({
      itemId: z.string().uuid(), position: z.number().int().positive(), required: z.boolean(),
      formKey: intakeFormKey, version: z.number().int().positive(), title: z.string(), kind: intakeFormKind,
      contentSha256: digest, answers: intakeAnswers.nullable(), submittedAt: z.string().nullable(),
      signature: z.object({
        signedAt: z.string(), authority: signerAuthority, agreementSha256: digest,
        signerName, signerNameDigest: digest,
      }).strict().nullable(),
    }).strict()),
  }).strict(),
  z.object({ action: z.literal('cancel'), packetId: z.string().uuid(), status: z.literal('cancelled'), revision }).strict(),
]);
export type IntakePacketWorkforceResponse = z.infer<typeof intakePacketWorkforceResponse>;

/** What the patient's app may ask. It cannot assign, cancel, or name another patient. */
export const intakePacketConsumerRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('open'), packetId: z.string().uuid() }).strict(),
  z.object({
    action: z.literal('submit'), packetId: z.string().uuid(), itemId: z.string().uuid(),
    contentSha256: digest, answers: intakeAnswers,
  }).strict(),
  z.object({
    action: z.literal('sign'), packetId: z.string().uuid(), itemId: z.string().uuid(),
    contentSha256: digest, agreementSha256: digest,
    signerName, signerNameDigest: digest, signerAuthority,
  }).strict(),
]);
export type IntakePacketConsumerRequest = z.infer<typeof intakePacketConsumerRequest>;

export const intakePacketConsumerResponse = z.union([
  z.object({ action: z.literal('list'), packets: z.array(packetSummary.strict()) }).strict(),
  z.object({
    action: z.literal('open'), packetId: z.string().uuid(), label: z.string(),
    status: intakePacketStatus, dueBefore: z.string().nullable(), revision,
    items: z.array(z.object({
      itemId: z.string().uuid(), position: z.number().int().positive(), required: z.boolean(),
      formVersionId: z.string().uuid(), formKey: intakeFormKey, version: z.number().int().positive(),
      title: z.string(), kind: intakeFormKind, content: intakeFormContent,
      contentSha256: digest, agreementSha256: digest.nullable(),
      response: z.object({ submittedAt: z.string(), answersSha256: digest }).strict().nullable(),
      signature: z.object({ signedAt: z.string(), authority: signerAuthority }).strict().nullable(),
    }).strict()),
  }).strict(),
  z.object({
    action: z.literal('submit'), packetId: z.string().uuid(), itemId: z.string().uuid(),
    packetStatus: z.enum(['open', 'completed']), contentSha256: digest,
  }).strict(),
  z.object({
    action: z.literal('sign'), packetId: z.string().uuid(), itemId: z.string().uuid(),
    packetStatus: z.enum(['open', 'completed']), agreementSha256: digest, signerAuthority,
  }).strict(),
]);
export type IntakePacketConsumerResponse = z.infer<typeof intakePacketConsumerResponse>;

const bind = <Request extends { action: string }, Response extends { action: string }>(
  schema: z.ZodType<Response>, request: Request, raw: unknown,
): Response => {
  const parsed = schema.parse(raw);
  if (parsed.action !== request.action) throw new Error('response_action_mismatch');
  return parsed;
};
export const parseIntakeFormAdminResponse = (request: IntakeFormAdminRequest, raw: unknown) =>
  bind(intakeFormAdminResponse, request, raw);
export const parseIntakePacketWorkforceResponse = (request: IntakePacketWorkforceRequest, raw: unknown) =>
  bind(intakePacketWorkforceResponse, request, raw);
export const parseIntakePacketConsumerResponse = (request: IntakePacketConsumerRequest, raw: unknown) =>
  bind(intakePacketConsumerResponse, request, raw);
