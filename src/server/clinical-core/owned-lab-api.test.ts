import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({db:vi.fn(),sfn:vi.fn(),s3:vi.fn(),sign:vi.fn(),claim:vi.fn(),cleanup:vi.fn()}));
vi.mock('./lab-deletion-cleanup',()=>({claimLabDeletion:mock.claim,reconcileLabDeletion:mock.cleanup}));
vi.mock('@aws-sdk/lib-dynamodb',async importOriginal=>({...await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:mock.db})}}));
vi.mock('@aws-sdk/client-sfn',()=>({SFNClient:class{send=mock.sfn;},StartExecutionCommand:class{constructor(public input:unknown){}}}));
vi.mock('@aws-sdk/client-s3',()=>{class Command{constructor(public input:Record<string,unknown>){}}return {S3Client:class{send=mock.s3;},PutObjectCommand:class extends Command{},GetObjectCommand:class extends Command{},HeadObjectCommand:class extends Command{},ListObjectsV2Command:class extends Command{}};});
vi.mock('@aws-sdk/s3-request-presigner',()=>({getSignedUrl:mock.sign}));
import {createOwnedLabApi,type OwnedLabConfiguration,type OwnedLabEvent} from './owned-lab-api';
import {createAwsLabAnalysisApiHandler} from './aws-lab-analysis-api';
import {CoreSubscriptionError} from './core-subscription-guard';
import {OwnedStorageError,type StorageConsentState} from './owned-consumer-records';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import type {ExternalDeletionGuard} from './owned-external-deletion';
const now=Date.parse('2026-09-16T12:00:00Z'),uuid='11111111-1111-4111-8111-111111111111',requestId='10000000-0000-4000-8000-000000000001';
const config:OwnedLabConfiguration={consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/consumer',consumerAudience:'12345678901234567890',
  phiAllowed:true,activationState:'approved',activationEvidenceSha256:'a'.repeat(64),providerEvidenceSha256:'b'.repeat(64),allowedScopes:['ai_context','lab_history']};
const planInput=()=>({request:{id:requestId,createdAt:new Date().toISOString()},dataClassification:'personal_health_record',attestsOwnerConsent:true,
  panelId:uuid,panelName:'Fictional panel',testDate:'2026-09-01',biomarkers:[{markerId:'fictional',canonicalName:'Fictional',value:1,unit:'widgets',labMin:null,labMax:null}]});
const claims=(patch:Record<string,unknown>={})=>({iss:config.consumerIssuer,aud:config.consumerAudience,sub:'33333333-3333-4333-8333-333333333333',token_use:'id',email_verified:'true',
  'custom:person_id':uuid,'custom:organization_id':uuid,'custom:production_bound':'true',iat:now/1000-60,exp:now/1000+600,...patch});
function event(method:string,path:string,body?:unknown,claimPatch:Record<string,unknown>={}):OwnedLabEvent{
  return {rawPath:'/clinical-core/consumer/labs/'+path,...(body===undefined?{}:{body:JSON.stringify(body)}),headers:{'content-type':'application/json',authorization:'Bearer '+'x'.repeat(64)},
    requestContext:{http:{method},authorizer:{jwt:{claims:claims(claimPatch)}}}} as OwnedLabEvent;
}
function state(scope:StorageConsentState['scope'],revision=1):StorageConsentState{return {scope,release:{version:'approved-fixture/1',content:'test only',contentSha256:'a'.repeat(64),approvedAt:new Date(now-1000).toISOString()},
  current:{status:'granted',revision,releaseVersion:'approved-fixture/1',recordedAt:new Date(now-500).toISOString()},history:[],historyLimit:100,activeRevision:revision};}
const rows=new Map<string,Record<string,unknown>>();
let consentState:ReturnType<typeof vi.fn<(context:ProductionClinicalRequestContext,scope:StorageConsentState['scope'])=>Promise<StorageConsentState>>>;
let deletionBlocked=false;
const processingConsentStates=async(c:ProductionClinicalRequestContext)=>{
  if(deletionBlocked)throw new OwnedStorageError('account_deletion_write_blocked');
  return Promise.all((['ai_context','lab_history'] as const).map(scope=>consentState(c,scope)));
};
const personalGet=vi.fn(async(..._args:unknown[])=>null);const personalWrite=vi.fn();
function setup(c=config){const adapter=vi.fn(()=>({consentState,processingConsentStates,get:personalGet,write:personalWrite}));const requireCore=vi.fn(async()=>{});
  const deletionGuard:ExternalDeletionGuard=async(_s,work)=>work();
  return {adapter,requireCore,deletionGuard,handler:createOwnedLabApi({configuration:c,adapter,now:()=>now,requireCore,deletionGuard})};}
beforeEach(()=>{
  deletionBlocked=false;
  rows.clear();vi.clearAllMocks();consentState=vi.fn(async(_c,scope)=>state(scope));
  mock.claim.mockReset().mockResolvedValue(undefined);mock.cleanup.mockReset().mockResolvedValue(null);
  mock.s3.mockReset();mock.sign.mockReset();
  vi.stubEnv('LAB_DOCUMENT_BUCKET','fictional-documents');vi.stubEnv('LAB_KMS_KEY_ARN','fictional-kms');
  vi.stubEnv('LAB_JOB_TABLE','fictional-table');vi.stubEnv('LAB_RANGE_MODE','synthetic_fixture');vi.stubEnv('LAB_STATE_MACHINE_ARN','fictional-machine');vi.stubEnv('LAB_OBJECT_PREFIX','personal-labs');
  mock.db.mockImplementation(async c=>{
    if(c.constructor.name==='GetCommand')return {Item:rows.get(c.input.Key.pk)};
    if(c.constructor.name==='QueryCommand')return {Items:[...rows.values()].filter(r=>r.inventoryOwner===c.input.ExpressionAttributeValues[':owner']).map(r=>({pk:r.pk,inventoryOwner:r.inventoryOwner,inventoryOrder:r.inventoryOrder}))};
    if(c.constructor.name==='TransactWriteCommand'){const puts=c.input.TransactItems.map((r:{Put:{Item:{pk:string}}})=>r.Put.Item);
      if(puts.some((r:{pk:string})=>rows.has(r.pk)))throw new Error('conditional collision');for(const row of puts)rows.set(row.pk,row);return {};}
    if(c.constructor.name==='PutCommand'){rows.set(c.input.Item.pk,c.input.Item);return {};}
    throw new Error('unexpected write '+c.constructor.name);
  });mock.sfn.mockResolvedValue({});
});
afterEach(()=>vi.unstubAllEnvs());
const job=()=>[...rows.values()].find(r=>String(r.pk).startsWith('job#'))!;
describe('independent production lab processing',()=>{
  it('blocks new processing for a deletion request before job creation, signing or dispatch',async()=>{
    deletionBlocked=true;const s=setup(),r=await s.handler(event('POST','requests/saved',planInput()));
    expect(r.statusCode).toBe(403);expect(JSON.parse(r.body).data.error).toBe('account_deletion_write_blocked');
    expect(rows.size).toBe(0);expect(mock.sign).not.toHaveBeenCalled();expect(mock.sfn).not.toHaveBeenCalled();
  });
  it('withholds existing job results after deletion but keeps privacy inspection available',async()=>{
    const s=setup();await s.handler(event('POST','requests/saved',planInput()));const id=String(job().pk).slice(4);
    deletionBlocked=true;mock.sfn.mockClear();mock.sign.mockClear();
    const r=await s.handler(event('GET',`jobs/${id}`));
    expect(r.statusCode).toBe(403);expect(JSON.parse(r.body).data.error).toBe('account_deletion_write_blocked');
    expect(mock.sfn).not.toHaveBeenCalled();expect(mock.sign).not.toHaveBeenCalled();
    expect((await s.handler(event('GET',`jobs/${id}/privacy-copy`))).statusCode).toBe(200);
  });
  it.each([{phiAllowed:true,activationState:'blocked' as const},{phiAllowed:true,activationEvidenceSha256:undefined},{phiAllowed:true,providerEvidenceSha256:'short'}])
    ('refuses malformed activation %j',patch=>{expect(()=>setup({...config,...patch})).toThrow('owned_lab_activation_invalid');});
  it('blocked deployment refuses every route before identity, consent, billing or storage access',async()=>{
    const s=setup({...config,phiAllowed:false,activationState:'blocked',allowedScopes:[]});
    for(const request of [event('POST','requests/saved',planInput()),event('GET','inventory'),event('GET',`jobs/${uuid}`),event('POST',`jobs/${uuid}/cancel`,{confirmRemoveUnfinishedAnalysis:true}),event('GET',`jobs/${uuid}/privacy-copy`),event('POST',`jobs/${uuid}/documents/${requestId}/privacy-download`,{confirmDownload:true})]){
      const response=await s.handler(request);expect(response.statusCode).toBe(503);expect(JSON.parse(response.body)).toEqual({data:{error:'production_not_activated',phiAllowed:false}});
    }
    expect(s.adapter).not.toHaveBeenCalled();expect(s.requireCore).not.toHaveBeenCalled();expect(mock.db).not.toHaveBeenCalled();
  });
  it.each([{'custom:synthetic_attested':'true'},{'custom:production_bound':'false'},{email_verified:'false'},{iss:'https://cognito-idp.us-east-2.amazonaws.com/other'},{aud:'99999999999999999999'},{exp:now/1000-1},{token_use:'access'}])
    ('refuses non-production identity %j before any job access',async patch=>{
      const s=setup();const response=await s.handler(event('POST','requests/saved',planInput(),patch));
      expect(response.statusCode).toBe(401);expect(JSON.parse(response.body).data.error).toBe('reauth_required');
      expect(consentState).not.toHaveBeenCalled();expect(mock.db).not.toHaveBeenCalled();expect(s.requireCore).not.toHaveBeenCalled();
    });
  it('creates a job only with paid Core and both current consents, binding exact revisions to the row',async()=>{
    const s=setup();const response=await s.handler(event('POST','requests/saved',planInput()));
    expect(response.statusCode).toBe(200);expect(s.requireCore).toHaveBeenCalledOnce();
    expect(job()).toMatchObject({ownerSub:'33333333-3333-4333-8333-333333333333',organizationId:uuid,personId:uuid,dataClassification:'personal_health_record',
      authorization:{version:'owned-lab/1',personId:uuid,organizationId:uuid,identitySubject:'33333333-3333-4333-8333-333333333333',
        consents:{ai_context:{revision:1,releaseVersion:'approved-fixture/1',contentSha256:'a'.repeat(64)},lab_history:{revision:1,releaseVersion:'approved-fixture/1',contentSha256:'a'.repeat(64)}}}});
    expect(JSON.stringify(job())).not.toContain('synthetic');
  });
  it('refuses synthetic attestation fields and caller-supplied authorization in a production request',async()=>{
    const s=setup();
    expect((await s.handler(event('POST','requests/saved',{...planInput(),dataClassification:'synthetic_only',attestsSyntheticOnly:true,attestsOwnerConsent:undefined}))).statusCode).toBe(400);
    expect((await s.handler(event('POST','requests/saved',{...planInput(),attestsSyntheticOnly:true}))).statusCode).toBe(400);
    expect((await s.handler(event('POST','requests/saved',{...planInput(),authorization:{version:'owned-lab/1'}}))).statusCode).toBe(400);
    expect(rows.size).toBe(0);expect(s.requireCore).not.toHaveBeenCalled();
  });
  it('requires paid Core for creation but not for status or cancellation',async()=>{
    const s=setup();s.requireCore.mockRejectedValueOnce(new CoreSubscriptionError('core_subscription_unavailable'));
    const refused=await s.handler(event('POST','requests/saved',planInput()));
    expect(refused.statusCode).toBe(402);expect(JSON.parse(refused.body).data.error).toBe('core_subscription_required');expect(rows.size).toBe(0);
    expect((await s.handler(event('POST','requests/saved',planInput()))).statusCode).toBe(200);
    const id=String(job().pk).slice(4);s.requireCore.mockClear();
    expect((await s.handler(event('GET',`jobs/${id}`))).statusCode).toBe(200);expect(s.requireCore).not.toHaveBeenCalled();
  });
  it('withdrawn or re-granted consent hides the job from reads but a different owner never sees it',async()=>{
    const s=setup(),input=planInput();expect((await s.handler(event('POST','requests/saved',input))).statusCode).toBe(200);
    const id=String(job().pk).slice(4);
    expect((await s.handler(event('GET',`jobs/${id}`,undefined,{sub:'44444444-4444-4444-8444-444444444444'}))).statusCode).toBe(404);
    consentState.mockImplementation(async(_c,scope)=>scope==='lab_history'?{...state(scope),current:{...state(scope).current!,status:'revoked'}}:state(scope));
    const withdrawn=await s.handler(event('GET',`jobs/${id}`));
    expect(withdrawn.statusCode).toBe(403);expect(JSON.parse(withdrawn.body).data.error).toBe('lab_consent_required');
    consentState.mockImplementation(async(_c,scope)=>state(scope,2));
    expect((await s.handler(event('GET',`jobs/${id}`))).statusCode).toBe(403);
    const replay=await s.handler(event('POST','requests/saved',input)); // same request identity, stale consent binding
    expect(replay.statusCode).toBe(403);expect(JSON.parse(replay.body).data.error).toBe('lab_consent_required');expect(rows.size).toBe(2);
  });
  it('revalidates the database identity on every route and maps refusals without leaking',async()=>{
    const s=setup();consentState.mockRejectedValue(new OwnedStorageError('owner_required'));
    const response=await s.handler(event('GET','inventory'));expect(response.statusCode).toBe(401);
    consentState.mockRejectedValue(new Error('private database failure'));
    const outage=await s.handler(event('GET','inventory'));expect(outage.statusCode).toBe(503);expect(outage.body).not.toContain('private');
  });
  it('rejects paths outside the consumer lab root and disabled feature scopes',async()=>{
    const s=setup();expect((await s.handler({...event('GET','inventory'),rawPath:'/clinical-core/synthetic-session/labs/inventory'})).statusCode).toBe(404);
    const t=setup({...config,allowedScopes:['lab_history']});expect((await t.handler(event('GET','inventory'))).statusCode).toBe(403);expect(consentState).not.toHaveBeenCalled();
  });
  it('the synthetic handler never serves a production job and vice versa',async()=>{
    const s=setup();expect((await s.handler(event('POST','requests/saved',planInput()))).statusCode).toBe(200);
    const id=String(job().pk).slice(4);
    const synthetic=await createAwsLabAnalysisApiHandler({rawPath:`/clinical-core/consumer/labs/jobs/${id}`,requestContext:{http:{method:'GET'},
      authorizer:{jwt:{claims:{sub:'33333333-3333-4333-8333-333333333333','custom:person_id':uuid,'custom:organization_id':uuid,'custom:synthetic_attested':'true'}}}}});
    expect(synthetic.statusCode).toBe(404);
    rows.set('job#'+requestId,{pk:'job#'+requestId,ownerSub:'33333333-3333-4333-8333-333333333333',organizationId:uuid,personId:uuid,state:'completed',passesCompleted:5,progressPercent:100,attempt:1,
      createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),expiresAt:now/1000+3600,documents:[],failureCategory:null,result:{}});
    expect((await s.handler(event('GET',`jobs/${requestId}`))).statusCode).toBe(404);
  });
});

describe('production owner privacy routes after consent withdrawal',()=>{
  async function retained(){
    const s=setup();expect((await s.handler(event('POST','requests/saved',planInput()))).statusCode).toBe(200);
    const id=String(job().pk).slice(4);mock.sfn.mockClear();s.requireCore.mockClear();mock.db.mockClear();
    consentState.mockImplementation(async(_c,scope)=>({...state(scope),current:{...state(scope).current!,status:'revoked'}}));
    return {...s,id};
  }
  it('returns an inert retained copy without paid Core, current AI consent, dispatch or writes',async()=>{
    const s=await retained();
    const response=await s.handler(event('GET',`jobs/${s.id}/privacy-copy`));
    expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body).data).toMatchObject({contractVersion:'lab-processing-copy/1',coverage:{completeAccountExport:false},record:{jobId:s.id,structuredBiomarkers:planInput().biomarkers}});
    expect(response.body).not.toContain('authorization');expect(s.requireCore).not.toHaveBeenCalled();expect(mock.sfn).not.toHaveBeenCalled();
    expect(mock.db.mock.calls.every(([c])=>c.constructor.name==='GetCommand'&&c.input.ConsistentRead===true)).toBe(true);
    expect((await s.handler(event('GET',`jobs/${s.id}`))).statusCode).toBe(403);
  });
  it('does not expose other owners or synthetic-classified copies',async()=>{
    const s=await retained();
    expect((await s.handler(event('GET',`jobs/${s.id}/privacy-copy`,undefined,{sub:requestId}))).statusCode).toBe(404);
    job().dataClassification='synthetic_only';expect((await s.handler(event('GET',`jobs/${s.id}/privacy-copy`))).statusCode).toBe(404);
    expect(mock.sign).not.toHaveBeenCalled();
  });
  it('requires the explicit document confirmation and pins signing to verified version, checksum, scope and headers',async()=>{
    const s=await retained(),checksum=Buffer.alloc(32,1).toString('base64');
    const key=`personal-labs/${uuid}/${claims().sub}/${s.id}/${requestId}/fictional.pdf`;
    job().documents=[{clientDocumentId:requestId,fileName:'fictional.pdf',contentType:'application/pdf',byteSize:100,checksumSHA256:checksum,objectKey:key}];
    mock.s3.mockResolvedValue({ContentLength:100,ContentType:'application/pdf',ChecksumSHA256:checksum,ServerSideEncryption:'aws:kms',SSEKMSKeyId:'fictional-kms',
      Metadata:{'job-id':s.id,'document-id':requestId},VersionId:'pinned-version',ETag:'"abc123"'});
    mock.sign.mockResolvedValue('https://fictional-documents.s3.us-east-2.amazonaws.com/pinned');
    const path=`jobs/${s.id}/documents/${requestId}/privacy-download`;
    for(const input of [{},{confirmDownload:false},{confirmDownload:true,objectKey:'other'}])expect((await s.handler(event('POST',path,input))).statusCode).toBe(400);
    expect(mock.s3).not.toHaveBeenCalled();expect(mock.sign).not.toHaveBeenCalled();
    const response=await s.handler(event('POST',path,{confirmDownload:true}));expect(response.statusCode).toBe(200);
    expect(mock.sign.mock.calls[0][1].input).toEqual({Bucket:'fictional-documents',Key:key,VersionId:'pinned-version',IfMatch:'"abc123"',ResponseContentType:'application/pdf',ResponseCacheControl:'no-store',ResponseContentDisposition:`attachment; filename="alp-lab-document-${requestId}.pdf"`});
    expect(mock.sign.mock.calls[0][2]).toEqual({expiresIn:60});expect(JSON.parse(response.body).data.requiredHeaders).toEqual({'if-match':'"abc123"'});
    expect(s.requireCore).not.toHaveBeenCalled();expect(mock.sfn).not.toHaveBeenCalled();
  });
  it('rejects extra query parameters, wrong methods and database identity loss',async()=>{
    const s=await retained();
    expect((await s.handler({...event('GET',`jobs/${s.id}/privacy-copy`),queryStringParameters:{owner:'other'}})).statusCode).toBe(400);
    expect((await s.handler(event('POST',`jobs/${s.id}/privacy-copy`,{}))).statusCode).toBe(405);
    consentState.mockRejectedValue(new OwnedStorageError('owner_required'));
    expect((await s.handler(event('GET',`jobs/${s.id}/privacy-copy`))).statusCode).toBe(401);
  });
  it.each(['cancel','delete'] as const)('allows explicit %s after withdrawal while retaining cleanup ownership and state checks',async operation=>{
    const s=await retained();if(operation==='delete')job().state='completed';
    mock.cleanup.mockResolvedValue({cleanupStatus:'late_upload_watch'});
    const response=await s.handler(operation==='cancel'?event('POST',`jobs/${s.id}/cancel`,{confirmRemoveUnfinishedAnalysis:true}):event('DELETE',`jobs/${s.id}`));
    expect(response.statusCode).toBe(200);
    const scope={ownerSub:claims().sub,organizationId:uuid,personId:uuid};
    // Deletion consults personal storage for a cloud copy even after withdrawal;
    // cancellation of unfinished work has no copy to consult.
    if(operation==='delete'){expect(JSON.parse(response.body).data.publication).toMatchObject({status:'not_published'});expect(personalGet.mock.calls[0][1]).toMatchObject({collection:'lab_analyses'});expect(personalWrite).not.toHaveBeenCalled();}
    else {expect(personalGet).not.toHaveBeenCalled();expect(JSON.parse(response.body).data.publication).toBeUndefined();}
    expect(mock.claim.mock.calls[0].slice(1)).toEqual(operation==='cancel'?[scope,s.id,true]:[scope,s.id]);
    expect(mock.cleanup.mock.calls[0].slice(1)).toEqual([s.id,scope]);expect(s.requireCore).not.toHaveBeenCalled();
    expect(mock.claim.mock.calls[0][0].deletionGuard).toBe(s.deletionGuard);
    expect(mock.cleanup.mock.calls[0][0].deletionGuard).toBe(s.deletionGuard);
    expect(mock.sfn).not.toHaveBeenCalled();
  });
  it.each(['cancel','delete'] as const)('reports a hold distinctly for %s without claiming deletion',async operation=>{
    const s=await retained();if(operation==='delete')job().state='completed';
    mock.claim.mockRejectedValue(new OwnedStorageError('legal_hold'));
    const response=await s.handler(operation==='cancel'?event('POST',`jobs/${s.id}/cancel`,{confirmRemoveUnfinishedAnalysis:true}):event('DELETE',`jobs/${s.id}`));
    expect(response.statusCode).toBe(409);expect(JSON.parse(response.body)).toEqual({data:{error:'lab_deletion_held'}});
    expect(mock.cleanup).not.toHaveBeenCalled();
  });
  it('never claims another owner or classification for deletion, and refuses cancellation of saved results',async()=>{
    const s=await retained();
    expect((await s.handler(event('POST',`jobs/${s.id}/cancel`,{confirmRemoveUnfinishedAnalysis:true},{sub:requestId}))).statusCode).toBe(404);
    expect(mock.claim).not.toHaveBeenCalled();
    job().dataClassification='synthetic_only';
    expect((await s.handler(event('POST',`jobs/${s.id}/cancel`,{confirmRemoveUnfinishedAnalysis:true}))).statusCode).toBe(404);
    expect(mock.claim).not.toHaveBeenCalled();
    job().dataClassification='personal_health_record';job().state='completed';
    expect((await s.handler(event('POST',`jobs/${s.id}/cancel`,{confirmRemoveUnfinishedAnalysis:true}))).statusCode).toBe(409);
    expect(mock.claim).not.toHaveBeenCalled();
  });
});
