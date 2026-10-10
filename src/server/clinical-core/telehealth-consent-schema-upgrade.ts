if (typeof window !== 'undefined') throw Error('telehealth-consent-schema-upgrade is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { splitPostgresStatements, type ClinicalCoreMigration } from './migrations';
import { productionArtifactReleaseHash } from './production-migrations';
import { assertQualificationConfiguration } from './qualification-target';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { careErasurePreservation } from './care-erasure-schema-upgrade';
import { FULLSCRIPT_UPGRADE, FULLSCRIPT_CONSENT_SUCCESSOR } from './fullscript-migration-release';
import { FullscriptUpgradeError, verifyFullscriptExtensionSchema } from './fullscript-schema-upgrade';
import { verifyCareConsentRegistrationSchema } from './care-connections-schema-upgrade';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ledger = 'clinical_core.schema_migrations';
const schemas = ['clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference','fullscript_delivery'];
const added111 = ['clinical_audit.fullscript_consent_events','clinical_audit.protocol_cart_events',
  'fullscript_delivery.authority_releases','fullscript_delivery.draft_events','fullscript_delivery.draft_intents',
  'fullscript_delivery.external_consents','fullscript_delivery.protocol_manifests','fullscript_delivery.recipient_holds'];
type Table = { schema_name: string; table_name: string; kind: string; rls: boolean; forced: boolean } & Record<string,unknown>;
type Command = 'inspect'|'inspect-settled'|'rehearse'|'upgrade';
const fail = (category: ConstructorParameters<typeof FullscriptUpgradeError>[0], stage?: string): never => {
  throw new FullscriptUpgradeError(category,stage);
};
export type TelehealthConsentUpgradeObservation = {
  contract: 'telehealth-consent-schema-upgrade/1'; execution: 'qualification'; phiAllowed: false; activation: 'blocked';
  historicalTableCount: 217; rowCount: number; dataSha256: string; historicalSchemaSha256: string;
  fromReleaseSha256: string; toReleaseSha256: string;
};
export type TelehealthConsentUpgradeResult = TelehealthConsentUpgradeObservation & {
  observedMigrationCount: 111|112; command: Command; applied: boolean; rolledBack: boolean;
  dataPreserved: true; historicalSchemaPreserved: true; newTableCount: 0; newRows: 0; newFunctionCount: 0|1;
};
/** Separate exact release. Never widens the historical 111 operator. */
export function assertTelehealthConsentUpgrade(c: QualificationUpgradeConfiguration, m: readonly ClinicalCoreMigration[]) {
  try { assertQualificationConfiguration(c,c.region); } catch { fail('boundary_refused'); }
  if (c.expectedAccountId!=='588966314750' || c.region!=='us-east-2' || c.phiAllowed!==false || c.activation!=='blocked'
    || c.qualificationDatabaseName!=='clinical_core_qualification' || c.stagingDatabaseName!=='clinical_core'
    || c.fromReleaseSha256!==FULLSCRIPT_UPGRADE.successor111 || c.toReleaseSha256!==FULLSCRIPT_CONSENT_SUCCESSOR.ledger) fail('boundary_refused');
  const last=m[111], p=FULLSCRIPT_CONSENT_SUCCESSOR;
  if (m.length!==112 || m.some((r,i)=>!/^\d{14}$/.test(r.version) || !/^[a-z0-9_]+$/.test(r.name)
    || r.sql.includes('\r') || sha(r.sql)!==r.sha256 || i>0 && r.version<=m[i-1].version)
    || productionArtifactReleaseHash([...m.slice(0,111)])!==FULLSCRIPT_UPGRADE.successor111
    || sha(m.slice(0,111).map(r=>`${r.version}:${r.version}_${r.name}.sql:${r.sha256}`).join('\n'))!==FULLSCRIPT_UPGRADE.successorArtifact
    || productionArtifactReleaseHash([...m])!==p.ledger
    || sha(m.map(r=>`${r.version}:${r.version}_${r.name}.sql:${r.sha256}`).join('\n'))!==p.assembly
    || last?.version!==p.version || last?.name!==p.name || last?.sha256!==p.sqlSha256) fail('artifact_refused');
}
async function history(tx: ClinicalCoreTransaction, m: ClinicalCoreMigration[], allowSuccessor: boolean) {
  const rows=(await tx.query<{version:string;name:string;sha256:string}>(`select version,name,sha256 from ${ledger} order by version`)).rows;
  if (rows.length===112 && !allowSuccessor) fail('recovery_required');
  if (![111,...(allowSuccessor?[112]:[])].includes(rows.length)
    || rows.some((r,i)=>r.version!==m[i]?.version || r.name!==m[i]?.name || r.sha256!==m[i]?.sha256)) fail('history_refused');
  return rows.length as 111|112;
}
async function inventory(tx: ClinicalCoreTransaction) {
  const tables=(await tx.query<Table>(careErasurePreservation.tableQuery.replace("'commercial_reference'","'commercial_reference','fullscript_delivery'"))).rows;
  const historical=tables.filter(t=>!added111.includes(careErasurePreservation.tableName(t)));
  if (tables.length!==217 || tables.some(t=>t.kind!=='r') || historical.length!==209
    || sha(historical.map(careErasurePreservation.tableName).join('\n'))!==FULLSCRIPT_UPGRADE.historicalTableNames
    || added111.some(n=>!tables.some(t=>careErasurePreservation.tableName(t)===n))) fail('inventory_refused');
  tables.forEach(careErasurePreservation.qualified);
  return tables;
}
async function otherLedgers(tx: ClinicalCoreTransaction) {
  const rows=(await tx.query<Table>(`select n.nspname schema_name,c.relname table_name,c.relkind::text kind,c.relrowsecurity rls,c.relforcerowsecurity forced
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in (select jsonb_array_elements_text($1::jsonb))
    and c.relname='schema_migrations' and n.nspname<>'clinical_core' order by n.nspname,c.relname`,[JSON.stringify(schemas)])).rows;
  if (rows.some(t=>t.kind!=='r')) fail('inventory_refused');
  rows.forEach(careErasurePreservation.qualified); return rows;
}
async function data(tx: ClinicalCoreTransaction, tables: Table[], references: Table[], lastParentVersion: string) {
  const rows=await careErasurePreservation.fingerprint(tx,[...tables,...references].sort((a,b)=>careErasurePreservation.tableName(a).localeCompare(careErasurePreservation.tableName(b))));
  // Preserve complete historical operator receipts, including their dates.
  // The new migration receipt is the sole allowed data delta.
  const receipt=(await tx.query<{n:number;digest:string}>(`select count(*)::int n,
    encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by version),'[]'::jsonb)::text,'UTF8')),'hex') digest
    from ${ledger} r where version<=$1`,[lastParentVersion])).rows[0];
  if (receipt?.n!==111 || !/^[a-f0-9]{64}$/.test(receipt.digest)) fail('history_refused');
  return {rows:rows.rows,digest:sha(JSON.stringify({data:rows.sha256,receipts:receipt.digest}))};
}
/** Entire historical schema, including all constraints and all Fullscript
 * objects/privileges. Only the single named new function is excluded, and it
 * is independently checked below. No old cart/scope/role exclusions carry on. */
async function schema(tx: ClinicalCoreTransaction, tables: Table[], references: Table[]) {
  const names=[...tables,...references].map(careErasurePreservation.tableName).concat(ledger).sort();
  const rows=(await tx.query<{name:string;digest:string}>(`select selected.name,
    encode(sha256(convert_to(jsonb_build_object(
      'relation',jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
        'owner',c.relowner::regrole::text,'acl',coalesce(c.relacl,acldefault('r',c.relowner))::text,
        'replica_identity',c.relreplident,'options',c.reloptions),
      'columns',(select jsonb_agg(jsonb_build_object('attribute',to_jsonb(a),'type',format_type(a.atttypid,a.atttypmod),
        'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a
        left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0),
      'constraints',(select jsonb_agg(jsonb_build_object('metadata',to_jsonb(k),'def',pg_get_constraintdef(k.oid)) order by k.conname)
        from pg_constraint k where k.conrelid=c.oid),
      'indexes',(select jsonb_agg(jsonb_build_object('metadata',to_jsonb(i),'def',pg_get_indexdef(i.indexrelid)) order by i.indexrelid::regclass::text)
        from pg_index i where i.indrelid=c.oid),
      'policies',(select jsonb_agg(to_jsonb(p)-'oid'-'polrelid' order by p.polname) from pg_policy p where p.polrelid=c.oid),
      'triggers',(select jsonb_agg(jsonb_build_object('enabled',t.tgenabled,'internal',t.tgisinternal,'def',pg_get_triggerdef(t.oid)) order by t.tgname)
        from pg_trigger t where t.tgrelid=c.oid)
    )::text,'UTF8')),'hex') digest from jsonb_array_elements_text($1::jsonb) selected(name)
    join pg_class c on c.oid=selected.name::regclass order by selected.name`,[JSON.stringify(names)])).rows;
  const global=(await tx.query<{digest:string}>(`select encode(sha256(convert_to(jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'def',pg_get_functiondef(p.oid),
      'owner',p.proowner::regrole::text,'acl',coalesce(p.proacl,acldefault('f',p.proowner))::text) order by n.nspname,p.proname,p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in (select jsonb_array_elements_text($1::jsonb)) and p.prokind in ('f','p')
      and not(n.nspname='clinical_core' and p.proname='production_telehealth_consent_request')),
    'schemas',(select jsonb_agg(to_jsonb(n) order by n.nspname) from pg_namespace n where n.nspname in (select jsonb_array_elements_text($1::jsonb))),
    'types',(select jsonb_agg(jsonb_build_object('type',to_jsonb(t)-'oid',
      'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'valid',k.convalidated,'def',pg_get_constraintdef(k.oid),
        'deferred',k.condeferred,'deferrable',k.condeferrable) order by k.conname) from pg_constraint k where k.contypid=t.oid),
      'enum',(select jsonb_agg(to_jsonb(e)-'oid' order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid)) order by n.nspname,t.typname)
      from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname in (select jsonb_array_elements_text($1::jsonb))),
    'other_relations',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,
      'owner',c.relowner::regrole::text,'acl',c.relacl::text,'view',case when c.relkind in ('v','m') then pg_get_viewdef(c.oid) else null end)
      order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in (select jsonb_array_elements_text($1::jsonb)) and c.relkind not in ('r','i','t')),
    'default_acl',(select jsonb_agg(to_jsonb(d)-'oid' order by d.defaclrole,d.defaclnamespace,d.defaclobjtype) from pg_default_acl d),
    'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
    'memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor) from pg_auth_members m)
  )::text,'UTF8')),'hex') digest`,[JSON.stringify(schemas)])).rows[0];
  if (rows.length!==names.length || rows.some(r=>!/^[a-f0-9]{64}$/.test(r.digest)) || !global || !/^[a-f0-9]{64}$/.test(global.digest)) fail('verification_failed');
  return sha(JSON.stringify({tables:rows,global:global.digest}));
}
async function verifyNewFunction(tx: ClinicalCoreTransaction, m: ClinicalCoreMigration[], successor: boolean) {
  const body=/as \$\$([^]*?)\$\$/.exec(m[111].sql)?.[1] ?? fail('artifact_refused');
  const rows=(await tx.query<{valid:boolean}>(`select
    p.oid=to_regprocedure('clinical_core.production_telehealth_consent_request(jsonb)')
    and p.prorettype='jsonb'::regtype and p.prokind='f' and p.provolatile='v' and p.prosecdef
    and p.prolang=(select oid from pg_language where lanname='plpgsql') and p.proconfig=array['search_path=""']::text[]
    and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$1 and not p.proisstrict and not p.proleakproof
    and p.proparallel='u' and p.proowner=(select oid from pg_roles where rolname=current_user)
    and p.pronargs=1 and p.pronargdefaults=0 and p.provariadic=0 and not p.proretset
    and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.privilege_type='EXECUTE' and (a.is_grantable or a.grantee not in
        (p.proowner,(select oid from pg_roles where rolname='clinical_core_api')))) valid
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clinical_core'
      and p.proname='production_telehealth_consent_request'`,[sha(body)])).rows;
  if (successor ? rows.length!==1 || rows[0]?.valid!==true : rows.length!==0) fail('verification_failed','new_function');
}
/** Separate exact successor admission for the telehealth-only copy registrar.
 * No prefix tolerance, migration, approval, copy insertion or consent grant. */
export async function verifyTelehealthConsentCopyRegistrationTarget(tx: ClinicalCoreTransaction,
  supplied: ClinicalCoreMigration[], configuration: QualificationUpgradeConfiguration) {
  const m=supplied.map(r=>({...r})),c={...configuration};assertTelehealthConsentUpgrade(c,m);
  if((await tx.query<{name:string}>('select current_database() as name')).rows[0]?.name!==c.qualificationDatabaseName)fail('boundary_refused');
  if(await history(tx,m,true)!==112)fail('history_refused');
  await inventory(tx);await verifyFullscriptExtensionSchema(tx,m.slice(0,111));
  await verifyCareConsentRegistrationSchema(tx,m[104]);await verifyNewFunction(tx,m,true);
  const immutableBodies=m.flatMap(r=>[...r.sql.matchAll(/create(?: or replace)? function clinical_private\.block_update_delete\(\)[^]*?as \$\$([^]*?)\$\$/g)])
    .map(match=>match[1]);
  const body=immutableBodies.at(-1)??fail('artifact_refused');
  const immutable=(await tx.query<{valid:boolean}>(`select count(*)=1 and bool_and(
    p.oid=to_regprocedure('clinical_private.block_update_delete()') and p.prorettype='trigger'::regtype
    and p.prokind='f' and p.provolatile='v' and p.prolang=(select oid from pg_language where lanname='plpgsql')
    and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$1) valid
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clinical_private' and p.proname='block_update_delete'`,[sha(body)])).rows[0];
  const protectedTable=(await tx.query<{valid:boolean}>(`select c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity valid
    from pg_class c where c.oid='clinical_core.care_consent_texts'::regclass`)).rows[0];
  if(immutable?.valid!==true||protectedTable?.valid!==true)fail('verification_failed','copy_immutability');
}
class Rehearsal extends Error { constructor(readonly observation: TelehealthConsentUpgradeObservation) { super('rollback_rehearsal'); } }
const observationKeys = ['contract','execution','phiAllowed','activation','historicalTableCount','rowCount','dataSha256',
  'historicalSchemaSha256','fromReleaseSha256','toReleaseSha256'] as const;
/** Source transaction engine only. Requires the separately reviewed native
 * operator/custody wrapper before AWS use. An unknown commit is never retried. */
export async function runTelehealthConsentSchemaUpgrade(database: ClinicalCoreDatabase, supplied: ClinicalCoreMigration[],
  configuration: QualificationUpgradeConfiguration, command: Command, admission?: TelehealthConsentUpgradeObservation): Promise<TelehealthConsentUpgradeResult> {
  const m=supplied.map(r=>({...r})), c={...configuration}, a=admission?{...admission}:undefined;
  assertTelehealthConsentUpgrade(c,m);
  if (!['inspect','inspect-settled','rehearse','upgrade'].includes(command) || command==='upgrade' && (!a
    || a.contract!=='telehealth-consent-schema-upgrade/1' || a.execution!=='qualification' || a.phiAllowed!==false || a.activation!=='blocked'
    || a.fromReleaseSha256!==c.fromReleaseSha256 || a.toReleaseSha256!==c.toReleaseSha256)) fail('boundary_refused');
  let stage='transaction_start';
  try { return await database.transaction(async tx=>{
    await tx.query(command==='inspect'?'set transaction isolation level repeatable read read only':'set transaction isolation level read committed');
    await tx.query("set local lock_timeout='5s'"); await tx.query("set local statement_timeout='30s'"); await tx.query('set local row_security=off');
    stage='database_identity';
    if ((await tx.query<{name:string}>('select current_database() as name')).rows[0]?.name!==c.qualificationDatabaseName) fail('boundary_refused');
    if (command!=='inspect') for (const key of ['ai-desktop-pro:production-clinical-core-migrations','ai-desktop-pro:qualification-fixtures']) {
      if ((await tx.query<{acquired:boolean}>('select pg_try_advisory_xact_lock(hashtext($1)) as acquired',[key])).rows[0]?.acquired!==true) fail('upgrade_busy');
    }
    stage='history'; const count=await history(tx,m,command==='inspect-settled');
    stage='inventory'; const tables=await inventory(tx), references=await otherLedgers(tx);
    if (command!=='inspect') {
      await tx.query(`lock table ${[...tables,...references].map(careErasurePreservation.qualified).concat(ledger).sort().join(',')} in share row exclusive mode`);
      if (await history(tx,m,command==='inspect-settled')!==count || JSON.stringify(await inventory(tx))!==JSON.stringify(tables)
        || JSON.stringify(await otherLedgers(tx))!==JSON.stringify(references)) fail('inventory_refused');
    }
    stage='canonical_parent'; await verifyFullscriptExtensionSchema(tx,m.slice(0,111)); await verifyNewFunction(tx,m,count===112);
    stage='before_evidence'; const beforeData=await data(tx,tables,references,m[110].version), beforeSchema=await schema(tx,tables,references);
    const before: TelehealthConsentUpgradeObservation={contract:'telehealth-consent-schema-upgrade/1',execution:'qualification',phiAllowed:false,activation:'blocked',
      historicalTableCount:217,rowCount:beforeData.rows,dataSha256:beforeData.digest,historicalSchemaSha256:beforeSchema,
      fromReleaseSha256:c.fromReleaseSha256,toReleaseSha256:c.toReleaseSha256};
    if (command==='upgrade' && observationKeys.some(k=>before[k]!==a![k])) fail('admission_changed');
    if (command==='rehearse' || command==='upgrade') {
      stage='extension_ddl'; for (const statement of splitPostgresStatements(m[111].sql)) await tx.query(statement);
      await tx.query(`insert into ${ledger}(version,name,sha256) values($1,$2,$3)`,[m[111].version,m[111].name,m[111].sha256]);
      stage='after_history'; if (await history(tx,m,true)!==112) fail('verification_failed');
      stage='after_schema'; if (JSON.stringify(await inventory(tx))!==JSON.stringify(tables)
        || JSON.stringify(await otherLedgers(tx))!==JSON.stringify(references) || await schema(tx,tables,references)!==beforeSchema) fail('verification_failed');
      stage='after_data'; const after=await data(tx,tables,references,m[110].version);
      if (after.rows!==beforeData.rows || after.digest!==beforeData.digest) fail('verification_failed');
      stage='after_function'; await verifyNewFunction(tx,m,true);
      if (command==='rehearse') throw new Rehearsal(before);
    }
    return {...before,observedMigrationCount:command==='upgrade'?112:count,command,applied:command==='upgrade',rolledBack:false,
      dataPreserved:true,historicalSchemaPreserved:true,newTableCount:0,newRows:0,newFunctionCount:count===112 || command==='upgrade'?1:0};
  }); } catch (error) {
    if (error instanceof Rehearsal) {
      const after=await runTelehealthConsentSchemaUpgrade(database,m,c,'inspect');
      if (observationKeys.some(k=>after[k]!==error.observation[k])) fail('verification_failed','rollback_readback');
      return {...after,command:'rehearse',rolledBack:true};
    }
    if (error instanceof FullscriptUpgradeError) throw new FullscriptUpgradeError(error.category,error.stage??stage);
    throw new FullscriptUpgradeError('upgrade_failed',stage);
  }
}
