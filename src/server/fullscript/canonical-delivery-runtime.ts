if (typeof window !== 'undefined') throw new Error('Fullscript delivery runtime is server-only.');
import {z} from 'zod';
import type {ClinicalCoreDatabase} from '../clinical-core/database';
import type {RequestSession} from '../session';
import {createCanonicalDraftAuthority} from './canonical-draft-authority';
import {createCredentialBoundFullscriptDraftProvider} from './credential-binding';
import {createDraftDeliveryService,DraftDeliveryRefused,type DraftDeliveryActor,type DraftDeliveryBinding} from './draft-delivery';
import {fullscriptSupplementDraftInput,type FullscriptSupplementDraftInput} from './protocol-draft';

const actorSchema=z.object({organizationId:z.string().uuid(),personId:z.string().uuid(),
 identitySubject:z.string().min(1).max(200),identityPool:z.enum(['workforce','consumer']),
 environment:z.literal('synthetic-staging'),phiAllowed:z.literal(false)}).strict();
const intentKey=z.string().regex(/^alp-cart-[a-f0-9]{64}$/);
const decoded=(v:unknown):unknown=>typeof v==='string'?JSON.parse(v):v;
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const guarded=async<T>(work:()=>Promise<T>)=>{try{return await work();}catch{throw new DraftDeliveryRefused();}};

/** Real service composition, still UNRELEASED. Uses the canonical SQL authority,
 * durable ledger and native credential-bound provider rather than review JSON
 * or a caller-chosen provider. Actor/session MUST come from the future handler's
 * verified JWT and observed pool/MFA/target; this constructor is not a verifier.
 * No HTTP route or activation flag exposes it yet. Same-target review loading
 * cannot replace target/ledger review, privacy lifecycle or sandbox acceptance.
 * Consumer reads/cancellation/export never construct an OAuth provider.
 */
export function createCanonicalFullscriptDelivery(input:{database:ClinicalCoreDatabase;
 configuration:unknown;actor:DraftDeliveryActor;session?:RequestSession}){
 let actor:DraftDeliveryActor;
 try{actor=actorSchema.parse(structuredClone(input.actor));}catch{throw new DraftDeliveryRefused();}
 const session=input.session?{...input.session}:undefined;
 const database=input.database,authority=createCanonicalDraftAuthority(input.configuration);
 if(actor.identityPool==='workforce'&&(!session?.signedIn||session.expired||!session.email||session.orgId!==actor.organizationId))
  throw new DraftDeliveryRefused();
 type IntentRow=Record<string,unknown>&{manifest_id:string;patient_record_id:string;authority_sha256:string;
  intent_sha256:string;input:unknown;state:string;writer_id:string|null;writer_actor:unknown;writer_settled:boolean;writer_live:boolean};

 const load=async(key:string,post:boolean,expected?:FullscriptSupplementDraftInput)=>guarded(()=>database.transaction(async tx=>{
  if(actor.identityPool!=='workforce'||!session)throw new DraftDeliveryRefused();
  intentKey.parse(key);
  const row=(await tx.query<IntentRow>(`select manifest_id,patient_record_id,authority_sha256,intent_sha256,
   input,state,writer_id,writer_actor,writer_settled,coalesce(writer_deadline>clock_timestamp(),false) as writer_live
   from fullscript_delivery.draft_intents
   where organization_id=$1::uuid and intent_sha256=$2`,[actor.organizationId,key.slice('alp-cart-'.length)])).rows[0];
  if(!row||!row.writer_id||canonical(decoded(row.writer_actor))!==canonical(actor)
   ||post&&(row.state!=='dispatching'||row.writer_settled||row.writer_live!==true))throw new DraftDeliveryRefused();
  const binding:DraftDeliveryBinding=await authority.resolve(tx,actor,{manifestId:row.manifest_id,patientRecordId:row.patient_record_id});
  const saved=fullscriptSupplementDraftInput.parse(decoded(row.input));
  if(binding.authoritySha256!==row.authority_sha256||binding.intentSha256!==row.intent_sha256
   ||binding.input.idempotencyKey!==key||canonical(binding.input)!==canonical(saved)
   ||expected&&canonical(expected)!==canonical(saved))throw new DraftDeliveryRefused();
  return {binding,release:await authority.providerRelease(tx,actor,binding)};
 }));
 const provider={
  create:(raw:FullscriptSupplementDraftInput)=>guarded(async()=>{
   const request=fullscriptSupplementDraftInput.parse(structuredClone(raw));
   const admitted=await load(request.idempotencyKey,true,request);
   const check=async()=>{
    const current=await load(request.idempotencyKey,true,request);
    if(canonical(current)!==canonical(admitted))throw new DraftDeliveryRefused();
   };
   return createCredentialBoundFullscriptDraftProvider(session!,admitted.release,check).create(request);
  }),
  findByMetadata:(key:string)=>guarded(async()=>{
   const admitted=await load(key,false);
   const check=async()=>{
    const current=await load(key,false);
    if(canonical(current)!==canonical(admitted))throw new DraftDeliveryRefused();
   };
   return createCredentialBoundFullscriptDraftProvider(session!,admitted.release,check).findByMetadata(key);
  }),
 };
 const delivery=createDraftDeliveryService(database,authority,provider);
 return {
  prepare:(selector:Parameters<typeof delivery.prepare>[1])=>delivery.prepare(actor,selector),
  send:(id:string)=>delivery.send(actor,id),
  read:(id:string)=>delivery.read(actor,id),
  cancel:(id:string)=>delivery.cancel(actor,id),
  reconcile:(id:string)=>delivery.reconcile(actor,id),
  exportForOwner:(id:string,before:unknown=null)=>delivery.exportForOwner(actor,id,before),
 };
}
