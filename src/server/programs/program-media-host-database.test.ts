import { beforeAll, beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { S3Client } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { DescribeUserPoolCommand, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from '@/server/clinical-core/database';
import { guardProgramMediaHostDatabase, PROGRAM_MEDIA_HOST_PRIVILEGES_SQL } from './program-media-host-database';
import { PROGRAM_MEDIA_HOST_SCHEMA_SHA256, programMediaHostTarget } from './program-media-host-target';
import { createProgramMediaHostAuthority } from './program-media-host-authority';
import { createProgramMediaHostHandlers } from './program-media-host';

const sha = (s: string) => createHash('sha256').update(s.replaceAll('\r\n', '\n')).digest('hex');
const id = (n: number) => `74000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let db: PGlite;
let migrations: { version: string; name: string; sha256: string }[];
const target = () => ({ contract: 'program-media-host-target/1', execution: 'qualification', account: '588966314750', region: 'us-east-2',
  phiAllowed: false, productionActivation: 'blocked', sourceCommit: 'a'.repeat(40), hostReviewSha256: 'a'.repeat(64), databaseName: 'clinical_core_qualification',
  clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional-media', secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-media-login',
  loginName: 'program_media_runtime', hostRoleArn: 'arn:aws:iam::588966314750:role/alp-media-host', storageRoleArn: 'arn:aws:iam::588966314750:role/alp-media-storage',
  poolId: 'us-east-2_fictionalMedia', clientId: 'fictionalmedia', origin: 'https://desktop.example.test',
  designatedWorkforce: [{ subject: 'fictional_media_workforce', personId: id(1), organizationId: id(2) }], migrations,
  storage: { purpose: 'educational_media', phiAllowed: false, dedicated: true, bucket: 'alp-fictional-lessons', expectedBucketOwner: '588966314750', region: 'us-east-2',
    kmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/' + id(90), maxImageBytes: 16777216, maxVideoBytes: 268435456, publicOrigin: 'https://lessons.example.test/' },
  forbiddenBuckets: ['fictional-recordings'], forbiddenKmsKeyArns: ['arn:aws:kms:us-east-2:588966314750:key/' + id(91)],
  nativeEvidenceSha256: 'c'.repeat(64), multipartEvidenceSha256: 'd'.repeat(64),
  policyReview: { contract: 'program-media-multipart-resource-review/1', policySha256: 'e'.repeat(64), evidenceSha256: 'f'.repeat(64) } });
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: { file: string; version: string }[] };
  // Exact historical qualification fixture plus pinned BLOCKED source parents.
  // This is an embedded preserving-role test, not a hosted credential proof.
  for (const m of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + m.file, 'utf8'));
  await db.exec(`create table clinical_core.schema_migrations(version text primary key,name text not null,sha256 text not null,applied_at timestamptz not null default clock_timestamp())`);
  migrations = manifest.migrations.map(m => ({ version: m.version, name: m.file.slice(15, -4), sha256: sha(readFileSync('infra/aws-clinical-core/migrations/' + m.file, 'utf8')) }));
  for (const m of migrations) await db.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [m.version, m.name, m.sha256]);
  for (const [file, expected] of [
    ['program-media-ledger.sql', '6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d'],
    ['program-media-settlement.sql', '74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04'],
    ['program-media-native-ledger.sql', '69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7'],
    ['program-media-multipart.sql', 'a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092'],
  ]) { const sql = readFileSync('infra/aws-clinical-core/source-candidates/' + file, 'utf8'); expect(sha(sql)).toBe(expected); await db.exec(sql); }
  await db.exec(readFileSync('infra/aws-clinical-core/source-candidates/program-media-host-authority.sql', 'utf8'));
  // Explicit fictional ledger identities for BLOCKED candidates in this one
  // embedded fixture. No real registration/version or approval is claimed.
  for (const [i, [file, sha256]] of Object.entries(PROGRAM_MEDIA_HOST_SCHEMA_SHA256).entries()) {
    expect(sha(readFileSync('infra/aws-clinical-core/source-candidates/' + file, 'utf8'))).toBe(sha256);
    const entry = { version: '202610110000' + String(i).padStart(2, '0'), name: 'fictional_only_' + file.slice(0, -4), sha256 };
    migrations.push(entry); await db.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
  // Fictional operator setup only; the candidate itself seeds NOLOGIN.
  await db.exec('alter role program_media_runtime login');
}, 120000);
afterAll(async () => { await db?.close(); });
afterEach(() => { vi.restoreAllMocks(); });
// PGlite does not restore the original backend identity with RESET SESSION
// AUTHORIZATION. Explicit operator restoration is test setup, never host code.
beforeEach(async () => { await db.exec('reset role; set session authorization postgres'); });
function raw(login = 'program_media_runtime'): ClinicalCoreDatabase {
  return { transaction: async work => {
    await db.exec('set session authorization ' + login);
    try { return await db.transaction(async tx => {
      await tx.exec('set local role program_media_worker');
      const query: ClinicalCoreTransaction['query'] = (sql, args = []) => tx.query(sql, args.map(a => a && typeof a === 'object' && 'kind' in a && 'value' in a ? a.value : a));
      return work({ query });
    }); } finally { await db.exec('reset role; set session authorization postgres'); }
  } };
}
async function good() {
  // PGlite uses one embedded database named postgres; pinning checks must still
  // refuse it. Replace ONLY its observed name in this explicit fictional test
  // adapter. Every role, grant, ledger and mutation is real embedded SQL.
  const base = raw();
  return guardProgramMediaHostDatabase({ transaction: work => base.transaction(tx => work({ query: async <Row extends Record<string, unknown>>(sql: string, args?: readonly unknown[]) => {
    const result = await tx.query<Row>(sql, args);
    if (sql.includes("'database',current_database()")) {
      const row = result.rows[0] as unknown as { proof: { database: string } }; row.proof.database = 'clinical_core_qualification';
    }
    return result;
  } })) }, target());
}
it('candidate creates no active login, no password, no seeded reviews and no registration', () => {
  const sql = readFileSync('infra/aws-clinical-core/source-candidates/program-media-host-authority.sql', 'utf8');
  expect(sql).toContain('program_media_runtime nologin noinherit'); expect(sql.replace(/^--.*$/gm, '')).not.toMatch(/\b(password|insert|update)\b/i);
});
it('refuses the wrong physical database name, even with the right restricted roles', async () => {
  let entered = false;
  await expect(guardProgramMediaHostDatabase(raw(), target()).transaction(async () => { entered = true; })).rejects.toThrow('storage_unverified'); expect(entered).toBe(false);
});
it('pins the callable worker inventory, including ordinary SQL signatures', async () => {
  const seen = await raw().transaction(tx => tx.query<{ proof: { workerFunctions: unknown; loginFunctions: unknown; sequences: unknown } }>(PROGRAM_MEDIA_HOST_PRIVILEGES_SQL));
  expect(seen.rows[0].proof.workerFunctions).toEqual([
    'clinical_core.program_media_host_ledger()', 'clinical_core.program_media_multipart_request(jsonb)',
    'clinical_core.program_media_request(jsonb)', 'clinical_private.consumer_collection_scope(text)',
    'clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)',
  ]);
  expect(seen.rows[0].proof.loginFunctions).toEqual([]); expect(seen.rows[0].proof.sequences).toEqual([]);
});
it('admits a real restricted embedded session only when roles and the complete ledger agree', async () => {
  const guarded = await good(); expect(await guarded.transaction(async tx => (await tx.query('select current_user as role,session_user as login')).rows))
    .toEqual([{ role: 'program_media_worker', login: 'program_media_runtime' }]);
  await expect(guarded.transaction(tx => tx.query('select * from clinical_core.persons'))).rejects.toThrow(/permission denied/);
  await expect(guarded.transaction(tx => tx.query('select applied_at from clinical_core.schema_migrations'))).rejects.toThrow(/permission denied/);
  await expect(guarded.transaction(tx => tx.query('set role program_media_authority'))).rejects.toThrow(/permission denied/);
  await expect(guarded.transaction(tx => tx.query('set role clinical_core_api'))).rejects.toThrow(/permission denied/);
});
it('exposes only ledger identity metadata and refuses direct table writes or API access to it', async () => {
  const guarded = await good(); const seen = await guarded.transaction(tx => tx.query<{ ledger: unknown }>('select clinical_core.program_media_host_ledger() as ledger'));
  expect(seen.rows).toEqual([{ ledger: migrations }]); expect(Object.keys((seen.rows[0].ledger as object[])[0]).sort()).toEqual(['name', 'sha256', 'version']);
  await expect(guarded.transaction(tx => tx.query("update clinical_core.schema_migrations set name='forged'"))).rejects.toThrow(/permission denied/);
  await expect(db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.exec('select clinical_core.program_media_host_ledger()'); })).rejects.toThrow(/permission denied/);
});
it('refuses an administrative SESSION login that merely SET ROLE to the worker', async () => {
  const direct: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => {
    await tx.exec('set local role program_media_worker'); return work({ query: async <Row extends Record<string, unknown>>(s: string, a?: readonly unknown[]) => tx.query<Row>(s, [...(a ?? [])]) });
  }) };
  let entered = false; await expect(guardProgramMediaHostDatabase(direct, target()).transaction(async () => { entered = true; })).rejects.toThrow('storage_unverified'); expect(entered).toBe(false);
});
it.each(['superuser', 'bypassrls', 'inherit', 'createrole'])('refuses a restricted login changed to %s', async privilege => {
  await db.exec(`alter role program_media_runtime ${privilege}`);
  try { await expect((await good()).transaction(async () => 'must not enter')).rejects.toThrow('storage_unverified'); }
  finally { await db.exec(`alter role program_media_runtime no${privilege}`); }
});
it('refuses any extra reachable role, column grant, public grant or schema CREATE', async () => {
  for (const [grant, revoke] of [
    ['grant clinical_core_api to program_media_runtime', 'revoke clinical_core_api from program_media_runtime'],
    ['grant select(id) on clinical_core.persons to program_media_worker', 'revoke select(id) on clinical_core.persons from program_media_worker'],
    ['grant select(id) on clinical_core.persons to public', 'revoke select(id) on clinical_core.persons from public'],
    ['grant create on schema public to program_media_runtime', 'revoke create on schema public from program_media_runtime'],
  ]) { await db.exec(grant); try { await expect((await good()).transaction(async () => 'must not enter')).rejects.toThrow('storage_unverified'); }
    finally { await db.exec(revoke); } }
});
it.each(['worker grant', 'public grant'])('refuses an extra SECURITY DEFINER capability through %s before any media work', async audience => {
  await db.exec(`create function public.fictional_media_bypass() returns boolean language sql security definer set search_path='' as $$ select true $$;
    revoke all on function public.fictional_media_bypass() from public;
    grant execute on function public.fictional_media_bypass() to ${audience === 'worker grant' ? 'program_media_worker' : 'public'}`);
  try {
    let entered = false;
    await expect((await good()).transaction(async tx => { entered = true; await tx.query('select public.fictional_media_bypass()'); }))
      .rejects.toThrow('storage_unverified');
    expect(entered).toBe(false);
  } finally { await db.exec('drop function public.fictional_media_bypass()'); }
});
it('refuses a private sequence grant as well as raw table grants', async () => {
  await db.exec('create sequence public.fictional_media_sequence; grant usage on sequence public.fictional_media_sequence to program_media_worker');
  try { await expect((await good()).transaction(async () => 'must not enter')).rejects.toThrow('storage_unverified'); }
  finally { await db.exec('drop sequence public.fictional_media_sequence'); }
});
it('refuses missing, modified, extra and reordered expected migration entries', async () => {
  const t = target();
  for (const list of [migrations.slice(1), migrations.map((m, i) => i === 0 ? { ...m, sha256: 'f'.repeat(64) } : m),
    [...migrations, { version: '20990101000000', name: 'fictional_extra', sha256: 'f'.repeat(64) }]]) {
    let entered = false;
    // Use real roles and explicit PGlite name adapter as above, but changed expectation.
    const goodDb = await good();
    await expect(guardProgramMediaHostDatabase(goodDb, { ...t, migrations: list }).transaction(async () => { entered = true; })).rejects.toThrow('storage_unverified');
    expect(entered).toBe(false);
  }
  expect(() => guardProgramMediaHostDatabase(raw(), { ...t, migrations: [...migrations].reverse() })).toThrow();
});

/** Combined route + real cryptographic verifier + restricted SQL + real S3
 * adapter/signer. ONLY network command sends and the host opener are fictional;
 * no actual credentials are resolved and no response fakes the whole service. */
async function composedHost() {
  const t = programMediaHostTarget.parse(target()), database = await good(), subject = 'fictional_media_workforce';
  await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional host clinic') on conflict do nothing", [id(2)]);
  await db.query("insert into clinical_core.persons(id,synthetic_subject_key) values($1,'syn_media_host_person') on conflict do nothing", [id(1)]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true) on conflict do nothing", [id(1), subject]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner') on conflict do nothing", [id(2), id(1)]);
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,created_by_person_id) values($1,$2,'Fictional host lesson',$3) on conflict do nothing", [id(3), id(2), id(1)]);
  await db.query(`update clinical_core.program_media_activation set enabled=true,evidence_sha256=$1,reviewed_by='FICTIONAL FIXTURE ONLY',reviewed_at=clock_timestamp(),
    native_evidence_sha256=$1,storage_bucket=$2,public_origin=$3,expected_bucket_owner=$4,region=$5,kms_key_arn=$6,max_image_bytes=$7,max_video_bytes=$8`,
  [t.nativeEvidenceSha256, t.storage.bucket, t.storage.publicOrigin, t.account, t.region, t.storage.kmsKeyArn, t.storage.maxImageBytes, t.storage.maxVideoBytes]);
  const arn = 'arn:aws:s3:::' + t.storage.bucket;
  const policy = JSON.stringify({ Statement: [
    { Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [arn, arn + '/*'], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
    ...[['s3:x-amz-server-side-encryption', 'aws:kms'], ['s3:x-amz-server-side-encryption-aws-kms-key-id', t.storage.kmsKeyArn]].map(([key, value]) => ({
      Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: arn + '/*', Condition: { StringNotEquals: { [key]: value }, Null: { [key]: 'false' } } })),
    { Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: arn + '/*', Condition: { StringNotEquals: { 's3:if-none-match': '*' }, Bool: { 's3:ObjectCreationOperation': 'true' } } },
  ] });
  t.policyReview.policySha256 = sha(policy);
  const at = Math.floor(Date.now() / 1000) - 10, policyDate = new Date((at - 10) * 1000);
  const claims = { iss: `https://cognito-idp.us-east-2.amazonaws.com/${t.poolId}`, aud: t.clientId, token_use: 'id', sub: subject,
    exp: at + 3600, iat: at, auth_time: at, 'custom:person_id': id(1), 'custom:organization_id': id(2) };
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }), jwk = pair.publicKey.export({ format: 'jwk' });
  if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw new Error('fictional RSA key incomplete');
  const jwt = CognitoJwtVerifier.create({ userPoolId: t.poolId, tokenUse: 'id', clientId: t.clientId });
  jwt.cacheJwks({ keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'fictional-host', use: 'sig', alg: 'RS256' }] });
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = enc({ alg: 'RS256', kid: 'fictional-host' }) + '.' + enc(claims);
  const token = body + '.' + sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url');
  const f = { mfa: true, close: vi.fn(), afterResolve: async (_count: number) => undefined, reads: 0, issued: vi.fn(), stored: new Map<string, Record<string, unknown>>() };
  const clients = { sts: { send: async (command: unknown) => {
    if (!(command instanceof AssumeRoleCommand)) return { Account: t.account, Arn: 'arn:aws:sts::588966314750:assumed-role/alp-media-host/fixture' };
    f.issued(command.input); return { AssumedRoleUser: { Arn: 'arn:aws:sts::588966314750:assumed-role/alp-media-storage/' + command.input.RoleSessionName },
      Credentials: { AccessKeyId: 'ASIA' + 'F'.repeat(16), SecretAccessKey: 'x'.repeat(40), SessionToken: 'fictional-scoped-session', Expiration: new Date(Date.now() + 900000) } };
  } }, cognito: { send: async (command: unknown) => {
    if (command instanceof DescribeUserPoolCommand) return { UserPool: { Id: t.poolId, Arn: `arn:aws:cognito-idp:us-east-2:${t.account}:userpool/${t.poolId}`, MfaConfiguration: f.mfa ? 'ON' : 'OFF', LastModifiedDate: policyDate } };
    if (command instanceof DescribeUserPoolClientCommand) return { UserPoolClient: { UserPoolId: t.poolId, ClientId: t.clientId, LastModifiedDate: policyDate, SupportedIdentityProviders: ['COGNITO'], ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH'] } };
    return { Enabled: true, UserStatus: 'CONFIRMED', UserLastModifiedDate: policyDate, PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'], UserAttributes: [
      { Name: 'sub', Value: subject }, { Name: 'custom:person_id', Value: id(1) }, { Name: 'custom:organization_id', Value: id(2) }, { Name: 'email_verified', Value: 'true' }] };
  } } };
  const sdk = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const q = command.input;
    switch (command.constructor.name) {
      case 'GetCallerIdentityCommand': return { Account: t.account, Arn: 'arn:aws:sts::588966314750:assumed-role/alp-media-storage/fixture' };
      case 'GetBucketVersioningCommand': return { Status: 'Enabled' };
      case 'GetBucketEncryptionCommand': return { ServerSideEncryptionConfiguration: { Rules: [{ BucketKeyEnabled: false, ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: t.storage.kmsKeyArn } }] } };
      case 'GetPublicAccessBlockCommand': return { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } };
      case 'GetBucketOwnershipControlsCommand': return { OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } };
      case 'GetBucketTaggingCommand': return { TagSet: [{ Key: 'alp:purpose', Value: 'educational_media' }, { Key: 'alp:classification', Value: 'synthetic_only' }, { Key: 'alp:phi-allowed', Value: 'false' }, { Key: 'alp:dedicated', Value: 'true' }] };
      case 'GetBucketPolicyCommand': return { Policy: policy };
      case 'PutObjectCommand': {
        const bytes = new Uint8Array(q.Body as Uint8Array); expect(q.ChecksumSHA256).toBe(createHash('sha256').update(bytes).digest('base64'));
        expect(q.IfNoneMatch).toBe('*'); f.stored.set(String(q.Key), { ...q, Body: bytes }); return { VersionId: 'fictional-host-version' };
      }
      case 'HeadObjectCommand': {
        const saved = f.stored.get(String(q.Key)); if (!saved) throw new Error('fictional missing object');
        return { VersionId: 'fictional-host-version', ContentLength: (saved.Body as Uint8Array).length, ContentType: saved.ContentType,
          ChecksumSHA256: saved.ChecksumSHA256, ChecksumType: 'FULL_OBJECT', ServerSideEncryption: saved.ServerSideEncryption, SSEKMSKeyId: saved.SSEKMSKeyId, Metadata: saved.Metadata };
      }
      default: throw new Error('unexpected fictional SDK command');
    }
  });
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(sdk as never); vi.spyOn(STSClient.prototype, 'send').mockImplementation(sdk as never);
  const openRequest = vi.fn(async (_target: unknown, signedToken: string, signal: AbortSignal) => {
    const authority = createProgramMediaHostAuthority({ target: t, database, clients, jwt }); await authority.resolveContext(signedToken, signal);
    return { database, close: f.close, resolveContext: async (bound: AbortSignal) => {
      const context = await authority.resolveContext(signedToken, bound); await f.afterResolve(++f.reads); return context;
    }, credentialsForProgram: async (scope: { clinic: string; programId: string }, bound: AbortSignal) =>
      authority.credentialsForProgram(signedToken, await authority.resolveContext(signedToken, bound), scope, bound) };
  });
  const host = createProgramMediaHostHandlers({ target: t, enabled: true, openRequest });
  const request = (operation: string, value: unknown) => new Request(t.origin + '/api/live/programs/media/control', { method: 'POST',
    headers: { host: new URL(t.origin).host, origin: t.origin, 'content-type': 'application/json' }, body: JSON.stringify({ operation, request: value }) });
  const data = new TextEncoder().encode('Fictional host educational image, no patient data');
  const prepare = () => ({ commandId: randomUUID(), programId: id(3), kind: 'image', contentType: 'image/png', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), fileName: 'fictional.png' });
  return { ...f, t, host, token, sdk, request, data, prepare, control: (operation: string, value: unknown) => host.handle(request(operation, value), token),
    setMfa: (enabled: boolean) => { f.mfa = enabled; }, afterResolve: (callback: typeof f.afterResolve) => { f.afterResolve = callback; } };
}
it('composes signed identity, restricted SQL, binary upload, supplied caption, publication and original-author preview', async () => {
  const f = await composedHost();
  const reservationResponse = await f.control('prepare', f.prepare()); expect(reservationResponse.status).toBe(200);
  const reservation = (await reservationResponse.json()).data;
  const binary = () => new Request(f.t.origin + '/api/live/programs/media/image/' + reservation.artifactId, { method: 'PUT',
    headers: { host: new URL(f.t.origin).host, origin: f.t.origin, 'content-type': 'application/octet-stream' }, body: f.data });
  const uploaded = await f.host.handle(binary(), f.token); expect(uploaded.status).toBe(200); const artifact = (await uploaded.json()).data;
  expect(artifact.state).toBe('ready'); expect(f.issued).toHaveBeenCalledOnce(); expect(f.stored.size).toBe(1);
  expect((await f.host.handle(binary(), f.token)).status).toBe(200);
  expect(f.sdk.mock.calls.filter(([c]) => c.constructor.name === 'PutObjectCommand')).toHaveLength(1);
  const caption = await f.control('attachText', { artifactId: artifact.artifactId, expectedVersion: artifact.version, slot: 'caption',
    source: 'supplied_by_author', format: 'plain', text: 'Fictional supplied lesson description.' });
  expect(caption.status).toBe(200); const updated = (await caption.json()).data;
  expect((await f.control('publish', { artifactId: artifact.artifactId, expectedVersion: updated.version })).status).toBe(200);
  const preview = await f.control('preview', { artifactId: artifact.artifactId }); expect(preview.status).toBe(200);
  const link = new URL((await preview.json()).data.previewToken); expect(link.searchParams.get('versionId')).toBe('fictional-host-version');
  expect(link.searchParams.get('X-Amz-Expires')).toBe('300'); expect(f.close).toHaveBeenCalledTimes(6);
});
it('denies a real forged signature and current MFA withdrawal before reserving anything', async () => {
  const f = await composedHost(), count = async () => (await db.query<{ count: number }>('select count(*)::int as count from clinical_core.program_media_artifacts')).rows[0].count;
  const before = await count(), bad = f.token.slice(0, f.token.lastIndexOf('.') + 1) + Buffer.alloc(256).toString('base64url');
  expect((await f.host.handle(f.request('prepare', f.prepare()), bad)).status).toBe(403);
  f.setMfa(false); expect((await f.control('prepare', f.prepare())).status).toBe(403);
  expect(await count()).toBe(before); expect(f.issued).not.toHaveBeenCalled(); expect(f.sdk).not.toHaveBeenCalled();
});
it('withholds a private response if the release changes between mutation and final response', async () => {
  const f = await composedHost(); f.afterResolve(async count => { if (count === 2) await db.query('update clinical_core.program_media_activation set native_evidence_sha256=$1', ['f'.repeat(64)]); });
  const response = await f.control('prepare', f.prepare()); expect(response.status).toBe(503);
  expect((await response.json()).ok).toBe(false); expect(f.close).toHaveBeenCalledOnce();
});
