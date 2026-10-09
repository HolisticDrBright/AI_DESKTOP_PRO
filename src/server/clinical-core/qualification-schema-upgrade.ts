if (typeof window !== 'undefined') throw new Error('qualification-schema-upgrade is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { splitPostgresStatements, type ClinicalCoreMigration } from './migrations';
import { productionArtifactReleaseHash } from './production-migrations';
import { assertQualificationConfiguration, type QualificationTargetConfiguration } from './qualification-target';

// Source-reviewed, data-preserving DDL transition only. Adding an upgrade requires a new
// source review/test and these exact pins, not an operator-supplied SQL file or approval hash.
export const EXPORT_RECOVERY_UPGRADE = Object.freeze({
  from: 'd6b0a8a5d61c465f8e1db1181c52d6bf4d90db0b65068042d8ebf56358dd82b3',
  to: '9bc30d04930816a523a7dc67b95944fba1d294dad4d71cf7585158fbc3a874aa',
  version: '20260928010000', countBefore: 102, countAfter: 103,
});
export type QualificationUpgradeConfiguration = QualificationTargetConfiguration & {
  region: string; phiAllowed: false; activation: 'blocked'; fromReleaseSha256: string; toReleaseSha256: string;
};
type Category = 'boundary_refused' | 'artifact_refused' | 'history_refused' | 'inventory_refused' | 'data_changed' | 'upgrade_failed' | 'upgrade_busy' | 'verification_failed';
export class QualificationUpgradeError extends Error {
  constructor(readonly category: Category, readonly stage?: string) { super(category); this.name = 'QualificationUpgradeError'; }
}
const fail = (code: Category): never => { throw new QualificationUpgradeError(code); };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const LEDGER = 'clinical_core.schema_migrations';
const TABLES = `select n.nspname as schema_name,c.relname as table_name,c.relkind::text as kind,
  c.relrowsecurity as rls,c.relforcerowsecurity as forced
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')
    and c.relkind in ('r','p','f') and not(n.nspname='clinical_core' and c.relname='schema_migrations')
  order by n.nspname,c.relname`;
type Table = { schema_name: string; table_name: string; kind: string; rls: boolean; forced: boolean } & Record<string, unknown>;
type Fingerprint = { table_name: string; row_count: number; sha256: string } & Record<string, unknown>;
const quote = (name: string) => /^[a-z][a-z0-9_]{0,62}$/.test(name) ? `"${name}"` : fail('inventory_refused');
const qualified = (t: Table) => `${quote(t.schema_name)}.${quote(t.table_name)}`;

export function assertQualificationUpgrade(configuration: QualificationUpgradeConfiguration, migrations: ClinicalCoreMigration[]) {
  try { assertQualificationConfiguration(configuration, configuration.region); } catch { fail('boundary_refused'); }
  if (configuration.expectedAccountId !== '588966314750' || configuration.region !== 'us-east-2'
    || configuration.phiAllowed !== false || configuration.activation !== 'blocked'
    || configuration.qualificationDatabaseName !== 'clinical_core_qualification' || configuration.stagingDatabaseName !== 'clinical_core') fail('boundary_refused');
  if (configuration.fromReleaseSha256 !== EXPORT_RECOVERY_UPGRADE.from || configuration.toReleaseSha256 !== EXPORT_RECOVERY_UPGRADE.to) fail('artifact_refused');
  if (migrations.length !== 103 || migrations[102].version !== EXPORT_RECOVERY_UPGRADE.version
    || new Set(migrations.map(m => m.version)).size !== 103
    || migrations.some((m, i) => !/^\d{14}$/.test(m.version) || (i > 0 && m.version <= migrations[i - 1].version)
      || sha(m.sql) !== m.sha256)
    || productionArtifactReleaseHash(migrations) !== EXPORT_RECOVERY_UPGRADE.to
    || productionArtifactReleaseHash(migrations.slice(0, 102)) !== EXPORT_RECOVERY_UPGRADE.from) fail('artifact_refused');
}

async function inventory(tx: ClinicalCoreTransaction): Promise<Table[]> {
  const tables = (await tx.query<Table>(TABLES)).rows;
  // The exact release creates 202 application tables across all five schemas, not
  // just the 123 core/audit tables counted by the empty-database installer.
  if (tables.length !== 202 || tables.some(t => t.kind !== 'r' || typeof t.rls !== 'boolean' || typeof t.forced !== 'boolean')) fail('inventory_refused');
  for (const table of tables) qualified(table);
  if (sha(tables.map(t => `${t.schema_name}.${t.table_name}`).sort().join('\n')) !== '0a8707390d9df08773e7dcede52f7a9c44a443f4293136171e21a533f0cc52b0') fail('inventory_refused');
  return tables;
}
async function fingerprint(tx: ClinicalCoreTransaction, tables: Table[]) {
  // Read hashes only, never health values into this process or its output. Per-table
  // bounds and statement timeout make this a qualification tool, not a bulk PHI scan.
  const rows: Fingerprint[] = [];
  // Keep each SQL request well below the Data API's request-size bound. Every batch
  // stays in the same snapshot/locked transaction; no table contents cross the API.
  for (let offset = 0; offset < tables.length; offset += 20) {
    const sql = tables.slice(offset, offset + 20).map(t => `select '${t.schema_name}.${t.table_name}' as table_name,count(*)::int as row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash,'' order by row_hash),''),'UTF8')),'hex') as sha256
    from (select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') as row_hash from ${qualified(t)} t limit 5001) bounded`).join('\nunion all\n');
    if (Buffer.byteLength(sql, 'utf8') > 20000) fail('inventory_refused');
    rows.push(...(await tx.query<Fingerprint>(sql)).rows);
  }
  rows.sort((a, b) => a.table_name.localeCompare(b.table_name));
  if (rows.length !== tables.length || new Set(rows.map(r => r.table_name)).size !== tables.length
    || rows.some(r => !Number.isSafeInteger(r.row_count) || r.row_count < 0 || r.row_count > 5000 || !/^[a-f0-9]{64}$/.test(r.sha256))) fail('inventory_refused');
  return { sha256: sha(JSON.stringify(rows)), rows: rows.reduce((n, r) => n + r.row_count, 0) };
}
async function history(tx: ClinicalCoreTransaction, migrations: ClinicalCoreMigration[]) {
  const rows = (await tx.query<{ version: string; sha256: string }>(`select version,sha256 from ${LEDGER} order by version`)).rows;
  if (![102, 103].includes(rows.length) || rows.some((row, i) => row.version !== migrations[i].version || row.sha256 !== migrations[i].sha256)) fail('history_refused');
  return rows.length;
}

/** Separate from the empty installer. Atomic, exact 102->103 transition; never clears
 * fixtures, edits an old ledger row, starts services or activates any provider. */
export async function runQualificationSchemaUpgrade(database: ClinicalCoreDatabase, migrations: ClinicalCoreMigration[],
  configuration: QualificationUpgradeConfiguration, command: 'inspect' | 'upgrade') {
  assertQualificationUpgrade(configuration, migrations);
  if (command !== 'inspect' && command !== 'upgrade') fail('boundary_refused');
  let stage = 'transaction_start';
  try {
    return await database.transaction(async tx => {
      stage = 'transaction_settings';
      // Do not inherit a changed server default for mutable admission.
      await tx.query(command === 'inspect' ? 'set transaction isolation level repeatable read read only' : 'set transaction isolation level read committed');
      await tx.query("set local lock_timeout='5s'");
      await tx.query("set local statement_timeout='30s'");
      // Fail instead of silently fingerprinting an RLS-filtered subset. This setting
      // grants no bypass privilege and does not disable any table's RLS policy.
      await tx.query('set local row_security=off');
      stage = 'database_identity';
      const current = (await tx.query<{ name: string }>('select current_database() as name')).rows[0]?.name;
      if (current !== configuration.qualificationDatabaseName) fail('boundary_refused');
      if (command === 'upgrade') {
        stage = 'operator_locks';
        for (const key of ['ai-desktop-pro:production-clinical-core-migrations', 'ai-desktop-pro:qualification-fixtures']) {
          if ((await tx.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) as acquired', [key])).rows[0]?.acquired !== true) fail('upgrade_busy');
        }
      }
      stage = 'table_inventory';
      const tables = await inventory(tx);
      if (command === 'upgrade') {
        // One deterministic lock order fences ordinary writers too, not just operators
        // which share advisory locks. RLS remains enabled/forced throughout.
        stage = 'writer_locks';
        await tx.query(`lock table ${[...tables.map(qualified), LEDGER].sort().join(',')} in share row exclusive mode`);
        if (JSON.stringify(await inventory(tx)) !== JSON.stringify(tables)) fail('inventory_refused');
      }
      stage = 'ledger_read';
      const count = await history(tx, migrations);
      stage = 'before_fingerprint';
      const before = await fingerprint(tx, tables);
      let applied = false;
      if (command === 'upgrade' && count === 102) {
        stage = 'migration_ddl';
        const migration = migrations[102];
        for (const statement of splitPostgresStatements(migration.sql)) await tx.query(statement);
        stage = 'ledger_receipt';
        await tx.query(`insert into ${LEDGER}(version,name,sha256) values($1,$2,$3)`, [migration.version, migration.name, migration.sha256]);
        applied = true;
      }
      stage = 'after_inventory';
      if (JSON.stringify(await inventory(tx)) !== JSON.stringify(tables)) fail('inventory_refused');
      stage = 'after_fingerprint';
      const after = await fingerprint(tx, tables);
      if (before.sha256 !== after.sha256 || before.rows !== after.rows) fail('data_changed');
      stage = 'final_ledger';
      const finalCount = await history(tx, migrations);
      if (finalCount !== (command === 'upgrade' ? 103 : count)) fail('history_refused');
      if (finalCount === 103) {
        stage = 'function_verification';
        const verified = (await tx.query<{ valid: boolean }>(`select
          exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='clinical_core' and p.proname='find_latest_owned_privacy_export_job'
              and p.pronargs=0 and p.prosecdef and p.prorettype='jsonb'::regtype
              and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$1)
          and has_function_privilege('clinical_core_api','clinical_core.find_latest_owned_privacy_export_job()','EXECUTE')
          and not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
            lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            where n.nspname='clinical_core' and p.proname='find_latest_owned_privacy_export_job' and a.grantee=0 and a.privilege_type='EXECUTE') as valid`,
          [sha(migrations[102].sql.match(/as \$\$([\s\S]*?)\$\$/)?.[1] ?? fail('artifact_refused'))])).rows[0]?.valid;
        if (verified !== true) fail('verification_failed');
      }
      stage = 'transaction_commit';
      return { contract: 'qualification-schema-upgrade/1' as const, command, execution: 'qualification' as const,
        phiAllowed: false as const, activation: 'blocked' as const, database: current,
        fromReleaseSha256: EXPORT_RECOVERY_UPGRADE.from, toReleaseSha256: EXPORT_RECOVERY_UPGRADE.to,
        observedMigrationCount: finalCount, applied, alreadyApplied: count === 103,
        dataPreserved: true, tableCount: tables.length, rowCount: before.rows, dataSha256: after.sha256 };
    });
  } catch (error) { if (error instanceof QualificationUpgradeError) throw error; throw new QualificationUpgradeError('upgrade_failed', stage); }
}
