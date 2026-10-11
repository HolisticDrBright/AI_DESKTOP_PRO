import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { ClinicalCoreDatabase } from './database';
import { successorQualificationReleaseArtifact } from '../../../scripts/successor-qualification-release.mjs';
import { assertTelehealthRequestAuthorityRows, telehealthRequestAuthorityCandidate } from '../../../scripts/telehealth-request-authority-candidate.mjs';
import { createTelehealthRequestAuthority } from './telehealth-request-authority';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { classifyDatabaseRejection } from './rds-data-database';

// Real parent SQL and API role. Local fictional identities/copies only.
// The positive check first failed against the unchanged 117 parent with the
// real missing RPC. Final tests require the distinct pinned 118 artifact.
let pg: PGlite;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const extensionFile = 'infra/aws-clinical-core/source-candidates/telehealth-request-authority.sql';
const version = '20261011180000';
let extensionSql: string;
let artifactRows: { version: string; name: string; sha256: string }[];
const database: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  return work({ query: async (sql, values = []) => {
    const parameters = values.map(v => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v);
    try { return await tx.query(sql, parameters); }
    catch (error) { throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: error instanceof Error ? error.message : '' }) ?? error; }
  } });
}) };
beforeAll(async () => {
  const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-transfer-authority-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
  expect(successorQualificationReleaseArtifact(a).executionAllowed).toBe(false);
  extensionSql = readFileSync(extensionFile, 'utf8').replace(/\r\n?/g, '\n');
  const candidate = telehealthRequestAuthorityCandidate(a, extensionSql);
  const migrations = candidate.manifest.migrations.map((r: { version: string; file: string }) => ({
    version: r.version, name: r.file.slice(15, -4), sql: candidate.files[r.file], sha256: sha(candidate.files[r.file]),
  }));
  artifactRows = migrations.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
  assertTelehealthRequestAuthorityRows(artifactRows);
  const bootstrap = new PGlite({ extensions: { pgcrypto } });
  await bootstrap.exec('create database clinical_core_qualification');
  const localData = await bootstrap.dumpDataDir('none'); await bootstrap.close();
  pg = new PGlite({ loadDataDir: localData, database: 'clinical_core_qualification', extensions: { pgcrypto } });
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, values = []) => tx.query(sql, [...values]) })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  await pg.transaction(async tx => {
    for (const m of migrations.slice(106)) {
      await tx.exec(m.sql);
      await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [m.version, m.name, m.sha256]);
    }
  });
}, 60000);
afterAll(async () => { await pg?.close(); });

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
  const text = 'FICTIONAL appointment sharing copy for local software tests only. No patient approval.';
  await pg.query("insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,$2,'appointments','fictional-test',$3,'TEST','approved',now(),$4)", [artifactId, org, sha(text), staff]);
  await pg.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)', [artifactId, org, text, sha(text)]);
  const call = (who = owner, pool = 'consumer', body: unknown = { action: 'consumer_appointments' }, organization = org, subject = 'fictional-' + who) =>
    pg.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [who, organization, pool, subject, 'clinical_data', 'production-clinical', 'clinical_phi']);
      return (await tx.query<{ data: Record<string, unknown> }>('select clinical_core.production_telehealth_request_authority($1::jsonb) as data', [JSON.stringify(body)])).rows[0].data;
    });
  await pg.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [owner, org, 'consumer', 'fictional-' + owner, 'consent_management', 'production-clinical', 'clinical_phi']);
    await tx.query('select clinical_core.production_care_connection_request($1::jsonb)', [JSON.stringify({ action: 'grant', connectionId: connection,
      scope: 'appointments', artifactId, contentSha256: sha(text), expectedVersion: 0 })]);
  });
  const context = (who = owner, pool: 'consumer' | 'workforce' = 'consumer', organization = org): ProductionClinicalRequestContext => ({
    actorPersonId: who, organizationId: organization, identityPool: pool, identitySubject: 'fictional-' + who,
    purpose: 'clinical_data', environment: 'production-clinical', dataClassification: 'clinical_phi',
    productionBound: true, containsPhi: true, realPatientData: true,
  });
  return { org, foreignOrg, owner, other, staff, outsider, patient, connection, artifactId, text, call, context };
}

it('observes the current consumer, approved appointment grant and whole exact release through the API role', async () => {
  const f = await fixture(), response = await f.call();
  expect(response.contract).toBe('telehealth-request-authority-observation/1');
  expect(response.actorPersonId).toBe(f.owner);
  expect(response.patientRecordId).toBe(f.patient);
  expect(response.connectionId).toBe(f.connection);
  expect(response.appointmentsConsent).toMatchObject({ artifactId: f.artifactId, version: 1 });
  expect(response.migrationLedger).toHaveLength(118);
});

it('keeps raw migration-ledger reads denied to the API role', async () => {
  await expect(pg.transaction(async tx => { await tx.exec('set local role clinical_core_api');
    await tx.query('select * from clinical_core.schema_migrations'); })).rejects.toThrow(/permission denied/);
});

it('runs the compiled observation port through the real API role without clinical or audit writes', async () => {
  const f = await fixture();
  const before = (await pg.query('select (select count(*) from clinical_core.consent_grants)::int grants,(select count(*) from clinical_audit.events)::int events')).rows;
  const r = await createTelehealthRequestAuthority(database)(f.context(), { action: 'consumer_appointments' });
  expect(r.databaseName).toBe('clinical_core_qualification');
  expect(r.migrationLedger).toEqual(artifactRows);
  expect(r.appointmentsConsent).toMatchObject({ artifactId: f.artifactId, contentSha256: sha(f.text), version: 1 });
  expect(JSON.stringify(r)).not.toContain(f.text);
  expect(JSON.stringify(r)).not.toContain('FICTIONAL');
  expect((await pg.query('select (select count(*) from clinical_core.consent_grants)::int grants,(select count(*) from clinical_audit.events)::int events')).rows).toEqual(before);
});

it('allows the current clinic workforce observation and binds an optional active patient independently', async () => {
  const f = await fixture(), port = createTelehealthRequestAuthority(database);
  expect(await port(f.context(f.staff, 'workforce'), { action: 'workforce_appointments' })).toMatchObject({
    patientRecordId: null, connectionId: null, appointmentsConsent: null,
  });
  expect(await port(f.context(f.staff, 'workforce'), { action: 'workforce_appointments', patientRecordId: f.patient })).toMatchObject({ patientRecordId: f.patient });
  await expect(port(f.context(f.outsider, 'workforce', f.foreignOrg), { action: 'workforce_appointments', patientRecordId: f.patient })).rejects.toMatchObject({ category: 'identity_refused' });
});

it.each(['other_owner', 'foreign_clinic', 'wrong_subject', 'wrong_pool', 'inactive_identity', 'inactive_person', 'inactive_clinic', 'inactive_membership'])('refuses %s with a safe current-identity refusal', async fault => {
  const f = await fixture(), c = f.context();
  if (fault === 'other_owner') { c.actorPersonId = f.other; c.identitySubject = 'fictional-' + f.other; }
  if (fault === 'foreign_clinic') c.organizationId = f.foreignOrg;
  if (fault === 'wrong_subject') c.identitySubject = 'fictional-' + f.other;
  if (fault === 'wrong_pool') c.identityPool = 'workforce';
  if (fault === 'inactive_identity') await pg.query("update clinical_core.identities set status='disabled' where person_id=$1", [f.owner]);
  if (fault === 'inactive_person') await pg.query("update clinical_core.persons set status='disabled' where id=$1", [f.owner]);
  if (fault === 'inactive_clinic') await pg.query("update clinical_core.organizations set status='suspended' where id=$1", [f.org]);
  if (fault === 'inactive_membership') {
    Object.assign(c, f.context(f.staff, 'workforce'));
    await pg.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [f.staff]);
  }
  const body = fault === 'inactive_membership' ? { action: 'workforce_appointments' } : { action: 'consumer_appointments' };
  await expect(createTelehealthRequestAuthority(database)(c, body)).rejects.toMatchObject({ category: 'identity_refused' });
});

it.each(['paused', 'revoked', 'inactive_patient', 'withdrawn', 'retired', 'newer_release_without_copy'])('refuses new-sharing observation after %s without falling back', async fault => {
  const f = await fixture();
  if (fault === 'paused') await pg.query("update clinical_core.patient_connections set state='paused',paused_at=clock_timestamp() where id=$1", [f.connection]);
  if (fault === 'revoked') await pg.query("update clinical_core.patient_connections set state='revoked',revoked_at=clock_timestamp() where id=$1", [f.connection]);
  if (fault === 'inactive_patient') await pg.query("update clinical_core.patient_records set status='archived' where id=$1", [f.patient]);
  if (fault === 'withdrawn') await pg.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [f.owner, f.org, 'consumer', 'fictional-' + f.owner, 'consent_management', 'production-clinical', 'clinical_phi']);
    await tx.query('select clinical_core.production_care_connection_request($1::jsonb)', [JSON.stringify({ action: 'withdraw', connectionId: f.connection, scope: 'appointments', expectedVersion: 1 })]);
  });
  if (fault === 'retired') await pg.query("update clinical_core.consent_artifacts set status='retired' where id=$1", [f.artifactId]);
  if (fault === 'newer_release_without_copy') await pg.query("insert into clinical_core.consent_artifacts(organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,'appointments','fictional-new',$2,'TEST','approved',clock_timestamp(),$3)", [f.org, sha('new fictional copy'), f.staff]);
  await expect(createTelehealthRequestAuthority(database)(f.context(), { action: 'consumer_appointments' })).rejects.toMatchObject({
    category: ['paused', 'revoked', 'inactive_patient'].includes(fault) ? 'identity_refused' : 'consent_required',
  });
});

it.each([null, [], {}, { action: null }, { action: 'other' }, { action: 'consumer_appointments', actorPersonId: 'injected' },
  { action: 'workforce_appointments', patientRecordId: null }, { action: 'workforce_appointments', patientRecordId: 2 },
  { action: 'workforce_appointments', patientRecordId: 'invalid' }])('refuses malformed request at SQL and port: %j', async body => {
  const f = await fixture();
  await expect(f.call(f.owner, 'consumer', body)).rejects.toThrow('telehealth_request_invalid');
  await expect(createTelehealthRequestAuthority(database)(f.context(), body)).rejects.toMatchObject({ category: 'request_invalid' });
});

it.each(['missing_receipt', 'extra_receipt', 'parent_digest', 'parent_name', 'own_digest'])('refuses %s rather than accepting a partial/superset ledger', async fault => {
  const old = artifactRows.at(-1)!;
  try {
    if (fault === 'missing_receipt') await pg.query('delete from clinical_core.schema_migrations where version=$1', [version]);
    if (fault === 'extra_receipt') await pg.query("insert into clinical_core.schema_migrations(version,name,sha256) values('20261011190000','unrelated',$1)", ['1'.repeat(64)]);
    if (fault === 'parent_digest') await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', ['1'.repeat(64), artifactRows[0].version]);
    if (fault === 'parent_name') await pg.query("update clinical_core.schema_migrations set name='unrelated' where version=$1", [artifactRows[0].version]);
    if (fault === 'own_digest') await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', ['1'.repeat(64), version]);
    const f = await fixture();
    await expect(createTelehealthRequestAuthority(database)(f.context(), { action: 'consumer_appointments' })).rejects.toMatchObject({ category: 'release_required' });
  } finally {
    await pg.query("delete from clinical_core.schema_migrations where version='20261011190000'");
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3) on conflict(version) do update set name=excluded.name,sha256=excluded.sha256', [version, old.name, old.sha256]);
    await pg.query('update clinical_core.schema_migrations set name=$1,sha256=$2 where version=$3', [artifactRows[0].name, artifactRows[0].sha256, artifactRows[0].version]);
  }
});

it.each(['public_execute', 'body_drift', 'search_path', 'overload', 'helper_drift', 'private_table_grant'])('refuses live %s before data observation', async fault => {
  const definition = extensionSql.slice(extensionSql.indexOf('create function clinical_core.production_telehealth_request_authority'))
    .replace('create function ', 'create or replace function ');
  try {
    if (fault === 'public_execute') await pg.exec('grant execute on function clinical_core.production_telehealth_request_authority(jsonb) to public');
    if (fault === 'body_drift') await pg.exec(definition.replace('end $$;', () => 'end\n $$;'));
    if (fault === 'search_path') await pg.exec('alter function clinical_core.production_telehealth_request_authority(jsonb) set search_path=public');
    if (fault === 'overload') await pg.exec("create function clinical_core.production_telehealth_request_authority(text) returns jsonb language sql as 'select null::jsonb'");
    if (fault === 'helper_drift') await pg.exec('alter function clinical_private.care_connection_actor(text,text) set search_path=public');
    if (fault === 'private_table_grant') await pg.exec('grant select on clinical_core.care_consent_texts to clinical_core_api');
    const f = await fixture();
    await expect(createTelehealthRequestAuthority(database)(f.context(), { action: 'consumer_appointments' })).rejects.toMatchObject({
      category: ['helper_drift', 'private_table_grant'].includes(fault) ? 'service_unavailable' : 'release_required',
    });
  } finally {
    await pg.exec(definition);
    await pg.exec("drop function if exists clinical_core.production_telehealth_request_authority(text); alter function clinical_private.care_connection_actor(text,text) set search_path=''; revoke select on clinical_core.care_consent_texts from clinical_core_api");
  }
});

it('refuses DDL on any non-exact parent before changing functions', async () => {
  const original = (await pg.query('select count(*)::int n from pg_proc')).rows;
  await expect(pg.exec(extensionSql)).rejects.toThrow('telehealth_request_parent_refused');
  expect((await pg.query('select count(*)::int n from pg_proc')).rows).toEqual(original);
});
