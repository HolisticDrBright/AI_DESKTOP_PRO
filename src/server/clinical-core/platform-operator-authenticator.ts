if (typeof window !== 'undefined') throw new Error('platform-operator-authenticator is server-only');
import { z } from 'zod';
import { AdminGetUserCommand, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';

/**
 * How a platform operator signs in: a SEPARATE login, never a workforce or patient account.
 *
 * - The operator's token must come from the operator user pool and its own app client. The configuration refuses a
 *   pool or client shared with the workforce or consumer sign-ins, and a workforce or consumer issuer is refused by
 *   name even if a verifier were misconfigured to accept it.
 * - The operator pool must require MFA (`MfaConfiguration: ON`), read from Cognito on every request, not remembered.
 * - The operator's own account must be enabled and confirmed, with a confirmed address and TOTP as its preferred
 *   factor (`SOFTWARE_TOKEN_MFA`; SMS is not accepted for this role), and must not have changed since the sign-in.
 * - The sign-in must be fresh (within 15 minutes), so a long-lived session cannot carry operator authority.
 *
 * It answers only "which operator subject is this, now"; whether that subject is an ACTIVE, registered operator is
 * decided inside each operator SQL function against `clinical_private.workforce_platform_operators`, which no API role
 * can write. BLOCKED: `PLATFORM_OPERATOR_SIGN_IN_RELEASE` refuses before any token is read, no operator pool exists,
 * and no route or surface uses this.
 */
export const PLATFORM_OPERATOR_SIGN_IN_RELEASE: 'blocked' | 'qualification' = 'blocked';
const POOL = /^us-east-2_[A-Za-z0-9]{9}$/;
const CLIENT = /^[a-z0-9]{26}$/;
export const platformOperatorTarget = z.object({
  account: z.literal('588966314750'),
  operatorPoolId: z.string().regex(POOL),
  operatorClientId: z.string().regex(CLIENT),
  /** Every workforce and consumer pool and client, so none can double as the operator login. */
  otherPoolIds: z.array(z.string().regex(POOL)).min(1).max(8),
  otherClientIds: z.array(z.string().regex(CLIENT)).min(1).max(8),
}).strict().refine(t => !t.otherPoolIds.includes(t.operatorPoolId) && !t.otherClientIds.includes(t.operatorClientId),
  { message: 'operator_login_not_separate' });
export type PlatformOperatorTarget = z.infer<typeof platformOperatorTarget>;

export class PlatformOperatorSignInError extends Error {
  constructor(readonly code: 'not_released' | 'operator_refused') { super(code); }
}
type Commands = { send(command: unknown, options?: { abortSignal: AbortSignal }): Promise<Record<string, unknown>> };
const record = (value: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(value);
const require = (condition: unknown) => { if (!condition) throw new PlatformOperatorSignInError('operator_refused'); };
const issuer = (pool: string) => `https://cognito-idp.us-east-2.amazonaws.com/${pool}`;
const time = (value: unknown) => { require(value instanceof Date && Number.isFinite(value.getTime())); return (value as Date).getTime(); };

export function createPlatformOperatorAuthenticator(input: {
  target: unknown;
  /** A verifier bound to the operator pool, its client and `tokenUse: 'id'` (aws-jwt-verify in the reviewed host). */
  jwt: { verify(token: string): Promise<unknown> };
  cognito: Commands;
  release?: 'blocked' | 'qualification';
  now?: () => number;
}) {
  const target = platformOperatorTarget.parse(structuredClone(input.target));
  const release = input.release ?? PLATFORM_OPERATOR_SIGN_IN_RELEASE;
  const now = input.now ?? Date.now;
  return async (authorization: string): Promise<string> => {
    if (release !== 'qualification') throw new PlatformOperatorSignInError('not_released');
    try {
      const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(typeof authorization === 'string' ? authorization : '')?.[1];
      require(token && token.length <= 16384);
      const claims = record(await input.jwt.verify(token!));
      // Another login's token is never an operator's, even when its subject is in the registry.
      require(!target.otherPoolIds.some(pool => claims.iss === issuer(pool)) && !target.otherClientIds.includes(String(claims.aud)));
      const at = now();
      require(claims.iss === issuer(target.operatorPoolId) && claims.aud === target.operatorClientId && claims.token_use === 'id'
        && typeof claims.sub === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.sub)
        && [claims.exp, claims.iat, claims.auth_time].every(v => typeof v === 'number' && Number.isSafeInteger(v))
        && Number(claims.exp) * 1000 > at && Number(claims.iat) * 1000 <= at && Number(claims.auth_time) <= Number(claims.iat)
        && Number(claims.auth_time) * 1000 >= at - 15 * 60_000);
      const signal = AbortSignal.timeout(10_000);
      const pool = record((await input.cognito.send(new DescribeUserPoolCommand({ UserPoolId: target.operatorPoolId }), { abortSignal: signal })).UserPool);
      require(pool.Id === target.operatorPoolId && pool.Arn === `arn:aws:cognito-idp:us-east-2:${target.account}:userpool/${target.operatorPoolId}`
        && (pool.Status === undefined || pool.Status === 'Enabled') && pool.MfaConfiguration === 'ON');
      const user = await input.cognito.send(new AdminGetUserCommand({ UserPoolId: target.operatorPoolId, Username: String(claims.sub) }), { abortSignal: signal });
      require(Array.isArray(user.UserAttributes));
      const attributes = new Map<string, string>();
      for (const raw of user.UserAttributes as unknown[]) {
        const a = record(raw); require(typeof a.Name === 'string' && typeof a.Value === 'string' && !attributes.has(a.Name));
        attributes.set(String(a.Name), String(a.Value));
      }
      const factors = z.array(z.string()).parse(user.UserMFASettingList);
      const signedAt = Number(claims.auth_time) * 1000;
      require(user.Enabled === true && user.UserStatus === 'CONFIRMED' && factors.includes('SOFTWARE_TOKEN_MFA')
        && user.PreferredMfaSetting === 'SOFTWARE_TOKEN_MFA' && attributes.get('sub') === claims.sub
        && attributes.get('email_verified') === 'true' && !attributes.has('identities')
        && signedAt >= Math.ceil(time(user.UserLastModifiedDate) / 1000) * 1000
        && signedAt >= Math.ceil(time(pool.LastModifiedDate) / 1000) * 1000);
      return String(claims.sub).toLowerCase();
    } catch (error) {
      if (error instanceof PlatformOperatorSignInError) throw error;
      throw new PlatformOperatorSignInError('operator_refused');
    }
  };
}
