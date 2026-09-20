if (typeof window !== 'undefined') throw new Error('recording-cleanup-authority is server-only');
import { z } from 'zod';
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { recordingStorageSchema } from './recording-segments';
import { createRecordingStorageBudget } from './recording-storage-budget';

const uuid=z.string().uuid(), sha=z.string().regex(/^[a-f0-9]{64}$/);
export const recordingCleanupRequestSchema=z.object({recordingId:uuid,version:z.number().int().positive().safe(),cleanupReleaseId:uuid,workerSha256:sha,attemptId:uuid.optional(),runId:uuid.optional()}).strict();
export type RecordingCleanupRequest=z.infer<typeof recordingCleanupRequestSchema>;
const version=z.string().min(1).max(1024).regex(/^[A-Za-z0-9+/=._-]+$/).refine(v=>v!=='null');
/** Exactly one target: an audio segment or a registered transcription artifact. */
export const recordingCleanupAttemptSchema=z.object({id:uuid,segmentId:uuid.nullable(),artifactId:uuid.nullable().default(null),objectVersion:version,
  kind:z.enum(['object','delete_marker']),evidenceSha256:sha}).strict().refine(a=>(a.segmentId===null)!==(a.artifactId===null));
const artifactSchema=z.object({artifactId:uuid,jobId:uuid,kind:z.enum(['media','provider','transcript','proposed_note']),objectKey:z.string().min(1).max(512),
  objectVersion:version,sha256:sha,bytes:z.number().int().min(1).max(268435456),transcriptId:uuid.nullable()}).strict()
  .refine(t=>(t.kind==='transcript')===(t.transcriptId!==null));
/** Transcription jobs write under `transcription/<job>/`; drafting jobs under `drafting/<job>/`. */
export const artifactPrefix=(organizationId:string,recordingId:string,t:{kind:string;jobId:string})=>
  `encounter-recordings/${organizationId}/${recordingId}/${t.kind==='proposed_note'?'drafting':'transcription'}/${t.jobId}/`;
export type RecordingCleanupArtifact=z.infer<typeof artifactSchema>;
const segmentSchema=z.object({segmentId:uuid,sequence:z.number().int().min(0).max(4095),sha256:sha,
  bytes:z.number().int().min(1).max(4194304),status:z.enum(['reserved','stored']),objectKey:z.string().max(512),
  objectVersion:z.string().min(1).max(1024).regex(/^[A-Za-z0-9+/=._-]+$/).refine(v=>v!=='null').nullable(),
  storageReleaseId:uuid,authorityEpoch:z.number().int().nonnegative().safe(),participantIds:z.array(uuid).max(100),
  recordingGrantIds:z.array(uuid).max(100)}).strict().refine(s=>(s.status==='stored')===(s.objectVersion!==null));
export const recordingCleanupAdmissionSchema=z.object({recordingId:uuid,sessionId:uuid,organizationId:uuid,patientRecordId:uuid,
  version:z.number().int().positive().safe(),cleanupReleaseId:uuid,workerSha256:sha,storageReleaseId:uuid,storage:recordingStorageSchema,
  inventory:z.array(segmentSchema).max(4096),inventorySha256:sha,
  transcriptionInventory:z.array(artifactSchema).max(512),transcriptionInventorySha256:sha,
  validUntil:z.string().datetime({offset:true}),audioDeleted:z.literal(false),
  attempt:recordingCleanupAttemptSchema.optional(),runId:uuid.optional()}).strict()
  .refine(r=>new Set(r.inventory.map(s=>s.segmentId)).size===r.inventory.length
    && new Set(r.inventory.map(s=>s.sequence)).size===r.inventory.length
    && r.inventory.every(s=>s.storageReleaseId===r.storageReleaseId && s.bytes<=r.storage.maxSegmentBytes
      && s.objectKey===`encounter-recordings/${r.organizationId}/${r.recordingId}/${r.sessionId}/${s.sequence}-${s.sha256}`))
  .refine(r=>new Set(r.transcriptionInventory.map(t=>t.artifactId)).size===r.transcriptionInventory.length
    && new Set(r.transcriptionInventory.map(t=>t.objectKey)).size===r.transcriptionInventory.length
    && r.transcriptionInventory.every(t=>t.objectKey.startsWith(artifactPrefix(r.organizationId,r.recordingId,t))
      && !r.inventory.some(s=>s.objectKey===t.objectKey)));
export type RecordingCleanupAdmission=z.infer<typeof recordingCleanupAdmissionSchema>;
export class RecordingCleanupError extends Error {
  constructor(readonly code:'request_invalid'|'access_refused'|'legal_hold'|'not_ready'|'service_unavailable'){
    super(code);this.name='RecordingCleanupError';
  }
}
export function assertRecordingCleanupContext(context:ProductionClinicalRequestContext){
  if(context.identityPool!=='workforce'||context.purpose!=='consent_management'||context.environment!=='production-clinical'
    ||context.dataClassification!=='clinical_phi'||context.productionBound!==true||context.containsPhi!==true||context.realPatientData!==true
    ||!uuid.safeParse(context.actorPersonId).success||!uuid.safeParse(context.organizationId).success
    ||typeof context.identitySubject!=='string'||!context.identitySubject.trim())throw new RecordingCleanupError('access_refused');
}

/** Internal-only boundary for a separately reviewed worker. Fresh authenticated
 * workforce context and the deployed worker artifact hash must come from trusted
 * server configuration, never from a consumer request or capture token.
 * Hold locks stay held for ONE bounded operation. A timeout/rollback is uncertain,
 * not erasure; late remote writes/deletes still require durable reconciliation.
 * This function never removes the queue, creates a deletion receipt or grants
 * S3 permissions. The callback must not retain/reuse this inventory as a permit.
 */
export function createRecordingCleanupAuthority(database:ClinicalCoreDatabase){
  return async<T>(context:ProductionClinicalRequestContext,input:unknown,
    operation:(admission:RecordingCleanupAdmission,signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    const request=recordingCleanupRequestSchema.safeParse(input);
    if(!request.success)throw new RecordingCleanupError('request_invalid');
    assertRecordingCleanupContext(context);
    try{
      return await database.transaction(async tx=>{
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
          clinicalUuid(context.actorPersonId),clinicalUuid(context.organizationId),context.identityPool,context.identitySubject,
          context.purpose,context.environment,context.dataClassification]);
        const r=request.data;
        const result=await tx.query<{data:unknown}>(r.runId
          ?'select clinical_private.admit_recording_cleanup_run($1,$2::bigint,$3,$4,$5,$6) as data'
          :r.attemptId
          ?'select clinical_private.admit_recording_cleanup_attempt($1,$2::bigint,$3,$4,$5) as data'
          :'select clinical_private.admit_recording_cleanup($1,$2::bigint,$3,$4) as data',[
          clinicalUuid(r.recordingId),r.version,clinicalUuid(r.cleanupReleaseId),r.workerSha256,
          ...(r.runId?[clinicalUuid(r.runId),r.attemptId?clinicalUuid(r.attemptId):null]:r.attemptId?[clinicalUuid(r.attemptId)]:[])]);
        if(result.rows.length!==1)throw new RecordingCleanupError('service_unavailable');
        const raw=result.rows[0].data, parsed=recordingCleanupAdmissionSchema.safeParse(typeof raw==='string'?JSON.parse(raw):raw);
        if(!parsed.success)throw new RecordingCleanupError('service_unavailable');
        const a=parsed.data;
        if(a.recordingId!==r.recordingId||a.organizationId!==context.organizationId||a.version!==r.version
          ||a.cleanupReleaseId!==r.cleanupReleaseId||a.workerSha256!==r.workerSha256||a.attempt?.id!==r.attemptId||a.runId!==r.runId)throw new RecordingCleanupError('service_unavailable');
        return createRecordingStorageBudget(a.validUntil,5000).run(signal=>operation(a,signal));
      });
    }catch(error){
      if(error instanceof RecordingCleanupError)throw error;
      if(error instanceof ClinicalCoreDatabaseRejection){
        if(error.category==='legal_hold')throw new RecordingCleanupError('legal_hold');
        if(error.category==='conflict')throw new RecordingCleanupError('not_ready');
        throw new RecordingCleanupError('access_refused');
      }
      throw new RecordingCleanupError('service_unavailable');
    }
  };
}
