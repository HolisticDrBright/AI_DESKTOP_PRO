import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { applyClinicalCoreMigrations, loadClinicalCoreMigrations, type ClinicalCoreMigration } from './migrations';
import { applyGovernedCatalogMigrations, loadHistoricalGovernedCatalogMigrations as loadGovernedCatalogMigrations } from './catalog-migrations';
import { CARE_ERASURE_AWS, CARE_ERASURE_UPGRADE, runCareErasureSchemaUpgrade, type CareErasureUpgradeConfiguration } from './care-erasure-schema-upgrade';
import { executeCareErasureUpgradeCommand } from './care-erasure-upgrade-command';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const configuration: CareErasureUpgradeConfiguration = { account: CARE_ERASURE_AWS.account, region: CARE_ERASURE_AWS.region,
  databaseName: CARE_ERASURE_AWS.databaseName, clusterArn: CARE_ERASURE_AWS.clusterArn, secretArn: CARE_ERASURE_AWS.secretArn,
  phiAllowed: false, environment: 'synthetic-staging', dataClassification: 'synthetic_only' };
let pg: PGlite, migrations: ClinicalCoreMigration[], reference: ClinicalCoreMigration[];
const org = randomUUID(), owner = randomUUID();
type Inner = { query: (s: string, p?: unknown[]) => Promise<unknown> };
type Intercept = (s: string, tx: Inner) => Promise<void>;
// Actual SQL, constraints, privileges, data digests and rollback. Only the
// database's name and AWS metadata are substituted; not hosted/race evidence.
const database = (intercept?: Intercept, name = 'clinical_core'): ClinicalCoreDatabase => ({
  transaction: work => pg.transaction(async tx => work({ query: async (s: string, p: readonly unknown[] = []) => {
    if (intercept) await intercept(s, tx);
    if (s === 'select current_database() as name') return { rows: [{ name }] };
    return tx.query(s, [...p]);
  } } as ClinicalCoreTransaction)),
});
const run = (mode: 'inspect' | 'rehearse' | 'upgrade', db = database()) => runCareErasureSchemaUpgrade(db, migrations, reference, configuration, mode);
const atReceipt = (change: (tx: Inner) => Promise<void>) => database(async (s, tx) => {
  if (s.startsWith('insert into clinical_core.schema_migrations')) await change(tx);
});
const predecessor = async () => {
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.schema_migrations')).rows[0]?.n).toBe(46);
  expect((await pg.query<{ absent: boolean }>("select to_regclass('clinical_core.care_data_erasure_requests') is null absent")).rows[0]?.absent).toBe(true);
};
beforeAll(async () => {
  // Historical upgrade fixture, not current release authority.
  migrations = loadClinicalCoreMigrations().slice(0,46); reference = loadGovernedCatalogMigrations();
  pg = new PGlite({ extensions: { pgcrypto } });
  await applyClinicalCoreMigrations(database(), migrations.slice(0, 45));
  const alias = migrations.find(x => x.version === '20260821049700')!;
  await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', ['20260902230000', alias.name, alias.sha256]);
  await applyGovernedCatalogMigrations(database(), reference);
  await pg.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'FICTIONAL erasure upgrade')", [org]);
  await pg.query("insert into clinical_core.persons(id,synthetic_subject_key) values($1,'syn_erasure_upgrade')", [owner]);
  await pg.query("insert into clinical_reference.knowledge_sources(stable_id,environment) values('src_fictional_erasure_upgrade','synthetic-staging')");
  // Real staging already exceeds the old qualification-only 5k bound.
  await pg.query(`insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose)
    select $1,$2,'consent.granted','consent',$2,'consent_management' from generate_series(1,12001)`, [org, owner]);
}, 60000);
afterAll(async () => { await pg?.close(); });
describe('exact preserving synthetic staging erasure successor', () => {
  it('refuses different database/account/region/PHI and changed core or reference artifacts before a transaction', async () => {
    let opened = false; const never: ClinicalCoreDatabase = { transaction: async () => { opened = true; throw Error('unexpected'); } };
    for (const patch of [{ account: '173535830222' }, { region: 'us-west-2' }, { databaseName: 'clinical_core_qualification' },
      { phiAllowed: true }, { environment: 'production-clinical' }, { clusterArn: CARE_ERASURE_AWS.clusterArn + '-other' }, { dataClassification: 'phi' }]) {
      await expect(runCareErasureSchemaUpgrade(never, migrations, reference, { ...configuration, ...patch } as CareErasureUpgradeConfiguration, 'upgrade')).rejects.toThrow('boundary_refused');
    }
    for (const changed of [migrations.slice(0, 45), [...migrations, migrations[45]], migrations.map((m, i) => i === 0 || i === 45
      ? { ...m, sql: m.sql + '\nselect 1;', sha256: sha(m.sql + '\nselect 1;') } : m)]) {
      await expect(runCareErasureSchemaUpgrade(never, changed, reference, configuration, 'upgrade')).rejects.toThrow('artifact_refused');
    }
    await expect(runCareErasureSchemaUpgrade(never, migrations, reference.slice(0, 1), configuration, 'upgrade')).rejects.toThrow('artifact_refused');
    expect(opened).toBe(false); await predecessor();
  });
  it('inspects read only, includes the separate catalog, and refuses qualification/production database names', async () => {
    const queries: string[] = [];
    const r = await run('inspect', database(async s => { queries.push(s); }));
    expect(r).toMatchObject({ observedMigrationCount: 46, sourceMigrationCount: 45, tableCount: 87, applied: false, alreadyApplied: false,
      fromLedgerSha256: CARE_ERASURE_UPGRADE.liveBefore, referenceLedgerSha256: CARE_ERASURE_UPGRADE.reference });
    expect(r.rowCount).toBeGreaterThanOrEqual(12004);
    expect(queries[0]).toContain('read only'); expect(queries.some(s => /^(create|alter|insert|update|delete|lock)/i.test(s))).toBe(false);
    for (const name of ['clinical_core_qualification', 'clinical_core_production']) await expect(run('upgrade', database(undefined, name))).rejects.toThrow('boundary_refused');
    await predecessor();
  });
  it('runs the actual successor then rolls it back and independently reads original data/history', async () => {
    const before = await run('inspect');
    expect(await run('rehearse')).toMatchObject({ command: 'rehearse', rolledBack: true, observedMigrationCount: 46,
      applied: false, tableCount: 87, dataSha256: before.dataSha256, rowCount: before.rowCount });
    await predecessor();
  });
  it('uses fresh writer statement snapshots while retaining read-only inspector snapshots', async () => {
    const queries: string[] = [];
    await expect(run('upgrade', database(async s => {
      queries.push(s);
      if (s.startsWith('lock table ')) throw Error('fictional stop before mutation');
    }))).rejects.toMatchObject({ category: 'upgrade_failed', stage: 'writer_locks' });
    expect(queries[0]).toBe('set transaction isolation level read committed');
    expect(queries.some(s => /^(create|alter|insert|update|delete)/i.test(s))).toBe(false);
    await predecessor();
  });
  it.each(['clinical_core.schema_migrations', 'clinical_reference.schema_migrations'])
    ('refuses %s drift at lock admission before successor DDL', async table => {
      const queries: string[] = [];
      const changed = database(async (s, tx) => {
        queries.push(s);
        // PGlite executes the real changed ledger and rollback. This injection
        // models admission-time drift, not an independently committed writer.
        if (s.startsWith('lock table ')) await tx.query(`update ${table} set sha256=$1 where version=$2`,
          ['f'.repeat(64), table.startsWith('clinical_core.') ? migrations[0].version : reference[0].version]);
      });
      await expect(run('upgrade', changed)).rejects.toMatchObject({ category: 'history_refused', stage: 'writer_history' });
      expect(queries.some(s => /^(create|alter|insert|update|delete)/i.test(s))).toBe(false);
      await predecessor();
      expect((await run('inspect')).observedMigrationCount).toBe(46);
    });
  it.each(['reverse', 'rotate', 'hosted-collation'])('accepts only the identical constraint set despite %s result ordering', async order => {
    const reordered: ClinicalCoreDatabase = { transaction: work => database().transaction(tx => work({ query: async <Row extends Record<string, unknown>>
      (s: string, p: readonly unknown[] = []) => {
        const r = await tx.query<Row>(s, p);
        if (!s.startsWith('select contype::text kind')) return r;
        const rows = [...r.rows];
        if (order === 'reverse') rows.reverse();
        else if (order === 'rotate') rows.push(rows.shift()!);
        else [rows[0], rows[1]] = [rows[1], rows[0]]; // Observed AWS collation versus PGlite.
        return { ...r, rows };
      } })) };
    expect(await run('rehearse', reordered)).toMatchObject({ rolledBack: true, observedMigrationCount: 46 });
    await predecessor();
  });
  it('refuses missing/renamed historical alias, altered catalog ledger, unknown or altered core history', async () => {
    const alias = migrations.find(x => x.version === '20260821049700')!;
    await pg.query("delete from clinical_core.schema_migrations where version='20260902230000'");
    try { await expect(run('upgrade')).rejects.toThrow('history_refused'); }
    finally { await pg.query("insert into clinical_core.schema_migrations(version,name,sha256) values('20260902230000',$1,$2)", [alias.name, alias.sha256]); }
    for (const [table, entry] of [['clinical_core.schema_migrations', migrations[0]], ['clinical_reference.schema_migrations', reference[0]]] as const) {
      await pg.query(`update ${table} set sha256=$1 where version=$2`, ['f'.repeat(64), entry.version]);
      try { await expect(run('upgrade')).rejects.toThrow('history_refused'); }
      finally { await pg.query(`update ${table} set sha256=$1 where version=$2`, [entry.sha256, entry.version]); }
    }
    await pg.query("update clinical_core.schema_migrations set name='renamed_alias' where version='20260902230000'");
    try { await expect(run('upgrade')).rejects.toThrow('history_refused'); }
    finally { await pg.query("update clinical_core.schema_migrations set name=$1 where version='20260902230000'", [alias.name]); }
    await predecessor();
  });
  it('captures artifacts and configuration before asynchronous caller mutation', async () => {
    const supplied = migrations.map(x => ({ ...x })), refs = reference.map(x => ({ ...x })), c = { ...configuration }; let changed = false;
    const r = await runCareErasureSchemaUpgrade(database(async () => {
      if (changed) return; changed = true; supplied[45].sql += '\nselect 1;'; refs[0].sql += '\nselect 1;'; c.databaseName = 'clinical_core_qualification';
    }), supplied, refs, c, 'rehearse');
    expect(r).toMatchObject({ rolledBack: true, observedMigrationCount: 46 }); await predecessor();
  });
  // Each complete rollback + independent inspection keeps the existing test
  // deadline. Bundling all three round trips made the unrelated third case
  // inherit the first two's elapsed time under parallel embedded-db load.
  it.each([
    ['same-count clinical change', async (tx: Inner) => { await tx.query("update clinical_core.organizations set synthetic_label='FICTIONAL changed' where id=$1", [org]); }],
    ['same-count reference change', async (tx: Inner) => { await tx.query("update clinical_reference.knowledge_sources set review_status='rejected' where stable_id='src_fictional_erasure_upgrade'"); }],
    ['unexpected seeded cancellation', async (tx: Inner) => { await tx.query("insert into clinical_core.care_data_erasure_requests(owner_id,request_id,scope,outcome) values($1,$2,'domain','cancelled')", [owner, randomUUID()]); }],
  ] as const)('rolls back %s and independently verifies preservation', async (_name, change) => {
    const before = await run('inspect');
    await expect(run('upgrade', atReceipt(change))).rejects.toThrow('data_changed');
    expect((await run('inspect')).dataSha256).toBe(before.dataSha256); await predecessor();
  });
  // Seeding 12,001 rows plus complete before/rollback/after fingerprints is a
  // compound embedded-DB operation. Keep every row and protection assertion;
  // this test budget does not change the runtime database deadlines.
  it('detects a changed row beyond a 5k prefix without weakening append-only audit protections', async () => {
    await pg.query(`insert into clinical_reference.knowledge_sources(stable_id,environment)
      select 'src_fictional_tail_'||n,'synthetic-staging' from generate_series(1,12001) n`);
    const before = await run('inspect');
    await expect(run('upgrade', atReceipt(async tx => {
      await tx.query("update clinical_reference.knowledge_sources set review_status='rejected' where stable_id='src_fictional_tail_12001'");
    }))).rejects.toThrow('data_changed');
    expect((await run('inspect')).dataSha256).toBe(before.dataSha256); await predecessor();
    // Leave these fictional rows for replay/preservation coverage; no trigger
    // or immutability guard is disabled to manufacture the failure.
  }, 30000);
  it('never treats a bounded prefix as complete data-preservation evidence', async () => {
    const overBound: ClinicalCoreDatabase = { transaction: work => database().transaction(tx => work({ query: async <Row extends Record<string, unknown>>
      (s: string, p: readonly unknown[] = []) => {
        const r = await tx.query<Row>(s, p);
        if (s.includes('string_agg(row_hash')) return { ...r, rows: r.rows.map(x => x.table_name === 'clinical_audit.events'
          ? { ...x, row_count: 100001 } : x) };
        return r;
      } })) };
    await expect(run('upgrade', overBound)).rejects.toThrow('inventory_refused'); await predecessor();
  });
  it.each(['alter table clinical_core.persons disable row level security',
    'alter table clinical_core.care_data_erasure_requests disable row level security',
    'create table clinical_private.unreviewed_erasure_table(id int)'])('refuses inventory drift and rolls back %s', async sql => {
    await expect(run('upgrade', atReceipt(async tx => { await tx.query(sql); }))).rejects.toThrow('inventory_refused'); await predecessor();
  });
  it.each(['grant execute on function clinical_core.care_data_erase(jsonb) to clinical_core_api',
      'grant select(request_id) on clinical_core.care_data_erasure_requests to clinical_core_api',
      'grant select on clinical_core.care_data_erasure_requests to public',
      'revoke execute on function clinical_core.care_data_erasure_request(jsonb) from clinical_core_api',
      "alter function clinical_core.care_data_erasure_request(jsonb) set search_path=public",
      'alter table clinical_core.care_data_erasure_requests drop constraint care_data_erasure_requests_scope_check',
      'alter table clinical_core.care_data_erasure_requests drop constraint care_data_erasure_requests_owner_id_fkey',
      'alter table clinical_core.care_data_erasure_requests drop constraint care_data_erasure_requests_outcome_check',
      'alter table clinical_core.care_data_erasure_requests add constraint weakened_receipt_contract check(true)',
      'alter table clinical_core.care_data_erasure_requests alter column scope drop not null',
      'alter table clinical_core.care_data_erasure_requests alter column settled_at drop default',
      'alter table clinical_core.care_data_erasure_requests disable trigger care_data_erasure_requests_immutable'])('refuses contract drift and rolls back %s', async sql => {
    await expect(run('upgrade', atReceipt(async tx => { await tx.query(sql); }))).rejects.toThrow('verification_failed'); await predecessor();
  });
  it('rolls back a database failure before recording the successor and hides SQL/provider details', async () => {
    const broken = database(async s => { if (s.startsWith('insert into clinical_core.schema_migrations')) throw Error('secret provider detail'); });
    await expect(run('upgrade', broken)).rejects.toMatchObject({ category: 'upgrade_failed', stage: 'ledger_receipt', message: 'upgrade_failed' }); await predecessor();
  });
  it('legacy command cannot commit; the preserving transaction applies once and preserves populated receipts on replay', async () => {
    const observations: string[] = [], a = CARE_ERASURE_AWS;
    const d = { observeCaller: () => { observations.push('caller'); return { Account: a.account, Arn: `arn:aws:sts::${a.account}:assumed-role/FictionalOperator/session` }; },
      observeFoundation: () => { observations.push('foundation'); return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE',
        StackId: `arn:aws:cloudformation:${a.region}:${a.account}:stack/${a.foundation}/fictional`,
        Outputs: Object.entries({ PhiAllowed: 'false', Environment: 'synthetic-staging', DataClassification: 'synthetic_only', DatabaseName: a.databaseName,
          ClinicalApiId: a.apiId, DatabaseClusterArn: a.clusterArn, DatabaseSecretArn: a.secretArn }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] }; },
      loadMigrations: () => migrations, loadReferenceMigrations: () => reference, createDatabase: () => database() };
    const before = await run('inspect');
    await expect(executeCareErasureUpgradeCommand(['upgrade', '--confirm-fictional-care-erasure-upgrade'], { sourceCommit: '1'.repeat(40), clean: true }, d)).rejects.toThrow('boundary_refused');
    expect(observations).toEqual([]);
    const rehearsal = await run('rehearse');
    expect(rehearsal).toMatchObject({ rolledBack: true, dataSha256: before.dataSha256, rowCount: before.rowCount });
    const r = await run('upgrade');
    expect(r).toMatchObject({ observedMigrationCount: 47, sourceMigrationCount: 46, tableCount: 88, applied: true, alreadyApplied: false,
      dataSha256: before.dataSha256, rowCount: before.rowCount, phiAllowed: false,
      originalDataSha256: before.dataSha256, originalRowCount: before.rowCount });
    await pg.query("insert into clinical_core.care_data_erasure_requests(owner_id,request_id,scope,outcome) values($1,$2,'domain','cancelled')", [owner, randomUUID()]);
    const after = await run('inspect'); expect(after.rowCount).toBe(before.rowCount + 1);
    expect(after.originalDataSha256).toBe(before.dataSha256); expect(after.originalRowCount).toBe(before.rowCount);
    expect(await run('upgrade')).toMatchObject({ applied: false, alreadyApplied: true, dataSha256: after.dataSha256 });
    expect(await run('rehearse')).toMatchObject({ rolledBack: true, observedMigrationCount: 47, dataSha256: after.dataSha256 });
    expect(JSON.stringify(after)).not.toMatch(/FICTIONAL|synthetic_label|secretArn|syn_erasure_upgrade/);
  }, 30000); // Multiple real preserving/rehearsal transactions over 24k fictional rows.
});
