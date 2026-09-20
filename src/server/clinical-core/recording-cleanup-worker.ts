if(typeof window!=='undefined')throw new Error('recording-cleanup-worker is server-only');
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {RecordingCleanupError,recordingCleanupRequestSchema,type RecordingCleanupAdmission,type RecordingCleanupArtifact,
  type RecordingCleanupRequest,type createRecordingCleanupAuthority} from './recording-cleanup-authority';
import type {RecordingCleanupAttempts,CleanupPrepared,CleanupOutcome} from './recording-cleanup-attempts';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import type {RecordingStoredObject} from './recording-segments';
import {createRecordingStorageBudget} from './recording-storage-budget';

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
type CleanupTarget={kind:'segment';segment:RecordingCleanupAdmission['inventory'][number]}|{kind:'artifact';artifact:RecordingCleanupArtifact};
/** Every listed key must be an inventoried audio segment or a registered
 * transcription artifact; anything else under the recording prefix stops the pass. */
export function cleanupTarget(a:RecordingCleanupAdmission,v:CleanupObjectVersion):CleanupTarget{
  const s=a.inventory.find(s=>s.objectKey===v.key);if(s)return {kind:'segment',segment:s};
  const t=a.transcriptionInventory.find(t=>t.objectKey===v.key);if(t)return {kind:'artifact',artifact:t};
  throw new RecordingCleanupError('access_refused');
}
export const targetIds=(t:CleanupTarget)=>t.kind==='segment'?{segmentId:t.segment.segmentId,artifactId:null}:{segmentId:null,artifactId:t.artifact.artifactId};
function verifiedPage(a:RecordingCleanupAdmission,input:unknown){
  const parsed=pageSchema.safeParse(input);if(!parsed.success)throw new RecordingCleanupError('service_unavailable');
  const p=parsed.data;
  if(new Set(p.versions.map(v=>v.key+'\0'+v.version)).size!==p.versions.length||p.truncated&&!p.versions.length)
    throw new RecordingCleanupError('service_unavailable');
  for(const v of p.versions)cleanupTarget(a,v);
  return p;
}
function verifyHolds(h:CleanupInspection){
  if(h.legalHold==='ON'||h.eventHold==='ON')throw new RecordingCleanupError('legal_hold');
  if(h.legalHold!=='OFF'||h.retentionVerified!==true||h.eventHold!==undefined&&h.eventHold!=='OFF')
    throw new RecordingCleanupError('service_unavailable');
  if(h.retainUntil!==undefined){
    if(!Number.isFinite(Date.parse(h.retainUntil)))throw new RecordingCleanupError('service_unavailable');
    if(Date.parse(h.retainUntil)>Date.now())throw new RecordingCleanupError('legal_hold');
  }
}
function verifyObject(a:RecordingCleanupAdmission,v:CleanupObjectVersion,h:CleanupInspection){
  const t=cleanupTarget(a,v);
  if(t.kind==='artifact'){
    const x=t.artifact,checksum=Buffer.from(x.sha256,'hex').toString('base64');
    // Media and transcript objects were written by this service with a full-object
    // checksum and provenance metadata. The provider wrote provider.json itself, so
    // its checksum is verified only when S3 reports one; version, size and key are exact.
    if(v.version!==x.objectVersion||h.version!==v.version||h.bytes!==x.bytes||h.encryption!=='aws:kms'||h.kmsKeyArn!==a.storage.kmsKeyArn||h.deleteMarker===true
      ||(x.kind!=='provider'&&(h.checksum!==checksum||h.checksumType!=='FULL_OBJECT'||h.metadata?.['recording-id']!==a.recordingId
        ||h.metadata?.['job-id']!==x.jobId||(x.kind==='orphan'?!['transcript','proposed_note'].includes(h.metadata?.['artifact-kind']??''):h.metadata?.['artifact-kind']!==x.kind)))
      ||(x.kind==='provider'&&h.checksum!==undefined&&(h.checksum!==checksum||h.checksumType!=='FULL_OBJECT')))
      throw new RecordingCleanupError('access_refused');
    verifyHolds(h);
    return evidence({key:v.key,version:v.version,kind:v.kind,artifactId:x.artifactId,artifactKind:x.kind,jobId:x.jobId,sha256:x.sha256,bytes:x.bytes,
      kmsKeyArn:a.storage.kmsKeyArn,recordingId:a.recordingId});
  }
  const s=t.segment;
  if(h.version!==v.version||h.bytes!==s.bytes||h.checksum!==Buffer.from(s.sha256,'hex').toString('base64')
    ||h.checksumType!=='FULL_OBJECT'||h.encryption!=='aws:kms'||h.kmsKeyArn!==a.storage.kmsKeyArn||h.deleteMarker===true
    ||h.metadata?.['segment-id']!==s.segmentId||h.metadata?.['recording-id']!==a.recordingId
    ||h.metadata?.['session-id']!==a.sessionId||h.metadata?.['authority-epoch']!==String(s.authorityEpoch))
    throw new RecordingCleanupError('access_refused');
  verifyHolds(h);
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
export function createRecordingCleanupWorker(deps:{authorize:ReturnType<typeof createRecordingCleanupAuthority>;attempts:RecordingCleanupAttempts;storage:RecordingCleanupStore;maximumMs?:number}){
  const maximumMs=deps.maximumMs??60000;
  if(!Number.isSafeInteger(maximumMs)||maximumMs<1||maximumMs>60000)throw new Error('recording_cleanup_budget_invalid');
  return async(context:ProductionClinicalRequestContext,input:unknown):Promise<CleanupWorkerResult>=>{
    const parsed=recordingCleanupRequestSchema.safeParse(input);
    if(!parsed.success||parsed.data.attemptId||!parsed.data.runId)throw new RecordingCleanupError('request_invalid');
    const request:RecordingCleanupRequest=parsed.data;
    const budget=createRecordingStorageBudget(new Date(Date.now()+maximumMs).toISOString(),maximumMs);
    // The pass has one monotonic deadline, including database waits. A late
    // admission/prepare must never continue into a new storage operation.
    const authorize:ReturnType<typeof createRecordingCleanupAuthority>=(_context,r,operation)=>budget.run(passSignal=>
      deps.authorize(_context,r,(a,operationSignal)=>{
        budget.check();
        const signal=AbortSignal.any([passSignal,operationSignal]);
        if(signal.aborted)throw new RecordingCleanupError('not_ready');
        return operation(a,signal);
      }));
    const initial=await authorize(context,request,async(a,signal)=>({a,page:verifiedPage(a,await deps.storage.list(a,signal))}));
    if(initial.page.versions.length===0)return {state:'empty_observed',deleteAcknowledged:0,audioDeleted:false,requiresRecheck:true};
    let acknowledged=0;
    // A processing-scope pass leaves audio segments (and their delete markers) in place until the recording's own deadline.
    const actionable=initial.page.versions.filter(v=>initial.a.audioActionable||cleanupTarget(initial.a,v).kind==='artifact');
    if(actionable.length===0)return {state:'needs_recheck',deleteAcknowledged:0,audioDeleted:false,requiresRecheck:true};
    const objects=[...actionable].sort((a,b)=>Number(a.kind==='delete_marker')-Number(b.kind==='delete_marker')).slice(0,25);
    for(const object of objects){
      const proof=await authorize(context,request,async(a,signal)=>{
        if(a.inventorySha256!==initial.a.inventorySha256||a.transcriptionInventorySha256!==initial.a.transcriptionInventorySha256
          ||a.scope!==initial.a.scope||a.audioActionable!==initial.a.audioActionable)throw new RecordingCleanupError('not_ready');
        if(object.kind==='object')return verifyObject(a,object,await deps.storage.inspect(a,object,signal));
        const page=verifiedPage(a,await deps.storage.list(a,signal));
        if(!page.versions.some(v=>v.key===object.key&&v.version===object.version&&v.kind===object.kind))throw new RecordingCleanupError('not_ready');
        return evidence(object);
      });
      const attempt:CleanupPrepared={id:randomUUID(),...targetIds(cleanupTarget(initial.a,object)),objectVersion:object.version,
        kind:object.kind,inventorySha256:initial.a.inventorySha256,evidenceSha256:proof};
      // A separate committed transaction, BEFORE any remote mutation.
      const prepared=await budget.run(async()=>deps.attempts.prepare(context,request,attempt));
      if(prepared!==attempt.id)throw new RecordingCleanupError('service_unavailable');
      let outcome:CleanupOutcome='unknown';
      try{
        await authorize(context,{...request,attemptId:attempt.id},async(a,signal)=>{
          if(!a.attempt||a.attempt.id!==attempt.id||a.attempt.segmentId!==attempt.segmentId||a.attempt.artifactId!==attempt.artifactId
            ||a.attempt.objectVersion!==object.version||a.attempt.kind!==object.kind||a.attempt.evidenceSha256!==proof)
            throw new RecordingCleanupError('access_refused');
          // Both inventories must still be the ones this pass verified; the database pins the audio inventory, the worker pins both.
          if(a.inventorySha256!==initial.a.inventorySha256||a.transcriptionInventorySha256!==initial.a.transcriptionInventorySha256
            ||a.scope!==initial.a.scope||a.audioActionable!==initial.a.audioActionable)throw new RecordingCleanupError('not_ready');
          if(!a.audioActionable&&cleanupTarget(a,object).kind==='segment')throw new RecordingCleanupError('not_ready');
          let freshProof:string;
          if(object.kind==='object')freshProof=verifyObject(a,object,await deps.storage.inspect(a,object,signal));
          else{
            const page=verifiedPage(a,await deps.storage.list(a,signal));
            if(!page.versions.some(v=>v.key===object.key&&v.version===object.version&&v.kind===object.kind))throw new RecordingCleanupError('not_ready');
            freshProof=evidence(object);
          }
          budget.check();
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
      await budget.run(async()=>deps.attempts.record(context,attempt.id,outcome,evidence({attemptId:attempt.id,outcome,objectVersion:object.version})));
      if(outcome!=='delete_acknowledged')return {state:'needs_recheck',deleteAcknowledged:acknowledged,audioDeleted:false,requiresRecheck:true};
    }
    return {state:'needs_recheck',deleteAcknowledged:acknowledged,audioDeleted:false,requiresRecheck:true};
  };
}
