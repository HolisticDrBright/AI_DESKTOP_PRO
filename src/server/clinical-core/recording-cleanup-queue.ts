if(typeof window!=='undefined')throw new Error('recording-cleanup-queue is server-only');
import {z} from 'zod';
import {createHash,randomUUID} from 'node:crypto';
import {clinicalUuid,ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import {assertRecordingCleanupContext,RecordingCleanupError,recordingCleanupRequestSchema} from './recording-cleanup-authority';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import type {createRecordingCleanupWorker} from './recording-cleanup-worker';
import {cleanupWorkItemSchema as itemSchema,cleanupOutcomeSchema,cleanupHistoryItemSchema} from '@/contracts/recordingCleanupReview';
const uuid=z.string().uuid(),date=z.string().datetime({offset:true});
export const cleanupRunRequestSchema=recordingCleanupRequestSchema.omit({attemptId:true,runId:true}).strict();
export const cleanupRunOutcomeSchema=cleanupOutcomeSchema;
export const cleanupRunClaimSchema=z.object({runId:uuid,recordingId:uuid,version:z.number().int().positive().safe(),claimed:z.boolean(),leaseUntil:date}).strict();
export const cleanupRunResultSchema=z.object({runId:uuid,recordingId:uuid,outcome:cleanupRunOutcomeSchema,appliedToSchedule:z.boolean(),
  nextCheckAt:date.nullable(),audioDeleted:z.literal(false),requiresRecheck:z.literal(true)}).strict();
export type CleanupRunRequest=z.infer<typeof cleanupRunRequestSchema>;
export type CleanupRunOutcome=z.infer<typeof cleanupRunOutcomeSchema>;
export interface RecordingCleanupQueue {
  claim(context:ProductionClinicalRequestContext,request:CleanupRunRequest,runId:string):Promise<z.infer<typeof cleanupRunClaimSchema>>;
  finish(context:ProductionClinicalRequestContext,runId:string,recordingId:string,outcome:CleanupRunOutcome,acknowledged:number|null,evidence:string):Promise<z.infer<typeof cleanupRunResultSchema>>;
  list(context:ProductionClinicalRequestContext,after?:string):Promise<{items:z.infer<typeof itemSchema>[];nextAfter:string|null}>;
}
export function createRecordingCleanupQueue(database:ClinicalCoreDatabase){
  async function query<T>(context:ProductionClinicalRequestContext,sql:string,args:unknown[],schema:z.ZodType<T>){
    assertRecordingCleanupContext(context);
    try{return await database.transaction(async tx=>{
      await tx.query("set local lock_timeout='2s'");
      await tx.query("set local statement_timeout='10s'");
      await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
        clinicalUuid(context.actorPersonId),clinicalUuid(context.organizationId),context.identityPool,context.identitySubject,context.purpose,context.environment,context.dataClassification]);
      const result=await tx.query<{data:unknown}>(sql,args);
      if(result.rows.length!==1)throw new RecordingCleanupError('service_unavailable');
      const raw=result.rows[0].data,parsed=schema.safeParse(typeof raw==='string'?JSON.parse(raw):raw);
      if(!parsed.success)throw new RecordingCleanupError('service_unavailable');return parsed.data;
    });}catch(error){
      if(error instanceof RecordingCleanupError)throw error;
      if(error instanceof ClinicalCoreDatabaseRejection)throw new RecordingCleanupError(error.category==='conflict'?'not_ready':error.category==='legal_hold'?'legal_hold':'access_refused');
      throw new RecordingCleanupError('service_unavailable');
    }
  }
  const queue:RecordingCleanupQueue={
    async claim(context,request,runId){
      const parsed=cleanupRunRequestSchema.safeParse(request);
      if(!parsed.success||!uuid.safeParse(runId).success)throw new RecordingCleanupError('request_invalid');
      const r=parsed.data,result=await query(context,'select clinical_private.claim_recording_cleanup_run($1,$2::bigint,$3,$4,$5) as data',
        [clinicalUuid(r.recordingId),r.version,clinicalUuid(r.cleanupReleaseId),r.workerSha256,clinicalUuid(runId)],cleanupRunClaimSchema);
      if(result.runId!==runId||result.recordingId!==r.recordingId||result.version!==r.version)throw new RecordingCleanupError('service_unavailable');return result;
    },
    async finish(context,runId,recordingId,outcome,acknowledged,evidence){
      if(!uuid.safeParse(runId).success||!uuid.safeParse(recordingId).success||!cleanupRunOutcomeSchema.safeParse(outcome).success
        ||!z.number().int().min(0).max(25).nullable().safeParse(acknowledged).success||!/^[a-f0-9]{64}$/.test(evidence))throw new RecordingCleanupError('request_invalid');
      const result=await query(context,'select clinical_private.finish_recording_cleanup_run($1,$2,$3::integer,$4) as data',[
        clinicalUuid(runId),outcome,acknowledged,evidence],cleanupRunResultSchema);
      if(result.runId!==runId||result.recordingId!==recordingId||result.outcome!==outcome)throw new RecordingCleanupError('service_unavailable');return result;
    },
    async list(context,after){
      if(after!==undefined&&!uuid.safeParse(after).success)throw new RecordingCleanupError('request_invalid');
      const items=await query(context,'select clinical_private.review_recording_cleanup_work($1,25) as data',[after?clinicalUuid(after):null],z.array(itemSchema).max(25));
      if(items.some((v,i)=>(i>0&&v.recordingId<=items[i-1].recordingId)||after!==undefined&&v.recordingId<=after))throw new RecordingCleanupError('service_unavailable');
      return {items,nextAfter:items.length===25?items.at(-1)!.recordingId:null};
    },
  };
  return {...queue,async history(context:ProductionClinicalRequestContext,recordingId:string,after?:string){
    if(!uuid.safeParse(recordingId).success||after!==undefined&&!uuid.safeParse(after).success)throw new RecordingCleanupError('request_invalid');
    const runs=await query(context,'select clinical_private.list_recording_cleanup_runs($1,$2,25) as data',
      [clinicalUuid(recordingId),after?clinicalUuid(after):null],z.array(cleanupHistoryItemSchema).max(25));
    if(runs.some((r,i)=>i>0&&r.runId<=runs[i-1].runId||after!==undefined&&r.runId<=after))throw new RecordingCleanupError('service_unavailable');
    return {recordingId,runs,nextAfter:runs.length===25?runs.at(-1)!.runId:null};
  }};
}

/** Claim commits before work; result commits separately. A crash or a failed
 * result write leaves the lease visible until a new run can reclaim it. Replayed
 * claims NEVER invoke storage again. No in-process loop substitutes for a durable
 * schedule; external dispatch must use this runner with reviewed server binding. */
export function createRecordingCleanupRunner(queue:RecordingCleanupQueue,worker:ReturnType<typeof createRecordingCleanupWorker>){
  return async(context:ProductionClinicalRequestContext,input:unknown,runId:string=randomUUID())=>{
    const request=cleanupRunRequestSchema.safeParse(input);
    if(!request.success||!uuid.safeParse(runId).success)throw new RecordingCleanupError('request_invalid');
    const claim=await queue.claim(context,request.data,runId);
    if(!claim.claimed)return {state:'already_claimed' as const,runId,recordingId:request.data.recordingId,audioDeleted:false as const,requiresRecheck:true as const};
    let outcome:CleanupRunOutcome='unavailable',acknowledged:number|null=null;
    try{
      if(Date.parse(claim.leaseUntil)<=Date.now())throw new RecordingCleanupError('not_ready');
      const raw=await worker(context,{...request.data,runId});
      const result=z.object({state:z.enum(['empty_observed','needs_recheck']),deleteAcknowledged:z.number().int().min(0).max(25),
        audioDeleted:z.literal(false),requiresRecheck:z.literal(true)}).strict().parse(raw);
      outcome=result.state;acknowledged=result.deleteAcknowledged;
    }catch(error){
      outcome=error instanceof RecordingCleanupError&&error.code==='legal_hold'?'held':
        error instanceof RecordingCleanupError&&['access_refused','request_invalid'].includes(error.code)?'refused':'unavailable';
    }
    const proof=createHash('sha256').update(JSON.stringify({runId,recordingId:request.data.recordingId,outcome,acknowledged})).digest('hex');
    return queue.finish(context,runId,request.data.recordingId,outcome,acknowledged,proof);
  };
}
