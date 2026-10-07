import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { CARE_CLAIM_RECOVERY_UPGRADE, runCareClaimRecoverySchemaUpgrade } from './care-claim-recovery-schema-upgrade';
import { executeCareClaimRecoveryUpgradeCommand } from './care-claim-recovery-upgrade-command';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const configuration: QualificationUpgradeConfiguration = { expectedAccountId: '588966314750', region: 'us-east-2', phiAllowed: false,
  activation: 'blocked', clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:synthetic-test',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:synthetic-test',
  qualificationDatabaseName: 'clinical_core_qualification', stagingDatabaseName: 'clinical_core',
  fromReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.from, toReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.to };
let pg: PGlite, migrations: ClinicalCoreMigration[];
const org = randomUUID(), owner = randomUUID(), patient = randomUUID(), request = randomUUID();
type Intercept = (sql: string, tx: { query: (sql: string, args?: unknown[]) => Promise<unknown> }) => Promise<void>;
// Only database name is substituted. Actual SQL, API role, digest, privileges
// and rollback run in PGlite. This is not hosted or multi-session evidence.
const database = (intercept?: Intercept, observedName = 'clinical_core_qualification'): ClinicalCoreDatabase => ({
  transaction: work => pg.transaction(async tx => work({ query: async (sql: string, args: readonly unknown[] = []) => {
    if (intercept) await intercept(sql, tx);
    if (sql === 'select current_database() as name') return { rows: [{ name: observedName }] };
    return tx.query(sql, args.map(v => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v));
  } } as ClinicalCoreTransaction)),
});
const run = (command: 'inspect' | 'rehearse' | 'upgrade', db = database()) =>
  runCareClaimRecoverySchemaUpgrade(db, migrations, configuration, command);
const predecessor = async () => {
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.schema_migrations')).rows[0]?.n).toBe(105);
  expect((await pg.query("select to_regclass('clinical_core.care_claim_requests') is null absent")).rows[0]).toEqual({ absent: true });
  expect((await pg.query("select to_regclass('clinical_audit.care_claim_events') is null absent")).rows[0]).toEqual({ absent: true });
};
const atReceipt = (change: (tx: Parameters<Intercept>[1]) => Promise<void>) => database(async (sql, tx) => {
  if (sql.startsWith('insert into clinical_core.schema_migrations')) await change(tx);
});
beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 }));
  expect(manifest.migrations).toHaveLength(106); // The exact historical 105 prefix remains unchanged.
  migrations = manifest.migrations.map((m: { version: string; file: string }) => ({ version: m.version, name: m.file.slice(15, -4),
    sql: files[m.file], sha256: sha(files[m.file]) }));
  const sql = readFileSync('infra/aws-clinical-core/production-candidates/care-claim-recovery.sql', 'utf8').replace(/\r\n?/g, '\n');
  expect(migrations[105].sql).toBe(sql);
  pg = new PGlite({ extensions: { pgcrypto } });
  expect((await applyProductionClinicalCoreMigrations(database(), migrations.slice(0, 105))).tableCount).toBe(128);
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL recovery upgrade')", [org]);
  await pg.query("insert into clinical_core.persons(id,subject_key) values($1,'subject_fictional_claim_upgrade')", [owner]);
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,'patient_fictional_claim_upgrade','Fictional','Upgrade')", [patient, org]);
}, 60000);
afterAll(async () => { await pg?.close(); });

describe('prepared preserving claim recovery 105 to 106 transition', () => {
  it('refuses altered artifacts and activation boundaries before any database call', async () => {
    let opened = false;
    const never: ClinicalCoreDatabase = { transaction: async () => { opened = true; throw new Error('unexpected'); } };
    for (const change of [{ phiAllowed: true }, { activation: 'approved' }, { expectedAccountId: '173535830222' }, { region: 'us-west-2' },
      { qualificationDatabaseName: 'clinical_core' }, { fromReleaseSha256: 'a'.repeat(64) }, { toReleaseSha256: 'b'.repeat(64) }]) {
      await expect(runCareClaimRecoverySchemaUpgrade(never, migrations, { ...configuration, ...change } as QualificationUpgradeConfiguration, 'upgrade')).rejects.toThrow();
    }
    for (const changed of [migrations.slice(0, 105), [...migrations, migrations[105]],
      migrations.map((m, i) => i === 0 ? { ...m, sql: m.sql + '\nselect 1;', sha256: sha(m.sql + '\nselect 1;') } : m),
      migrations.map((m, i) => i === 105 ? { ...m, sql: m.sql + '\nselect 1;', sha256: sha(m.sql + '\nselect 1;') } : m),
      migrations.map((m, i) => i === 105 ? { ...m, version: '20261006020000' } : m)]) {
      await expect(runCareClaimRecoverySchemaUpgrade(never, changed, configuration, 'upgrade')).rejects.toThrow('artifact_refused');
    }
    expect(opened).toBe(false);
  });
  it('inspects read only without DDL and refuses the observed staging database', async () => {
    const queries: string[] = [];
    expect(await run('inspect', database(async sql => { queries.push(sql); }))).toMatchObject({ observedMigrationCount: 105,
      tableCount: 207, rowCount: 3, applied: false, canonical: true, phiAllowed: false });
    expect(queries[0]).toContain('read only'); expect(queries.some(q => /^(insert|update|create|alter)/i.test(q))).toBe(false);
    await expect(run('upgrade', database(undefined, 'clinical_core'))).rejects.toThrow('boundary_refused'); await predecessor();
  });
  it('rehearses actual DDL and API role verification and proves rollback by reading the original state', async () => {
    const before = await run('inspect');
    expect(await run('rehearse')).toMatchObject({ command: 'rehearse', rolledBack: true, observedMigrationCount: 105,
      applied: false, tableCount: 207, dataSha256: before.dataSha256, rowCount: 3 }); await predecessor();
  });
  it('refuses mutated or unknown ledger history', async () => {
    const old = migrations[0];
    await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', ['b'.repeat(64), old.version]);
    try { await expect(run('upgrade')).rejects.toThrow('history_refused'); }
    finally { await pg.query('update clinical_core.schema_migrations set sha256=$1 where version=$2', [old.sha256, old.version]); }
    await pg.query("insert into clinical_core.schema_migrations(version,name,sha256) values('20990101000000','unknown',$1)", ['f'.repeat(64)]);
    try { await expect(run('upgrade')).rejects.toThrow('history_refused'); }
    finally { await pg.query("delete from clinical_core.schema_migrations where version='20990101000000'"); }
    await predecessor();
  });
  it('captures SQL and configuration before asynchronous caller mutation', async () => {
    const supplied = migrations.map(m => ({ ...m })), settings = { ...configuration }; let changed = false;
    const result = await runCareClaimRecoverySchemaUpgrade(database(async () => {
      if (changed) return; changed = true; supplied[105].sql += '\nselect 1;'; supplied[105].sha256 = sha(supplied[105].sql);
      settings.qualificationDatabaseName = 'clinical_core'; settings.toReleaseSha256 = 'f'.repeat(64);
    }), supplied, settings, 'rehearse');
    expect(result).toMatchObject({ rolledBack: true, observedMigrationCount: 105, toReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.to }); await predecessor();
  });
  it('rolls back same-count predecessor changes and unexpected seeded decisions', async () => {
    const before = await run('inspect');
    for (const change of [
      async (tx: Parameters<Intercept>[1]) => { await tx.query("update clinical_core.patient_records set first_name='FICTIONAL changed' where id=$1", [patient]); },
      async (tx: Parameters<Intercept>[1]) => { await tx.query("insert into clinical_core.care_claim_requests(organization_id,consumer_person_id,request_id,status) values($1,$2,$3,'cancelled')", [org, owner, request]); },
    ]) {
      await expect(run('upgrade', atReceipt(change))).rejects.toThrow('data_changed');
      expect((await run('inspect')).dataSha256).toBe(before.dataSha256); await predecessor();
    }
  });
  it('rejects old or new RLS loss and undeclared tables', async () => {
    for (const sql of ['alter table clinical_core.patient_records disable row level security',
      'alter table clinical_core.care_claim_requests no force row level security',
      'create table clinical_private.unreviewed_claim_table(id int)']) {
      await expect(run('upgrade', atReceipt(async tx => { await tx.query(sql); }))).rejects.toThrow('inventory_refused'); await predecessor();
    }
  });
  it('rejects PUBLIC/column/helper grants, lost API execution and immutable-trigger drift', async () => {
    for (const sql of ['grant select on clinical_core.care_claim_requests to public',
      'grant select(status) on clinical_core.care_claim_requests to clinical_core_api',
      'grant execute on function clinical_private.care_claim_result(uuid,uuid,uuid) to clinical_core_api',
      'revoke execute on function clinical_core.production_care_claim_request(jsonb) from clinical_core_api',
      "alter function clinical_core.production_care_claim_request(jsonb) set search_path=public",
      'alter table clinical_audit.care_claim_events disable trigger care_claim_events_immutable']) {
      await expect(run('upgrade', atReceipt(async tx => { await tx.query(sql); }))).rejects.toThrow('verification_failed'); await predecessor();
    }
  });
  it('rolls DDL back when a storage/database transport fails before ledger recording', async () => {
    const broken = database(async sql => { if (sql.startsWith('insert into clinical_core.schema_migrations')) throw new Error('sensitive transport detail'); });
    await expect(run('upgrade', broken)).rejects.toMatchObject({ category: 'upgrade_failed', stage: 'ledger_receipt', message: 'upgrade_failed' });
    await predecessor();
  });
  it('applies once and then preserves populated request and audit rows on inspection, replay and rehearsal', async () => {
    const before = await run('inspect');
    const observations: string[] = [];
    // Real command -> real preserving runner -> real embedded SQL, with only
    // STS/DescribeStacks and the database name fictionalized. Not AWS proof.
    const dependencies = {
      observeCaller: () => { observations.push('caller'); return { Account: '588966314750',
        Arn: 'arn:aws:sts::588966314750:assumed-role/FictionalOperator/session' }; },
      observeFoundation: () => { observations.push('foundation'); return { Stacks: [{ StackStatus: 'CREATE_COMPLETE',
        StackId: 'arn:aws:cloudformation:us-east-2:588966314750:stack/ai-clinical-core-qualification-foundation/fictional',
        Outputs: Object.entries({ PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'disabled',
          DatabaseName: configuration.qualificationDatabaseName, DatabaseClusterArn: configuration.clusterArn,
          DatabaseSecretArn: configuration.secretArn }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] }; },
      loadMigrations: () => migrations,
      createDatabase: () => database(),
    };
    const upgraded = await executeCareClaimRecoveryUpgradeCommand(['upgrade', '--confirm-fictional-care-claim-recovery-upgrade'],
      { sourceCommit: '1'.repeat(40), clean: true }, dependencies);
    expect(upgraded).toMatchObject({ observedMigrationCount: 106, tableCount: 209, applied: true, alreadyApplied: false,
      rowCount: 3, dataSha256: before.dataSha256, activation: 'blocked', phiAllowed: false, canonical: true });
    expect(upgraded.rehearsal).toEqual({ rolledBack: true, dataSha256: before.dataSha256, rowCount: 3 });
    expect(observations).toEqual(['caller', 'foundation', 'caller', 'foundation']);
    await pg.query("insert into clinical_core.care_claim_requests(organization_id,consumer_person_id,request_id,status) values($1,$2,$3,'cancelled')", [org, owner, request]);
    await pg.query("insert into clinical_audit.care_claim_events(organization_id,consumer_person_id,request_id,action,outcome) values($1,$2,$3,'settle','cancelled')", [org, owner, request]);
    const after = await run('inspect'); expect(after).toMatchObject({ observedMigrationCount: 106, rowCount: 5, alreadyApplied: true });
    expect(await run('upgrade')).toMatchObject({ applied: false, alreadyApplied: true, dataSha256: after.dataSha256, rowCount: 5 });
    expect(await run('rehearse')).toMatchObject({ rolledBack: true, alreadyApplied: true, dataSha256: after.dataSha256, rowCount: 5 });
    expect(await executeCareClaimRecoveryUpgradeCommand(['upgrade', '--confirm-fictional-care-claim-recovery-upgrade'],
      { sourceCommit: '1'.repeat(40), clean: true }, dependencies)).toMatchObject({ applied: false, alreadyApplied: true, rowCount: 5,
        dataSha256: after.dataSha256, rehearsal: { rolledBack: true, dataSha256: after.dataSha256, rowCount: 5 } });
    expect(JSON.stringify(after)).not.toMatch(/FICTIONAL|secretArn|subject_fictional|first_name/);
  });
});
