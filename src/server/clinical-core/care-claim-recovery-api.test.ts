import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {CareConnectionError} from './production-care-connections';
import {createCareClaimRecoveryApi,CARE_CLAIM_RECOVERY_ROUTE,type CareClaimRecoveryConfiguration} from './care-claim-recovery-api';
import type {ApiGatewayV2Event} from './aws-identity-api';
const now=1800000000000,org=randomUUID(),owner=randomUUID(),requestId=randomUUID(),hash='a'.repeat(64);
// These review hashes/identities are explicit fictional test inputs, NOT approvals.
const config:CareClaimRecoveryConfiguration={
  workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce',workforceAudience:'w'.repeat(26),
  consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer',consumerAudience:'c'.repeat(26),organizationId:org,
  phiAllowed:false,activation:'blocked',databaseReviewSha256:hash,mfaReviewSha256:hash,connectionReviewSha256:hash,
  claimRecoveryReviewSha256:hash,enabledScopes:[],
  qualification:{accountId:'588966314750',databaseName:'clinical_core_qualification',reviewSha256:hash,identitySubjects:['FICTIONAL-consumer-00001']},
};
function event(body:unknown={action:'receipt',requestId}):ApiGatewayV2Event{
  return {routeKey:CARE_CLAIM_RECOVERY_ROUTE,headers:{'content-type':'application/json'},body:JSON.stringify(body),
    requestContext:{authorizer:{jwt:{claims:{iss:config.consumerIssuer,aud:config.consumerAudience,sub:'FICTIONAL-consumer-00001',
      token_use:'id','custom:person_id':owner,'custom:organization_id':org,'custom:production_bound':'true',email_verified:true,
      iat:now/1000-10,exp:now/1000+1000,auth_time:now/1000-10}}}}};
}
function setup(c=structuredClone(config)){
  const operation=vi.fn(async()=>({requestId,status:'unresolved' as const})),factory=vi.fn(()=>operation);
  const input={configuration:c,operations:factory,now:()=>now};return {api:createCareClaimRecoveryApi(input),operation,factory,input};
}
describe('unreleased recovery API boundaries',()=>{
  it('is blocked by default before touching a database',async()=>{
    const s=setup({...config,qualification:undefined});expect(await s.api(event())).toMatchObject({statusCode:503});expect(s.factory).not.toHaveBeenCalled();
  });
  it('requires a distinct recovery review, connection review and workforce MFA review',()=>{
    for(const key of ['claimRecoveryReviewSha256','connectionReviewSha256','mfaReviewSha256'] as const)
      expect(()=>setup({...config,[key]:undefined})).toThrow('care_claim_review_required');
    expect(()=>setup({...config,phiAllowed:true,activation:'approved',activationEvidenceSha256:hash})).toThrow('qualification_execution_invalid');
  });
  it('admits only designated qualification identity and labels every result',async()=>{
    const s=setup();expect(await s.api(event())).toMatchObject({statusCode:200,headers:{'x-clinical-execution':'qualification','cache-control':'no-store'}});
    const changed=event();changed.requestContext!.authorizer!.jwt!.claims!.sub='NOT-designated';
    expect(await s.api(changed)).toMatchObject({statusCode:503});expect(s.factory).toHaveBeenCalledOnce();
  });
  it('requires recent authentication to claim but permits receipt and settlement with a valid older login',async()=>{
    const s=setup();
    for(const action of ['claim','receipt','settle']){
      const changed=event({action,requestId,...(action==='claim'?{token:'ABCDEFGHJKLMN'}:{})});
      changed.requestContext!.authorizer!.jwt!.claims!.auth_time=now/1000-901;
      expect((await s.api(changed)).statusCode).toBe(action==='claim'?401:200);
    }
    expect(s.factory).toHaveBeenCalledTimes(2);
  });
  it.each(['iss','aud','custom:organization_id','custom:production_bound','exp','email_verified'])('refuses invalid %s before database access',async key=>{
    const s=setup(),changed=event();changed.requestContext!.authorizer!.jwt!.claims![key]=key==='exp'?now/1000-1:key==='custom:organization_id'?randomUUID():key==='iss'?config.workforceIssuer:key==='aud'?config.workforceAudience:'false';
    expect((await s.api(changed)).statusCode).toBe(key==='custom:organization_id'?403:401);expect(s.factory).not.toHaveBeenCalled();
  });
  it('never promotes unverified authorization headers into identity',async()=>{
    const s=setup(),changed=event();changed.requestContext=undefined;changed.headers!.authorization='Bearer FICTIONAL';
    expect((await s.api(changed)).statusCode).toBe(401);expect(s.factory).not.toHaveBeenCalled();
  });
  it('strictly refuses unbounded, redirected-authority, query, encoding and unknown-action inputs',async()=>{
    const s=setup();
    for(const changed of [event({action:'settle',requestId,token:'ABCDEFGHJKLMN'}),event({action:'receipt',requestId,ownerId:owner}),
      event({action:'grant',requestId}),{...event(),queryStringParameters:{organizationId:org}},
      {...event(),headers:{'content-type':'text/plain'}},{...event(),body:' '.repeat(1401)},
      {...event(),isBase64Encoded:true,body:'%%%%'},{...event(),isBase64Encoded:true,body:Buffer.from([0xff]).toString('base64')}])
      expect((await s.api(changed)).statusCode).toBe(400);
    expect((await s.api({...event(),routeKey:'POST /wrong'})).statusCode).toBe(404);expect(s.factory).not.toHaveBeenCalled();
  });
  it('captures the reviewed configuration and collaborators',async()=>{
    const s=setup();s.input.configuration.consumerIssuer=config.workforceIssuer;s.input.operations=vi.fn(()=>s.operation);
    expect((await s.api(event())).statusCode).toBe(200);expect(s.factory).toHaveBeenCalledOnce();expect(s.input.operations).not.toHaveBeenCalled();
    expect(s.operation.mock.calls[0]).toMatchObject([{actorPersonId:owner,organizationId:org,purpose:'identity_link'},{action:'receipt',requestId}]);
  });
  it('keeps fixed refusal categories and strips unforeseen sensitive error text',async()=>{
    const s=setup();for(const [category,status] of [['conflict',409],['identity_refused',403],['account_deletion_write_blocked',403],['request_invalid',400]] as const){
      s.operation.mockRejectedValueOnce(new CareConnectionError(category));expect(await s.api(event())).toMatchObject({statusCode:status,body:JSON.stringify({error:category})});
    }
    s.operation.mockRejectedValueOnce(new Error('FICTIONAL secret code and raw SQL'));expect(await s.api(event())).toMatchObject({statusCode:503,body:'{"error":"service_unavailable"}'});
  });
});
