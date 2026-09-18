import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createRecordingCleanupReviewApi,RECORDING_CLEANUP_REVIEW_ROUTE,type CleanupReviewConfiguration} from './recording-cleanup-review-api';
import type {ApiGatewayV2Event} from './aws-identity-api';
import {RecordingCleanupError} from './recording-cleanup-authority';
const org=randomUUID(),person=randomUUID(),recordingId=randomUUID(),now=Date.now(),seconds=Math.floor(now/1000);
const configuration:CleanupReviewConfiguration={organizationId:org,workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/FictionalWorkforce',
  workforceAudience:'12345678901234567890',activation:'approved',phiAllowed:true,activationEvidenceSha256:'a'.repeat(64),
  mfaReviewSha256:'b'.repeat(64),databaseReviewSha256:'c'.repeat(64),cleanupReviewSha256:'d'.repeat(64)};
function event(body:unknown={action:'queue'},claims:Record<string,unknown>={}):ApiGatewayV2Event{
  return {routeKey:RECORDING_CLEANUP_REVIEW_ROUTE,body:JSON.stringify(body),headers:{'content-type':'application/json'},
    requestContext:{authorizer:{jwt:{claims:{iss:configuration.workforceIssuer,aud:configuration.workforceAudience,
      sub:'FICTIONAL-operator',token_use:'id','custom:person_id':person,'custom:organization_id':org,
      'custom:production_bound':'true',email_verified:true,iat:seconds,exp:seconds+600,auth_time:seconds,...claims}}}}};
}
function fixture(c=configuration){
  const list=vi.fn().mockResolvedValue({items:[],nextAfter:null}),history=vi.fn().mockResolvedValue({recordingId,runs:[],nextAfter:null});
  const service=vi.fn(()=>({list,history}));return {list,history,service,call:createRecordingCleanupReviewApi({configuration:c,service,now:()=>now})};
}
describe('metadata-only cleanup operator API',()=>{
  it('does not construct services while blocked; independent review is mandatory',async()=>{
    const f=fixture({...configuration,phiAllowed:false,activation:'blocked'});
    expect((await f.call(event())).statusCode).toBe(503);expect(f.service).not.toHaveBeenCalled();
    expect(()=>fixture({...configuration,cleanupReviewSha256:undefined})).toThrow('recording_cleanup_review_activation_invalid');
  });
  it.each([{aud:'consumer'},{iss:'https://untrusted.invalid'},{'custom:organization_id':randomUUID()},
    {'custom:production_bound':'false'},{'custom:synthetic_attested':'true'},{auth_time:seconds-901},{exp:seconds-1},{'custom:person_id':'bad'}])(
    'refuses unqualified identity before database work: %j',async claims=>{
      const f=fixture();expect((await f.call(event(undefined,claims))).statusCode).toBe(401);expect(f.service).not.toHaveBeenCalled();
    });
  it('uses verified workforce identity with server-selected privacy purpose',async()=>{
    const f=fixture(),response=await f.call(event());expect(response.statusCode).toBe(200);
    expect(f.list).toHaveBeenCalledWith(expect.objectContaining({actorPersonId:person,organizationId:org,identityPool:'workforce',purpose:'consent_management'}),undefined);
    expect(JSON.parse(response.body).capabilities).toEqual({review:true,dispatch:false,storageDeletion:false});
    expect(response.headers['cache-control']).toBe('no-store');expect(f.history).not.toHaveBeenCalled();
  });
  it.each([{action:'claim'},{action:'run',recordingId},{action:'history',recordingId,workerSha256:'a'.repeat(64)},
    {action:'queue',organizationId:org},{action:'queue',purpose:'clinical_data'},{action:'history',recordingId,operatorId:person},
    {action:'queue',after:'bad'},{action:'history',recordingId:'bad'}])('rejects injected capability or scope %j',async body=>{
    const f=fixture();expect((await f.call(event(body))).statusCode).toBe(400);expect(f.service).not.toHaveBeenCalled();
  });
  it('does not authenticate caller authorization text without Gateway claims',async()=>{
    const f=fixture(),e=event();delete e.requestContext;e.headers={...e.headers,authorization:'Bearer FICTIONAL-NOT-A-TOKEN'};
    expect((await f.call(e)).statusCode).toBe(401);expect(f.service).not.toHaveBeenCalled();
  });
  it.each(['query','header','duplicate-type','invalid-base64','invalid-utf8','oversize','json'])(
    'rejects malformed transport %s before runtime access',async mode=>{
      const f=fixture(),e=event();
      if(mode==='query')e.queryStringParameters={token:'secret'};
      if(mode==='header')e.headers={'content-type':'application/json','x-alp-organization':org};
      if(mode==='duplicate-type')e.headers={'Content-Type':'application/json','content-type':'application/json'};
      if(mode==='invalid-base64'){e.isBase64Encoded=true;e.body='!!!!';}
      if(mode==='invalid-utf8'){e.isBase64Encoded=true;e.body=Buffer.from([255]).toString('base64');}
      if(mode==='oversize')e.body=' '.repeat(4097);
      if(mode==='json')e.body='{';
      expect((await f.call(e)).statusCode).toBe(400);expect(f.service).not.toHaveBeenCalled();
    });
  it('forwards only exact history identity/cursor and rejects substituted or expanded responses',async()=>{
    const f=fixture(),after=randomUUID();expect((await f.call(event({action:'history',recordingId,after}))).statusCode).toBe(200);
    expect(f.history).toHaveBeenCalledWith(expect.any(Object),recordingId,after);
    f.history.mockResolvedValue({recordingId:randomUUID(),runs:[],nextAfter:null});
    expect((await f.call(event({action:'history',recordingId}))).statusCode).toBe(503);
    f.list.mockResolvedValue({items:[],nextAfter:null,objectKey:'must not leak'});
    const bad=await f.call(event());expect(bad.statusCode).toBe(503);expect(bad.body).not.toContain('must not leak');
  });
  it.each([['access_refused',403],['not_ready',409],['service_unavailable',503]] as const)('sanitizes %s refusal',async(code,status)=>{
    const f=fixture();f.list.mockRejectedValue(new RecordingCleanupError(code));expect((await f.call(event())).statusCode).toBe(status);
    f.list.mockRejectedValue(new Error('provider secret or patient payload'));
    expect(JSON.parse((await f.call(event())).body)).toEqual({error:'service_unavailable'});
  });
});
