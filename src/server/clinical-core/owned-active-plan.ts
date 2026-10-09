import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {clinicalUuid,type ClinicalCoreTransaction} from './database';
import {OwnedStorageError} from './owned-consumer-records';
import {createHash} from 'node:crypto';
import {canonicalPayload} from './aws-consumer-clinical-records';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Run=<T>(context:ProductionClinicalRequestContext,work:(tx:ClinicalCoreTransaction)=>Promise<T>)=>Promise<T>;
export type ActivePlanPointer={recordId:string;revision:number;contentSha256:string;consentRevision:number;adoptedAt:string;adoptionRequestId:string;
  supersedes:{recordId:string;revision:number}|null};
export type ActivePlanHistoryEntry={action:'adopted'|'released'|'record_deleted';requestId:string;recordId:string;revision:number;
  previousRecordId:string|null;previousRevision:number|null;recordedAt:string};
export type ActivePlanState={version:'owned-active-plan/1';current:ActivePlanPointer|null;history:ActivePlanHistoryEntry[];historyLimit:100;duplicate?:boolean};
export type AdoptActivePlanInput={recordId:string;revision:number;contentSha256:string;consentRevision:number;requestId:string;
  expectedPrevious:{recordId:string;revision:number}|null};
export type ReleaseActivePlanInput={requestId:string;expected:{recordId:string;revision:number}};

/** The pointer names one exact immutable protocols revision. The server never
 * reads or interprets the plan content here, never promotes consumer-written
 * generation metadata, and never adopts on its own: adoption is an explicit,
 * idempotent, predecessor-checked owner request. */
export function createOwnedActivePlan(run:Run){
  const parse=(raw:unknown,duplicate?:boolean):ActivePlanState=>{
    const value=object(raw);
    const current=value.current===null?null:pointer(object(value.current));
    if(!Array.isArray(value.history)||value.history.length>100||value.historyLimit!==100)unavailable();
    const history=value.history.map(row=>{
      const v=object(row);
      if(!['adopted','released','record_deleted'].includes(String(v.action))||!UUID.test(String(v.requestId))||!UUID.test(String(v.recordId))
        ||!revision(v.revision)||!date(v.recordedAt)||(v.previousRecordId!==null&&!UUID.test(String(v.previousRecordId)))
        ||(v.previousRevision!==null&&!revision(v.previousRevision))||((v.previousRecordId===null)!==(v.previousRevision===null)))unavailable();
      return {action:v.action as ActivePlanHistoryEntry['action'],requestId:v.requestId as string,recordId:v.recordId as string,revision:v.revision as number,
        previousRecordId:v.previousRecordId as string|null,previousRevision:v.previousRevision as number|null,recordedAt:v.recordedAt as string};
    });
    return {version:'owned-active-plan/1',current,history,historyLimit:100,...(duplicate===undefined?{}:{duplicate})};
  };
  return {
    async activePlan(context:ProductionClinicalRequestContext):Promise<ActivePlanState>{
      return run(context,async tx=>parse((await tx.query<{result:unknown}>('select clinical_core.get_owned_active_plan() as result')).rows[0]?.result));
    },
    async adoptActivePlan(context:ProductionClinicalRequestContext,input:AdoptActivePlanInput):Promise<ActivePlanState>{
      exact(input,['recordId','revision','contentSha256','consentRevision','requestId','expectedPrevious']);
      if(!UUID.test(input.recordId)||!revision(input.revision)||!/^[a-f0-9]{64}$/.test(input.contentSha256)||!revision(input.consentRevision)
        ||!UUID.test(input.requestId)||(input.expectedPrevious!==null&&(!object(input.expectedPrevious,false)
        ||Object.keys(input.expectedPrevious).sort().join(',')!=='recordId,revision'||!UUID.test(input.expectedPrevious.recordId)||!revision(input.expectedPrevious.revision))))invalid();
      return run(context,async tx=>{
        // Bind the caller's digest to the actual immutable record while holding
        // the same owner lock used by writes, adoption, and consent withdrawal.
        await tx.query('select pg_advisory_xact_lock(hashtextextended(clinical_private.owned_consumer_actor()::text,0))');
        const stored=object((await tx.query<{result:unknown}>('select clinical_core.get_owned_consumer_record($1,$2) as result',
          ['protocols',clinicalUuid(input.recordId)])).rows[0]?.result);
        if(stored.recordId!==input.recordId||stored.revision!==input.revision||stored.deleted!==false
          ||createHash('sha256').update(canonicalPayload(object(stored.payload))).digest('hex')!==input.contentSha256)throw new OwnedStorageError('conflict');
        const result=await tx.query<{result:unknown}>('select clinical_core.adopt_owned_active_plan($1,$2::integer,$3,$4::integer,$5,$6,$7::integer) as result',
          [clinicalUuid(input.recordId),input.revision,input.contentSha256,input.consentRevision,clinicalUuid(input.requestId),
            input.expectedPrevious?clinicalUuid(input.expectedPrevious.recordId):null,input.expectedPrevious?.revision??null]);
        const value=object(result.rows[0]?.result);
        const state=parse(value,value.duplicate===true);
        if(!state.current||state.current.recordId!==input.recordId||state.current.revision!==input.revision
          ||state.current.contentSha256!==input.contentSha256||state.current.consentRevision!==input.consentRevision
          ||state.current.adoptionRequestId!==input.requestId
          ||canonicalPayload({previous:state.current.supersedes})!==canonicalPayload({previous:input.expectedPrevious}))unavailable();
        return state;
      });
    },
    async releaseActivePlan(context:ProductionClinicalRequestContext,input:ReleaseActivePlanInput):Promise<ActivePlanState>{
      exact(input,['requestId','expected']);
      if(!UUID.test(input.requestId)||!object(input.expected,false)||Object.keys(input.expected).sort().join(',')!=='recordId,revision'
        ||!UUID.test(input.expected.recordId)||!revision(input.expected.revision))invalid();
      return run(context,async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.release_owned_active_plan($1,$2,$3::integer) as result',
          [clinicalUuid(input.requestId),clinicalUuid(input.expected.recordId),input.expected.revision]);
        const value=object(result.rows[0]?.result);
        const state=parse(value,value.duplicate===true);
        if(state.current!==null)unavailable();
        return state;
      });
    },
  };
}
function pointer(v:Record<string,unknown>):ActivePlanPointer{
  if(!UUID.test(String(v.recordId))||!revision(v.revision)||!/^[a-f0-9]{64}$/.test(String(v.contentSha256))||!revision(v.consentRevision)
    ||!date(v.adoptedAt)||!UUID.test(String(v.adoptionRequestId)))unavailable();
  let supersedes:ActivePlanPointer['supersedes']=null;
  if(v.supersedes!==null){const s=object(v.supersedes);if(!UUID.test(String(s.recordId))||!revision(s.revision))unavailable();supersedes={recordId:s.recordId as string,revision:s.revision as number};}
  return {recordId:v.recordId as string,revision:v.revision as number,contentSha256:v.contentSha256 as string,consentRevision:v.consentRevision as number,
    adoptedAt:v.adoptedAt as string,adoptionRequestId:v.adoptionRequestId as string,supersedes};
}
function exact(value:unknown,keys:string[]){const v=object(value,false);if(Object.keys(v).some(k=>!keys.includes(k)))invalid();}
function object(value:unknown,strictResult=true):Record<string,unknown>{
  if(strictResult&&typeof value==='string'){try{value=JSON.parse(value);}catch{unavailable();}}
  if(!value||typeof value!=='object'||Array.isArray(value)){if(strictResult)unavailable();invalid();}
  return value as Record<string,unknown>;
}
function revision(value:unknown):value is number{return Number.isSafeInteger(value)&&(value as number)>=1;}
function date(value:unknown){return typeof value==='string'&&Number.isFinite(Date.parse(value));}
function invalid():never{throw new OwnedStorageError('request_invalid');}
function unavailable():never{throw new OwnedStorageError('storage_unavailable');}
