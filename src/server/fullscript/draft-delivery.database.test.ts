import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import type {ClinicalCoreDatabase} from '../clinical-core/database';
import type {FullscriptSupplementDraftInput} from './protocol-draft';
import {FullscriptApiClient,readFullscriptConfiguration} from './client';
import {FULLSCRIPT_DRAFT_SCOPES} from './draft-scopes';
import {createFullscriptDraftProvider} from './draft-provider';
import {createDraftDeliveryService,type DraftDeliveryBinding,type DraftDeliveryActor,type DraftDeliveryAuthority,
 type FullscriptDraftObservation} from './draft-delivery';
const id=(n:number)=>'e0000000-0000-4000-8000-'+String(n).padStart(12,'0');
const actor:DraftDeliveryActor={organizationId:id(1),personId:id(2),identitySubject:'fictional-practitioner',
 identityPool:'workforce',environment:'synthetic-staging',phiAllowed:false};
const owner:DraftDeliveryActor={...actor,personId:id(3),identitySubject:'fictional-consumer',identityPool:'consumer'};
const binding=():DraftDeliveryBinding=>({organizationId:id(1),consumerPersonId:id(3),patientRecordId:id(4),connectionId:id(5),
 practitionerPersonId:id(2),manifestId:id(6),authoritySha256:'b'.repeat(64),intentSha256:'a'.repeat(64),excludedCount:2,
 input:{fullscriptPatientId:id(7),practitionerId:id(8),idempotencyKey:'alp-cart-'+'a'.repeat(64),
 recommendations:[{variantId:id(9),unitsToPurchase:'2',instructions:'Original fictional directions'},
 {variantId:id(10),unitsToPurchase:'1',instructions:'Different fictional directions'}]}});
const observation=():FullscriptDraftObservation=>({contract:'fullscript-draft-observation/1',planId:id(11),patientId:id(7),
 practitionerId:id(8),state:'draft',metadataId:binding().input.idempotencyKey,labs:[],recommendations:binding().input.recommendations});
const selector={manifestId:id(6),patientRecordId:id(4)};
let db:PGlite,database:ClinicalCoreDatabase;
const provider={create:vi.fn(async(_input:FullscriptSupplementDraftInput)=>observation() as unknown),findByMetadata:vi.fn(async()=>[observation()] as unknown[])};
// Fictional authority, deliberately not a production adapter: permissions and
// current/revoked state are actually read through the ledger's transaction.
const authority:DraftDeliveryAuthority={
 resolve:async()=>binding(),
 assertAccess:async(tx,a,b)=>{
  const result=await tx.query('select actor_active from fixture_authority');
  if(a.organizationId!==b.organizationId||!(a.personId===b.consumerPersonId&&a.identityPool==='consumer'
   ||a.personId===b.practitionerPersonId&&a.identityPool==='workforce'&&result.rows[0].actor_active))throw new Error('refused');
 },
 assertCurrent:async(tx,b)=>{
  const result=await tx.query('select active,connection_id from fixture_authority');
  if(!result.rows[0].active||result.rows[0].connection_id!==b.connectionId)throw new Error('refused');
 },
};
const service=()=>createDraftDeliveryService(database,authority,provider);
const prepare=()=>service().prepare(actor,selector);
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(readFileSync('infra/aws-clinical-core/source-candidates/fullscript-draft-ledger.sql','utf8'));
 await db.exec(`create table fixture_authority(active boolean,actor_active boolean,connection_id uuid);
  insert into fixture_authority values(true,true,'${id(5)}')`);
 database={transaction:work=>db.transaction(tx=>work({query:async<Row extends Record<string,unknown>>(sql:string,parameters?:readonly unknown[])=>{
  const result=await tx.query<Row>(sql,parameters?[...parameters]:[]);
  return {rows:result.rows};
 }}))};
 provider.create.mockReset();provider.create.mockImplementation(async()=>observation());
 provider.findByMetadata.mockReset();provider.findByMetadata.mockImplementation(async()=>[observation()]);
});
afterEach(async()=>{await db.close();});

describe('unreleased Fullscript durable ledger with actual SQL and fictional authority/provider',()=>{
 it.each(['reply','lost-reply'])('settles the documented HTTP %s through the real ledger, never a second POST',async mode=>{
  const input=binding().input;
  const raw={treatment_plan:{id:id(11),patient:{id:input.fullscriptPatientId},practitioner:{id:input.practitionerId},
   state:'draft',available_at:null,metadata:{id:input.idempotencyKey},lab_recommendations:[],resources:[],
   recommendations:input.recommendations.map(r=>({variant_id:r.variantId,units_to_purchase:Number(r.unitsToPurchase),
    refill:false,dosage:{additional_info:r.instructions}}))}};
  const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
   if(init?.method==='POST'){
    expect((await db.query('select state,input from fullscript_delivery.draft_intents')).rows[0])
     .toMatchObject({state:'dispatching',input});
    if(mode==='lost-reply')throw Error('fictional lost reply');
   }
   const body=new URL(String(url)).pathname.endsWith('/metadata')?{
    metadata:[{id:input.idempotencyKey,type:'treatment_plan',data:{id:id(11)}}],
    meta:{current_page:1,next_page:null,prev_page:null,total_pages:1,total_count:1},
   }:raw;
   return new Response(JSON.stringify(body),{status:init?.method==='POST'?201:200,headers:{'content-type':'application/json'}});
  });
  const configuration=readFullscriptConfiguration({NODE_ENV:'test',FULLSCRIPT_ENVIRONMENT:'sandbox_us',
   FULLSCRIPT_CLIENT_ID:'fictional-client-id-1234567890',FULLSCRIPT_CLIENT_SECRET:'fictional-client-secret-1234567890',
   FULLSCRIPT_REDIRECT_URI:'https://desktop.example.test/api/live/fullscript/oauth/callback',
   FULLSCRIPT_OAUTH_STATE_SECRET:'fictional-state-secret-longer-than-thirty-two'});
  const adapter=createFullscriptDraftProvider(new FullscriptApiClient(configuration,'fictional-access-token-abcdefghijklmnopqrstuvwxyz',fetcher,FULLSCRIPT_DRAFT_SCOPES));
  const connected=createDraftDeliveryService(database,authority,adapter),prepared=await connected.prepare(actor,selector);
  expect((await connected.send(actor,prepared.id)).state).toBe(mode==='reply'?'verified':'uncertain');
  await connected.send(actor,prepared.id);
  if(mode==='lost-reply')expect((await connected.reconcile(actor,prepared.id)).state).toBe('verified');
  expect(await connected.read(owner,prepared.id)).toMatchObject({state:'verified',providerPlanId:id(11),writerPending:false});
  expect(fetcher.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
  expect(fetcher.mock.calls.filter(c=>c[1]?.method==='GET')).toHaveLength(mode==='reply'?0:2);
 });
 it('persists the exact recipient intent before I/O, replays preparation, and sends once across two service instances',async()=>{
  const a=await prepare(),b=await prepare();expect(b.id).toBe(a.id);
  provider.create.mockImplementation(async input=>{
   const rows=await db.query<Record<string,unknown>>('select state,input,writer_id from fullscript_delivery.draft_intents');
   expect(rows.rows).toHaveLength(1);expect(rows.rows[0]).toMatchObject({state:'dispatching',input});
   expect(rows.rows[0].writer_id).toBeTruthy();return observation();
  });
  const results=await Promise.all([service().send(actor,a.id),service().send(actor,a.id)]);
  expect(results.some(r=>r.state==='verified')).toBe(true);expect(provider.create).toHaveBeenCalledOnce();
  expect(await service().read(owner,a.id)).toMatchObject({state:'verified',providerPlanId:id(11),includedCount:2,
   excludedCount:2,writerPending:false,patientSent:false,phiAllowed:false});
 });
 it('refuses injected bindings, consumer sends, wrong clinic and wrong owner without a provider call',async()=>{
  const p=await prepare();
  for(const a of [owner,{...actor,organizationId:id(20)},{...actor,personId:id(21)}, {...actor,phiAllowed:true},
   {...actor,environment:'production-clinical'}])expect(await service().send(a,p.id).catch(e=>e.message)).toBe('fullscript_delivery_refused');
  await expect(service().prepare(actor,{...selector,input:binding().input})).rejects.toThrow('fullscript_delivery_refused');
  await expect(service().read({...owner,personId:id(20)},p.id)).rejects.toThrow('fullscript_delivery_refused');
  expect(provider.create).not.toHaveBeenCalled();
 });
 it('does not contact the provider if persistence fails',async()=>{
  const broken:ClinicalCoreDatabase={transaction:async()=>{throw new Error('database credentials and query text');}};
  await expect(createDraftDeliveryService(broken,authority,provider).send(actor,id(30))).rejects.toThrow('fullscript_delivery_refused');
  expect(provider.create).not.toHaveBeenCalled();
 });
 it('withholds a prepared request when a consent/release/connection is no longer current',async()=>{
  const p=await prepare();await db.exec('update fixture_authority set active=false');
  expect(await service().send(actor,p.id)).toMatchObject({state:'withheld',providerPlanId:null});
  expect(provider.create).not.toHaveBeenCalled();
 });
 it('cancellation before admission prevents all future POSTs and is idempotent',async()=>{
  const p=await prepare();expect((await service().cancel(owner,p.id)).state).toBe('cancelled');
  expect((await service().cancel(owner,p.id)).state).toBe('cancelled');
  expect((await service().send(actor,p.id)).state).toBe('cancelled');expect(provider.create).not.toHaveBeenCalled();
 });
 it.each(['cancel','connection','actor'] as const)('withholds a late receipt after %s, retaining external identity without showing delivery',async reason=>{
  const p=await prepare(),started=deferred<void>(),reply=deferred<unknown>();
  provider.create.mockImplementation(async()=>{started.resolve();return reply.promise;});
  const sending=service().send(actor,p.id);await started.promise;
  if(reason==='cancel')await service().cancel(owner,p.id);
  if(reason==='connection')await db.query('update fixture_authority set connection_id=$1::uuid',[id(99)]);
  if(reason==='actor')await db.exec('update fixture_authority set actor_active=false');
  reply.resolve(observation());expect(await sending).toMatchObject({state:'withheld',providerPlanId:null,writerPending:false});
  const row=(await db.query<Record<string,unknown>>('select provider_plan_id,receipt_sha256,writer_settled from fullscript_delivery.draft_intents')).rows[0];
  expect(row).toMatchObject({provider_plan_id:id(11),writer_settled:true});expect(row.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it('does not retry an unknown POST, uses read-only recovery, and preserves the original idempotency key',async()=>{
  const p=await prepare();provider.create.mockRejectedValue(new Error('token health-payload internal-provider-error'));
  expect((await service().send(actor,p.id)).state).toBe('uncertain');
  expect((await service().send(actor,p.id)).state).toBe('uncertain');expect(provider.create).toHaveBeenCalledOnce();
  expect(await service().reconcile(actor,p.id)).toMatchObject({state:'verified',providerPlanId:id(11)});
  expect(provider.findByMetadata).toHaveBeenCalledWith(binding().input.idempotencyKey);
 });
 it.each(['empty','multiple','mismatch'])('refuses %s recovery evidence without retrying or certifying absence',async kind=>{
  const p=await prepare();provider.create.mockRejectedValue(new Error('unknown'));await service().send(actor,p.id);
  provider.findByMetadata.mockResolvedValue(kind==='empty'?[]:kind==='multiple'?[observation(),observation()]:[{...observation(),patientId:id(77)}]);
  await expect(service().reconcile(actor,p.id)).rejects.toThrow('fullscript_delivery_refused');
  expect((await service().read(owner,p.id)).state).toBe('uncertain');expect(provider.create).toHaveBeenCalledOnce();
 });
 it('a live admitted writer is not replaced or reconciled by a second caller',async()=>{
  const p=await prepare(),started=deferred<void>(),reply=deferred<unknown>();
  provider.create.mockImplementation(async()=>{started.resolve();return reply.promise;});
  const sending=service().send(actor,p.id);await started.promise;
  expect((await service().reconcile(actor,p.id)).state).toBe('dispatching');expect(provider.findByMetadata).not.toHaveBeenCalled();
  expect((await service().send(actor,p.id)).state).toBe('dispatching');expect(provider.create).toHaveBeenCalledOnce();
  reply.resolve(observation());await sending;
 });
 it('an expired writer never permits another POST; reconciliation keeps the live writer pending until its actual completion',async()=>{
  const p=await prepare(),started=deferred<void>(),reply=deferred<unknown>();
  provider.create.mockImplementation(async()=>{started.resolve();await reply.promise;throw new Error('late lost reply');});
  const sending=service().send(actor,p.id);await started.promise;
  // Real PostgreSQL clock expiry, not an edited deadline or mocked store.
  await new Promise(resolve=>setTimeout(resolve,31_000));
  expect((await service().send(actor,p.id)).state).toBe('dispatching');
  expect(await service().reconcile(actor,p.id)).toMatchObject({state:'verified',providerPlanId:id(11),writerPending:true});
  expect(provider.create).toHaveBeenCalledOnce();
  reply.resolve(null);expect(await sending).toMatchObject({state:'verified',providerPlanId:id(11),writerPending:false});
 },45_000);
 it('a lost receipt commit reply recovers the saved receipt rather than regenerating a provider draft',async()=>{
  const p=await prepare();let count=0;
  const replyLost:ClinicalCoreDatabase={transaction:async work=>{
   const result=await database.transaction(work);if(++count===2)throw new Error('settlement commit reply lost');return result;
  }};
  await expect(createDraftDeliveryService(replyLost,authority,provider).send(actor,p.id)).rejects.toThrow('fullscript_delivery_refused');
  expect((await service().read(owner,p.id)).state).toBe('verified');
  expect((await service().send(actor,p.id)).state).toBe('verified');expect(provider.create).toHaveBeenCalledOnce();
 });
 it('rechecks current authority even after verification instead of leaking a stale provider receipt',async()=>{
  const p=await prepare();await service().send(actor,p.id);await db.exec('update fixture_authority set active=false');
  expect(await service().read(owner,p.id)).toMatchObject({state:'withheld',providerPlanId:null});
  await db.exec('update fixture_authority set active=true');expect((await service().read(owner,p.id)).state).toBe('withheld');
 });
 it('withholds a previously verified receipt when the admitting practitioner loses access',async()=>{
  const p=await prepare();await service().send(actor,p.id);await db.exec('update fixture_authority set actor_active=false');
  expect(await service().read(owner,p.id)).toMatchObject({state:'withheld',providerPlanId:null});
 });
 it('does not POST after a lost admission commit reply, even though the admission was persisted',async()=>{
  const p=await prepare();
  const replyLost:ClinicalCoreDatabase={transaction:async work=>{await database.transaction(work);throw new Error('commit reply lost');}};
  await expect(createDraftDeliveryService(replyLost,authority,provider).send(actor,p.id)).rejects.toThrow('fullscript_delivery_refused');
  expect((await service().read(owner,p.id)).state).toBe('dispatching');
  expect((await service().send(actor,p.id)).state).toBe('dispatching');expect(provider.create).not.toHaveBeenCalled();
 });
 it('a rebound authority cannot silently reuse the same idempotency intent for a different local patient',async()=>{
  await prepare();
  const rebound={...authority,resolve:async()=>({...binding(),consumerPersonId:id(80)})};
  await expect(createDraftDeliveryService(database,rebound,provider).prepare(actor,selector)).rejects.toThrow('fullscript_delivery_refused');
  expect((await db.query('select id from fullscript_delivery.draft_intents')).rows).toHaveLength(1);
 });
 it.each(['patient','practitioner','metadata','state','recommendation','units','instructions','duplicate','labs','unknown'])('does not certify a %s mismatch as a receipt',async kind=>{
  const p=await prepare(),o=observation() as unknown as Record<string,unknown>;
  const rows=observation().recommendations;
  if(kind==='patient')o.patientId=id(40);if(kind==='practitioner')o.practitionerId=id(40);
  if(kind==='metadata')o.metadataId='alp-cart-'+'d'.repeat(64);if(kind==='state')o.state='active';
  if(kind==='recommendation')o.recommendations=rows.slice(1);
  if(kind==='units')o.recommendations=[{...rows[0],unitsToPurchase:'3'},rows[1]];
  if(kind==='instructions')o.recommendations=[{...rows[0],instructions:'Changed dose'},rows[1]];
  if(kind==='duplicate')o.recommendations=[rows[0],rows[0]];
  if(kind==='labs')o.labs=[{id:id(40)}];if(kind==='unknown')o.checkoutUrl='https://unverified.example.test';
  provider.create.mockResolvedValue(o);expect(await service().send(actor,p.id)).toMatchObject({state:'uncertain',providerPlanId:null});
 });
 it('accepts a reordered but identical recommendation set, never a changed one',async()=>{
  const p=await prepare();provider.create.mockResolvedValue({...observation(),recommendations:observation().recommendations.reverse()});
  expect((await service().send(actor,p.id)).state).toBe('verified');
 });
 it('ledger SQL refuses immutable-intent, writer replacement, reopening, direct API reads and deletes',async()=>{
  await db.exec('create role clinical_core_api nologin');const p=await prepare();await service().send(actor,p.id);
  for(const sql of ["update fullscript_delivery.draft_intents set input='{}'::jsonb",
   `update fullscript_delivery.draft_intents set writer_id='${id(40)}'`,
   "update fullscript_delivery.draft_intents set state='prepared'",'delete from fullscript_delivery.draft_intents'])
   await expect(db.exec(sql)).rejects.toThrow();
  await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.exec('select * from fullscript_delivery.draft_intents');})).rejects.toThrow('permission denied');
 });
 it('even the internal writer role cannot insert a pre-verified receipt or delete a saved intent',async()=>{
  await prepare();
  await expect(db.transaction(async tx=>{
   await tx.exec('set local role fullscript_draft_worker');
   await tx.exec(`insert into fullscript_delivery.draft_intents(id,organization_id,consumer_person_id,patient_record_id,
    connection_id,practitioner_person_id,manifest_id,authority_sha256,intent_sha256,input,excluded_count,state,
    writer_id,writer_actor,writer_deadline,writer_settled,provider_plan_id,receipt_sha256)
    select '${id(90)}'::uuid,organization_id,consumer_person_id,patient_record_id,connection_id,practitioner_person_id,
    manifest_id,authority_sha256,repeat('d',64),input,excluded_count,'verified','${id(91)}'::uuid,
    '{}'::jsonb,clock_timestamp(),true,'${id(92)}',repeat('e',64) from fullscript_delivery.draft_intents`);
  })).rejects.toThrow('fullscript_initial_state_refused');
  await expect(db.transaction(async tx=>{
   await tx.exec('set local role fullscript_draft_worker');await tx.exec('delete from fullscript_delivery.draft_intents');
  })).rejects.toThrow('permission denied');
 });
});
