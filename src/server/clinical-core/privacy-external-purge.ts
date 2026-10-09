import {GetCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {S3Client} from '@aws-sdk/client-s3';
import {claimLabDeletion,reconcileLabDeletion} from './lab-deletion-cleanup';
import {OwnedStorageError} from './owned-consumer-records';
import type {ExternalDeletionGuard} from './owned-external-deletion';
import {ownedVoiceDeletionScope} from './owned-voice-deletion';
import type {VoiceJob} from './voice-jobs';

/** Executes the guarded deletion of one inventoried external job for the
 * privacy operations worker. Identities come from the reviewed inventory and
 * the request's owner scope, never from the caller. Each remote mutation runs
 * under the owner hold/identity guard, so a legal hold or closed identity
 * refuses rather than deletes. Outcomes are what the store confirmed: lab
 * objects stay under the outbox's late-upload watch and voice keeps its cleanup
 * tombstone, which is why the store outcome is tombstoned, never purged. */
export type ExternalPurgeItem={kind:'lab_job'|'lab_cleanup'|'voice_job';jobId:string;organizationId:string;inventoryState:string;attempts:number};
export type ExternalPurgeScope={ownerId:string;ownerSub:string;organizationId:string};
export type ExternalPurgeOutcome={state:'cleaned'|'claimed'|'not_found'|'refused';detail:string};
export type ExternalPurgeExecutor={purge:(store:'labs'|'voice',scope:ExternalPurgeScope,item:ExternalPurgeItem)=>Promise<ExternalPurgeOutcome>};
export type LabPurgeDependencies={db:DynamoDBDocumentClient;s3:S3Client;table:string;bucket:string;deletionGuard:ExternalDeletionGuard;
  stopExecutions:(jobId:string)=>Promise<void>;now?:()=>number};
export type VoicePurgeDependencies={db:DynamoDBDocumentClient;table:string;
  service:{cancel(owner:string,id:string):Promise<unknown>;advance(id:string):Promise<void>}};
const ACTIVE=new Set(['awaiting_upload','queued','extracting','verifying','normalizing','interpreting','synthesizing']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const refused=(detail:string):ExternalPurgeOutcome=>({state:'refused',detail});
function failure(error:unknown):ExternalPurgeOutcome{
  if(error instanceof OwnedStorageError)return refused(error.code==='legal_hold'?'legal_hold':error.code==='owner_required'?'owner_required':'storage_unavailable');
  const name=(error as {name?:unknown})?.name;
  if(name==='TransactionCanceledException'||name==='ConditionalCheckFailedException')return refused('state_conflict');
  const message=error instanceof Error?error.message:'';
  if(/lab_cleanup_state_conflict/.test(message))return refused('lease_active_retry_later');
  if(/lab_cleanup_retry_required/.test(message))return refused('cleanup_retry_required');
  return refused('deletion_retry_required');
}
export function createExternalPurgeExecutor(deps:{lab?:LabPurgeDependencies;voice?:VoicePurgeDependencies}):ExternalPurgeExecutor{
  return {async purge(store,scope,item){
    if(!uuid.test(scope.ownerId)||!uuid.test(scope.organizationId)||!/^[A-Za-z0-9:_-]{8,128}$/.test(scope.ownerSub)
      ||scope.organizationId.toLowerCase()!==item.organizationId.toLowerCase())return refused('scope_mismatch');
    if(store==='labs'){
      if(!deps.lab)return refused('lab_store_not_configured');
      if(item.kind==='voice_job'||!uuid.test(item.jobId))return refused('item_kind_invalid');
      return purgeLab(deps.lab,scope,item);
    }
    if(!deps.voice)return refused('voice_store_not_configured');
    if(item.kind!=='voice_job'||!/^[a-f0-9]{64}$/.test(item.jobId))return refused('item_kind_invalid');
    return purgeVoice(deps.voice,scope,item);
  }};
}
async function purgeLab(lab:LabPurgeDependencies,scope:ExternalPurgeScope,item:ExternalPurgeItem):Promise<ExternalPurgeOutcome>{
  const owner={ownerSub:scope.ownerSub,organizationId:scope.organizationId,personId:scope.ownerId};
  const cleanupDeps={db:lab.db,s3:lab.s3,table:lab.table,bucket:lab.bucket,deletionGuard:lab.deletionGuard,stopExecutions:lab.stopExecutions,...(lab.now?{now:lab.now}:{})};
  try{
    let present=false;
    if(item.kind==='lab_job'){
      const current=await lab.db.send(new GetCommand({TableName:lab.table,Key:{pk:'job#'+item.jobId},ConsistentRead:true}),{abortSignal:AbortSignal.timeout(4000)});
      const row=current.Item as {ownerSub?:unknown;organizationId?:unknown;personId?:unknown;state?:unknown}|undefined;
      if(row){
        if(row.ownerSub!==owner.ownerSub||String(row.organizationId).toLowerCase()!==owner.organizationId.toLowerCase()||String(row.personId).toLowerCase()!==owner.personId.toLowerCase())return refused('owner_mismatch');
        present=true;
        // Unfinished work is cancelled (fence + stop); finished work is deleted. Both go through the durable outbox.
        await claimLabDeletion(cleanupDeps,owner,item.jobId,ACTIVE.has(String(row.state)));
      }
    }
    const cleanup=await reconcileLabDeletion(cleanupDeps,item.jobId,owner);
    if(!cleanup)return present?{state:'claimed',detail:'cleanup_outbox_not_readable'}:{state:'not_found',detail:'no job or cleanup record remains'};
    return {state:'cleaned',detail:cleanup.cleanupStatus};
  }catch(error){return failure(error);}
}
async function purgeVoice(voice:VoicePurgeDependencies,scope:ExternalPurgeScope,item:ExternalPurgeItem):Promise<ExternalPurgeOutcome>{
  try{
    const read=async()=>(await voice.db.send(new GetCommand({TableName:voice.table,Key:{id:item.jobId},ConsistentRead:true}),{abortSignal:AbortSignal.timeout(4000)})).Item as VoiceJob|undefined;
    const job=await read();
    if(!job)return {state:'not_found',detail:'no voice job record remains'};
    const binding=ownedVoiceDeletionScope(job);
    if(binding.personId.toLowerCase()!==scope.ownerId.toLowerCase()||binding.ownerSub!==scope.ownerSub)return refused('owner_mismatch');
    if(job.state==='cleaned')return {state:'cleaned',detail:'cleanup tombstone retained'};
    if(!job.cancelled)await voice.service.cancel(job.owner,item.jobId);
    // Cleanup runs through the same guarded worker path as the sweep; a provider
    // job still processing cannot be deleted yet and stays claimed for retry.
    await voice.service.advance(item.jobId);
    const after=await read();
    if(!after)return {state:'not_found',detail:'voice job record removed during cleanup'};
    return after.state==='cleaned'?{state:'cleaned',detail:'objects removed; cleanup tombstone retained'}:{state:'claimed',detail:'cancelled; provider still processing'};
  }catch(error){return failure(error);}
}
