if (typeof window !== 'undefined') throw new Error('adopted-plan-inventory-schema-upgrade is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { splitPostgresStatements, type ClinicalCoreMigration } from './migrations';
import { productionArtifactReleaseHash } from './production-migrations';
import { assertQualificationConfiguration } from './qualification-target';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { careErasurePreservation } from './care-erasure-schema-upgrade';

export const ADOPTED_INVENTORY_UPGRADE = Object.freeze({
  from: '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b',
  to: '542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c',
  version: '20261009010000', sqlSha256: '9624b2c199421a52e0ddba03ae8dd2a5fb6a578e7f9380f42a066a343d6b53c5',
  tableCount: 209, tableNamesSha256: 'c627ee381347d585bbeb1bd8d4e95a0df640de14dd1ab0989157fda4a4c2cd38',
});
const FUNCTIONS = [
  ['clinical_core.verify_product_ingredient_inventory', '(uuid,jsonb)', 'void'],
  ['clinical_core.withdraw_product_ingredient_inventory', '(uuid,text)', 'void'],
  ['clinical_core.get_owned_plan_inventory_source', '()', 'jsonb'],
] as const;
const LEDGER = 'clinical_core.schema_migrations';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
type Category = 'boundary_refused' | 'artifact_refused' | 'history_refused' | 'inventory_refused'
  | 'upgrade_busy' | 'data_changed' | 'verification_failed' | 'upgrade_failed';
export class AdoptedInventoryUpgradeError extends Error {
  constructor(readonly category: Category, readonly stage?: string) { super(category); }
}
const fail = (category: Category): never => { throw new AdoptedInventoryUpgradeError(category); };
type Table = { schema_name: string; table_name: string; kind: string; rls: boolean; forced: boolean } & Record<string, unknown>;

export function assertAdoptedInventoryUpgrade(c: QualificationUpgradeConfiguration, m: ClinicalCoreMigration[]) {
  try { assertQualificationConfiguration(c, c.region); } catch { fail('boundary_refused'); }
  if (c.expectedAccountId !== '588966314750' || c.region !== 'us-east-2' || c.phiAllowed !== false || c.activation !== 'blocked'
    || c.qualificationDatabaseName !== 'clinical_core_qualification' || c.stagingDatabaseName !== 'clinical_core') fail('boundary_refused');
  if (c.fromReleaseSha256 !== ADOPTED_INVENTORY_UPGRADE.from || c.toReleaseSha256 !== ADOPTED_INVENTORY_UPGRADE.to
    || m.length !== 107 || new Set(m.map(row => row.version)).size !== 107
    || m.some((row, i) => !/^\d{14}$/.test(row.version) || sha(row.sql) !== row.sha256 || i > 0 && m[i - 1].version >= row.version)
    || m[106].version !== ADOPTED_INVENTORY_UPGRADE.version || m[106].sha256 !== ADOPTED_INVENTORY_UPGRADE.sqlSha256
    || productionArtifactReleaseHash(m.slice(0, 106)) !== ADOPTED_INVENTORY_UPGRADE.from
    || productionArtifactReleaseHash(m) !== ADOPTED_INVENTORY_UPGRADE.to) fail('artifact_refused');
}
async function history(tx: ClinicalCoreTransaction, m: ClinicalCoreMigration[]) {
  const rows = (await tx.query<{ version: string; sha256: string }>(`select version,sha256 from ${LEDGER} order by version`)).rows;
  if (![106, 107].includes(rows.length) || rows.some((r, i) => r.version !== m[i].version || r.sha256 !== m[i].sha256)) fail('history_refused');
  return rows.length;
}
async function inventory(tx: ClinicalCoreTransaction) {
  const tables = (await tx.query<Table>(careErasurePreservation.tableQuery)).rows;
  if (tables.length !== ADOPTED_INVENTORY_UPGRADE.tableCount || tables.some(t => t.kind !== 'r')
    || sha(tables.map(careErasurePreservation.tableName).join('\n')) !== ADOPTED_INVENTORY_UPGRADE.tableNamesSha256) fail('inventory_refused');
  tables.forEach(careErasurePreservation.qualified);
  return tables;
}
async function functions(tx: ClinicalCoreTransaction, sql: string, count: number) {
  const pins = FUNCTIONS.map(([name, args, result]) => {
    const match = [...sql.matchAll(/create function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)].find(m => m[1] === name);
    if (!match) return fail('artifact_refused');
    return { schema: 'clinical_core', name: name.split('.')[1], signature: name + args, result, sha256: sha(match[2]) };
  });
  const rows = (await tx.query<{ valid: boolean }>(`with expected as (
    select * from jsonb_to_recordset($1::jsonb) e(schema text,name text,signature text,result text,sha256 text)
  ), found as (
    select p.*,e.signature,e.result,e.sha256 from expected e join pg_namespace n on n.nspname=e.schema
      join pg_proc p on p.pronamespace=n.oid and p.proname=e.name
  ) select case when $2::int=106 then count(*)=0 else count(*)=3 and bool_and(
    oid=to_regprocedure(signature) and prorettype=result::regtype and prokind='f' and provolatile='v' and prosecdef
    and not proisstrict and not proleakproof and proparallel='u'
    and prolang=(select oid from pg_language where lanname='plpgsql') and proconfig=array['search_path=""']::text[]
    and proowner=(select oid from pg_roles where rolname=current_user)
    and encode(sha256(convert_to(prosrc,'UTF8')),'hex')=sha256
    and has_function_privilege('clinical_core_api',oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a
      where a.privilege_type='EXECUTE' and (a.is_grantable
        or a.grantee not in (proowner,(select oid from pg_roles where rolname='clinical_core_api'))))) end valid from found`, [JSON.stringify(pins), count])).rows;
  if (rows[0]?.valid !== true) fail('verification_failed');
}
/** Same-engine equality of all historical objects. Only the three exact new
 * signatures are excluded, and each is checked separately. No table, policy,
 * trigger, grant, role, existing function or entire schema is excluded. */
async function schema(tx: ClinicalCoreTransaction, tables: Table[]) {
  const names = [...tables.map(careErasurePreservation.tableName), LEDGER];
  const entries = (await tx.query<{ name: string; digest: string }>(`select selected.name,
    encode(sha256(convert_to(jsonb_build_object(
      'relation',jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
        'owner',c.relowner::regrole::text,'acl',coalesce(c.relacl,acldefault('r',c.relowner))::text),
      'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
        'required',a.attnotnull,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
        from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
      'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'validated',k.convalidated,'def',pg_get_constraintdef(k.oid))
        order by k.conname) from pg_constraint k where k.conrelid=c.oid),
      'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=c.oid),
      'policies',(select jsonb_agg(to_jsonb(p)-'oid'-'polrelid' order by p.polname) from pg_policy p where p.polrelid=c.oid),
      'triggers',(select jsonb_agg(jsonb_build_object('enabled',t.tgenabled,'internal',t.tgisinternal,'def',pg_get_triggerdef(t.oid)) order by t.tgname)
        from pg_trigger t where t.tgrelid=c.oid)
    )::text,'UTF8')),'hex') digest from jsonb_array_elements_text($1::jsonb) with ordinality selected(name,position)
    join pg_class c on c.oid=selected.name::regclass order by selected.position`, [JSON.stringify(names)])).rows;
  if (entries.length !== names.length || entries.some((e, i) => e.name !== names[i] || !/^[a-f0-9]{64}$/.test(e.digest))) fail('verification_failed');
  const exclusions = FUNCTIONS.map(([name, args]) => name + args);
  const global = (await tx.query<{ digest: string }>(`select encode(sha256(convert_to(jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
      'owner',p.proowner::regrole::text,'acl',coalesce(p.proacl,acldefault('f',p.proowner))::text)
      order by n.nspname,p.proname,p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')
        and p.prokind in ('f','p') and not exists(select 1 from jsonb_array_elements_text($1::jsonb) e where p.oid=to_regprocedure(e))),
    'schemas',(select jsonb_agg(jsonb_build_object('name',n.nspname,'owner',n.nspowner::regrole::text,
      'acl',coalesce(n.nspacl,acldefault('n',n.nspowner))::text) order by n.nspname) from pg_namespace n
      where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')),
    'other_relations',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,
      'owner',c.relowner::regrole::text,'acl',c.relacl::text,
      'view',case when c.relkind in ('v','m') then pg_get_viewdef(c.oid) else null end) order by n.nspname,c.relname)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference') and c.relkind not in ('r','i','t')),
    'types',(select jsonb_agg(jsonb_build_object('type',to_jsonb(t)-'oid',
      'enum',(select jsonb_agg(to_jsonb(e)-'oid' order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid),
      'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'def',pg_get_constraintdef(k.oid)) order by k.conname)
        from pg_constraint k where k.contypid=t.oid)) order by n.nspname,t.typname)
      from pg_type t join pg_namespace n on n.oid=t.typnamespace
      where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')),
    'default_acl',(select jsonb_agg(to_jsonb(d)-'oid' order by d.defaclrole,d.defaclnamespace,d.defaclobjtype)
      from pg_default_acl d where d.defaclnamespace=0 or d.defaclnamespace in
        (select oid from pg_namespace where nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference'))),
    'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
    'memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor) from pg_auth_members m
    )
  )::text,'UTF8')),'hex') digest`, [JSON.stringify(exclusions)])).rows[0];
  if (!global || !/^[a-f0-9]{64}$/.test(global.digest)) fail('verification_failed');
  return sha(JSON.stringify({ tables: entries, global: global.digest }));
}
async function data(tx: ClinicalCoreTransaction, tables: Table[]) {
  const rows = await careErasurePreservation.fingerprint(tx, tables);
  // Preserve all fields of every historic migration receipt, not merely its
  // version/hash. The one authorized successor receipt is checked separately.
  const ledger = (await tx.query<{ count: number; digest: string }>(`select count(*)::int as count,
    encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(m) order by version),'[]'::jsonb)::text,'UTF8')),'hex') digest
    from clinical_core.schema_migrations m where version<>$1`, [ADOPTED_INVENTORY_UPGRADE.version])).rows[0];
  if (!ledger || ledger.count !== 106 || !/^[a-f0-9]{64}$/.test(ledger.digest)) fail('history_refused');
  return { rows: rows.rows, sha256: sha(JSON.stringify({ data: rows.sha256, historicReceipts: ledger.digest })) };
}
export type AdoptedInventoryUpgradeResult = {
  contract: 'adopted-plan-inventory-schema-upgrade/1'; command: 'inspect' | 'rehearse' | 'upgrade';
  execution: 'qualification'; phiAllowed: false; activation: 'blocked';
  observedMigrationCount: number; applied: boolean; alreadyApplied: boolean; rolledBack: boolean;
  dataPreserved: true; historicalSchemaPreserved: true; tableCount: number; rowCount: number;
  dataSha256: string; historicalSchemaSha256: string; fromReleaseSha256: string; toReleaseSha256: string;
};
export type AdoptedInventoryAdmission = Pick<AdoptedInventoryUpgradeResult,
  'observedMigrationCount' | 'rowCount' | 'dataSha256' | 'historicalSchemaSha256'>;
class RehearsalRollback extends Error {
  constructor(readonly result: AdoptedInventoryUpgradeResult) { super('inventory_rehearsal_rollback'); }
}
export async function runAdoptedInventorySchemaUpgrade(database: ClinicalCoreDatabase, supplied: ClinicalCoreMigration[],
  configuration: QualificationUpgradeConfiguration, command: 'inspect' | 'rehearse' | 'upgrade',
  suppliedAdmission?: AdoptedInventoryAdmission): Promise<AdoptedInventoryUpgradeResult> {
  const migrations = supplied.map(m => ({ ...m })), c = { ...configuration };
  const admission = suppliedAdmission ? { ...suppliedAdmission } : undefined;
  assertAdoptedInventoryUpgrade(c, migrations);
  if (!['inspect', 'rehearse', 'upgrade'].includes(command)) fail('boundary_refused');
  if (command === 'upgrade' && (!admission || ![106, 107].includes(admission.observedMigrationCount)
    || !Number.isSafeInteger(admission.rowCount) || admission.rowCount < 0
    || !/^[a-f0-9]{64}$/.test(admission.dataSha256) || !/^[a-f0-9]{64}$/.test(admission.historicalSchemaSha256))) fail('boundary_refused');
  let stage = 'transaction_start';
  try {
    return await database.transaction(async tx => {
      await tx.query(command === 'inspect' ? 'set transaction isolation level repeatable read read only' : 'set transaction isolation level read committed');
      await tx.query("set local lock_timeout='5s'"); await tx.query("set local statement_timeout='30s'"); await tx.query('set local row_security=off');
      stage = 'database_identity';
      if ((await tx.query<{ name: string }>('select current_database() as name')).rows[0]?.name !== c.qualificationDatabaseName) fail('boundary_refused');
      if (command !== 'inspect') for (const key of ['ai-desktop-pro:production-clinical-core-migrations', 'ai-desktop-pro:qualification-fixtures']) {
        stage = 'operator_locks';
        if ((await tx.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) as acquired', [key])).rows[0]?.acquired !== true) fail('upgrade_busy');
      }
      stage = 'history'; const count = await history(tx, migrations);
      stage = 'inventory'; const tables = await inventory(tx);
      if (command !== 'inspect') {
        stage = 'writer_locks';
        await tx.query(`lock table ${[...tables.map(careErasurePreservation.qualified), LEDGER].sort().join(',')} in share row exclusive mode`);
        stage = 'writer_history'; if (await history(tx, migrations) !== count) fail('history_refused');
        stage = 'writer_inventory'; if (JSON.stringify(await inventory(tx)) !== JSON.stringify(tables)) fail('inventory_refused');
      }
      stage = 'before_functions'; await functions(tx, migrations[106].sql, count);
      stage = 'before_schema'; const beforeSchema = await schema(tx, tables);
      stage = 'before_fingerprint'; const before = await data(tx, tables);
      stage = 'rehearsal_admission';
      if (command === 'upgrade' && (admission!.observedMigrationCount !== count || admission!.rowCount !== before.rows
        || admission!.dataSha256 !== before.sha256 || admission!.historicalSchemaSha256 !== beforeSchema)) fail('data_changed');
      const applied = command !== 'inspect' && count === 106;
      if (applied) {
        stage = 'migration_ddl'; for (const statement of splitPostgresStatements(migrations[106].sql)) await tx.query(statement);
        stage = 'ledger_receipt'; const m = migrations[106];
        await tx.query(`insert into ${LEDGER}(version,name,sha256) values($1,$2,$3)`, [m.version, m.name, m.sha256]);
      }
      const final = applied ? 107 : count;
      stage = 'final_history'; if (await history(tx, migrations) !== final) fail('history_refused');
      stage = 'final_inventory'; if (JSON.stringify(await inventory(tx)) !== JSON.stringify(tables)) fail('inventory_refused');
      stage = 'final_schema'; const afterSchema = await schema(tx, tables);
      if (beforeSchema !== afterSchema) fail('verification_failed');
      stage = 'final_fingerprint'; const after = await data(tx, tables);
      if (before.sha256 !== after.sha256 || before.rows !== after.rows) fail('data_changed');
      stage = 'final_functions'; await functions(tx, migrations[106].sql, final);
      const result: AdoptedInventoryUpgradeResult = { contract: 'adopted-plan-inventory-schema-upgrade/1', command,
        execution: 'qualification', phiAllowed: false, activation: 'blocked', observedMigrationCount: final, applied, alreadyApplied: count === 107,
        rolledBack: false, dataPreserved: true, historicalSchemaPreserved: true, tableCount: tables.length, rowCount: before.rows,
        dataSha256: after.sha256, historicalSchemaSha256: afterSchema, fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from, toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to };
      if (command === 'rehearse') throw new RehearsalRollback(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RehearsalRollback) {
      const after = await runAdoptedInventorySchemaUpgrade(database, migrations, c, 'inspect');
      if (after.observedMigrationCount !== (error.result.alreadyApplied ? 107 : 106) || after.dataSha256 !== error.result.dataSha256
        || after.historicalSchemaSha256 !== error.result.historicalSchemaSha256 || after.rowCount !== error.result.rowCount) fail('verification_failed');
      return { ...after, command: 'rehearse', rolledBack: true };
    }
    if (error instanceof AdoptedInventoryUpgradeError) throw new AdoptedInventoryUpgradeError(error.category, error.stage ?? stage);
    throw new AdoptedInventoryUpgradeError('upgrade_failed', stage);
  }
}
