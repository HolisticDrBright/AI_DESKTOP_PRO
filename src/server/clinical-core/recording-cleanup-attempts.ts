if(typeof window!=='undefined')throw new Error('recording-cleanup-attempts is server-only');
import {z} from 'zod';
import {clinicalUuid,type ClinicalCoreDatabase} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {assertRecordingCleanupContext,recordingCleanupRequestSchema,recordingCleanupAttemptSchema,RecordingCleanupError,
  type RecordingCleanupRequest} from './recording-cleanup-authority';
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const cleanupPreparedSchema=recordingCleanupAttemptSchema.extend({inventorySha256:sha}).strict();
export type CleanupPrepared=z.infer<typeof cleanupPreparedSchema>;
export type CleanupOutcome='delete_acknowledged'|'unknown'|'retained'|'refused';
export interface RecordingCleanupAttempts {
  prepare(context:ProductionClinicalRequestContext,request:RecordingCleanupRequest,attempt:CleanupPrepared):Promise<string>;
  record(context:ProductionClinicalRequestContext,attemptId:string,outcome:CleanupOutcome,evidenceSha256:string):Promise<void>;
}
/** Each method commits separately. An intent must commit before ANY remote
 * mutation; failure to record a later outcome leaves that intent unresolved. */
export function createRecordingCleanupAttempts(database:ClinicalCoreDatabase):RecordingCleanupAttempts{
  async function execute(context:ProductionClinicalRequestContext,sql:string,args:unknown[],expected:string){
    assertRecordingCleanupContext(context);
    try{return await database.transaction(async tx=>{
      await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
        clinicalUuid(context.actorPersonId),clinicalUuid(context.organizationId),context.identityPool,context.identitySubject,
        context.purpose,context.environment,context.dataClassification]);
      const result=await tx.query<{id:string}>(sql,args);
      if(result.rows.length!==1||result.rows[0].id!==expected)throw new RecordingCleanupError('service_unavailable');
      return expected;
    });}catch{throw new RecordingCleanupError('service_unavailable');}
  }
  return {
    async prepare(context,request,attempt){
      const r=recordingCleanupRequestSchema.safeParse(request),a=cleanupPreparedSchema.safeParse(attempt);
      if(!r.success||r.data.attemptId!==undefined||!a.success)throw new RecordingCleanupError('request_invalid');
      // Segment and artifact intents are distinct SQL functions; each verifies its target exists for this recording.
      const target=a.data.segmentId??a.data.artifactId!;
      const fn=a.data.segmentId?'prepare_recording_cleanup_attempt':'prepare_recording_cleanup_artifact_attempt';
      return execute(context,`select clinical_private.${fn}($1,$2::bigint,$3,$4,$5,$6,$7,$8,$9,$10) as id`,[
        clinicalUuid(r.data.recordingId),r.data.version,clinicalUuid(r.data.cleanupReleaseId),r.data.workerSha256,
        clinicalUuid(a.data.id),clinicalUuid(target),a.data.objectVersion,a.data.kind,a.data.inventorySha256,a.data.evidenceSha256],a.data.id);
    },
    async record(context,id,outcome,evidence){
      if(!z.string().uuid().safeParse(id).success||!z.enum(['delete_acknowledged','unknown','retained','refused']).safeParse(outcome).success||!sha.safeParse(evidence).success)
        throw new RecordingCleanupError('request_invalid');
      await execute(context,'select clinical_private.record_recording_cleanup_attempt($1,$2,$3) as id',[clinicalUuid(id),outcome,evidence],id);
    },
  };
}
