import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {CARE_DATA_LIFECYCLE_ACK,type CareDataRequest} from '../../contracts/careDataLifecycle';
import {createCareDataLifecycle} from './care-data-lifecycle';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {SyntheticRequestContext} from './aws-identity-consent';

const id=(n:number)=>'50000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),owner=id(2),other=id(3),clinician=id(4);
const patient=id(5),connection=id(6),program=id(7),version=id(8);
let db:PGlite;

const context=(actor=owner,pool:'consumer'|'workforce'='consumer'):SyntheticRequestContext=>({
 actorPersonId:actor,organizationId:org,identityPool:pool,identitySubject:'subject-'+actor,
 purpose:'consent_management',environment:'synthetic-staging',dataClassification:'synthetic_only',
 containsPhi:false,realPatientData:false});
const INVALID=/\bcare_data_invalid\b/,FORBIDDEN=/\bcare_data_forbidden\b/;
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role clinical_core_api');
 return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
  try{return await tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p));}
  catch(cause){
   const message=cause instanceof Error?cause.message:String(cause);
   throw new ClinicalCoreDatabaseRejection(INVALID.test(message)?'request_invalid'
    :FORBIDDEN.test(message)?'identity_refused':'operation_refused');
  }
 }});
})};
const call=(input:CareDataRequest,actor=owner,pool:'consumer'|'workforce'='consumer')=>
 createCareDataLifecycle(database)(context(actor,pool),input);

const phases=[{id:'phase-1',title:'Phase one',days:1,transition:'scheduled',
 items:[{id:'lesson-a',title:'Fictional lesson',kind:'lesson',instructions:'Read it.',released:true}]},
 {id:'phase-2',title:'Phase two',days:1,transition:'scheduled',
 items:[{id:'lesson-b',title:'Fictional lesson two',kind:'lesson',instructions:'Read it.',released:true}]}];

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional A')",[org]);
 for(const [person,pool] of [[owner,'consumer'],[other,'consumer'],[clinician,'workforce']]){
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[person,'syn_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)',[person,pool,'subject-'+person]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,clinician]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_lifecycle_01')",[patient,org]);
 await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional program','published',$3)",[program,org,clinician]);
},60000);
afterAll(async()=>{await db?.close();});

/** A fresh account's worth of both domains, so each case starts from a known shape. */
async function seed(over:{linkState?:string;clinicReply?:boolean}={}){
 // These tables are append-only by trigger, which is the behaviour under test. Resetting
 // between cases is harness plumbing, so the triggers are stood down only for the reset
 // and are back in force for every assertion below.
 await db.exec(`set session_replication_role = 'replica';
  delete from clinical_core.care_data_erasures;
  delete from clinical_core.program_phase_authorizations; delete from clinical_core.program_assignment_completions;
  delete from clinical_core.program_assignment_audit; delete from clinical_core.program_assignments;
  delete from clinical_core.care_message_settlements; delete from clinical_core.care_message_audit;
  delete from clinical_core.care_messages; delete from clinical_core.care_message_threads;
  delete from clinical_core.synthetic_desktop_program_versions; delete from clinical_core.patient_connections;
  set session_replication_role = 'origin';`);
 await db.query(`insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at)
  values($1,$2,$3,$4,$5,now())`,[connection,org,patient,owner,over.linkState??'verified']);
 await db.query(`insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id)
  values($1,$2,$3,1,'published',$4::jsonb,$5)`,[version,org,program,
  JSON.stringify({consumerProgram:{title:'Fictional guide',phases}}),clinician]);
 const thread=id(20);
 await db.query("insert into clinical_core.care_message_threads(id,connection_id,subject) values($1,$2,'Fictional subject')",[thread,connection]);
 await db.query(`insert into clinical_core.care_messages(thread_id,sender_id,sender_pool,request_id,request_hash,acknowledgement,body)
  values($1,$2,'consumer',$3,'hash-1','care-messages/1','Fictional owner message'),
        ($1,$2,'consumer',$4,'hash-2','care-messages/1','Second fictional owner message')`,
  [thread,owner,id(30),id(31)]);
 if(over.clinicReply){
  await db.query(`insert into clinical_core.care_messages(thread_id,sender_id,sender_pool,request_id,request_hash,acknowledgement,body)
   values($1,$2,'workforce',$3,'hash-3','care-messages/1','Fictional clinic reply')`,[thread,clinician,id(32)]);
 }
 await db.query('insert into clinical_core.care_message_settlements(sender_id,request_id,connection_id,organization_id) values($1,$2,$3,$4)',[owner,id(33),connection,org]);
 const assignment=id(40);
 await db.query(`insert into clinical_core.program_assignments(id,organization_id,connection_id,consumer_person_id,program_version_id,
  assigned_by,title,content,source_digest,state,started_at,phase_started_at)
  values($1,$2,$3,$4,$5,$6,'Fictional guide',$7::jsonb,$8,'active',now(),now())`,
  [assignment,org,connection,owner,version,clinician,JSON.stringify(phases),'a'.repeat(64)]);
 await db.query("insert into clinical_core.program_assignment_completions(assignment_id,item_id) values($1,'lesson-a')",[assignment]);
 await db.query(`insert into clinical_core.program_phase_authorizations(assignment_id,phase_id,kind,recorded_by)
  values($1,'phase-1','consumer_check_in',$2)`,[assignment,owner]);
 return {thread,assignment};
}
beforeEach(async()=>{await seed();});

const exportAll=async(section:CareDataRequest extends never?never:'threads'|'messages'|'settlements'|'assignments'|'completions'|'authorizations',actor=owner)=>{
 const items:unknown[]=[];let after:string|undefined;
 for(let page=0;page<10;page+=1){
  const result=await call({action:'export',section,limit:100,...(after?{after}:{})},actor);
  if(result.action!=='export')throw new Error('unexpected');
  items.push(...result.items);
  if(!result.next)return items;
  after=result.next;
 }
 throw new Error('did not terminate');
};

describe('owner export for the messaging and program domains',()=>{
 it('declares its contract version',()=>{expect(CARE_DATA_LIFECYCLE_ACK).toBe('care-data-lifecycle/1');});

 it('returns the owner\'s own messages in full, because the bodies are theirs',async()=>{
  const messages=await exportAll('messages') as {body:string}[];
  expect(messages.map(entry=>entry.body).sort())
   .toEqual(['Fictional owner message','Second fictional owner message']);
 });

 it('covers every section the deferral named',async()=>{
  expect((await exportAll('threads')).length).toBe(1);
  expect((await exportAll('settlements')).length).toBe(1);
  expect((await exportAll('assignments')).length).toBe(1);
  expect((await exportAll('completions')).length).toBe(1);
  expect((await exportAll('authorizations')).length).toBe(1);
 });

 it('carries the program artifact and its phases, not a reference to them',async()=>{
  const [assignment]=await exportAll('assignments') as {phases:unknown[];sourceDigest:string;title:string}[];
  expect(assignment!.title).toBe('Fictional guide');
  expect(assignment!.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(assignment!.phases).toHaveLength(2);
 });

 it('never includes another account\'s records',async()=>{
  for(const section of ['threads','messages','settlements','assignments','completions','authorizations'] as const){
   expect(await exportAll(section,other),section).toEqual([]);
  }
 });

 it('pages without losing or repeating an entry',async()=>{
  const first=await call({action:'export',section:'messages',limit:1});
  if(first.action!=='export')throw new Error('unexpected');
  expect(first.items).toHaveLength(1);
  expect(first.next).toBeTruthy();
  const second=await call({action:'export',section:'messages',limit:1,after:first.next!});
  if(second.action!=='export')throw new Error('unexpected');
  expect(second.items).toHaveLength(1);
  expect(second.next).toBeNull();
  const bodies=[...first.items,...second.items].map(entry=>(entry as {body:string}).body);
  expect(new Set(bodies).size).toBe(2);
 });

 it('bounds the page and refuses an unknown section',async()=>{
  await expect(call({action:'export',section:'messages',limit:101})).rejects.toMatchObject({category:'request_invalid'});
  await expect(call({action:'export',section:'everything'} as never)).rejects.toMatchObject({category:'request_invalid'});
 });

 it('answers the same after the clinic link is revoked, because these are the owner\'s own records',async()=>{
  await seed({linkState:'verified'});
  const before=await exportAll('messages');
  await db.query("update clinical_core.patient_connections set state='revoked' where id=$1",[connection]);
  expect(await exportAll('messages')).toEqual(before);
  expect((await exportAll('assignments')).length).toBe(1);
 });

 it('refuses a workforce caller and a production-looking context',async()=>{
  await expect(call({action:'export',section:'messages'},clinician,'workforce')).rejects.toMatchObject({category:'identity_refused'});
  await expect(createCareDataLifecycle(database)(
   {...context(),environment:'production',dataClassification:'real_patient_data'} as never,
   {action:'export',section:'messages'})).rejects.toMatchObject({category:'identity_refused'});
 });
});

describe('owner erasure',()=>{
 it('erases the owner\'s messages and program records, and says what it did',async()=>{
  const result=await call({action:'erase',scope:'domain'});
  expect(result).toMatchObject({action:'erase',scope:'domain',messagesErased:2,assignmentsErased:1,
   threadsErased:1,threadsRetained:0,settlementsErased:0,settlementsRetained:1,lateAdmissionRefusable:true,
   retainedReason:'cancellation_refusal_must_outlive_late_admission'});
  expect(await exportAll('messages')).toEqual([]);
  expect(await exportAll('assignments')).toEqual([]);
  expect(await exportAll('completions')).toEqual([]);
  expect(await exportAll('authorizations')).toEqual([]);
 });

 it('keeps the cancellation tombstone, so a cancelled request stays refused',async()=>{
  await call({action:'erase',scope:'domain'});
  const settlements=await exportAll('settlements');
  expect(settlements).toHaveLength(1);
  // The refusal is still installed: a late send under that request id is still refused.
  await expect(db.query(`insert into clinical_core.care_messages(thread_id,sender_id,sender_pool,request_id,request_hash,acknowledgement,body)
   values((select id from clinical_core.care_message_threads limit 1),$1,'consumer',$2,'h','care-messages/1','late')`,
   [owner,id(33)])).rejects.toBeTruthy();
 });

 it('keeps a thread that still holds the clinic\'s messages, and names the reason',async()=>{
  await seed({clinicReply:true});
  const result=await call({action:'erase',scope:'domain'});
  expect(result).toMatchObject({threadsErased:0,threadsRetained:1,
   threadsRetainedReason:'thread_holds_another_participant_record'});
  // The owner's own messages are gone from it even so.
  expect(await exportAll('messages')).toEqual([]);
  const remaining=await db.query<{n:string}>('select count(*)::text as n from clinical_core.care_messages');
  expect(remaining.rows[0]!.n).toBe('1');
 });

 it('ends the refusal only on account closure, and says that it has',async()=>{
  const result=await call({action:'erase',scope:'account_closure'});
  expect(result).toMatchObject({scope:'account_closure',settlementsErased:1,settlementsRetained:0,
   lateAdmissionRefusable:false,retainedReason:null});
  expect(await exportAll('settlements')).toEqual([]);
 });

 it('is idempotent: a second erase changes nothing and reports zero',async()=>{
  await call({action:'erase',scope:'domain'});
  const again=await call({action:'erase',scope:'domain'});
  expect(again).toMatchObject({messagesErased:0,assignmentsErased:0,threadsErased:0,settlementsRetained:1});
 });

 it('touches no other account',async()=>{
  const otherThread=id(21);
  await db.query("insert into clinical_core.care_message_threads(id,connection_id,subject) values($1,$2,'Other subject')",[otherThread,connection]);
  await db.query(`insert into clinical_core.care_messages(thread_id,sender_id,sender_pool,request_id,request_hash,acknowledgement,body)
   values($1,$2,'consumer',$3,'h','care-messages/1','Another account message')`,[otherThread,other,id(34)]);
  await call({action:'erase',scope:'domain'});
  const left=await db.query<{body:string}>('select body from clinical_core.care_messages');
  expect(left.rows.map(row=>row.body)).toEqual(['Another account message']);
 });

 it('erases through a revoked link exactly as it would through a live one',async()=>{
  await db.query("update clinical_core.patient_connections set state='revoked' where id=$1",[connection]);
  const result=await call({action:'erase',scope:'domain'});
  expect(result).toMatchObject({messagesErased:2,assignmentsErased:1});
 });

 it('keeps the audit tables, which are content-free service records',async()=>{
  await db.query("insert into clinical_core.care_message_audit(actor_id,organization_id,action) values($1,$2,'send')",[owner,org]);
  await db.query("insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values($1,$2,'status')",[owner,org]);
  await call({action:'erase',scope:'account_closure'});
  for(const table of ['care_message_audit','program_assignment_audit']){
   const kept=await db.query<{n:string}>(`select count(*)::text as n from clinical_core.${table}`);
   expect(kept.rows[0]!.n,table).toBe('1');
  }
 });

 it('records the erasure as an append-only count, never as a copy of what was erased',async()=>{
  const result=await call({action:'erase',scope:'domain'});
  if(result.action!=='erase')throw new Error('unexpected');
  const history=await call({action:'erasure_history'});
  expect(history).toMatchObject({action:'erasure_history'});
  if(history.action!=='erasure_history')return;
  expect(history.erasures[0]).toMatchObject({erasureId:result.erasureId,scope:'domain',
   messagesErased:2,lateAdmissionRefusable:true});
  // Nothing in the record holds a body or a subject.
  expect(JSON.stringify(history.erasures)).not.toMatch(/Fictional/);
  await expect(db.query('update clinical_core.care_data_erasures set messages_erased=0 where id=$1',[result.erasureId]))
   .rejects.toMatchObject({message:expect.stringContaining('care_data_erasure_immutable')});
  await expect(db.query('delete from clinical_core.care_data_erasures where id=$1',[result.erasureId]))
   .rejects.toMatchObject({message:expect.stringContaining('care_data_erasure_immutable')});
 });

 it('refuses an unknown scope, a workforce caller and a direct table read',async()=>{
  await expect(call({action:'erase',scope:'everything'} as never)).rejects.toMatchObject({category:'request_invalid'});
  await expect(call({action:'erase',scope:'domain'},clinician,'workforce')).rejects.toMatchObject({category:'identity_refused'});
  await expect(db.transaction(async tx=>{
   await tx.exec('set local role clinical_core_api');
   await tx.query('select * from clinical_core.care_data_erasures limit 1');
  })).rejects.toBeTruthy();
 });
});

describe('the narrowed append-only refusal',()=>{
 it('still refuses a delete with no erasure running',async()=>{
  for(const table of ['care_messages','care_message_settlements']){
   await expect(db.query(`delete from clinical_core.${table}`),table)
    .rejects.toMatchObject({message:expect.stringContaining('append_only_record')});
  }
  await expect(db.query('delete from clinical_core.program_assignment_completions'))
   .rejects.toMatchObject({message:expect.stringContaining('append_only_record')});
  await expect(db.query('delete from clinical_core.program_phase_authorizations'))
   .rejects.toMatchObject({message:expect.stringContaining('append_only_record')});
 });

 it('refuses an update even while an erasure is running',async()=>{
  await expect(db.transaction(async tx=>{
   await tx.query("select set_config('clinical_private.care_erasure',$1,true)",[owner]);
   await tx.query("update clinical_core.care_messages set body='rewritten' where sender_id=$1",[owner]);
  })).rejects.toMatchObject({message:expect.stringContaining('append_only_record')});
 });

 it('refuses another owner\'s rows even with the window open',async()=>{
  const otherThread=id(22);
  await db.query("insert into clinical_core.care_message_threads(id,connection_id,subject) values($1,$2,'Other')",[otherThread,connection]);
  await db.query(`insert into clinical_core.care_messages(thread_id,sender_id,sender_pool,request_id,request_hash,acknowledgement,body)
   values($1,$2,'consumer',$3,'h','care-messages/1','Another account message')`,[otherThread,other,id(35)]);
  await expect(db.transaction(async tx=>{
   // The window names an owner, so holding it open for one account does not open the
   // other's rows. The API role has no table privilege here either way.
   await tx.query("select set_config('clinical_private.care_erasure',$1,true)",[owner]);
   await tx.query('delete from clinical_core.care_messages where sender_id=$1',[other]);
  })).rejects.toMatchObject({message:expect.stringContaining('append_only_record')});
 });

 it('closes the window before the erasure returns',async()=>{
  await db.transaction(async tx=>{
   await tx.exec('set local role clinical_core_api');
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
    [owner,org,'consumer','subject-'+owner,'consent_management','synthetic-staging','synthetic_only']);
   await tx.query('select clinical_core.care_data_erase($1::jsonb) as data',[JSON.stringify({action:'erase',scope:'domain'})]);
   const flag=await tx.query<{value:string}>("select coalesce(current_setting('clinical_private.care_erasure',true),'') as value");
   expect(flag.rows[0]!.value).toBe('');
  });
 });

 it('leaves the settlement insert refusal in force after the trigger was replaced',async()=>{
  // Migration 36 replaced the immutability trigger on care_messages. The separate
  // before-insert trigger that refuses a settled request id is a different trigger and
  // must still fire, or cancellation would have quietly stopped working.
  await expect(db.query(`insert into clinical_core.care_messages(thread_id,sender_id,sender_pool,request_id,request_hash,acknowledgement,body)
   values((select id from clinical_core.care_message_threads limit 1),$1,'consumer',$2,'h','care-messages/1','late')`,
   [owner,id(33)])).rejects.toMatchObject({message:expect.stringContaining('care_message_settled')});
 });
});
