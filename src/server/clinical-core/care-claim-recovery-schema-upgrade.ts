if (typeof window !== 'undefined') throw new Error('care-claim-recovery-schema-upgrade is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { splitPostgresStatements, type ClinicalCoreMigration } from './migrations';
import { productionArtifactReleaseHash } from './production-migrations';
import { assertQualificationConfiguration } from './qualification-target';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { verifyCareConsentRegistrationSchema } from './care-connections-schema-upgrade';
import { bindCareClaimRecoveryDatabase } from './care-claim-recovery-database-binding';
import type { CareConnectionFunctionBinding } from './care-connections-database-binding';

/** Prepared transition, NOT the canonical ledger or an activation review. The
 * registered artifact remains 105 until privacy disposition and integration. */
export const CARE_CLAIM_RECOVERY_UPGRADE = Object.freeze({
  from: '7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743',
  to: '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b',
  version: '20261006030000',
  sqlSha256: '033ea35ff3d8932a7b3ca13ee9968f072fbe33e7311a2ad010d8cad80b6f0ca8',
  countBefore: 105, countAfter: 106,
});
const NEW_TABLES = ['clinical_core.care_claim_requests', 'clinical_audit.care_claim_events'];
const LEDGER = 'clinical_core.schema_migrations';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Category = 'boundary_refused' | 'artifact_refused' | 'history_refused' | 'inventory_refused'
  | 'upgrade_busy' | 'data_changed' | 'verification_failed' | 'upgrade_failed';
export class CareClaimRecoveryUpgradeError extends Error {
  constructor(readonly category: Category, readonly stage?: string) { super(category); }
}
const fail = (code: Category): never => { throw new CareClaimRecoveryUpgradeError(code); };
type Table = { schema_name: string; table_name: string; kind: string; rls: boolean; forced: boolean } & Record<string, unknown>;
const name = (t: Table) => `${t.schema_name}.${t.table_name}`;
const quote = (v: string) => /^[a-z][a-z0-9_]{0,62}$/.test(v) ? `"${v}"` : fail('inventory_refused');
const qualified = (t: Table) => `${quote(t.schema_name)}.${quote(t.table_name)}`;
const TABLES = `select n.nspname as schema_name,c.relname as table_name,c.relkind::text as kind,
  c.relrowsecurity as rls,c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')
    and c.relkind in ('r','p','f') and not(n.nspname='clinical_core' and c.relname='schema_migrations')
  order by n.nspname,c.relname`;

export function assertCareClaimRecoveryUpgrade(c: QualificationUpgradeConfiguration, migrations: ClinicalCoreMigration[]) {
  try { assertQualificationConfiguration(c, c.region); } catch { fail('boundary_refused'); }
  if (c.expectedAccountId !== '588966314750' || c.region !== 'us-east-2' || c.phiAllowed !== false || c.activation !== 'blocked'
    || c.qualificationDatabaseName !== 'clinical_core_qualification' || c.stagingDatabaseName !== 'clinical_core') fail('boundary_refused');
  if (c.fromReleaseSha256 !== CARE_CLAIM_RECOVERY_UPGRADE.from || c.toReleaseSha256 !== CARE_CLAIM_RECOVERY_UPGRADE.to
    || migrations.length !== 106 || migrations[105].version !== CARE_CLAIM_RECOVERY_UPGRADE.version
    || migrations[105].sha256 !== CARE_CLAIM_RECOVERY_UPGRADE.sqlSha256
    || new Set(migrations.map(m => m.version)).size !== 106
    || migrations.some((m, i) => !/^\d{14}$/.test(m.version) || sha(m.sql) !== m.sha256 || i > 0 && m.version <= migrations[i - 1].version)
    || productionArtifactReleaseHash(migrations.slice(0, 105)) !== CARE_CLAIM_RECOVERY_UPGRADE.from
    || productionArtifactReleaseHash(migrations) !== CARE_CLAIM_RECOVERY_UPGRADE.to) fail('artifact_refused');
}
async function history(tx: ClinicalCoreTransaction, migrations: ClinicalCoreMigration[]) {
  const rows = (await tx.query<{ version: string; sha256: string }>(`select version,sha256 from ${LEDGER} order by version`)).rows;
  if (![105, 106].includes(rows.length) || rows.some((r, i) => r.version !== migrations[i].version || r.sha256 !== migrations[i].sha256))
    fail('history_refused');
  return rows.length;
}
async function inventory(tx: ClinicalCoreTransaction, count: number) {
  const tables = (await tx.query<Table>(TABLES)).rows;
  const old = tables.filter(t => !NEW_TABLES.includes(name(t))), added = tables.filter(t => NEW_TABLES.includes(name(t)));
  if (tables.length !== (count === 105 ? 207 : 209) || old.length !== 207 || added.length !== (count === 105 ? 0 : 2)
    || tables.some(t => t.kind !== 'r' || typeof t.rls !== 'boolean' || typeof t.forced !== 'boolean')
    || added.some(t => !t.rls || !t.forced)
    || sha(old.map(name).sort().join('\n')) !== '56b9f30790275d377f4cadddd319b614f0b37d850e608d06799e575c654e48da') fail('inventory_refused');
  for (const t of tables) qualified(t);
  return { tables, old, added };
}
async function fingerprint(tx: ClinicalCoreTransaction, tables: Table[]) {
  const rows: ({ table_name: string; row_count: number; sha256: string } & Record<string, unknown>)[] = [];
  for (let offset = 0; offset < tables.length; offset += 20) {
    const sql = tables.slice(offset, offset + 20).map(t => `select '${name(t)}' as table_name,count(*)::int as row_count,
      encode(sha256(convert_to(coalesce(string_agg(row_hash,'' order by row_hash),''),'UTF8')),'hex') as sha256
      from (select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') as row_hash from ${qualified(t)} t limit 5001) bounded`).join('\nunion all\n');
    if (Buffer.byteLength(sql) > 20000) fail('inventory_refused');
    rows.push(...(await tx.query<typeof rows[number]>(sql)).rows);
  }
  rows.sort((a, b) => a.table_name.localeCompare(b.table_name));
  if (rows.length !== tables.length || new Set(rows.map(r => r.table_name)).size !== tables.length
    || rows.some(r => !Number.isSafeInteger(r.row_count) || r.row_count < 0 || r.row_count > 5000 || !/^[a-f0-9]{64}$/.test(r.sha256)))
    fail('inventory_refused');
  return { sha256: sha(JSON.stringify(rows)), rows: rows.reduce((n, r) => n + r.row_count, 0) };
}
const functionPins = (sql: string): CareConnectionFunctionBinding[] =>
  [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
    .map(([, functionName, body]) => ({ name: functionName, bodySha256: sha(body), apiExecute: functionName.startsWith('clinical_core.') }));
async function verify(tx: ClinicalCoreTransaction, migrations: ClinicalCoreMigration[], count: number) {
  try {
    await verifyCareConsentRegistrationSchema(tx, migrations[104]);
    if (count === 106) {
      // Exercise the actual transaction binding as the real API role. No
      // identity or business command executes, and no grant is installed.
      await tx.query('set local role clinical_core_api');
      await bindCareClaimRecoveryDatabase({ transaction: work => work(tx) }, functionPins(migrations[104].sql),
        functionPins(migrations[105].sql)).transaction(async () => undefined);
      await tx.query('reset role');
    }
  } catch { fail('verification_failed'); }
}
export type CareClaimRecoveryUpgradeResult = {
  contract: 'care-claim-recovery-schema-upgrade/1'; command: 'inspect' | 'rehearse' | 'upgrade'; execution: 'qualification';
  phiAllowed: false; activation: 'blocked'; canonical: false; observedMigrationCount: number; applied: boolean;
  alreadyApplied: boolean; rolledBack: boolean; dataPreserved: true; tableCount: number; rowCount: number;
  dataSha256: string; fromReleaseSha256: string; toReleaseSha256: string;
};
class RehearsalRollback extends Error {
  constructor(readonly result: CareClaimRecoveryUpgradeResult) { super('qualification_rehearsal_rollback'); }
}

/** Qualification-only preparation. Calling this library needs the independently
 * observed member account/foundation boundary; no AWS entry point is released. */
export async function runCareClaimRecoverySchemaUpgrade(database: ClinicalCoreDatabase, suppliedMigrations: ClinicalCoreMigration[],
  suppliedConfiguration: QualificationUpgradeConfiguration, command: 'inspect' | 'rehearse' | 'upgrade'): Promise<CareClaimRecoveryUpgradeResult> {
  const migrations = suppliedMigrations.map(m => ({ ...m })), c = { ...suppliedConfiguration };
  assertCareClaimRecoveryUpgrade(c, migrations);
  if (!['inspect', 'rehearse', 'upgrade'].includes(command)) fail('boundary_refused');
  let stage = 'transaction_start';
  try {
    return await database.transaction(async tx => {
      stage = 'transaction_settings';
      await tx.query(command === 'inspect' ? 'set transaction isolation level repeatable read read only' : 'set transaction isolation level repeatable read');
      await tx.query("set local lock_timeout='5s'"); await tx.query("set local statement_timeout='30s'");
      await tx.query('set local row_security=off'); // Refuses filtered fingerprints; grants no bypass.
      stage = 'database_identity';
      if ((await tx.query<{ name: string }>('select current_database() as name')).rows[0]?.name !== c.qualificationDatabaseName) fail('boundary_refused');
      if (command !== 'inspect') {
        stage = 'operator_locks';
        for (const key of ['ai-desktop-pro:production-clinical-core-migrations', 'ai-desktop-pro:qualification-fixtures']) {
          if ((await tx.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) as acquired', [key])).rows[0]?.acquired !== true)
            fail('upgrade_busy');
        }
      }
      stage = 'history'; const count = await history(tx, migrations);
      stage = 'inventory'; const beforeTables = await inventory(tx, count);
      if (command !== 'inspect') {
        stage = 'writer_locks';
        await tx.query(`lock table ${[...beforeTables.tables.map(qualified), LEDGER].sort().join(',')} in share row exclusive mode`);
        if (JSON.stringify(await inventory(tx, count)) !== JSON.stringify(beforeTables)) fail('inventory_refused');
      }
      stage = 'before_verification'; await verify(tx, migrations, count);
      stage = 'before_fingerprint'; const before = await fingerprint(tx, beforeTables.tables);
      let applied = false;
      if (command !== 'inspect' && count === 105) {
        stage = 'migration_ddl';
        for (const statement of splitPostgresStatements(migrations[105].sql)) await tx.query(statement);
        stage = 'ledger_receipt'; const m = migrations[105];
        await tx.query(`insert into ${LEDGER}(version,name,sha256) values($1,$2,$3)`, [m.version, m.name, m.sha256]);
        applied = true;
      }
      const finalCount = command === 'inspect' ? count : 106;
      stage = 'final_history'; if (await history(tx, migrations) !== finalCount) fail('history_refused');
      stage = 'after_inventory'; const afterTables = await inventory(tx, finalCount);
      if (JSON.stringify(afterTables.old) !== JSON.stringify(beforeTables.old)) fail('inventory_refused');
      stage = 'after_fingerprint'; const after = await fingerprint(tx, applied ? afterTables.old : afterTables.tables);
      if (before.sha256 !== after.sha256 || before.rows !== after.rows) fail('data_changed');
      if (applied && (await fingerprint(tx, afterTables.added)).rows !== 0) fail('data_changed');
      stage = 'contract_verification'; await verify(tx, migrations, finalCount);
      const result: CareClaimRecoveryUpgradeResult = { contract: 'care-claim-recovery-schema-upgrade/1', command, execution: 'qualification',
        phiAllowed: false, activation: 'blocked', canonical: false, observedMigrationCount: finalCount, applied,
        alreadyApplied: count === 106, rolledBack: false, dataPreserved: true, tableCount: afterTables.tables.length,
        rowCount: before.rows, dataSha256: after.sha256, fromReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.from,
        toReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.to };
      if (command === 'rehearse') throw new RehearsalRollback(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RehearsalRollback) {
      const inspected = await runCareClaimRecoverySchemaUpgrade(database, migrations, c, 'inspect');
      if (inspected.observedMigrationCount !== (error.result.alreadyApplied ? 106 : 105)
        || inspected.dataSha256 !== error.result.dataSha256 || inspected.rowCount !== error.result.rowCount) fail('verification_failed');
      return { ...inspected, command: 'rehearse', rolledBack: true };
    }
    if (error instanceof CareClaimRecoveryUpgradeError) throw error;
    throw new CareClaimRecoveryUpgradeError('upgrade_failed', stage);
  }
}
