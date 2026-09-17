import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({db:vi.fn(),s3:vi.fn(),transcribe:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async original=>({...await original<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:mocks.db})}}));
vi.mock('@aws-sdk/client-s3',async original=>({...await original<typeof import('@aws-sdk/client-s3')>(),S3Client:class{send=mocks.s3;}}));
vi.mock('@aws-sdk/client-transcribe',async original=>({...await original<typeof import('@aws-sdk/client-transcribe')>(),TranscribeClient:class{send=mocks.transcribe;}}));
import {createAwsVoiceService,handler} from './aws-voice-jobs-lambda';
import {voiceOwner} from './owned-voice-authorization';
import {OwnedStorageError} from './owned-consumer-records';
import type {ExternalDeletionGuard} from './owned-external-deletion';
import type {VoiceJob} from './voice-jobs';
import {createVoiceWorkBudget} from './voice-work-budget';
const id='a'.repeat(64),person='10000000-0000-4000-8000-000000000001',org='20000000-0000-4000-8000-000000000001',sub='fictional-voice-subject';
const owner=voiceOwner({actorPersonId:person,organizationId:org,identitySubject:sub});
let row:VoiceJob,objects:{Key:string;VersionId:string}[],locked:boolean,guardCalls:number;
let guard:ExternalDeletionGuard;
const policy={verify:vi.fn(async()=>{})};
const service=()=>createAwsVoiceService({mode:'production',table:'fictional-table',bucket:'fictional-bucket',kms:'fictional-key',policy,
  deletionGuard:(scope,work)=>guard(scope,work)});
beforeEach(()=>{
  vi.clearAllMocks();locked=false;guardCalls=0;
  const consent={revision:1,releaseVersion:'fictional/1',contentSha256:'b'.repeat(64)};
  row={id,owner,inputHash:'c'.repeat(64),format:'wav',state:'ready',cancelled:true,consentVersion:'patient-chat-consent/1',
    consentAcceptedAt:1000,createdAt:1000,readableUntil:1900,nextWork:1900,pending:'work',
    authorization:{version:'owned-voice/1',personId:person,organizationId:org,identitySubject:sub,consents:{ai_context:consent,voice_transcription:consent}}};
  objects=[{Key:`personal-voice/input/${id}.wav`,VersionId:'input-v1'},{Key:`personal-voice/output/${id}.json`,VersionId:'output-v1'}];
  guard=async(scope,work)=>{expect(scope).toEqual({personId:person,organizationId:org,ownerSub:sub});guardCalls++;locked=true;try{return await work();}finally{locked=false;}};
  mocks.db.mockImplementation(async c=>{
    if(c.constructor.name==='GetCommand')return {Item:structuredClone(row)};
    if(c.constructor.name==='QueryCommand')return {Items:[{id}]};
    const v=c.input.ExpressionAttributeValues;
    if(c.input.ReturnValues==='ALL_NEW'){
      if((row.leaseUntil??0)>=v[':now'])return {};
      row.leaseToken=v[':token'];row.leaseUntil=v[':until'];return {Attributes:structuredClone(row)};
    }
    if(v[':yes']){row.cancelled=true;row.nextWork=v[':now'];return {};}
    expect(row.leaseToken).toBe(v[':token']);
    if(v[':verified']!==undefined){
      expect(locked).toBe(true);expect(c.input.ConditionExpression).toContain('#owner = :owner AND #authorization = :authorization');
      expect(c.input.ExpressionAttributeNames['#authorization']).toBe('authorization');
      expect(v[':owner']).toBe(row.owner);expect(v[':authorization']).toEqual(row.authorization);
      row.lastCleanupAt=v[':verified'];row.cleanupWatchVersion=v[':watch'];
    }
    if(v[':state'])row.state=v[':state'];row.nextWork=v[':due'];delete row.leaseToken;delete row.leaseUntil;return {};
  });
  mocks.transcribe.mockImplementation(async c=>{
    if(c.constructor.name==='GetTranscriptionJobCommand')return {TranscriptionJob:{TranscriptionJobStatus:'COMPLETED'}};
    expect(c.constructor.name).toBe('DeleteTranscriptionJobCommand');expect(locked).toBe(true);return {};
  });
  mocks.s3.mockImplementation(async c=>{
    if(c.constructor.name==='ListObjectVersionsCommand')return {Versions:objects.filter(o=>o.Key.startsWith(c.input.Prefix))};
    expect(c.constructor.name).toBe('DeleteObjectsCommand');expect(locked).toBe(true);
    objects=objects.filter(o=>!c.input.Delete.Objects.some((v:{Key:string;VersionId:string})=>v.Key===o.Key&&v.VersionId===o.VersionId));return {};
  });
});
afterEach(()=>{vi.unstubAllEnvs();});
describe('production voice: real lifecycle and AWS commands with mocked transports',()=>{
  it('raises a synthetic scheduled failure instead of returning an HTTP error that the scheduler treats as success',async()=>{
    for(const [key,value] of Object.entries({DATA_CLASSIFICATION:'synthetic_only',PHI_ALLOWED:'false',VOICE_JOB_TABLE:'fictional',TRANSCRIPTION_BUCKET:'fictional',VOICE_KMS_KEY_ARN:'fictional'}))vi.stubEnv(key,value);
    mocks.db.mockRejectedValue(new Error('unavailable'));
    await expect(handler({source:'aws.events'},{getRemainingTimeInMillis:()=>30000})).rejects.toThrow('voice_sweep_retry_required');
  });
  it('paginates past leased jobs using the actual DynamoDB query continuation',async()=>{
    const base=mocks.db.getMockImplementation()!;
    const first=Array.from({length:25},(_,i)=>({id:i.toString(16).padStart(64,'0')}));
    const cursor={id:first.at(-1)!.id,pending:'work',nextWork:1};let pages=0;
    mocks.db.mockImplementation(async(c,options)=>{
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      if(c.constructor.name==='QueryCommand'){
        expect(c.input.Limit).toBe(25);expect(c.input.ScanIndexForward).toBe(true);
        if(++pages===1)return {Items:first,LastEvaluatedKey:cursor};
        expect(c.input.ExclusiveStartKey).toEqual(cursor);return {Items:[{id}]};
      }
      if(c.input.ReturnValues==='ALL_NEW'&&c.input.Key.id!==id){throw Object.assign(new Error('leased'),{name:'ConditionalCheckFailedException'});}
      return base(c,options);
    });
    expect(await service().sweep()).toMatchObject({attempted:26,pages:2,stopReason:'exhausted',backlogCleared:false});
    expect(row.state).toBe('cleaned');
    for(const [,options] of [...mocks.s3.mock.calls,...mocks.transcribe.mock.calls])expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });
  it('deadline between version batches preserves pending artifacts and releases the lease',async()=>{
    let remaining=30000;const budget=createVoiceWorkBudget(()=>remaining);
    const base=mocks.s3.getMockImplementation()!;
    mocks.s3.mockImplementation(async(c,options)=>{
      const result=await base(c,options);
      if(c.constructor.name==='DeleteObjectsCommand')remaining=4000;
      return result;
    });
    const bounded=createAwsVoiceService({mode:'production',table:'fictional',bucket:'fictional',kms:'fictional',policy,
      budget,deletionGuard:(scope,work)=>guard(scope,work)});
    await expect(bounded.advance(id)).rejects.toThrow('voice_work_deferred');
    expect(objects).toEqual([{Key:`personal-voice/output/${id}.json`,VersionId:'output-v1'}]);
    expect(row.lastCleanupAt).toBeUndefined();expect(row.state).toBe('ready');expect(row.pending).toBe('work');
    expect(row.leaseToken).toBeUndefined();
  });
  it('rechecks the deadline after waiting for the hold database before deleting remotely',async()=>{
    let remaining=30000;const budget=createVoiceWorkBudget(()=>remaining);
    guard=async(_scope,work)=>{remaining=4000;return work();};
    const bounded=createAwsVoiceService({mode:'production',table:'fictional',bucket:'fictional',kms:'fictional',policy,
      budget,deletionGuard:(scope,work)=>guard(scope,work)});
    await expect(bounded.advance(id)).rejects.toThrow('voice_work_deferred');
    expect(mocks.transcribe.mock.calls.every(([c])=>c.constructor.name==='GetTranscriptionJobCommand')).toBe(true);
    expect(objects).toHaveLength(2);expect(row.lastCleanupAt).toBeUndefined();expect(row.leaseToken).toBeUndefined();
  });
  it('guards provider deletion, both version batches and the cleanup receipt without regranting consent',async()=>{
    await service().advance(id);
    expect(guardCalls).toBe(5);expect(objects).toEqual([]);expect(row.state).toBe('cleaned');expect(row.lastCleanupAt).toBeTypeOf('number');
    expect(policy.verify).not.toHaveBeenCalled();
  });
  it.each(['legal_hold','owner_required','storage_unavailable'] as const)('retains all artifacts and retry state after %s',async code=>{
    guard=async()=>{throw new OwnedStorageError(code);};
    await expect(service().advance(id)).rejects.toThrow(code);
    expect(mocks.transcribe.mock.calls.every(([c])=>c.constructor.name==='GetTranscriptionJobCommand')).toBe(true);
    expect(mocks.s3).not.toHaveBeenCalled();expect(objects).toHaveLength(2);expect(row.state).toBe('ready');expect(row.lastCleanupAt).toBeUndefined();expect(row.pending).toBe('work');
    expect(row.leaseToken).toBeUndefined();
  });
  it('preserves output and refuses a receipt when a hold arrives after input removal',async()=>{
    const base=guard;let n=0;guard=async(s,work)=>{if(++n===4)throw new OwnedStorageError('legal_hold');return base(s,work);};
    await expect(service().advance(id)).rejects.toThrow('legal_hold');
    expect(objects).toEqual([{Key:`personal-voice/output/${id}.json`,VersionId:'output-v1'}]);expect(row.lastCleanupAt).toBeUndefined();
    expect(row.pending).toBe('work');
  });
  it('does not certify cleanup if a hold arrives just before the receipt write',async()=>{
    const base=guard;let n=0;guard=async(s,work)=>{if(++n===5)throw new OwnedStorageError('legal_hold');return base(s,work);};
    await expect(service().advance(id)).rejects.toThrow('legal_hold');
    expect(objects).toEqual([]);expect(row.state).toBe('ready');expect(row.lastCleanupAt).toBeUndefined();expect(row.pending).toBe('work');
  });
  it('logical cancellation remains immediate under a hold but cannot erase files',async()=>{
    row.cancelled=false;guard=async()=>{throw new OwnedStorageError('legal_hold');};
    expect(await service().cancel(owner,id)).toEqual({jobId:id,state:'cancelled'});
    expect(row.cancelled).toBe(true);expect(mocks.s3).not.toHaveBeenCalled();expect(mocks.transcribe).not.toHaveBeenCalled();
    await expect(service().advance(id)).rejects.toThrow('legal_hold');expect(objects).toHaveLength(2);
  });
  it.each(['missing','owner','subject','version'] as const)('refuses malformed persisted binding: %s',async kind=>{
    if(kind==='missing')delete row.authorization;
    else if(kind==='owner')row.owner='another-owner';
    else if(kind==='subject')row.authorization!.identitySubject='short';
    else row.authorization!.version='wrong' as 'owned-voice/1';
    await expect(service().advance(id)).rejects.toThrow('owner_required');expect(guardCalls).toBe(0);
    expect(mocks.s3).not.toHaveBeenCalled();expect(row.lastCleanupAt).toBeUndefined();
    expect(mocks.transcribe.mock.calls.every(([c])=>c.constructor.name==='GetTranscriptionJobCommand')).toBe(true);
  });
  it('refuses a production service without the hold guard before storage access',()=>{
    expect(()=>createAwsVoiceService({mode:'production',policy,table:'fictional',bucket:'fictional',kms:'fictional',deletionGuard:undefined as unknown as ExternalDeletionGuard})).toThrow('voice_configuration_refused');
    expect(mocks.db).not.toHaveBeenCalled();
  });
});
