import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { GetCallerIdentityCommand, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { DescribeUserPoolCommand, DescribeUserPoolClientCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { createProgramMediaHostAuthority, programMediaScopedSessionPolicy, waitProgramMediaHost } from './program-media-host-authority';
import { programMediaHostTarget, PROGRAM_MEDIA_HOST_SCHEMA_SHA256 } from './program-media-host-target';
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';

const id = (n: number) => `73000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = id(1), clinic = id(2), program = id(3), subject = 'fictional_media_workforce';
const target = () => ({ contract: 'program-media-host-target/1', execution: 'qualification', account: '588966314750', region: 'us-east-2',
  phiAllowed: false, productionActivation: 'blocked', sourceCommit: 'a'.repeat(40), hostReviewSha256: 'a'.repeat(64), databaseName: 'clinical_core_qualification',
  clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional-media', secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-media-login',
  loginName: 'program_media_runtime', hostRoleArn: 'arn:aws:iam::588966314750:role/alp-media-host', storageRoleArn: 'arn:aws:iam::588966314750:role/alp-media-storage',
  poolId: 'us-east-2_fictionalMedia', clientId: 'fictionalmedia', origin: 'https://desktop.example.test', designatedWorkforce: [{ subject, personId: person, organizationId: clinic }],
  migrations: Object.entries(PROGRAM_MEDIA_HOST_SCHEMA_SHA256).map(([name, sha256], i) => ({
    version: '202610110000' + String(i).padStart(2, '0'), name: 'fictional_only_' + name.slice(0, -4), sha256 })),
  storage: { purpose: 'educational_media', phiAllowed: false, dedicated: true, bucket: 'alp-fictional-lessons', expectedBucketOwner: '588966314750', region: 'us-east-2',
    kmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/' + id(90), maxImageBytes: 16777216, maxVideoBytes: 268435456, publicOrigin: 'https://lessons.example.test/' },
  forbiddenBuckets: ['fictional-recordings'], forbiddenKmsKeyArns: ['arn:aws:kms:us-east-2:588966314750:key/' + id(91)],
  nativeEvidenceSha256: 'c'.repeat(64), multipartEvidenceSha256: 'd'.repeat(64),
  policyReview: { contract: 'program-media-multipart-resource-review/1', policySha256: 'e'.repeat(64), evidenceSha256: 'f'.repeat(64) } });
const controller = () => new AbortController();
const deferred = <T>() => { let resolve!: (v: T) => void; let reject!: (v: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const t = target(), at = Math.floor(Date.now() / 1000) - 10;
  const claims: Record<string, unknown> = { iss: `https://cognito-idp.us-east-2.amazonaws.com/${t.poolId}`, aud: t.clientId, token_use: 'id',
    sub: subject, exp: at + 3600, iat: at, auth_time: at, 'custom:person_id': person, 'custom:organization_id': clinic };
  const policyDate = new Date((at - 10) * 1000);
  const pool: Record<string, unknown> = { Id: t.poolId, Arn: `arn:aws:cognito-idp:us-east-2:588966314750:userpool/${t.poolId}`, MfaConfiguration: 'ON', LastModifiedDate: policyDate };
  const app: Record<string, unknown> = { UserPoolId: t.poolId, ClientId: t.clientId, LastModifiedDate: policyDate,
    SupportedIdentityProviders: ['COGNITO'], ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'] };
  const user: Record<string, unknown> = { Enabled: true, UserStatus: 'CONFIRMED', UserLastModifiedDate: policyDate,
    PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'], UserAttributes: [
      { Name: 'sub', Value: subject }, { Name: 'custom:person_id', Value: person }, { Name: 'custom:organization_id', Value: clinic }, { Name: 'email_verified', Value: 'true' }] };
  const caller: Record<string, unknown> = { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/alp-media-host/fictional-session' };
  const jwt = { verify: vi.fn(async () => claims) };
  const cognito = { send: vi.fn(async (command: unknown) => {
    if (command instanceof DescribeUserPoolCommand) return { UserPool: pool };
    if (command instanceof DescribeUserPoolClientCommand) return { UserPoolClient: app };
    if (command instanceof AdminGetUserCommand) { expect(command.input.Username).toBe(subject); return user; }
    throw new Error('unexpected fictional Cognito command');
  }) };
  const sts = { send: vi.fn(async (command: unknown) => {
    if (command instanceof GetCallerIdentityCommand) return caller;
    if (command instanceof AssumeRoleCommand) return { AssumedRoleUser: { Arn: `arn:aws:sts::588966314750:assumed-role/alp-media-storage/${command.input.RoleSessionName}` },
      Credentials: { AccessKeyId: 'ASIA' + 'A'.repeat(16), SecretAccessKey: 'x'.repeat(40), SessionToken: 'fictional-session-token', Expiration: new Date(Date.now() + 900000) } };
    throw new Error('unexpected fictional STS command');
  }) };
  let authorize = true;
  const database: ClinicalCoreDatabase = { transaction: vi.fn(async work => work({ query: vi.fn(async (sql: string) => {
    if (sql.includes('set_request_context')) return { rows: [], rowCount: 1 };
    if (sql.includes('program_media_request')) return { rows: [{ data: { contractVersion: 'program-media-native-ledger/1', ok: true, data: authorize } }], rowCount: 1 };
    throw new Error('unexpected fictional database statement');
  }) as never })) };
  const api = () => createProgramMediaHostAuthority({ target: t, database, clients: { sts, cognito }, jwt });
  return { t, claims, pool, app, user, caller, jwt, cognito, sts, database, api, setAuthorize: (v: boolean) => { authorize = v; } };
}
afterEach(() => vi.restoreAllMocks());
describe('native host current workforce authority, fictional SDK transport', () => {
  it('derives only a designated identity after independent signature/current mandatory-MFA reads', async () => {
    const f = fixture(), signal = controller().signal;
    expect(await f.api().resolveContext('a.b.c', signal)).toEqual({ actorPersonId: person, organizationId: clinic, identitySubject: subject,
      identityPool: 'workforce', purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false });
    expect(f.cognito.send).toHaveBeenCalledTimes(3); expect(f.database.transaction).not.toHaveBeenCalled();
    expect(f.sts.send.mock.calls.some(([c]) => c instanceof AssumeRoleCommand)).toBe(false);
  });
  it.each([
    ['signature failure', (f: ReturnType<typeof fixture>) => f.jwt.verify.mockRejectedValue(new Error('bad signature'))],
    ['another issuer', (f: ReturnType<typeof fixture>) => { f.claims.iss = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_other'; }],
    ['another audience', (f: ReturnType<typeof fixture>) => { f.claims.aud = 'other'; }],
    ['access rather than ID token', (f: ReturnType<typeof fixture>) => { f.claims.token_use = 'access'; }],
    ['expired token', (f: ReturnType<typeof fixture>) => { f.claims.exp = Math.floor(Date.now() / 1000) - 1; }],
    ['old authentication after refresh', (f: ReturnType<typeof fixture>) => { f.claims.auth_time = Math.floor(Date.now() / 1000) - 1000; }],
    ['future authentication', (f: ReturnType<typeof fixture>) => { f.claims.auth_time = Number(f.claims.iat) + 10; }],
    ['another subject', (f: ReturnType<typeof fixture>) => { f.claims.sub = 'fictional_other_person'; }],
    ['another person', (f: ReturnType<typeof fixture>) => { f.claims['custom:person_id'] = id(8); }],
    ['another clinic', (f: ReturnType<typeof fixture>) => { f.claims['custom:organization_id'] = id(9); }],
    ['optional MFA', (f: ReturnType<typeof fixture>) => { f.pool.MfaConfiguration = 'OPTIONAL'; }],
    ['remembered device', (f: ReturnType<typeof fixture>) => { f.pool.DeviceConfiguration = {}; }],
    ['federated flow', (f: ReturnType<typeof fixture>) => { f.app.SupportedIdentityProviders = ['Google']; }],
    ['custom flow', (f: ReturnType<typeof fixture>) => { f.app.ExplicitAuthFlows = ['ALLOW_CUSTOM_AUTH']; }],
    ['passwordless flow', (f: ReturnType<typeof fixture>) => { f.app.ExplicitAuthFlows = ['ALLOW_USER_AUTH']; }],
    ['duplicate flows', (f: ReturnType<typeof fixture>) => { f.app.ExplicitAuthFlows = ['ALLOW_USER_SRP_AUTH', 'ALLOW_USER_SRP_AUTH']; }],
    ['disabled user', (f: ReturnType<typeof fixture>) => { f.user.Enabled = false; }],
    ['unconfirmed user', (f: ReturnType<typeof fixture>) => { f.user.UserStatus = 'UNCONFIRMED'; }],
    ['no TOTP', (f: ReturnType<typeof fixture>) => { f.user.UserMFASettingList = []; }],
    ['other preferred factor', (f: ReturnType<typeof fixture>) => { f.user.PreferredMfaSetting = 'SMS_MFA'; }],
    ['pool policy newer than auth', (f: ReturnType<typeof fixture>) => { f.pool.LastModifiedDate = new Date(); }],
    ['client policy newer than auth', (f: ReturnType<typeof fixture>) => { f.app.LastModifiedDate = new Date(); }],
    ['user changed after auth', (f: ReturnType<typeof fixture>) => { f.user.UserLastModifiedDate = new Date(); }],
    ['missing policy date', (f: ReturnType<typeof fixture>) => { delete f.pool.LastModifiedDate; }],
    ['duplicate attribute', (f: ReturnType<typeof fixture>) => { (f.user.UserAttributes as unknown[]).push({ Name: 'sub', Value: subject }); }],
    ['identity provider attribute', (f: ReturnType<typeof fixture>) => { (f.user.UserAttributes as unknown[]).push({ Name: 'identities', Value: '[]' }); }],
  ])('refuses %s before SQL or role issuance', async (_name, change) => {
    const f = fixture(); change(f);
    await expect(f.api().resolveContext('a.b.c', controller().signal)).rejects.toThrow('access_refused');
    expect(f.database.transaction).not.toHaveBeenCalled(); expect(f.sts.send.mock.calls.some(([c]) => c instanceof AssumeRoleCommand)).toBe(false);
  });
  it.each(['arn:aws:sts::173535830222:assumed-role/alp-media-host/session', 'arn:aws:iam::588966314750:root',
    'arn:aws:sts::588966314750:assumed-role/AdministratorAccess/session', 'arn:aws:sts::588966314750:assumed-role/alp-media-host-other/session'])('refuses managed principal %s', async arn => {
    const f = fixture(); f.caller.Arn = arn;
    await expect(f.api().resolveContext('a.b.c', controller().signal)).rejects.toThrow('storage_unverified'); expect(f.cognito.send).not.toHaveBeenCalled();
  });
  it('reauthorizes the SQL program before issuing a narrow fifteen-minute session', async () => {
    const f = fixture(), api = f.api(), signal = controller().signal, context = await api.resolveContext('a.b.c', signal);
    const c = await api.credentialsForProgram('a.b.c', context, { clinic, programId: program }, signal);
    expect(c.scope).toEqual({ clinic, programId: program }); expect(c.expectedRoleArn).toBe(f.t.storageRoleArn);
    expect(f.database.transaction).toHaveBeenCalledTimes(2);
    const command = f.sts.send.mock.calls.map(([c]) => c).find(c => c instanceof AssumeRoleCommand) as AssumeRoleCommand;
    expect(command.input).toMatchObject({ RoleArn: f.t.storageRoleArn, DurationSeconds: 900, ExternalId: f.t.hostReviewSha256, SourceIdentity: person });
    const doc = JSON.parse(command.input.Policy!); expect(Buffer.byteLength(command.input.Policy!)).toBeLessThanOrEqual(2048);
    expect(doc.Statement[2].Resource).toBe(`arn:aws:s3:::${f.t.storage.bucket}/program-media/${clinic}/${program}/*`);
    expect(doc.Statement[3].Condition.StringLike['kms:EncryptionContext:aws:s3:arn']).toBe(doc.Statement[2].Resource);
    expect(doc.Statement.flatMap((s: { Action: string | string[] }) => s.Action)).not.toContain('s3:DeleteObject');
  });
  it('denies a program or changed admitted identity without sending AssumeRole', async () => {
    const f = fixture(), api = f.api(), signal = controller().signal, context = await api.resolveContext('a.b.c', signal);
    f.setAuthorize(false);
    await expect(api.credentialsForProgram('a.b.c', context, { clinic, programId: program }, signal)).rejects.toThrow('access_refused');
    await expect(api.credentialsForProgram('a.b.c', { ...context, actorPersonId: id(8) }, { clinic, programId: program }, signal)).rejects.toThrow('access_refused');
    await expect(api.credentialsForProgram('a.b.c', context, { clinic: id(8), programId: program }, signal)).rejects.toThrow('access_refused');
    expect(f.sts.send.mock.calls.some(([c]) => c instanceof AssumeRoleCommand)).toBe(false);
  });
  it('discards credentials when MFA policy changes during role issuance', async () => {
    const f = fixture(), api = f.api(), signal = controller().signal, context = await api.resolveContext('a.b.c', signal);
    const original = f.sts.send.getMockImplementation()!;
    f.sts.send.mockImplementation(async c => { const result = await original(c); if (c instanceof AssumeRoleCommand) f.user.Enabled = false; return result; });
    await expect(api.credentialsForProgram('a.b.c', context, { clinic, programId: program }, signal)).rejects.toThrow('access_refused');
  });
  it('discards credentials when program authority is withdrawn during role issuance', async () => {
    const f = fixture(), api = f.api(), signal = controller().signal, context = await api.resolveContext('a.b.c', signal);
    const original = f.sts.send.getMockImplementation()!;
    f.sts.send.mockImplementation(async c => { const result = await original(c); if (c instanceof AssumeRoleCommand) f.setAuthorize(false); return result; });
    await expect(api.credentialsForProgram('a.b.c', context, { clinic, programId: program }, signal)).rejects.toThrow('access_refused');
  });
  it('observes late rejections after withdrawal from ignored authentication waits', async () => {
    const f = fixture(), slow = deferred<Record<string, unknown>>(), abort = controller(); f.jwt.verify.mockImplementation(() => slow.promise);
    const work = f.api().resolveContext('a.b.c', abort.signal), check = expect(work).rejects.toThrow('access_refused'); abort.abort(); await check;
    slow.reject(new Error('fictional late rejection')); await Promise.resolve(); expect(f.cognito.send).not.toHaveBeenCalled();
  });
  it('uses the actual Cognito cryptographic verifier with a locally cached fictional JWKS', async () => {
    const f = fixture(), pair = generateKeyPairSync('rsa', { modulusLength: 2048 }), exported = pair.publicKey.export({ format: 'jwk' });
    if (typeof exported.n !== 'string' || typeof exported.e !== 'string') throw new Error('fictional RSA key incomplete');
    const jwk = { kty: 'RSA', n: exported.n, e: exported.e, kid: 'fictional-kid', alg: 'RS256', use: 'sig' };
    const verifier = CognitoJwtVerifier.create({ userPoolId: f.t.poolId, tokenUse: 'id', clientId: f.t.clientId }); verifier.cacheJwks({ keys: [jwk] });
    const encoded = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url'), body = encoded({ alg: 'RS256', kid: jwk.kid }) + '.' + encoded(f.claims);
    const token = body + '.' + sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url');
    const api = createProgramMediaHostAuthority({ target: f.t, database: f.database, clients: { sts: f.sts, cognito: f.cognito }, jwt: verifier });
    expect((await api.resolveContext(token, controller().signal)).actorPersonId).toBe(person);
    const bad = token.slice(0, token.lastIndexOf('.') + 1) + Buffer.alloc(256).toString('base64url');
    await expect(api.resolveContext(bad, controller().signal)).rejects.toThrow('access_refused');
  });
});
describe('reviewed target and cancellation bounds', () => {
  it.each(['phiAllowed', 'productionActivation', 'databaseName', 'account', 'execution'])('refuses changed %s', key => {
    expect(programMediaHostTarget.safeParse({ ...target(), [key]: 'wrong' }).success).toBe(false);
  });
  it('refuses duplicate identities, unsorted/duplicate migrations, shared roles and storage', () => {
    const t = target(); expect(programMediaHostTarget.safeParse({ ...t, designatedWorkforce: [...t.designatedWorkforce, ...t.designatedWorkforce] }).success).toBe(false);
    expect(programMediaHostTarget.safeParse({ ...t, migrations: [...t.migrations, ...t.migrations] }).success).toBe(false);
    expect(programMediaHostTarget.safeParse({ ...t, hostRoleArn: t.storageRoleArn }).success).toBe(false);
    expect(programMediaHostTarget.safeParse({ ...t, forbiddenBuckets: [t.storage.bucket] }).success).toBe(false);
    for (const missing of t.migrations) expect(programMediaHostTarget.safeParse({ ...t,
      migrations: t.migrations.filter(m => m.sha256 !== missing.sha256) }).success).toBe(false);
  });
  it('captures review and client methods before a caller changes the input', async () => {
    const f = fixture(), api = f.api(); f.t.designatedWorkforce[0].personId = id(8); f.cognito.send = vi.fn(async () => { throw Error('changed'); });
    expect((await api.resolveContext('a.b.c', controller().signal)).actorPersonId).toBe(person);
    expect(programMediaScopedSessionPolicy(programMediaHostTarget.parse(target()), { clinic, programId: program })).not.toContain(id(8));
  });
  it('does not emit a late value after an already-aborted wait', async () => {
    const abort = controller(); abort.abort(); await expect(waitProgramMediaHost(Promise.resolve('secret'), abort.signal)).rejects.toThrow('access_refused');
  });
});
