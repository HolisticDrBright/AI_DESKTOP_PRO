import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { CARE_CONNECTIONS_UPGRADE, runCareConnectionsSchemaUpgrade } from './care-connections-schema-upgrade';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';

const configuration: QualificationUpgradeConfiguration = { expectedAccountId: '588966314750', region: 'us-east-2', phiAllowed: false,
  activation: 'blocked', clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:synthetic-test',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:synthetic-test',
  qualificationDatabaseName: 'clinical_core_qualification', stagingDatabaseName: 'clinical_core',
  fromReleaseSha256: CARE_CONNECTIONS_UPGRADE.from, toReleaseSha256: CARE_CONNECTIONS_UPGRADE.to };
let pg: PGlite; let migrations: ClinicalCoreMigration[];
const org = randomUUID(), person = randomUUID(), patient = randomUUID(), conversation = randomUUID(), artifact = randomUUID();
const copy = 'FICTIONAL TEST ONLY: share fictional messages. No real personal or health data.';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Intercept = (sql: string, tx: { query: (sql: string, args?: unknown[]) => Promise<unknown> }) => Promise<void>;
// Only current_database() is substituted. SQL, privileges, fingerprints and
// transactional rollback are real; PGlite is not hosted or concurrent evidence.
const database = (intercept?: Intercept, observedName = 'clinical_core_qualification'): ClinicalCoreDatabase => ({
  transaction: work => pg.transaction(async tx => work({ query: async (sql: string, args: readonly unknown[] = []) => {
    if (intercept) await intercept(sql, tx);
    if (sql === 'select current_database() as name') return { rows: [{ name: observedName }] };
    return tx.query(sql, args.map(v => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v));
  } } as ClinicalCoreTransaction)),
});
const run = (command: 'inspect' | 'rehearse' | 'upgrade', db = database()) => runCareConnectionsSchemaUpgrade(db, migrations, configuration, command);
const predecessor = async () => {
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.schema_migrations')).rows[0]?.n).toBe(104);
  expect((await pg.query("select to_regclass('clinical_core.care_consent_texts') is null absent")).rows[0]).toEqual({ absent: true });
};
const atReceipt = (change: (tx: Parameters<Intercept>[1]) => Promise<void>) => database(async (sql, tx) => {
  if (sql.startsWith('insert into clinical_core.schema_migrations')) await change(tx);
});
beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 }));
  expect(manifest.migrations).toHaveLength(106);
  migrations = manifest.migrations.slice(0, 105).map((m: { version: string; file: string }) => ({ version: m.version, name: m.file.slice(15, -4),
    sql: files[m.file], sha256: sha(files[m.file]) }));
  pg = new PGlite({ extensions: { pgcrypto } });
  expect((await applyProductionClinicalCoreMigrations(database(), migrations.slice(0, 104))).tableCount).toBe(127);
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL qualification')", [org]);
  await pg.query("insert into clinical_core.persons(id,subject_key) values($1,'subject_fictional_connection_upgrade')", [person]);
  await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce','fictional-upgrade-staff',true)", [person]);
  await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, person]);
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,'patient_fictional_connection_upgrade','Fictional','Upgrade')", [patient, org]);
  await pg.query("insert into clinical_core.conversations(id,organization_id,patient_record_id,subject,category,priority,created_by_person_id) values($1,$2,$3,'FICTIONAL old thread','patient_app','medium',$4)", [conversation, org, patient, person]);
  await pg.query("insert into clinical_core.messages(organization_id,conversation_id,sender_person_id,body,status) values($1,$2,$3,'FICTIONAL original draft','draft')", [org, conversation, person]);
  // This approval belongs only to the fictional local failure-injection fixture.
  await pg.query("insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,$2,'messaging','FICTIONAL-test/1',$3,'TEST','approved',clock_timestamp(),$4)", [artifact, org, sha(copy), person]);
}, 60000);
afterAll(async () => { await pg?.close(); });

describe('unreleased preserving connection 104->105 qualification upgrade', () => {
  it('uses fresh writer statement snapshots before bounded table-lock admission', async () => {
    const queries: string[] = [];
    await expect(run('upgrade', database(async sql => {
      queries.push(sql);
      if (sql.startsWith('lock table ')) throw Error('fictional stop before mutation');
    }))).rejects.toMatchObject({ category: 'upgrade_failed', stage: 'writer_locks' });
    expect(queries[0]).toBe('set transaction isolation level read committed');
    expect(queries.some(sql => /^(create|alter|insert|update|delete)/i.test(sql))).toBe(false);
    await predecessor();
  });
  it('refuses ledger drift at lock admission before successor DDL', async () => {
    const queries: string[] = [];
    // A real local ledger update at the modeled admission boundary. This is
    // rollback/order evidence, not a real concurrent or hosted writer.
    const changed = database(async (sql, tx) => {
      queries.push(sql);
      if (sql.startsWith('lock table ')) await tx.query(
        'update clinical_core.schema_migrations set sha256=$1 where version=$2',
        ['f'.repeat(64), migrations[0].version]);
    });
    await expect(run('upgrade', changed)).rejects.toMatchObject({ category: 'history_refused', stage: 'writer_history' });
    expect(queries.some(sql => /^(create|alter|insert|update|delete)/i.test(sql))).toBe(false);
    await predecessor();
    await run('inspect');
  });
  it('refuses account, region, production, staging and wrong release before connecting', async () => {
    let queried = false;
    const never: ClinicalCoreDatabase = { transaction: async () => { queried = true; throw new Error('unexpected'); } };
    for (const change of [{ phiAllowed: true }, { activation: 'approved' }, { expectedAccountId: '173535830222' }, { region: 'us-west-2' },
      { qualificationDatabaseName: 'clinical_core' }, { stagingDatabaseName: 'clinical_core_qualification' },
      { fromReleaseSha256: 'a'.repeat(64) }, { toReleaseSha256: 'b'.repeat(64) }]) {
      await expect(runCareConnectionsSchemaUpgrade(never, migrations, { ...configuration, ...change } as QualificationUpgradeConfiguration, 'upgrade')).rejects.toThrow();
    }
    for (const altered of [migrations.slice(0, 104), [...migrations, migrations[104]],
      migrations.map((m, i) => i === 104 ? { ...m, sql: m.sql + '\nselect 1;', sha256: sha(m.sql + '\nselect 1;') } : m),
      migrations.map((m, i) => i === 0 ? { ...m, sha256: 'f'.repeat(64) } : m)]) {
      await expect(runCareConnectionsSchemaUpgrade(never, altered, configuration, 'upgrade')).rejects.toThrow('artifact_refused');
    }
    expect(queried).toBe(false);
  });
  it('inspects read-only and refuses the actual staging observation', async () => {
    const queries: string[] = [];
    expect(await run('inspect', database(async sql => { queries.push(sql); }))).toMatchObject({ observedMigrationCount: 104,
      tableCount: 206, applied: false, alreadyApplied: false, phiAllowed: false, rowCount: 8 });
    expect(queries[0]).toContain('read only'); expect(queries.some(q => /^(insert|update|create|alter)/i.test(q))).toBe(false);
    await expect(run('upgrade', database(undefined, 'clinical_core'))).rejects.toThrow('boundary_refused'); await predecessor();
  });
  it('rehearses DDL, functions and privileges then physically verifies rollback', async () => {
    const before = await run('inspect');
    expect(await run('rehearse')).toMatchObject({ command: 'rehearse', rolledBack: true, applied: false, observedMigrationCount: 104,
      tableCount: 206, dataSha256: before.dataSha256, rowCount: before.rowCount }); await predecessor();
  });
  it('refuses changed or unknown ledger entries', async () => {
    const old = migrations[0];
    await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', ['b'.repeat(64), old.version]);
    try { await expect(run('upgrade')).rejects.toThrow('history_refused'); }
    finally { await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', [old.sha256, old.version]); }
    await pg.query("insert into clinical_core.schema_migrations(version,name,sha256) values('20990101000000','unknown',$1)", ['f'.repeat(64)]);
    try { await expect(run('upgrade')).rejects.toThrow('history_refused'); }
    finally { await pg.query("delete from clinical_core.schema_migrations where version='20990101000000'"); }
    await predecessor();
  });
  it('keeps admitted SQL and configuration stable across asynchronous caller mutation', async () => {
    const supplied = migrations.map(m => ({ ...m })); const settings = { ...configuration };
    let mutated = false;
    const observed = await runCareConnectionsSchemaUpgrade(database(async () => {
      if (mutated) return; mutated = true;
      supplied[104].sql += '\nselect 1;'; supplied[104].sha256 = sha(supplied[104].sql);
      settings.toReleaseSha256 = 'f'.repeat(64); settings.qualificationDatabaseName = 'clinical_core';
      (settings as { phiAllowed: boolean }).phiAllowed = true;
    }), supplied, settings, 'rehearse');
    expect(observed).toMatchObject({ rolledBack: true, phiAllowed: false, observedMigrationCount: 104,
      toReleaseSha256: CARE_CONNECTIONS_UPGRADE.to }); await predecessor();
  });
  it('detects a same-count old row rewrite and a seeded new copy and rolls both back', async () => {
    const before = await run('inspect');
    for (const change of [
      async (tx: Parameters<Intercept>[1]) => { await tx.query("update clinical_core.messages set body='FICTIONAL changed' where status='draft'"); },
      async (tx: Parameters<Intercept>[1]) => { await tx.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)', [artifact, org, copy, sha(copy)]); },
    ]) {
      await expect(run('upgrade', atReceipt(change))).rejects.toThrow('data_changed');
      expect((await run('inspect')).dataSha256).toBe(before.dataSha256); await predecessor();
    }
  });
  it('refuses lost old RLS, new unforced RLS and added inventory', async () => {
    for (const sql of ['alter table clinical_core.patient_records disable row level security',
      'alter table clinical_core.care_consent_texts no force row level security', 'create table clinical_private.unreviewed_connection_table(id int)']) {
      await expect(run('upgrade', atReceipt(async tx => { await tx.query(sql); }))).rejects.toThrow('inventory_refused'); await predecessor();
    }
  });
  it('refuses PUBLIC/table/helper grants and lost API execution', async () => {
    for (const sql of ['grant select on clinical_core.care_consent_texts to clinical_core_api',
      'grant select on clinical_core.care_consent_texts to public',
      'grant truncate on clinical_core.care_consent_texts to clinical_core_api',
      'grant truncate on clinical_core.care_consent_texts to public',
      'grant select(content) on clinical_core.care_consent_texts to clinical_core_api',
      'grant select(content) on clinical_core.care_consent_texts to public',
      'grant execute on function clinical_private.care_connection_actor(text,text) to clinical_core_api',
      'grant execute on function clinical_core.production_care_connection_request(jsonb) to public',
      "alter function clinical_core.production_care_connection_request(jsonb) set search_path='public'",
      'alter function clinical_private.care_connection_actor(text,text) volatile',
      'revoke execute on function clinical_core.create_sync_invitation(uuid,uuid) from clinical_core_api']) {
      await expect(run('upgrade', atReceipt(async tx => { await tx.query(sql); }))).rejects.toThrow('verification_failed'); await predecessor();
    }
  });
  it('refuses a changed function body, disabled or rebound safety trigger', async () => {
    for (const sql of ["create or replace function clinical_core.production_care_connection_request(_request jsonb) returns jsonb language sql security definer set search_path='' as $$select '{}'::jsonb$$",
      'alter table clinical_core.consent_artifacts disable trigger care_consent_release_serialized',
      'drop trigger care_consent_texts_immutable on clinical_core.care_consent_texts; create trigger care_consent_texts_immutable before insert on clinical_core.care_consent_texts for each row execute function clinical_private.block_update_delete()']) {
      await expect(run('upgrade', atReceipt(async tx => {
        if (sql.startsWith('drop trigger')) {
          for (const statement of sql.split('; ')) await tx.query(statement);
        } else await tx.query(sql);
      }))).rejects.toThrow('verification_failed'); await predecessor();
    }
  });
  it('upgrades exactly once and verifies repeat inspection, replay and rollback with populated copy', async () => {
    const before = await run('inspect');
    expect(await run('upgrade')).toMatchObject({ observedMigrationCount: 105, tableCount: 207, applied: true, alreadyApplied: false,
      dataSha256: before.dataSha256, rowCount: before.rowCount, phiAllowed: false, activation: 'blocked' });
    await pg.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)', [artifact, org, copy, sha(copy)]);
    const after = await run('inspect'); expect(after).toMatchObject({ observedMigrationCount: 105, applied: false, alreadyApplied: true, rowCount: 9 });
    expect(await run('upgrade')).toMatchObject({ applied: false, alreadyApplied: true, dataSha256: after.dataSha256 });
    expect(await run('rehearse')).toMatchObject({ applied: false, alreadyApplied: true, rolledBack: true, dataSha256: after.dataSha256 });
    expect(JSON.stringify(after)).not.toMatch(/FICTIONAL|secretArn|subject_fictional|patientRecordId/);
  });
});
