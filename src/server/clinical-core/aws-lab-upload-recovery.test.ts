import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const mocks=vi.hoisted(()=>({db:vi.fn(),s3:vi.fn(),sign:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',()=>{
  class Command{constructor(public input:Record<string,unknown>) {}}
  return {DynamoDBDocumentClient:{from:()=>({send:mocks.db})},GetCommand:class extends Command{},PutCommand:class extends Command{},UpdateCommand:class extends Command{},DeleteCommand:class extends Command{}};
});
vi.mock('@aws-sdk/client-s3',()=>{
  class Command{constructor(public input:Record<string,unknown>) {}}
  return {S3Client:class{send=mocks.s3;},PutObjectCommand:class extends Command{},HeadObjectCommand:class extends Command{},ListObjectsV2Command:class extends Command{},DeleteObjectsCommand:class extends Command{},ListObjectVersionsCommand:class extends Command{}};
});
vi.mock('@aws-sdk/s3-request-presigner',()=>({getSignedUrl:mocks.sign}));
import {createAwsLabAnalysisApiHandler} from './aws-lab-analysis-api';
const owner='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
const a='33333333-3333-4333-8333-333333333333',b='44444444-4444-4444-8444-444444444444';
const checksum=Buffer.alloc(32).toString('base64');
const doc=(id:string)=>({clientDocumentId:id,fileName:'fixture.pdf',contentType:'application/pdf',byteSize:100,checksumSHA256:checksum,objectKey:`fixture/${id}`});
const job=()=>({pk:`job#${jobId}`,ownerSub:owner,organizationId:owner,personId:owner,state:'awaiting_upload',expiresAt:Math.floor(Date.now()/1000)+600,documents:[doc(a),doc(b)]});
function event(path=`jobs/${jobId}/resume-upload`,claims:Record<string,string>={},body?:unknown){return {rawPath:`/clinical-core/consumer/labs/${path}`,
  ...(body?{body:JSON.stringify(body)}:{}),requestContext:{http:{method:'POST'},authorizer:{jwt:{claims:{sub:owner,'custom:organization_id':owner,'custom:person_id':owner,'custom:synthetic_attested':'true',...claims}}}}};}
const head=(id:string)=>({ContentLength:100,ContentType:'application/pdf',ServerSideEncryption:'aws:kms',SSEKMSKeyId:'fixture-key',ChecksumSHA256:checksum,
  Metadata:{'job-id':jobId,'document-id':id}});
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('LAB_JOB_TABLE','fixture');vi.stubEnv('LAB_DOCUMENT_BUCKET','fixture-bucket');vi.stubEnv('LAB_KMS_KEY_ARN','fixture-key');vi.stubEnv('LAB_RANGE_MODE','synthetic_fixture');
  mocks.db.mockResolvedValue({Item:job()});mocks.sign.mockResolvedValue('https://fixture.invalid/signed');
  mocks.s3.mockImplementation(async c=>{if(c.constructor.name==='ListObjectsV2Command')return {Contents:c.input.Prefix===doc(a).objectKey?[{Key:doc(a).objectKey}]:[]};if(c.input.Key===doc(a).objectKey)return head(a);throw Object.assign(new Error('missing'),{name:'NotFound'});});});
afterEach(()=>vi.unstubAllEnvs());
describe('owned checksum-bound upload recovery',()=>{
  it('signs only missing objects and returns verified already-uploaded IDs',async()=>{
    const response=await createAwsLabAnalysisApiHandler(event());expect(response.statusCode).toBe(200);
    const data=JSON.parse(response.body).data;expect(data.uploadedDocuments).toEqual([{clientDocumentId:a}]);expect(data.documents.map((d:{clientDocumentId:string})=>d.clientDocumentId)).toEqual([b]);
    expect(mocks.sign).toHaveBeenCalledOnce();const [,command,options]=mocks.sign.mock.calls[0];
    expect(command.input).toMatchObject({ChecksumSHA256:checksum,IfNoneMatch:'*',SSEKMSKeyId:'fixture-key'});
    expect(options.unhoistableHeaders.has('x-amz-checksum-sha256')).toBe(true);expect(options.signableHeaders.has('if-none-match')).toBe(true);
    expect(mocks.s3.mock.calls.find(([c])=>c.constructor.name==='HeadObjectCommand')![0].input.ChecksumMode).toBe('ENABLED');
    expect(mocks.db.mock.calls.every(([c])=>c.constructor.name==='GetCommand')).toBe(true);
  });
  it.each(['owner','organization','person','attestation'])('denies changed %s before signing',async kind=>{
    const claims:Record<string,string>=kind==='owner'?{sub:a}:kind==='organization'?{'custom:organization_id':a}:kind==='person'?{'custom:person_id':a}:{'custom:synthetic_attested':'false'};
    expect((await createAwsLabAnalysisApiHandler(event(undefined,claims))).statusCode).not.toBe(200);expect(mocks.sign).not.toHaveBeenCalled();expect(mocks.s3).not.toHaveBeenCalled();
  });
  it.each(['queued','completed','expired','legacy'])('does not renew %s jobs',async kind=>{
    const stored=job();if(kind==='expired')stored.expiresAt=0;else if(kind==='legacy')delete (stored.documents[0] as {checksumSHA256?:string}).checksumSHA256;else stored.state=kind;
    mocks.db.mockResolvedValue({Item:stored});expect((await createAwsLabAnalysisApiHandler(event())).statusCode).toBe(409);expect(mocks.sign).not.toHaveBeenCalled();
  });
  it.each(['checksum','key','type','size','metadata','access','network'])('does not interpret %s failure as a missing object',async kind=>{
    const value=head(a);if(kind==='checksum')value.ChecksumSHA256='bad';if(kind==='key')value.SSEKMSKeyId='wrong';if(kind==='type')value.ContentType='image/png';if(kind==='size')value.ContentLength=99;if(kind==='metadata')value.Metadata['job-id']=a;
    if(kind==='access'||kind==='network')mocks.s3.mockRejectedValue(Object.assign(new Error('private failure'),{name:kind==='access'?'AccessDenied':'TimeoutError'}));else mocks.s3.mockImplementation(async c=>c.constructor.name==='ListObjectsV2Command'?{Contents:[{Key:doc(a).objectKey}]}:value);
    const response=await createAwsLabAnalysisApiHandler(event());expect(response.statusCode).not.toBe(200);expect(response.body).not.toContain('private failure');expect(mocks.sign).not.toHaveBeenCalled();
  });
  it('accepts all-already-uploaded recovery without issuing writable links',async()=>{
    mocks.s3.mockImplementation(async c=>c.constructor.name==='ListObjectsV2Command'?{Contents:[{Key:c.input.Prefix}]}:head(c.input.Key===doc(a).objectKey?a:b));const response=await createAwsLabAnalysisApiHandler(event());
    expect(JSON.parse(response.body).data.documents).toEqual([]);expect(JSON.parse(response.body).data.uploadedDocuments).toHaveLength(2);expect(mocks.sign).not.toHaveBeenCalled();
  });
  it('checks the checksum again before completion can queue the job',async()=>{
    mocks.s3.mockResolvedValue({...head(a),ChecksumSHA256:'wrong'});
    expect((await createAwsLabAnalysisApiHandler(event(`jobs/${jobId}/complete-upload`,{}, {uploadedDocuments:[{clientDocumentId:a},{clientDocumentId:b}]}))).statusCode).not.toBe(200);
    expect(mocks.db.mock.calls.some(([c])=>c.constructor.name==='UpdateCommand')).toBe(false);
  });
  it('keeps both recovery routes authenticated',()=>{
    const template=JSON.parse(readFileSync('infra/aws-clinical-core/lab-analysis-extension.json','utf8'));
    expect(template.Resources.ResumeLabUploadRoute.Properties).toMatchObject({AuthorizationType:'JWT',AuthorizerId:{Ref:'LabConsumerAuthorizer'}});
    expect(template.Resources.ResumeLabUploadSyntheticSessionRoute.Properties).toMatchObject({AuthorizationType:'CUSTOM',AuthorizerId:{Ref:'LabSyntheticSessionAuthorizer'}});
  });
});
