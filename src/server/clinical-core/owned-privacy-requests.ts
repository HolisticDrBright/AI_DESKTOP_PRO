import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {clinicalUuid,type ClinicalCoreTransaction} from './database';
import {OwnedStorageError} from './owned-consumer-records';
import {CORRECTION_COLLECTIONS,correctionInputSchema,correctionRecordSchema,correctionTargetSchema,correctionResolutionSchema,
  type CorrectionRecord,type CorrectionTarget,type CorrectionResolution} from '@/contracts/personalCorrection';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Run=<T>(context:ProductionClinicalRequestContext,work:(tx:ClinicalCoreTransaction)=>Promise<T>)=>Promise<T>;
export const PRIVACY_STORES=['personal_records','personal_consents','active_plan','lab_jobs_and_documents','voice_jobs_and_transcripts',
  'identity','clinic_records','device_caches_and_recovery_archives','backups_and_audit'] as const;
export const PRIVACY_OUTCOMES=['tombstoned','purged','not_applicable','pending','refused','not_enumerable','retained_by_policy'] as const;
export type PrivacyStore=typeof PRIVACY_STORES[number];
export type PrivacyFulfillmentEntry={store:PrivacyStore;outcome:typeof PRIVACY_OUTCOMES[number];evidenceSha256:string|null;recordedAt:string};
export type PrivacyRequest={privacyRequestId:string;requestId:string;kind:'deletion'|'correction';status:'submitted'|'held'|'in_progress'|'completed'|'refused';
  submittedAt:string;updatedAt:string;completedAt:string|null;legalHold:boolean;fulfillment:PrivacyFulfillmentEntry[];duplicate?:boolean;tombstoned?:number;
  correctionTarget?:CorrectionTarget;correctionResolution?:CorrectionResolution};
/** Machine-readable statement of what self-service deletion does and does not do. */
export const PERSONAL_DELETION_COVERAGE={
  completeAccountDeletion:false,
  selfService:['personal_records_tombstoned','active_plan_pointer_cleared'],
  operatorFulfilled:['personal_history_purge_requires_retention_policy','lab_jobs_and_documents','voice_jobs_and_transcripts','identity','clinic_records'],
  notErased:['device_caches_and_recovery_archives','backups_and_audit'],
} as const;

/** Consumer-facing privacy request ledger. Submission and listing survive
 * consent withdrawal. The consumer can tombstone their own personal records;
 * every other store is fulfilled by an attributable workforce operation and
 * recorded here. Nothing is inferred as erased. */
export function createOwnedPrivacyRequests(run:Run){
  const parse=(raw:unknown):PrivacyRequest=>{
    const v=object(raw);
    if(!UUID.test(String(v.privacyRequestId))||!UUID.test(String(v.requestId))||!['deletion','correction'].includes(String(v.kind))
      ||!['submitted','held','in_progress','completed','refused'].includes(String(v.status))||!date(v.submittedAt)||!date(v.updatedAt)
      ||(v.completedAt!==null&&!date(v.completedAt))||typeof v.legalHold!=='boolean'||!Array.isArray(v.fulfillment)||v.fulfillment.length>200)unavailable();
    const fulfillment=v.fulfillment.map(row=>{
      const f=object(row);
      if(!PRIVACY_STORES.includes(f.store as PrivacyStore)||!PRIVACY_OUTCOMES.includes(f.outcome as typeof PRIVACY_OUTCOMES[number])
        ||(f.evidenceSha256!==null&&!/^[a-f0-9]{64}$/.test(String(f.evidenceSha256)))||!date(f.recordedAt))unavailable();
      return {store:f.store as PrivacyStore,outcome:f.outcome as typeof PRIVACY_OUTCOMES[number],evidenceSha256:f.evidenceSha256 as string|null,recordedAt:f.recordedAt as string};
    });
    const target=v.correctionTarget===undefined?undefined:correctionTargetSchema.safeParse(v.correctionTarget);
    const resolution=v.correctionResolution===undefined?undefined:correctionResolutionSchema.safeParse(v.correctionResolution);
    if(target&&!target.success||resolution&&!resolution.success||((target||resolution)&&v.kind!=='correction'))unavailable();
    if(target?.success&&v.status==='completed'&&!resolution?.success)unavailable();
    if(resolution?.success&&(!target?.success||(resolution.data.outcome==='applied'?
      v.status!=='completed'||resolution.data.appliedRevision!<=target.data.expectedRevision||v.completedAt===null:v.status!=='refused'||v.completedAt!==null)))unavailable();
    return {privacyRequestId:v.privacyRequestId as string,requestId:v.requestId as string,kind:v.kind as PrivacyRequest['kind'],status:v.status as PrivacyRequest['status'],
      submittedAt:v.submittedAt as string,updatedAt:v.updatedAt as string,completedAt:v.completedAt as string|null,legalHold:v.legalHold,fulfillment,
      ...(typeof v.duplicate==='boolean'?{duplicate:v.duplicate}:{}),...(Number.isSafeInteger(v.tombstoned)?{tombstoned:v.tombstoned as number}:{}),
      ...(target?.success?{correctionTarget:target.data}:{}),...(resolution?.success?{correctionResolution:resolution.data}:{})};
  };
  return {
    async submitPrivacyRequest(context:ProductionClinicalRequestContext,input:{requestId:string;kind:'deletion'|'correction';correction?:Record<string,unknown>}):Promise<PrivacyRequest>{
      exact(input,['requestId','kind','correction']);
      if(!UUID.test(input.requestId)||!['deletion','correction'].includes(input.kind)||((input.kind==='correction')!==(input.correction!==undefined)))invalid();
      if(input.correction!==undefined){
        const c=input.correction;
        if(!c||typeof c!=='object'||Array.isArray(c)||Buffer.byteLength(JSON.stringify(c),'utf8')>8192)invalid();
        if(!correctionInputSchema.safeParse(c).success)invalid();
      }
      return run(context,async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.submit_owned_privacy_request($1,$2,$3::jsonb) as result',
          [clinicalUuid(input.requestId),input.kind,input.correction===undefined?null:JSON.stringify(input.correction)]);
        const state=parse(result.rows[0]?.result);
        if(state.requestId!==input.requestId||state.kind!==input.kind)unavailable();
        if(input.correction){
          const c=input.correction,t=state.correctionTarget;
          if(!t||t.collection!==c.collection||t.recordId!==c.recordId||t.field!==c.field
            ||t.expectedRevision!==c.expectedRevision||t.expectedPayloadSha256!==c.expectedPayloadSha256)unavailable();
        }
        return state;
      });
    },
    async listCorrectionTargets(context:ProductionClinicalRequestContext,input:{collection:string;limit?:number;after?:string}):Promise<CorrectionRecord[]>{
      exact(input,['collection','limit','after']);
      const limit=input.limit??25;
      if(!(CORRECTION_COLLECTIONS as readonly string[]).includes(input.collection)||!Number.isInteger(limit)||limit<1||limit>25
        ||input.after!==undefined&&!UUID.test(input.after))invalid();
      return run(context,async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.list_owned_correction_targets($1,$2,$3) as result',
          [input.collection,limit,input.after?clinicalUuid(input.after):null]);
        const rows=decoded(result.rows[0]?.result);
        if(!Array.isArray(rows)||rows.length>limit)unavailable();
        let previous=input.after?.toLowerCase()??'';
        return rows.map(value=>{const parsed=correctionRecordSchema.safeParse(value);if(!parsed.success)unavailable();
          const row=parsed.data;if(row.collection!==input.collection||row.recordId.toLowerCase()<=previous)unavailable();previous=row.recordId.toLowerCase();return row;});
      });
    },
    async listPrivacyRequests(context:ProductionClinicalRequestContext):Promise<PrivacyRequest[]>{
      return run(context,async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.list_owned_privacy_requests() as result');
        const rows=decoded(result.rows[0]?.result);
        if(!Array.isArray(rows)||rows.length>50)unavailable();
        return rows.map(parse);
      });
    },
    async tombstonePersonalRecords(context:ProductionClinicalRequestContext,input:{requestId:string;confirmTombstoneAllPersonalRecords:true}):Promise<PrivacyRequest>{
      exact(input,['requestId','confirmTombstoneAllPersonalRecords']);
      if(!UUID.test(input.requestId)||input.confirmTombstoneAllPersonalRecords!==true)invalid();
      return run(context,async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.tombstone_owned_personal_records($1) as result',[clinicalUuid(input.requestId)]);
        const state=parse(result.rows[0]?.result);
        if(state.kind!=='deletion'||!Number.isSafeInteger(state.tombstoned))unavailable();
        return state;
      });
    },
  };
}
function exact(value:unknown,keys:string[]){const v=object(value,false);if(Object.keys(v).some(k=>!keys.includes(k)))invalid();}
function object(value:unknown,strictResult=true):Record<string,unknown>{
  if(strictResult)value=decoded(value);
  if(!value||typeof value!=='object'||Array.isArray(value)){if(strictResult)unavailable();invalid();}
  return value as Record<string,unknown>;
}
function decoded(value:unknown):unknown{try{return typeof value==='string'?JSON.parse(value):value;}catch{unavailable();}}
function date(v:unknown){return typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));}
function invalid():never{throw new OwnedStorageError('request_invalid');}
function unavailable():never{throw new OwnedStorageError('storage_unavailable');}
