if (typeof window !== 'undefined') throw new Error('learner/consumer-session is server-only.');
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { SyntheticRequestContext } from '../clinical-core/aws-identity-consent';

/**
 * A verified consumer session, the only source of a learner's identity in the reviewed runtime.
 *
 *   1. The ID token's signature, issuer, audience (the consumer app client), token use and expiry
 *      are verified against the user pool's published keys (aws-jwt-verify). An unsigned, foreign,
 *      expired or workforce token is not a session.
 *   2. The token must carry the consumer's verified person and clinic (custom:person_id,
 *      custom:organization_id), be attested synthetic and not production-bound: this runtime serves
 *      the synthetic qualification target only.
 *   3. Revocation, on EVERY request: Cognito GetUser with the session's access token. Cognito refuses
 *      a revoked access token (sign-out everywhere, token revocation, a disabled or deleted user), so a
 *      session that was signed out elsewhere stops working at once rather than at token expiry.
 *   4. Owner: the user GetUser returns must be the ID token's subject, and its current person and
 *      clinic attributes must still be the token's. A token for one user and an access token for
 *      another is refused.
 * Nothing is remembered: there is no cache of a positive answer, so every request repeats 1 to 4.
 * A request body, a staff login, a fixture cookie or a stored earlier result is never an identity.
 */
export type ConsumerSessionTokens = { idToken: string; accessToken: string };
export type ConsumerSessionResult =
  | { state: 'verified'; context: SyntheticRequestContext }
  | { state: 'refused'; reason: 'token_invalid' | 'claims_refused' | 'session_revoked' | 'owner_mismatch' | 'auth_too_old' }
  | { state: 'unavailable' };
export type ConsumerUser = { username: string; attributes: Readonly<Record<string, string>> };
export class ConsumerSessionRevoked extends Error { constructor() { super('session_revoked'); this.name = 'ConsumerSessionRevoked'; } }
export type ConsumerSessionVerifier = (tokens: ConsumerSessionTokens | null) => Promise<ConsumerSessionResult>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function createConsumerSessionVerifier(deps: {
  /** Signature, issuer, audience, token use and expiry; throws otherwise. */
  verifyIdToken: (token: string) => Promise<Record<string, unknown>>;
  /** Cognito GetUser on the access token; throws ConsumerSessionRevoked when Cognito refuses the token, anything else when unreachable. */
  getUser: (accessToken: string) => Promise<ConsumerUser>;
  now?: () => Date;
  /** How old the sign-in may be; the session is refused after it even while its tokens refresh. */
  maxAuthAgeSeconds?: number;
}): ConsumerSessionVerifier {
  const now = deps.now ?? (() => new Date());
  const maxAge = deps.maxAuthAgeSeconds ?? 12 * 3600;
  return async tokens => {
    if (!tokens || !TOKEN.test(tokens.idToken) || !TOKEN.test(tokens.accessToken) || tokens.idToken.length > 8192 || tokens.accessToken.length > 8192) return { state: 'refused', reason: 'token_invalid' };
    let claims: Record<string, unknown>;
    try { claims = await deps.verifyIdToken(tokens.idToken); } catch { return { state: 'refused', reason: 'token_invalid' }; }
    const text = (key: string) => (typeof claims[key] === 'string' ? (claims[key] as string) : '');
    const subject = text('sub'), personId = text('custom:person_id'), organizationId = text('custom:organization_id');
    if (!SUBJECT.test(subject) || !UUID.test(personId) || !UUID.test(organizationId)
      || text('custom:synthetic_attested') !== 'true' || text('custom:production_bound') === 'true') return { state: 'refused', reason: 'claims_refused' };
    const authTime = Number(claims.auth_time);
    if (!Number.isFinite(authTime) || now().getTime() / 1000 - authTime > maxAge) return { state: 'refused', reason: 'auth_too_old' };
    let user: ConsumerUser;
    try { user = await deps.getUser(tokens.accessToken); }
    catch (error) { return error instanceof ConsumerSessionRevoked ? { state: 'refused', reason: 'session_revoked' } : { state: 'unavailable' }; }
    if ((user.attributes.sub ?? '') !== subject || user.attributes['custom:person_id'] !== personId || user.attributes['custom:organization_id'] !== organizationId) {
      return { state: 'refused', reason: 'owner_mismatch' };
    }
    return { state: 'verified', context: {
      actorPersonId: personId, organizationId, identityPool: 'consumer', identitySubject: subject,
      purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false,
    } };
  };
}

/** The Cognito bindings for a consumer pool and app client: published keys for the ID token, GetUser for revocation. No IAM credential is used or needed. */
export function cognitoConsumerSessionVerifier(pool: { poolId: string; clientId: string }, options: { maxAuthAgeSeconds?: number } = {}): ConsumerSessionVerifier {
  const jwt = CognitoJwtVerifier.create({ userPoolId: pool.poolId, tokenUse: 'id', clientId: pool.clientId });
  const cognito = new CognitoIdentityProviderClient({ region: 'us-east-2', endpoint: 'https://cognito-idp.us-east-2.amazonaws.com', maxAttempts: 1 });
  return createConsumerSessionVerifier({
    verifyIdToken: async token => (await jwt.verify(token)) as unknown as Record<string, unknown>,
    getUser: async accessToken => {
      try {
        const reply = await cognito.send(new GetUserCommand({ AccessToken: accessToken }));
        const attributes: Record<string, string> = {};
        for (const attribute of reply.UserAttributes ?? []) if (attribute.Name && typeof attribute.Value === 'string') attributes[attribute.Name] = attribute.Value;
        return { username: reply.Username ?? '', attributes };
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === 'NotAuthorizedException' || name === 'UserNotFoundException' || name === 'PasswordResetRequiredException' || name === 'UserNotConfirmedException') throw new ConsumerSessionRevoked();
        throw error;
      }
    },
    maxAuthAgeSeconds: options.maxAuthAgeSeconds,
  });
}
