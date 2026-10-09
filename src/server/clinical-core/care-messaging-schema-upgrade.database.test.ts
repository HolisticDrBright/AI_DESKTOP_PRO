import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { CARE_MESSAGING_UPGRADE, runCareMessagingSchemaUpgrade } from './care-messaging-schema-upgrade';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';

const configuration: QualificationUpgradeConfiguration = { expectedAccountId: '588966314750', region: 'us-east-2', phiAllowed: false,
  activation: 'blocked', clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:synthetic-test',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:synthetic-test',
  qualificationDatabaseName: 'clinical_core_qualification', stagingDatabaseName: 'clinical_core',
  fromReleaseSha256: CARE_MESSAGING_UPGRADE.from, toReleaseSha256: CARE_MESSAGING_UPGRADE.to };
let pg: PGlite; let migrations: ClinicalCoreMigration[];
const org = randomUUID(), person = randomUUID(), patient = randomUUID(), conversation = randomUUID();
type Intercept = (sql: string, tx: { query: (sql: string, args?: unknown[]) => Promise<unknown> }) => Promise<void>;
// Only current_database() is substituted: PGlite supports a single database.
// DDL, ledger, privileges, locks, row fingerprints and rollback SQL are real.
const database = (intercept?: Intercept, observedName = 'clinical_core_qualification'): ClinicalCoreDatabase => ({
  transaction: work => pg.transaction(async tx => work({ query: async (sql: string, args: readonly unknown[] = []) => {
    if (intercept) await intercept(sql, tx);
    if (sql === 'select current_database() as name') return { rows: [{ name: observedName }] };
    return tx.query(sql, args.map(v => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v));
  } } as ClinicalCoreTransaction)),
});
const run = (command: 'inspect' | 'rehearse' | 'upgrade', db = database()) => runCareMessagingSchemaUpgrade(db, migrations, configuration, command);
const predecessor = async () => {
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.schema_migrations')).rows[0]?.n).toBe(103);
  expect((await pg.query("select to_regclass('clinical_core.care_message_receipts') is null absent")).rows[0]).toEqual({ absent: true });
};
beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 }));
  migrations = manifest.migrations.slice(0, 104).map((m: { version: string; file: string }) => ({ version: m.version, name: m.file.slice(15, -4),
    sql: files[m.file], sha256: createHash('sha256').update(files[m.file]).digest('hex') }));
  pg = new PGlite({ extensions: { pgcrypto } });
  expect((await applyProductionClinicalCoreMigrations(database(), migrations.slice(0, 103))).tableCount).toBe(123);
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL qualification')", [org]);
  await pg.query("insert into clinical_core.persons(id,subject_key) values($1,'subject_fictional_care_upgrade')", [person]);
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,'patient_fictional_upgrade','Fictional','Upgrade')", [patient, org]);
  await pg.query("insert into clinical_core.conversations(id,organization_id,patient_record_id,subject,category,priority,created_by_person_id) values($1,$2,$3,'FICTIONAL old thread','patient_app','medium',$4)", [conversation, org, patient, person]);
  await pg.query("insert into clinical_core.messages(organization_id,conversation_id,sender_person_id,body,status) values($1,$2,$3,'FICTIONAL original draft','draft')", [org, conversation, person]);
}, 60000);
afterAll(async () => { await pg?.close(); });

describe('actual preserving qualification care-messaging 103->104 upgrade', () => {
  it('captures admitted artifacts before an asynchronous caller can rewrite them', async () => {
    const supplied = migrations.map(m => ({ ...m })), config = { ...configuration };
    const queries: string[] = []; let changed = false;
    const db = database(async sql => {
      queries.push(sql);
      if (changed) return;
      changed = true; supplied[103].sql += '\nselect 12345;'; Object.assign(config, { phiAllowed: true });
    });
    expect(await runCareMessagingSchemaUpgrade(db, supplied, config, 'rehearse'))
      .toMatchObject({ rolledBack: true, phiAllowed: false, observedMigrationCount: 103 });
    expect(queries).not.toContain('select 12345;'); await predecessor();
  });
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
  it('refuses production, staging, wrong region/account and artifact tampering before connecting', async () => {
    let queried = false;
    const never: ClinicalCoreDatabase = { transaction: async () => { queried = true; throw new Error('unexpected'); } };
    for (const change of [{ phiAllowed: true }, { activation: 'approved' }, { expectedAccountId: '173535830222' }, { region: 'us-west-2' },
      { qualificationDatabaseName: 'clinical_core' }, { stagingDatabaseName: 'clinical_core_qualification' },
      { fromReleaseSha256: 'a'.repeat(64) }, { toReleaseSha256: 'b'.repeat(64) }]) {
      await expect(runCareMessagingSchemaUpgrade(never, migrations, { ...configuration, ...change } as QualificationUpgradeConfiguration, 'upgrade')).rejects.toThrow();
    }
    for (const altered of [migrations.slice(0, 103), [...migrations, migrations[103]],
      migrations.map((m, i) => i === 103 ? { ...m, sql: m.sql + '\nselect 1;' } : m),
      migrations.map((m, i) => i === 0 ? { ...m, sha256: 'f'.repeat(64) } : m)]) {
      await expect(runCareMessagingSchemaUpgrade(never, altered, configuration, 'upgrade')).rejects.toThrow('artifact_refused');
    }
    expect(queried).toBe(false);
  });
  it('inspects read-only without modifying old rows or installing the new schema', async () => {
    const queries: string[] = [];
    expect(await run('inspect', database(async sql => { queries.push(sql); }))).toMatchObject({ observedMigrationCount: 103, tableCount: 202,
      applied: false, alreadyApplied: false, rolledBack: false, phiAllowed: false, rowCount: 5 });
    expect(queries[0]).toContain('read only'); expect(queries.some(q => /^(insert|update|create|alter)/i.test(q))).toBe(false);
    await predecessor();
  });
  it('refuses the actual staging database observation', async () => {
    await expect(run('upgrade', database(undefined, 'clinical_core'))).rejects.toThrow('boundary_refused'); await predecessor();
  });
  it('rehearses all DDL, privileges and fingerprints then proves rollback from a fresh read', async () => {
    const before = await run('inspect');
    const result = await run('rehearse');
    expect(result).toMatchObject({ command: 'rehearse', rolledBack: true, applied: false, observedMigrationCount: 103,
      tableCount: 202, dataSha256: before.dataSha256, rowCount: before.rowCount }); await predecessor();
  });
  it('refuses a changed predecessor ledger', async () => {
    const old = migrations[0];
    await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', ['b'.repeat(64), old.version]);
    try { await expect(run('upgrade')).rejects.toThrow('history_refused'); }
    finally { await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', [old.sha256, old.version]); }
    await predecessor();
  });
  it('detects a same-count row rewrite and rolls it back with the new DDL', async () => {
    const before = await run('inspect');
    await expect(run('upgrade', database(async (sql, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations')) await tx.query("update clinical_core.messages set body='FICTIONAL changed' where status='draft'");
    }))).rejects.toThrow('data_changed');
    expect((await run('inspect')).dataSha256).toBe(before.dataSha256); await predecessor();
  });
  it('refuses a new seeded audit row rather than treating it as a migration approval', async () => {
    await expect(run('upgrade', database(async (sql, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations')) await tx.query("insert into clinical_audit.care_message_access_events(organization_id,actor_person_id,action) values($1,$2,'list')", [org, person]);
    }))).rejects.toThrow('data_changed'); await predecessor();
  });
  it('refuses changed old RLS or a new table with RLS disabled', async () => {
    for (const table of ['clinical_core.patient_records', 'clinical_core.care_message_receipts']) {
      await expect(run('upgrade', database(async (sql, tx) => {
        if (sql.startsWith('insert into clinical_core.schema_migrations')) await tx.query(`alter table ${table} disable row level security`);
      }))).rejects.toThrow('inventory_refused'); await predecessor();
    }
  });
  it('refuses extra API table privileges and lost or public function privileges', async () => {
    for (const sqlChange of ['grant select on clinical_core.care_message_receipts to clinical_core_api',
      'revoke execute on function clinical_core.production_care_message_export(jsonb) from clinical_core_api',
      'grant execute on function clinical_core.production_care_message_request(jsonb) to public']) {
      await expect(run('upgrade', database(async (sql, tx) => {
        if (sql.startsWith('insert into clinical_core.schema_migrations')) await tx.query(sqlChange);
      }))).rejects.toThrow('verification_failed'); await predecessor();
    }
  });
  it('refuses a disabled immutable trigger', async () => {
    await expect(run('upgrade', database(async (sql, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations')) await tx.query('alter table clinical_core.messages disable trigger stored_care_messages_immutable');
    }))).rejects.toThrow('verification_failed'); await predecessor();
  });
  it('refuses a changed function body even when its name, signature and grants remain', async () => {
    await expect(run('upgrade', database(async (sql, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations')) await tx.query(`create or replace function
        clinical_core.production_care_message_export(_request jsonb) returns jsonb language sql security definer set search_path=''
        as $$select '{}'::jsonb$$`);
    }))).rejects.toThrow('verification_failed'); await predecessor();
  });
  it('refuses an immutable trigger rebound to the wrong event despite the same name and function', async () => {
    await expect(run('upgrade', database(async (sql, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations')) {
        await tx.query('drop trigger stored_care_messages_immutable on clinical_core.messages');
        await tx.query(`create trigger stored_care_messages_immutable before insert on clinical_core.messages
          for each row execute function clinical_private.production_care_message_immutable()`);
      }
    }))).rejects.toThrow('verification_failed'); await predecessor();
  });
  it('refuses extra application tables without changing the reviewed inventory', async () => {
    await pg.query('create table clinical_private.unreviewed_care_table(id int)');
    try { await expect(run('upgrade')).rejects.toThrow('inventory_refused'); }
    finally { await pg.query('drop table clinical_private.unreviewed_care_table'); }
    await predecessor();
  });
  it('upgrades once, preserves every old fingerprint and safely replays without new rows', async () => {
    const before = await run('inspect'); const result = await run('upgrade');
    expect(result).toMatchObject({ observedMigrationCount: 104, tableCount: 206, applied: true, alreadyApplied: false,
      dataSha256: before.dataSha256, rowCount: before.rowCount, phiAllowed: false, activation: 'blocked' });
    const after = await run('inspect'); expect(after).toMatchObject({ observedMigrationCount: 104, applied: false, alreadyApplied: true });
    expect(await run('upgrade')).toMatchObject({ applied: false, alreadyApplied: true, dataSha256: after.dataSha256 });
    expect(await run('rehearse')).toMatchObject({ applied: false, alreadyApplied: true, rolledBack: true, dataSha256: after.dataSha256 });
    expect(JSON.stringify(result)).not.toMatch(/FICTIONAL|secretArn|subject_fictional|patientRecordId/);
  });
});
