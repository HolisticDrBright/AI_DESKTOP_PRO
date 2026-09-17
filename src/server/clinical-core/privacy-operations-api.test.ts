import {describe,it,expect,vi} from 'vitest';
import {createPrivacyOperationsApi,PRIVACY_OPERATIONS_ROUTE,type PrivacyOperationsConfiguration} from './privacy-operations-api';
import {PrivacyOperationError} from './privacy-operations';
import type {ApiGatewayV2Event} from './aws-identity-api';
const now=Date.now(),time=Math.floor(now/1000),uuid='11111111-1111-4111-8111-111111111111';
const config:PrivacyOperationsConfiguration={workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/workforce',
  workforceAudience:'12345678901234567890',phiAllowed:true,activation:'approved',evidenceSha256:'a'.repeat(64),mfaReviewSha256:'b'.repeat(64)};
const event=(patch:Record<string,unknown>={}):ApiGatewayV2Event=>({routeKey:PRIVACY_OPERATIONS_ROUTE,
  body:JSON.stringify({action:'list',includeClosed:false}),headers:{'content-type':'application/json'},
  requestContext:{authorizer:{jwt:{claims:{iss:config.workforceIssuer,aud:config.workforceAudience,token_use:'id',sub:'workforce-subject',
    'custom:person_id':uuid,'custom:organization_id':uuid,'custom:production_bound':'true',email_verified:'true',
    exp:time+600,iat:time,auth_time:time,...patch}}}}});
describe('privacy workforce API claims and activation',()=>{
  it('defaults blocked without opening a database and requires separate MFA review',async()=>{
    const operations=vi.fn();
    const handler=createPrivacyOperationsApi({configuration:{...config,phiAllowed:false,activation:'blocked'},operations});
    expect((await handler(event())).statusCode).toBe(503);expect(operations).not.toHaveBeenCalled();
    expect(()=>createPrivacyOperationsApi({configuration:{...config,mfaReviewSha256:''},operations})).toThrow('privacy_api_activation_invalid');
  });
  it.each([{iss:'https://cognito-idp.us-east-2.amazonaws.com/consumer'},{aud:'other-client'},{token_use:'access'},
    {email_verified:false},{'custom:production_bound':'false'},{'custom:synthetic_attested':'true'},
    {exp:time-1},{iat:time+120},{auth_time:time-901},{auth_time:undefined},{auth_time:time+1},
    {'custom:person_id':'bad'}, {sub:''}])('rejects invalid or stale workforce identity %j',async patch=>{
      const operations=vi.fn();const handler=createPrivacyOperationsApi({configuration:config,operations,now:()=>now});
      expect((await handler(event(patch))).statusCode).toBe(401);expect(operations).not.toHaveBeenCalled();
  });
  it('uses only server purpose and role, refusing owner overrides or unbounded requests',async()=>{
    const call=vi.fn().mockResolvedValue({items:[],nextAfter:null});
    const handler=createPrivacyOperationsApi({configuration:config,operations:()=>call,now:()=>now});
    const success=await handler(event());
    expect(success.statusCode).toBe(200);expect(success.headers['cache-control']).toBe('no-store');
    expect(call).toHaveBeenCalledWith(expect.objectContaining({identityPool:'workforce',purpose:'consent_management',actorPersonId:uuid}),
      {action:'list',includeClosed:false});
    for(const body of [{action:'list',includeClosed:false,ownerId:uuid},{action:'resolve',privacyRequestId:uuid,outcome:'declined',appliedRevision:2,explanation:'reason'}]){
      expect((await handler({...event(),body:JSON.stringify(body)})).statusCode).toBe(400);
    }
    expect((await handler({...event(),queryStringParameters:{ownerId:uuid}})).statusCode).toBe(400);
    expect((await handler({...event(),body:'x'.repeat(20000)})).statusCode).toBe(400);
    expect((await handler({...event(),routeKey:'POST /clinical-core/consumer/privacy-operations'})).statusCode).toBe(404);
  });
  it('does not expose raw SQL, field values or credentials on errors',async()=>{
    const call=vi.fn().mockRejectedValue(new Error('secret clinical SQL patient information'));
    const handler=createPrivacyOperationsApi({configuration:config,operations:()=>call,now:()=>now});
    expect(JSON.parse((await handler(event())).body)).toEqual({error:'service_unavailable'});
    call.mockRejectedValue(new PrivacyOperationError('privacy_access_refused'));
    expect((await handler(event())).statusCode).toBe(403);
    call.mockRejectedValue(new PrivacyOperationError('conflict'));
    expect((await handler(event())).statusCode).toBe(409);
  });
});
