import {beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({db:vi.fn(),s3:vi.fn(),transcribe:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async()=>{
  const actual=await vi.importActual<typeof import('@aws-sdk/lib-dynamodb')>('@aws-sdk/lib-dynamodb');
  return {...actual,DynamoDBDocumentClient:{from:()=>({send:mocks.db})}};
});
vi.mock('@aws-sdk/client-s3',async()=>{
  const actual=await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {...actual,S3Client:class{send=mocks.s3;}};
});
vi.mock('@aws-sdk/client-transcribe',async()=>{
  const actual=await vi.importActual<typeof import('@aws-sdk/client-transcribe')>('@aws-sdk/client-transcribe');
  return {...actual,TranscribeClient:class{send=mocks.transcribe;}};
});
import {createAwsVoiceService} from './aws-voice-jobs-lambda';
const id='a'.repeat(64);
const row={id,owner:'fictional',inputHash:'b'.repeat(64),format:'wav',state:'cleaned',cancelled:true,
  consentVersion:'patient-chat-consent/1',consentAcceptedAt:1000,createdAt:1000,readableUntil:1900,
  nextWork:2000,pending:'work',cleanupWatchVersion:'voice-cleanup-watch/1',lastCleanupAt:1500};
beforeEach(()=>{
  mocks.db.mockReset();mocks.s3.mockReset();mocks.transcribe.mockReset();
  mocks.db.mockResolvedValueOnce({Attributes:row}).mockResolvedValue({});
  mocks.s3.mockResolvedValue({});
});
describe('actual AWS voice repository cleanup-watch commands (mock transport)',()=>{
  it('reacquires cleaned rows, retains the due index and removes rather than extends TTL',async()=>{
    mocks.transcribe.mockResolvedValueOnce({TranscriptionJob:{TranscriptionJobStatus:'COMPLETED'}}).mockResolvedValue({});
    await createAwsVoiceService({mode:'synthetic',table:'fixture',bucket:'fixture',kms:'fixture'}).advance(id);
    const acquire=mocks.db.mock.calls[0][0].input,release=mocks.db.mock.calls[1][0].input;
    expect(acquire.ConditionExpression).toContain('attribute_exists(id)');
    expect(acquire.ConditionExpression).not.toContain(':cleaned');
    expect(release.UpdateExpression).toContain('pending = :work, cleanupWatchVersion = :watch, lastCleanupAt = :verified');
    expect(release.UpdateExpression).toContain('REMOVE leaseToken, leaseUntil, expiresAt');
    expect(release.ExpressionAttributeValues).toMatchObject({':state':'cleaned',':work':'work',':watch':'voice-cleanup-watch/1'});
    expect(release.ExpressionAttributeValues).not.toHaveProperty(':expires');
    expect(release.ExpressionAttributeValues[':due']).toBe(release.ExpressionAttributeValues[':verified']+86400);
  });
  it('does not advance verification or drop retry scheduling after an S3 failure',async()=>{
    mocks.transcribe.mockResolvedValueOnce({TranscriptionJob:{TranscriptionJobStatus:'COMPLETED'}}).mockResolvedValue({});
    mocks.s3.mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(createAwsVoiceService({mode:'synthetic',table:'fixture',bucket:'fixture',kms:'fixture'}).advance(id)).rejects.toThrow('synthetic failure');
    const release=mocks.db.mock.calls[1][0].input;
    expect(release.ExpressionAttributeValues).not.toHaveProperty(':verified');
    expect(release.UpdateExpression).not.toContain('pending');
    expect(release.ConditionExpression).toBe('leaseToken = :token');
  });
  it('keeps a late running provider job scheduled without trying to erase or restart it',async()=>{
    mocks.transcribe.mockResolvedValue({TranscriptionJob:{TranscriptionJobStatus:'IN_PROGRESS'}});
    await createAwsVoiceService({mode:'synthetic',table:'fixture',bucket:'fixture',kms:'fixture'}).advance(id);
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    expect(mocks.s3).not.toHaveBeenCalled();
    expect(mocks.db.mock.calls[1][0].input.ExpressionAttributeValues).not.toHaveProperty(':state');
  });
});
