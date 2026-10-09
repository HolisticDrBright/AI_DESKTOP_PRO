import { z } from 'zod';
export const careConsentScope = z.enum(['programs', 'protocols_supplements', 'nutrition', 'appointments', 'messaging',
  'forms_checkins', 'symptoms_adherence', 'wearables', 'reproductive_health', 'lab_summaries', 'lab_results_import',
  'lab_specimen_context', 'billing_links', 'research_n_of_1']);
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), version = z.number().int().min(0).max(999999999);
const scoped = { connectionId: uuid, scope: careConsentScope };
export const careConnectionRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('issue'), patientRecordId: uuid }).strict(),
  z.object({ action: z.literal('claim'), token: z.string().trim().max(24).transform(s => s.toUpperCase().replaceAll('-', ''))
    .pipe(z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{13}$/)) }).strict(),
  z.object({ action: z.literal('connection') }).strict(),
  z.object({ action: z.literal('consent'), ...scoped }).strict(),
  z.object({ action: z.literal('grant'), ...scoped, artifactId: uuid, contentSha256: hash, expectedVersion: version }).strict(),
  z.object({ action: z.literal('withdraw'), ...scoped, expectedVersion: version }).strict(),
]);
export type CareConnectionRequest = z.infer<typeof careConnectionRequest>;
const connection = z.object({ connectionId: uuid, patientRecordId: uuid, state: z.enum(['verified', 'paused']),
  verifiedAt: z.string().datetime({ offset: true }), version: version.refine(v => v > 0) }).strict();
const artifact = z.object({ artifactId: uuid, artifactVersion: z.string().min(1).max(64), contentSha256: hash,
  jurisdiction: z.string().min(2).max(64), approvedAt: z.string().datetime({ offset: true }), content: z.string().min(1).max(16000) }).strict();
const consentStatus = z.enum(['granted', 'revoked', 'not_granted']);
export const careConsentReview = z.object({ connectionId: uuid, connectionState: z.enum(['verified', 'paused', 'revoked']),
  scope: careConsentScope, status: consentStatus, version, currentArtifactId: uuid.nullable(), artifact: artifact.nullable() }).strict();
export function parseCareConnectionResponse(request: CareConnectionRequest, value: unknown) {
  if (request.action === 'issue') return z.object({ ok: z.literal(true), message: z.literal('Invitation created'), connectionId: uuid,
    invitationId: uuid, token: z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{13}$/), expiresAt: z.string().datetime({ offset: true }),
    state: z.literal('invitation_pending'), version: version.refine(v => v > 0) }).strict().parse(value);
  if (request.action === 'claim') return connection.extend({ state: z.literal('verified') }).parse(value);
  if (request.action === 'connection') return z.object({ connection: connection.nullable() }).strict().parse(value);
  const response = request.action === 'consent' ? careConsentReview.parse(value) : z.object({ connectionId: uuid, scope: careConsentScope,
    status: consentStatus, version, alreadyApplied: z.boolean() }).strict().parse(value);
  if (response.connectionId !== request.connectionId || response.scope !== request.scope) throw new Error('care_connection_response_invalid');
  if (request.action === 'grant' && response.status !== 'granted') throw new Error('care_connection_response_invalid');
  if (request.action === 'withdraw' && response.status === 'granted') throw new Error('care_connection_response_invalid');
  if (request.action !== 'consent' && 'alreadyApplied' in response
    && (response.version < request.expectedVersion || response.version > request.expectedVersion + 1
      || !response.alreadyApplied && response.version !== request.expectedVersion + 1
      || response.status === 'not_granted' && (request.action !== 'withdraw' || request.expectedVersion !== 0
        || response.version !== 0 || !response.alreadyApplied))) throw new Error('care_connection_response_invalid');
  return response;
}
