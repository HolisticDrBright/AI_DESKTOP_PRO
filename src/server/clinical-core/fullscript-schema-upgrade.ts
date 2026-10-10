if (typeof window !== 'undefined') throw Error('fullscript-schema-upgrade is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { splitPostgresStatements } from './migrations';
import { productionArtifactReleaseHash } from './production-migrations';
import { assertQualificationConfiguration } from './qualification-target';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { careErasurePreservation } from './care-erasure-schema-upgrade';
import { FULLSCRIPT_UPGRADE } from './fullscript-migration-release';
export { FULLSCRIPT_UPGRADE } from './fullscript-migration-release';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ledger = 'clinical_core.schema_migrations';
const baseScopes = ['programs','protocols_supplements','nutrition','appointments','messaging','forms_checkins',
  'symptoms_adherence','wearables','reproductive_health','lab_summaries','lab_results_import','lab_specimen_context','billing_links','research_n_of_1'];
type Category = 'boundary_refused' | 'artifact_refused' | 'history_refused' | 'inventory_refused' | 'upgrade_busy'
  | 'admission_changed' | 'verification_failed' | 'upgrade_failed' | 'recovery_required' | 'custody_refused' | 'recovery_refused';
export class FullscriptUpgradeError extends Error {
  constructor(readonly category: Category, readonly stage?: string) { super(stage ? `${category}:${stage}` : category); }
}
const fail = (c: Category): never => { throw new FullscriptUpgradeError(c); };
type Table = { schema_name: string; table_name: string; kind: string; rls: boolean; forced: boolean } & Record<string, unknown>;
export type FullscriptUpgradeObservation = {
  contract: 'fullscript-schema-upgrade/1'; execution: 'qualification'; phiAllowed: false; activation: 'blocked';
  observedMigrationCount: 107 | 108; historicalTableCount: number; rowCount: number;
  dataSha256: string; historicalSchemaSha256: string; consentConstraintSha256: string;
  fromReleaseSha256: string; toReleaseSha256: string;
};
export type FullscriptUpgradeResult = Omit<FullscriptUpgradeObservation, 'observedMigrationCount'> & {
  observedMigrationCount: 107 | 108 | 111; command: 'inspect' | 'inspect-settled' | 'rehearse' | 'upgrade';
  applied: boolean; rolledBack: boolean; dataPreserved: true; historicalSchemaPreserved: true;
  // A rollback rehearsal is not a reviewed receipt or hosted acceptance.
  newTableCount: number; newRows: number;
};
function artifact(c: QualificationUpgradeConfiguration, m: ClinicalCoreMigration[]) {
  try { assertQualificationConfiguration(c, c.region); } catch { fail('boundary_refused'); }
  if (c.expectedAccountId !== '588966314750' || c.region !== 'us-east-2' || c.phiAllowed !== false || c.activation !== 'blocked'
    || c.qualificationDatabaseName !== 'clinical_core_qualification' || c.stagingDatabaseName !== 'clinical_core') fail('boundary_refused');
  const p = FULLSCRIPT_UPGRADE;
  if ((c.fromReleaseSha256 !== p.parent107 && c.fromReleaseSha256 !== p.parent108) || c.toReleaseSha256 !== p.successor111
    || m.length !== 111 || m.some((r,i) => !/^\d{14}$/.test(r.version) || !/^[a-z0-9_]+$/.test(r.name)
      || r.sql.includes('\r') || sha(r.sql) !== r.sha256 || (i > 0 && r.version <= m[i-1].version))
    || productionArtifactReleaseHash(m.slice(0,107)) !== p.parent107
    || productionArtifactReleaseHash(m.slice(0,108)) !== p.parent108
    || productionArtifactReleaseHash(m) !== p.successor111
    || sha(m.map(r=>`${r.version}:${r.version}_${r.name}.sql:${r.sha256}`).join('\n')) !== p.successorArtifact
    || m.slice(-3).map(r=>r.name).join(',') !== 'production_fullscript_draft_ledger,production_canonical_protocol_carts,production_fullscript_canonical_authority') fail('artifact_refused');
}
export const assertFullscriptUpgrade = artifact;
export function fullscriptConsentConstraintSha256(count: 107 | 108 | 111) {
  const scopes=[...baseScopes,...(count>=108?['telehealth_recording']:[])];
  const definition=`CHECK ((scope = ANY (ARRAY[${scopes.map(s=>`'${s}'::text`).join(', ')}])))`;
  return sha(JSON.stringify(['consent_artifacts_scope_check','consent_grants_scope_check'].map(name=>({name,definition,valid:true}))));
}
async function history(tx: ClinicalCoreTransaction, m: ClinicalCoreMigration[], allowSuccessor = false) {
  const rows = (await tx.query<{ version: string; name: string; sha256: string }>(`select version,name,sha256 from ${ledger} order by version`)).rows;
  if (rows.length === 111 && !allowSuccessor) fail('recovery_required');
  if (![107,108,...(allowSuccessor?[111]:[])].includes(rows.length)
    || rows.some((r,i) => r.version !== m[i].version || r.name !== m[i].name || r.sha256 !== m[i].sha256)) fail('history_refused');
  return rows.length as 107 | 108 | 111;
}
async function inventory(tx: ClinicalCoreTransaction, successor = false) {
  const tables = (await tx.query<Table>(careErasurePreservation.tableQuery)).rows
    .filter(t => !successor || !addedTables.includes(careErasurePreservation.tableName(t)));
  if (tables.length !== 209 || tables.some(t => t.kind !== 'r')
    || sha(tables.map(careErasurePreservation.tableName).join('\n')) !== FULLSCRIPT_UPGRADE.historicalTableNames) fail('inventory_refused');
  tables.forEach(careErasurePreservation.qualified);
  return tables;
}
async function fresh(tx: ClinicalCoreTransaction) {
  const r = (await tx.query<{ absent: boolean }>(`select not exists(select 1 from pg_namespace where nspname='fullscript_delivery')
    and not exists(select 1 from pg_roles where rolname='fullscript_draft_worker')
    and to_regclass('clinical_audit.protocol_cart_events') is null
    and to_regclass('clinical_audit.fullscript_consent_events') is null
    and to_regprocedure('clinical_core.canonical_protocol_cart_workforce(jsonb)') is null as absent`)).rows[0];
  if (r?.absent !== true) fail('inventory_refused');
}
async function data(tx: ClinicalCoreTransaction, tables: Table[], prefix: number) {
  const d = await careErasurePreservation.fingerprint(tx, tables);
  const r = (await tx.query<{ n: number; digest: string }>(`select count(*)::int n,
    encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(m) order by version),'[]'::jsonb)::text,'UTF8')),'hex') digest
    from ${ledger} m where version<=$1`, [prefix===107?'20261009010000':'20261009100000'])).rows[0];
  if (!r || r.n !== prefix || !/^[a-f0-9]{64}$/.test(r.digest)) fail('history_refused');
  return { rows: d.rows, digest: sha(JSON.stringify({ data: d.sha256, historicReceipts: r.digest })) };
}
async function constraints(tx: ClinicalCoreTransaction, count: number) {
  const rows = (await tx.query<{ name: string; definition: string; valid: boolean }>(`select conname name,
    pg_get_constraintdef(oid) definition,convalidated valid from pg_constraint
    where (conrelid='clinical_core.consent_artifacts'::regclass and conname='consent_artifacts_scope_check')
      or (conrelid='clinical_core.consent_grants'::regclass and conname='consent_grants_scope_check') order by conname`)).rows;
  const expected = [...baseScopes,...(count>=108?['telehealth_recording']:[])];
  if (rows.length!==2 || rows.some(r => !r.valid || r.definition!==`CHECK ((scope = ANY (ARRAY[${expected.map(s=>`'${s}'::text`).join(', ')}])))`)) fail('verification_failed');
  return sha(JSON.stringify(rows));
}
/** Every historical table, column, index, policy, trigger and grant is included.
 * Only the two enumerated scope checks are compared separately; new objects
 * are checked separately, never treated as arbitrary changes to an old schema. */
async function schema(tx: ClinicalCoreTransaction, tables: Table[]) {
  const names = [...tables.map(careErasurePreservation.tableName),ledger];
  const tableRows = (await tx.query<{ name: string; digest: string }>(`select selected.name,
    encode(sha256(convert_to(jsonb_build_object(
      'relation',jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
        'owner',c.relowner::regrole::text,'acl',coalesce(c.relacl,acldefault('r',c.relowner))::text,
        'replica_identity',c.relreplident,'options',c.reloptions),
      'columns',(select jsonb_agg(jsonb_build_object('attribute',to_jsonb(a),'type',format_type(a.atttypid,a.atttypmod),
        'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a
        left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0),
      'constraints',(select jsonb_agg(jsonb_build_object('metadata',to_jsonb(k),'def',pg_get_constraintdef(k.oid)) order by k.conname)
        from pg_constraint k where k.conrelid=c.oid and not((selected.name='clinical_core.consent_artifacts' and k.conname='consent_artifacts_scope_check')
          or (selected.name='clinical_core.consent_grants' and k.conname='consent_grants_scope_check'))),
      'indexes',(select jsonb_agg(jsonb_build_object('metadata',to_jsonb(i),'def',pg_get_indexdef(i.indexrelid)) order by i.indexrelid::regclass::text)
        from pg_index i where i.indrelid=c.oid),
      'policies',(select jsonb_agg(to_jsonb(p)-'oid'-'polrelid' order by p.polname) from pg_policy p where p.polrelid=c.oid),
      'triggers',(select jsonb_agg(jsonb_build_object('enabled',t.tgenabled,'internal',t.tgisinternal,'def',pg_get_triggerdef(t.oid)) order by t.tgname)
        from pg_trigger t where t.tgrelid=c.oid and not(t.tgisinternal and exists(select 1 from pg_constraint k
          where k.oid=t.tgconstraint and k.conrelid in (select cl.oid from pg_class cl join pg_namespace ns on ns.oid=cl.relnamespace
            where ns.nspname||'.'||cl.relname in (select jsonb_array_elements_text($2::jsonb))))))
    )::text,'UTF8')),'hex') digest from jsonb_array_elements_text($1::jsonb) selected(name)
    join pg_class c on c.oid=selected.name::regclass order by selected.name`, [JSON.stringify(names), JSON.stringify(addedTables)])).rows;
  const r = (await tx.query<{ digest: string }>(`select encode(sha256(convert_to(jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'def',pg_get_functiondef(p.oid),
      'owner',p.proowner::regrole::text,'acl',coalesce(p.proacl,acldefault('f',p.proowner))::text) order by n.nspname,p.proname,p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in
      ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference') and p.prokind in ('f','p')
      and not(n.nspname='clinical_core' and p.proname='canonical_protocol_cart_workforce' and pg_get_function_identity_arguments(p.oid)='_request jsonb')),
    'schemas',(select jsonb_agg(jsonb_build_object('name',n.nspname,'owner',n.nspowner::regrole::text,
      'acl',coalesce(n.nspacl,acldefault('n',n.nspowner))::text) order by n.nspname) from pg_namespace n where n.nspname in
      ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')),
    'types',(select jsonb_agg(jsonb_build_object('type',to_jsonb(t)-'oid',
      'domain_constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'valid',k.convalidated,
        'def',pg_get_constraintdef(k.oid),'deferred',k.condeferred,'deferrable',k.condeferrable) order by k.conname)
        from pg_constraint k where k.contypid=t.oid),
      'enum',(select jsonb_agg(to_jsonb(e)-'oid' order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid)) order by n.nspname,t.typname)
      from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname in
      ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')
      and not(n.nspname='clinical_audit' and t.typname in ('protocol_cart_events','_protocol_cart_events','fullscript_consent_events','_fullscript_consent_events'))),
    'other_relations',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,
      'owner',c.relowner::regrole::text,'acl',c.relacl::text,'view',case when c.relkind in ('v','m') then pg_get_viewdef(c.oid) else null end)
      order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in
      ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference') and c.relkind not in ('r','i','t')),
    'default_acl',(select jsonb_agg(to_jsonb(d)-'oid' order by d.defaclrole,d.defaclnamespace,d.defaclobjtype) from pg_default_acl d),
    'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r where rolname<>'fullscript_draft_worker'),
    'memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor) from pg_auth_members m)
  )::text,'UTF8')),'hex') digest`)).rows[0];
  if (tableRows.length!==names.length || tableRows.some(r=>!/^[a-f0-9]{64}$/.test(r.digest)) || !r || !/^[a-f0-9]{64}$/.test(r.digest)) fail('verification_failed');
  return sha(JSON.stringify({ tables: tableRows, global: r.digest }));
}
const addedTables = ['clinical_audit.fullscript_consent_events','clinical_audit.protocol_cart_events',
  'fullscript_delivery.authority_releases','fullscript_delivery.draft_events','fullscript_delivery.draft_intents',
  'fullscript_delivery.external_consents','fullscript_delivery.protocol_manifests','fullscript_delivery.recipient_holds'];
async function extensions(tx: ClinicalCoreTransaction, m: ClinicalCoreMigration[]) {
  // The original 107/108 -> 111 admission still requires unused extension
  // tables. Later preserving upgrades may validate this same schema without
  // treating legitimate recipient holds or provider rows as corruption.
  const tables = (await tx.query<Table>(careErasurePreservation.tableQuery.replace("'commercial_reference'", "'commercial_reference','fullscript_delivery'"))).rows;
  const empty = await careErasurePreservation.fingerprint(tx,tables.filter(t=>addedTables.includes(careErasurePreservation.tableName(t))));
  if (empty.rows!==0) fail('verification_failed');
  await verifyFullscriptExtensionSchema(tx,m);
}
/** Read-only canonical 111 extension validation. Does not admit a migration,
 * certify empty tables, or approve any provider/consent/activation row. */
export async function verifyFullscriptExtensionSchema(tx: ClinicalCoreTransaction, m: ClinicalCoreMigration[]) {
  const rows = (await tx.query<Table>(careErasurePreservation.tableQuery.replace("'commercial_reference'", "'commercial_reference','fullscript_delivery'"))).rows;
  const added = rows.filter(t=>addedTables.includes(careErasurePreservation.tableName(t)));
  if (rows.length!==217 || added.length!==8 || added.some(t=>t.kind!=='r'
    || t.rls!==!['draft_events','draft_intents'].includes(t.table_name) || t.forced!==t.rls)) fail('verification_failed');
  const shape=(await tx.query<{digest:string}>(`select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object(
    'name',selected.name,'kind',c.relkind,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
    'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
    'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'valid',k.convalidated,
      'deferred',k.condeferred,'deferrable',k.condeferrable,'def',pg_get_constraintdef(k.oid)) order by k.conname)
      from pg_constraint k where k.conrelid=c.oid),
    'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=c.oid),
    'policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
      'roles',(select jsonb_agg(case when v=0 then 'public' else v::regrole::text end order by v) from unnest(p.polroles) v),
      'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname) from pg_policy p where p.polrelid=c.oid),
    'triggers',(select jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'def',pg_get_triggerdef(t.oid)) order by t.tgname)
      from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
  ) order by selected.name),'[]'::jsonb)::text,'UTF8')),'hex') digest
  from jsonb_array_elements_text($1::jsonb) selected(name) join pg_class c on c.oid=selected.name::regclass`,[JSON.stringify(addedTables)])).rows[0];
  if(shape?.digest!==FULLSCRIPT_UPGRADE.extensionShape) throw new FullscriptUpgradeError('verification_failed','extension_shape');
  const source=m.slice(108).map(r=>r.sql).join('\n');
  const bodies = [...source.matchAll(/create function ([a-z_]+\.[a-z_]+)\(([^]*?)\)\s+returns ([a-z_.]+)([^]*?)as \$\$([^]*?)\$\$/g)]
    .map(x=>({name:x[1],hash:sha(x[5]),returns:x[3],definer:/\bsecurity definer\b/.test(x[4]),
      language:/\blanguage (sql|plpgsql)\b/.exec(x[4])?.[1],volatility:/\bimmutable\b/.test(x[4])?'i':/\bstable\b/.test(x[4])?'s':'v',
      path:x[4].includes('search_path=pg_catalog')?'search_path=pg_catalog':'search_path=""',
      granted:source.match(new RegExp(`grant execute on function ${x[1].replace('.', '\\.')}\\([^]*?\\) to ([a-z_]+);`))?.[1]??null}));
  for (const f of bodies) {
    const [s,n] = f.name.split('.');
    const found = (await tx.query<{ valid: boolean }>(`select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$3
      and p.prorettype=$4::regtype and p.prosecdef=$5::boolean and p.prolang=(select oid from pg_language where lanname=$6)
      and p.provolatile=$7::"char" and p.proconfig=array[$8]::text[] and p.proowner=(select oid from pg_roles where rolname=current_user)
      and not p.proisstrict and not p.proleakproof and p.prokind='f' and p.proparallel='u'
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.privilege_type='EXECUTE' and (a.is_grantable or a.grantee not in
          (p.proowner,coalesce((select oid from pg_roles where rolname=$9),p.proowner))))
      and case when $9::text is null then true else has_function_privilege($9,p.oid,'EXECUTE') end valid
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2`,
    [s,n,f.hash,f.returns,f.definer,f.language,f.volatility,f.path,f.granted])).rows;
    if (found.length!==1 || found[0].valid!==true) throw new FullscriptUpgradeError('verification_failed',`extension_function:${f.name}`);
  }
  if (bodies.length!==22 || (await tx.query<{n:number}>(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='fullscript_delivery'`)).rows[0]?.n!==21) throw new FullscriptUpgradeError('verification_failed','extension_function_inventory');
  for (const table of addedTables) {
    const tableAcl=(await tx.query<{safe:boolean}>(`select not exists(select 1 from pg_class c,
      lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=$1::regclass and
      (a.is_grantable or (a.grantee<>c.relowner and not($1::text='fullscript_delivery.draft_intents'
        and a.grantee=(select oid from pg_roles where rolname='fullscript_draft_worker') and a.privilege_type in ('SELECT','INSERT','UPDATE'))))) safe`,[table])).rows[0];
    if(tableAcl?.safe!==true)fail('verification_failed');
  }
  const r = (await tx.query<{ safe: boolean }>(`select exists(select 1 from pg_roles where rolname='fullscript_draft_worker'
    and not rolcanlogin and not rolsuper and not rolcreaterole and not rolcreatedb and not rolbypassrls and not rolreplication)
    and not has_schema_privilege('clinical_core_api','fullscript_delivery','USAGE')
    and not has_schema_privilege('fullscript_draft_worker','clinical_core','USAGE')
    and not has_table_privilege('fullscript_draft_worker','fullscript_delivery.draft_events','SELECT')
    and not has_table_privilege('fullscript_draft_worker','fullscript_delivery.draft_intents','DELETE')
    and has_function_privilege('fullscript_draft_worker','fullscript_delivery.migration_ledger()','EXECUTE') as safe`)).rows[0];
  if (r?.safe!==true) fail('verification_failed');
}
class Rehearsal extends Error { constructor(readonly before: FullscriptUpgradeObservation) { super('rollback_rehearsal'); } }
/** Source-only engine. Native STS/stack/review binding must wrap this before an
 * AWS command is installed. It never downgrades committed custody or clears an
 * uncertain writer. A completed/lost-commit receipt requires explicit recovery. */
export async function runFullscriptSchemaUpgrade(database: ClinicalCoreDatabase, supplied: ClinicalCoreMigration[],
  configuration: QualificationUpgradeConfiguration, command: 'inspect' | 'inspect-settled' | 'rehearse' | 'upgrade', admission?: FullscriptUpgradeObservation): Promise<FullscriptUpgradeResult> {
  const m = supplied.map(r=>({...r})), c={...configuration}, a=admission?{...admission}:undefined;
  artifact(c,m);
  if (!['inspect','inspect-settled','rehearse','upgrade'].includes(command) || (command==='upgrade' && (!a || a.contract!=='fullscript-schema-upgrade/1'
    || a.execution!=='qualification' || a.phiAllowed!==false || a.activation!=='blocked' || a.fromReleaseSha256!==c.fromReleaseSha256
    || a.toReleaseSha256!==c.toReleaseSha256))) fail('boundary_refused');
  let stage='transaction_start';
  try { return await database.transaction(async tx=>{
    await tx.query(command==='inspect'?'set transaction isolation level repeatable read read only':'set transaction isolation level read committed');
    await tx.query("set local lock_timeout='5s'"); await tx.query("set local statement_timeout='30s'"); await tx.query('set local row_security=off');
    stage='database_identity';
    if ((await tx.query<{name:string}>('select current_database() as name')).rows[0]?.name!==c.qualificationDatabaseName) fail('boundary_refused');
    if (command!=='inspect') for(const key of ['ai-desktop-pro:production-clinical-core-migrations','ai-desktop-pro:qualification-fixtures']) {
      if ((await tx.query<{ acquired:boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) as acquired',[key])).rows[0]?.acquired!==true) fail('upgrade_busy');
    }
    stage='history'; const count=await history(tx,m,command==='inspect-settled');
    const prefix=c.fromReleaseSha256===FULLSCRIPT_UPGRADE.parent107?107:108;
    if (count!==111 && count!==prefix) fail('history_refused');
    stage='inventory'; if(count!==111)await fresh(tx); const tables=await inventory(tx,count===111);
    if (command!=='inspect') {
      await tx.query(`lock table ${[...tables.map(careErasurePreservation.qualified),ledger].sort().join(',')} in share row exclusive mode`);
      if (await history(tx,m,command==='inspect-settled')!==count || JSON.stringify(await inventory(tx,count===111))!==JSON.stringify(tables)) fail('inventory_refused');
      if(count!==111)await fresh(tx);
    }
    stage='before_evidence'; const beforeData=await data(tx,tables,prefix), beforeSchema=await schema(tx,tables), beforeConsent=await constraints(tx,count);
    const before: FullscriptUpgradeObservation={ contract:'fullscript-schema-upgrade/1',execution:'qualification',phiAllowed:false,activation:'blocked',
      observedMigrationCount:prefix,historicalTableCount:209,rowCount:beforeData.rows,dataSha256:beforeData.digest,
      historicalSchemaSha256:beforeSchema,consentConstraintSha256:beforeConsent,fromReleaseSha256:c.fromReleaseSha256,toReleaseSha256:c.toReleaseSha256 };
    if (command==='upgrade' && Object.keys(before).some(k=>before[k as keyof typeof before]!==a![k as keyof typeof before])) fail('admission_changed');
    if(count===111) { stage='settled_extensions'; await extensions(tx,m); }
    if(command==='rehearse' || command==='upgrade') {
      stage='extension_ddl';
      for(const r of m.slice(count)) {
        for(const statement of splitPostgresStatements(r.sql)) await tx.query(statement);
        await tx.query(`insert into ${ledger}(version,name,sha256) values($1,$2,$3)`,[r.version,r.name,r.sha256]);
      }
      stage='after_history';
      if(await history(tx,m,true)!==111) fail('verification_failed');
      stage='after_schema';
      if(await schema(tx,tables)!==beforeSchema) fail('verification_failed');
      stage='after_data';
      const after=await data(tx,tables,count);
      if(after.rows!==beforeData.rows || after.digest!==beforeData.digest) fail('verification_failed');
      stage='after_consent'; await constraints(tx,111);
      stage='after_extensions'; await extensions(tx,m);
      if(command==='rehearse') throw new Rehearsal(before);
    }
    return { ...before,observedMigrationCount:command==='upgrade'?111:count,command,
      // Report the actually observed successor constraint, not the old scope check.
      consentConstraintSha256:command==='upgrade'?await constraints(tx,111):beforeConsent,
      applied:command==='upgrade',rolledBack:false,dataPreserved:true,historicalSchemaPreserved:true,
      newTableCount:count===111 || command==='upgrade'?8:0,newRows:0 };
  }); } catch(error) {
    if(error instanceof Rehearsal) {
      const after=await runFullscriptSchemaUpgrade(database,m,c,'inspect');
      for(const k of Object.keys(error.before) as Array<keyof FullscriptUpgradeObservation>) if(after[k]!==error.before[k]) fail('verification_failed');
      return {...after,command:'rehearse',rolledBack:true};
    }
    if(error instanceof FullscriptUpgradeError) throw new FullscriptUpgradeError(error.category,error.stage??stage);
    throw new FullscriptUpgradeError('upgrade_failed',stage);
  }
}
