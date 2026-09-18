import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createRecordingCleanupExecutionApi,RECORDING_CLEANUP_EXECUTION_ROUTE,type CleanupExecutionConfiguration} from './recording-cleanup-execution-api';
import type {ApiGatewayV2Event} from './aws-identity-api';
import {RecordingCleanupError} from './recording-cleanup-authority';
const org=randomUUID(),person=randomUUID(),recordingId=randomUUID(),requestId=randomUUID(),now=Date.now(),seconds=Math.floor(now/1000);
const configuration:CleanupExecutionConfiguration={organizationId:org,workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/FictionalWorkforce',
  workforceAudience:'12345678901234567890',activation:'approved',phiAllowed:true,activationEvidenceSha256:'a'.repeat(64),
  mfaReviewSha256:'b'.repeat(64),databaseReviewSha256:'c'.repeat(64),executionReviewSha256:'d'.repeat(64),
  cleanupReleaseId:randomUUID(),workerSha256:'e'.repeat(64),storageReviewSha256:'f'.repeat(64),holdCoordinationReviewSha256:'1'.repeat(64)};
const request={recordingId,requestId,version:2,confirmation:'run_bounded_cleanup_pass'};
function event(body:unknown=request,claims:Record<string,unknown>={}):ApiGatewayV2Event{
  return {routeKey:RECORDING_CLEANUP_EXECUTION_ROUTE,body:JSON.stringify(body),headers:{'content-type':'application/json'},
    requestContext:{authorizer:{jwt:{claims:{iss:configuration.workforceIssuer,aud:configuration.workforceAudience,
      sub:'FICTIONAL-operator',token_use:'id','custom:person_id':person,'custom:organization_id':org,
      'custom:production_bound':'true',email_verified:true,iat:seconds,exp:seconds+600,auth_time:seconds,...claims}}}}};
}
const result={runId:requestId,recordingId,outcome:'empty_observed',appliedToSchedule:true,nextCheckAt:new Date(now+3600000).toISOString(),audioDeleted:false,requiresRecheck:true};
function fixture(c=configuration){
  const run=vi.fn().mockResolvedValue(result),service=vi.fn(()=>run);
  return {run,service,call:createRecordingCleanupExecutionApi({configuration:c,service,now:()=>now})};
}
describe('separately governed cleanup pass endpoint',()=>{
  it('does not load a worker while disabled',async()=>{
    const f=fixture({...configuration,phiAllowed:false,activation:'blocked'});expect((await f.call(event())).statusCode).toBe(503);expect(f.service).not.toHaveBeenCalled();
  });
  it.each(['cleanupReleaseId','workerSha256','executionReviewSha256','storageReviewSha256','holdCoordinationReviewSha256'] as const)(
    'requires independent valid %s before activation',key=>{
      expect(()=>fixture({...configuration,[key]:undefined})).toThrow('recording_cleanup_execution_activation_invalid');
      expect(()=>fixture({...configuration,[key]:'bad'})).toThrow('recording_cleanup_execution_activation_invalid');
    });
  it.each([{aud:'consumer'},{iss:'https://untrusted.invalid'},{'custom:organization_id':randomUUID()},
    {'custom:production_bound':'false'},{'custom:synthetic_attested':'true'},{auth_time:seconds-901},{exp:seconds-1},{'custom:person_id':'bad'}])(
    'refuses unqualified identity %j before runtime construction',async claims=>{
      const f=fixture();expect((await f.call(event(undefined,claims))).statusCode).toBe(401);expect(f.service).not.toHaveBeenCalled();
    });
  it('binds server release/worker and authenticated organization to a caller-stable run identifier',async()=>{
    const f=fixture(),response=await f.call(event());expect(response.statusCode).toBe(200);
    expect(f.run).toHaveBeenCalledWith(expect.objectContaining({actorPersonId:person,organizationId:org,purpose:'consent_management',identityPool:'workforce'}),
      {recordingId,version:2,cleanupReleaseId:configuration.cleanupReleaseId,workerSha256:configuration.workerSha256},requestId);
    expect(response.headers['cache-control']).toBe('no-store');expect(JSON.parse(response.body)).toEqual({data:result,
      capabilities:{boundedPass:true,scheduledDispatch:false,holdMutation:false,wholeRecordingErasure:false}});
  });
  it.each([{workerSha256:'a'.repeat(64)},{cleanupReleaseId:randomUUID()},{organizationId:org},{actorPersonId:person},
    {purpose:'clinical_data'},{attemptId:randomUUID()},{confirmation:undefined},{version:0},{version:1.5},{requestId:'bad'},{recordingId:'bad'}])(
    'rejects substituted authority or invalid command %j',async fields=>{
      const f=fixture();expect((await f.call(event({...request,...fields}))).statusCode).toBe(400);expect(f.service).not.toHaveBeenCalled();
    });
  it('cannot authenticate arbitrary bearer text without Gateway verification',async()=>{
    const f=fixture(),e=event();delete e.requestContext;e.headers={authorization:'Bearer FICTIONAL','content-type':'application/json'};
    expect((await f.call(e)).statusCode).toBe(401);expect(f.service).not.toHaveBeenCalled();
  });
  it.each(['query','header','duplicate-type','invalid-base64','invalid-utf8','oversize','json'])('rejects bad %s transport',async mode=>{
    const f=fixture(),e=event();
    if(mode==='query')e.queryStringParameters={token:'secret'};
    if(mode==='header')e.headers={'content-type':'application/json','x-alp-role':'operator'};
    if(mode==='duplicate-type')e.headers={'Content-Type':'application/json','content-type':'application/json'};
    if(mode==='invalid-base64'){e.isBase64Encoded=true;e.body='!!!!';}
    if(mode==='invalid-utf8'){e.isBase64Encoded=true;e.body=Buffer.from([255]).toString('base64');}
    if(mode==='oversize')e.body=' '.repeat(4097);
    if(mode==='json')e.body='{';
    expect((await f.call(e)).statusCode).toBe(400);expect(f.service).not.toHaveBeenCalled();
  });
  it.each([{runId:randomUUID()},{recordingId:randomUUID()},{audioDeleted:true},{requiresRecheck:false},{objectKey:'SENSITIVE'},
    {outcome:'fully_erased'}])('rejects false or uncorrelated receipts %j',async fields=>{
      const f=fixture();f.run.mockResolvedValue({...result,...fields});const response=await f.call(event());
      expect(response.statusCode).toBe(503);expect(response.body).not.toContain('SENSITIVE');
    });
  it('keeps exact replay visibly different from a newly recorded result',async()=>{
    const f=fixture();const replay={state:'already_claimed',runId:requestId,recordingId,audioDeleted:false,requiresRecheck:true};f.run.mockResolvedValue(replay);
    expect(JSON.parse((await f.call(event())).body).data).toEqual(replay);
  });
  it.each([['legal_hold',409],['not_ready',409],['access_refused',403],['service_unavailable',503]] as const)('sanitizes %s',async(code,status)=>{
    const f=fixture();f.run.mockRejectedValue(new RecordingCleanupError(code));expect((await f.call(event())).statusCode).toBe(status);
    f.run.mockRejectedValue(new Error('SENSITIVE PATIENT PAYLOAD'));expect(JSON.parse((await f.call(event())).body)).toEqual({error:'service_unavailable'});
  });
});
