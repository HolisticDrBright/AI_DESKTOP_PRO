import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { FULLSCRIPT_UPGRADE, FULLSCRIPT_CONSENT_SUCCESSOR } from './fullscript-migration-release';
import { runTelehealthConsentSchemaUpgrade } from './telehealth-consent-schema-upgrade';
import { bindParameters } from './rds-data-database';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
let pg:PGlite,m:ClinicalCoreMigration[],org:string,person:string,patient:string;
const c:QualificationUpgradeConfiguration={expectedAccountId:'588966314750',region:'us-east-2',phiAllowed:false,activation:'blocked',
  clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional',
  qualificationDatabaseName:'clinical_core_qualification',stagingDatabaseName:'clinical_core',
  fromReleaseSha256:FULLSCRIPT_UPGRADE.successor111,toReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger};
type Intercept=(sql:string,tx:{query:(sql:string,args?:unknown[])=>Promise<unknown>})=>Promise<void>;
// Only PGlite's fixed database name is modeled. Actual SQL, ACLs, triggers,
// RLS, canonical artifact, preservation and transaction rollback are exercised.
const database=(intercept?:Intercept,name='clinical_core_qualification'):ClinicalCoreDatabase=>({transaction:work=>pg.transaction(async tx=>work({
  query:async(sql,args=[])=>{
    // All source queries must be encodable by the actual AWS transport.
    bindParameters(sql,args);
    if(intercept)await intercept(sql,tx);
    if(sql==='select current_database() as name')return {rows:[{name}]};
    return tx.query(sql,[...args]);
  },
} as ClinicalCoreTransaction))});
const absent=async()=>expect((await pg.query<{n:number;absent:boolean}>(`select
  (select count(*)::int from clinical_core.schema_migrations) n,
  to_regprocedure('clinical_core.production_telehealth_consent_request(jsonb)') is null absent`)).rows[0])
  .toEqual({n:111,absent:true});
beforeAll(async()=>{
  const a=JSON.parse(execFileSync(process.execPath,['scripts/build-telehealth-consent-copy-candidate.mjs','--json'],
    {encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000,windowsHide:true}));
  m=a.manifest.migrations.map((r:{version:string;file:string})=>({version:r.version,name:r.file.slice(15,-4),sql:a.files[r.file],sha256:sha(a.files[r.file])}));
  pg=new PGlite({extensions:{pgcrypto}});
  await applyProductionClinicalCoreMigrations(database(),m.slice(0,106));
  for(const r of m.slice(106,111)) {
    await pg.exec(r.sql);
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[r.version,r.name,r.sha256]);
  }
  [org,person,patient]=Array.from({length:3},()=>randomUUID());
  // Every identity, approval, copy and hold here is fictional, in memory.
  // Nothing is an owner/provider review or a hosted activation receipt.
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL preservation')",[org]);
  await pg.query("insert into clinical_core.persons(id,subject_key) values($1,'subject_fictional_consent_upgrade')",[person]);
  await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce','FICTIONAL_reviewer',true)",[person]);
  await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'owner')",[org,person]);
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,'patient_fictional_consent_upgrade','FICTIONAL','TEST')",[patient,org]);
  await pg.query("insert into fullscript_delivery.recipient_holds(organization_id,patient_record_id,reason,placed_by_person_id) values($1,$2,'privacy_request',$3)",[org,patient,person]);
  const copy='FICTIONAL existing immutable copy. No real health information.', artifact=randomUUID();
  await pg.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
    values($1,$2,'telehealth_recording','FICTIONAL/1',$3,'TEST','approved',now(),$4)`,[artifact,org,sha(copy),person]);
  await pg.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)',[artifact,org,copy,sha(copy)]);
},90000);
afterAll(async()=>{await pg?.close();});
describe('111 -> 112 preserving real-SQL upgrade, source-only not hosted acceptance',()=>{
  it('reads the exact parent with legitimate Fullscript holds and approved copies without creating or changing anything',async()=>{
    const queries:string[]=[];
    const r=await runTelehealthConsentSchemaUpgrade(database(async sql=>{queries.push(sql);}),m,c,'inspect');
    expect(r).toMatchObject({observedMigrationCount:111,historicalTableCount:217,rowCount:8,newTableCount:0,newRows:0,newFunctionCount:0,applied:false});
    expect(queries[0]).toContain('read only');
    expect(queries.some(sql=>/^(create|alter|insert|update|delete|grant|revoke|lock table)/i.test(sql))).toBe(false);
    expect((await pg.query<{n:number}>('select count(*)::int n from fullscript_delivery.recipient_holds')).rows[0].n).toBe(1);
    await absent();
  },30000);
  it('actually applies and rolls back the one function, verifying all historical data, ledger receipts, schema and holds',async()=>{
    const before=await runTelehealthConsentSchemaUpgrade(database(),m,c,'inspect');
    const after=await runTelehealthConsentSchemaUpgrade(database(),m,c,'rehearse');
    expect(after).toMatchObject({...before,command:'rehearse',rolledBack:true});
    await absent();
  },60000);
  it.each(['clinical_core','clinical_core_production','postgres'])('refuses the observed database %s before DDL',async name=>{
    await expect(runTelehealthConsentSchemaUpgrade(database(undefined,name),m,c,'rehearse')).rejects.toMatchObject({category:'boundary_refused'});
    await absent();
  });
  it.each([{expectedAccountId:'173535830222'},{phiAllowed:true},{activation:'approved'},{region:'us-east-1'},
    {fromReleaseSha256:FULLSCRIPT_UPGRADE.parent108},{toReleaseSha256:FULLSCRIPT_UPGRADE.successor111},
    {secretArn:'arn:aws:secretsmanager:us-east-2:173535830222:secret:fictional'}])('refuses unsafe boundary %j before opening a transaction',async delta=>{
    await expect(runTelehealthConsentSchemaUpgrade({transaction:async()=>{throw Error('unexpected_transaction');}},m,
      {...c,...delta} as QualificationUpgradeConfiguration,'inspect')).rejects.toMatchObject({category:'boundary_refused'});
  });
  it.each(['sql','name','version','short','extra'])('rejects altered or incomplete source artifact: %s',async change=>{
    const altered=m.map(r=>({...r}));
    if(change==='sql'){altered[111].sql+='\nselect 1;';altered[111].sha256=sha(altered[111].sql);}
    if(change==='name')altered[0].name='forged';
    if(change==='version')altered[110].version='20261010000000';
    if(change==='short')altered.pop();
    if(change==='extra')altered.push({...m[111],version:'20261011100000'});
    await expect(runTelehealthConsentSchemaUpgrade(database(),altered,c,'rehearse')).rejects.toMatchObject({category:'artifact_refused'});
    await absent();
  });
  it('refuses changed historical ledger names, not merely count or latest version',async()=>{
    await pg.query("update clinical_core.schema_migrations set name='forged' where version=$1",[m[3].version]);
    try{await expect(runTelehealthConsentSchemaUpgrade(database(),m,c,'inspect')).rejects.toMatchObject({category:'history_refused'});}
    finally{await pg.query('update clinical_core.schema_migrations set name=$1 where version=$2',[m[3].name,m[3].version]);}
    await absent();
  });
  it('refuses an unexpected new-function overload on the parent',async()=>{
    await pg.exec("create function clinical_core.production_telehealth_consent_request(text) returns text language sql as $$ select $1 $$");
    try{await expect(runTelehealthConsentSchemaUpgrade(database(),m,c,'inspect')).rejects.toMatchObject({category:'verification_failed',stage:'new_function'});}
    finally{await pg.exec('drop function clinical_core.production_telehealth_consent_request(text)');}
    await absent();
  });
  it('refuses missing migration/fixture lock admission',async()=>{
    const refusing:ClinicalCoreDatabase={transaction:work=>database().transaction(tx=>work({query:async(sql,args)=>{
      if(sql.includes('pg_try_advisory_xact_lock'))return {rows:[{acquired:false}]} as never;
      return tx.query(sql,args);
    }}))};
    await expect(runTelehealthConsentSchemaUpgrade(refusing,m,c,'rehearse')).rejects.toMatchObject({category:'upgrade_busy'});
    await absent();
  });
  it('refuses a changed admission before executing new DDL',async()=>{
    const a=await runTelehealthConsentSchemaUpgrade(database(),m,c,'inspect');
    await pg.query("update clinical_core.patient_records set first_name='FICTIONAL new admission' where id=$1",[patient]);
    try{await expect(runTelehealthConsentSchemaUpgrade(database(),m,c,'upgrade',a)).rejects.toMatchObject({category:'admission_changed'});}
    finally{await pg.query("update clinical_core.patient_records set first_name='FICTIONAL' where id=$1",[patient]);}
    await absent();
  },30000);
  it.each([
    ['historical row',"update clinical_core.patient_records set first_name='FICTIONAL corruption'",'after_data'],
    ['Fullscript shape','alter table fullscript_delivery.recipient_holds add column forbidden text','after_schema'],
    ['existing cart function',"revoke execute on function clinical_core.canonical_protocol_cart_workforce(jsonb) from clinical_core_api",'after_schema'],
    ['historical role membership','grant fullscript_draft_worker to clinical_core_api','after_schema'],
    ['old migration receipt',"update clinical_core.schema_migrations set applied_at=applied_at+interval '1 second' where version='20261009100000'",'after_data'],
  ])('detects an unauthorized %s change inside the transaction and rolls back',async(_label,injection,stage)=>{
    let changed=false;
    await expect(runTelehealthConsentSchemaUpgrade(database(async(sql,tx)=>{
      if(!changed&&sql.includes('create function '+ 'clinical_core.production_telehealth_consent_request')){changed=true;await tx.query(injection);}
    }),m,c,'rehearse')).rejects.toMatchObject({category:'verification_failed',stage});
    await absent();
    expect((await pg.query<{first_name:string}>('select first_name from clinical_core.patient_records where id=$1',[patient])).rows[0].first_name).toBe('FICTIONAL');
  },30000);
  it.each([
    'grant execute on function clinical_core.production_telehealth_consent_request(jsonb) to public',
    'grant execute on function clinical_core.production_telehealth_consent_request(jsonb) to fullscript_draft_worker',
    'alter function clinical_core.production_telehealth_consent_request(jsonb) set search_path=public',
    'create function clinical_core.production_telehealth_consent_request(text) returns text language sql as $$ select $1 $$',
  ])('refuses widened/malformed new function authority: %s',async injection=>{
    let changed=false;
    await expect(runTelehealthConsentSchemaUpgrade(database(async(sql,tx)=>{
      if(!changed&&sql.startsWith('insert into clinical_core.schema_migrations')){changed=true;await tx.query(injection);}
    }),m,c,'rehearse')).rejects.toMatchObject({category:'verification_failed',stage:'new_function'});
    await absent();
  },30000);
  it('a failed migration receipt rolls back the function without issuing preservation evidence',async()=>{
    await expect(runTelehealthConsentSchemaUpgrade(database(async sql=>{
      if(sql.startsWith('insert into clinical_core.schema_migrations'))throw Error('FICTIONAL lost receipt');
    }),m,c,'rehearse')).rejects.toMatchObject({category:'upgrade_failed',stage:'extension_ddl'});
    await absent();
  },30000);
  it('commits only with exact admission; readback includes the same holds/copies, and blind retry is refused',async()=>{
    const baseline=await runTelehealthConsentSchemaUpgrade(database(),m,c,'inspect');
    const r=await runTelehealthConsentSchemaUpgrade(database(),m,c,'upgrade',baseline);
    expect(r).toMatchObject({...baseline,command:'upgrade',observedMigrationCount:112,applied:true,newFunctionCount:1});
    const queries:string[]=[];
    const settled=await runTelehealthConsentSchemaUpgrade(database(async sql=>{queries.push(sql);}),m,c,'inspect-settled');
    expect(settled).toMatchObject({...baseline,command:'inspect-settled',observedMigrationCount:112,newFunctionCount:1});
    expect(queries.some(sql=>/^(create|alter|insert|update|delete|grant|revoke)/i.test(sql))).toBe(false);
    expect(queries.some(sql=>sql.startsWith('lock table'))).toBe(true);
    await expect(runTelehealthConsentSchemaUpgrade(database(),m,c,'upgrade',baseline)).rejects.toMatchObject({category:'recovery_required'});
    expect((await pg.query<{n:number}>('select count(*)::int n from fullscript_delivery.recipient_holds')).rows[0].n).toBe(1);
    expect((await pg.query<{n:number}>('select count(*)::int n from clinical_core.care_consent_texts')).rows[0].n).toBe(1);
  },60000);
  it('settlement refuses changed new-function bytes or PUBLIC authority rather than trusting the ledger',async()=>{
    await pg.exec('grant execute on function clinical_core.production_telehealth_consent_request(jsonb) to public');
    try{await expect(runTelehealthConsentSchemaUpgrade(database(),m,c,'inspect-settled')).rejects.toMatchObject({category:'verification_failed',stage:'new_function'});}
    finally{await pg.exec('revoke all on function clinical_core.production_telehealth_consent_request(jsonb) from public');}
  },30000);
});
