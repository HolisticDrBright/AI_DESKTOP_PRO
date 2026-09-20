if(typeof window!=='undefined')throw new Error('owned-privacy-export-job is server-only');
import {createHash} from 'node:crypto';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {clinicalUuid,type ClinicalCoreTransaction} from './database';
import {OwnedStorageError} from './owned-consumer-records';
import {createOwnedPrivacyExport,PERSONAL_EXPORT_COVERAGE} from './owned-privacy-export';

/** Large personal-storage exports packaged server-side in owner-authorized,
 * bounded passes (migration 20260920110000). A pass runs only while the owner
 * is authenticated and polling: it reads a bounded number of snapshot pages,
 * uploads one encrypted object part (or a staging object when fewer than a
 * part's worth of rows arrived), records the cursor, and returns. The download
 * is a short-lived signed link for the exact ready version, issued only to a
 * freshly signed-in owner. Coverage is the inline export's; this is not a
 * complete account export and never claims to be. */
export const PRIVACY_EXPORT_JOB_CONTRACT='personal-storage-export-job/1';
export type PrivacyExportObjectStorage={bucket:string;region:string;kmsKeyArn:string;expectedBucketOwner:string};
export interface PrivacyExportStore {
  createUpload(s:PrivacyExportObjectStorage,key:string,signal:AbortSignal):Promise<{uploadId:string}>;
  uploadPart(s:PrivacyExportObjectStorage,key:string,uploadId:string,partNumber:number,body:Uint8Array,sha256Hex:string,signal:AbortSignal):Promise<{etag:string}>;
  completeUpload(s:PrivacyExportObjectStorage,key:string,uploadId:string,parts:{partNumber:number;etag:string;sha256Hex:string}[],signal:AbortSignal):Promise<{version:string;checksum:string}>;
  abortUpload(s:PrivacyExportObjectStorage,key:string,uploadId:string,signal:AbortSignal):Promise<void>;
  put(s:PrivacyExportObjectStorage,key:string,body:Uint8Array,sha256Hex:string,signal:AbortSignal):Promise<{version:string}>;
  get(s:PrivacyExportObjectStorage,key:string,version:string,maxBytes:number,signal:AbortSignal):Promise<Uint8Array>;
  head(s:PrivacyExportObjectStorage,key:string,version:string,signal:AbortSignal):Promise<{exists:boolean;bytes?:number;encryption?:string;kmsKeyArn?:string;checksum?:string}|null>;
  deleteVersion(s:PrivacyExportObjectStorage,key:string,version:string,signal:AbortSignal):Promise<void>;
  signDownload(s:PrivacyExportObjectStorage,key:string,version:string,seconds:number,fileName:string,signal:AbortSignal):Promise<string>;
}
export type PrivacyExportJobView={contract:typeof PRIVACY_EXPORT_JOB_CONTRACT;jobId:string;status:'requested'|'running'|'ready'|'failed'|'cancelled'|'expired';
  asOf:string;requestedAt:string;readyAt:string|null;expiresAt:string;recordCount:number;consentCount:number;exportedRecords:number;exportedConsents:number;
  parts:number;bytesWritten:number;byteLength:number|null;objectChecksum:string|null;failureCode:string|null;objectDeleted:boolean;version:number;
  coverage:typeof PERSONAL_EXPORT_COVERAGE};
type Run=<T>(context:ProductionClinicalRequestContext,work:(tx:ClinicalCoreTransaction)=>Promise<T>)=>Promise<T>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PRIVACY_EXPORT_PART_BYTES=5*1024*1024, PRIVACY_EXPORT_MAX_BYTES=2*1024*1024*1024, PRIVACY_EXPORT_DOWNLOAD_SECONDS=300, PRIVACY_EXPORT_FRESH_AUTH_MS=5*60_000;
const sha256=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function invalid():never{throw new OwnedStorageError('request_invalid');}
function unavailable():never{throw new OwnedStorageError('storage_unavailable');}
function object(raw:unknown):Record<string,unknown>{try{const v=typeof raw==='string'?JSON.parse(raw):raw;if(!v||typeof v!=='object'||Array.isArray(v))unavailable();return v;}catch{unavailable();}}
const date=(v:unknown)=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
/** Owner ids never appear in object keys; the prefix is the owner's digest. */
export const privacyExportPrefix=(ownerId:string)=>`personal-exports/${createHash('sha256').update(ownerId).digest('hex')}/`;

function view(raw:unknown):PrivacyExportJobView{
  const v=object(raw);
  if(!UUID.test(String(v.jobId))||!['requested','running','ready','failed','cancelled','expired'].includes(String(v.status))||!date(v.asOf)||!date(v.requestedAt)
    ||!date(v.expiresAt)||(v.readyAt!==null&&!date(v.readyAt))||!count(v.recordCount)||!count(v.consentCount)||!count(v.exportedRecords)||!count(v.exportedConsents)
    ||!count(v.parts)||!count(v.bytesWritten)||(v.byteLength!==null&&!count(v.byteLength))||(v.objectChecksum!==null&&typeof v.objectChecksum!=='string')
    ||(v.failureCode!==null&&typeof v.failureCode!=='string')||typeof v.objectDeleted!=='boolean'||!count(v.version))unavailable();
  return {contract:PRIVACY_EXPORT_JOB_CONTRACT,jobId:v.jobId as string,status:v.status as PrivacyExportJobView['status'],asOf:v.asOf as string,requestedAt:v.requestedAt as string,
    readyAt:(v.readyAt as string|null),expiresAt:v.expiresAt as string,recordCount:v.recordCount as number,consentCount:v.consentCount as number,
    exportedRecords:v.exportedRecords as number,exportedConsents:v.exportedConsents as number,parts:v.parts as number,bytesWritten:v.bytesWritten as number,
    byteLength:v.byteLength as number|null,objectChecksum:v.objectChecksum as string|null,failureCode:v.failureCode as string|null,objectDeleted:v.objectDeleted,
    version:v.version as number,coverage:PERSONAL_EXPORT_COVERAGE};
}
async function call<T=unknown>(tx:ClinicalCoreTransaction,sql:string,args:unknown[]){const r=await tx.query<{result:T}>(sql,args);if(r.rows.length!==1)unavailable();return r.rows[0].result;}

export function createOwnedPrivacyExportJobs(run:Run,delivery:{store:PrivacyExportStore;storage:PrivacyExportObjectStorage;now?:()=>number;partBytes?:number}){
  const now=()=>delivery.now?.()??Date.now(), partBytes=delivery.partBytes??PRIVACY_EXPORT_PART_BYTES, {store,storage}=delivery;
  if(!Number.isSafeInteger(partBytes)||partBytes<1024||partBytes>PRIVACY_EXPORT_PART_BYTES)throw new Error('privacy_export_part_bytes_invalid');
  const reader=createOwnedPrivacyExport(run);
  const staging=(key:string)=>`${key}.staging`;
  return {
    async requestPrivacyExportJob(context:ProductionClinicalRequestContext,input:{requestId:string}):Promise<PrivacyExportJobView&{replayed:boolean}>{
      if(!input||typeof input!=='object'||Object.keys(input).join(',')!=='requestId'||!UUID.test(input.requestId))invalid();
      return run(context,async tx=>{
        const raw=object(await call(tx,'select clinical_core.request_owned_privacy_export_job($1,$2) as result',[clinicalUuid(input.requestId),privacyExportPrefix(context.actorPersonId)]));
        if(typeof raw.replayed!=='boolean')unavailable();
        return {...view(raw),replayed:raw.replayed as boolean};
      });
    },
    async getPrivacyExportJob(context:ProductionClinicalRequestContext,input:{jobId:string}):Promise<PrivacyExportJobView>{
      if(!input||typeof input!=='object'||Object.keys(input).join(',')!=='jobId'||!UUID.test(input.jobId))invalid();
      return run(context,async tx=>view(await call(tx,'select clinical_core.get_owned_privacy_export_job($1) as result',[clinicalUuid(input.jobId)])));
    },
    /** One bounded pass, then the job view. Runs only under the owner's own identity; nothing continues after the caller leaves. */
    async advancePrivacyExportJob(context:ProductionClinicalRequestContext,input:{jobId:string},budgetMs:number,signal:AbortSignal):Promise<PrivacyExportJobView>{
      if(!input||typeof input!=='object'||Object.keys(input).join(',')!=='jobId'||!UUID.test(input.jobId))invalid();
      if(!Number.isSafeInteger(budgetMs)||budgetMs<500||budgetMs>20000)invalid();
      const deadline=now()+budgetMs;
      const lease=object(await run(context,tx=>call(tx,'select clinical_core.lease_owned_privacy_export_pass($1,$2::integer) as result',[clinicalUuid(input.jobId),Math.min(60,Math.ceil(budgetMs/1000)+10)])));
      const state={exportId:String(lease.exportId),asOf:String(lease.asOf),recordCount:lease.recordCount as number,consentCount:lease.consentCount as number,
        key:String(lease.objectKey),uploadId:(lease.uploadId as string|null),section:String(lease.section) as 'records'|'consents'|'done',
        cursor:(lease.cursor as {cursor:string|null}|null)?.cursor??null,parts:lease.parts as number,partSha256s:lease.partSha256s as string[],partEtags:lease.partEtags as string[],
        bytesWritten:lease.bytesWritten as number,exportedRecords:lease.exportedRecords as number,exportedConsents:lease.exportedConsents as number,
        stagingVersion:(lease.stagingVersion as string|null),version:lease.version as number};
      if(!UUID.test(state.exportId)||!date(state.asOf)||!count(state.recordCount)||!count(state.consentCount)||!state.key.startsWith(privacyExportPrefix(context.actorPersonId))
        ||!['records','consents','done'].includes(state.section)||!count(state.parts)||!Array.isArray(state.partSha256s)||!Array.isArray(state.partEtags)
        ||state.partSha256s.length!==state.parts||state.partEtags.length!==state.parts||!count(state.version))unavailable();
      const fail=async(code:string)=>{try{await run(context,tx=>call(tx,'select clinical_core.fail_owned_privacy_export_job($1,$2) as result',[clinicalUuid(input.jobId),code]));}catch{/* the lease expires; the next poll sees the state */}};
      try{
        // Resume the pending text from the staging object, or start the document.
        const chunks:string[]=[];let bytes=0;
        const push=(text:string)=>{chunks.push(text);bytes+=Buffer.byteLength(text,'utf8');};
        if(state.stagingVersion){
          const pending=await store.get(storage,staging(state.key),state.stagingVersion,partBytes+1024*1024,signal);
          chunks.push(Buffer.from(pending).toString('utf8'));bytes=pending.byteLength;
        }else if(state.parts===0&&state.exportedRecords===0&&state.exportedConsents===0&&state.section==='records'){
          push(JSON.stringify({contract:PRIVACY_EXPORT_JOB_CONTRACT,manifest:{version:'personal-storage-export/1',exportId:state.exportId,asOf:state.asOf,
            recordCount:state.recordCount,consentCount:state.consentCount,coverage:PERSONAL_EXPORT_COVERAGE}}).slice(0,-1)+',"records":[');
        }
        let section=state.section,cursor=state.cursor,records=state.exportedRecords,consents=state.exportedConsents,partReady=false;
        while(section!=='done'&&now()<deadline&&!signal.aborted&&bytes<partBytes){
          const page=await reader.readPrivacyExport(context,{exportId:state.exportId,section,limit:100,...(cursor?{cursor}:{})});
          for(const item of page.items){
            const seen=section==='records'?records:consents;
            push((seen>0?',':'')+JSON.stringify(item));
            if(section==='records')records++;else consents++;
          }
          if(page.nextCursor){cursor=page.nextCursor;continue;}
          if(section==='records'){
            if(records!==state.recordCount)unavailable();
            section='consents';cursor=null;push('],"consents":[');
          }else{
            if(consents!==state.consentCount)unavailable();
            section='done';cursor=null;push(']}');
          }
        }
        if(bytes>PRIVACY_EXPORT_MAX_BYTES-state.bytesWritten){await fail('export_too_large');return this.getPrivacyExportJob(context,input);}
        const body=Buffer.from(chunks.join(''),'utf8');
        let uploadId=state.uploadId,partSha:string|null=null,partEtag:string|null=null,partBytesWritten:number|null=null,stagingVersion:string|null=null;
        if(section==='done'||body.byteLength>=partBytes){
          partReady=true;
          if(!uploadId)uploadId=(await store.createUpload(storage,state.key,signal)).uploadId;
          partSha=sha256(body);
          partEtag=(await store.uploadPart(storage,state.key,uploadId,state.parts+1,body,partSha,signal)).etag;
          partBytesWritten=body.byteLength;
        }else{
          stagingVersion=(await store.put(storage,staging(state.key),body,sha256(body),signal)).version;
        }
        const recorded=view(await run(context,tx=>call(tx,'select clinical_core.record_owned_privacy_export_pass($1,$2::bigint,$3,$4,$5,$6::bigint,$7,$8,$9::jsonb,$10::bigint,$11::bigint) as result',
          [clinicalUuid(input.jobId),state.version,uploadId,partSha,partEtag,partBytesWritten,stagingVersion,section,JSON.stringify({cursor}),records,consents])));
        // The old staging object is superseded either way; removal is best effort and verified by the cleanup pass if it fails here.
        if(state.stagingVersion){try{await store.deleteVersion(storage,staging(state.key),state.stagingVersion,signal);}catch{/* cleanup pass */}}
        if(partReady&&section==='done'){
          const parts=[...state.partSha256s.map((sha,i)=>({partNumber:i+1,etag:state.partEtags[i],sha256Hex:sha})),{partNumber:state.parts+1,etag:partEtag!,sha256Hex:partSha!}];
          const completed=await store.completeUpload(storage,state.key,uploadId!,parts,signal);
          if(!completed.version||completed.version==='null'||!completed.checksum)unavailable();
          const head=await store.head(storage,state.key,completed.version,signal);
          if(!head?.exists||head.encryption!=='aws:kms'||head.kmsKeyArn!==storage.kmsKeyArn||head.bytes!==state.bytesWritten+body.byteLength)unavailable();
          return view(await run(context,tx=>call(tx,'select clinical_core.complete_owned_privacy_export_job($1,$2::bigint,$3,$4) as result',[clinicalUuid(input.jobId),recorded.version,completed.version,completed.checksum])));
        }
        return recorded;
      }catch(error){
        // A storage or database hiccup leaves the job running: nothing was recorded for this pass, the lease
        // lapses, and the next poll resumes from the last recorded state. Only bounded conditions fail the job.
        if(error instanceof OwnedStorageError)throw error;
        throw new OwnedStorageError('storage_unavailable');
      }
    },
    async cancelPrivacyExportJob(context:ProductionClinicalRequestContext,input:{jobId:string}):Promise<PrivacyExportJobView>{
      if(!input||typeof input!=='object'||Object.keys(input).join(',')!=='jobId'||!UUID.test(input.jobId))invalid();
      return run(context,async tx=>view(await call(tx,'select clinical_core.cancel_owned_privacy_export_job($1) as result',[clinicalUuid(input.jobId)])));
    },
    /** A signed link for the exact ready version. `authTime` is the token's sign-in time: only a fresh sign-in may download. */
    async issuePrivacyExportDownload(context:ProductionClinicalRequestContext,input:{jobId:string},authTimeMs:number,signal:AbortSignal):Promise<{jobId:string;url:string;expiresInSeconds:number;byteLength:number;objectChecksum:string}>{
      if(!input||typeof input!=='object'||Object.keys(input).join(',')!=='jobId'||!UUID.test(input.jobId))invalid();
      if(!Number.isFinite(authTimeMs)||now()-authTimeMs>PRIVACY_EXPORT_FRESH_AUTH_MS||authTimeMs>now()+60_000)throw new OwnedStorageError('owner_required');
      const issued=object(await run(context,tx=>call(tx,'select clinical_core.issue_owned_privacy_export_download($1) as result',[clinicalUuid(input.jobId)])));
      if(issued.jobId!==input.jobId||typeof issued.objectKey!=='string'||!issued.objectKey.startsWith(privacyExportPrefix(context.actorPersonId))
        ||typeof issued.objectVersion!=='string'||typeof issued.objectChecksum!=='string'||!count(issued.byteLength))unavailable();
      const head=await store.head(storage,issued.objectKey,issued.objectVersion,signal);
      if(!head?.exists||head.encryption!=='aws:kms'||head.kmsKeyArn!==storage.kmsKeyArn||head.bytes!==issued.byteLength)unavailable();
      const url=await store.signDownload(storage,issued.objectKey,issued.objectVersion,PRIVACY_EXPORT_DOWNLOAD_SECONDS,'alp-personal-storage-copy.json',signal);
      if(!/^https:\/\//.test(url))unavailable();
      return {jobId:input.jobId,url,expiresInSeconds:PRIVACY_EXPORT_DOWNLOAD_SECONDS,byteLength:issued.byteLength as number,objectChecksum:issued.objectChecksum};
    },
    /** Removes the owner's own finished jobs' objects and open uploads, verifying each; returns how many jobs were cleaned. */
    async cleanupPrivacyExportJobs(context:ProductionClinicalRequestContext,signal:AbortSignal):Promise<{cleaned:number;remaining:number}>{
      const listed=await run(context,tx=>call<unknown>(tx,'select clinical_core.list_owned_privacy_export_cleanup() as result',[]));
      const items=(typeof listed==='string'?JSON.parse(listed):listed) as Record<string,unknown>[];
      if(!Array.isArray(items))unavailable();
      let cleaned=0,remaining=0;
      for(const item of items){
        if(signal.aborted){remaining++;continue;}
        try{
          const key=String(item.objectKey);
          if(!key.startsWith(privacyExportPrefix(context.actorPersonId)))unavailable();
          if(typeof item.uploadId==='string'){try{await store.abortUpload(storage,key,item.uploadId,signal);}catch{/* an already-completed or absent upload */}}
          for(const [k,v] of [[staging(key),item.stagingVersion],[key,item.objectVersion]] as [string,unknown][]){
            if(typeof v!=='string')continue;
            await store.deleteVersion(storage,k,v,signal);
            const head=await store.head(storage,k,v,signal);
            if(head?.exists)unavailable();
          }
          await run(context,tx=>call(tx,'select clinical_core.record_owned_privacy_export_object_deleted($1,$2::bigint) as result',[clinicalUuid(String(item.jobId)),Number(item.version)]));
          cleaned++;
        }catch{remaining++;}
      }
      return {cleaned,remaining};
    },
  };
}
