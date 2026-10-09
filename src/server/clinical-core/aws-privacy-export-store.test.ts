import {describe,expect,it} from 'vitest';
import {createAwsPrivacyExportStore} from './aws-privacy-export-store';
import {compositeChecksum} from './owned-privacy-export-job';
import {createHash} from 'node:crypto';

// The S3 client is replaced by a fictional command recorder: these cases pin the request shapes (pagination markers,
// checksum mode, versioned deletes, expected bucket owner) and the response handling (delete markers, 404 as absence,
// 403 as a thrown refusal) that the hosted run must then confirm against a real bucket. No AWS call is made.
const storage={bucket:'fictional-export-bucket',region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111',expectedBucketOwner:'123456789012'};
type Seen={name:string;input:Record<string,unknown>};
function client(respond:(seen:Seen,index:number)=>unknown){
  const calls:Seen[]=[];
  return {calls,store:createAwsPrivacyExportStore(()=>({send:async(command:unknown)=>{
    const seen={name:(command as {constructor:{name:string}}).constructor.name,input:(command as {input:Record<string,unknown>}).input};
    calls.push(seen);const r=respond(seen,calls.length-1);if(r instanceof Error)throw r;return r;}}) as never)};
}
const signal=new AbortController().signal;
describe('AWS privacy export store request contracts',()=>{
  it('lists multipart uploads by key prefix across pages with both markers, pinning the bucket owner, and refuses a prefix outside personal-exports',async()=>{
    const {calls,store}=client((seen,i)=>seen.name!=='ListMultipartUploadsCommand'?new Error('unexpected'):i===0
      ?{Uploads:[{Key:'personal-exports/a/x.json',UploadId:'u1'}],IsTruncated:true,NextKeyMarker:'personal-exports/a/x.json',NextUploadIdMarker:'u1'}
      :{Uploads:[{Key:'personal-exports/a/x.json',UploadId:'u2'},{Key:undefined,UploadId:'ignored'}],IsTruncated:false});
    expect(await store.listUploads(storage,'personal-exports/a/x.json',signal)).toEqual([{key:'personal-exports/a/x.json',uploadId:'u1'},{key:'personal-exports/a/x.json',uploadId:'u2'}]);
    expect(calls[0].input).toMatchObject({Bucket:storage.bucket,ExpectedBucketOwner:storage.expectedBucketOwner,Prefix:'personal-exports/a/x.json',MaxUploads:1000});
    expect(calls[1].input).toMatchObject({KeyMarker:'personal-exports/a/x.json',UploadIdMarker:'u1'});
    await expect(store.listUploads(storage,'personal-labs/x',signal)).rejects.toThrow('privacy_export_prefix_invalid');
  });
  it('lists versions and delete markers across pages and fails closed when a listing never terminates',async()=>{
    const {calls,store}=client((seen,i)=>seen.name!=='ListObjectVersionsCommand'?new Error('unexpected'):i===0
      ?{Versions:[{Key:'k.json',VersionId:'v1',Size:10}],DeleteMarkers:[{Key:'k.json',VersionId:'m1'}],IsTruncated:true,NextKeyMarker:'k.json',NextVersionIdMarker:'m1'}
      :{Versions:[{Key:'k.json.staging',VersionId:'v2'}],IsTruncated:false});
    expect(await store.listVersions(storage,'personal-exports/k.json',signal)).toEqual([
      {key:'k.json',version:'v1',bytes:10,deleteMarker:false},{key:'k.json',version:'m1',bytes:null,deleteMarker:true},{key:'k.json.staging',version:'v2',bytes:null,deleteMarker:false}]);
    expect(calls[1].input).toMatchObject({KeyMarker:'k.json',VersionIdMarker:'m1',Prefix:'personal-exports/k.json'});
    const endless=client(()=>({Versions:[],IsTruncated:true,NextKeyMarker:'k'}));
    await expect(endless.store.listVersions(storage,'personal-exports/k.json',signal)).rejects.toThrow('privacy_export_listing_truncated');
    expect(endless.calls).toHaveLength(20);
  });
  it('requests the checksum only when asked, treats 404 as absence and rethrows a 403',async()=>{
    const {calls,store}=client((seen,i)=>{
      if(i===0)return {ContentLength:5,ServerSideEncryption:'aws:kms',SSEKMSKeyId:storage.kmsKeyArn,ChecksumSHA256:'abc=-2'};
      if(i===1)return {ContentLength:5,ServerSideEncryption:'aws:kms',SSEKMSKeyId:storage.kmsKeyArn,ChecksumSHA256:'leaked-if-returned'};
      if(i===2)return Object.assign(new Error('NotFound'),{name:'NotFound',$metadata:{httpStatusCode:404}});
      return Object.assign(new Error('AccessDenied'),{name:'AccessDenied',$metadata:{httpStatusCode:403}});
    });
    expect(await store.head(storage,'personal-exports/k.json','v1',signal,{checksum:true})).toEqual({exists:true,bytes:5,encryption:'aws:kms',kmsKeyArn:storage.kmsKeyArn,checksum:'abc=-2'});
    expect(calls[0].input).toMatchObject({VersionId:'v1',ChecksumMode:'ENABLED'});
    expect(await store.head(storage,'personal-exports/k.json','v1',signal)).toEqual({exists:true,bytes:5,encryption:'aws:kms',kmsKeyArn:storage.kmsKeyArn});
    expect(calls[1].input).not.toHaveProperty('ChecksumMode');
    expect(await store.head(storage,'personal-exports/k.json','gone',signal)).toEqual({exists:false});
    await expect(store.head(storage,'personal-exports/k.json','denied',signal)).rejects.toThrow('AccessDenied');
  });
  it('sends part checksums, completes with the recorded composite parts, and deletes only by exact version',async()=>{
    const part=Buffer.from('hello'),sha=createHash('sha256').update(part).digest('hex');
    const {calls,store}=client(seen=>seen.name==='CreateMultipartUploadCommand'?{UploadId:'u'}:seen.name==='UploadPartCommand'?{ETag:'"e"'}
      :seen.name==='CompleteMultipartUploadCommand'?{VersionId:'v9',ChecksumSHA256:compositeChecksum([sha])}:seen.name==='DeleteObjectCommand'?{}:new Error('unexpected'));
    expect(await store.createUpload(storage,'personal-exports/k.json',signal)).toEqual({uploadId:'u'});
    expect(calls[0].input).toMatchObject({ServerSideEncryption:'aws:kms',SSEKMSKeyId:storage.kmsKeyArn,ChecksumAlgorithm:'SHA256',ExpectedBucketOwner:storage.expectedBucketOwner});
    await store.uploadPart(storage,'personal-exports/k.json','u',1,part,sha,signal);
    expect(calls[1].input).toMatchObject({PartNumber:1,ContentLength:5,ChecksumSHA256:Buffer.from(sha,'hex').toString('base64')});
    const completed=await store.completeUpload(storage,'personal-exports/k.json','u',[{partNumber:1,etag:'"e"',sha256Hex:sha}],signal);
    expect(completed).toEqual({version:'v9',checksum:compositeChecksum([sha])});
    expect(calls[2].input).toMatchObject({MultipartUpload:{Parts:[{PartNumber:1,ETag:'"e"',ChecksumSHA256:Buffer.from(sha,'hex').toString('base64')}]}});
    await store.deleteVersion(storage,'personal-exports/k.json','v9',signal);
    expect(calls[3].input).toEqual({Bucket:storage.bucket,Key:'personal-exports/k.json',ExpectedBucketOwner:storage.expectedBucketOwner,VersionId:'v9'});
  });
  it('the composite checksum equals S3 rule: base64(sha256(concat(raw part digests)))-count',()=>{
    const a=createHash('sha256').update('a').digest(),b=createHash('sha256').update('b').digest();
    expect(compositeChecksum([a.toString('hex'),b.toString('hex')])).toBe(createHash('sha256').update(Buffer.concat([a,b])).digest('base64')+'-2');
    expect(compositeChecksum([b.toString('hex'),a.toString('hex')])).not.toBe(compositeChecksum([a.toString('hex'),b.toString('hex')]));
  });
});
