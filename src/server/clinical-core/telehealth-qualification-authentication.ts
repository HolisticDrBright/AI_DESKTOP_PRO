if (typeof window !== 'undefined') throw Error('telehealth authentication is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError, JwtInvalidClaimError, JwtInvalidSignatureError, JwtInvalidSignatureAlgorithmError,
  JwtParseError, JwtWithoutValidKidError, KidNotFoundInJwksError, ParameterValidationError } from 'aws-jwt-verify/error';
import { CognitoIdentityProviderClient, DescribeUserPoolCommand, DescribeUserPoolClientCommand,
  GetUserPoolMfaConfigCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const subject = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const pool = z.object({ poolId: z.string().regex(/^us-east-2_[A-Za-z0-9]+$/),
  clientId: z.string().regex(/^[a-z0-9]{1,128}$/),
  identities: z.array(z.object({ subject, personId: z.uuid() }).strict()).min(1).max(2) }).strict();
const targetSchema = z.object({ contract: z.literal('telehealth-qualification-authentication/1'),
  account: z.literal('588966314750'), region: z.literal('us-east-2'), phiAllowed: z.literal(false),
  activation: z.literal('blocked'), organizationId: z.uuid(), consumer: pool, workforce: pool }).strict().superRefine((c, ctx) => {
  const identities = [...c.consumer.identities, ...c.workforce.identities];
  if (c.consumer.poolId === c.workforce.poolId || c.consumer.clientId === c.workforce.clientId
    || new Set(identities.map(i => i.subject)).size !== identities.length
    || new Set(identities.map(i => i.personId)).size !== identities.length)
    ctx.addIssue({ code: 'custom', message: 'identity bindings must be distinct' });
});
export type TelehealthAuthenticationTarget = z.infer<typeof targetSchema>;
type Pool = 'consumer' | 'workforce';
type Headers = { headers?: Record<string, string | undefined> };
type Reader = { send(command: unknown, options: { abortSignal: AbortSignal }): Promise<unknown> };
type Verifier = { verify(token: string): Promise<unknown> };
export type TelehealthAuthenticatedIdentity = Readonly<{ identityPool: Pool; identitySubject: string;
  actorPersonId: string; organizationId: string; email: string; tokenSha256: string;
  authenticatedAt: number; tokenExpiresAt: number; observedAt: number }>;
export class TelehealthAuthenticationError extends Error {
  constructor(readonly category: 'reauth_required' | 'service_unavailable') {
    super(category); this.name = 'TelehealthAuthenticationError';
  }
}
const refuse = (): never => { throw new TelehealthAuthenticationError('reauth_required'); };
const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TelehealthAuthenticationError('service_unavailable');
  return raw as Record<string, unknown>;
};
const exactList = (raw: unknown, expected: string[]) => Array.isArray(raw) && raw.length === expected.length
  && new Set(raw).size === raw.length && raw.every(v => typeof v === 'string' && expected.includes(v));
const changedAt = (value: unknown) => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TelehealthAuthenticationError('service_unavailable');
  return Math.ceil(value.getTime() / 1000) * 1000;
};
const claimsSchema = z.object({ iss: z.string(), aud: z.string(), token_use: z.literal('id'), sub: subject,
  email: z.email().max(254), email_verified: z.literal(true),
  'custom:person_id': z.uuid(), 'custom:organization_id': z.uuid(), 'custom:production_bound': z.literal('true'),
  'custom:synthetic_attested': z.string().optional(),
  exp: z.number().int().positive(), iat: z.number().int().positive(), auth_time: z.number().int().positive() });

/** Bounded read only; a timed-out verifier cannot schedule subsequent Cognito
 * reads. No reader/verifier message, token or returned attribute is logged. */
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = () => reject(new TelehealthAuthenticationError('service_unavailable'));
    if (signal.aborted) { timeout(); return; }
    signal.addEventListener('abort', timeout, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', timeout);
      if (signal.aborted) timeout(); else resolve(value);
    }, error => { signal.removeEventListener('abort', timeout); reject(error); });
  });
}

/** Complete authentication prerequisite, not clinic/consent/write admission.
 * The future factory must bind its actual deployment, API, role, database and
 * resources independently, then perform per-action authority and settlement.
 * This source seam accepts fictional transports; native construction below
 * never accepts them from an event or environment. Nothing installs a route. */
export function createTelehealthQualificationAuthenticationSource(input: {
  target: unknown; cognito: Reader; jwt: Verifier; now?: () => number;
}) {
  const target = targetSchema.parse(structuredClone(input.target));
  const clock = input.now ?? Date.now;
  const receipts = new WeakSet<object>();
  const authenticate = async (event: Headers, identityPool: Pool): Promise<TelehealthAuthenticatedIdentity> => {
    const startedAt = clock();
    if (!Number.isFinite(startedAt) || !['consumer', 'workforce'].includes(identityPool)) refuse();
    const headers = Object.entries(event.headers ?? {}).filter(([key]) => key.toLowerCase() === 'authorization');
    if (headers.length !== 1 || typeof headers[0][1] !== 'string' || headers[0][1].length > 16_384) refuse();
    const token = headers[0][1]!.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1];
    if (!token) refuse();
    const signal = AbortSignal.timeout(10_000);
    let verified: unknown;
    try { verified = await bounded(input.jwt.verify(token!), signal); }
    catch (e) {
      if (e instanceof TelehealthAuthenticationError) throw e;
      if (e instanceof FetchError) throw new TelehealthAuthenticationError('service_unavailable');
      if (e instanceof JwtInvalidClaimError || e instanceof JwtInvalidSignatureError || e instanceof JwtInvalidSignatureAlgorithmError
        || e instanceof JwtParseError || e instanceof JwtWithoutValidKidError || e instanceof KidNotFoundInJwksError || e instanceof ParameterValidationError) refuse();
      throw new TelehealthAuthenticationError('service_unavailable');
    }
    const parsed = claimsSchema.safeParse(verified);
    if (!parsed.success) refuse();
    const claims = parsed.data!, configured = target[identityPool];
    const issuer = `https://cognito-idp.${target.region}.amazonaws.com/${configured.poolId}`;
    const designated = configured.identities.find(i => i.subject === claims.sub);
    const validateTime = () => {
      const current = clock();
      if (!Number.isFinite(current) || current < startedAt || claims.exp * 1000 <= current
        || claims.iat * 1000 > current || claims.auth_time * 1000 > current
        || claims.iat < claims.auth_time || claims.exp <= claims.iat || current - claims.auth_time * 1000 > 900_000) refuse();
      if (signal.aborted) throw new TelehealthAuthenticationError('service_unavailable');
      return current;
    };
    validateTime();
    if (claims.iss !== issuer || claims.aud !== configured.clientId || !designated
      || claims['custom:person_id'] !== designated.personId || claims['custom:organization_id'] !== target.organizationId
      || claims['custom:synthetic_attested'] === 'true') refuse();
    const read = async (command: unknown) => { validateTime();
      const answer = object(await bounded(input.cognito.send(command, { abortSignal: signal }), signal));
      validateTime(); return answer;
    };
    try {
      const userPool = object((await read(new DescribeUserPoolCommand({ UserPoolId: configured.poolId }))).UserPool);
      if (userPool.Id !== configured.poolId || userPool.Arn !== `arn:aws:cognito-idp:${target.region}:${target.account}:userpool/${configured.poolId}`
        || userPool.Status !== undefined && userPool.Status !== 'Enabled') throw new TelehealthAuthenticationError('service_unavailable');
      const client = object((await read(new DescribeUserPoolClientCommand({ UserPoolId: configured.poolId, ClientId: configured.clientId }))).UserPoolClient);
      if (client.UserPoolId !== configured.poolId || client.ClientId !== configured.clientId) throw new TelehealthAuthenticationError('service_unavailable');
      const user = await read(new AdminGetUserCommand({ UserPoolId: configured.poolId, Username: claims.sub }));
      if (user.Enabled !== true || user.UserStatus !== 'CONFIRMED') refuse();
      const attributes = new Map<string, string>();
      if (!Array.isArray(user.UserAttributes)) throw new TelehealthAuthenticationError('service_unavailable');
      for (const raw of user.UserAttributes) {
        const a = object(raw);
        if (typeof a.Name !== 'string' || typeof a.Value !== 'string' || attributes.has(a.Name)) throw new TelehealthAuthenticationError('service_unavailable');
        attributes.set(a.Name, a.Value);
      }
      for (const [name, value] of Object.entries({ sub: claims.sub, 'custom:person_id': designated!.personId,
        'custom:organization_id': target.organizationId, email: claims.email, email_verified: 'true', 'custom:production_bound': 'true' }))
        if (attributes.get(name) !== value) refuse();
      if (attributes.get('custom:synthetic_attested') === 'true' || attributes.has('identities')) refuse();
      const signedAt = claims.auth_time * 1000;
      if (signedAt < changedAt(user.UserLastModifiedDate)) refuse();
      if (identityPool === 'workforce') {
        const flows = client.ExplicitAuthFlows;
        if (userPool.MfaConfiguration !== 'ON' || userPool.DeviceConfiguration !== undefined
          || !exactList(client.SupportedIdentityProviders, ['COGNITO']) || !Array.isArray(flows)
          || flows.length === 0 || new Set(flows).size !== flows.length
          || !flows.some(f => ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH'].includes(f))
          || !flows.every(f => ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'].includes(f))
          || !exactList(user.UserMFASettingList, ['SOFTWARE_TOKEN_MFA']) || user.PreferredMfaSetting !== 'SOFTWARE_TOKEN_MFA') refuse();
        const policy = userPool.Policies === undefined ? undefined : object(userPool.Policies).SignInPolicy;
        if (policy !== undefined && !exactList(object(policy).AllowedFirstAuthFactors, ['PASSWORD'])) refuse();
        const mfa = await read(new GetUserPoolMfaConfigCommand({ UserPoolId: configured.poolId }));
        if (mfa.MfaConfiguration !== 'ON' || object(mfa.SoftwareTokenMfaConfiguration).Enabled !== true
          || mfa.SmsMfaConfiguration !== undefined || mfa.EmailMfaConfiguration !== undefined || mfa.WebAuthnConfiguration !== undefined) refuse();
        if (signedAt < changedAt(userPool.LastModifiedDate) || signedAt < changedAt(client.LastModifiedDate)) refuse();
      }
      const receipt = Object.freeze({ identityPool, identitySubject: claims.sub, actorPersonId: designated!.personId,
        organizationId: target.organizationId, email: claims.email, tokenSha256: createHash('sha256').update(token!).digest('hex'),
        authenticatedAt: signedAt, tokenExpiresAt: claims.exp * 1000, observedAt: validateTime() });
      receipts.add(receipt); return receipt;
    } catch (e) {
      if (e instanceof TelehealthAuthenticationError) throw e;
      throw new TelehealthAuthenticationError('service_unavailable');
    }
  };
  return Object.freeze({ authenticate, isObserved: (receipt: unknown): receipt is TelehealthAuthenticatedIdentity =>
    typeof receipt === 'object' && receipt !== null && receipts.has(receipt) });
}

/** Uses the real verifier and account/region-pinned Cognito client. The target
 * is a SERVER artifact, not proof of deployment or patient authority. */
export function createNativeTelehealthQualificationAuthentication(rawTarget: unknown) {
  const target = targetSchema.parse(structuredClone(rawTarget));
  const jwt = CognitoJwtVerifier.create([target.consumer, target.workforce].map(p => ({
    userPoolId: p.poolId, tokenUse: 'id' as const, clientId: p.clientId,
  })));
  const cognito = new CognitoIdentityProviderClient({ region: target.region, maxAttempts: 1 });
  return createTelehealthQualificationAuthenticationSource({ target, jwt, cognito });
}
