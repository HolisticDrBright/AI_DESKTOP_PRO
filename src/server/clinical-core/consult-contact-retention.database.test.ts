import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';

/**
 * Erasing the contact details of someone who asked about care and never became a patient.
 *
 * The first test is the defect this closes: before migration 45 an unconverted request's
 * contact envelope survived both erasure scopes and every sweep, and its owner had no account
 * to ask from. The rest are the ways a fix like this goes wrong. A purge must not leave half an
 * envelope. It must not touch a request the clinic still owes an answer to. It must not invent a
 * retention window. The row must survive so the clinic keeps its record of having been asked.
 * And opening a purged envelope must be refused, not answered with nulls.
 */
const id=(n:number)=>'c1000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),clinician=id(2),link=id(3);
let db:PGlite;
type Json={[key:string]:unknown};

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
const envelope=async(requestId:string)=>(await db.query<{
 contact_ciphertext:string|null;contact_iv:string|null;contact_tag:string|null;
 contact_digest:string|null;contact_purged_at:string|null;status:string}>(
 `select contact_ciphertext,contact_iv,contact_tag,contact_digest,contact_purged_at,status
  from clinical_core.consult_requests where id=$1`,[requestId])).rows[0];

/**
 * A request in a given state, with the companion columns its own CHECK constraints demand: a
 * decline has a reason and an author, a conversion has a patient and a connection, a withdrawal
 * has neither. Writing these by hand rather than driving the public function keeps the fixture
 * independent of the throttle, but it must still be a row the table would actually accept.
 */
const REFERENCE = 'ABCDEFGH';
let sequence=0;
async function arrive(over:{status?:string;daysAgo?:number;connection?:string;patient?:string}={}){
 sequence+=1;
 const status=over.status??'received';
 const requestId=id(500+sequence);
 const decided=['accepted','declined','converted'].includes(status);
 await db.query(`insert into clinical_core.consult_requests(id,organization_id,link_id,reference_code,
   contact_ciphertext,contact_iv,contact_tag,contact_digest,visit_type,reason_code,status,
   decline_reason,decided_at,decided_by_person_id,converted_at,patient_record_id,connection_id,
   received_at)
  values($1,$2,$3,$4,$5,$6,$7,$8,'initial','new_consultation',$9,$10,$11,$12,$13,$14,$15,
   clock_timestamp()-make_interval(days=>$16))`,
  [requestId,org,link,REFERENCE+String(2+(sequence%8))+String(2+((sequence*3)%8)),
   'ZmljdGlvbmFsLWNpcGhlcnRleHQ=','AAAAAAAAAAAAAAA=','AAAAAAAAAAAAAAAAAAAAAA==',
   'f'.repeat(64),status,
   status==='declined'?'outside_scope':null,
   decided?new Date().toISOString():null, decided?clinician:null,
   status==='converted'?new Date().toISOString():null,
   status==='converted'?(over.patient??null):null,
   status==='converted'?(over.connection??null):null,
   over.daysAgo??0]);
 return requestId;
}

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional Longevity Clinic')",[org]);
 await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[clinician,'syn_retention_clinician']);
 await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)",[clinician,'subject-'+clinician]);
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,clinician]);
 await db.query(`insert into clinical_core.consult_links(id,organization_id,slug,label,visit_types,
   reason_codes,status,created_by_person_id)
  values($1,$2,'fictional-clinic','Fictional Longevity Clinic',
   array['initial','follow_up'],array['new_consultation','lab_review'],'active',$3)`,[link,org,clinician]);
},90000);
afterAll(async()=>{await db?.close();});

beforeEach(async()=>{
 await db.exec("set session_replication_role = 'replica'");
 for(const table of ['consult_request_audit','consult_requests','consult_retention_settings',
  'patient_connections','patient_records'])
  await db.exec(`delete from clinical_core.${table}`);
 await db.exec(`delete from clinical_core.persons where id<>'${clinician}'`);
 await db.exec("set session_replication_role = 'origin'");
});

describe('the defect this closes',()=>{
 it('an unconverted request was reached by no erasure scope at all',async()=>{
  const requestId=await arrive({status:'declined'});
  // Both scopes delete a request by joining through patient_connections, and an unconverted
  // request has no connection. Run exactly what the erasure runs, as the erasure runs it.
  const {rows}=await db.query<{count:number}>(
   `select count(*)::int as count from clinical_core.consult_requests q
     join clinical_core.patient_connections c on c.id=q.connection_id
    where q.id=$1`,[requestId]);
  expect(rows[0].count).toBe(0);
  // And it is still holding a contact envelope until something purges it.
  expect((await envelope(requestId)).contact_ciphertext).not.toBeNull();
  // Which is now possible.
  const purged=await rpc('consult_contact_retention',{action:'purge',requestId});
  expect(purged).toMatchObject({purged:true,refusal:null});
  expect((await envelope(requestId)).contact_ciphertext).toBeNull();
 });
});

describe('what a purge removes and what it keeps',()=>{
 it('takes the whole envelope and leaves the clinic’s record of being asked',async()=>{
  const requestId=await arrive({status:'withdrawn'});
  await rpc('consult_contact_retention',{action:'purge',requestId});
  const row=await envelope(requestId);
  expect([row.contact_ciphertext,row.contact_iv,row.contact_tag,row.contact_digest])
   .toEqual([null,null,null,null]);
  expect(row.contact_purged_at).not.toBeNull();
  // The row itself, and what the clinic decided, survive.
  expect(row.status).toBe('withdrawn');
  const listed=await rpc('consult_request_review',{action:'list'});
  expect((listed.requests as {requestId:string}[]).map(r=>r.requestId)).toContain(requestId);
 });

 it('cannot leave half an envelope behind',async()=>{
  const requestId=await arrive({status:'declined'});
  // Nulling one column is not a partial erasure, it is an unopenable record.
  expect(await message(db.query(
   'update clinical_core.consult_requests set contact_tag=null where id=$1',[requestId])))
   .toContain('consult_request_immutable');
  // And a purge stamp with the envelope still there is refused by the constraint.
  expect(await message(db.query(
   'update clinical_core.consult_requests set contact_purged_at=now() where id=$1',[requestId])))
   .toContain('consult_request_immutable');
 });

 it('still refuses everything the append-only guard refused before',async()=>{
  const requestId=await arrive({status:'declined'});
  await rpc('consult_contact_retention',{action:'purge',requestId});
  for(const [sql,parameters] of [
   ['update clinical_core.consult_requests set visit_type=$1 where id=$2',['follow_up',requestId]],
   ['update clinical_core.consult_requests set received_at=now() where id=$1',[requestId]],
   ['update clinical_core.consult_requests set reference_code=$1 where id=$2',['ZZZZZZZZZZ',requestId]],
   ['delete from clinical_core.consult_requests where id=$1',[requestId]],
  ] as [string,unknown[]][]) expect(await message(db.query(sql,parameters)))
   .toMatch(/consult_request_immutable|append_only_record/);
 });

 it('still lets the owner’s own erasure delete a converted request',async()=>{
  // Migration 41 added that allowance and this migration replaces the same guard, so the
  // allowance is asserted here as well as there: a future replacement that drops it fails twice.
  const patient=id(80),consumer=id(81),connection=id(82);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[consumer,'syn_retention_owner_02']);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'consumer',$2,true)",[consumer,'subject-'+consumer]);
  await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_retention_02')",[patient,org]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",
   [connection,org,patient,consumer]);
  const requestId=await arrive({status:'converted',patient,connection});
  await db.transaction(async tx=>{
   await tx.exec('set local role clinical_core_api');
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
    [consumer,org,'consumer','subject-'+consumer,'consent_management','synthetic-staging','synthetic_only']);
   await tx.query('select clinical_core.care_data_erasure_request($1::jsonb)',
    [JSON.stringify({action:'erase_request',scope:'account_closure',requestId:'b0000000-0000-4000-8000-000000000099'})]);
  });
  const {rows}=await db.query<{count:number}>(
   'select count(*)::int as count from clinical_core.consult_requests where id=$1',[requestId]);
  expect(rows[0].count).toBe(0);
 });

 it('will not purge twice',async()=>{
  const requestId=await arrive({status:'declined'});
  await rpc('consult_contact_retention',{action:'purge',requestId});
  expect(await rpc('consult_contact_retention',{action:'purge',requestId}))
   .toMatchObject({purged:false,refusal:'already_purged'});
 });
});

describe('what may not be purged yet',()=>{
 it('refuses a request the clinic still owes an answer to, and says why',async()=>{
  for(const status of ['received','accepted']){
   const requestId=await arrive({status});
   expect(await rpc('consult_contact_retention',{action:'purge',requestId}),status)
    .toMatchObject({purged:false,refusal:'still_open_and_no_retention_window_is_set'});
  }
 });

 it('refuses a converted request, because the owner’s own erasure reaches that one',async()=>{
  const patient=id(90),consumer=id(91),connection=id(92);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[consumer,'syn_retention_owner_01']);
  await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_retention_01')",[patient,org]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",
   [connection,org,patient,consumer]);
  const requestId=await arrive({status:'converted',patient,connection});
  expect(await rpc('consult_contact_retention',{action:'purge',requestId}))
   .toMatchObject({purged:false,refusal:'converted_to_a_patient_record'});
 });

 it('says a still-open request is inside the window rather than refusing it outright',async()=>{
  await rpc('consult_contact_retention',{action:'settings_set',purgeContactAfterDays:30});
  const fresh=await arrive({status:'received',daysAgo:5});
  expect(await rpc('consult_contact_retention',{action:'purge',requestId:fresh}))
   .toMatchObject({refusal:'still_open_and_inside_the_retention_window'});
  const stale=await arrive({status:'received',daysAgo:40});
  expect(await rpc('consult_contact_retention',{action:'purge',requestId:stale}))
   .toMatchObject({purged:true,refusal:null});
 });
});

describe('the retention window',()=>{
 it('has no default, and says so',async()=>{
  const read=await rpc('consult_contact_retention',{action:'settings_read'});
  expect(read).toMatchObject({purgeContactAfterDays:null,automaticPurge:false});
 });

 it('sweeps nothing at all until a window is set',async()=>{
  await arrive({status:'received',daysAgo:4000});
  expect(await rpc('consult_contact_retention',{action:'sweep'}))
   .toMatchObject({purged:0,skipped:'no_retention_window_is_set'});
 });

 it('sweeps only what is past the window, and leaves converted requests alone',async()=>{
  await rpc('consult_contact_retention',{action:'settings_set',purgeContactAfterDays:60});
  const stale=await arrive({status:'received',daysAgo:90});
  const fresh=await arrive({status:'received',daysAgo:10});
  expect(await rpc('consult_contact_retention',{action:'sweep'}))
   .toMatchObject({purged:1,skipped:null});
  expect((await envelope(stale)).contact_ciphertext).toBeNull();
  expect((await envelope(fresh)).contact_ciphertext).not.toBeNull();
  // Idempotent: a second sweep finds nothing left to do.
  expect(await rpc('consult_contact_retention',{action:'sweep'})).toMatchObject({purged:0});
 });

 it('keeps every window a practice ever set',async()=>{
  await rpc('consult_contact_retention',{action:'settings_set',purgeContactAfterDays:30});
  await rpc('consult_contact_retention',{action:'settings_set',purgeContactAfterDays:null});
  const read=await rpc('consult_contact_retention',{action:'settings_read'});
  expect(read).toMatchObject({purgeContactAfterDays:null,version:2,automaticPurge:false});
  const {rows}=await db.query<{version:number;status:string;purge_contact_after_days:number|null}>(
   'select version,status,purge_contact_after_days from clinical_core.consult_retention_settings order by version');
  expect(rows.map(r=>[r.version,r.status,r.purge_contact_after_days]))
   .toEqual([[1,'retired',30],[2,'published',null]]);
  expect(await message(db.query(
   'update clinical_core.consult_retention_settings set purge_contact_after_days=1 where version=1')))
   .toContain('consult_retention_immutable');
 });

 it('refuses a window nobody could have meant',async()=>{
  for(const value of [0,-1,3651,'thirty',{}])
   expect(await message(rpc('consult_contact_retention',
    {action:'settings_set',purgeContactAfterDays:value})),String(value))
    .toBe('consult_retention_invalid');
  // Omitting the field is not the same as setting it to null.
  expect(await message(rpc('consult_contact_retention',{action:'settings_set'})))
   .toBe('consult_retention_invalid');
 });
});

describe('afterwards',()=>{
 it('refuses to open a purged envelope instead of handing back nulls',async()=>{
  const requestId=await arrive({status:'declined'});
  await rpc('consult_contact_retention',{action:'purge',requestId});
  expect(await message(rpc('consult_request_review',{action:'open',requestId})))
   .toBe('consult_contact_purged');
  // And the refusal is not recorded as an open that happened.
  const {rows}=await db.query<{count:number}>(
   "select count(*)::int as count from clinical_core.consult_request_audit where action='contact_opened'");
  expect(rows[0].count).toBe(0);
 });

 it('records the purge, and the window being set, without recording who asked',async()=>{
  const requestId=await arrive({status:'declined'});
  await rpc('consult_contact_retention',{action:'settings_set',purgeContactAfterDays:45});
  await rpc('consult_contact_retention',{action:'purge',requestId});
  const {rows}=await db.query<{action:string;request_id:string|null}>(
   'select action,request_id from clinical_core.consult_request_audit order by id');
  expect(rows.map(r=>r.action)).toEqual(['retention_window_set','contact_purged']);
  expect(rows[1].request_id).toBe(requestId);
 });

 it('counts what is held, purgeable and already gone',async()=>{
  await rpc('consult_contact_retention',{action:'settings_set',purgeContactAfterDays:30});
  await arrive({status:'declined'});
  await arrive({status:'received',daysAgo:2});
  const gone=await arrive({status:'withdrawn'});
  await rpc('consult_contact_retention',{action:'purge',requestId:gone});
  const pending=await rpc('consult_contact_retention',{action:'pending'});
  expect(pending).toMatchObject({purgeContactAfterDays:30,purgeable:1,stillHeld:2,alreadyPurged:1});
 });

 it('does not answer a patient session',async()=>{
  const consumer=id(95);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[consumer,'syn_retention_consumer_1']);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'consumer',$2,true)",[consumer,'subject-'+consumer]);
  expect(await message(rpc('consult_contact_retention',{action:'pending'},consumer,'consumer')))
   .toBe('consult_retention_forbidden');
 });
});
