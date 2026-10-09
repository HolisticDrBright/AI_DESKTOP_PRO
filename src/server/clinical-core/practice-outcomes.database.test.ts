import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';

/**
 * What happened in this practice, reported only in aggregate.
 *
 * The assertions that carry weight are about what cannot be learned from it. A cell below eleven
 * must not be reported. One suppressed cell beside a total is not suppressed at all, so a second
 * cell and the total must both go. An exact age must never be stored. A code nobody declared must
 * be refused rather than kept as free text under a coded name. And revoking the research consent,
 * or asking for an erasure, must actually remove what was contributed.
 */
const id=(n:number)=>'d1000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),clinician=id(2);
let db:PGlite;
type Json={[key:string]:unknown};
type Group={outcome:string;treatment:string|null;ageBand:string|null;count:number};

async function rpc(fn:string,request:unknown,actor=clinician,pool:'workforce'|'consumer'='workforce'){
 return db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
   [actor,org,pool,'subject-'+actor,'clinical_data','synthetic-staging','synthetic_only']);
  const {rows}=await tx.query<{data:Json}>(`select clinical_core.${fn}($1::jsonb) as data`,
   [JSON.stringify(request)]);
  return rows[0].data;
 });
}
const message=async(work:Promise<unknown>)=>{
 try{await work;return 'resolved';}catch(cause){return cause instanceof Error?cause.message:String(cause);}
};

/** A patient with the research consent granted, ready to be counted. */
async function person(n:number,granted=true){
 const patient=id(100+n),connection=id(200+n),consumer=id(300+n);
 await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[consumer,'syn_outcome_person_'+String(n).padStart(4,'0')]);
 await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'consumer',$2,true)",[consumer,'subject-outcome-'+n]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,$3)",[patient,org,'patient_syn_outcome_'+String(n).padStart(4,'0')]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",
  [connection,org,patient,consumer]);
 if(granted)await grant(connection,1);
 return {connection,consumer,patient};
}
/** A consent grant written the way the identity domain writes one. */
async function grant(connection:string,version:number){
 const artifact=id(400+version*100+Number(connection.slice(-3)));
 await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
  values($1,$2,'research_practice_outcomes',$3,$4,'US-CO','approved',now(),$5)`,
  [artifact,org,'v'+version+'-'+connection.slice(-4),'a'.repeat(64),clinician]);
 await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id)
  select $1,c.patient_record_id,c.id,$2,'research_practice_outcomes','granted','in_person','self',$3,$4
  from clinical_core.patient_connections c where c.id=$5`,[org,artifact,version,clinician,connection]);
}
async function revoke(connection:string,version:number){
 await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,representative_authority,reason_code,version,recorded_by_person_id)
  select $1,c.patient_record_id,c.id,'research_practice_outcomes','revoked','in_person','self','patient_request',$2,$3
  from clinical_core.patient_connections c where c.id=$4`,[org,version,clinician,connection]);
}
const contribute=(connection:string,over:Record<string,unknown>={})=>rpc('outcome_ledger_workforce',
 {action:'contribute',connectionId:connection,ageYears:47,sex:'female',
  conditionCodes:['hypothyroid'],treatmentCode:'thyroid_support',outcomeCode:'improved',
  followupBand:'3_to_6_months',...over});

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional Longevity Clinic')",[org]);
 await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[clinician,'syn_outcome_clinician']);
 await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)",[clinician,'subject-'+clinician]);
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,clinician]);
},90000);
afterAll(async()=>{await db?.close();});

beforeEach(async()=>{
 await db.exec("set session_replication_role = 'replica'");
 for(const table of ['outcome_observations','outcome_vocabulary','consent_grants','consent_artifacts',
  'care_data_erasures','patient_connections','patient_records','identities'])
  await db.exec(`delete from clinical_core.${table}`);
 await db.exec(`delete from clinical_core.persons where id<>'${clinician}'`);
 await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)",[clinician,'subject-'+clinician]);
 await db.exec("set session_replication_role = 'origin'");
 await rpc('outcome_ledger_workforce',{action:'declare_code',kind:'condition',code:'hypothyroid',label:'Hypothyroidism'});
 await rpc('outcome_ledger_workforce',{action:'declare_code',kind:'treatment',code:'thyroid_support',label:'Fictional thyroid support'});
});

describe('what is stored',()=>{
 it('bands the age and never keeps the exact one',async()=>{
  const {connection}=await person(1);
  const stored=await contribute(connection,{ageYears:47});
  expect(stored.ageBand).toBe('45_49');
  expect(stored.stored).toEqual({exactAgeKept:false,freeTextKept:false,dateKept:false});
  const {rows}=await db.query<{age_band:string}>('select age_band from clinical_core.outcome_observations');
  expect(rows[0].age_band).toBe('45_49');
  // Nothing anywhere in the row holds 47.
  const {rows:columns}=await db.query<{column_name:string}>(
   `select column_name from information_schema.columns
    where table_schema='clinical_core' and table_name='outcome_observations'`);
  expect(columns.map(c=>c.column_name)).not.toContain('age_years');
 });

 it('collapses everyone over 89 into one band and refuses a minor',async()=>{
  const {connection}=await person(2);
  for(const years of [90,97,118])
   expect((await contribute(connection,{ageYears:years})).ageBand).toBe('90_plus');
  expect(await message(contribute(connection,{ageYears:17}))).toBe('outcome_age_out_of_range');
  expect(await message(contribute(connection,{ageYears:131}))).toBe('outcome_age_out_of_range');
 });

 it('refuses a code nobody declared, rather than keeping it as free text',async()=>{
  const {connection}=await person(3);
  // A sentence squeezed into code shape is still refused — not because it looks like prose, but
  // because nobody declared it. That is the check that holds whatever someone tries to write.
  expect(await message(contribute(connection,{conditionCodes:['a_43_year_old_teacher_from_denver']})))
   .toBe('outcome_code_absent');
  // Shape is not what saves this. Nothing was declared under that name, so it is refused, and
  // that holds for every string anyone could try.
  expect(await message(contribute(connection,{conditionCodes:['Hypothyroid, 43yo teacher']})))
   .toBe('outcome_code_absent');
  expect(await message(contribute(connection,{conditionCodes:['undeclared_condition']})))
   .toBe('outcome_code_absent');
  expect(await message(contribute(connection,{treatmentCode:'undeclared_treatment'})))
   .toBe('outcome_code_absent');
 });

 it('refuses to count anyone who has not consented to this specifically',async()=>{
  const {connection}=await person(4,false);
  expect(await message(contribute(connection))).toBe('outcome_consent_absent');
 });

 it('does not let the API role read the rows at all',async()=>{
  const {connection}=await person(5);
  await contribute(connection);
  const denied=await message(db.transaction(async tx=>{
   await tx.exec('set local role clinical_core_api');
   return tx.query('select * from clinical_core.outcome_observations');
  }));
  expect(denied).toContain('permission denied');
 });
});

describe('what a report may say',()=>{
 /** n people, all counted the same way, so a cohort can be put either side of the threshold. */
 async function cohort(count:number,over:Record<string,unknown>={},offset=10){
  for(let index=0;index<count;index+=1){
   const {connection}=await person(offset+index);
   await contribute(connection,over);
  }
 }

 it('suppresses a cohort below eleven entirely',async()=>{
  await cohort(9);
  const report=await rpc('outcome_report',{action:'report',groupBy:['treatment']});
  expect(report.groups).toEqual([]);
  expect(report.suppressedGroups).toBe(1);
  expect(report.total).toBeNull();
  expect(report.minimumCohort).toBe(11);
 });

 it('reports a cohort of eleven and gives a total when nothing was suppressed',async()=>{
  await cohort(11);
  const report=await rpc('outcome_report',{action:'report',groupBy:['treatment']});
  expect((report.groups as Group[]).map(g=>[g.outcome,g.treatment,g.count]))
   .toEqual([['improved','thyroid_support',11]]);
  expect(report.total).toBe(11);
  expect(report.suppressedGroups).toBe(0);
 });

 it('takes a second cell when exactly one was suppressed, so the gap cannot be subtracted',async()=>{
  await cohort(14,{outcomeCode:'improved'},10);
  await cohort(12,{outcomeCode:'unchanged'},40);
  await cohort(4,{outcomeCode:'worse'},70);
  const report=await rpc('outcome_report',{action:'report',groupBy:['treatment']});
  // 'worse' is below the threshold; 'unchanged' is the smallest survivor and goes with it.
  expect((report.groups as Group[]).map(g=>g.outcome)).toEqual(['improved']);
  expect(report.suppressedGroups).toBe(2);
  expect(report.total).toBeNull();
 });

 it('always carries the statement that this is not evidence of efficacy',async()=>{
  await cohort(11);
  for(const groupBy of [[],['treatment'],['treatment','ageBand']]){
   const report=await rpc('outcome_report',{action:'report',groupBy});
   expect(report.interpretation).toBe('what_happened_in_this_practice_not_evidence_of_efficacy');
  }
 });

 it('refuses more than two extra dimensions, a repeated one, or an unknown one',async()=>{
  for(const groupBy of [['treatment','ageBand','sex'],['treatment','treatment'],['recordedAt'],['patientName']])
   expect(await message(rpc('outcome_report',{action:'report',groupBy})))
    .toBe('outcome_ledger_invalid');
 });

 it('has no way to group or filter by time',async()=>{
  await cohort(11);
  expect(await message(rpc('outcome_report',{action:'report',groupBy:['treatment'],since:'2026-01-01'})))
   .toBe('outcome_ledger_invalid');
 });
});

describe('taking a contribution back',()=>{
 it('deletes what was contributed when the consent is revoked',async()=>{
  const {connection}=await person(6);
  await contribute(connection);
  const before=await db.query<{count:number}>('select count(*)::int as count from clinical_core.outcome_observations');
  expect(before.rows[0].count).toBe(1);
  await revoke(connection,2);
  const after=await db.query<{count:number}>('select count(*)::int as count from clinical_core.outcome_observations');
  expect(after.rows[0].count).toBe(0);
  // And refuses to count them again while the revocation stands.
  expect(await message(contribute(connection))).toBe('outcome_consent_absent');
 });

 it('deletes what was contributed on either erasure scope',async()=>{
  for(const [index,scope] of (['domain','account_closure'] as const).entries()){
   const {connection,consumer}=await person(50+index);
   await contribute(connection);
   // The ledger row every erasure writes, with the counts an erasure of nothing would carry.
   await db.query(`insert into clinical_core.care_data_erasures(owner_id,scope,messages_erased,
    threads_erased,threads_retained,settlements_erased,settlements_retained,assignments_erased,
    late_admission_refusable) values($1,$2,0,0,0,0,0,0,$3)`,[consumer,scope,scope==='domain']);
   const {rows}=await db.query<{count:number}>(
    'select count(*)::int as count from clinical_core.outcome_observations where contributing_person_id=$1',[consumer]);
   expect(rows[0].count,scope).toBe(0);
  }
 });

 it('keeps a retired code on the rows already counted',async()=>{
  const {connection}=await person(7);
  await contribute(connection);
  await rpc('outcome_ledger_workforce',{action:'retire_code',kind:'treatment',code:'thyroid_support'});
  // No new contribution may cite it, and the counted row still carries it.
  expect(await message(contribute(connection))).toBe('outcome_code_absent');
  const {rows}=await db.query<{treatment_code:string}>('select treatment_code from clinical_core.outcome_observations');
  expect(rows[0].treatment_code).toBe('thyroid_support');
 });
});

describe('the consent scope list',()=>{
 it('still accepts every scope that existed before this migration',async()=>{
  const {connection}=await person(8,false);
  for(const scope of ['reproductive_health','lab_results_import','lab_specimen_context','research_n_of_1']){
   const result=await message(db.query(
    `insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,representative_authority,reason_code,version,recorded_by_person_id)
     select $1,c.patient_record_id,c.id,$2,'revoked','in_person','self','patient_request',1,$3
     from clinical_core.patient_connections c where c.id=$4`,[org,scope,clinician,connection]));
   expect(result,scope).toBe('resolved');
  }
 });
});
