import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { assertSuccessorQualificationRows, successorQualificationReleaseArtifact, SUCCESSOR_QUALIFICATION_RELEASE } from '../../../scripts/successor-qualification-release.mjs';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import * as consentRuntime from './telehealth-consent-deployment';
import * as clinicRuntime from './clinic-records-deployment';
import type { ApiGatewayV2Event } from './aws-identity-api';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { classifyDatabaseRejection } from './rds-data-database';

// Actual proposed 117 SQL and actual API role. All people, copies and reviews
// are local fictional fixtures, never AWS identities, releases or approvals.
let pg: PGlite;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const source = { ...SUCCESSOR_QUALIFICATION_RELEASE, sourceCommit: '1'.repeat(40), sourceClean: true, sourceInputSha256: '2'.repeat(64) };
let consentBuild: typeof source & Pick<consentRuntime.TelehealthConsentBuild, 'sqlSha256' | 'functions' | 'telehealthFunctionSha256'>;
let clinicBuild: typeof source & Pick<clinicRuntime.ClinicRecordsBuild, 'extensionSha256' | 'dispatcher'>;
const database: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  return work({ query: async (sql: string, values: unknown[] = []) => {
    try { return await tx.query(sql, values.map(v => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v)); }
    catch (error) { throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: error instanceof Error ? error.message : '' }) ?? error; }
  } } as ClinicalCoreTransaction);
}) };
beforeAll(async () => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-transfer-authority-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
  expect(successorQualificationReleaseArtifact(artifact).executionAllowed).toBe(false);
  const migrations = artifact.manifest.migrations.map((m: { version: string; file: string }) => ({
    version: m.version, name: m.file.slice(15, -4), sql: artifact.files[m.file], sha256: sha(artifact.files[m.file]),
  }));
  pg = new PGlite({ extensions: { pgcrypto } });
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, values = []) => tx.query(sql, [...values]) })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  await pg.transaction(async tx => {
    for (const m of migrations.slice(106)) {
      await tx.exec(m.sql);
      await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [m.version, m.name, m.sha256]);
    }
  });
  assertSuccessorQualificationRows((await pg.query<{ version: string; name: string; sha256: string }>(
    'select version,name,sha256 from clinical_core.schema_migrations order by version collate "C"')).rows);
  const consentSql = artifact.files['20261010100000_production_telehealth_consent_copy.sql'];
  const clinicSql = artifact.files['20261011000000_production_clinic_record_privacy.sql'];
  consentBuild = { ...source, sqlSha256: sha(consentSql),
    functions: [...artifact.files['20261006020000_production_care_connections.sql'].matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
      .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') })),
    telehealthFunctionSha256: sha(/as \$\$([^]*?)\$\$/.exec(consentSql)![1]) };
  clinicBuild = { ...source, extensionSha256: sha(clinicSql), dispatcher: { schema: 'clinical_core', name: 'clinic_record_request',
    sha256: sha(/create function clinical_core\.clinic_record_request\(_request jsonb\) returns jsonb\s+language plpgsql security definer set search_path='' as \$\$([^]*?)\$\$;/.exec(clinicSql)![1]) } };
}, 60000);
afterAll(async () => { await pg?.close(); });

// Failing-before diagnostic only: absent successor factory uses the unchanged
// historical factory, so the same positive journey exposes its 503 refusal.
// This is NOT a runtime fallback and is not used by a deployed entry point.
const consent = (...args: Parameters<typeof consentRuntime.createTelehealthConsentHandler>) => {
  const factory = (consentRuntime as unknown as Record<string, typeof consentRuntime.createTelehealthConsentHandler>).createSuccessorTelehealthConsentHandler
    ?? consentRuntime.createTelehealthConsentHandler;
  return factory(...args);
};
const clinic = (...args: Parameters<typeof clinicRuntime.createClinicRecordsHandler>) => {
  const factory = (clinicRuntime as unknown as Record<string, typeof clinicRuntime.createClinicRecordsHandler>).createSuccessorClinicRecordsHandler
    ?? clinicRuntime.createClinicRecordsHandler;
  return factory(...args);
};
const consentMetadata = () => consentBuild as unknown as consentRuntime.TelehealthConsentBuild;
const clinicMetadata = () => clinicBuild as unknown as clinicRuntime.ClinicRecordsBuild;
const configurationDigest = (e: Record<string, string | undefined>) => sha(JSON.stringify([
  ...consentRuntime.TELEHEALTH_CONSENT_CONFIGURATION_KEYS, 'SUCCESSOR_QUALIFICATION_PROFILE', 'MIGRATION_ASSEMBLY_SHA256',
].map(key => [key, e[key] ?? ''])));
const sign = (e: Record<string, string | undefined>): Record<string, string | undefined> =>
  ({ ...e, TELEHEALTH_CONSENT_CONFIGURATION_SHA256: configurationDigest(e) });

async function fixture() {
  const [org, foreignOrg, owner, other, staff, outsider, patient, connection, artifactId] = Array.from({ length: 9 }, () => randomUUID());
  for (const id of [org, foreignOrg]) await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL ONLY')", [id]);
  for (const [id, pool] of [[owner, 'consumer'], [other, 'consumer'], [staff, 'workforce'], [outsider, 'workforce']]) {
    await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
    await pg.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, 'fictional-' + id]);
  }
  for (const [id, organization] of [[staff, org], [outsider, foreignOrg]]) await pg.query(
    "insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [organization, id]);
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')", [patient, org, 'patient_' + patient.replaceAll('-', '')]);
  await pg.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [connection, org, patient, owner]);
  const text = 'FICTIONAL consent copy for local software tests only. No patient approval.';
  await pg.query("insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,$2,'telehealth_recording','fictional-test',$3,'TEST','approved',now(),$4)", [artifactId, org, sha(text), staff]);
  await pg.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)', [artifactId, org, text, sha(text)]);
  const review = '3'.repeat(64), now = Date.now();
  const e: Record<string, string | undefined> = { SOURCE_COMMIT: source.sourceCommit, SOURCE_INPUT_SHA256: source.sourceInputSha256,
    SUCCESSOR_QUALIFICATION_PROFILE: source.qualificationProfile, MIGRATION_RELEASE_SHA256: source.migrationReleaseSha256,
    MIGRATION_ASSEMBLY_SHA256: source.migrationAssemblySha256, CLINIC_RECORDS_EXTENSION_SHA256: clinicBuild.extensionSha256,
    AWS_REGION: 'us-east-2', DEPLOYMENT_ACCOUNT_ID: '588966314750', PHI_ALLOWED: 'false',
    TELEHEALTH_CONSENT_ACTIVATION: 'blocked', CLINIC_RECORDS_ACTIVATION: 'blocked', TELEHEALTH_CONSENT_ENABLED: 'true',
    TELEHEALTH_CONSENT_ORGANIZATION_ID: org, CLINIC_RECORDS_ORGANIZATION_ID: org,
    CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
    WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26),
    CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
    CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/runtime-api-fictional-AbCd12',
    CLINICAL_DATABASE_NAME: 'clinical_core_qualification', DATABASE_REVIEW_SHA256: review, WORKFORCE_MFA_REVIEW_SHA256: review,
    CONNECTION_REVIEW_SHA256: review, CONSENT_REVIEW_SHA256: review, DISCLOSURE_REVIEW_SHA256: review, RETENTION_REVIEW_SHA256: review,
    QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: review, QUALIFICATION_ACCOUNT_ID: '588966314750',
    QUALIFICATION_IDENTITY_SUBJECTS: [owner, other, staff, outsider].map(id => 'fictional-' + id).join(',') };
  const event = (route: 'telehealth-consent' | 'clinic-records', body: unknown, who = owner, pool: 'consumer' | 'workforce' = 'consumer'): ApiGatewayV2Event => ({
    routeKey: `POST /clinical-core/${pool}/${route}`, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: e[pool === 'consumer' ? 'CONSUMER_ISSUER' : 'WORKFORCE_ISSUER'],
      aud: e[pool === 'consumer' ? 'CONSUMER_AUDIENCE' : 'WORKFORCE_AUDIENCE'], sub: 'fictional-' + who, token_use: 'id',
      'custom:person_id': who, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: true,
      iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 1000, auth_time: Math.floor(now / 1000) - 10 } } } },
  });
  return { org, owner, other, staff, outsider, patient, connection, artifactId, text, now, e: sign(e), event };
}
it('117 rehearsal starts without patient, consent or disclosure seed rows', async () => {
  for (const table of ['clinical_core.persons', 'clinical_core.consent_grants', 'clinical_private.clinic_disclosure_releases'])
    expect((await pg.query<{ n: number }>(`select count(*)::int n from ${table}`)).rows[0].n).toBe(0);
});
it('successor telehealth consent reads exact copy, grants and withdraws through real guarded SQL', async () => {
  const f = await fixture(), handle = consent(f.e, consentMetadata(), () => database, () => f.now);
  const review = await handle(f.event('telehealth-consent', { action: 'consent', connectionId: f.connection, scope: 'telehealth_recording' }));
  expect(review).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
  expect(JSON.parse(review.body).data.artifact).toMatchObject({ content: f.text, contentSha256: sha(f.text) });
  expect((await handle(f.event('telehealth-consent', { action: 'grant', connectionId: f.connection, scope: 'telehealth_recording',
    artifactId: f.artifactId, contentSha256: sha(f.text), expectedVersion: 0 }))).statusCode).toBe(200);
  expect((await handle(f.event('telehealth-consent', { action: 'withdraw', connectionId: f.connection, scope: 'telehealth_recording', expectedVersion: 1 }))).statusCode).toBe(200);
  const result = await handle(f.event('telehealth-consent', { action: 'consent', connectionId: f.connection, scope: 'telehealth_recording' }));
  expect(JSON.parse(result.body).data).toMatchObject({ status: 'revoked', version: 2 });
  expect((await handle(f.event('telehealth-consent', { action: 'consent', connectionId: f.connection, scope: 'telehealth_recording' }, f.other))).statusCode).toBe(403);
});
it('successor clinic records executes owner overview and workforce queue without cross-owner or clinic exposure', async () => {
  const f = await fixture(), handle = clinic(f.e, clinicMetadata(), () => database, () => f.now);
  const owner = await handle(f.event('clinic-records', { action: 'overview' }));
  expect(owner).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
  expect(JSON.parse(owner.body).data.connection.connectionId).toBe(f.connection);
  const other = await handle(f.event('clinic-records', { action: 'overview' }, f.other));
  expect(other.statusCode).toBe(200); expect(other.body).not.toContain(f.connection); expect(other.body).not.toContain(f.patient);
  expect((await handle(f.event('clinic-records', { action: 'queue', limit: 10 }, f.staff, 'workforce'))).statusCode).toBe(200);
  expect((await handle(f.event('clinic-records', { action: 'queue', limit: 10 }, f.outsider, 'workforce'))).statusCode).toBe(403);
});
it('historical 112 and 116 handlers refuse successor metadata before constructing a client', async () => {
  const f = await fixture(), factory = vi.fn(() => database);
  expect((await consentRuntime.createTelehealthConsentHandler(f.e, consentMetadata(), factory)(f.event('telehealth-consent', { action: 'connection' }))).statusCode).toBe(503);
  expect((await clinicRuntime.createClinicRecordsHandler(f.e, clinicMetadata(), factory)(f.event('clinic-records', { action: 'overview' }))).statusCode).toBe(503);
  expect(factory).not.toHaveBeenCalled();
});
it.each([
  ['SUCCESSOR_QUALIFICATION_PROFILE', 'clinical-successor-qualification/2'], ['MIGRATION_RELEASE_SHA256', '4'.repeat(64)],
  ['MIGRATION_ASSEMBLY_SHA256', '4'.repeat(64)], ['SOURCE_COMMIT', '4'.repeat(40)], ['SOURCE_INPUT_SHA256', '4'.repeat(64)],
  ['PHI_ALLOWED', 'true'], ['CLINICAL_DATABASE_NAME', 'clinical_core'], ['DEPLOYMENT_ACCOUNT_ID', '173535830222'],
  ['INVENTORY_QUALIFICATION_PROFILE', 'clinical-inventory-qualification/1'],
  ['CLINICAL_DATABASE_SECRET_ARN', 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-operator-AbCd12'],
  ['DATABASE_REVIEW_SHA256', ''], ['WORKFORCE_MFA_REVIEW_SHA256', ''], ['RETENTION_REVIEW_SHA256', ''], ['QUALIFICATION_REVIEW_SHA256', ''],
])('both successor factories refuse %s before data construction', async (key, value) => {
  const f = await fixture(), e = sign({ ...f.e, [key]: value }), factory = vi.fn(() => database);
  expect((await consent(e, consentMetadata(), factory)(f.event('telehealth-consent', { action: 'connection' }))).statusCode).toBe(503);
  expect((await clinic(e, clinicMetadata(), factory)(f.event('clinic-records', { action: 'overview' }))).statusCode).toBe(503);
  expect(factory).not.toHaveBeenCalled();
});
it('consent configuration remains independently bound and grants remain independently switchable', async () => {
  const f = await fixture(), e = sign({ ...f.e, TELEHEALTH_CONSENT_ENABLED: 'false' });
  const handle = consent(e, consentMetadata(), () => database, () => f.now);
  expect((await handle(f.event('telehealth-consent', { action: 'connection' }))).statusCode).toBe(200);
  expect((await handle(f.event('telehealth-consent', { action: 'grant', connectionId: f.connection, scope: 'telehealth_recording',
    artifactId: f.artifactId, contentSha256: sha(f.text), expectedVersion: 0 }))).statusCode).toBe(403);
  const factory = vi.fn(() => database);
  expect((await consent({ ...f.e, TELEHEALTH_CONSENT_CONFIGURATION_SHA256: consentRuntime.telehealthConsentConfigurationSha256(f.e) },
    consentMetadata(), factory)(f.event('telehealth-consent', { action: 'connection' }))).statusCode).toBe(503);
  expect(factory).not.toHaveBeenCalled();
});
it('same release cannot substitute child SQL or per-transaction compiled function pins', async () => {
  const f = await fixture(), factory = vi.fn(() => database);
  for (const b of [{ ...consentBuild, sqlSha256: '9'.repeat(64) }, { ...consentBuild, sourceClean: false }])
    expect((await consent(f.e, b as unknown as consentRuntime.TelehealthConsentBuild, factory)(f.event('telehealth-consent', { action: 'connection' }))).statusCode).toBe(503);
  for (const b of [{ ...clinicBuild, extensionSha256: '9'.repeat(64) }, { ...clinicBuild, sourceClean: false }])
    expect((await clinic(sign({ ...f.e, CLINIC_RECORDS_EXTENSION_SHA256: b.extensionSha256 }), b as unknown as clinicRuntime.ClinicRecordsBuild,
      factory)(f.event('clinic-records', { action: 'overview' }))).statusCode).toBe(503);
  expect(factory).not.toHaveBeenCalled();
  const drifted = { ...clinicBuild, dispatcher: { ...clinicBuild.dispatcher, sha256: '9'.repeat(64) } };
  expect((await clinic(f.e, drifted as unknown as clinicRuntime.ClinicRecordsBuild, () => database, () => f.now)(f.event('clinic-records', { action: 'overview' }))).statusCode).toBe(503);
  expect((await consent(f.e, { ...consentBuild, telehealthFunctionSha256: '9'.repeat(64) } as unknown as consentRuntime.TelehealthConsentBuild,
    () => database, () => f.now)(f.event('telehealth-consent', { action: 'connection' }))).statusCode).toBe(503);
});
it.each(['CONNECTION_REVIEW_SHA256', 'CONSENT_REVIEW_SHA256'])('successor consent cannot substitute its configuration digest for %s', async key => {
  const f = await fixture(), factory = vi.fn(() => database);
  expect((await consent(sign({ ...f.e, [key]: '' }), consentMetadata(), factory)(f.event('telehealth-consent', { action: 'connection' }))).statusCode).toBe(503);
  expect(factory).not.toHaveBeenCalled();
});
it('successor clinic disclosure review remains independent of the exact migration and source', async () => {
  const f = await fixture(), factory = vi.fn(() => database);
  expect((await clinic({ ...f.e, DISCLOSURE_REVIEW_SHA256: '' }, clinicMetadata(), factory)(f.event('clinic-records', { action: 'overview' }))).statusCode).toBe(503);
  expect(factory).not.toHaveBeenCalled();
});
it('both factories capture build and environment without granting an administrative database role', async () => {
  const f = await fixture(), e = { ...f.e }, cb = structuredClone(consentBuild), rb = structuredClone(clinicBuild);
  const ch = consent(e, cb as unknown as consentRuntime.TelehealthConsentBuild, () => database, () => f.now);
  const rh = clinic(e, rb as unknown as clinicRuntime.ClinicRecordsBuild, () => database, () => f.now);
  e.PHI_ALLOWED = 'true'; cb.functions = []; rb.dispatcher.sha256 = '9'.repeat(64);
  expect((await ch(f.event('telehealth-consent', { action: 'connection' }))).statusCode).toBe(200);
  expect((await rh(f.event('clinic-records', { action: 'overview' }))).statusCode).toBe(200);
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, args = []) => tx.query(sql, [...args]) })) };
  expect((await consent(f.e, consentMetadata(), () => admin, () => f.now)(f.event('telehealth-consent', { action: 'connection' }))).statusCode).toBe(503);
  expect((await clinic(f.e, clinicMetadata(), () => admin, () => f.now)(f.event('clinic-records', { action: 'overview' }))).statusCode).toBe(503);
});
it('disabled execution and stale authentication never construct a request database', async () => {
  const f = await fixture(), factory = vi.fn(() => database), disabled = sign({ ...f.e, QUALIFICATION_EXECUTION: 'disabled' });
  expect((await consent(disabled, consentMetadata(), factory)(f.event('telehealth-consent', { action: 'connection' }))).statusCode).toBe(503);
  expect((await clinic(disabled, clinicMetadata(), factory)(f.event('clinic-records', { action: 'overview' }))).statusCode).toBe(503);
  const stale = f.event('clinic-records', { action: 'overview' }); stale.requestContext!.authorizer!.jwt!.claims!.auth_time = Math.floor(f.now / 1000) - 901;
  expect((await clinic(f.e, clinicMetadata(), factory, () => f.now)(stale)).statusCode).toBe(401);
  const grant = f.event('telehealth-consent', { action: 'grant', connectionId: f.connection, scope: 'telehealth_recording',
    artifactId: f.artifactId, contentSha256: sha(f.text), expectedVersion: 0 });
  grant.requestContext!.authorizer!.jwt!.claims!.auth_time = Math.floor(f.now / 1000) - 901;
  expect((await consent(f.e, consentMetadata(), factory, () => f.now)(grant)).statusCode).toBe(401);
  expect(factory).not.toHaveBeenCalled();
});
it('additive configuration identity binds successor pins without changing historical identity bytes', async () => {
  const f = await fixture();
  expect(consentRuntime.successorTelehealthConsentConfigurationSha256(f.e)).toBe(configurationDigest(f.e));
  const e = Object.fromEntries(consentRuntime.SUCCESSOR_TELEHEALTH_CONSENT_CONFIGURATION_KEYS.map(key => [key, f.e[key] ?? '']));
  expect(consentRuntime.successorTelehealthConsentConfigurationIdentity({ contract: 'telehealth-consent-configuration/2', environment: e }))
    .toEqual({ configurationSha256: configurationDigest(e) });
  const old = Object.fromEntries(consentRuntime.TELEHEALTH_CONSENT_CONFIGURATION_KEYS.map(key => [key, e[key]]));
  expect(consentRuntime.telehealthConsentConfigurationIdentity({ contract: 'telehealth-consent-configuration/1', environment: old }))
    .toEqual({ configurationSha256: consentRuntime.telehealthConsentConfigurationSha256(old) });
  expect(consentRuntime.telehealthConsentConfigurationSha256(old)).not.toBe(configurationDigest(e));
  expect(() => consentRuntime.successorTelehealthConsentConfigurationIdentity({ contract: 'telehealth-consent-configuration/2', environment: { ...e, secret: 'DO-NOT-ECHO' } }))
    .toThrow('successor_telehealth_consent_configuration_input_refused');
});
