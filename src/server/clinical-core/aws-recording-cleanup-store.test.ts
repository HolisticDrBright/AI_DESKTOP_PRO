import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {S3Client} from '@aws-sdk/client-s3';
import {createAwsRecordingCleanupStore} from './aws-recording-cleanup-store';
import type {RecordingCleanupAdmission} from './recording-cleanup-authority';
function fixture(){
  const a={organizationId:randomUUID(),recordingId:randomUUID(),sessionId:randomUUID(),storage:{bucket:'fictional-bucket',expectedBucketOwner:'123456789012',region:'us-east-2'},
    inventory:[{objectKey:'exact-key',segmentId:randomUUID()}]} as RecordingCleanupAdmission;
  const v={key:'exact-key',version:'exact-version',kind:'object' as const};
  const responses:Record<string,unknown>={GetBucketVersioningCommand:{Status:'Enabled'},GetObjectLockConfigurationCommand:{ObjectLockConfiguration:{ObjectLockEnabled:'Enabled'}},
    ListObjectVersionsCommand:{Versions:[{Key:v.key,VersionId:v.version}],IsTruncated:false},
    HeadObjectCommand:{VersionId:v.version},GetObjectLegalHoldCommand:{LegalHold:{Status:'OFF'}},GetObjectRetentionCommand:{Retention:{}},DeleteObjectCommand:{VersionId:v.version}};
  const send=vi.fn(async(command:{constructor:{name:string};input:unknown})=>{
    const value=responses[command.constructor.name];if(value instanceof Error)throw value;return value;
  });
  const store=createAwsRecordingCleanupStore(()=>({send}) as unknown as S3Client);
  return {a,v,responses,send,store,signal:new AbortController().signal};
}
describe('AWS recording cleanup adapter',()=>{
  it('pins owner/prefix and qualifies versioning and Object Lock before listing',async()=>{
    const f=fixture();expect((await f.store.list(f.a,f.signal)).versions).toEqual([f.v]);
    expect(f.send.mock.calls.map(c=>c[0].constructor.name)).toEqual(['GetBucketVersioningCommand','GetObjectLockConfigurationCommand','ListObjectVersionsCommand']);
    expect(f.send.mock.calls.at(-1)?.[0].input).toEqual({Bucket:'fictional-bucket',ExpectedBucketOwner:'123456789012',
      Prefix:`encounter-recordings/${f.a.organizationId}/${f.a.recordingId}/${f.a.sessionId}/`,MaxKeys:100});
  });
  it.each(['GetBucketVersioningCommand','GetObjectLockConfigurationCommand'])('refuses incomplete %s qualification',async name=>{
    const f=fixture();f.responses[name]={};await expect(f.store.list(f.a,f.signal)).rejects.toThrow();
    expect(f.send.mock.calls.some(c=>c[0].constructor.name==='ListObjectVersionsCommand')).toBe(false);
  });
  it('uses explicit legal-hold and retention reads; missing permissions/state never becomes OFF',async()=>{
    const f=fixture();expect(await f.store.inspect(f.a,f.v,f.signal)).toMatchObject({legalHold:'OFF',retentionVerified:true});
    expect(f.send.mock.calls.map(c=>c[0].constructor.name)).toEqual(['HeadObjectCommand','GetObjectLegalHoldCommand','GetObjectRetentionCommand']);
    f.responses.GetObjectLegalHoldCommand=new Error('AccessDenied');await expect(f.store.inspect(f.a,f.v,f.signal)).rejects.toThrow();
    f.responses.GetObjectLegalHoldCommand={};await expect(f.store.inspect(f.a,f.v,f.signal)).rejects.toThrow();
  });
  it('requires an attempt and sends only an exact version delete without governance bypass',async()=>{
    const f=fixture();await expect(f.store.remove(f.a,f.v,f.signal)).rejects.toThrow();expect(f.send).not.toHaveBeenCalled();
    f.a.attempt={id:randomUUID(),segmentId:f.a.inventory[0].segmentId,objectVersion:f.v.version,kind:'object',evidenceSha256:'a'.repeat(64)};
    expect(await f.store.remove(f.a,f.v,f.signal)).toMatchObject({version:f.v.version});
    expect(f.send.mock.calls[0][0].input).toEqual({Bucket:'fictional-bucket',ExpectedBucketOwner:'123456789012',Key:f.v.key,VersionId:f.v.version});
    await expect(f.store.remove(f.a,{...f.v,version:'null'},f.signal)).rejects.toThrow();
    await expect(f.store.remove(f.a,{...f.v,key:'other-key'},f.signal)).rejects.toThrow();
  });
  it('does not continue SDK calls after cancellation is ignored by an earlier request',async()=>{
    const f=fixture(),controller=new AbortController();
    f.send.mockImplementationOnce(async()=>{controller.abort();return {Status:'Enabled'};});
    await expect(f.store.list(f.a,controller.signal)).rejects.toThrow();expect(f.send).toHaveBeenCalledTimes(1);
  });
});
