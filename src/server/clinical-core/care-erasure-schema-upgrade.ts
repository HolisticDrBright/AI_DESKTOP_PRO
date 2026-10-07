if (typeof window !== 'undefined') throw new Error('care-erasure-schema-upgrade is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { splitPostgresStatements, type ClinicalCoreMigration } from './migrations';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const CARE_ERASURE_UPGRADE = Object.freeze({
  sourceBefore: '1da8cf4c3c8edfa1f3fc2d3230940c65eb33f1e0ad61f25582112c34766f3e22',
  sourceAfter: '52f2027ba0db0fd570bc4714fadf5ccd39e2caabf992081cb24be56497a52017',
  liveBefore: '2563a6bbe70c75bbb2e9c423aececf6cf92eaead44f28da7a8c457225e0ed393',
  liveAfter: '99ad59a94bab717a4e1299979db177394e931c9ebb7f40aa8be1ba1d99d52148',
  reference: '83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62',
  version: '20261006040000', sqlSha256: '3890daeb708511a0f651abd95456906048fb9f4a7bc1ef754b731e9d673dab91',
  oldTableMetadata: '30c0d4c36c2941581cde68d3e887c2c0c3893e5466e17de81455f15bea3738b4',
});
export const CARE_ERASURE_AWS = Object.freeze({ account: '588966314750', region: 'us-east-2',
  profile: 'ai-synthetic-member', foundation: 'ai-clinical-core-synthetic-staging', databaseName: 'clinical_core', apiId: 'wxv734oi12',
  clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-b98d4dce-bd27-475e-ae27-8f11f49c6d09-S79X4B',
});
export type CareErasureUpgradeConfiguration = { account: string; region: string; clusterArn: string; secretArn: string;
  databaseName: string; phiAllowed: false; environment: 'synthetic-staging'; dataClassification: 'synthetic_only' };
type Category = 'boundary_refused' | 'artifact_refused' | 'history_refused' | 'inventory_refused' | 'upgrade_busy'
  | 'data_changed' | 'verification_failed' | 'upgrade_failed';
export class CareErasureUpgradeError extends Error {
  constructor(readonly category: Category, readonly stage?: string) { super(category); }
}
function fail(category: Category): never { throw new CareErasureUpgradeError(category); }
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  ? v as Record<string, unknown> : fail('boundary_refused');
/** Fixed member STS + completed synthetic foundation. No caller/environment target overrides. */
export function careErasureUpgradeFromAws(callerValue: unknown, responseValue: unknown): CareErasureUpgradeConfiguration {
  const c = object(callerValue), a = CARE_ERASURE_AWS;
  if (c.Account !== a.account || typeof c.Arn !== 'string'
    || !/^arn:aws:sts::588966314750:assumed-role\/[A-Za-z0-9_+=,.@/-]+$/.test(c.Arn)) fail('boundary_refused');
  const stacks = object(responseValue).Stacks;
  if (!Array.isArray(stacks) || stacks.length !== 1) fail('boundary_refused');
  const stack = object(stacks[0]);
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(String(stack.StackStatus)) || typeof stack.StackId !== 'string'
    || !stack.StackId.startsWith(`arn:aws:cloudformation:${a.region}:${a.account}:stack/${a.foundation}/`)
    || !Array.isArray(stack.Outputs)) fail('boundary_refused');
  const outputs = new Map<string, string>();
  for (const raw of stack.Outputs) {
    const v = object(raw);
    if (typeof v.OutputKey !== 'string' || typeof v.OutputValue !== 'string' || outputs.has(v.OutputKey)) fail('boundary_refused');
    outputs.set(v.OutputKey, v.OutputValue);
  }
  for (const [key, value] of Object.entries({ PhiAllowed: 'false', Environment: 'synthetic-staging', DataClassification: 'synthetic_only',
    DatabaseName: a.databaseName, ClinicalApiId: a.apiId, DatabaseClusterArn: a.clusterArn, DatabaseSecretArn: a.secretArn })) {
    if (outputs.get(key) !== value) fail('boundary_refused');
  }
  return { account: a.account, region: a.region, databaseName: a.databaseName, clusterArn: a.clusterArn,
    secretArn: a.secretArn, phiAllowed: false, environment: 'synthetic-staging', dataClassification: 'synthetic_only' };
}
type LedgerRow = { version: string; name: string; sha256: string } & Record<string, unknown>;
const ledgerRows = (m: ClinicalCoreMigration[]): LedgerRow[] => m.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
const digest = (m: ClinicalCoreMigration[]) => sha(JSON.stringify(ledgerRows(m)));
function canonical(m: ClinicalCoreMigration[]) {
  if (m.some((x, i) => !/^\d{14}$/.test(x.version) || !/^[a-z0-9_]+$/.test(x.name)
    || sha(x.sql) !== x.sha256 || i > 0 && x.version <= m[i - 1].version)) fail('artifact_refused');
}
export function assertCareErasureUpgrade(c: CareErasureUpgradeConfiguration, m: ClinicalCoreMigration[], reference: ClinicalCoreMigration[]) {
  const a = CARE_ERASURE_AWS, pin = CARE_ERASURE_UPGRADE;
  if (c.account !== a.account || c.region !== a.region || c.clusterArn !== a.clusterArn || c.secretArn !== a.secretArn
    || c.databaseName !== a.databaseName || c.phiAllowed !== false || c.environment !== 'synthetic-staging'
    || c.dataClassification !== 'synthetic_only') fail('boundary_refused');
  canonical(m); canonical(reference);
  if (m.length !== 46 || digest(m.slice(0, 45)) !== pin.sourceBefore || digest(m) !== pin.sourceAfter
    || m[45].version !== pin.version || m[45].sha256 !== pin.sqlSha256 || reference.length !== 2
    || digest(reference) !== pin.reference) fail('artifact_refused');
}
function liveRows(m: ClinicalCoreMigration[], successor: boolean) {
  const rows = ledgerRows(m.slice(0, successor ? 46 : 45));
  // Preserve the registered deployed alias verbatim; never rewrite or reapply it.
  const source = rows.find(x => x.version === '20260821049700');
  if (!source) fail('artifact_refused');
  return [...rows, { ...source, version: '20260902230000' }].sort((a, b) => a.version.localeCompare(b.version));
}
async function history(tx: ClinicalCoreTransaction, m: ClinicalCoreMigration[], reference: ClinicalCoreMigration[]) {
  const rows = (await tx.query<LedgerRow>('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows;
  const successor = rows.length === 47;
  if (![46, 47].includes(rows.length) || JSON.stringify(rows) !== JSON.stringify(liveRows(m, successor))
    || sha(JSON.stringify(rows)) !== (successor ? CARE_ERASURE_UPGRADE.liveAfter : CARE_ERASURE_UPGRADE.liveBefore)) fail('history_refused');
  const catalog = (await tx.query<LedgerRow>('select version,name,sha256 from clinical_reference.schema_migrations order by version')).rows;
  if (JSON.stringify(catalog) !== JSON.stringify(ledgerRows(reference))) fail('history_refused');
  return successor;
}
type Table = { schema_name: string; table_name: string; kind: string; rls: boolean; forced: boolean } & Record<string, unknown>;
const TABLES = `select n.nspname as schema_name,c.relname as table_name,c.relkind::text kind,c.relrowsecurity rls,c.relforcerowsecurity forced
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')
    and c.relkind in ('r','p','f') and c.relname<>'schema_migrations' order by n.nspname,c.relname`;
const newName = 'clinical_core.care_data_erasure_requests';
const name = (t: Table) => `${t.schema_name}.${t.table_name}`;
const quote = (s: string) => /^[a-z][a-z0-9_]{0,62}$/.test(s) ? `"${s}"` : fail('inventory_refused');
const qualified = (t: Table) => `${quote(t.schema_name)}.${quote(t.table_name)}`;
async function inventory(tx: ClinicalCoreTransaction, successor: boolean) {
  const tables = (await tx.query<Table>(TABLES)).rows, old = tables.filter(t => name(t) !== newName);
  if (tables.length !== (successor ? 88 : 87) || old.length !== 87 || sha(JSON.stringify(old)) !== CARE_ERASURE_UPGRADE.oldTableMetadata
    || tables.some(t => t.kind !== 'r') || successor && !tables.some(t => name(t) === newName && t.rls && !t.forced)) fail('inventory_refused');
  tables.forEach(qualified);
  return { tables, old, added: tables.filter(t => name(t) === newName) };
}
async function fingerprint(tx: ClinicalCoreTransaction, tables: Table[]) {
  const rows: ({ table_name: string; row_count: number; sha256: string } & Record<string, unknown>)[] = [];
  for (let offset = 0; offset < tables.length; offset += 20) {
    const sql = tables.slice(offset, offset + 20).map(t => `select '${name(t)}' table_name,count(*)::int row_count,
      encode(sha256(convert_to(coalesce(string_agg(row_hash,'' order by row_hash),''),'UTF8')),'hex') sha256
      from (select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') row_hash from ${qualified(t)} t limit 5001) bounded`).join('\nunion all\n');
    if (Buffer.byteLength(sql) > 20000) fail('inventory_refused');
    rows.push(...(await tx.query<typeof rows[number]>(sql)).rows);
  }
  rows.sort((a, b) => a.table_name.localeCompare(b.table_name));
  if (rows.length !== tables.length || new Set(rows.map(r => r.table_name)).size !== tables.length
    || rows.some(r => !Number.isSafeInteger(r.row_count) || r.row_count < 0 || r.row_count > 5000 || !/^[a-f0-9]{64}$/.test(r.sha256))) fail('inventory_refused');
  return { sha256: sha(JSON.stringify(rows)), rows: rows.reduce((n, r) => n + r.row_count, 0) };
}
function body(m: ClinicalCoreMigration[], functionName: string) {
  let found: string | undefined;
  for (const x of m) for (const match of x.sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)) {
    if (match[1] === functionName) found = match[2];
  }
  if (found === undefined) fail('artifact_refused');
  return sha(found);
}
async function verify(tx: ClinicalCoreTransaction, m: ClinicalCoreMigration[], successor: boolean) {
  const functions = [{ name: 'clinical_core.care_data_erase', signature: '(jsonb)', result: 'jsonb', definer: true, api: !successor },
    { name: 'clinical_private.care_data_immutable', signature: '()', result: 'trigger', definer: false, api: false },
    ...(successor ? [{ name: 'clinical_core.care_data_erasure_request', signature: '(jsonb)', result: 'jsonb', definer: true, api: true }] : [])];
  for (const f of functions) {
    const [schema, fname] = f.name.split('.');
    const valid = (await tx.query<{ valid: boolean }>(`select count(*)=1 and bool_and(p.oid=to_regprocedure($1)
      and p.prokind='f' and p.prorettype=$2::regtype and p.prosecdef=$3
      and p.prolang=(select oid from pg_language where lanname='plpgsql')
      and (not $3 or p.proconfig=array['search_path=""']::text[])
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$4
      and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')=$5
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0)) valid
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$6 and p.proname=$7`,
    [f.name + f.signature, f.result, f.definer, body(m.slice(0, successor ? 46 : 45), f.name), f.api, schema, fname])).rows[0]?.valid;
    if (valid !== true) fail('verification_failed');
  }
  if (!successor) {
    if ((await tx.query<{ absent: boolean }>("select to_regprocedure('clinical_core.care_data_erasure_request(jsonb)') is null absent")).rows[0]?.absent !== true)
      fail('verification_failed');
    return;
  }
  const valid = (await tx.query<{ valid: boolean }>(`select c.relrowsecurity and not c.relforcerowsecurity
    and not has_table_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_any_column_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
    and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0)
    and not exists(select 1 from pg_attribute a,lateral aclexplode(a.attacl) x where a.attrelid=c.oid and x.grantee=0)
    and exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname='care_data_erasure_requests_immutable'
      and not t.tgisinternal and t.tgenabled='O' and t.tgtype=27 and t.tgfoid='clinical_private.care_data_immutable()'::regprocedure)
    and exists(select 1 from pg_constraint k where k.conrelid=c.oid and k.contype='p'
      and pg_get_constraintdef(k.oid)='PRIMARY KEY (owner_id, request_id)') valid
    from pg_class c where c.oid='clinical_core.care_data_erasure_requests'::regclass`)).rows[0]?.valid;
  if (valid !== true) fail('verification_failed');
  // PostgreSQL 18 exposes NOT NULL as additional pg_constraint rows, while
  // Aurora's older major versions use attnotnull. Compare those via columns.
  const cols = (await tx.query(`select attname name,format_type(atttypid,atttypmod) type,attnotnull required,
    pg_get_expr(d.adbin,d.adrelid) default_value from pg_attribute a
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid=$1::regclass and a.attnum>0 and not a.attisdropped order by a.attnum`, [newName])).rows;
  const constraints = (await tx.query(`select contype::text kind,convalidated validated,pg_get_constraintdef(oid) definition
    from pg_constraint where conrelid=$1::regclass and contype<>'n' order by contype,pg_get_constraintdef(oid)`, [newName])).rows;
  if (sha(JSON.stringify({ cols, constraints })) !== '5d1c88f1c605d77e0d9ccc613e700c5f6cba3a7691518d09909fedde203b0031') fail('verification_failed');
}
export type CareErasureUpgradeResult = { contract: 'care-erasure-schema-upgrade/1'; execution: 'synthetic-staging'; phiAllowed: false;
  command: 'inspect' | 'rehearse' | 'upgrade'; observedMigrationCount: 46 | 47; sourceMigrationCount: 45 | 46; tableCount: number;
  rowCount: number; dataSha256: string; dataPreserved: true; applied: boolean; alreadyApplied: boolean; rolledBack: boolean;
  fromLedgerSha256: string; toLedgerSha256: string; referenceLedgerSha256: string };
class RehearsalRollback extends Error { constructor(readonly result: CareErasureUpgradeResult) { super('synthetic_rehearsal_rollback'); } }
/** Only the exact staging successor, with all clinical and reference rows preserved.
 * No fixture, consent, activation, account erasure or production migration is admitted. */
export async function runCareErasureSchemaUpgrade(database: ClinicalCoreDatabase, supplied: ClinicalCoreMigration[],
  suppliedReference: ClinicalCoreMigration[], suppliedConfiguration: CareErasureUpgradeConfiguration,
  command: 'inspect' | 'rehearse' | 'upgrade'): Promise<CareErasureUpgradeResult> {
  const m = supplied.map(x => ({ ...x })), reference = suppliedReference.map(x => ({ ...x })), c = { ...suppliedConfiguration };
  assertCareErasureUpgrade(c, m, reference);
  if (!['inspect', 'rehearse', 'upgrade'].includes(command)) fail('boundary_refused');
  let stage = 'transaction_start';
  try {
    return await database.transaction(async tx => {
      stage = 'transaction_settings';
      await tx.query(command === 'inspect' ? 'set transaction isolation level repeatable read read only' : 'set transaction isolation level repeatable read');
      await tx.query("set local lock_timeout='5s'"); await tx.query("set local statement_timeout='30s'"); await tx.query('set local row_security=off');
      stage = 'database_identity';
      if ((await tx.query<{ name: string }>('select current_database() as name')).rows[0]?.name !== c.databaseName) fail('boundary_refused');
      if (command !== 'inspect') {
        stage = 'operator_locks';
        for (const key of ['ai-desktop-pro:clinical-core-migrations', 'ai-desktop-pro:governed-catalog-migrations']) {
          if ((await tx.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) acquired', [key])).rows[0]?.acquired !== true) fail('upgrade_busy');
        }
      }
      stage = 'history'; const successor = await history(tx, m, reference);
      stage = 'inventory'; const beforeTables = await inventory(tx, successor);
      if (command !== 'inspect') {
        stage = 'writer_locks';
        await tx.query(`lock table ${[...beforeTables.tables.map(qualified), 'clinical_core.schema_migrations', 'clinical_reference.schema_migrations'].sort().join(',')} in share row exclusive mode`);
        if (JSON.stringify(await inventory(tx, successor)) !== JSON.stringify(beforeTables)) fail('inventory_refused');
      }
      stage = 'before_verification'; await verify(tx, m, successor);
      stage = 'before_fingerprint'; const before = await fingerprint(tx, beforeTables.tables);
      let applied = false;
      if (command !== 'inspect' && !successor) {
        stage = 'migration_ddl'; for (const statement of splitPostgresStatements(m[45].sql)) await tx.query(statement);
        stage = 'ledger_receipt'; const x = m[45];
        await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [x.version, x.name, x.sha256]);
        applied = true;
      }
      const final = command === 'inspect' ? successor : true;
      stage = 'after_history'; if (await history(tx, m, reference) !== final) fail('history_refused');
      stage = 'after_inventory'; const afterTables = await inventory(tx, final);
      if (JSON.stringify(beforeTables.old) !== JSON.stringify(afterTables.old)) fail('inventory_refused');
      stage = 'after_fingerprint'; const after = await fingerprint(tx, applied ? afterTables.old : afterTables.tables);
      if (before.sha256 !== after.sha256 || before.rows !== after.rows || applied && (await fingerprint(tx, afterTables.added)).rows !== 0) fail('data_changed');
      stage = 'contract_verification'; await verify(tx, m, final);
      const result: CareErasureUpgradeResult = { contract: 'care-erasure-schema-upgrade/1', execution: 'synthetic-staging', phiAllowed: false,
        command, observedMigrationCount: final ? 47 : 46, sourceMigrationCount: final ? 46 : 45, tableCount: afterTables.tables.length,
        rowCount: before.rows, dataSha256: after.sha256, dataPreserved: true, applied, alreadyApplied: successor, rolledBack: false,
        fromLedgerSha256: CARE_ERASURE_UPGRADE.liveBefore, toLedgerSha256: CARE_ERASURE_UPGRADE.liveAfter, referenceLedgerSha256: CARE_ERASURE_UPGRADE.reference };
      if (command === 'rehearse') throw new RehearsalRollback(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RehearsalRollback) {
      const inspected = await runCareErasureSchemaUpgrade(database, m, reference, c, 'inspect');
      if (inspected.observedMigrationCount !== (error.result.alreadyApplied ? 47 : 46)
        || inspected.rowCount !== error.result.rowCount || inspected.dataSha256 !== error.result.dataSha256) fail('verification_failed');
      return { ...inspected, command: 'rehearse', rolledBack: true };
    }
    if (error instanceof CareErasureUpgradeError) throw error;
    throw new CareErasureUpgradeError('upgrade_failed', stage);
  }
}
