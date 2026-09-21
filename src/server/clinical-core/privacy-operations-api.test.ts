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
  it('under qualification execution serves only the designated fictional workforce identity, admits sub-activations on their own evidence, marks responses and refuses unsafe configuration',async()=>{
    const qualification={reviewSha256:'e'.repeat(64),accountId:'588966314750',databaseName:'clinical_core_qualification',identitySubjects:['workforce-subject']};
    const blocked:PrivacyOperationsConfiguration={...config,phiAllowed:false,activation:'blocked',evidenceSha256:undefined};
    const call=vi.fn().mockResolvedValue({items:[]});
    const handler=createPrivacyOperationsApi({configuration:{...blocked,qualification,personalPurgeEnabled:true,personalPurgeEvidenceSha256:'c'.repeat(64)},operations:()=>call,now:()=>now});
    const listed=await handler(event());expect(listed.statusCode).toBe(200);expect(listed.headers['x-clinical-execution']).toBe('qualification');expect(call).toHaveBeenCalledTimes(1);
    expect((await handler({...event(),body:JSON.stringify({action:'previewPersonalPurge',privacyRequestId:uuid,policyVersion:'fictional'})})).statusCode).toBe(200);
    const refused=await handler(event({sub:'real-practitioner-0001'}));
    expect(refused.statusCode).toBe(503);expect(JSON.parse(refused.body)).toEqual({error:'production_not_activated',phiAllowed:false});expect(call).toHaveBeenCalledTimes(2);
    expect((await handler(event({'custom:synthetic_attested':'true'}))).statusCode).toBe(401);
    expect((await createPrivacyOperationsApi({configuration:config,operations:()=>call,now:()=>now})(event())).headers['x-clinical-execution']).toBeUndefined();
    expect(()=>createPrivacyOperationsApi({configuration:{...config,qualification},operations:()=>call})).toThrow('qualification_execution_invalid');
    expect(()=>createPrivacyOperationsApi({configuration:{...blocked,activation:'approved',qualification},operations:()=>call})).toThrow('qualification_execution_invalid');
    expect(()=>createPrivacyOperationsApi({configuration:{...blocked,qualification:{...qualification,accountId:'173535830222'}},operations:()=>call})).toThrow('qualification_execution_invalid');
    expect(()=>createPrivacyOperationsApi({configuration:{...blocked,qualification,personalPurgeEnabled:true},operations:()=>call})).toThrow('privacy_purge_activation_invalid');
  });
  it('keeps purge separately disabled and refuses unreviewed activation before opening the database',async()=>{
    const operations=vi.fn();
    const handler=createPrivacyOperationsApi({configuration:config,operations,now:()=>now});
    const preview={action:'previewPersonalPurge',privacyRequestId:uuid,policyVersion:'fictional'};
    const purge={action:'purgePersonal',privacyRequestId:uuid,policyVersion:'fictional',commandId:uuid,
      policySha256:'a'.repeat(64),inventorySha256:'b'.repeat(64),confirmation:'PURGE PERSONAL HISTORY'};
    for(const body of [preview,purge]){
      const result=await handler({...event(),body:JSON.stringify(body)});
      expect(result.statusCode).toBe(503);expect(JSON.parse(result.body)).toEqual({error:'personal_purge_not_activated'});
    }
    expect(operations).not.toHaveBeenCalled();
    expect(()=>createPrivacyOperationsApi({configuration:{...config,personalPurgeEnabled:true},operations})).toThrow('privacy_purge_activation_invalid');
    expect(()=>createPrivacyOperationsApi({configuration:{...config,phiAllowed:false,personalPurgeEnabled:true,personalPurgeEvidenceSha256:'c'.repeat(64)},operations})).toThrow('privacy_purge_activation_invalid');
    const call=vi.fn().mockResolvedValue({});
    const reviewed=createPrivacyOperationsApi({configuration:{...config,personalPurgeEnabled:true,personalPurgeEvidenceSha256:'c'.repeat(64)},operations:()=>call,now:()=>now});
    expect((await reviewed({...event(),body:JSON.stringify(preview)})).statusCode).toBe(200);
    for(const body of [{...purge,confirmation:'yes'},{...purge,inventorySha256:''},{...preview,ownerId:uuid}])
      expect((await reviewed({...event(),body:JSON.stringify(body)})).statusCode).toBe(400);
    expect(call).toHaveBeenCalledOnce();
  });
  it('keeps external purge behind the inventory activation and its own evidence, and gates the completion actions on activation only',async()=>{
    const operations=vi.fn();
    const inventoryOn={...config,externalInventoryEnabled:true,externalInventoryEvidenceSha256:'d'.repeat(64)};
    const purge={action:'purgeExternal',privacyRequestId:uuid,inventoryId:uuid,store:'labs',maxItems:5,confirmation:'PURGE EXTERNAL STORE'};
    const handler=createPrivacyOperationsApi({configuration:inventoryOn,operations,now:()=>now});
    const result=await handler({...event(),body:JSON.stringify(purge)});
    expect(result.statusCode).toBe(503);expect(JSON.parse(result.body)).toEqual({error:'external_purge_not_activated'});
    expect(operations).not.toHaveBeenCalled();
    expect(()=>createPrivacyOperationsApi({configuration:{...config,externalPurgeEnabled:true,externalPurgeEvidenceSha256:'e'.repeat(64)},operations})).toThrow('privacy_external_purge_activation_invalid');
    expect(()=>createPrivacyOperationsApi({configuration:{...inventoryOn,externalPurgeEnabled:true},operations})).toThrow('privacy_external_purge_activation_invalid');
    const call=vi.fn().mockResolvedValue({});
    const reviewed=createPrivacyOperationsApi({configuration:{...inventoryOn,externalPurgeEnabled:true,externalPurgeEvidenceSha256:'e'.repeat(64)},operations:()=>call,now:()=>now});
    expect((await reviewed({...event(),body:JSON.stringify(purge)})).statusCode).toBe(200);
    for(const body of [{...purge,confirmation:'yes'},{...purge,maxItems:11},{...purge,store:'clinic'},{...purge,ownerId:uuid}])
      expect((await reviewed({...event(),body:JSON.stringify(body)})).statusCode).toBe(400);
    const completion=vi.fn().mockResolvedValue({});
    const base=createPrivacyOperationsApi({configuration:config,operations:()=>completion,now:()=>now});
    for(const body of [{action:'recordDisposition',privacyRequestId:uuid,store:'clinic_records',outcome:'not_applicable',evidenceSha256:'f'.repeat(64)},
      {action:'retainByPolicy',privacyRequestId:uuid,store:'backups_and_audit',evidenceSha256:'f'.repeat(64),policyVersion:'fictional'},
      {action:'completeDeletion',privacyRequestId:uuid,confirmation:'COMPLETE DELETION REQUEST'}])
      expect((await base({...event(),body:JSON.stringify(body)})).statusCode).toBe(200);
    for(const body of [{action:'recordDisposition',privacyRequestId:uuid,store:'personal_records',outcome:'purged',evidenceSha256:'f'.repeat(64)},
      {action:'recordDisposition',privacyRequestId:uuid,store:'clinic_records',outcome:'purged',evidenceSha256:'f'.repeat(64)},
      {action:'retainByPolicy',privacyRequestId:uuid,store:'personal_records',evidenceSha256:'f'.repeat(64),policyVersion:'fictional'},
      {action:'completeDeletion',privacyRequestId:uuid,confirmation:'complete'}])
      expect((await base({...event(),body:JSON.stringify(body)})).statusCode).toBe(400);
    expect(completion).toHaveBeenCalledTimes(3);expect(call).toHaveBeenCalledOnce();expect(operations).not.toHaveBeenCalled();
  });
  it('keeps identity deletion behind its own reviewed evidence and exact confirmation',async()=>{
    const operations=vi.fn();
    const body={action:'purgeIdentity',privacyRequestId:uuid,confirmation:'DELETE CONSUMER IDENTITY'};
    const handler=createPrivacyOperationsApi({configuration:config,operations,now:()=>now});
    const result=await handler({...event(),body:JSON.stringify(body)});
    expect(result.statusCode).toBe(503);expect(JSON.parse(result.body)).toEqual({error:'identity_deletion_not_activated'});expect(operations).not.toHaveBeenCalled();
    expect(()=>createPrivacyOperationsApi({configuration:{...config,identityDeletionEnabled:true},operations})).toThrow('privacy_identity_deletion_activation_invalid');
    const call=vi.fn().mockResolvedValue({});
    const reviewed=createPrivacyOperationsApi({configuration:{...config,identityDeletionEnabled:true,identityDeletionEvidenceSha256:'e'.repeat(64)},operations:()=>call,now:()=>now});
    expect((await reviewed({...event(),body:JSON.stringify(body)})).statusCode).toBe(200);
    expect((await reviewed({...event(),body:JSON.stringify({...body,confirmation:'delete'})})).statusCode).toBe(400);
    expect(call).toHaveBeenCalledOnce();
  });
  it('keeps export retention behind its own reviewed evidence and bounded batch size',async()=>{
    const operations=vi.fn();
    const body={action:'cleanupExports',maxItems:10};
    const handler=createPrivacyOperationsApi({configuration:config,operations,now:()=>now});
    const result=await handler({...event(),body:JSON.stringify(body)});
    expect(result.statusCode).toBe(503);expect(JSON.parse(result.body)).toEqual({error:'export_cleanup_not_activated'});expect(operations).not.toHaveBeenCalled();
    expect(()=>createPrivacyOperationsApi({configuration:{...config,exportCleanupEnabled:true},operations})).toThrow('privacy_export_cleanup_activation_invalid');
    const call=vi.fn().mockResolvedValue({});
    const reviewed=createPrivacyOperationsApi({configuration:{...config,exportCleanupEnabled:true,exportCleanupEvidenceSha256:'f'.repeat(64)},operations:()=>call,now:()=>now});
    expect((await reviewed({...event(),body:JSON.stringify(body)})).statusCode).toBe(200);
    for(const bad of [{...body,maxItems:11},{...body,maxItems:0},{...body,ownerId:uuid},{action:'cleanupExports'},{action:'exportBacklog',maxItems:1},{action:'reconcileExports'}])
      expect((await reviewed({...event(),body:JSON.stringify(bad)})).statusCode).toBe(400);
    for(const more of [{action:'reconcileExports',maxItems:10},{action:'exportBacklog'}]){
      expect((await handler({...event(),body:JSON.stringify(more)})).statusCode).toBe(503);
      expect((await reviewed({...event(),body:JSON.stringify(more)})).statusCode).toBe(200);
    }
    expect(call).toHaveBeenCalledTimes(3);expect(operations).not.toHaveBeenCalled();
  });
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
