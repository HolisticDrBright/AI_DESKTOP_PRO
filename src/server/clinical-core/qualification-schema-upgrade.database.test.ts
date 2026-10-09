import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { provisionQualificationFixtures } from './qualification-fixtures';
import { validateQualificationFixtureManifest } from './qualification-fixture-manifest';
import { EXPORT_RECOVERY_UPGRADE, runQualificationSchemaUpgrade, type QualificationUpgradeConfiguration } from './qualification-schema-upgrade';

const configuration: QualificationUpgradeConfiguration = {
  expectedAccountId: '588966314750', region: 'us-east-2', phiAllowed: false, activation: 'blocked',
  clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:synthetic-test',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:synthetic-test',
  qualificationDatabaseName: 'clinical_core_qualification', stagingDatabaseName: 'clinical_core',
  fromReleaseSha256: EXPORT_RECOVERY_UPGRADE.from, toReleaseSha256: EXPORT_RECOVERY_UPGRADE.to,
};
let pg: PGlite; let migrations: ClinicalCoreMigration[];
const unwrap = (v: unknown) => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v;
type Intercept = (sql: string, tx: { query: (sql: string, args?: unknown[]) => Promise<unknown> }) => Promise<void>;
// PGlite initializes only its default database. ONLY the database-name observation
// is a fixture here. All migration, lock, table, privilege and transaction SQL is real.
const database = (intercept?: Intercept, observedName = 'clinical_core_qualification'): ClinicalCoreDatabase => ({
  transaction: work => pg.transaction(async tx => work({ query: async (sql: string, args: readonly unknown[] = []) => {
    if (intercept) await intercept(sql, tx);
    if (sql === 'select current_database() as name') return { rows: [{ name: observedName }] };
    return tx.query(sql, args.map(unwrap));
  } } as ClinicalCoreTransaction)),
});
const inspect = () => runQualificationSchemaUpgrade(database(), migrations, configuration, 'inspect');
const upgrade = (db = database()) => runQualificationSchemaUpgrade(db, migrations, configuration, 'upgrade');
const remains102 = async () => {
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.schema_migrations')).rows[0].n).toBe(102);
  expect((await pg.query("select to_regprocedure('clinical_core.find_latest_owned_privacy_export_job()') is null as absent")).rows[0]).toEqual({ absent: true });
};
beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  // This operator remains pinned to its historical 102->103 transition.
  migrations = manifest.migrations.slice(0, 103).map((m: { version: string; file: string }) => ({ version: m.version, name: m.file.slice(15, -4), sql: files[m.file], sha256: createHash('sha256').update(files[m.file]).digest('hex') }));
  pg = new PGlite({ extensions: { pgcrypto } }); await pg.exec('create extension if not exists pgcrypto');
  await applyProductionClinicalCoreMigrations(database(), migrations.slice(0, 102));
  const legacy = JSON.parse(readFileSync('infra/aws-clinical-core/synthetic-acceptance-manifest.example.json', 'utf8'));
  const { isolationWorkforcePersonId, isolationWorkforceSubject, ...fixture } = legacy.fixture;
  const reviewed = validateQualificationFixtureManifest({ ...legacy, awsAccountId: '588966314750', schemaVersion: 'aws-clinical-core-qualification-fixtures/2',
    fixture: { ...fixture, workforceSubject: 'qualification-workforce', consumerSubject: 'qualification-consumer', isolationConsumerPersonId: isolationWorkforcePersonId, isolationConsumerSubject: isolationWorkforceSubject } });
  expect((await provisionQualificationFixtures(database(), reviewed, migrations.slice(0, 102), configuration)).inserted).toBe(24);
}, 120000);
afterAll(async () => { await pg?.close(); });

describe('data-preserving qualification upgrade using actual 102/103 artifacts', () => {
  it('sets writer isolation explicitly instead of inheriting a server default', async () => {
    const queries: string[] = [];
    await expect(upgrade(database(async sql => {
      queries.push(sql);
      if (sql.startsWith('lock table ')) throw Error('fictional stop before mutation');
    }))).rejects.toMatchObject({ category: 'upgrade_failed', stage: 'writer_locks' });
    expect(queries[0]).toBe('set transaction isolation level read committed');
    await remains102();
  });
  it('reproduces empty-installer refusal without losing seeded data or retaining new DDL', async () => {
    await expect(applyProductionClinicalCoreMigrations(database(), migrations)).rejects.toThrow('verification_failed');
    await remains102();
    expect((await pg.query('select count(*)::int n from clinical_core.persons')).rows[0]).toEqual({ n: 3 });
  });
  it('refuses configuration and tampered artifacts before connecting', async () => {
    let queried = false;
    const never: ClinicalCoreDatabase = { transaction: async () => { queried = true; throw new Error('unexpected'); } };
    for (const change of [{ phiAllowed: true }, { activation: 'approved' }, { expectedAccountId: '173535830222' }, { region: 'us-west-2' },
      { qualificationDatabaseName: 'clinical_core' }, { stagingDatabaseName: 'clinical_core_qualification' }, { fromReleaseSha256: 'a'.repeat(64) },
      { toReleaseSha256: 'b'.repeat(64) }, { secretArn: 'arn:aws:secretsmanager:us-east-2:173535830222:secret:wrong' }]) {
      await expect(runQualificationSchemaUpgrade(never, migrations, { ...configuration, ...change } as QualificationUpgradeConfiguration, 'upgrade')).rejects.toThrow();
    }
    for (const altered of [migrations.slice(0, 102), [...migrations, migrations[102]], migrations.map((m, i) => i === 102 ? { ...m, sql: m.sql + '\nselect 1;' } : m),
      migrations.map((m, i) => i === 1 ? { ...m, sha256: 'a'.repeat(64) } : m)]) {
      await expect(runQualificationSchemaUpgrade(never, altered, configuration, 'upgrade')).rejects.toThrow('artifact_refused');
    }
    expect(queried).toBe(false);
  });
  it('inspects a stable snapshot without applying DDL or ledger writes', async () => {
    const commands: string[] = [];
    const result = await runQualificationSchemaUpgrade(database(async sql => { commands.push(sql); }), migrations, configuration, 'inspect');
    expect(result).toMatchObject({ applied: false, alreadyApplied: false, observedMigrationCount: 102, tableCount: 202, phiAllowed: false, activation: 'blocked', dataPreserved: true });
    expect(commands[0]).toBe('set transaction isolation level repeatable read read only');
    expect(commands.some(sql => /^(insert|alter|create|update|delete|lock)/i.test(sql))).toBe(false);
    await remains102();
  });
  it('refuses the actual wrong database and an occupied operator lock', async () => {
    await expect(upgrade(database(undefined, 'clinical_core'))).rejects.toThrow('boundary_refused');
    const busy: ClinicalCoreDatabase = { transaction: work => database().transaction(tx => work({ query: async (sql: string, args?: readonly unknown[]) => sql.includes('pg_try_advisory') ? { rows: [{ acquired: false }] } : tx.query(sql, args) } as ClinicalCoreTransaction)) };
    await expect(upgrade(busy)).rejects.toThrow('upgrade_busy'); await remains102();
  });
  it('refuses extra or mismatched ledger entries without repairing history', async () => {
    await pg.query("insert into clinical_core.schema_migrations(version,name,sha256) values('20260101000000','unknown',$1)", ['a'.repeat(64)]);
    try { await expect(upgrade()).rejects.toThrow('history_refused'); } finally { await pg.query("delete from clinical_core.schema_migrations where version='20260101000000'"); }
    await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', ['b'.repeat(64), migrations[0].version]);
    try { await expect(upgrade()).rejects.toThrow('history_refused'); } finally { await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', [migrations[0].sha256, migrations[0].version]); }
    await remains102();
  });
  it('rolls back DDL when the ledger receipt fails', async () => {
    await expect(upgrade(database(async sql => { if (sql.startsWith('insert into clinical_core.schema_migrations')) throw new Error('simulated receipt loss'); }))).rejects.toThrow('upgrade_failed');
    await remains102();
  });
  it('detects a same-count data mutation and rolls it back with the DDL', async () => {
    const before = await inspect();
    await expect(upgrade(database(async (sql, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations')) await tx.query("update clinical_core.organizations set organization_label='Synthetic changed label'");
    }))).rejects.toThrow('data_changed');
    expect((await inspect()).dataSha256).toBe(before.dataSha256); await remains102();
  });
  it('detects changed RLS and rolls it back without accepting matching row digests', async () => {
    await expect(upgrade(database(async (sql, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations')) await tx.query('alter table clinical_core.patient_records disable row level security');
    }))).rejects.toThrow('inventory_refused'); await remains102();
  });
  it('refuses missing final execution privilege and rolls the migration back', async () => {
    await expect(upgrade(database(async (sql, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations')) await tx.query('revoke execute on function clinical_core.find_latest_owned_privacy_export_job() from clinical_core_api');
    }))).rejects.toThrow('verification_failed'); await remains102();
  });
  it('refuses an unexpected application table', async () => {
    await pg.query('create table clinical_private.unreviewed_table(id int)');
    try { await expect(upgrade()).rejects.toThrow('inventory_refused'); } finally { await pg.query('drop table clinical_private.unreviewed_table'); }
    await remains102();
  });
  it('refuses a table beyond the bounded qualification inventory without applying DDL', async () => {
    // The bound applies to every inventoried table. Use real inactive domain
    // rows instead of 5,001 persons with dozens of incoming FKs; this keeps the
    // same SQL/refusal/deadline without making cleanup a relationship benchmark.
    await pg.query("insert into clinical_reference.clinical_domains(code,version,name,description) select 'upgrade_bound_'||i::text,1,'FICTIONAL bound fixture','FICTIONAL inactive domain for the 5000-row qualification bound' from generate_series(1,5001) i");
    const queries: string[] = [];
    try {
      expect((await pg.query<{ n: number }>("select count(*)::int n from clinical_reference.clinical_domains where code like 'upgrade_bound_%'")).rows[0].n).toBe(5001);
      await expect(upgrade(database(async sql => { queries.push(sql); }))).rejects.toThrow('inventory_refused');
      expect(queries.some(sql => /^(create|alter|insert)/i.test(sql))).toBe(false);
    } finally { await pg.query("delete from clinical_reference.clinical_domains where code like 'upgrade_bound_%'"); }
    await remains102();
  }, 60000); // Includes real 5,001-row fixture setup/cleanup; not an API latency assertion.
  it('upgrades exactly once, preserves every table fingerprint, and safely inspects/replays', async () => {
    const before = await inspect(); const queries: string[] = [];
    const applied = await upgrade(database(async sql => { queries.push(sql); }));
    expect(queries.filter(sql => sql.includes('string_agg')).length).toBe(22);
    expect(queries.filter(sql => sql.includes('string_agg')).every(sql => Buffer.byteLength(sql) <= 20000)).toBe(true);
    expect(applied).toMatchObject({ applied: true, alreadyApplied: false, observedMigrationCount: 103, tableCount: 202, dataPreserved: true, dataSha256: before.dataSha256, rowCount: before.rowCount });
    const replay = await upgrade(); expect(replay).toMatchObject({ applied: false, alreadyApplied: true, dataSha256: before.dataSha256 });
    expect(await inspect()).toMatchObject({ observedMigrationCount: 103, alreadyApplied: true, applied: false });
    expect(JSON.stringify(applied)).not.toMatch(/qualification-consumer|organization_label|secretArn|patientRecordId/);
  });
});
