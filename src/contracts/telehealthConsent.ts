import { z } from 'zod';
import { careConsentReview } from './careConnections';

const uuid = z.string().uuid(), version = z.number().int().min(0).max(999999999);
const scoped = { connectionId: uuid, scope: z.literal('telehealth_recording') };
/** Separate wire contract: never widen the immutable historical care port. */
export const telehealthConsentRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connection') }).strict(),
  z.object({ action: z.literal('consent'), ...scoped }).strict(),
  z.object({ action: z.literal('grant'), ...scoped, artifactId: uuid,
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: version }).strict(),
  z.object({ action: z.literal('withdraw'), ...scoped, expectedVersion: version }).strict(),
]);
export type TelehealthConsentRequest = z.infer<typeof telehealthConsentRequest>;
export const telehealthConsentReview = careConsentReview.extend({ scope: z.literal('telehealth_recording') });
export type TelehealthConsentReview = z.infer<typeof telehealthConsentReview>;
const connection = z.object({ connectionId: uuid, patientRecordId: uuid, state: z.enum(['verified', 'paused']),
  verifiedAt: z.string().datetime({ offset: true }), version: version.refine(v => v > 0) }).strict();
export function parseTelehealthConsentResponse(request: TelehealthConsentRequest, value: unknown) {
  if (request.action === 'connection') return z.object({ connection: connection.nullable() }).strict().parse(value);
  if (request.action === 'consent') {
    const result = telehealthConsentReview.parse(value);
    if (result.connectionId !== request.connectionId) throw Error('telehealth_consent_response_invalid');
    return result;
  }
  const result = z.object({ ...scoped, status: z.enum(['granted', 'revoked', 'not_granted']),
    artifactId: uuid.nullable(), version, alreadyApplied: z.boolean() }).strict().parse(value);
  if (result.connectionId !== request.connectionId || request.action === 'grant' && result.status !== 'granted'
    || request.action === 'grant' && result.artifactId !== request.artifactId
    || request.action === 'withdraw' && result.artifactId !== null
    || request.action === 'withdraw' && result.status === 'granted'
    || result.version < request.expectedVersion || result.version > request.expectedVersion + 1
    || !result.alreadyApplied && result.version !== request.expectedVersion + 1
    || result.status === 'not_granted' && (request.action !== 'withdraw' || request.expectedVersion !== 0
      || result.version !== 0 || !result.alreadyApplied)) throw Error('telehealth_consent_response_invalid');
  return result;
}
