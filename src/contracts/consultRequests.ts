import { z } from 'zod';
/**
 * The public consult link and the requests it produces.
 *
 * Two request shapes exist deliberately. What a browser sends carries the visitor's own
 * name and email, because a stranger has no account and no other way to be reached. What
 * reaches the database carries a sealed envelope and a digest instead, and the sealing
 * happens on the server in between. A page therefore cannot write contact details straight
 * into a row, and a row cannot be read back into contact details without the key.
 *
 * Neither shape has a field for narrative health information. A visitor chooses a visit
 * type and one of the reasons the clinic published. An unauthenticated endpoint that
 * accepted "describe your symptoms" would be an unauthenticated clinical intake channel,
 * opened before any consent exists; clinical detail belongs to the intake packet, which is
 * authenticated and consented.
 */
export const CONSULT_REQUEST_ACK = 'consult-requests/1' as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const base64 = (length: number) => z.string().regex(new RegExp(`^[A-Za-z0-9+/=]{${length}}$`));
export const consultSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/);
export const consultReference = z.string().regex(/^[A-HJ-NP-Z2-9]{10}$/);
export const consultVisitType = z.enum(['initial', 'follow_up', 'urgent_question']);
export const consultReasonCode = z.enum(['new_consultation', 'lab_review', 'follow_up_care',
  'supplement_question', 'program_question', 'insurance_question', 'other']);
export const consultRequestStatus = z.enum(['received', 'accepted', 'declined', 'withdrawn', 'converted']);
export const consultDeclineReason = z.enum(['outside_scope', 'not_accepting', 'duplicate_request', 'unreachable']);
export const sealedContact = z.object({
  ciphertext: z.string().min(1).max(8192), iv: base64(16), tag: base64(24),
}).strict();
/** Times the visitor said they could attend. Times only; no note travels with them. */
export const consultWindows = z.array(z.object({
  from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }),
}).strict()).max(5);

/** What a page may send. The server seals the contact before anything is stored. */
export const publicConsultBrowserRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('describe'), slug: consultSlug }).strict(),
  z.object({
    action: z.literal('submit'), slug: consultSlug,
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().max(40).nullish(),
    visitType: consultVisitType, reasonCode: consultReasonCode,
    preferredWindows: consultWindows.default([]),
    timeZone: z.string().trim().min(3).max(64).nullish(),
  }).strict(),
  z.object({
    action: z.literal('withdraw'), reference: consultReference,
    email: z.string().trim().email().max(254),
  }).strict(),
]);
export type PublicConsultBrowserRequest = z.infer<typeof publicConsultBrowserRequest>;

/** What reaches the database. No plaintext contact detail appears in this shape at all. */
export const consultIntakeRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('describe'), slug: consultSlug }).strict(),
  z.object({
    action: z.literal('submit'), slug: consultSlug, contact: sealedContact, contactDigest: digest,
    visitType: consultVisitType, reasonCode: consultReasonCode,
    preferredWindows: consultWindows, timeZone: z.string().min(3).max(64).nullable(),
  }).strict(),
  z.object({ action: z.literal('withdraw'), reference: consultReference, contactDigest: digest }).strict(),
]);
export type ConsultIntakeRequest = z.infer<typeof consultIntakeRequest>;

const describeResponse = z.object({
  action: z.literal('describe'), slug: consultSlug, label: z.string().min(1).max(120),
  clinic: z.string().min(1).max(120), visitTypes: z.array(consultVisitType).min(1),
  reasonCodes: z.array(consultReasonCode).min(1), acceptingRequests: z.boolean(),
}).strict();
/** A throttled submission is an outcome, not an exception: the request simply was not made. */
const submitResponse = z.union([
  z.object({
    action: z.literal('submit'), outcome: z.literal('received'), reference: consultReference,
    receivedAt: z.string(), status: consultRequestStatus,
  }).strict(),
  z.object({
    action: z.literal('submit'), outcome: z.literal('throttled'), reference: z.null(),
    retryAfterSeconds: z.number().int().positive(),
  }).strict(),
]);
const withdrawResponse = z.object({
  action: z.literal('withdraw'), reference: consultReference, status: z.literal('withdrawn'),
}).strict();
export const consultIntakeResponse = z.union([describeResponse, submitResponse, withdrawResponse]);
export type ConsultIntakeResponse = z.infer<typeof consultIntakeResponse>;

export const consultLinkAdminRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({
    action: z.literal('create'), slug: consultSlug, label: z.string().trim().min(1).max(120),
    visitTypes: z.array(consultVisitType).min(1).max(3),
    reasonCodes: z.array(consultReasonCode).min(1).max(7),
    expiresAt: z.string().datetime({ offset: true }).nullish(),
  }).strict(),
  z.object({
    action: z.literal('update'), linkId: z.string().uuid(),
    label: z.string().trim().min(1).max(120).optional(),
    acceptingRequests: z.boolean().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullish(),
  }).strict(),
  z.object({ action: z.literal('disable'), linkId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('enable'), linkId: z.string().uuid() }).strict(),
]);
export type ConsultLinkAdminRequest = z.infer<typeof consultLinkAdminRequest>;

export const consultLinkAdminResponse = z.union([
  z.object({
    action: z.literal('list'), links: z.array(z.object({
      linkId: z.string().uuid(), slug: consultSlug, label: z.string(),
      visitTypes: z.array(consultVisitType), reasonCodes: z.array(consultReasonCode),
      status: z.enum(['active', 'disabled']), acceptingRequests: z.boolean(),
      expiresAt: z.string().nullable(), createdAt: z.string(), openRequests: z.number().int().min(0),
    }).strict()),
  }).strict(),
  z.object({ action: z.literal('create'), linkId: z.string().uuid(), slug: consultSlug, status: z.enum(['active', 'disabled']) }).strict(),
  z.object({
    action: z.literal('update'), linkId: z.string().uuid(), label: z.string(),
    acceptingRequests: z.boolean(), expiresAt: z.string().nullable(),
  }).strict(),
  z.object({ action: z.literal('disable'), linkId: z.string().uuid(), status: z.literal('disabled') }).strict(),
  z.object({ action: z.literal('enable'), linkId: z.string().uuid(), status: z.literal('active') }).strict(),
]);
export type ConsultLinkAdminResponse = z.infer<typeof consultLinkAdminResponse>;

export const consultReviewRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'), status: consultRequestStatus.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).strict(),
  z.object({ action: z.literal('open'), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('accept'), requestId: z.string().uuid(), expectedRevision: revision }).strict(),
  z.object({
    action: z.literal('decline'), requestId: z.string().uuid(), expectedRevision: revision,
    declineReason: consultDeclineReason,
  }).strict(),
  z.object({
    action: z.literal('convert'), requestId: z.string().uuid(), expectedRevision: revision,
    syntheticRecordKey: z.string().regex(/^patient_syn_[A-Za-z0-9_-]{8,96}$/),
  }).strict(),
]);
export type ConsultReviewRequest = z.infer<typeof consultReviewRequest>;

export const consultReviewResponse = z.union([
  z.object({
    action: z.literal('list'), requests: z.array(z.object({
      requestId: z.string().uuid(), reference: consultReference, slug: consultSlug,
      visitType: consultVisitType, reasonCode: consultReasonCode, status: consultRequestStatus,
      preferredWindows: consultWindows, timeZone: z.string().nullable(),
      receivedAt: z.string(), decidedAt: z.string().nullable(),
      declineReason: consultDeclineReason.nullable(),
      patientRecordId: z.string().uuid().nullable(), connectionId: z.string().uuid().nullable(),
      revision,
    }).strict()),
  }).strict(),
  z.object({
    action: z.literal('open'), requestId: z.string().uuid(), reference: consultReference,
    // The envelope's own binding travels with it, so the service checks that what it opens
    // belonged to this link and this visitor rather than opening whatever it was handed.
    slug: consultSlug, contactDigest: digest,
    contact: sealedContact, status: consultRequestStatus, revision,
  }).strict(),
  z.object({ action: z.literal('accept'), requestId: z.string().uuid(), status: z.literal('accepted'), revision }).strict(),
  z.object({
    action: z.literal('decline'), requestId: z.string().uuid(), status: z.literal('declined'),
    declineReason: consultDeclineReason, revision,
  }).strict(),
  z.object({
    action: z.literal('convert'), requestId: z.string().uuid(), status: z.literal('converted'),
    patientRecordId: z.string().uuid(), connectionId: z.string().uuid(), revision,
  }).strict(),
]);
export type ConsultReviewResponse = z.infer<typeof consultReviewResponse>;

/** A reply that does not answer the action that was asked is not usable, however well formed. */
const bind = <Request extends { action: string }, Response extends { action: string }>(
  schema: z.ZodType<Response>, request: Request, raw: unknown,
): Response => {
  const parsed = schema.parse(raw);
  if (parsed.action !== request.action) throw new Error('response_action_mismatch');
  return parsed;
};
export const parseConsultIntakeResponse = (request: ConsultIntakeRequest, raw: unknown) =>
  bind(consultIntakeResponse, request, raw);
export const parseConsultLinkAdminResponse = (request: ConsultLinkAdminRequest, raw: unknown) =>
  bind(consultLinkAdminResponse, request, raw);
export const parseConsultReviewResponse = (request: ConsultReviewRequest, raw: unknown) =>
  bind(consultReviewResponse, request, raw);
