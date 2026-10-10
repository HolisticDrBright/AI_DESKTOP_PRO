if (typeof window !== 'undefined') throw new Error('Fullscript delivery is server-only.');
import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ClinicalCoreDatabase, ClinicalCoreTransaction} from '../clinical-core/database';
import {fullscriptSupplementDraftInput, type FullscriptSupplementDraftInput} from './protocol-draft';

const uuid=z.string().uuid(), hash=z.string().regex(/^[a-f0-9]{64}$/).refine(v=>v!=='0'.repeat(64));
const providerId=z.string().regex(/^[A-Za-z0-9-]{8,128}$/);
const actorSchema=z.object({organizationId:uuid,personId:uuid,identitySubject:z.string().min(1).max(200),
 identityPool:z.enum(['workforce','consumer']),environment:z.literal('synthetic-staging'),phiAllowed:z.literal(false)}).strict();
export type DraftDeliveryActor=z.infer<typeof actorSchema>;
const selectorSchema=z.object({manifestId:uuid,patientRecordId:uuid}).strict();
export type DraftDeliverySelector=z.infer<typeof selectorSchema>;
const bindingSchema=z.object({organizationId:uuid,consumerPersonId:uuid,patientRecordId:uuid,connectionId:uuid,
 practitionerPersonId:uuid,manifestId:uuid,authoritySha256:hash,intentSha256:hash,
 input:fullscriptSupplementDraftInput,excludedCount:z.number().int().min(0).max(400)}).strict()
 .refine(v=>v.input.idempotencyKey==='alp-cart-'+v.intentSha256);
export type DraftDeliveryBinding=z.infer<typeof bindingSchema>;
type State='prepared'|'dispatching'|'uncertain'|'verified'|'cancelled'|'withheld';
const stateSchema=z.enum(['prepared','dispatching','uncertain','verified','cancelled','withheld']);
const eventIdSchema=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v=>BigInt(v)<=BigInt('9223372036854775807'));
const auditPageSchema=z.object({events:z.array(z.object({eventId:eventIdSchema,
 action:z.enum(['prepared','transition','custody','status_read','owner_export_read']),actorPersonId:uuid,
 actorPool:z.enum(['consumer','workforce']),actorSource:z.enum(['caller','admitted_writer']),
 previousState:stateSchema.nullable(),nextState:stateSchema,writerPending:z.boolean(),providerReceiptKnown:z.boolean(),
 happenedAt:z.string().min(1).max(80)}).strict()).max(100),nextBefore:eventIdSchema.nullable()}).strict()
 .refine(p=>p.events.every((e,i)=>i===0||BigInt(e.eventId)<BigInt(p.events[i-1].eventId))
  &&(p.nextBefore===null||p.events.length===100&&p.nextBefore===p.events[99].eventId));
export type DraftDeliveryStatus={id:string;state:State;includedCount:number;excludedCount:number;
 providerPlanId:string|null;writerPending:boolean;patientSent:false;phiAllowed:false};
type Row=Record<string,unknown>&{id:string;binding:unknown;state:State;writer_id:string|null;
 writer_live:boolean;writer_settled:boolean;writer_actor:unknown;provider_plan_id:string|null;receipt_sha256:string|null};

/** Required SAME-TARGET transactional authority. A source-only qualification
 * adapter exists; no production implementation is wired. Resolve/assertCurrent must read the current patient connection,
 * published manifest, catalog/ingredients/mappings, consent, holds and reviewed
 * provider release; assertAccess must validate identity and clinic/owner access.
 * This interface is not a caller-supplied approval, an OAuth token or a hash
 * attestation. Request JSON cannot inject any of these dependencies. */
export interface DraftDeliveryAuthority {
 resolve(tx:ClinicalCoreTransaction,actor:DraftDeliveryActor,selector:DraftDeliverySelector):Promise<DraftDeliveryBinding>;
 assertAccess(tx:ClinicalCoreTransaction,actor:DraftDeliveryActor,binding:DraftDeliveryBinding):Promise<void>;
 assertCurrent(tx:ClinicalCoreTransaction,binding:DraftDeliveryBinding):Promise<void>;
}
/** Normalized ledger observation, not the provider wire schema. The source
 * adapter decodes documented GET/POST responses; it is not installed in an API. */
const observationSchema=z.object({contract:z.literal('fullscript-draft-observation/1'),planId:providerId,
 patientId:providerId,practitionerId:providerId,state:z.literal('draft'),metadataId:z.string().regex(/^alp-cart-[a-f0-9]{64}$/),
 labs:z.array(z.never()).length(0),recommendations:fullscriptSupplementDraftInput.shape.recommendations}).strict();
export type FullscriptDraftObservation=z.infer<typeof observationSchema>;
export interface DraftDeliveryProvider {
 create(input:FullscriptSupplementDraftInput):Promise<unknown>;
 findByMetadata(idempotencyKey:string):Promise<unknown[]>;
}
export class DraftDeliveryRefused extends Error {
 constructor(){super('fullscript_delivery_refused');this.name='DraftDeliveryRefused';}
}
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const projection=`id,state,writer_id,writer_actor,writer_settled,provider_plan_id,receipt_sha256,
 coalesce(writer_deadline>clock_timestamp(),false) as writer_live,
 jsonb_build_object('organizationId',organization_id,'consumerPersonId',consumer_person_id,
 'patientRecordId',patient_record_id,'connectionId',connection_id,'practitionerPersonId',practitioner_person_id,
 'manifestId',manifest_id,'authoritySha256',authority_sha256,'intentSha256',intent_sha256,
 'input',input,'excludedCount',excluded_count) as binding`;
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const verifiedObservation=(raw:unknown,input:FullscriptSupplementDraftInput)=>{
 const o=observationSchema.parse(raw);
 const sort=(rows:FullscriptSupplementDraftInput['recommendations'])=>[...rows].sort((a,b)=>a.variantId.localeCompare(b.variantId));
 if(o.patientId!==input.fullscriptPatientId||o.practitionerId!==input.practitionerId||o.metadataId!==input.idempotencyKey
 ||canonical(sort(o.recommendations))!==canonical(sort(input.recommendations)))throw new DraftDeliveryRefused();
 // Normalize recommendation order for identical receipts across GET/POST.
 return {planId:o.planId,receiptSha256:digest({...o,recommendations:sort(o.recommendations)})};
};

/** Shared exact-intent check used by the provider decoder and ledger. It never
 * accepts a purchase URL, hidden extra recommendation, or inferred quantity. */
export function parseFullscriptDraftObservation(raw:unknown,input:FullscriptSupplementDraftInput):FullscriptDraftObservation {
 verifiedObservation(raw,input);
 return observationSchema.parse(raw);
}

/** One admitted writer, persisted before the external request. No transaction
 * spans provider I/O. Unknown replies and expired writers never permit a second
 * POST; reconciliation is read-only. Cancellation preserves the writer token,
 * since it cannot revoke an already admitted request at the provider. */
export function createDraftDeliveryService(database:ClinicalCoreDatabase,authority:DraftDeliveryAuthority,provider:DraftDeliveryProvider){
 const auditActor=async(tx:ClinicalCoreTransaction,actor:DraftDeliveryActor,source:'caller'|'admitted_writer'='caller')=>{
  await tx.query("select set_config('alp.fullscript_audit_actor',$1,true)",[JSON.stringify({organizationId:actor.organizationId,
   personId:actor.personId,identityPool:actor.identityPool,source})]);
 };
 const load=async(tx:ClinicalCoreTransaction,actor:DraftDeliveryActor,id:string)=>{
  const result=await tx.query<Row>(`select ${projection} from fullscript_delivery.draft_intents
   where id=$1::uuid and organization_id=$2::uuid for update`,[uuid.parse(id),actor.organizationId]);
  const row=result.rows[0];if(!row)throw new DraftDeliveryRefused();
  const binding=bindingSchema.parse(row.binding);
  await authority.assertAccess(tx,actor,copy(binding));
  await auditActor(tx,actor);
  return {row,binding};
 };
 const status=(row:Row,b:DraftDeliveryBinding):DraftDeliveryStatus=>({id:row.id,state:row.state,
  includedCount:b.input.recommendations.length,excludedCount:b.excludedCount,
  providerPlanId:row.state==='verified'?row.provider_plan_id:null,
  writerPending:row.writer_id!==null&&!row.writer_settled,patientSent:false,phiAllowed:false});
 const current=async(tx:ClinicalCoreTransaction,b:DraftDeliveryBinding)=>{
  try{await authority.assertCurrent(tx,copy(b));return true;}catch{return false;}
 };
 const stillAuthorized=async(tx:ClinicalCoreTransaction,row:Row,b:DraftDeliveryBinding)=>{
  if(!(await current(tx,b)))return false;
  if(row.writer_id)try{await authority.assertAccess(tx,actorSchema.parse(row.writer_actor),copy(b));}catch{return false;}
  return true;
 };
 const withhold=async(tx:ClinicalCoreTransaction,row:Row)=>{
  if(row.state!=='cancelled'&&row.state!=='withheld'){
   await tx.query(`update fullscript_delivery.draft_intents set state='withheld' where id=$1::uuid`,[row.id]);row.state='withheld';
  }
 };
 // Only a matching admitted writer may settle its uncertain response. Missing
 // authorization never suppresses custody of a known external draft; it only
 // withholds it from the owner. No raw provider bodies/errors are stored.
 const settle=async(id:string,writer:string,observation:unknown,finishedWriter:boolean)=>database.transaction(async tx=>{
  const found=await tx.query<Row>(`select ${projection} from fullscript_delivery.draft_intents where id=$1::uuid for update`,[id]);
  const row=found.rows[0];if(!row||row.writer_id!==writer)throw new DraftDeliveryRefused();
  const b=bindingSchema.parse(row.binding);
  await auditActor(tx,actorSchema.parse(row.writer_actor),'admitted_writer');
  let receipt:ReturnType<typeof verifiedObservation>|null=null;
  try{receipt=verifiedObservation(observation,b.input);}catch{ /* Unverified is not a receipt. */ }
  const valid=await stillAuthorized(tx,row,b);
  if(!valid)await withhold(tx,row);
  if(receipt&&row.provider_plan_id&& (receipt.planId!==row.provider_plan_id||receipt.receiptSha256!==row.receipt_sha256))
   throw new DraftDeliveryRefused();
  const next=row.state==='withheld'?'withheld':receipt||row.state==='verified'?'verified':'uncertain';
  await tx.query(`update fullscript_delivery.draft_intents set state=$2,
   provider_plan_id=coalesce(provider_plan_id,$3),receipt_sha256=coalesce(receipt_sha256,$4),
   writer_settled=writer_settled or $5 where id=$1::uuid`,[id,next,receipt?.planId??null,receipt?.receiptSha256??null,finishedWriter]);
  row.state=next;row.provider_plan_id=receipt?.planId??row.provider_plan_id;
  row.writer_settled=row.writer_settled||finishedWriter;
  return status(row,b);
 });
 const guarded=<T>(work:()=>Promise<T>)=>work().catch(()=>{throw new DraftDeliveryRefused();});
 return {
  prepare:(rawActor:unknown,rawSelector:unknown)=>guarded(async()=>{
   const actor=actorSchema.parse(rawActor),selector=selectorSchema.parse(rawSelector);
   if(actor.identityPool!=='workforce')throw new DraftDeliveryRefused();
   return database.transaction(async tx=>{
    const b=bindingSchema.parse(await authority.resolve(tx,actor,selector));
    if(b.organizationId!==actor.organizationId||b.manifestId!==selector.manifestId||b.patientRecordId!==selector.patientRecordId)
     throw new DraftDeliveryRefused();
    await authority.assertAccess(tx,actor,copy(b));await authority.assertCurrent(tx,copy(b));
    await auditActor(tx,actor);
    await tx.query(`insert into fullscript_delivery.draft_intents(id,organization_id,consumer_person_id,patient_record_id,
     connection_id,practitioner_person_id,manifest_id,authority_sha256,intent_sha256,input,excluded_count)
     values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10::jsonb,$11)
     on conflict(organization_id,intent_sha256) do nothing`,[randomUUID(),b.organizationId,b.consumerPersonId,b.patientRecordId,
     b.connectionId,b.practitionerPersonId,b.manifestId,b.authoritySha256,b.intentSha256,JSON.stringify(b.input),b.excludedCount]);
    const result=await tx.query<Row>(`select ${projection} from fullscript_delivery.draft_intents
     where organization_id=$1::uuid and intent_sha256=$2 for update`,[b.organizationId,b.intentSha256]);
    const row=result.rows[0];if(!row||canonical(row.binding)!==canonical(b))throw new DraftDeliveryRefused();
    return status(row,b);
   });
  }),
  send:(rawActor:unknown,id:string)=>guarded(async()=>{
   const actor=actorSchema.parse(rawActor);if(actor.identityPool!=='workforce')throw new DraftDeliveryRefused();
   const admitted=await database.transaction(async tx=>{
    const {row,binding:b}=await load(tx,actor,id);
    if(!(await stillAuthorized(tx,row,b))){await withhold(tx,row);return {result:status(row,b),writer:null,b};}
    if(row.state!=='prepared')return {result:status(row,b),writer:null,b};
    const writer=randomUUID();
    await tx.query(`update fullscript_delivery.draft_intents set state='dispatching',writer_id=$2::uuid,
     writer_actor=$3::jsonb,writer_deadline=clock_timestamp()+interval '30 seconds' where id=$1::uuid`,[id,writer,JSON.stringify(actor)]);
    return {result:null,writer,b};
   });
   if(!admitted.writer)return admitted.result!;
   // The committed writer admission is irreversible. Any thrown POST or
   // verifier error becomes uncertain, not "failed, retry with a new key".
   let observation:unknown=null;
   try{observation=await provider.create(copy(admitted.b.input));}catch{ /* Reply unknown. */ }
   return settle(id,admitted.writer,observation,true);
  }),
  cancel:(rawActor:unknown,id:string)=>guarded(async()=>{
   const actor=actorSchema.parse(rawActor);
   return database.transaction(async tx=>{
    const {row,binding:b}=await load(tx,actor,id);
    if(row.state==='prepared'){
     await tx.query(`update fullscript_delivery.draft_intents set state='cancelled' where id=$1::uuid`,[id]);row.state='cancelled';
    }else await withhold(tx,row);
    return status(row,b);
   });
  }),
  read:(rawActor:unknown,id:string)=>guarded(async()=>{
   const actor=actorSchema.parse(rawActor);
   return database.transaction(async tx=>{
    const {row,binding:b}=await load(tx,actor,id);
    if(!(await stillAuthorized(tx,row,b)))await withhold(tx,row);
    await tx.query('select fullscript_delivery.record_draft_access($1::uuid,$2)',[id,'status_read']);
    return status(row,b);
   });
  }),
  /** Unreleased owner-only export port. Includes one immutable intent and a
   * bounded, descending live audit page, not an account-wide snapshot or a
   * deletion/recall guarantee. No raw provider response or URL is exported. */
  exportForOwner:(rawActor:unknown,id:string,rawBefore:unknown=null)=>guarded(async()=>{
   const actor=actorSchema.parse(rawActor);
   if(actor.identityPool!=='consumer')throw new DraftDeliveryRefused();
   const before=eventIdSchema.nullable().parse(rawBefore);
   return database.transaction(async tx=>{
    const {row,binding:b}=await load(tx,actor,id);
    if(actor.personId!==b.consumerPersonId)throw new DraftDeliveryRefused();
    if(!(await stillAuthorized(tx,row,b)))await withhold(tx,row);
    // Export is historical owner access, not renewed delivery authorization.
    // Keep known external custody visible even for a withheld receipt.
    const page=auditPageSchema.parse((await tx.query<{data:unknown}>('select fullscript_delivery.owner_event_page($1::uuid,$2::bigint) as data',
     [id,before])).rows[0]?.data);
    const data={contract:'fullscript-draft-owner-export/1',coverage:'single_intent_live_audit_page',
     intentId:row.id,state:row.state,manifestId:b.manifestId,input:copy(b.input),excludedCount:b.excludedCount,
     externalCustody:{providerPlanId:row.provider_plan_id,receiptSha256:row.receipt_sha256,
      writerPending:row.writer_id!==null&&!row.writer_settled,providerCopyRemoval:'not_verified',backupRemoval:'not_verified'},
     audit:page,phiAllowed:false};
    if(Buffer.byteLength(JSON.stringify(data),'utf8')>256*1024)throw new DraftDeliveryRefused();
    await tx.query('select fullscript_delivery.record_draft_access($1::uuid,$2)',[id,'owner_export_read']);
    return data;
   });
  }),
  reconcile:(rawActor:unknown,id:string)=>guarded(async()=>{
   const actor=actorSchema.parse(rawActor);if(actor.identityPool!=='workforce')throw new DraftDeliveryRefused();
   const admitted=await database.transaction(async tx=>{
    const {row,binding:b}=await load(tx,actor,id);
    if(!(await stillAuthorized(tx,row,b))){await withhold(tx,row);return {result:status(row,b),writer:null,b};}
    if(!row.writer_id||row.state==='verified'||(row.writer_live&&!row.writer_settled))
     return {result:status(row,b),writer:null,b};
    return {result:null,writer:row.writer_id,b};
   });
   if(!admitted.writer)return admitted.result!;
   const observations=await provider.findByMetadata(admitted.b.input.idempotencyKey);
   // An empty lookup can be eventual consistency. Multiple matches are
   // ambiguous. Neither outcome authorizes a new POST or certifies absence.
   if(!Array.isArray(observations)||observations.length!==1)throw new DraftDeliveryRefused();
   verifiedObservation(observations[0],admitted.b.input);
   return settle(id,admitted.writer,observations[0],false);
  }),
 };
}
