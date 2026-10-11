import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {randomUUID} from 'node:crypto';
import type {ClinicalCoreDatabase,ClinicalCoreTransaction} from './database';
import type {ClinicalCoreMigration} from './migrations';
import type {QualificationUpgradeConfiguration} from './qualification-schema-upgrade';
import {applyProductionClinicalCoreMigrations} from './production-migrations';
import {configuration,migrations,sha} from './__fixtures__/telehealth-consent-upgrade';
import {parseTelehealthConsentCopy,runTelehealthConsentCopyRegistration,type TelehealthConsentCopy,type TelehealthConsentCopyMode} from './telehealth-consent-copy-registration';
import {runCareConsentCopyRegistration} from './care-consent-copy-registration';

// Actual 112 SQL, roles, approval triggers and rollback. Every identity and
// review is fictional in memory; no hosted or concurrent-session evidence.
let pg:PGlite,m:ClinicalCoreMigration[],copy:TelehealthConsentCopy,staff:string;
type Intercept=(sql:string,tx:{query:(sql:string,args?:unknown[])=>Promise<unknown>})=>Promise<void>;
const db=(intercept?:Intercept,name='clinical_core_qualification'):ClinicalCoreDatabase=>({transaction:work=>pg.transaction(async tx=>work({
  query:async(sql:string,args:readonly unknown[]=[])=>{
    if(intercept)await intercept(sql,tx);
    if(sql==='select current_database() as name')return {rows:[{name}]};
    return tx.query(sql,args.map(v=>v&&typeof v==='object'&&'kind'in v&&v.kind==='uuid'&&'value'in v?v.value:v));
  },
} as ClinicalCoreTransaction))});
const run=(mode:TelehealthConsentCopyMode='register',database=db(),value:unknown=copy)=>
  runTelehealthConsentCopyRegistration(database,m,configuration,mode,mode==='inventory'?undefined:value);
const count=async()=>(await pg.query<{n:number}>('select count(*)::int n from clinical_core.care_consent_texts where artifact_id=$1',[copy.artifactId])).rows[0].n;
async function approved(change:{id?:string;version?:string;text?:string;scope?:string;status?:string;time?:string}={}){
  await pg.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,
    status,approved_at,approved_by_person_id) values($1,$2,$3,$4,$5,'TEST',$6,
    case when $6='draft' then null else clock_timestamp()+($7::interval) end,case when $6='draft' then null else $8::uuid end)`,
    [change.id??copy.artifactId,copy.organizationId,change.scope??copy.scope,change.version??copy.artifactVersion,
      sha(change.text??copy.content),change.status??'approved',change.time??'-1 second',staff]);
}
beforeAll(async()=>{
  m=migrations();pg=new PGlite({extensions:{pgcrypto}});
  await applyProductionClinicalCoreMigrations(db(),m.slice(0,106));
  for(const r of m.slice(106)){await pg.exec(r.sql);await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[r.version,r.name,r.sha256]);}
},90000);
beforeEach(async()=>{
  staff=randomUUID();const text='FICTIONAL TEST ONLY — exact recording consent.\nNot a production approval.';
  copy={contract:'telehealth-consent-copy/112',artifactId:randomUUID(),organizationId:randomUUID(),scope:'telehealth_recording',
    artifactVersion:'FICTIONAL/1',content:text,contentSha256:sha(text)};
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')",[copy.organizationId]);
  await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[staff,'subject_'+staff.replaceAll('-','')]);
  await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)",[staff,'fixture-'+staff]);
  await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[copy.organizationId,staff]);
});
afterAll(async()=>{await pg?.close();});
describe('distinct telehealth-only approved-copy source registrar',()=>{
  it('preserves exact text and only normalizes UUID spelling',()=>{
    expect(parseTelehealthConsentCopy({...copy,artifactId:copy.artifactId.toUpperCase(),organizationId:copy.organizationId.toUpperCase()})).toEqual(copy);
  });
  it.each(['','  ','\0','\ud800','😀'.repeat(4001)])('rejects invalid or oversized exact-copy text',content=>{
    expect(()=>parseTelehealthConsentCopy({...copy,content,contentSha256:sha(content)})).toThrow('copy_invalid');
  });
  it.each([{approved:true},{phiAllowed:true},{scope:'messaging'},{contract:'care-consent-copy/1'},{contentSha256:'f'.repeat(64)},
    {scope:'lab_results_import'}])('refuses broadened or unapproved input %j',delta=>{
    expect(()=>parseTelehealthConsentCopy({...copy,...delta})).toThrow('copy_invalid');
  });
  it('refuses trimmed and newline-normalized replacements',()=>{
    for(const content of [' '+copy.content,copy.content.replace('\n','\r\n')])expect(()=>parseTelehealthConsentCopy({...copy,content})).toThrow('copy_invalid');
  });
  it('keeps the historical registrar closed to the new scope and exact 112 artifact',async()=>{
    await expect(runCareConsentCopyRegistration(db(),m,configuration,'inventory')).rejects.toThrow('artifact_refused');
  });
  it('refuses unsafe configuration and source before opening a transaction',async()=>{
    let entered=0;const never:ClinicalCoreDatabase={transaction:async()=>{entered++;throw Error('must not enter');}};
    for(const delta of [{phiAllowed:true},{activation:'approved'},{expectedAccountId:'173535830222'},{region:'us-east-1'},
      {qualificationDatabaseName:'clinical_core'}])await expect(runTelehealthConsentCopyRegistration(never,m,
        {...configuration,...delta} as QualificationUpgradeConfiguration,'register',copy)).rejects.toThrow('boundary_refused');
    for(const bad of [m.slice(0,111),m.map((r,i)=>i===0?{...r,name:'forged'}:r),m.map((r,i)=>i===111?{...r,sql:r.sql+'\nselect 1;'}:r)])
      await expect(runTelehealthConsentCopyRegistration(never,bad,configuration,'register',copy)).rejects.toThrow('artifact_refused');
    expect(entered).toBe(0);
  });
  it('inventory and inspection remain read-only and never insert',async()=>{
    await approved();const sql:string[]=[];const database=db(async q=>{sql.push(q);});
    expect(await run('inventory',database)).toMatchObject({migrationCount:112,copyPresent:null,scope:'telehealth_recording',approvalsCreated:false,grantsCreated:false});
    expect(await run('inspect',database)).toMatchObject({copyPresent:false,copyInserted:false});
    expect(sql[0]).toContain('read only');expect(sql.some(q=>/^(insert|update|delete|create|alter|grant|revoke|lock table)/i.test(q))).toBe(false);
    expect(await count()).toBe(0);
  });
  it.each(['missing','draft','retired','future','hash','scope','version','clinic'])('refuses missing or mismatched approval: %s',async mode=>{
    if(mode!=='missing')await approved(mode==='draft'||mode==='retired'?{status:mode}:mode==='future'?{time:'1 day'}:
      mode==='hash'?{text:copy.content+' changed'}:mode==='scope'?{scope:'messaging'}:{});
    const value=mode==='version'?{...copy,artifactVersion:'wrong'}:mode==='clinic'?{...copy,organizationId:randomUUID()}:copy;
    await expect(run('register',db(),value)).rejects.toThrow('approval_required');expect(await count()).toBe(0);
  });
  it.each([
    "update clinical_core.identities set status='disabled' where person_id=$1",
    "update clinical_core.identities set identity_pool='consumer' where person_id=$1",
    "update clinical_core.persons set status='disabled' where id=$1",
    "update clinical_core.organization_memberships set status='suspended' where person_id=$1",
    "update clinical_core.organization_memberships set role='staff' where person_id=$1",
  ])('refuses lost workforce reviewer authority',async sql=>{
    await approved();await pg.query(sql,[staff]);await expect(run()).rejects.toThrow('approval_required');expect(await count()).toBe(0);
  });
  it('refuses a suspended clinic and never falls back to a superseded copy',async()=>{
    await approved();await pg.query("update clinical_core.organizations set status='suspended' where id=$1",[copy.organizationId]);
    await expect(run()).rejects.toThrow('approval_required');
    await pg.query("update clinical_core.organizations set status='active' where id=$1",[copy.organizationId]);
    await approved({id:randomUUID(),version:'FICTIONAL/2',time:'0 seconds'});
    await expect(run()).rejects.toThrow('approval_required');expect(await count()).toBe(0);
  });
  it.each([
    "delete from clinical_core.schema_migrations where version='20261010100000'",
    "update clinical_core.schema_migrations set name='forged' where version='20261010100000'",
    'alter table clinical_core.care_consent_texts disable row level security',
    'alter table clinical_core.care_consent_texts no force row level security',
    'alter table clinical_core.care_consent_texts disable trigger care_consent_texts_immutable',
    'grant select on clinical_core.care_consent_texts to clinical_core_api',
    'grant execute on function clinical_core.production_telehealth_consent_request(jsonb) to public',
    "create or replace function clinical_private.block_update_delete() returns trigger language plpgsql as $$ begin return new; end $$",
  ])('refuses a changed target before copy insertion',async change=>{
    await approved();let changed=false;
    const database=db(async(sql,tx)=>{if(!changed&&sql==='select current_database() as name'){changed=true;await tx.query(change);}});
    await expect(run('register',database)).rejects.toThrow();expect(await count()).toBe(0);
  });
  it('refuses the staging database and denied shared lock before insertion',async()=>{
    await approved();await expect(run('register',db(undefined,'clinical_core'))).rejects.toThrow('boundary_refused');
    const refused:ClinicalCoreDatabase={transaction:work=>pg.transaction(async tx=>work({query:async(sql,args=[])=>
      sql.startsWith('select pg_try_advisory_xact_lock')?{rows:[{acquired:false}]}:tx.query(sql,[...args])} as ClinicalCoreTransaction))};
    await expect(run('register',refused)).rejects.toThrow('target_refused');expect(await count()).toBe(0);
  });
  it('actually rolls back, registers one immutable copy and inspects replay without approvals or grants',async()=>{
    await approved();const before=(await pg.query(`select (select count(*) from clinical_core.identities)::int identities,
      (select count(*) from clinical_core.consent_artifacts)::int artifacts,(select count(*) from clinical_core.consent_grants)::int grants`)).rows;
    expect(await run('rehearse')).toMatchObject({copyInserted:false,copyPresent:false,rolledBack:true});expect(await count()).toBe(0);
    expect(await run()).toMatchObject({copyInserted:true,copyPresent:true,rolledBack:false,approvalsCreated:false,grantsCreated:false});
    expect(await run('inspect')).toMatchObject({copyInserted:false,copyPresent:true});
    expect(await run()).toMatchObject({copyInserted:false,copyPresent:true});expect(await count()).toBe(1);
    expect((await pg.query(`select (select count(*) from clinical_core.identities)::int identities,
      (select count(*) from clinical_core.consent_artifacts)::int artifacts,(select count(*) from clinical_core.consent_grants)::int grants`)).rows).toEqual(before);
    await expect(pg.query('update clinical_core.care_consent_texts set content=content where artifact_id=$1',[copy.artifactId])).rejects.toThrow();
    await expect(pg.query('delete from clinical_core.care_consent_texts where artifact_id=$1',[copy.artifactId])).rejects.toThrow();
  });
  it('does not retry or certify a lost commit reply; exact read-only inspection finds the written copy',async()=>{
    await approved();let writes=0;
    const lost:ClinicalCoreDatabase={transaction:async work=>{writes++;await db().transaction(work);throw Error('FICTIONAL unknown commit outcome');}};
    await expect(run('register',lost)).rejects.toThrow('operation_failed');expect(writes).toBe(1);expect(await count()).toBe(1);
    expect(await run('inspect')).toMatchObject({copyPresent:true,copyInserted:false});
  });
  it('registered copy reaches the actual restricted consumer consent port without granting consent, and cross-owner access is denied',async()=>{
    await approved();await run();
    const owner=randomUUID(),other=randomUUID(),patient=randomUUID(),connection=randomUUID();
    for(const actor of [owner,other]){
      await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[actor,'subject_'+actor.replaceAll('-','')]);
      await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)",[actor,'fixture-'+actor]);
    }
    await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')",
      [patient,copy.organizationId,'patient_'+patient.replaceAll('-','')]);
    await pg.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",
      [connection,copy.organizationId,patient,owner]);
    const read=(actor:string)=>pg.transaction(async tx=>{
      await tx.exec('set local role clinical_core_api');
      await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
        [actor,copy.organizationId,'consumer','fixture-'+actor,'consent_management','production-clinical','clinical_phi']);
      return tx.query<{data:{status:string;artifact:{artifactId:string;content:string;contentSha256:string}}}>(
        'select clinical_core.production_telehealth_consent_request($1::jsonb) data',
        [JSON.stringify({action:'consent',connectionId:connection,scope:'telehealth_recording'})]);
    });
    expect((await read(owner)).rows[0].data).toMatchObject({status:'not_granted',
      artifact:{artifactId:copy.artifactId,content:copy.content,contentSha256:copy.contentSha256}});
    await expect(read(other)).rejects.toThrow();
    expect((await pg.query<{n:number}>('select count(*)::int n from clinical_core.consent_grants where connection_id=$1',[connection])).rows[0].n).toBe(0);
  });
  it('a failed insert result rolls back without a copy or success receipt',async()=>{
    await approved();const database=db(async sql=>{if(sql.startsWith('insert into clinical_core.care_consent_texts'))throw Error('FICTIONAL transport error');});
    await expect(run('register',database)).rejects.toThrow('operation_failed');expect(await count()).toBe(0);
  });
});
