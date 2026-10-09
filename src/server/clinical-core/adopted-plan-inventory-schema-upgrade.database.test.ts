import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { ADOPTED_INVENTORY_UPGRADE, runAdoptedInventorySchemaUpgrade } from './adopted-plan-inventory-schema-upgrade';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const c: QualificationUpgradeConfiguration = { expectedAccountId: '588966314750', region: 'us-east-2', phiAllowed: false, activation: 'blocked',
  clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional',
  qualificationDatabaseName: 'clinical_core_qualification', stagingDatabaseName: 'clinical_core',
  fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from, toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to };
let pg: PGlite, migrations: ClinicalCoreMigration[];
const org = randomUUID(), person = randomUUID(), patient = randomUUID();
type Intercept = (sql: string, tx: { query: (sql: string, args?: unknown[]) => Promise<unknown> }) => Promise<void>;
// Only the local engine's database name is modeled. All SQL, locks, actual
// metadata/ACL checks, fingerprints and rollbacks execute in PGlite.
const db = (intercept?: Intercept, observedName = 'clinical_core_qualification'): ClinicalCoreDatabase => ({
  transaction: work => pg.transaction(async tx => work({ query: async (sql, args = []) => {
    if (intercept) await intercept(sql, tx);
    if (sql === 'select current_database() as name') return { rows: [{ name: observedName }] };
    return tx.query(sql, [...args]);
  } } as ClinicalCoreTransaction)),
});
const run = async (command: 'inspect' | 'rehearse' | 'upgrade', database = db()) => {
  const rehearsal = command === 'upgrade' ? await runAdoptedInventorySchemaUpgrade(db(), migrations, c, 'rehearse') : undefined;
  return runAdoptedInventorySchemaUpgrade(database, migrations, c, command, rehearsal);
};
const predecessor = async () => {
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.schema_migrations')).rows[0].n).toBe(106);
  expect((await pg.query<{ absent: boolean }>("select to_regprocedure('clinical_core.get_owned_plan_inventory_source()') is null absent")).rows[0].absent).toBe(true);
};
beforeAll(async () => {
  const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 }));
  migrations = a.manifest.migrations.map((m: { version: string; file: string }) => ({
    version: m.version, name: m.file.slice(15, -4), sql: a.files[m.file], sha256: sha(a.files[m.file]),
  }));
  pg = new PGlite({ extensions: { pgcrypto } });
  await applyProductionClinicalCoreMigrations(db(), migrations.slice(0, 106));
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL inventory upgrade')", [org]);
  await pg.query("insert into clinical_core.persons(id,subject_key) values($1,'subject_fictional_inventory_upgrade')", [person]);
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,'patient_fictional_inventory_upgrade','Fictional','Upgrade')", [patient, org]);
}, 60000);
afterAll(async () => { await pg?.close(); });

describe('distinct preserving 106 to 107 inventory transition, actual embedded SQL not hosted evidence', () => {
  it('inspects read only and reports the exact parent with no approval or rows added', async () => {
    const queries: string[] = [];
    expect(await run('inspect', db(async sql => { queries.push(sql); }))).toMatchObject({
      observedMigrationCount: 106, tableCount: 209, rowCount: 3, applied: false, dataPreserved: true, phiAllowed: false,
    });
    expect(queries[0]).toContain('read only'); expect(queries.some(q => /^(create|alter|insert|update|delete)/i.test(q))).toBe(false);
  });
  it('rehearses actual DDL and verifies the complete historical schema and rows after rollback', async () => {
    const before = await run('inspect');
    expect(await run('rehearse')).toMatchObject({ observedMigrationCount: 106, applied: false, rolledBack: true,
      historicalSchemaSha256: before.historicalSchemaSha256, dataSha256: before.dataSha256, rowCount: 3 });
    await predecessor();
  });
  it('refuses activation, a wrong account/region/database or artifact before opening a transaction', async () => {
    let opened = false;
    const never: ClinicalCoreDatabase = { transaction: async () => { opened = true; throw Error('must not open'); } };
    for (const change of [{ phiAllowed: true }, { activation: 'approved' }, { expectedAccountId: '173535830222' },
      { region: 'us-west-2' }, { qualificationDatabaseName: 'clinical_core' }, { toReleaseSha256: 'e'.repeat(64) }]) {
      await expect(runAdoptedInventorySchemaUpgrade(never, migrations, { ...c, ...change } as QualificationUpgradeConfiguration, 'rehearse')).rejects.toThrow();
    }
    for (const changed of [migrations.slice(0, 106), [...migrations, migrations[106]],
      migrations.map((m, i) => i === 106 ? { ...m, name: 'unreviewed_receipt' } : m),
      migrations.map((m, i) => i === 0 || i === 106 ? { ...m, sql: m.sql + '\nselect 1;', sha256: sha(m.sql + '\nselect 1;') } : m)]) {
      await expect(runAdoptedInventorySchemaUpgrade(never, changed, c, 'rehearse')).rejects.toThrow('artifact_refused');
    }
    await expect(runAdoptedInventorySchemaUpgrade(never, migrations, c, 'upgrade')).rejects.toThrow('boundary_refused');
    expect(opened).toBe(false);
  });
  it('refuses an observed staging database and an occupied migration lock without DDL', async () => {
    await expect(run('rehearse', db(undefined, 'clinical_core'))).rejects.toThrow('boundary_refused');
    const locked: ClinicalCoreDatabase = { transaction: work => db().transaction(tx => work({
      query: (sql, args) => sql.startsWith('select pg_try_advisory') ? Promise.resolve({ rows: [{ acquired: false }] }) : tx.query(sql, args),
    } as ClinicalCoreTransaction)) };
    await expect(run('rehearse', locked)).rejects.toThrow('upgrade_busy'); await predecessor();
  });
  it('refuses ledger drift admitted during table-lock waiting before successor DDL', async () => {
    const queries: string[] = [];
    await expect(run('rehearse', db(async (sql, tx) => {
      queries.push(sql);
      if (sql.startsWith('lock table ')) await tx.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', ['f'.repeat(64), migrations[0].version]);
    }))).rejects.toMatchObject({ category: 'history_refused', stage: 'writer_history' });
    expect(queries[0]).toBe('set transaction isolation level read committed');
    expect(queries.some(q => /^create function/i.test(q))).toBe(false); await predecessor();
  });
  it('refuses a changed prestate after rehearsal instead of committing against stale admission', async () => {
    const rehearsal = await run('rehearse');
    await pg.query("update clinical_core.patient_records set first_name='FICTIONAL changed' where id=$1", [patient]);
    try { await expect(runAdoptedInventorySchemaUpgrade(db(), migrations, c, 'upgrade', rehearsal)).rejects.toMatchObject({ category: 'data_changed', stage: 'rehearsal_admission' }); }
    finally { await pg.query("update clinical_core.patient_records set first_name='Fictional' where id=$1", [patient]); }
    await predecessor();
  });
  it.each([
    "update clinical_core.patient_records set first_name='FICTIONAL mutation'",
    'grant select(first_name) on clinical_core.patient_records to clinical_core_api',
    'alter table clinical_core.patient_records disable row level security',
    'alter table clinical_core.patient_records disable trigger all',
    'alter table clinical_core.patient_records replica identity full',
    'alter table clinical_core.patient_records alter first_name set statistics 100',
    "alter function clinical_private.owned_consumer_actor() set search_path=public",
    'grant usage on schema clinical_private to public',
    'create function clinical_private.unreviewed_inventory_helper() returns int language sql as $$select 1$$',
    "create type clinical_private.unreviewed_inventory_mode as enum ('unreviewed')",
    'alter default privileges in schema clinical_core grant execute on functions to public',
    "update clinical_core.schema_migrations set name='unreviewed historical receipt' where version='20261006030000'",
    'create index unreviewed_inventory_index on clinical_core.patient_records(first_name)',
    'alter role clinical_core_api bypassrls',
    'grant execute on function clinical_core.get_owned_plan_inventory_source() to public',
    'grant execute on function clinical_core.get_owned_plan_inventory_source() to pg_read_all_data',
    'grant execute on function clinical_core.get_owned_plan_inventory_source() to clinical_core_api with grant option',
    'alter function clinical_core.get_owned_plan_inventory_source() strict',
    'alter function clinical_core.get_owned_plan_inventory_source() leakproof',
    'alter function clinical_core.get_owned_plan_inventory_source() parallel safe',
    'alter function clinical_core.get_owned_plan_inventory_source() owner to clinical_core_api',
    "alter function clinical_core.get_owned_plan_inventory_source() set search_path=public",
    'revoke execute on function clinical_core.verify_product_ingredient_inventory(uuid,jsonb) from clinical_core_api',
    'create function clinical_core.get_owned_plan_inventory_source(text) returns int language sql as $$select 1$$',
  ])('rolls back row/schema/ACL/role/contract drift at receipt: %s', async mutation => {
    const before = await run('inspect');
    await expect(run('rehearse', db(async (sql, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations')) await tx.query(mutation);
    }))).rejects.toBeDefined();
    const after = await run('inspect');
    expect(after.dataSha256).toBe(before.dataSha256); expect(after.historicalSchemaSha256).toBe(before.historicalSchemaSha256);
    await predecessor();
  });
  it('refuses a relabeled successor receipt after its insert, before certification', async () => {
    await expect(run('rehearse', db(async (sql, tx) => {
      // The early history read has no successor to update. The final read is
      // after the actual INSERT and must detect the changed new receipt.
      if (sql === 'select version,name,sha256 from clinical_core.schema_migrations order by version') {
        await tx.query("update clinical_core.schema_migrations set name='unreviewed successor receipt' where version='20261009010000'");
      }
    }))).rejects.toMatchObject({ category: 'history_refused', stage: 'final_history' });
    await predecessor();
  });
  // This compound case performs an inspection and two complete rehearsal/write
  // cycles over 209 real tables. Its test deadline is separate from the actual
  // operator's unchanged 5-second lock and 30-second statement limits.
  it('commits exactly one schema row with no data or review mutation, and replay does not recreate functions', async () => {
    const before = await run('inspect'), queries: string[] = [];
    expect(await run('upgrade')).toMatchObject({ applied: true, alreadyApplied: false, observedMigrationCount: 107,
      historicalSchemaSha256: before.historicalSchemaSha256, dataSha256: before.dataSha256, rowCount: 3 });
    expect(await run('upgrade', db(async sql => { queries.push(sql); }))).toMatchObject({ applied: false, alreadyApplied: true, observedMigrationCount: 107 });
    expect(queries.some(q => /^(create|alter|insert|update|delete)/i.test(q))).toBe(false);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_reference.product_label_verifications')).rows[0].n).toBe(0);
  }, 30000);
});
