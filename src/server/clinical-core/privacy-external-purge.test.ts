import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createExternalPurgeExecutor,type ExternalPurgeItem} from './privacy-external-purge';
import {OwnedStorageError} from './owned-consumer-records';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {S3Client} from '@aws-sdk/client-s3';
import type {VoiceJob} from './voice-jobs';
import type {ExternalDeletionGuard} from './owned-external-deletion';
import {voiceOwner} from './owned-voice-authorization';

const jobId='10000000-0000-4000-8000-000000000001',org='20000000-0000-4000-8000-000000000001',ownerId='30000000-0000-4000-8000-000000000001',ownerSub='40000000-0000-4000-8000-000000000001';
const scope={ownerId,ownerSub,organizationId:org};
const item=(patch:Partial<ExternalPurgeItem>={}):ExternalPurgeItem=>({kind:'lab_job',jobId,organizationId:org,inventoryState:'completed',attempts:0,...patch});
let rows:Map<string,Record<string,unknown>>;
const db={send:vi.fn()} as unknown as DynamoDBDocumentClient&{send:ReturnType<typeof vi.fn>};
const s3={send:vi.fn()} as unknown as S3Client&{send:ReturnType<typeof vi.fn>};
const guardMock=vi.fn(async(_scope:unknown,operation:()=>Promise<unknown>)=>operation());
const guard=guardMock as unknown as ExternalDeletionGuard;
const stopExecutions=vi.fn(async()=>{});
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv('LAB_OBJECT_PREFIX','personal-labs');
  rows=new Map([['job#'+jobId,{pk:'job#'+jobId,ownerSub,organizationId:org,personId:ownerId,state:'completed'}]]);
  s3.send.mockResolvedValue({Versions:[],DeleteMarkers:[]});
  db.send.mockImplementation(async(command:{constructor:{name:string};input:Record<string,unknown>})=>{
    const name=command.constructor.name,input=command.input;
    if(name==='GetCommand')return {Item:structuredClone(rows.get((input.Key as {pk:string}).pk))};
    if(name==='TransactWriteCommand'){
      const claim=(input.TransactItems as {Update:{ExpressionAttributeValues:Record<string,unknown>}}[])[0].Update.ExpressionAttributeValues;
      const job=rows.get('job#'+jobId);if(!job||job.ownerSub!==claim[':owner'])throw Object.assign(new Error('refused'),{name:'TransactionCanceledException'});
      job.state='deleting';const out=(input.TransactItems as {Update:{ExpressionAttributeValues:Record<string,unknown>}}[])[1].Update.ExpressionAttributeValues;
      rows.set('cleanup#'+jobId,{pk:'cleanup#'+jobId,ownerSub,organizationId:org,personId:ownerId,contractVersion:out[':version'],requestedAt:out[':now'],cleanupPartition:'pending',cleanupDue:out[':now'],...(out[':yes']?{stopRequired:true}:{})});
      return {};
    }
    if(name==='DeleteCommand'){rows.delete('job#'+jobId);return {};}
    if(name==='UpdateCommand'){const c=rows.get('cleanup#'+jobId)!;Object.assign(c,{cleanupPartition:'watching',lastVerifiedAt:(input.ExpressionAttributeValues as Record<string,string>)[':now']});delete c.stopRequired;return {};}
    throw new Error('unexpected '+name);
  });
});
const executor=()=>createExternalPurgeExecutor({lab:{db,s3,table:'labs',bucket:'lab-bucket',deletionGuard:guard,stopExecutions}});

describe('external purge executor: lab jobs',()=>{
  it('fences, purges and records a completed job through the outbox, and treats a later retry as already cleaned',async()=>{
    expect(await executor().purge('labs',scope,item())).toEqual({state:'cleaned',detail:'late_upload_watch'});
    expect(rows.has('job#'+jobId)).toBe(false);expect(rows.get('cleanup#'+jobId)).toMatchObject({cleanupPartition:'watching'});
    expect(stopExecutions).not.toHaveBeenCalled();
    expect(await executor().purge('labs',scope,item({kind:'lab_cleanup',attempts:1}))).toEqual({state:'cleaned',detail:'late_upload_watch'});
  });
  it('cancels unfinished work with a stop request and reports absent jobs as not found',async()=>{
    rows.get('job#'+jobId)!.state='extracting';
    expect(await executor().purge('labs',scope,item({inventoryState:'extracting'}))).toEqual({state:'cleaned',detail:'late_upload_watch'});
    expect(stopExecutions).toHaveBeenCalledWith(jobId);
    rows.clear();
    expect(await executor().purge('labs',scope,item())).toEqual({state:'not_found',detail:'no job or cleanup record remains'});
    expect(await executor().purge('labs',scope,item({kind:'lab_cleanup'}))).toEqual({state:'not_found',detail:'no job or cleanup record remains'});
  });
  it('refuses another owner, a mismatched scope, a legal hold and unconfirmed cleanup without deleting anything',async()=>{
    rows.get('job#'+jobId)!.ownerSub='someone-else';
    expect(await executor().purge('labs',scope,item())).toEqual({state:'refused',detail:'owner_mismatch'});
    rows.get('job#'+jobId)!.ownerSub=ownerSub;
    expect(await executor().purge('labs',{...scope,organizationId:ownerId},item())).toEqual({state:'refused',detail:'scope_mismatch'});
    guardMock.mockRejectedValueOnce(new OwnedStorageError('legal_hold'));
    expect(await executor().purge('labs',scope,item())).toEqual({state:'refused',detail:'legal_hold'});
    expect(rows.get('job#'+jobId)).toMatchObject({state:'completed'});
    s3.send.mockResolvedValue({Versions:[{Key:`personal-labs/${org}/${ownerSub}/${jobId}/document.pdf`,VersionId:'v'}],Errors:[{Key:'x'}]});
    const outcome=await executor().purge('labs',scope,item());
    expect(outcome.state).toBe('refused');expect(outcome.detail).toBe('cleanup_retry_required');
    expect(await executor().purge('labs',scope,item({kind:'voice_job',jobId:'a'.repeat(64)}))).toEqual({state:'refused',detail:'item_kind_invalid'});
    expect(await createExternalPurgeExecutor({}).purge('labs',scope,item())).toEqual({state:'refused',detail:'lab_store_not_configured'});
  });
});

describe('external purge executor: voice jobs',()=>{
  const voiceId='b'.repeat(64);
  const authorization={version:'owned-voice/1' as const,personId:ownerId,organizationId:org,identitySubject:ownerSub,
    consents:{ai_context:{revision:1,releaseVersion:'r',contentSha256:'a'.repeat(64)},voice_transcription:{revision:1,releaseVersion:'r',contentSha256:'a'.repeat(64)}}};
  const owner=voiceOwner({actorPersonId:ownerId,organizationId:org,identitySubject:ownerSub});
  let job:VoiceJob|undefined;
  const vdb={send:vi.fn(async()=>({Item:job?structuredClone(job):undefined}))} as unknown as DynamoDBDocumentClient;
  const service={cancel:vi.fn(async()=>{job!.cancelled=true;}),advance:vi.fn(async()=>{if(job)job.state='cleaned';})};
  const voiceItem=item({kind:'voice_job',jobId:voiceId});
  beforeEach(()=>{job={id:voiceId,owner,inputHash:'h',format:'mp4',state:'ready',consentVersion:'c',consentAcceptedAt:1,createdAt:1,readableUntil:2,cancelled:false,nextWork:1,authorization} as VoiceJob;});
  const vexec=()=>createExternalPurgeExecutor({voice:{db:vdb,table:'voice',service}});
  it('cancels, advances cleanup under the guarded worker path and reports the retained tombstone',async()=>{
    expect(await vexec().purge('voice',scope,voiceItem)).toEqual({state:'cleaned',detail:'objects removed; cleanup tombstone retained'});
    expect(service.cancel).toHaveBeenCalledWith(owner,voiceId);expect(service.advance).toHaveBeenCalledWith(voiceId);
    service.cancel.mockClear();
    expect(await vexec().purge('voice',scope,voiceItem)).toEqual({state:'cleaned',detail:'cleanup tombstone retained'});
    expect(service.cancel).not.toHaveBeenCalled();
  });
  it('keeps a still-processing provider job claimed, reports missing jobs, and refuses other owners',async()=>{
    service.advance.mockImplementationOnce(async()=>{});
    expect(await vexec().purge('voice',scope,voiceItem)).toEqual({state:'claimed',detail:'cancelled; provider still processing'});
    job=undefined;
    expect(await vexec().purge('voice',scope,voiceItem)).toEqual({state:'not_found',detail:'no voice job record remains'});
    job={id:voiceId,owner,inputHash:'h',format:'mp4',state:'ready',consentVersion:'c',consentAcceptedAt:1,createdAt:1,readableUntil:2,cancelled:false,nextWork:1,authorization} as VoiceJob;
    expect(await vexec().purge('voice',{...scope,ownerSub:'50000000-0000-4000-8000-000000000001'},voiceItem)).toEqual({state:'refused',detail:'owner_mismatch'});
    service.cancel.mockRejectedValueOnce(new OwnedStorageError('legal_hold'));
    expect(await vexec().purge('voice',scope,voiceItem)).toEqual({state:'refused',detail:'legal_hold'});
    expect(await vexec().purge('voice',scope,item())).toEqual({state:'refused',detail:'item_kind_invalid'});
  });
});
