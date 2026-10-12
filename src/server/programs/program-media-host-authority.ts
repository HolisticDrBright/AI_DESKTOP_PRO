if (typeof window !== 'undefined') throw new Error('program media host authority is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { CognitoIdentityProviderClient, DescribeUserPoolCommand, DescribeUserPoolClientCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';
import { programMediaHostTarget, type ProgramMediaHostTarget } from './program-media-host-target';
import { createProgramMediaNativeLedger } from './program-media-native-ledger';
import { ProgramMediaError } from './program-media-authoring';
import type { AwsProgramMediaStoreConfiguration } from './aws-program-media-store';

type Commands = { send(command: unknown, options?: { abortSignal: AbortSignal }): Promise<Record<string, unknown>> };
type Clients = { sts: Commands; cognito: Commands };
const object = (v: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(v);
const check = (v: unknown, code: 'access_refused' | 'storage_unverified' = 'access_refused') => {
  if (!v) throw new ProgramMediaError(code);
};
const identity = (c: ClinicalRequestContext) => JSON.stringify([c.actorPersonId, c.organizationId, c.identitySubject]);
const date = (v: unknown): number => { check(v instanceof Date && Number.isFinite(v.getTime())); return (v as Date).getTime(); };

/** Withdrawal is honored even if a provider ignores cancellation. Late promise
 * rejections stay observed; no provider response certifies a cancelled request. */
export async function waitProgramMediaHost<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const live = () => { if (signal.aborted) throw new ProgramMediaError('access_refused'); };
  const observed = work.then(v => { live(); return v; });
  if (signal.aborted) { void observed.catch(() => undefined); live(); }
  let stop: (() => void) | undefined;
  try { return await Promise.race([observed, new Promise<never>((_resolve, reject) => {
    stop = () => reject(new ProgramMediaError('access_refused'));
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
  })]); } finally { if (stop) signal.removeEventListener('abort', stop); }
}

/** A session policy can only reduce the reviewed storage role's permissions.
 * The bucket-level multipart listing has no prefix IAM condition: provider
 * source code must keep its independently checked exact-prefix output fence.
 * Object and KMS grants are restricted to THIS program, not the whole bucket. */
export function programMediaScopedSessionPolicy(t: ProgramMediaHostTarget, scope: { clinic: string; programId: string }): string {
  const q = z.object({ clinic: z.string().uuid(), programId: z.string().uuid() }).strict().parse(scope);
  const bucket = `arn:aws:s3:::${t.storage.bucket}`, prefix = `program-media/${q.clinic}/${q.programId}/`, objects = `${bucket}/${prefix}*`;
  const policy = JSON.stringify({ Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: ['s3:GetBucketVersioning', 's3:GetEncryptionConfiguration', 's3:GetBucketPublicAccessBlock',
      's3:GetBucketOwnershipControls', 's3:GetBucketTagging', 's3:GetBucketPolicy', 's3:ListBucketMultipartUploads'], Resource: bucket },
    { Effect: 'Allow', Action: 's3:ListBucketVersions', Resource: bucket, Condition: { StringLike: { 's3:prefix': `${prefix}*` } } },
    { Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion', 's3:DeleteObjectVersion',
      's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'], Resource: objects },
    { Effect: 'Allow', Action: ['kms:Decrypt', 'kms:GenerateDataKey'], Resource: t.storage.kmsKeyArn,
      Condition: { StringEquals: { 'kms:ViaService': 's3.us-east-2.amazonaws.com' },
        StringLike: { 'kms:EncryptionContext:aws:s3:arn': objects } } },
  ] });
  check(Buffer.byteLength(policy, 'utf8') <= 2048, 'storage_unverified'); return policy;
}

/** Actual JWT verification + current Cognito policy/user reads, then restricted
 * SQL program authority, then actual STS AssumeRole. Nothing is inferred from
 * browser identity fields, remembered MFA registration, environment booleans,
 * a previous positive permission or a previously issued credential. Tests may
 * substitute fictional command transports; the native host supplies real SDK
 * clients with one captured managed-host credential identity. */
export function createProgramMediaHostAuthority(input: { target: unknown; database: ClinicalCoreDatabase;
  clients: Clients; jwt?: { verify(token: string): Promise<unknown> } }) {
  const t = programMediaHostTarget.parse(structuredClone(input.target));
  const database: ClinicalCoreDatabase = { transaction: input.database.transaction.bind(input.database) };
  const sendSts = input.clients.sts.send.bind(input.clients.sts), sendCognito = input.clients.cognito.send.bind(input.clients.cognito);
  const verifier = input.jwt ?? CognitoJwtVerifier.create({ userPoolId: t.poolId, tokenUse: 'id', clientId: t.clientId });
  const verify = verifier.verify.bind(verifier);
  const ledger = createProgramMediaNativeLedger(database, { evidenceSha256: t.nativeEvidenceSha256, storage: t.storage });
  const roleName = (arn: string) => arn.split('/').at(-1)!;
  const caller = async (signal: AbortSignal) => {
    const seen = await waitProgramMediaHost(sendSts(new GetCallerIdentityCommand({}), { abortSignal: signal }), signal);
    check(seen.Account === t.account && typeof seen.Arn === 'string'
      && new RegExp(`^arn:aws:sts::588966314750:assumed-role/${roleName(t.hostRoleArn).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[A-Za-z0-9_+=,.@-]{2,64}$`).test(seen.Arn), 'storage_unverified');
  };
  async function resolveContext(token: string, signal: AbortSignal): Promise<ClinicalRequestContext> {
    try {
      check(typeof token === 'string' && token.length <= 16384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));
      const claims = object(await waitProgramMediaHost(verify(token), signal)), now = Date.now();
      check(claims.iss === `https://cognito-idp.us-east-2.amazonaws.com/${t.poolId}` && claims.aud === t.clientId && claims.token_use === 'id'
        && [claims.exp, claims.iat, claims.auth_time].every(v => typeof v === 'number' && Number.isSafeInteger(v))
        && Number(claims.exp) * 1000 > now && Number(claims.iat) <= now / 1000 && Number(claims.auth_time) <= Number(claims.iat)
        && Number(claims.auth_time) * 1000 >= now - 15 * 60000);
      const designated = t.designatedWorkforce.find(p => p.subject === claims.sub);
      check(designated && claims['custom:person_id'] === designated.personId && claims['custom:organization_id'] === designated.organizationId);
      await caller(signal);
      const send = (command: unknown) => waitProgramMediaHost(sendCognito(command, { abortSignal: signal }), signal);
      const pool = object((await send(new DescribeUserPoolCommand({ UserPoolId: t.poolId }))).UserPool);
      const app = object((await send(new DescribeUserPoolClientCommand({ UserPoolId: t.poolId, ClientId: t.clientId }))).UserPoolClient);
      const user = await send(new AdminGetUserCommand({ UserPoolId: t.poolId, Username: String(claims.sub) }));
      const attributes = new Map<string, string>();
      check(Array.isArray(user.UserAttributes));
      for (const raw of user.UserAttributes as unknown[]) { const a = object(raw); check(typeof a.Name === 'string' && typeof a.Value === 'string'
        && !attributes.has(a.Name)); attributes.set(String(a.Name), String(a.Value)); }
      const flows = z.array(z.string()).parse(app.ExplicitAuthFlows), factors = z.array(z.string()).parse(user.UserMFASettingList);
      const signedAt = Number(claims.auth_time) * 1000;
      check(pool.Id === t.poolId && pool.Arn === `arn:aws:cognito-idp:us-east-2:588966314750:userpool/${t.poolId}`
        && (pool.Status === undefined || pool.Status === 'Enabled') && pool.MfaConfiguration === 'ON' && pool.DeviceConfiguration === undefined
        && app.UserPoolId === t.poolId && app.ClientId === t.clientId && JSON.stringify(app.SupportedIdentityProviders) === '["COGNITO"]'
        && !attributes.has('identities') && flows.length > 0 && new Set(flows).size === flows.length
        && flows.some(f => ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH'].includes(f))
        && flows.every(f => ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'].includes(f))
        && user.Enabled === true && user.UserStatus === 'CONFIRMED' && factors.includes('SOFTWARE_TOKEN_MFA') && user.PreferredMfaSetting === 'SOFTWARE_TOKEN_MFA'
        && attributes.get('sub') === designated!.subject && attributes.get('custom:person_id') === designated!.personId
        && attributes.get('custom:organization_id') === designated!.organizationId && attributes.get('email_verified') === 'true'
        && signedAt >= Math.ceil(date(pool.LastModifiedDate) / 1000) * 1000
        && signedAt >= Math.ceil(date(app.LastModifiedDate) / 1000) * 1000
        && signedAt >= Math.ceil(date(user.UserLastModifiedDate) / 1000) * 1000);
      check(Number(claims.exp) * 1000 > Date.now() && signedAt >= Date.now() - 15 * 60000);
      return Object.freeze({ actorPersonId: designated!.personId, organizationId: designated!.organizationId, identitySubject: designated!.subject,
        identityPool: 'workforce', purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false });
    } catch (error) { if (error instanceof ProgramMediaError) throw error; throw new ProgramMediaError('access_refused'); }
  }
  return Object.freeze({ resolveContext, async credentialsForProgram(token: string, admitted: ClinicalRequestContext,
    value: { clinic: string; programId: string }, signal: AbortSignal): Promise<AwsProgramMediaStoreConfiguration> {
    try {
      const scope = Object.freeze(z.object({ clinic: z.string().uuid(), programId: z.string().uuid() }).strict().parse(value));
      const current = await resolveContext(token, signal);
      check(identity(current) === identity(admitted) && scope.clinic === current.organizationId);
      check(await waitProgramMediaHost(ledger.authorize(current, scope.programId), signal));
      const policy = programMediaScopedSessionPolicy(t, scope), session = `alp-media-${createHash('sha256').update(identity(current) + scope.programId).digest('hex').slice(0, 32)}`;
      const started = Date.now();
      const out = await waitProgramMediaHost(sendSts(new AssumeRoleCommand({ RoleArn: t.storageRoleArn, RoleSessionName: session,
        DurationSeconds: 900, ExternalId: t.hostReviewSha256, SourceIdentity: current.actorPersonId, Policy: policy }), { abortSignal: signal }), signal);
      const creds = object(out.Credentials), who = object(out.AssumedRoleUser), expiry = date(creds.Expiration);
      check(who.Arn === `arn:aws:sts::588966314750:assumed-role/${roleName(t.storageRoleArn)}/${session}`
        && expiry > Date.now() + 10 * 60000 && expiry <= started + 16 * 60000
        && typeof creds.AccessKeyId === 'string' && /^ASIA[A-Z0-9]{16}$/.test(creds.AccessKeyId)
        && typeof creds.SecretAccessKey === 'string' && creds.SecretAccessKey.length >= 40 && creds.SecretAccessKey.length <= 128
        && typeof creds.SessionToken === 'string' && creds.SessionToken.length >= 10 && creds.SessionToken.length <= 3000, 'storage_unverified');
      // Issuance is not continuing authority. Discard the private credentials
      // if identity OR the SQL program permission changed while STS waited.
      const settled = await resolveContext(token, signal);
      check(identity(settled) === identity(current));
      check(await waitProgramMediaHost(ledger.authorize(settled, scope.programId), signal));
      return { storage: structuredClone(t.storage), scope: { ...scope }, expectedRoleArn: t.storageRoleArn,
        credentials: { accessKeyId: String(creds.AccessKeyId), secretAccessKey: String(creds.SecretAccessKey), sessionToken: String(creds.SessionToken), expiration: new Date(expiry) },
        forbiddenBuckets: [...t.forbiddenBuckets], forbiddenKmsKeyArns: [...t.forbiddenKmsKeyArns] };
    } catch (error) { if (error instanceof ProgramMediaError) throw error; throw new ProgramMediaError('storage_unverified'); }
  } });
}

/** Managed-host bootstrap only. First resolve and capture its credentials, then
 * construct ALL clients from that same copy. A wrong/admin principal is refused
 * by the authority before Cognito or database use, never a fallback identity. */
export async function openNativeProgramMediaHostClients(signal: AbortSignal) {
  if (signal.aborted) throw new ProgramMediaError('access_refused');
  const bootstrap = new STSClient({ region: 'us-east-2', endpoint: 'https://sts.us-east-2.amazonaws.com', maxAttempts: 1 });
  try {
    const credentials = await waitProgramMediaHost(bootstrap.config.credentials(), signal);
    check(credentials.expiration instanceof Date && credentials.expiration.getTime() > Date.now() + 60000
      && /^ASIA[A-Z0-9]{16}$/.test(credentials.accessKeyId)
      && typeof credentials.secretAccessKey === 'string' && credentials.secretAccessKey.length >= 40 && credentials.secretAccessKey.length <= 128
      && typeof credentials.sessionToken === 'string' && credentials.sessionToken.length >= 10 && credentials.sessionToken.length <= 16384, 'storage_unverified');
    const captured = { ...credentials, expiration: new Date(credentials.expiration!.getTime()) };
    const credential = async () => ({ ...captured, expiration: new Date(captured.expiration.getTime()) });
    const options = { region: 'us-east-2', credentials: credential, maxAttempts: 1 };
    const sts = new STSClient({ ...options, endpoint: 'https://sts.us-east-2.amazonaws.com' });
    try {
      const cognito = new CognitoIdentityProviderClient({ ...options, endpoint: 'https://cognito-idp.us-east-2.amazonaws.com' });
      let closed = false;
      return { sts, cognito, credential, close: () => { if (!closed) { closed = true; sts.destroy(); cognito.destroy(); } } };
    } catch (error) { sts.destroy(); throw error; }
  } finally { bootstrap.destroy(); }
}
