import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { assertSuccessorQualificationRows, successorQualificationReleaseArtifact, SUCCESSOR_QUALIFICATION_RELEASE } from '../../../scripts/successor-qualification-release.mjs';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { bindCareMessagingDatabase, createCareMessagingHandler, createInventoryCareMessagingHandler, createSuccessorCareMessagingHandler, type CareMessagingBuild, type InventoryCareMessagingBuild } from './care-messaging-deployment';
import { createCareConnectionsHandler, createInventoryCareConnectionsHandler, createSuccessorCareConnectionsHandler, type CareConnectionsBuild, type InventoryCareConnectionsBuild } from './care-connections-deployment';
import { bindCareConnectionDatabase, type CareConnectionFunctionBinding } from './care-connections-database-binding';
import { bindCareClaimRecoveryDatabase } from './care-claim-recovery-database-binding';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { classifyDatabaseRejection } from './rds-data-database';
import type { ApiGatewayV2Event } from './aws-identity-api';
import { CARE_CLAIM_RECOVERY_ROUTE } from './care-claim-recovery-api';

let pg: PGlite;
let messagePins: { schema: string; name: string; sha256: string; callable: boolean }[];
let connectionPins: CareConnectionFunctionBinding[], claimPins: CareConnectionFunctionBinding[];
const database: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  return work({ query: async (sql: string, args: unknown[] = []) => {
    try { return await tx.query(sql, args.map(value => value && typeof value === 'object' && 'kind' in value
      && value.kind === 'uuid' && 'value' in value ? value.value : value)); }
    catch (error) {
      const rejection = classifyDatabaseRejection({ name: 'DatabaseErrorException', message: error instanceof Error ? error.message : '' });
      if (rejection) throw rejection;
      throw error;
    }
  } } as ClinicalCoreTransaction);
}) };
beforeAll(async () => {
  const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-transfer-authority-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
  const release = successorQualificationReleaseArtifact(a);
  expect(release.executionAllowed).toBe(false);
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');
  pg = new PGlite({ extensions: { pgcrypto } });
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql: string, args: unknown[] = []) => tx.query(sql, args) } as ClinicalCoreTransaction)) };
  const migrations = a.manifest.migrations.map((m: { version: string; file: string }) => ({
    version: m.version, name: m.file.slice(15, -4), sql: a.files[m.file], sha256: sha(a.files[m.file]),
  }));
  // Preserve the exact historical installer. Forward candidate SQL is rehearsed
  // only in this fresh embedded DB, not registered or applied to managed AWS.
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  await pg.transaction(async tx => {
    for (const entry of migrations.slice(106)) {
      await tx.exec(entry.sql);
      await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',
        [entry.version, entry.name, entry.sha256]);
    }
  });
  assertSuccessorQualificationRows((await pg.query<{ version: string; name: string; sha256: string }>(
    'select version,name,sha256 from clinical_core.schema_migrations order by version collate "C"')).rows);
  messagePins = [...a.files['20261006010000_production_care_messaging.sql'].matchAll(
    /create function (clinical_(?:core|private))\.(production_care_message_[a-z]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
    .map(([, schema, name, body]) => ({ schema, name, sha256: sha(body), callable: schema === 'clinical_core' }));
  const pins = (sql: string) => [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
    .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') }));
  connectionPins = pins(a.files['20261006020000_production_care_connections.sql']);
  claimPins = pins(a.files['20261006030000_production_care_claim_recovery.sql']);
}, 60000);
afterAll(async () => { await pg?.close(); });
it('actual 117 embedded SQL has the complete ledger with no clinical or approval fixtures', async () => {
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.schema_migrations')).rows[0].n).toBe(117);
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.persons')).rows[0].n).toBe(0);
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_private.telehealth_admission_keys')).rows[0].n).toBe(0);
});
it.each(['messaging', 'connections', 'claim-recovery'] as const)('actual successor preserves %s bodies, privileges and guards', async kind => {
  const guarded = kind === 'messaging' ? bindCareMessagingDatabase(database, { functions: messagePins })
    : kind === 'connections' ? bindCareConnectionDatabase(database, connectionPins)
      : bindCareClaimRecoveryDatabase(database, connectionPins, claimPins);
  expect(await guarded.transaction(async tx => (await tx.query<{ actor: string }>('select current_user as actor')).rows[0].actor)).toBe('clinical_core_api');
});
it('same ledger does not bypass changed compiled function authority', async () => {
  let entered = false;
  const changed = messagePins.map((p, i) => i ? p : { ...p, sha256: 'f'.repeat(64) });
  await expect(bindCareMessagingDatabase(database, { functions: changed }).transaction(async () => { entered = true; })).rejects.toThrow('service_unavailable');
  expect(entered).toBe(false);
});

const source = { ...SUCCESSOR_QUALIFICATION_RELEASE, sourceCommit: '1'.repeat(40), sourceClean: true, sourceInputSha256: '2'.repeat(64) };
const review = '3'.repeat(64); // Local review-shaped fixture, never a human review or AWS release.
const subject = (who: string) => 'fictional-' + who;
async function fixture() {
  const [org, owner, other, staff, patient, connection, artifact] = Array.from({ length: 7 }, () => randomUUID());
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL EMBEDDED TEST')", [org]);
  for (const [who, pool] of [[owner, 'consumer'], [other, 'consumer'], [staff, 'workforce']]) {
    await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who, 'subject_' + who.replaceAll('-', '')]);
    await pg.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [who, pool, subject(who)]);
  }
  await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, staff]);
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')", [patient, org, 'patient_test_' + patient.replaceAll('-', '')]);
  await pg.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [connection, org, patient, owner]);
  await pg.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
    values($1,$2,'messaging','fictional-embedded-test',$3,'TEST','approved',now(),$4)`, [artifact, org, 'a'.repeat(64), staff]);
  await pg.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id)
    values($1,$2,$3,$4,'messaging','granted','patient_app','self',1,$5)`, [org, patient, connection, artifact, owner]);
  const now = Date.now();
  const environment: Record<string, string> = { SOURCE_COMMIT: source.sourceCommit, SOURCE_INPUT_SHA256: source.sourceInputSha256,
    SUCCESSOR_QUALIFICATION_PROFILE: source.qualificationProfile, MIGRATION_RELEASE_SHA256: source.migrationReleaseSha256,
    MIGRATION_ASSEMBLY_SHA256: source.migrationAssemblySha256, AWS_REGION: 'us-east-2', DEPLOYMENT_ACCOUNT_ID: '588966314750',
    PHI_ALLOWED: 'false', CARE_MESSAGING_ACTIVATION: 'blocked', CARE_CONNECTIONS_ACTIVATION: 'blocked',
    CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
    WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26),
    CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
    CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/runtime-api-fictional-AbCd12',
    CLINICAL_DATABASE_NAME: 'clinical_core_qualification', CARE_MESSAGING_ORGANIZATION_ID: org, CARE_CONNECTIONS_ORGANIZATION_ID: org,
    DATABASE_REVIEW_SHA256: review, WORKFORCE_MFA_REVIEW_SHA256: review, MESSAGING_REVIEW_SHA256: review, RETENTION_REVIEW_SHA256: review,
    CONNECTION_REVIEW_SHA256: review, CONSENT_REVIEW_SHA256: review, ENABLED_CONSENT_SCOPES: 'messaging',
    CARE_CLAIM_RECOVERY_ENABLED: 'true', CARE_CLAIM_RECOVERY_REVIEW_SHA256: review,
    QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: review, QUALIFICATION_ACCOUNT_ID: '588966314750',
    QUALIFICATION_IDENTITY_SUBJECTS: [owner, other, staff].map(subject).join(',') };
  const event = (route: 'messages' | 'connection', body: unknown, who = owner, pool: 'consumer' | 'workforce' = 'consumer'): ApiGatewayV2Event => ({
    routeKey: `POST /clinical-core/${pool}/${route}`, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: environment[pool === 'consumer' ? 'CONSUMER_ISSUER' : 'WORKFORCE_ISSUER'],
      aud: environment[pool === 'consumer' ? 'CONSUMER_AUDIENCE' : 'WORKFORCE_AUDIENCE'], sub: subject(who), token_use: 'id',
      'custom:person_id': who, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: true,
      iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 1000, auth_time: Math.floor(now / 1000) - 10 } } } },
  });
  return { org, owner, other, staff, patient, connection, now, environment, event };
}
it('117 messaging executes real guarded SQL and enforces owner and withdrawal authority', async () => {
  const f = await fixture();
  const handle = createSuccessorCareMessagingHandler(f.environment, { ...source, functions: messagePins }, () => database, () => f.now);
  const sent = await handle(f.event('messages', { action: 'send', requestId: randomUUID(), connectionId: f.connection,
    subject: 'Fictional question', body: 'FICTIONAL test message', acknowledgement: 'care-messages/1' }));
  expect(sent).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
  const { threadId } = JSON.parse(sent.body).data;
  expect(await handle(f.event('messages', { action: 'read', threadId }, f.staff, 'workforce'))).toMatchObject({ statusCode: 200 });
  expect(await handle(f.event('messages', { action: 'read', threadId }, f.other))).toMatchObject({ statusCode: 403 });
  await pg.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,representative_authority,reason_code,version,recorded_by_person_id)
    values($1,$2,$3,'messaging','revoked','patient_app','self','patient_request',2,$4)`, [f.org, f.patient, f.connection, f.owner]);
  expect(await handle(f.event('messages', { action: 'read', threadId }))).toMatchObject({ statusCode: 403 });
});
it('117 connections and independently reviewed recovery execute their actual guarded SQL', async () => {
  const f = await fixture();
  const handle = createSuccessorCareConnectionsHandler(f.environment, { ...source, functions: connectionPins, claimFunctions: claimPins }, () => database, () => f.now);
  const connected = await handle(f.event('connection', { action: 'connection' }));
  expect(connected).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
  expect(JSON.parse(connected.body).data.connection.connectionId).toBe(f.connection);
  const requestId = randomUUID();
  const recovered = await handle({ ...f.event('connection', { action: 'receipt', requestId }), routeKey: CARE_CLAIM_RECOVERY_ROUTE });
  expect(recovered).toMatchObject({ statusCode: 200, body: JSON.stringify({ data: { requestId, status: 'unresolved' } }) });
});
it('historical 106 and 107 factories still refuse the 117 build without data construction', async () => {
  const f = await fixture(); let entered = false;
  const factory = () => { entered = true; return database; };
  const messageBuild = { ...source, functions: messagePins }, connectionBuild = { ...source, functions: connectionPins, claimFunctions: claimPins };
  for (const handle of [
    createCareMessagingHandler(f.environment, messageBuild as unknown as CareMessagingBuild, factory),
    createInventoryCareMessagingHandler(f.environment, messageBuild as unknown as InventoryCareMessagingBuild, factory),
    createCareConnectionsHandler(f.environment, connectionBuild as unknown as CareConnectionsBuild, factory),
    createInventoryCareConnectionsHandler(f.environment, connectionBuild as unknown as InventoryCareConnectionsBuild, factory),
  ]) expect(await handle(f.event('messages', { action: 'list' }))).toMatchObject({ statusCode: 503 });
  expect(entered).toBe(false);
});
