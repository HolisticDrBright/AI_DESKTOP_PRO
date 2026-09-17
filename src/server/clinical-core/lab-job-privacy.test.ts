import {createHash} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createLabJobPrivacy,type LabPrivacyDeps} from './lab-job-privacy';

const jobId='11111111-1111-4111-8111-111111111111',documentId='22222222-2222-4222-8222-222222222222';
const scope={ownerSub:'33333333-3333-4333-8333-333333333333',organizationId:'44444444-4444-4444-8444-444444444444',personId:'55555555-5555-4555-8555-555555555555'};
const now=Date.parse('2026-09-16T12:00:00Z'),checksum=Buffer.alloc(32,1).toString('base64'),kms='arn:aws:kms:us-east-2:123456789012:key/fictional';
const objectKey=`personal-labs/${scope.organizationId}/${scope.ownerSub}/${jobId}/${documentId}/fictional.pdf`;
function fixture(){return {pk:'job#'+jobId,...scope,dataClassification:'personal_health_record',state:'completed',
  createdAt:new Date(now-1000).toISOString(),updatedAt:new Date(now).toISOString(),expiresAt:now/1000-1,
  documents:[{clientDocumentId:documentId,fileName:'fictional.pdf',contentType:'application/pdf',byteSize:100,checksumSHA256:checksum,objectKey}],
  passesCompleted:5,progressPercent:100,attempt:1,failureCategory:null,result:{biomarkers:[{name:'fictional',value:0}]},
  structuredBiomarkers:[{name:'fictional',value:0}],patientContext:{age:40},authorization:{secret:'not-exportable'},leaseToken:'not-exportable',
  inventoryOwner:'not-exportable',executionArn:'not-exportable'};}
let row:Record<string,unknown>,deps:LabPrivacyDeps;
beforeEach(()=>{row=fixture();deps={classification:'personal_health_record',prefix:'personal-labs',kmsKeyArn:kms,now:()=>now,
  read:vi.fn(async()=>structuredClone(row)),revalidate:vi.fn(async()=>{}),
  head:vi.fn(async()=>({ContentLength:100,ContentType:'application/pdf',Metadata:{'job-id':jobId,'document-id':documentId},ChecksumSHA256:checksum,
    ServerSideEncryption:'aws:kms',SSEKMSKeyId:kms,VersionId:'version-1',ETag:'"abc123"'})),
  sign:vi.fn(async()=>'https://fictional.s3.us-east-2.amazonaws.com/version-pinned')};});
describe('owner-only retained lab privacy copies',()=>{
  it('exports retained expired processing inputs/results without processing, object keys or credentials',async()=>{
    const out=await createLabJobPrivacy(deps).copy(scope,jobId);
    expect(out.coverage.completeAccountExport).toBe(false);expect(out.coverage.excluded).toContain('original_document_bytes');
    expect(out.record.result).toEqual({biomarkers:[{name:'fictional',value:0}]});
    expect(out.record).toMatchObject({structuredBiomarkers:[{name:'fictional',value:0}]});
    expect(JSON.stringify(out)).not.toMatch(/not-exportable|objectKey|personal-labs|authorization/);
    expect(out.recordSha256).toBe(createHash('sha256').update(JSON.stringify(out.record)).digest('hex'));
    expect(deps.read).toHaveBeenCalledExactlyOnceWith(jobId);expect(deps.revalidate).toHaveBeenCalledTimes(2);
    expect(deps.head).not.toHaveBeenCalled();expect(deps.sign).not.toHaveBeenCalled();
  });
  it.each(['ownerSub','organizationId','personId'] as const)('denies a different %s',async key=>{
    await expect(createLabJobPrivacy(deps).copy({...scope,[key]:documentId},jobId)).rejects.toMatchObject({code:'lab_privacy_not_found',status:404});
    expect(deps.sign).not.toHaveBeenCalled();
  });
  it.each(['synthetic_only',undefined])('denies other or legacy classification %s',async classification=>{
    row.dataClassification=classification;await expect(createLabJobPrivacy(deps).copy(scope,jobId)).rejects.toMatchObject({status:404});
  });
  it('rejects a missing job and revoked identity without returning data',async()=>{
    vi.mocked(deps.read).mockResolvedValueOnce(undefined);
    await expect(createLabJobPrivacy(deps).copy(scope,jobId)).rejects.toMatchObject({status:404});
    vi.mocked(deps.revalidate).mockRejectedValueOnce(new Error('owner_required'));
    await expect(createLabJobPrivacy(deps).copy(scope,jobId)).rejects.toThrow('owner_required');
    expect(deps.read).toHaveBeenCalledTimes(1);
  });
  it.each(['copy','document'] as const)('revalidates identity after reading on %s',async method=>{
    vi.mocked(deps.revalidate).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('owner_required'));
    await expect(createLabJobPrivacy(deps)[method](scope,jobId,documentId)).rejects.toThrow('owner_required');
    expect(deps.head).not.toHaveBeenCalled();expect(deps.sign).not.toHaveBeenCalled();
  });
  it.each([
    {state:'deleting'},{pk:'job#'+documentId},{progressPercent:101},{documents:[fixture().documents[0],fixture().documents[0]]},
    {documents:[{...fixture().documents[0],objectKey:'personal-labs/other-owner/private.pdf'}]},
    {documents:[{...fixture().documents[0],fileName:'../private.pdf'}]},
  ])('refuses malformed or deleting record %j',async patch=>{
    Object.assign(row,patch);await expect(createLabJobPrivacy(deps).copy(scope,jobId)).rejects.toMatchObject({status:patch.state?409:503});
  });
  it('bounds the exported bytes and validates job IDs and namespace configuration',async()=>{
    row.result={large:'x'.repeat(512*1024)};
    await expect(createLabJobPrivacy(deps).copy(scope,jobId)).rejects.toMatchObject({status:503});
    await expect(createLabJobPrivacy(deps).copy(scope,'bad')).rejects.toMatchObject({status:400});
    expect(()=>createLabJobPrivacy({...deps,prefix:'synthetic-labs'})).toThrow('lab_privacy_namespace_invalid');
  });
});
describe('version-pinned original-document privacy downloads',()=>{
  it('signs only a verified owner object version for 60 seconds with a generic filename',async()=>{
    const out=await createLabJobPrivacy(deps).document(scope,jobId,documentId);
    expect(deps.head).toHaveBeenCalledExactlyOnceWith(objectKey);
    expect(deps.sign).toHaveBeenCalledExactlyOnceWith({key:objectKey,versionId:'version-1',etag:'"abc123"',contentType:'application/pdf',downloadName:`alp-lab-document-${documentId}.pdf`,seconds:60});
    expect(out.requiredHeaders).toEqual({'if-match':'"abc123"'});expect(out.checksumSHA256).toBe(checksum);
    expect(out.expiresAt).toBe(new Date(now+60000).toISOString());expect(out.downloadName).not.toContain('fictional');
    expect(deps.read).toHaveBeenCalledTimes(3);expect(deps.revalidate).toHaveBeenCalledTimes(6);
  });
  it.each([{ContentLength:101},{ContentType:'text/html'},{Metadata:{}},{ChecksumSHA256:'wrong'},
    {ServerSideEncryption:'AES256'},{SSEKMSKeyId:'other'},{VersionId:undefined},{VersionId:'null'},{VersionId:''},{ETag:'bad'},
    {DeleteMarker:true}])('refuses unsafe head metadata %j',async patch=>{
    const head=await deps.head(objectKey);vi.mocked(deps.head).mockResolvedValue({...head,...patch});
    await expect(createLabJobPrivacy(deps).document(scope,jobId,documentId)).rejects.toMatchObject({status:409});
    expect(deps.sign).not.toHaveBeenCalled();
  });
  it('refuses documents without a checksum or absent from the job',async()=>{
    row.documents=[{...fixture().documents[0],checksumSHA256:undefined}];
    await expect(createLabJobPrivacy(deps).document(scope,jobId,documentId)).rejects.toMatchObject({status:409});
    await expect(createLabJobPrivacy(deps).document(scope,jobId,scope.personId)).rejects.toMatchObject({status:404});
    expect(deps.head).not.toHaveBeenCalled();
  });
  it('does not disclose S3 errors',async()=>{
    vi.mocked(deps.head).mockRejectedValue(new Error('private internal object details'));
    await expect(createLabJobPrivacy(deps).document(scope,jobId,documentId)).rejects.toMatchObject({message:'lab_document_unavailable',status:503});
  });
  it('refuses a job mutation between head and signing',async()=>{
    const original=await deps.head(objectKey);vi.mocked(deps.head).mockImplementation(async()=>{row.updatedAt=new Date(now+1).toISOString();return original;});
    await expect(createLabJobPrivacy(deps).document(scope,jobId,documentId)).rejects.toMatchObject({status:409});
    expect(deps.sign).not.toHaveBeenCalled();
  });
  it('withholds a signed URL after deletion or ownership loss while signing',async()=>{
    vi.mocked(deps.sign).mockImplementation(async()=>{row.state='deleting';return 'https://must-not-escape';});
    await expect(createLabJobPrivacy(deps).document(scope,jobId,documentId)).rejects.toMatchObject({status:409});
  });
  it('withholds an expired URL and rejects identity revocation after signing',async()=>{
    let clock=now;deps.now=()=>clock;
    vi.mocked(deps.sign).mockImplementation(async()=>{clock+=60000;return 'https://must-not-escape';});
    await expect(createLabJobPrivacy(deps).document(scope,jobId,documentId)).rejects.toMatchObject({status:409});
    vi.mocked(deps.sign).mockImplementation(async()=>{vi.mocked(deps.revalidate).mockRejectedValue(new Error('owner_required'));return 'https://must-not-escape';});
    await expect(createLabJobPrivacy(deps).document(scope,jobId,documentId)).rejects.toThrow('owner_required');
  });
});
