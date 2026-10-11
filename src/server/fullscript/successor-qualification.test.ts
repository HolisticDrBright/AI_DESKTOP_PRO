import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash,generateKeyPairSync,sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {CognitoJwtVerifier} from 'aws-jwt-verify';
import {applyProductionClinicalCoreMigrations} from '../clinical-core/production-migrations';
import * as api from './qualification-api';
import * as loader from './qualification-target-loader';
import * as observer from './qualification-observer';
import { SUCCESSOR_QUALIFICATION_RELEASE, successorQualificationReleaseArtifact } from '../../../scripts/successor-qualification-release.mjs';
import type { ClinicalCoreDatabase } from '../clinical-core/database';

// All identities, reviews, AWS responses and provider operations are fictional.
// Actual source SQL determines the complete ledger, not a hand-written subset.
const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}' : JSON.stringify(v);
const source = { ...SUCCESSOR_QUALIFICATION_RELEASE, sourceCommit: 'a'.repeat(40), sourceClean: true, sourceInputSha256: 'b'.repeat(64) };
const org = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333', now = Math.floor(Date.now() / 1000) * 1000;
const context = { invokedFunctionArn: 'arn:aws:lambda:us-east-2:588966314750:function:fictional-fullscript:7', functionVersion: '7' };
const providerCredentials = { providerSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-provider',
  providerSecretVersion: 'f'.repeat(32), tokenTable: 'fictional-fullscript-tokens',
  redirectUri: 'https://fictional.example.test/api/live/fullscript/oauth/callback' };
let target: Record<string, unknown>;
let pg:PGlite;
beforeAll(async() => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-transfer-authority-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
  const release = successorQualificationReleaseArtifact(artifact);
  expect(release.executionAllowed).toBe(false);
  const bootstrap=new PGlite({extensions:{pgcrypto}});
  await bootstrap.exec('create database clinical_core_qualification');
  const localData=await bootstrap.dumpDataDir('none');await bootstrap.close();
  pg=new PGlite({loadDataDir:localData,database:'clinical_core_qualification',extensions:{pgcrypto}});
  const migrations=artifact.manifest.migrations.map((m:{version:string;file:string})=>({
    version:m.version,name:m.file.slice(15,-4),sql:artifact.files[m.file],sha256:sha(artifact.files[m.file])}));
  const admin:ClinicalCoreDatabase={transaction:work=>pg.transaction(tx=>work({query:(sql,values=[])=>tx.query(sql,[...values])}))};
  await applyProductionClinicalCoreMigrations(admin,migrations.slice(0,106));
  await pg.transaction(async tx=>{for(const m of migrations.slice(106)){
    await tx.exec(m.sql);await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[m.version,m.name,m.sha256]);
  }});
  target = { execution: 'qualification', account: '588966314750', region: 'us-east-2', phiAllowed: false, activation: 'blocked',
    reviewSha256: 'c'.repeat(64), sourceCommit: source.sourceCommit, sourceInputSha256: source.sourceInputSha256,
    schemaRelease: 'clinical-successor-qualification/117', qualificationProfile: source.qualificationProfile,
    migrationReleaseSha256: source.migrationReleaseSha256, migrationAssemblySha256: source.migrationAssemblySha256,
    apiId: 'a123456789', functionArn: context.invokedFunctionArn, codeSha256: Buffer.alloc(32, 7).toString('base64'),
    clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
    secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/fullscript-worker-fictional-AbCd12',
    databaseName: 'clinical_core_qualification', organizationId: org,
    consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalConsumer', consumerAudience: 'c'.repeat(26),
    workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalWorkforce', workforceAudience: 'w'.repeat(26),
    consumerSubjects: ['fictional-consumer-1', 'fictional-consumer-2'], workforceSubjects: ['fictional-workforce'],
    providerCredentials, migrations: release.rows };
},60000);
afterAll(async()=>{await pg?.close();});
const createApi = api.createSuccessorQualificationFullscriptApi;
const createObserver = observer.createSuccessorFullscriptQualificationObserver;
const loadTarget = loader.loadSuccessorFullscriptQualificationTarget;
function event(workforce = false): api.FullscriptQualificationEvent {
  return { routeKey: workforce ? api.FULLSCRIPT_QUALIFICATION_ROUTES.workforce : api.FULLSCRIPT_QUALIFICATION_ROUTES.consumer,
    headers: { 'content-type': 'application/json', authorization: 'Bearer e30.e30.FICTIONAL' }, body: JSON.stringify({ action: 'read', id }),
    requestContext: { apiId: 'a123456789', routeId: 'fictionalroute', authorizer: { jwt: { claims: {
      iss: target[workforce ? 'workforceIssuer' : 'consumerIssuer'] as string, aud: target[workforce ? 'workforceAudience' : 'consumerAudience'] as string,
      token_use: 'id', sub: workforce ? 'fictional-workforce' : 'fictional-consumer-1', email: 'fictional@example.test', email_verified: true,
      'custom:person_id': person, 'custom:organization_id': org, 'custom:production_bound': 'true',
      iat: now / 1000 - 10, auth_time: now / 1000 - 10, exp: now / 1000 + 1000,
    } } } } };
}
function environment(): Record<string, string | undefined> {
  return { AWS_REGION: 'us-east-2', DEPLOYMENT_ACCOUNT_ID: '588966314750', PHI_ALLOWED: 'false', PRODUCTION_ACTIVATION: 'blocked',
    QUALIFICATION_EXECUTION: 'true', QUALIFICATION_ACCOUNT_ID: '588966314750', QUALIFICATION_REVIEW_SHA256: 'c'.repeat(64),
    QUALIFICATION_IDENTITY_SUBJECTS: 'fictional-consumer-1,fictional-consumer-2,fictional-workforce',
    SOURCE_COMMIT: source.sourceCommit, SOURCE_INPUT_SHA256: source.sourceInputSha256,
    FULLSCRIPT_SOURCE_COMMIT: source.sourceCommit, SUCCESSOR_QUALIFICATION_PROFILE: source.qualificationProfile,
    MIGRATION_RELEASE_SHA256: source.migrationReleaseSha256, MIGRATION_ASSEMBLY_SHA256: source.migrationAssemblySha256,
    CLINICAL_DATABASE_CLUSTER_ARN: target.clusterArn as string, CLINICAL_DATABASE_SECRET_ARN: target.secretArn as string,
    CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
    FULLSCRIPT_PROVIDER_SECRET_ARN: providerCredentials.providerSecretArn, FULLSCRIPT_PROVIDER_SECRET_VERSION: providerCredentials.providerSecretVersion,
    FULLSCRIPT_TOKEN_TABLE: providerCredentials.tokenTable, FULLSCRIPT_REDIRECT_URI: providerCredentials.redirectUri };
}
function storedTarget(value = target) {
  const released: Record<string, unknown> = { ...value, functionArn: context.invokedFunctionArn.slice(0, -2) };
  delete released.reviewSha256; delete released.providerCredentials;
  const release = { contract: 'fullscript-qualification-target-release/4', target: released,
    credentials: providerCredentials,
    review: { reviewer: 'Brandon Bright', reviewedAt: '2026-10-01T00:00:00.000Z', decision: 'approved',
      scope: 'fictional-fullscript-api-target-only', versionBinding: 'observed-numeric-version-of-exact-reviewed-code' } };
  const bytes = Buffer.from(canonical(release) + '\n'), env = { ...environment(), QUALIFICATION_REVIEW_SHA256: sha(bytes),
    FULLSCRIPT_TARGET_BUCKET: 'alp-qualification-code-588966314750-us-east-2', FULLSCRIPT_TARGET_KEY: 'fullscript/qualification-target/' + '1'.repeat(32) + '/target.json',
    FULLSCRIPT_TARGET_VERSION: 'fictional-version', FULLSCRIPT_PROVIDER_SECRET_ARN: release.credentials.providerSecretArn,
    FULLSCRIPT_PROVIDER_SECRET_VERSION: release.credentials.providerSecretVersion, FULLSCRIPT_TOKEN_TABLE: release.credentials.tokenTable,
    FULLSCRIPT_REDIRECT_URI: release.credentials.redirectUri };
  const send = vi.fn(async () => ({ $metadata: { httpStatusCode: 200 }, VersionId: 'fictional-version', ContentLength: bytes.length,
    ContentType: 'application/json', ServerSideEncryption: 'AES256', Body: Readable.from([bytes]) }));
  return { env, send, build: { ...source, clean: true }, context, release };
}
it('new API reaches fictional consumer read through the actual 117 target contract', async () => {
  const observe = vi.fn(async () => {}), read = vi.fn(async () => ({ id, status: 'cancelled' })), operations = vi.fn(() => ({ read }));
  const run = createApi({ target, observe, operations: operations as unknown as Parameters<typeof api.createQualificationFullscriptApi>[0]['operations'], now: () => now });
  const result = await run(event(), context);
  expect(result).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
  expect(JSON.parse(result.body).data.status).toBe('cancelled'); expect(observe).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledWith(id);
});
it('new loader reads exact immutable target and derives the actual numeric invocation version', async () => {
  const s = storedTarget(), actual = await loadTarget({ ...s, store: { send: s.send } });
  expect(actual).toMatchObject({ schemaRelease: 'clinical-successor-qualification/117', functionArn: context.invokedFunctionArn,
    reviewSha256: s.env.QUALIFICATION_REVIEW_SHA256 }); expect(actual.migrations).toHaveLength(117); expect(s.send).toHaveBeenCalledOnce();
});
it('historical API and loader do not silently admit the successor', async () => {
  const observe = vi.fn(async () => {}), operations = vi.fn();
  expect(() => api.createQualificationFullscriptApi({ target, observe, operations })).toThrow();
  const s = storedTarget(); await expect(loader.loadFullscriptQualificationTarget({ ...s, build: { ...s.build, clean: true }, store: { send: s.send } })).rejects.toThrow();
  expect(operations).not.toHaveBeenCalled();
});
it.each(['schema', 'profile', 'source-input', 'release', 'assembly', 'short', 'extra', 'reordered', 'changed-name', 'changed-body', 'api-secret', 'operator-secret', 'phi', 'production'])
('successor contract refuses %s without provider construction', kind => {
  const t = structuredClone(target), rows = t.migrations as Record<string, unknown>[];
  if (kind === 'schema') t.schemaRelease = 'telehealth-consent-copy/112';
  if (kind === 'profile') t.qualificationProfile = 'clinical-inventory-qualification/1';
  if (kind === 'source-input') t.sourceInputSha256 = '0'.repeat(64);
  if (kind === 'release') t.migrationReleaseSha256 = 'd'.repeat(64);
  if (kind === 'assembly') t.migrationAssemblySha256 = 'd'.repeat(64);
  if (kind === 'short') rows.pop(); if (kind === 'extra') rows.push(rows[116]);
  if (kind === 'reordered') [rows[0], rows[1]] = [rows[1], rows[0]];
  if (kind === 'changed-name') rows[0].name = 'altered'; if (kind === 'changed-body') rows[0].sha256 = 'd'.repeat(64);
  if (kind === 'api-secret') t.secretArn = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/runtime-api-fictional-AbCd12';
  if (kind === 'operator-secret') t.secretArn = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-operator-X';
  if (kind === 'phi') t.phiAllowed = true; if (kind === 'production') t.databaseName = 'clinical_core';
  const operations = vi.fn(); expect(() => createApi({ target: t, observe: async () => {}, operations })).toThrow(); expect(operations).not.toHaveBeenCalled();
});
it.each(['SOURCE_INPUT_SHA256', 'SUCCESSOR_QUALIFICATION_PROFILE', 'MIGRATION_ASSEMBLY_SHA256', 'CLINICAL_DATABASE_SECRET_ARN', 'QUALIFICATION_IDENTITY_SUBJECTS'])
('loader refuses wrong %s before storage', async key => {
  const s = storedTarget(); s.env[key as keyof typeof s.env] = 'wrong';
  await expect(loadTarget({ ...s, store: { send: s.send } })).rejects.toThrow(); expect(s.send).not.toHaveBeenCalled();
});
it.each([false,true])('observer admits the exact fictional published service and complete same-worker ledger workforce=%s', async workforce => {
  const e = event(workforce), claims = e.requestContext!.authorizer!.jwt!.claims!;
  const poolId=workforce?'us-east-2_FictionalWorkforce':'us-east-2_FictionalConsumer';
  const env = environment(), date = new Date(now - 60000), subject = String(claims.sub);
  const replies: Record<string, Record<string, unknown>> = {
    GetCallerIdentityCommand: { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/FICTIONAL/test' },
    GetFunctionConfigurationCommand: { FunctionArn: context.invokedFunctionArn, Version: '7', CodeSha256: target.codeSha256,
      State: 'Active', LastUpdateStatus: 'Successful', Environment: { Variables: env } },
    GetRouteCommand: { RouteKey: e.routeKey, AuthorizationType: 'JWT', AuthorizerId: 'fictional', Target: 'integrations/fictional' },
    GetAuthorizerCommand: { AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'], JwtConfiguration: { Issuer: claims.iss, Audience: [claims.aud] } },
    GetIntegrationCommand: { IntegrationType: 'AWS_PROXY', PayloadFormatVersion: '2.0', IntegrationUri: context.invokedFunctionArn },
    DescribeUserPoolCommand: { UserPool: { Id: poolId, Arn: 'arn:aws:cognito-idp:us-east-2:588966314750:userpool/'+poolId,
      MfaConfiguration:'ON',LastModifiedDate:date } },
    DescribeUserPoolClientCommand: { UserPoolClient: { UserPoolId: poolId, ClientId: claims.aud,
      SupportedIdentityProviders:['COGNITO'],ExplicitAuthFlows:['ALLOW_USER_SRP_AUTH','ALLOW_REFRESH_TOKEN_AUTH'],LastModifiedDate:date } },
    AdminGetUserCommand: { Enabled: true, UserStatus: 'CONFIRMED', UserLastModifiedDate: date,
      PreferredMfaSetting:'SOFTWARE_TOKEN_MFA',UserMFASettingList:['SOFTWARE_TOKEN_MFA'],
      UserAttributes: Object.entries({ sub: subject, email: 'fictional@example.test', email_verified: 'true', 'custom:person_id': person,
        'custom:organization_id': org, 'custom:production_bound': 'true' }).map(([Name, Value]) => ({ Name, Value })) },
  };
  const send = vi.fn(async (command: unknown) => structuredClone(replies[(command as { constructor: { name: string } }).constructor.name]));
  const queries:string[]=[];
  const database:ClinicalCoreDatabase={transaction:work=>pg.transaction(async tx=>{
    await tx.exec('set local role fullscript_draft_worker');
    return work({query:(sql,values=[])=>{queries.push(sql);return tx.query(sql,[...values]);}});
  })};
  const jwt=CognitoJwtVerifier.create([{userPoolId:poolId,tokenUse:'id',clientId:String(claims.aud)}]);
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=publicKey.export({format:'jwk'});
  jwt.cacheJwks({keys:[{...jwk,kty:'RSA',kid:'FICTIONAL',alg:'RS256',use:'sig'}]},poolId);
  const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const signed=encode({alg:'RS256',kid:'FICTIONAL'})+'.'+encode(claims);
  e.headers!.authorization='Bearer '+signed+'.'+sign('RSA-SHA256',Buffer.from(signed),privateKey).toString('base64url');
  const run = createObserver({ target, database, clients: { sts: { send }, lambda: { send }, gateway: { send }, cognito: { send } }, jwt });
  const who: api.FullscriptRequestIdentity = { actor: { organizationId: org, personId: person, identitySubject: subject, identityPool: workforce?'workforce':'consumer', environment: 'synthetic-staging', phiAllowed: false }, claims };
  await run(e, context, who); expect(send).toHaveBeenCalledTimes(8);
  for(const key of ['MIGRATION_ASSEMBLY_SHA256','SOURCE_INPUT_SHA256','FULLSCRIPT_PROVIDER_SECRET_ARN',
    'FULLSCRIPT_PROVIDER_SECRET_VERSION','FULLSCRIPT_TOKEN_TABLE','FULLSCRIPT_REDIRECT_URI','QUALIFICATION_IDENTITY_SUBJECTS']){
    const prior=env[key];env[key]='wrong';await expect(run(e,context,who)).rejects.toThrow();env[key]=prior;
  }
  expect(queries).toHaveLength(2); // Changed service metadata stops before a second database pass.
});
it('actual successor worker ledger exists without direct clinical access or API-role substitution',async()=>{
  const ledger=await pg.transaction(async tx=>{
    await tx.exec('set local role fullscript_draft_worker');
    return tx.query<{ledger:unknown}>('select fullscript_delivery.migration_ledger() as ledger');
  });
  expect(ledger.rows[0].ledger).toEqual(target.migrations);
  for(const sql of ['select * from clinical_core.patient_records','select * from clinical_core.schema_migrations'])
    await expect(pg.transaction(async tx=>{await tx.exec('set local role fullscript_draft_worker');return tx.query(sql);})).rejects.toThrow(/permission denied/);
  await expect(pg.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');return tx.query('select fullscript_delivery.migration_ledger()');
  })).rejects.toThrow(/permission denied/);
});
