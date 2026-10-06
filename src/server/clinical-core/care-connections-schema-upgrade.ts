if (typeof window !== 'undefined') throw new Error('care-connections-schema-upgrade is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { splitPostgresStatements, type ClinicalCoreMigration } from './migrations';
import { productionArtifactReleaseHash } from './production-migrations';
import { assertQualificationConfiguration } from './qualification-target';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';

export const CARE_CONNECTIONS_UPGRADE = Object.freeze({
  from: '57fdf022f0fdd7d70be12384d6e6d54caab1a0ddb4965a884e4d59eec4c552b0',
  to: '7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743',
  version: '20261006020000', countBefore: 104, countAfter: 105,
});
const NEW_TABLES = ['clinical_core.care_consent_texts'];
const LEDGER = 'clinical_core.schema_migrations';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Category = 'boundary_refused' | 'artifact_refused' | 'history_refused' | 'inventory_refused' | 'data_changed'
  | 'upgrade_busy' | 'verification_failed' | 'upgrade_failed';
export class CareConnectionsUpgradeError extends Error {
  constructor(readonly category: Category, readonly stage?: string) { super(category); }
}
function fail(code: Category): never { throw new CareConnectionsUpgradeError(code); }
type Table = { schema_name: string; table_name: string; kind: string; rls: boolean; forced: boolean } & Record<string, unknown>;
const name = (t: Table) => `${t.schema_name}.${t.table_name}`;
const quote = (v: string) => /^[a-z][a-z0-9_]{0,62}$/.test(v) ? `"${v}"` : fail('inventory_refused');
const qualified = (t: Table) => `${quote(t.schema_name)}.${quote(t.table_name)}`;
const TABLES = `select n.nspname as schema_name,c.relname as table_name,c.relkind::text as kind,
  c.relrowsecurity as rls,c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')
    and c.relkind in ('r','p','f') and not(n.nspname='clinical_core' and c.relname='schema_migrations')
  order by n.nspname,c.relname`;
export function assertCareConnectionsUpgrade(c: QualificationUpgradeConfiguration, migrations: ClinicalCoreMigration[]) {
  try { assertQualificationConfiguration(c, c.region); } catch { fail('boundary_refused'); }
  if (c.expectedAccountId !== '588966314750' || c.region !== 'us-east-2' || c.phiAllowed !== false || c.activation !== 'blocked'
    || c.qualificationDatabaseName !== 'clinical_core_qualification' || c.stagingDatabaseName !== 'clinical_core') fail('boundary_refused');
  if (c.fromReleaseSha256 !== CARE_CONNECTIONS_UPGRADE.from || c.toReleaseSha256 !== CARE_CONNECTIONS_UPGRADE.to
    || migrations.length !== 105 || migrations[104].version !== CARE_CONNECTIONS_UPGRADE.version
    || new Set(migrations.map(m => m.version)).size !== 105
    || migrations.some((m, i) => !/^\d{14}$/.test(m.version) || sha(m.sql) !== m.sha256 || i > 0 && m.version <= migrations[i - 1].version)
    || productionArtifactReleaseHash(migrations.slice(0, 104)) !== CARE_CONNECTIONS_UPGRADE.from
    || productionArtifactReleaseHash(migrations) !== CARE_CONNECTIONS_UPGRADE.to) fail('artifact_refused');
}
async function history(tx: ClinicalCoreTransaction, migrations: ClinicalCoreMigration[]) {
  const rows = (await tx.query<{ version: string; sha256: string }>(`select version,sha256 from ${LEDGER} order by version`)).rows;
  if (![104, 105].includes(rows.length) || rows.some((r, i) => r.version !== migrations[i].version || r.sha256 !== migrations[i].sha256)) fail('history_refused');
  return rows.length;
}
async function inventory(tx: ClinicalCoreTransaction, count: number) {
  const tables = (await tx.query<Table>(TABLES)).rows;
  const old = tables.filter(t => !NEW_TABLES.includes(name(t))), added = tables.filter(t => NEW_TABLES.includes(name(t)));
  if (tables.length !== (count === 104 ? 206 : 207) || old.length !== 206 || added.length !== (count === 104 ? 0 : 1)
    || tables.some(t => t.kind !== 'r' || typeof t.rls !== 'boolean' || typeof t.forced !== 'boolean')
    || added.some(t => !t.rls || !t.forced)
    || sha(old.map(name).sort().join('\n')) !== 'ff2f991845392493188149083e42c65367b77a3b000ff69b70803795cd8eec9b') fail('inventory_refused');
  for (const t of tables) qualified(t);
  return { tables, old, added };
}
async function fingerprint(tx: ClinicalCoreTransaction, tables: Table[]) {
  const rows: ({ table_name: string; row_count: number; sha256: string } & Record<string, unknown>)[] = [];
  // Database-side digests only: do not carry fictional/clinical content into logs.
  for (let offset = 0; offset < tables.length; offset += 20) {
    const sql = tables.slice(offset, offset + 20).map(t => `select '${name(t)}' as table_name,count(*)::int as row_count,
      encode(sha256(convert_to(coalesce(string_agg(row_hash,'' order by row_hash),''),'UTF8')),'hex') as sha256
      from (select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') as row_hash from ${qualified(t)} t limit 5001) bounded`).join('\nunion all\n');
    if (Buffer.byteLength(sql) > 20000) fail('inventory_refused');
    rows.push(...(await tx.query<typeof rows[number]>(sql)).rows);
  }
  rows.sort((a, b) => a.table_name.localeCompare(b.table_name));
  if (rows.length !== tables.length || new Set(rows.map(r => r.table_name)).size !== tables.length
    || rows.some(r => !Number.isSafeInteger(r.row_count) || r.row_count < 0 || r.row_count > 5000 || !/^[a-f0-9]{64}$/.test(r.sha256))) fail('inventory_refused');
  return { sha256: sha(JSON.stringify(rows)), rows: rows.reduce((n, r) => n + r.row_count, 0) };
}
async function verify(tx: ClinicalCoreTransaction, migration: ClinicalCoreMigration) {
  const functions = ['clinical_private.guard_care_consent_text', 'clinical_private.serialize_care_consent_release',
    'clinical_private.protect_care_consent_artifact', 'clinical_private.care_connection_actor',
    'clinical_private.care_connection_artifact', 'clinical_core.create_sync_invitation',
    'clinical_core.production_care_connection_request'];
  for (const f of functions) {
    const index = [`create function ${f}(`, `create or replace function ${f}(`]
      .map(declaration => migration.sql.indexOf(declaration)).find(position => position >= 0);
    if (index === undefined) fail('artifact_refused');
    const body = migration.sql.slice(index).match(/as \$\$([\s\S]*?)\$\$/)?.[1];
    if (body === undefined) fail('artifact_refused');
    const [schema, functionName] = f.split('.');
    const signature = f === 'clinical_core.create_sync_invitation' ? `${f}(uuid,uuid)`
      : f === 'clinical_core.production_care_connection_request' ? `${f}(jsonb)`
        : f === 'clinical_private.care_connection_actor' ? `${f}(text,text)`
          : f === 'clinical_private.care_connection_artifact' ? `${f}(text)` : `${f}()`;
    const returnType = schema === 'clinical_core' ? 'jsonb'
      : functionName === 'care_connection_actor' ? 'uuid'
        : functionName === 'care_connection_artifact' ? 'clinical_core.consent_artifacts' : 'trigger';
    const result = await tx.query<{ valid: boolean }>(`select count(*)=1 and bool_and(p.prosecdef
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$3
      and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')=$4
      and p.oid=to_regprocedure($5) and p.prorettype=$6::regtype
      and p.proconfig=array['search_path=""']::text[]
      and p.prokind='f' and p.provolatile=$7
      and p.prolang=(select oid from pg_language where lanname='plpgsql')
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE')) as valid
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2`,
    [schema, functionName, sha(body), schema === 'clinical_core', signature, returnType,
      functionName === 'care_connection_actor' ? 's' : 'v']);
    if (result.rows[0]?.valid !== true) fail('verification_failed');
  }
  for (const table of NEW_TABLES) {
    const result = await tx.query<{ valid: boolean }>(`select not has_table_privilege('clinical_core_api',$1,'SELECT,INSERT,UPDATE,DELETE')
      and not exists(select 1 from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        where c.oid=$1::regclass and a.grantee=0 and a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')) as valid`, [table]);
    if (result.rows[0]?.valid !== true) fail('verification_failed');
  }
  const triggers = (await tx.query<{ valid: boolean }>(`with expected(table_name,trigger_name,function_name,event_mask) as (values
    ('clinical_core.care_consent_texts','care_consent_texts_immutable','block_update_delete',27),
    ('clinical_core.care_consent_texts','care_consent_texts_approved','guard_care_consent_text',7),
    ('clinical_core.consent_artifacts','care_consent_release_serialized','serialize_care_consent_release',23),
    ('clinical_core.consent_artifacts','care_consent_artifact_immutable','protect_care_consent_artifact',19))
    select count(*)=4 and bool_and(not t.tgisinternal and t.tgenabled='O' and t.tgtype=e.event_mask
      and n.nspname='clinical_private' and p.proname=e.function_name and p.pronargs=0) as valid
    from expected e join pg_trigger t on t.tgname=e.trigger_name and t.tgrelid=e.table_name::regclass
    join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace`)).rows[0]?.valid;
  if (triggers !== true) fail('verification_failed');
}
type Result = { contract: 'care-connections-schema-upgrade/1'; command: 'inspect' | 'rehearse' | 'upgrade'; execution: 'qualification';
  phiAllowed: false; activation: 'blocked'; observedMigrationCount: number; applied: boolean; alreadyApplied: boolean; rolledBack: boolean;
  dataPreserved: true; tableCount: number; rowCount: number; dataSha256: string; fromReleaseSha256: string; toReleaseSha256: string };
class RehearsalRollback extends Error { constructor(readonly result: Result) { super('qualification_rehearsal_rollback'); } }

/** Exact fictional qualification transition. Never touches staging, drops rows,
 * rewrites an earlier migration, enables APIs, grants consent or activates PHI. */
export async function runCareConnectionsSchemaUpgrade(database: ClinicalCoreDatabase, suppliedMigrations: ClinicalCoreMigration[],
  suppliedConfiguration: QualificationUpgradeConfiguration, command: 'inspect' | 'rehearse' | 'upgrade'): Promise<Result> {
  // The artifact admitted before an asynchronous transaction is the artifact
  // executed and reported afterward. Caller mutation is never new authority.
  const migrations = suppliedMigrations.map(migration => ({ ...migration }));
  const c = { ...suppliedConfiguration };
  assertCareConnectionsUpgrade(c, migrations);
  if (!['inspect', 'rehearse', 'upgrade'].includes(command)) fail('boundary_refused');
  let stage = 'transaction_start';
  try {
    return await database.transaction(async tx => {
      stage = 'transaction_settings';
      await tx.query(command === 'inspect' ? 'set transaction isolation level repeatable read read only' : 'set transaction isolation level repeatable read');
      await tx.query("set local lock_timeout='5s'"); await tx.query("set local statement_timeout='30s'");
      await tx.query('set local row_security=off'); // Refuse filtered fingerprints, not grant RLS bypass.
      stage = 'database_identity';
      if ((await tx.query<{ name: string }>('select current_database() as name')).rows[0]?.name !== c.qualificationDatabaseName) fail('boundary_refused');
      if (command !== 'inspect') {
        stage = 'operator_locks';
        for (const key of ['ai-desktop-pro:production-clinical-core-migrations', 'ai-desktop-pro:qualification-fixtures']) {
          if ((await tx.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) as acquired', [key])).rows[0]?.acquired !== true) fail('upgrade_busy');
        }
      }
      stage = 'history'; const count = await history(tx, migrations);
      stage = 'inventory'; const beforeTables = await inventory(tx, count);
      if (command !== 'inspect') {
        stage = 'writer_locks';
        await tx.query(`lock table ${[...beforeTables.tables.map(qualified), LEDGER].sort().join(',')} in share row exclusive mode`);
        if (JSON.stringify(await inventory(tx, count)) !== JSON.stringify(beforeTables)) fail('inventory_refused');
      }
      stage = 'before_fingerprint'; const before = await fingerprint(tx, beforeTables.tables);
      let applied = false;
      if (command !== 'inspect' && count === 104) {
        stage = 'migration_ddl';
        for (const statement of splitPostgresStatements(migrations[104].sql)) await tx.query(statement);
        stage = 'ledger_receipt';
        const m = migrations[104]; await tx.query(`insert into ${LEDGER}(version,name,sha256) values($1,$2,$3)`, [m.version, m.name, m.sha256]);
        applied = true;
      }
      const finalCount = command === 'inspect' ? count : 105;
      stage = 'final_history'; if (await history(tx, migrations) !== finalCount) fail('history_refused');
      stage = 'after_inventory'; const afterTables = await inventory(tx, finalCount);
      if (JSON.stringify(afterTables.old) !== JSON.stringify(beforeTables.old)) fail('inventory_refused');
      stage = 'after_fingerprint';
      const after = await fingerprint(tx, applied ? afterTables.old : afterTables.tables);
      if (before.sha256 !== after.sha256 || before.rows !== after.rows) fail('data_changed');
      if (applied && (await fingerprint(tx, afterTables.added)).rows !== 0) fail('data_changed');
      if (finalCount === 105) { stage = 'contract_verification'; await verify(tx, migrations[104]); }
      const result: Result = { contract: 'care-connections-schema-upgrade/1', command, execution: 'qualification', phiAllowed: false,
        activation: 'blocked', observedMigrationCount: finalCount, applied, alreadyApplied: count === 105, rolledBack: false,
        dataPreserved: true, tableCount: afterTables.tables.length, rowCount: before.rows, dataSha256: after.sha256,
        fromReleaseSha256: CARE_CONNECTIONS_UPGRADE.from, toReleaseSha256: CARE_CONNECTIONS_UPGRADE.to };
      if (command === 'rehearse') throw new RehearsalRollback(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RehearsalRollback) {
      // Read back after the transaction has actually rolled back; don't infer it.
      const inspected = await runCareConnectionsSchemaUpgrade(database, migrations, c, 'inspect');
      if (inspected.observedMigrationCount !== (error.result.alreadyApplied ? 105 : 104)
        || inspected.dataSha256 !== error.result.dataSha256 || inspected.rowCount !== error.result.rowCount) fail('verification_failed');
      return { ...inspected, command: 'rehearse', rolledBack: true };
    }
    if (error instanceof CareConnectionsUpgradeError) throw error;
    throw new CareConnectionsUpgradeError('upgrade_failed', stage);
  }
}
