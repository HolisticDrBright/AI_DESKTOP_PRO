import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {clinicalUuid,type ClinicalCoreTransaction} from './database';
import {OwnedStorageError} from './owned-consumer-records';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Run=<T>(context:ProductionClinicalRequestContext,work:(tx:ClinicalCoreTransaction)=>Promise<T>)=>Promise<T>;
export const PRIVACY_STORES=['personal_records','personal_consents','active_plan','lab_jobs_and_documents','voice_jobs_and_transcripts',
  'identity','clinic_records','device_caches_and_recovery_archives','backups_and_audit'] as const;
export const PRIVACY_OUTCOMES=['tombstoned','purged','not_applicable','pending','refused','not_enumerable','retained_by_policy'] as const;
export type PrivacyStore=typeof PRIVACY_STORES[number];
export type PrivacyFulfillmentEntry={store:PrivacyStore;outcome:typeof PRIVACY_OUTCOMES[number];evidenceSha256:string|null;recordedAt:string};
export type PrivacyRequest={privacyRequestId:string;requestId:string;kind:'deletion'|'correction';status:'submitted'|'held'|'in_progress'|'completed'|'refused';
  submittedAt:string;updatedAt:string;completedAt:string|null;legalHold:boolean;fulfillment:PrivacyFulfillmentEntry[];duplicate?:boolean;tombstoned?:number};
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
    return {privacyRequestId:v.privacyRequestId as string,requestId:v.requestId as string,kind:v.kind as PrivacyRequest['kind'],status:v.status as PrivacyRequest['status'],
      submittedAt:v.submittedAt as string,updatedAt:v.updatedAt as string,completedAt:v.completedAt as string|null,legalHold:v.legalHold,fulfillment,
      ...(typeof v.duplicate==='boolean'?{duplicate:v.duplicate}:{}),...(Number.isSafeInteger(v.tombstoned)?{tombstoned:v.tombstoned as number}:{})};
  };
  return {
    async submitPrivacyRequest(context:ProductionClinicalRequestContext,input:{requestId:string;kind:'deletion'|'correction';correction?:Record<string,unknown>}):Promise<PrivacyRequest>{
      exact(input,['requestId','kind','correction']);
      if(!UUID.test(input.requestId)||!['deletion','correction'].includes(input.kind)||((input.kind==='correction')!==(input.correction!==undefined)))invalid();
      if(input.correction!==undefined){
        const c=input.correction;
        if(!c||typeof c!=='object'||Array.isArray(c)||Buffer.byteLength(JSON.stringify(c),'utf8')>8192)invalid();
        exact(c,['collection','recordId','field','requestedValue','reason']);
        if(!UUID.test(String(c.recordId))||typeof c.collection!=='string'||typeof c.field!=='string'||c.field.length>80||typeof c.reason!=='string'||c.reason.length>2000)invalid();
      }
      return run(context,async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.submit_owned_privacy_request($1,$2,$3::jsonb) as result',
          [clinicalUuid(input.requestId),input.kind,input.correction===undefined?null:JSON.stringify(input.correction)]);
        const state=parse(result.rows[0]?.result);
        if(state.requestId!==input.requestId||state.kind!==input.kind)unavailable();
        return state;
      });
    },
    async listPrivacyRequests(context:ProductionClinicalRequestContext):Promise<PrivacyRequest[]>{
      return run(context,async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.list_owned_privacy_requests() as result');
        const rows=result.rows[0]?.result;
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
  if(!value||typeof value!=='object'||Array.isArray(value)){if(strictResult)unavailable();invalid();}
  return value as Record<string,unknown>;
}
function date(v:unknown){return typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));}
function invalid():never{throw new OwnedStorageError('request_invalid');}
function unavailable():never{throw new OwnedStorageError('storage_unavailable');}
