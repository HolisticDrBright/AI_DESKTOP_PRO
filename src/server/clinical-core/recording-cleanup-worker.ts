if(typeof window!=='undefined')throw new Error('recording-cleanup-worker is server-only');
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {RecordingCleanupError,recordingCleanupRequestSchema,type RecordingCleanupAdmission,
  type RecordingCleanupRequest,type createRecordingCleanupAuthority} from './recording-cleanup-authority';
import type {RecordingCleanupAttempts,CleanupPrepared,CleanupOutcome} from './recording-cleanup-attempts';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import type {RecordingStoredObject} from './recording-segments';

export const cleanupVersionSchema=z.object({key:z.string().min(1).max(512),version:z.string().min(1).max(1024)
  .regex(/^[A-Za-z0-9+/=._-]+$/).refine(v=>v!=='null'),kind:z.enum(['object','delete_marker'])}).strict();
export type CleanupObjectVersion=z.infer<typeof cleanupVersionSchema>;
const pageSchema=z.object({versions:z.array(cleanupVersionSchema).max(100),truncated:z.boolean()}).strict();
export type CleanupVersionPage=z.infer<typeof pageSchema>;
export type CleanupInspection=RecordingStoredObject & {legalHold:'ON'|'OFF';retentionVerified:boolean;retainUntil?:string;eventHold?:'ON'|'OFF'};
export interface RecordingCleanupStore {
  list(admission:RecordingCleanupAdmission,signal:AbortSignal):Promise<CleanupVersionPage>;
  inspect(admission:RecordingCleanupAdmission,object:CleanupObjectVersion,signal:AbortSignal):Promise<CleanupInspection>;
  remove(admission:RecordingCleanupAdmission,object:CleanupObjectVersion,signal:AbortSignal):Promise<{version?:string;deleteMarker?:boolean}>;
}
export type CleanupWorkerResult={state:'empty_observed'|'needs_recheck';deleteAcknowledged:number;audioDeleted:false;requiresRecheck:true};
const evidence=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function segment(a:RecordingCleanupAdmission,v:CleanupObjectVersion){
  const s=a.inventory.find(s=>s.objectKey===v.key);
  if(!s)throw new RecordingCleanupError('access_refused');return s;
}
function verifiedPage(a:RecordingCleanupAdmission,input:unknown){
  const parsed=pageSchema.safeParse(input);if(!parsed.success)throw new RecordingCleanupError('service_unavailable');
  const p=parsed.data;
  if(new Set(p.versions.map(v=>v.key+'\0'+v.version)).size!==p.versions.length||p.truncated&&!p.versions.length)
    throw new RecordingCleanupError('service_unavailable');
  for(const v of p.versions)segment(a,v);
  return p;
}
function verifyObject(a:RecordingCleanupAdmission,v:CleanupObjectVersion,h:CleanupInspection){
  const s=segment(a,v);
  if(h.version!==v.version||h.bytes!==s.bytes||h.checksum!==Buffer.from(s.sha256,'hex').toString('base64')
    ||h.checksumType!=='FULL_OBJECT'||h.encryption!=='aws:kms'||h.kmsKeyArn!==a.storage.kmsKeyArn||h.deleteMarker===true
    ||h.metadata?.['segment-id']!==s.segmentId||h.metadata?.['recording-id']!==a.recordingId
    ||h.metadata?.['session-id']!==a.sessionId||h.metadata?.['authority-epoch']!==String(s.authorityEpoch))
    throw new RecordingCleanupError('access_refused');
  if(h.legalHold==='ON'||h.eventHold==='ON')throw new RecordingCleanupError('legal_hold');
  if(h.legalHold!=='OFF'||h.retentionVerified!==true||h.eventHold!==undefined&&h.eventHold!=='OFF')
    throw new RecordingCleanupError('service_unavailable');
  if(h.retainUntil!==undefined){
    if(!Number.isFinite(Date.parse(h.retainUntil)))throw new RecordingCleanupError('service_unavailable');
    if(Date.parse(h.retainUntil)>Date.now())throw new RecordingCleanupError('legal_hold');
  }
  // Immutable version provenance only; retention/hold observations are re-read
  // before deletion and must never be cached as permission.
  return evidence({key:v.key,version:v.version,kind:v.kind,segmentId:s.segmentId,sha256:s.sha256,bytes:s.bytes,
    kmsKeyArn:a.storage.kmsKeyArn,authorityEpoch:s.authorityEpoch,recordingId:a.recordingId,sessionId:a.sessionId});
}

/** Internal bounded worker; not wired to any public route or scheduler. Each
 * invocation handles at most25 versions from a fresh first page. The next run
 * starts over rather than continuing a stale pagination cursor after deletion.
 * Empty listing is an observation, not proof against late PUTs or complete
 * erasure. Durable attempts remain for watch/reconciliation/operator review. */
export function createRecordingCleanupWorker(deps:{authorize:ReturnType<typeof createRecordingCleanupAuthority>;attempts:RecordingCleanupAttempts;storage:RecordingCleanupStore}){
  return async(context:ProductionClinicalRequestContext,input:unknown):Promise<CleanupWorkerResult>=>{
    const parsed=recordingCleanupRequestSchema.safeParse(input);
    if(!parsed.success||parsed.data.attemptId||!parsed.data.runId)throw new RecordingCleanupError('request_invalid');
    const request:RecordingCleanupRequest=parsed.data;
    const initial=await deps.authorize(context,request,async(a,signal)=>({a,page:verifiedPage(a,await deps.storage.list(a,signal))}));
    if(initial.page.versions.length===0)return {state:'empty_observed',deleteAcknowledged:0,audioDeleted:false,requiresRecheck:true};
    let acknowledged=0;
    const objects=[...initial.page.versions].sort((a,b)=>Number(a.kind==='delete_marker')-Number(b.kind==='delete_marker')).slice(0,25);
    for(const object of objects){
      const proof=await deps.authorize(context,request,async(a,signal)=>{
        if(a.inventorySha256!==initial.a.inventorySha256)throw new RecordingCleanupError('not_ready');
        if(object.kind==='object')return verifyObject(a,object,await deps.storage.inspect(a,object,signal));
        const page=verifiedPage(a,await deps.storage.list(a,signal));
        if(!page.versions.some(v=>v.key===object.key&&v.version===object.version&&v.kind===object.kind))throw new RecordingCleanupError('not_ready');
        return evidence(object);
      });
      const attempt:CleanupPrepared={id:randomUUID(),segmentId:segment(initial.a,object).segmentId,objectVersion:object.version,
        kind:object.kind,inventorySha256:initial.a.inventorySha256,evidenceSha256:proof};
      // A separate committed transaction, BEFORE any remote mutation.
      const prepared=await deps.attempts.prepare(context,request,attempt);
      if(prepared!==attempt.id)throw new RecordingCleanupError('service_unavailable');
      let outcome:CleanupOutcome='unknown';
      try{
        await deps.authorize(context,{...request,attemptId:attempt.id},async(a,signal)=>{
          if(!a.attempt||a.attempt.id!==attempt.id||a.attempt.segmentId!==attempt.segmentId
            ||a.attempt.objectVersion!==object.version||a.attempt.kind!==object.kind||a.attempt.evidenceSha256!==proof)
            throw new RecordingCleanupError('access_refused');
          let freshProof:string;
          if(object.kind==='object')freshProof=verifyObject(a,object,await deps.storage.inspect(a,object,signal));
          else{
            const page=verifiedPage(a,await deps.storage.list(a,signal));
            if(!page.versions.some(v=>v.key===object.key&&v.version===object.version&&v.kind===object.kind))throw new RecordingCleanupError('not_ready');
            freshProof=evidence(object);
          }
          if(freshProof!==proof||signal.aborted)throw new RecordingCleanupError('not_ready');
          const receipt=await deps.storage.remove(a,object,signal);
          if(receipt.version!==object.version||(object.kind==='delete_marker'?receipt.deleteMarker!==true:receipt.deleteMarker===true))
            throw new RecordingCleanupError('service_unavailable');
        });
        outcome='delete_acknowledged';acknowledged++;
      }catch(error){
        outcome=error instanceof RecordingCleanupError&&error.code==='legal_hold'?'retained':'unknown';
      }
      // Outcome logging is not a whole-recording deletion receipt. If it fails,
      // the durable attempt remains unresolved and a later pass must reconcile.
      await deps.attempts.record(context,attempt.id,outcome,evidence({attemptId:attempt.id,outcome,objectVersion:object.version}));
      if(outcome!=='delete_acknowledged')return {state:'needs_recheck',deleteAcknowledged:acknowledged,audioDeleted:false,requiresRecheck:true};
    }
    return {state:'needs_recheck',deleteAcknowledged:acknowledged,audioDeleted:false,requiresRecheck:true};
  };
}
