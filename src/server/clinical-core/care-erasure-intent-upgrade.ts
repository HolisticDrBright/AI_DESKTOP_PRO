if (typeof window !== 'undefined') throw new Error('care-erasure-intent-upgrade is server-only');
import {createHash} from 'node:crypto';
import type {ClinicalCoreDatabase,ClinicalCoreTransaction} from './database';
import {splitPostgresStatements,type ClinicalCoreMigration} from './migrations';
import {assertCareErasureUpgrade,CARE_ERASURE_UPGRADE,careErasurePreservation as base,
 type CareErasureUpgradeConfiguration} from './care-erasure-schema-upgrade';

/** Historical overlay transition identity. The exact SQL is now registered in
 * the current synthetic source manifest; this parent-view operator remains a
 * historical witness, not current release or PHI approval. Its separate CLI
 * permits only inspection and rollback rehearsal, never lasting upgrade. */
export const CARE_ERASURE_INTENT_UPGRADE=Object.freeze({version:'20261007010000',name:'synthetic_care_erasure_intents',
 sqlSha256:'4be2ca72b0486bec171f16c5299c898d70bfbdbfd3143c4bb216fccc329299ec'});
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Category='boundary_refused'|'artifact_refused'|'history_refused'|'inventory_refused'|'upgrade_busy'
 |'data_changed'|'verification_failed'|'upgrade_failed';
export class CareErasureIntentUpgradeError extends Error{
 constructor(readonly category:Category,readonly stage?:string){super(category);}
}
const fail=(category:Category,stage?:string):never=>{throw new CareErasureIntentUpgradeError(category,stage);};
type Table={schema_name:string;table_name:string;kind:string;rls:boolean;forced:boolean}&Record<string,unknown>;
const added='clinical_core.care_data_erasure_intents';
const rows=(m:ClinicalCoreMigration[])=>m.map(({version,name,sha256})=>({version,name,sha256}));
export function careErasureIntentMapping(m:ClinicalCoreMigration[],reference:ClinicalCoreMigration[],
 overlay:ClinicalCoreMigration,c:CareErasureUpgradeConfiguration){
 try{assertCareErasureUpgrade(c,m,reference);}catch(error){
  const category=error instanceof Error&&error.message==='boundary_refused'?'boundary_refused':'artifact_refused';fail(category);
 }
 const p=CARE_ERASURE_INTENT_UPGRADE;
 if(overlay.version!==p.version||overlay.name!==p.name||overlay.sha256!==p.sqlSha256
  ||overlay.sql.replace(/\r\n?/g,'\n')!==overlay.sql||sha(overlay.sql)!==p.sqlSha256)fail('artifact_refused');
 const alias=m.find(v=>v.version==='20260821049700')??fail('artifact_refused');
 const before=[...rows(m),{version:'20260902230000',name:alias.name,sha256:alias.sha256}]
  .sort((a,b)=>a.version<b.version?-1:a.version>b.version?1:0);
 if(sha(JSON.stringify(before))!==CARE_ERASURE_UPGRADE.liveAfter)fail('artifact_refused');
 const after=[...before,...rows([overlay])];
 return {before,after,reference:rows(reference),sourceBeforeSha256:CARE_ERASURE_UPGRADE.sourceAfter,
  sourceAfterSha256:sha(JSON.stringify([...rows(m),...rows([overlay])])),
  liveBeforeSha256:sha(JSON.stringify(before)),liveAfterSha256:sha(JSON.stringify(after)),
  referenceSha256:CARE_ERASURE_UPGRADE.reference};
}
type Mapping=ReturnType<typeof careErasureIntentMapping>;
async function history(tx:ClinicalCoreTransaction,p:Mapping){
 const core=(await tx.query('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows;
 const successor=core.length===48;
 if(JSON.stringify(core)!==JSON.stringify(successor?p.after:p.before))fail('history_refused');
 const reference=(await tx.query('select version,name,sha256 from clinical_reference.schema_migrations order by version')).rows;
 if(JSON.stringify(reference)!==JSON.stringify(p.reference))fail('history_refused');
 return successor;
}
async function inventory(tx:ClinicalCoreTransaction,successor:boolean){
 const tables=(await tx.query<Table>(base.tableQuery)).rows;
 const old=tables.filter(t=>base.tableName(t)!==added),original=old.filter(t=>base.tableName(t)!=='clinical_core.care_data_erasure_requests');
 if(tables.length!==(successor?89:88)||old.length!==88||original.length!==87
  ||sha(JSON.stringify(original))!==CARE_ERASURE_UPGRADE.oldTableMetadata
  ||tables.some(t=>t.kind!=='r')||!old.some(t=>base.tableName(t)==='clinical_core.care_data_erasure_requests'&&t.rls&&!t.forced)
  ||successor&&!tables.some(t=>base.tableName(t)===added&&t.rls&&!t.forced))fail('inventory_refused');
 tables.forEach(base.qualified);return {tables,old,added:tables.filter(t=>base.tableName(t)===added)};
}
/** Exact within-engine schema equality includes all old columns, constraints,
 * indexes, policies, triggers and effective ACL entries, not only row counts/RLS. */
async function preservedSchema(tx:ClinicalCoreTransaction,tables:Table[]){
 const names=tables.map(base.tableName);
 // Preserve the exact per-table encoding and ordered digest list, while
 // avoiding two full sets of per-table remote round trips during inspection.
 const result=(await tx.query<{relation_name:string;digest:string}>(`select selected.name relation_name,
  encode(sha256(convert_to(jsonb_build_object(
   'relation',jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,'owner',c.relowner::regrole::text,
     'acl',coalesce(c.relacl,acldefault('r',c.relowner))::text),
   'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
     'required',a.attnotnull,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
     from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
   'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'validated',k.convalidated,'def',pg_get_constraintdef(k.oid)) order by k.conname)
     from pg_constraint k where k.conrelid=c.oid),
   'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=c.oid),
   'policies',(select jsonb_agg(to_jsonb(p)-'oid'-'polrelid' order by p.polname) from pg_policy p where p.polrelid=c.oid),
   'triggers',(select jsonb_agg(jsonb_build_object('enabled',t.tgenabled,'def',pg_get_triggerdef(t.oid)) order by t.tgname)
     from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
  )::text,'UTF8')),'hex') digest from jsonb_array_elements_text($1::jsonb) with ordinality selected(name,position)
   join pg_class c on c.oid=selected.name::regclass order by selected.position`,[JSON.stringify(names)])).rows;
 if(result.length!==names.length||result.some((row,i)=>row.relation_name!==names[i]||!/^[a-f0-9]{64}$/.test(row.digest)))
  fail('verification_failed','preserved_schema_inventory');
 return sha(JSON.stringify(result.map(row=>row.digest)));
}
async function verifySuccessor(tx:ClinicalCoreTransaction,m:ClinicalCoreMigration[],overlay:ClinicalCoreMigration){
 const functions=[
  {name:'clinical_core.care_data_erase',signature:'(jsonb)',result:'jsonb',definer:true,api:false,body:base.functionBodySha256(m,'clinical_core.care_data_erase')},
  {name:'clinical_private.care_data_immutable',signature:'()',result:'trigger',definer:false,api:false,body:base.functionBodySha256(m,'clinical_private.care_data_immutable')},
  {name:'clinical_core.care_data_erasure_request_v1_terminal',signature:'(jsonb)',result:'jsonb',definer:true,api:false,body:base.functionBodySha256(m,'clinical_core.care_data_erasure_request')},
  ...['clinical_private.care_erasure_locked_owner','clinical_core.care_data_prepare_erasure',
   'clinical_core.care_data_discover_erasures','clinical_core.care_data_erasure_request'].map(name=>({name,
    signature:name.endsWith('locked_owner')?'()':'(jsonb)',result:name.endsWith('locked_owner')?'uuid':'jsonb',
    definer:true,api:!name.endsWith('locked_owner'),body:base.functionBodySha256([overlay],name)})),
 ];
 for(const f of functions){
  const [schema,name]=f.name.split('.');
  const valid=(await tx.query<{valid:boolean}>(`select count(*)=1 and bool_and(p.oid=to_regprocedure($1)
   and p.prokind='f' and p.prorettype=$2::regtype and p.prosecdef=$3
   and p.prolang=(select oid from pg_language where lanname='plpgsql') and (not $3 or p.proconfig=array['search_path=""']::text[])
   and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$4 and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')=$5
   and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0)) valid
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$6 and p.proname=$7`,
  [f.name+f.signature,f.result,f.definer,f.body,f.api,schema,name])).rows[0]?.valid;
  if(valid!==true)fail('verification_failed',`function_contract:${f.name}`);
 }
 const valid=(await tx.query<{valid:boolean}>(`select c.relrowsecurity and not c.relforcerowsecurity
  and not has_table_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_any_column_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
  and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0)
  and not exists(select 1 from pg_attribute a,lateral aclexplode(a.attacl) x where a.attrelid=c.oid and x.grantee=0)
  and exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname='care_data_erasure_intents_immutable'
    and not t.tgisinternal and t.tgenabled='O' and t.tgtype=27 and t.tgfoid='clinical_private.care_data_immutable()'::regprocedure)
  and exists(select 1 from pg_constraint k where k.conrelid=c.oid and k.contype='p'
    and pg_get_constraintdef(k.oid)='PRIMARY KEY (owner_id, request_id)') valid
  from pg_class c where c.oid='clinical_core.care_data_erasure_intents'::regclass`)).rows[0]?.valid;
 if(valid!==true)fail('verification_failed','intent_table_contract');
 const cols=(await tx.query(`select attname name,format_type(atttypid,atttypmod) type,attnotnull required,
  pg_get_expr(d.adbin,d.adrelid) default_value from pg_attribute a
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid=$1::regclass and a.attnum>0 and not a.attisdropped order by a.attnum`,[added])).rows;
 const constraints=(await tx.query(`select contype::text kind,convalidated validated,pg_get_constraintdef(oid) definition
  from pg_constraint where conrelid=$1::regclass and contype<>'n'`,[added])).rows;
 constraints.sort((a,b)=>{const left=`${a.kind}\u0000${a.definition}`,right=`${b.kind}\u0000${b.definition}`;
  return left<right?-1:left>right?1:0;});
 if(sha(JSON.stringify({cols,constraints}))!=='40407851471e70ef5a9d21f2e415d583794a1d2dc8e99d83f0f02827d41892ec')
  fail('verification_failed','intent_schema_contract');
}
export type CareErasureIntentUpgradeResult={contract:'care-erasure-intent-upgrade/1';command:'inspect'|'rehearse'|'upgrade';
 execution:'synthetic-staging';phiAllowed:false;observedMigrationCount:47|48;sourceMigrationCount:46|47;
 tableCount:number;rowCount:number;dataSha256:string;schemaSha256:string;dataPreserved:true;schemaPreserved:true;
 originalDataSha256:string;originalRowCount:number;completeDataSha256:string;completeRowCount:number;intentRowCount:number;
 applied:boolean;alreadyApplied:boolean;rolledBack:boolean;fromLedgerSha256:string;toLedgerSha256:string;referenceLedgerSha256:string;
 canonicalRegistered:false;hostedAcceptance:false;recoveryAcceptance:false;activationApproved:false};
class RehearsalRollback extends Error{constructor(readonly result:CareErasureIntentUpgradeResult){super('intent_rehearsal_rollback');}}
/** Library candidate only. No public transport, CLI, review substitution, fixture
 * writes or activation. Permanent operation is not authorized by this source. */
export async function runCareErasureIntentUpgrade(database:ClinicalCoreDatabase,supplied:ClinicalCoreMigration[],
 suppliedReference:ClinicalCoreMigration[],suppliedOverlay:ClinicalCoreMigration,suppliedConfiguration:CareErasureUpgradeConfiguration,
 command:'inspect'|'rehearse'|'upgrade'):Promise<CareErasureIntentUpgradeResult>{
 const m=supplied.map(v=>({...v})),reference=suppliedReference.map(v=>({...v})),overlay={...suppliedOverlay},c={...suppliedConfiguration};
 const p=careErasureIntentMapping(m,reference,overlay,c);
 if(!['inspect','rehearse','upgrade'].includes(command))fail('boundary_refused');let stage='transaction_start';
 try{return await database.transaction(async tx=>{
  stage='transaction_settings';await tx.query(command==='inspect'?'set transaction isolation level repeatable read read only':'set transaction isolation level repeatable read');
  await tx.query("set local lock_timeout='5s'");await tx.query("set local statement_timeout='30s'");await tx.query('set local row_security=off');
  stage='database_identity';if((await tx.query<{name:string}>('select current_database() as name')).rows[0]?.name!==c.databaseName)fail('boundary_refused');
  if(command!=='inspect')for(const key of ['ai-desktop-pro:clinical-core-migrations','ai-desktop-pro:governed-catalog-migrations']){
   stage='operator_locks';if((await tx.query<{acquired:boolean}>('select pg_try_advisory_xact_lock(hashtext($1)) acquired',[key])).rows[0]?.acquired!==true)fail('upgrade_busy');
  }
  stage='history';const successor=await history(tx,p);stage='inventory';const beforeTables=await inventory(tx,successor);
  if(command!=='inspect'){
   stage='writer_locks';await tx.query(`lock table ${[...beforeTables.tables.map(base.qualified),'clinical_core.schema_migrations','clinical_reference.schema_migrations'].sort().join(',')} in share row exclusive mode`);
   if(JSON.stringify(await inventory(tx,successor))!==JSON.stringify(beforeTables))fail('inventory_refused');
  }
  stage='before_verification';if(successor)await verifySuccessor(tx,m,overlay);else await base.verifyTerminal(tx,m,true);
  stage='before_fingerprint';const before=await base.fingerprint(tx,beforeTables.tables);
  stage='before_schema';const oldSchema=await preservedSchema(tx,beforeTables.old);
  let applied=false;
  if(command!=='inspect'&&!successor){
   stage='migration_ddl';for(const statement of splitPostgresStatements(overlay.sql))await tx.query(statement);
   stage='ledger_receipt';await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[overlay.version,overlay.name,overlay.sha256]);applied=true;
  }
  const final=command==='inspect'?successor:true;
  stage='after_history';if(await history(tx,p)!==final)fail('history_refused');
  stage='after_inventory';const afterTables=await inventory(tx,final);
  if(JSON.stringify(afterTables.old)!==JSON.stringify(beforeTables.old))fail('inventory_refused');
  stage='after_schema';if(await preservedSchema(tx,afterTables.old)!==oldSchema)fail('verification_failed','preserved_schema_changed');
  stage='after_fingerprint';const after=await base.fingerprint(tx,applied?afterTables.old:afterTables.tables);
  const addedFingerprint=applied?await base.fingerprint(tx,afterTables.added):undefined;
  if(before.sha256!==after.sha256||before.rows!==after.rows||applied&&addedFingerprint?.rows!==0)fail('data_changed');
  stage='contract_verification';if(final)await verifySuccessor(tx,m,overlay);else await base.verifyTerminal(tx,m,true);
  // A successor inspection includes the new table in its complete digest even
  // when that table is empty. Preserve a separate exact old-table witness from
  // this same snapshot; never compare two different inventories as one digest.
  const completeEntries=[...after.entries,...(addedFingerprint?.entries??[])].sort((a,b)=>a.table_name.localeCompare(b.table_name));
  const originalEntries=completeEntries.filter(x=>x.table_name!==added);
  const originalRows=originalEntries.reduce((n,r)=>n+r.row_count,0),completeRows=completeEntries.reduce((n,r)=>n+r.row_count,0);
  const result:CareErasureIntentUpgradeResult={contract:'care-erasure-intent-upgrade/1',command,execution:'synthetic-staging',phiAllowed:false,
   observedMigrationCount:final?48:47,sourceMigrationCount:final?47:46,tableCount:afterTables.tables.length,rowCount:before.rows,
   dataSha256:after.sha256,schemaSha256:oldSchema,dataPreserved:true,schemaPreserved:true,applied,alreadyApplied:successor,rolledBack:false,
   originalDataSha256:sha(JSON.stringify(originalEntries)),originalRowCount:originalRows,
   completeDataSha256:sha(JSON.stringify(completeEntries)),completeRowCount:completeRows,
   intentRowCount:completeRows-originalRows,
   fromLedgerSha256:p.liveBeforeSha256,toLedgerSha256:p.liveAfterSha256,referenceLedgerSha256:p.referenceSha256,
   canonicalRegistered:false,hostedAcceptance:false,recoveryAcceptance:false,activationApproved:false};
  if(command==='rehearse')throw new RehearsalRollback(result);return result;
 });}catch(error){
  if(error instanceof RehearsalRollback){
   const current=await runCareErasureIntentUpgrade(database,m,reference,overlay,c,'inspect');
   if(current.observedMigrationCount!==(error.result.alreadyApplied?48:47)||current.dataSha256!==error.result.dataSha256
    ||current.rowCount!==error.result.rowCount||current.schemaSha256!==error.result.schemaSha256)fail('verification_failed','rollback_readback');
   return {...current,command:'rehearse',rolledBack:true};
  }
  if(error instanceof CareErasureIntentUpgradeError)throw new CareErasureIntentUpgradeError(error.category,error.stage??stage);
  throw new CareErasureIntentUpgradeError('upgrade_failed',stage);
 }
}
