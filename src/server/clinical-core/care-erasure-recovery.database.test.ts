import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {createCareErasureRecovery} from './care-erasure-recovery';
import {createCareDataLifecycle} from './care-data-lifecycle';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {SyntheticRequestContext} from './aws-identity-consent';
import {parseCareErasureRecoveryResponse} from '../../contracts/careErasureRecovery';

const id=(n:number)=>'60000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),owner=id(2),other=id(3),clinician=id(4),patient=id(5),connection=id(6),thread=id(7);
let db:PGlite;
const context=(actor=owner,pool:'consumer'|'workforce'='consumer'):SyntheticRequestContext=>({
 actorPersonId:actor,organizationId:org,identityPool:pool,identitySubject:'subject-'+actor,
 purpose:'consent_management',environment:'synthetic-staging',dataClassification:'synthetic_only',
 containsPhi:false,realPatientData:false});
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role clinical_core_api');
 return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
  try{return await tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p));}
  catch(cause){
   const message=cause instanceof Error?cause.message:String(cause);
   throw new ClinicalCoreDatabaseRejection(/care_data_invalid|care_erasure_intent_required/.test(message)?'request_invalid'
    :/care_data_conflict/.test(message)?'conflict'
    :/care_data_forbidden|request_context_refused|synthetic_context_refused/.test(message)?'identity_refused':'operation_refused');
  }
 }});
})};
const recovery=(body:unknown,actor=owner)=>createCareErasureRecovery(database)(context(actor),body);
const prepare=(requestId=id(100),scope:'domain'|'account_closure'='domain',actor=owner)=>recovery({action:'prepare_erasure',requestId,scope},actor);
const discover=(limit=50,after?:string,actor=owner)=>recovery({action:'discover_erasure_requests',limit,...(after?{after}:{})},actor);
const terminal=(action:'erase_request'|'erase_receipt'|'settle_erasure',requestId=id(100),scope:'domain'|'account_closure'='domain',actor=owner)=>
 createCareDataLifecycle(database)(context(actor),{action,requestId,scope});
const messages=async()=>Number((await db.query<{n:string}>('select count(*)::text n from clinical_core.care_messages')).rows[0]!.n);

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 // The registered terminal migration is included exactly once above.
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional recovery clinic')",[org]);
 for(const [person,pool] of [[owner,'consumer'],[other,'consumer'],[clinician,'workforce']]){
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[person,'syn_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)',[person,pool,'subject-'+person]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,clinician]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_erasure_recovery')",[patient,org]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",[connection,org,patient,owner]);
},60000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
 // Harness reset only. Every assertion uses live immutable triggers and the API role.
 await db.exec(`set session_replication_role='replica';
  delete from clinical_core.care_data_erasure_intents; delete from clinical_core.care_data_erasure_requests;
  delete from clinical_core.care_data_erasures; delete from clinical_core.care_message_audit;
  delete from clinical_core.care_messages; delete from clinical_core.care_message_threads;
  set session_replication_role='origin';`);
 await db.query("insert into clinical_core.care_message_threads(id,connection_id,subject) values($1,$2,'Fictional recovery subject')",[thread,connection]);
 await db.query("insert into clinical_core.care_messages(thread_id,sender_id,sender_pool,request_id,request_hash,acknowledgement,body) values($1,$2,'consumer',$3,'fictional-hash','care-messages/1','Fictional recoverable message')",[thread,owner,id(8)]);
});

describe('canonical synthetic history: durable owner erasure intents',()=>{
 it('registers without deleting, and idempotently returns the same immutable intent',async()=>{
  const first=await prepare();expect(first).toMatchObject({action:'prepare_erasure',requestId:id(100),scope:'domain',outcome:'prepared',receipt:null});
  const original=(await discover());expect(await prepare()).toEqual(first);expect(await discover()).toEqual(original);
  expect(await messages()).toBe(1);
  await expect(prepare(id(100),'account_closure')).rejects.toMatchObject({category:'conflict'});
 });
 it('refuses an unregistered destructive request without changing any data',async()=>{
  await expect(terminal('erase_request')).rejects.toMatchObject({category:'request_invalid'});
  expect(await messages()).toBe(1);expect((await discover())).toMatchObject({items:[],legacyUncorrelatedErasureCount:0});
 });
 it('discovers a lost preparation reply on a new service instance, without reissuing deletion',async()=>{
  await prepare();
  const secondDevice=await createCareErasureRecovery(database)(context(),{action:'discover_erasure_requests'});
  expect(secondDevice).toMatchObject({items:[{requestId:id(100),outcome:'prepared',intentRegistered:true,completedAt:null}],coverage:'committed_owner_records_not_global_clearance'});
  expect(await messages()).toBe(1);
 });
 it('preserves the exact erased receipt and does not erase again on replay or discovery',async()=>{
  await prepare();const receipt=await terminal('erase_request');expect(receipt).toMatchObject({outcome:'erased',receipt:{messagesErased:1}});
  expect(await terminal('erase_request')).toEqual(receipt);expect(await terminal('settle_erasure')).toMatchObject({outcome:'erased'});
  expect(await prepare()).toMatchObject({outcome:'erased'});
  const found=await discover();expect(found).toMatchObject({items:[{outcome:'erased',intentRegistered:true,receipt:receipt.action==='erase_request'?receipt.receipt:undefined}]});
  expect(await messages()).toBe(0);
  expect((await db.query<{n:string}>('select count(*)::text n from clinical_core.care_data_erasures')).rows[0]!.n).toBe('1');
 });
 it('fences a prepared request before dispatch and refuses late destructive arrival',async()=>{
  await prepare();await terminal('settle_erasure');
  expect(await terminal('erase_request')).toMatchObject({outcome:'cancelled',receipt:null});
  expect(await prepare()).toMatchObject({outcome:'cancelled',receipt:null});expect(await messages()).toBe(1);
  expect(await discover()).toMatchObject({items:[{outcome:'cancelled',intentRegistered:true}]});
 });
 it('allows exact cancellation before registration and never changes it back to prepared',async()=>{
  await terminal('settle_erasure');expect(await prepare()).toMatchObject({outcome:'cancelled'});
  expect(await terminal('erase_request')).toMatchObject({outcome:'cancelled'});
  expect(await discover()).toMatchObject({items:[{outcome:'cancelled',intentRegistered:false,registeredAt:null}]});
  expect(await messages()).toBe(1);
 });
 it('keeps historical terminal UUIDs discoverable, without fabricating an intent',async()=>{
  // Simulate a predecessor admission before the guarded candidate existed.
  await db.transaction(async tx=>{
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[owner,org,'consumer','subject-'+owner,'consent_management','synthetic-staging','synthetic_only']);
   await tx.query('select clinical_core.care_data_erasure_request_v1_terminal($1::jsonb)',[JSON.stringify({action:'erase_request',requestId:id(100),scope:'domain'})]);
  });
  expect(await discover()).toMatchObject({items:[{outcome:'erased',intentRegistered:false}],legacyUncorrelatedErasureCount:0});
  expect(await terminal('erase_request')).toMatchObject({outcome:'erased'});
 });
 it('reports uncorrelated legacy erasures rather than matching them by timing or count',async()=>{
  await db.query("insert into clinical_core.care_data_erasures(owner_id,scope,messages_erased,threads_erased,threads_retained,settlements_erased,settlements_retained,assignments_erased,late_admission_refusable) values($1,'domain',0,0,0,0,0,0,true)",[owner]);
  expect(await discover()).toMatchObject({items:[],legacyUncorrelatedErasureCount:1,coverage:'committed_owner_records_not_global_clearance'});
  expect(await discover(50,undefined,other)).toMatchObject({items:[],legacyUncorrelatedErasureCount:0});
 });
 it('pages mixed prepared and terminal records without duplicates or omissions',async()=>{
  await prepare(id(100));await terminal('settle_erasure',id(100));
  await terminal('settle_erasure',id(101));await prepare(id(102));
  const all:string[]=[];let after:string|undefined;
  for(let i=0;i<3;i++){
   const page=await discover(1,after);if(page.action!=='discover_erasure_requests')throw new Error('wrong response');
   all.push(...page.items.map(x=>x.requestId));expect(page.next).toBe(i<2?page.items[0]!.requestId:null);after=page.next??undefined;
  }
  expect(all).toEqual([id(100),id(101),id(102)]);expect(new Set(all).size).toBe(3);
 });
 it('isolates known UUIDs across owners, even when both independently register the same UUID',async()=>{
  await prepare();expect(await discover(50,undefined,other)).toMatchObject({items:[]});
  expect(await terminal('erase_receipt',id(100),'domain',other)).toMatchObject({outcome:'unresolved'});
  await expect(terminal('erase_request',id(100),'domain',other)).rejects.toMatchObject({category:'request_invalid'});
  await prepare(id(100),'account_closure',other);expect(await discover(50,undefined,other)).toMatchObject({items:[{scope:'account_closure',outcome:'prepared'}]});
  expect(await discover()).toMatchObject({items:[{scope:'domain',outcome:'prepared'}]});
 });
 it('rejects workforce, wrong subject, production, and body-supplied ownership',async()=>{
  const run=createCareErasureRecovery(database);const body={action:'prepare_erasure',requestId:id(100),scope:'domain'};
  for(const ctx of [context(clinician,'workforce'),{...context(),identitySubject:'wrong-subject'},
   {...context(),environment:'production',dataClassification:'real_patient_data'}]){
   await expect(run(ctx as SyntheticRequestContext,body)).rejects.toMatchObject({category:'identity_refused'});
  }
  await expect(recovery({...body,ownerId:other})).rejects.toMatchObject({category:'request_invalid'});
  expect(await messages()).toBe(1);
 });
 it('refuses raw table and predecessor/helper authority for the API role',async()=>{
  for(const sql of ['select * from clinical_core.care_data_erasure_intents',
   'select clinical_private.care_erasure_locked_owner()',
   "select clinical_core.care_data_erasure_request_v1_terminal('{}'::jsonb)"]){
   await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');return tx.query(sql);})).rejects.toThrow(/permission denied/);
  }
 });
 it('makes intents immutable even for the owner-definer test connection',async()=>{
  await prepare();
  await expect(db.query('update clinical_core.care_data_erasure_intents set scope=$1 where owner_id=$2',['account_closure',owner])).rejects.toThrow();
  await expect(db.query('delete from clinical_core.care_data_erasure_intents where owner_id=$1',[owner])).rejects.toThrow();
  expect(await discover()).toMatchObject({items:[{scope:'domain'}]});
 });
 it('rolls back erased data if terminal receipt recording fails',async()=>{
  await prepare();
  await db.exec("create function public.recovery_test_fail() returns trigger language plpgsql as $$begin raise exception 'fictional receipt failure'; end$$; create trigger recovery_test_fail before insert on clinical_core.care_data_erasure_requests for each row execute function public.recovery_test_fail();");
  try{await expect(terminal('erase_request')).rejects.toBeTruthy();expect(await messages()).toBe(1);expect(await discover()).toMatchObject({items:[{outcome:'prepared'}]});}
  finally{await db.exec('drop trigger recovery_test_fail on clinical_core.care_data_erasure_requests; drop function public.recovery_test_fail();');}
 });
 it('refuses malformed paging directly in SQL as well as at the service contract',async()=>{
  for(const input of [{action:'discover_erasure_requests',limit:0},{action:'discover_erasure_requests',limit:101},
   {action:'discover_erasure_requests',limit:'2'},{action:'discover_erasure_requests',limit:null},
   {action:'discover_erasure_requests',after:'bad'},[],null]){
   await expect(db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[owner,org,'consumer','subject-'+owner,'consent_management','synthetic-staging','synthetic_only']);
    return tx.query('select clinical_core.care_data_discover_erasures($1::jsonb)',[JSON.stringify(input)]);
   })).rejects.toThrow(/care_data_invalid/);
  }
 });
 it('does not mistake missing or contradictory discovery fields for clearance',async()=>{
  await prepare();const page=await discover();if(page.action!=='discover_erasure_requests')throw new Error('wrong response');
  const parse=(value:unknown)=>parseCareErasureRecoveryResponse({action:'discover_erasure_requests'},value);
  for(const changed of [{...page,coverage:'account_clear'}, {...page,items:[{...page.items[0],intentRegistered:false}]},
   {...page,items:[{...page.items[0],completedAt:new Date().toISOString()}]},
   {...page,items:[page.items[0],page.items[0]]},{...page,next:id(100)},
  {...page,items:[{...page.items[0],outcome:'erased',receipt:null}]}])expect(()=>parse(changed)).toThrow();
 });
 it('rejects contradictory recovered receipt counts, reasons, and scope semantics',async()=>{
  await prepare();await terminal('erase_request');const page=await discover();
  if(page.action!=='discover_erasure_requests'||!page.items[0]?.receipt)throw new Error('missing test receipt');
  const entry=page.items[0],receipt=entry.receipt!;
  for(const delta of [{settlementsRetained:1,retainedReason:null},{threadsRetained:1,threadsRetainedReason:null},
   {packetsRetained:1,packetsRetainedReason:null},{signaturesRetained:1,signaturesRetainedReason:null},
   {disputesRetained:1,disputesRetainedReason:null},{packetsErased:1},{signaturesErased:1},
   {disputesErased:1},{consultRequestsErased:1}]){
   expect(()=>parseCareErasureRecoveryResponse({action:'discover_erasure_requests'},
    {...page,items:[{...entry,receipt:{...receipt,...delta}}]})).toThrow();
  }
 });
 it('refuses inactive identities at the database boundary',async()=>{
  await db.query("update clinical_core.identities set status='disabled' where person_id=$1",[owner]);
  try{await expect(prepare()).rejects.toMatchObject({category:'identity_refused'});expect(await messages()).toBe(1);}
  finally{await db.query("update clinical_core.identities set status='active' where person_id=$1",[owner]);}
 });
 it('records the exact synthetic-only canonical successor without production transformation',()=>{
  const manifest=readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8');
  expect(JSON.parse(manifest).migrations).toHaveLength(47);
  expect(JSON.parse(manifest).migrations.at(-1)).toEqual({version:'20261007010000',
   file:'20261007010000_synthetic_care_erasure_intents.sql',production_transform:false});
  expect(readFileSync('infra/aws-clinical-core/migrations/20261007010000_synthetic_care_erasure_intents.sql','utf8').replace(/\r\n?/g,'\n'))
   .toBe(readFileSync('infra/aws-clinical-core/source-candidates/care-erasure-intents.sql','utf8').replace(/\r\n?/g,'\n'));
  const handler=readFileSync('src/server/clinical-core/aws-identity-api.ts','utf8');
  expect(handler).toContain('createCareErasureRecovery');
  expect(handler).toContain("body.action==='prepare_erasure'||body.action==='discover_erasure_requests'");
 });
 it('refuses another UUID while an admitted owner intent is unresolved, then allows it after exact cancellation',async()=>{
  await prepare(id(100));await expect(prepare(id(101))).rejects.toMatchObject({category:'conflict'});
  expect(await messages()).toBe(1);await terminal('settle_erasure',id(100));
  expect(await prepare(id(101))).toMatchObject({outcome:'prepared'});
 });
});
