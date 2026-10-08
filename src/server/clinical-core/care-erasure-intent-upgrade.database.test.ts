import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {ClinicalCoreDatabase,ClinicalCoreTransaction} from './database';
import {applyClinicalCoreMigrations,loadClinicalCoreMigrations,type ClinicalCoreMigration} from './migrations';
import {applyGovernedCatalogMigrations,loadGovernedCatalogMigrations} from './catalog-migrations';
import {CARE_ERASURE_AWS,type CareErasureUpgradeConfiguration} from './care-erasure-schema-upgrade';
import {CARE_ERASURE_INTENT_UPGRADE,careErasureIntentMapping,runCareErasureIntentUpgrade} from './care-erasure-intent-upgrade';
import {releaseCareIntent} from '../../../scripts/care-intent-release.mjs';
import {careIntentContinuationFixture} from '../../../scripts/test-fixtures/care-intent-continuation.mjs';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const owner='70000000-0000-4000-8000-000000000001',org='70000000-0000-4000-8000-000000000002';
const request='70000000-0000-4000-8000-000000000003',pending='70000000-0000-4000-8000-000000000004';
const config:CareErasureUpgradeConfiguration={account:CARE_ERASURE_AWS.account,region:CARE_ERASURE_AWS.region,
 clusterArn:CARE_ERASURE_AWS.clusterArn,secretArn:CARE_ERASURE_AWS.secretArn,databaseName:'clinical_core',
 phiAllowed:false,environment:'synthetic-staging',dataClassification:'synthetic_only'};
let pg:PGlite,m:ClinicalCoreMigration[],reference:ClinicalCoreMigration[],overlay:ClinicalCoreMigration;
type Inner={query:(sql:string,parameters?:unknown[])=>Promise<unknown>};
type Intercept=(sql:string,tx:Inner)=>Promise<void>;
const database=(intercept?:Intercept,name='clinical_core'):ClinicalCoreDatabase=>({transaction:work=>pg.transaction(async tx=>
 work({query:async(sql:string,parameters:readonly unknown[]=[])=>{
  if(intercept)await intercept(sql,tx);
  if(sql==='select current_database() as name')return {rows:[{name}]};
  return tx.query(sql,[...parameters]);
 }} as ClinicalCoreTransaction))});
const run=(command:'inspect'|'rehearse'|'upgrade',db=database())=>runCareErasureIntentUpgrade(db,m,reference,overlay,config,command);
const atReceipt=(change:(tx:Inner)=>Promise<void>)=>database(async(sql,tx)=>{
 if(sql.startsWith('insert into clinical_core.schema_migrations'))await change(tx);
});
async function predecessor(){
 expect((await pg.query<{n:number}>('select count(*)::int n from clinical_core.schema_migrations')).rows[0]?.n).toBe(47);
 expect((await pg.query<{absent:boolean}>("select to_regclass('clinical_core.care_data_erasure_intents') is null absent")).rows[0]?.absent).toBe(true);
}
beforeAll(async()=>{
 pg=new PGlite({extensions:{pgcrypto}});m=loadClinicalCoreMigrations();reference=loadGovernedCatalogMigrations();
 const sql=readFileSync('infra/aws-clinical-core/source-candidates/care-erasure-intents.sql','utf8').replace(/\r\n?/g,'\n');
 overlay={version:CARE_ERASURE_INTENT_UPGRADE.version,name:CARE_ERASURE_INTENT_UPGRADE.name,sql,sha256:sha(sql)};
 await applyClinicalCoreMigrations(database(),m);await applyGovernedCatalogMigrations(database(),reference);
 const alias=m.find(v=>v.version==='20260821049700')!;
 await pg.query("insert into clinical_core.schema_migrations(version,name,sha256) values('20260902230000',$1,$2)",[alias.name,alias.sha256]);
 await pg.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'FICTIONAL intent operator clinic')",[org]);
 await pg.query("insert into clinical_core.persons(id,synthetic_subject_key) values($1,'syn_intent_operator_owner')",[owner]);
 await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'consumer','fictional_intent_operator_subject',true)",[owner]);
 await pg.query("insert into clinical_core.care_data_erasure_requests(owner_id,request_id,scope,outcome) values($1,$2,'domain','cancelled')",[owner,request]);
 await pg.query("insert into clinical_reference.knowledge_sources(stable_id,environment) values('src_fictional_intent_operator','synthetic-staging')");
 await pg.query(`insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose)
  select $1,$2,'consent.granted','consent',$2,'consent_management' from generate_series(1,12001)`,[org,owner]);
},60000);
afterAll(async()=>{await pg?.close();});
describe('blocked preserving intent successor operator library',()=>{
 it('maps source46/live47 to separate source47/live48, preserving the historical alias and reference identity',()=>{
  const p=careErasureIntentMapping(m,reference,overlay,config);
  expect(p.before).toHaveLength(47);expect(p.after).toHaveLength(48);
  expect(p.after.filter(v=>v.version==='20260902230000')).toEqual(p.before.filter(v=>v.version==='20260902230000'));
  expect(p.after.at(-1)).toEqual({version:overlay.version,name:overlay.name,sha256:overlay.sha256});
  expect(loadClinicalCoreMigrations()).toHaveLength(46);
 });
 it('refuses boundary and artifact drift before opening a database transaction',async()=>{
  let opened=false;const never:ClinicalCoreDatabase={transaction:async()=>{opened=true;throw Error('unexpected');}};
  for(const patch of [{databaseName:'clinical_core_qualification'},{account:'173535830222'},{region:'us-west-2'},
   {phiAllowed:true},{secretArn:config.secretArn+'wrong'},{dataClassification:'real_patient_data'}]){
   await expect(runCareErasureIntentUpgrade(never,m,reference,overlay,{...config,...patch} as CareErasureUpgradeConfiguration,'upgrade')).rejects.toThrow('boundary_refused');
  }
  for(const changed of [{...overlay,name:'renamed'},{...overlay,version:'20261007020000'},
   {...overlay,sql:overlay.sql+'\nselect 1;',sha256:sha(overlay.sql+'\nselect 1;')},
   {...overlay,sql:overlay.sql.replace(/\n/g,'\r\n')}]){
   await expect(runCareErasureIntentUpgrade(never,m,reference,changed,config,'upgrade')).rejects.toThrow('artifact_refused');
  }
  await expect(runCareErasureIntentUpgrade(never,m.slice(0,45),reference,overlay,config,'upgrade')).rejects.toThrow('artifact_refused');
  expect(opened).toBe(false);await predecessor();
 });
 it('inspects only, fingerprints all old rows including receipt and catalog, and refuses a substituted database name',async()=>{
  const queries:string[]=[];const r=await run('inspect',database(async sql=>{queries.push(sql);}));
  expect(r).toMatchObject({observedMigrationCount:47,sourceMigrationCount:46,tableCount:88,applied:false,
   dataPreserved:true,schemaPreserved:true,canonicalRegistered:false,hostedAcceptance:false,recoveryAcceptance:false,activationApproved:false});
  expect(r.rowCount).toBeGreaterThan(12001);expect(queries[0]).toContain('read only');
  expect(queries.some(sql=>/^(create|alter|insert|update|delete|lock)/i.test(sql))).toBe(false);
  await expect(run('rehearse',database(undefined,'clinical_core_qualification'))).rejects.toThrow('boundary_refused');await predecessor();
 });
 it('batches schema reads without changing the legacy ordered per-table schema digest',async()=>{
  const queries:{sql:string;parameters:readonly unknown[]}[]=[];
  const wrapped:ClinicalCoreDatabase={transaction:work=>database().transaction(tx=>work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
   if(sql.includes('jsonb_array_elements_text($1::jsonb) with ordinality selected'))queries.push({sql,parameters});
   return tx.query<Row>(sql,parameters);
  }}))};
  const inspected=await run('inspect',wrapped);expect(queries).toHaveLength(2);
  const query=queries[0],names=JSON.parse(String(query.parameters[0])) as string[];
  expect(names).toHaveLength(88);expect(queries[1]).toEqual(query);
  // Freeze the pre-batching query form as an independent per-table oracle.
  const old=query.sql.replace('select selected.name relation_name,\n  encode','select encode')
   .replace(/from jsonb_array_elements_text\(\$1::jsonb\) with ordinality selected\(name,position\)[\s\S]*$/,
    'from pg_class c where c.oid=$1::regclass');
  const digests:string[]=[];
  for(const name of names)digests.push((await pg.query<{digest:string}>(old,[name])).rows[0].digest);
  expect(inspected.schemaSha256).toBe(sha(JSON.stringify(digests)));
 },30000);
 it('runs the actual overlay and rolls back, independently proving history, original receipts, schema and data unchanged',async()=>{
  const before=await run('inspect'),r=await run('rehearse');
  expect(r).toMatchObject({rolledBack:true,observedMigrationCount:47,tableCount:88,applied:false,
   rowCount:before.rowCount,dataSha256:before.dataSha256,schemaSha256:before.schemaSha256});await predecessor();
 },30000); // Multiple complete SQL fingerprints and rollback over 12k+ fictional rows; transport deadlines are unchanged.
 it('refuses an unapplied terminal predecessor instead of implicitly upgrading the parent',async()=>{
  const terminal=m.at(-1)!;await pg.query('delete from clinical_core.schema_migrations where version=$1',[terminal.version]);
  try{await expect(run('upgrade')).rejects.toThrow('history_refused');}
  finally{await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[terminal.version,terminal.name,terminal.sha256]);}
  await predecessor();
 });
 it('refuses alias/reference history drift',async()=>{
  for(const [table,version,value] of [['clinical_core.schema_migrations','20260902230000',m.find(v=>v.version==='20260821049700')!.sha256],
   ['clinical_reference.schema_migrations',reference[0].version,reference[0].sha256]]){
   await pg.query(`update ${table} set sha256=$1 where version=$2`,['f'.repeat(64),version]);
   try{await expect(run('upgrade')).rejects.toThrow('history_refused');}
   finally{await pg.query(`update ${table} set sha256=$1 where version=$2`,[value,version]);}
  }await predecessor();
 });
 it.each([
  "update clinical_core.organizations set synthetic_label='FICTIONAL changed'",
  "update clinical_reference.knowledge_sources set review_status='rejected' where stable_id='src_fictional_intent_operator'",
  `insert into clinical_core.care_data_erasure_intents(owner_id,request_id,scope) values('${owner}','${pending}','domain')`,
 ])('rolls back original/reference data changes or unexpected seeded intents: %s',async sql=>{
  const before=await run('inspect');await expect(run('upgrade',atReceipt(async tx=>{await tx.query(sql);}))).rejects.toThrow('data_changed');
  expect((await run('inspect')).dataSha256).toBe(before.dataSha256);await predecessor();
 // Four complete 88-table fingerprint/schema passes qualify rollback and
 // preservation, not a five-second API response SLA. Keep all assertions and
 // SQL deadlines; give this intentionally expensive case a bounded budget.
 },30000);
 it.each([
  'grant select on clinical_core.care_data_erasure_requests to clinical_core_api',
  'alter table clinical_core.care_data_erasure_requests drop constraint care_data_erasure_requests_scope_check',
  'alter table clinical_core.persons add column unreviewed_field text',
  'alter table clinical_core.care_data_erasure_requests disable trigger care_data_erasure_requests_immutable',
 ])('rolls back preserved schema or ACL changes: %s',async sql=>{
  await expect(run('upgrade',atReceipt(async tx=>{await tx.query(sql);}))).rejects.toThrow('verification_failed');await predecessor();
 });
 it.each([
  'grant execute on function clinical_core.care_data_erasure_request_v1_terminal(jsonb) to clinical_core_api',
  'grant execute on function clinical_private.care_erasure_locked_owner() to public',
  'grant select(request_id) on clinical_core.care_data_erasure_intents to clinical_core_api',
  'alter function clinical_core.care_data_prepare_erasure(jsonb) set search_path=public',
  'alter table clinical_core.care_data_erasure_intents disable trigger care_data_erasure_intents_immutable',
  'alter table clinical_core.care_data_erasure_intents drop constraint care_data_erasure_intents_scope_check',
  'alter table clinical_core.care_data_erasure_intents drop constraint care_data_erasure_intents_owner_id_fkey',
  'alter table clinical_core.care_data_erasure_intents alter column registered_at drop default',
  'alter table clinical_core.care_data_erasure_intents alter column scope drop not null',
  'alter table clinical_core.care_data_erasure_intents add column unreviewed_field text',
  'alter table clinical_core.care_data_erasure_intents add constraint unreviewed_constraint check(true)',
 ])('rolls back successor authority drift: %s',async sql=>{
  await expect(run('upgrade',atReceipt(async tx=>{await tx.query(sql);}))).rejects.toThrow('verification_failed');await predecessor();
 });
 it('copies artifacts before awaiting and sanitizes a database error, without leaking provider or SQL text',async()=>{
  const copied=m.map(v=>({...v})),o={...overlay},c={...config};let changed=false;
  expect(await runCareErasureIntentUpgrade(database(async()=>{
   if(changed)return;changed=true;copied[0].sql+='changed';o.sql+='changed';c.databaseName='clinical_core_qualification';
  }),copied,reference,o,c,'rehearse')).toMatchObject({rolledBack:true});
  await expect(run('upgrade',atReceipt(async()=>{throw Error('secret provider detail');})))
   .rejects.toMatchObject({category:'upgrade_failed',stage:'ledger_receipt',message:'upgrade_failed'});await predecessor();
 });
 it('applies once to a disposable database and preserves old terminal and new pending records on idempotent replay',async()=>{
  const before=await run('inspect'),fixture=careIntentContinuationFixture();
  const receipt=async(command:'inspect'|'rehearse'|'upgrade')=>({...fixture.supplied.preparation.database,...await run(command),
   operatorSource:{sourceCommit:fixture.supplied.current.desktop.commit,clean:true},awsAccountId:CARE_ERASURE_AWS.account,foundation:CARE_ERASURE_AWS.foundation} as Awaited<ReturnType<typeof fixture.d.schema>>);
  const baseline=await receipt('inspect');fixture.supplied.preparation.database=baseline;
  fixture.supplied.recovery.databaseBefore=structuredClone(baseline);fixture.supplied.recovery.databaseAfter=structuredClone(baseline);
  fixture.d.schema=receipt;
  // Exercise the real continuation against SQL-derived receipts. The empty
  // new table changes the complete digest; transport/source ports alone are
  // fictional. No mocked digest can hide this integration mismatch again.
  const released=await releaseCareIntent(fixture.supplied,fixture.d),r=released.committed;
  expect(r).toMatchObject({observedMigrationCount:48,sourceMigrationCount:47,tableCount:89,applied:true,alreadyApplied:false,
   dataSha256:before.dataSha256,schemaSha256:before.schemaSha256});
  const empty=await run('inspect');expect(empty.intentRowCount).toBe(0);
  expect(empty.dataSha256).not.toBe(before.dataSha256);expect(empty.originalDataSha256).toBe(before.dataSha256);
  expect(empty.completeDataSha256).toBe(r.completeDataSha256);expect(released.after.dataSha256).toBe(empty.dataSha256);
  await pg.query("insert into clinical_core.care_data_erasure_intents(owner_id,request_id,scope) values($1,$2,'domain')",[owner,pending]);
  const after=await run('inspect');expect(after.rowCount).toBe(before.rowCount+1);
  expect(after.originalRowCount).toBe(before.rowCount);expect(after.originalDataSha256).toBe(before.dataSha256);expect(after.intentRowCount).toBe(1);
  expect(await run('upgrade')).toMatchObject({applied:false,alreadyApplied:true,dataSha256:after.dataSha256});
  expect(await run('rehearse')).toMatchObject({rolledBack:true,observedMigrationCount:48,dataSha256:after.dataSha256});
  expect((await pg.query('select request_id from clinical_core.care_data_erasure_requests')).rows).toEqual([{request_id:request}]);
  expect(JSON.stringify(after)).not.toMatch(/secretArn|FICTIONAL|synthetic_subject_key/);
 },30000);
});
