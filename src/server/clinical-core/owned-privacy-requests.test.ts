import {describe,it,expect,vi} from 'vitest';
import {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {clinicalUuid,type ClinicalCoreDatabase} from './database';
import {createOwnedConsumerApi,type OwnedConsumerApiConfiguration} from './owned-consumer-api';
import type {ApiGatewayV2Event} from './aws-identity-api';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
const uuid='11111111-1111-4111-8111-111111111111',req='33333333-3333-4333-8333-333333333333';
const now=Date.parse('2026-09-16T12:00:00Z');
const context:ProductionClinicalRequestContext={actorPersonId:uuid,organizationId:uuid,identitySubject:'owned-consumer-a',identityPool:'consumer',purpose:'consent_management',
  environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
const request=(patch:Record<string,unknown>={})=>({privacyRequestId:uuid,requestId:req,kind:'deletion',status:'submitted',submittedAt:'2026-09-16T12:00:00.000Z',updatedAt:'2026-09-16T12:00:00.000Z',
  completedAt:null,legalHold:false,fulfillment:[{store:'personal_records',outcome:'tombstoned',evidenceSha256:'a'.repeat(64),recordedAt:'2026-09-16T12:00:00.000Z'}],...patch});
function setup(result:unknown){
  const query=vi.fn().mockResolvedValue({rows:[{result}]});const transaction=vi.fn(async work=>work({query}));
  return {adapter:createOwnedConsumerRecordsAdapter({transaction} as unknown as ClinicalCoreDatabase),query,transaction};
}
describe('owned privacy requests',()=>{
  it('decodes real Aurora Data API JSON text and refuses invalid JSON',async()=>{
    const s=setup(JSON.stringify(request({duplicate:false})));
    await expect(s.adapter.submitPrivacyRequest(context,{requestId:req,kind:'deletion'})).resolves.toMatchObject({status:'submitted'});
    await expect(setup(JSON.stringify([request()])).adapter.listPrivacyRequests(context)).resolves.toHaveLength(1);
    await expect(setup('{bad').adapter.listPrivacyRequests(context)).rejects.toMatchObject({code:'storage_unavailable'});
  });
  it('submits deletion and correction requests under consent_management with exact parameters',async()=>{
    const s=setup(request({duplicate:false}));
    const state=await s.adapter.submitPrivacyRequest(context,{requestId:req,kind:'deletion'});
    expect(state).toMatchObject({kind:'deletion',status:'submitted',duplicate:false});
    expect(s.query.mock.calls[0][0]).toContain('set_request_context');expect(s.query.mock.calls[0][1]).toContain('consent_management');
    expect(s.query.mock.calls[1]).toEqual(['select clinical_core.submit_owned_privacy_request($1,$2,$3::jsonb) as result',[clinicalUuid(req),'deletion',null]]);
    const correction={version:'personal-correction/1',collection:'wellness_profiles',recordId:uuid,field:'height_cm',requestedValue:180,reason:'Entered in inches.',expectedRevision:1,expectedPayloadSha256:'a'.repeat(64)};
    const c=setup(request({kind:'correction',duplicate:false,correctionTarget:{collection:correction.collection,recordId:uuid,field:correction.field,
      expectedRevision:1,expectedPayloadSha256:'a'.repeat(64),requestSha256:'b'.repeat(64)}}));
    await c.adapter.submitPrivacyRequest(context,{requestId:req,kind:'correction',correction});
    expect(c.query.mock.calls[1][1]).toEqual([clinicalUuid(req),'correction',JSON.stringify(correction)]);
  });
  it('lists owner targets through the database boundary and refuses mismatched or unordered results',async()=>{
    const row={collection:'wellness_profiles',recordId:uuid,revision:1,payloadSha256:'a'.repeat(64),payload:{height_cm:170},receivedAt:'2026-09-16T12:00:00.000Z'};
    const s=setup([row]);expect(await s.adapter.listCorrectionTargets(context,{collection:'wellness_profiles'})).toEqual([row]);
    expect(s.query.mock.calls[1]).toEqual(['select clinical_core.list_owned_correction_targets($1,$2,$3) as result',['wellness_profiles',25,null]]);
    for(const rows of [[row,row],[{...row,collection:'protocols'}],[{...row,payloadSha256:'bad'}]]){
      await expect(setup(rows).adapter.listCorrectionTargets(context,{collection:'wellness_profiles'})).rejects.toMatchObject({code:'storage_unavailable'});
    }
    for(const patch of [{collection:'unknown'},{after:'bad'},{limit:26}]){
      await expect(s.adapter.listCorrectionTargets(context,{collection:'wellness_profiles',...patch})).rejects.toMatchObject({code:'request_invalid'});
    }
  });
  it.each([{requestId:'bad'},{kind:'export'},{kind:'correction'},{kind:'deletion',correction:{collection:'x',recordId:uuid,field:'f',requestedValue:1,reason:'r'}},
    {kind:'correction',correction:{collection:'x',recordId:uuid,field:'f',requestedValue:1,reason:'r',extra:1}},{kind:'correction',correction:{collection:'x',recordId:'bad',field:'f',requestedValue:1,reason:'r'}}])
    ('refuses malformed submissions %j before the database',async patch=>{
      const s=setup(request());await expect(s.adapter.submitPrivacyRequest(context,{requestId:req,kind:'deletion',...patch} as never)).rejects.toMatchObject({code:'request_invalid'});
      expect(s.transaction).not.toHaveBeenCalled();
    });
  it('tombstones only with explicit confirmation and validates the ledger shape it gets back',async()=>{
    const s=setup(request({status:'in_progress',tombstoned:4}));
    const state=await s.adapter.tombstonePersonalRecords(context,{requestId:req,confirmTombstoneAllPersonalRecords:true});
    expect(state.tombstoned).toBe(4);expect(s.query.mock.calls[1][0]).toBe('select clinical_core.tombstone_owned_personal_records($1) as result');
    await expect(s.adapter.tombstonePersonalRecords(context,{requestId:req,confirmTombstoneAllPersonalRecords:false as never})).rejects.toMatchObject({code:'request_invalid'});
    for(const bad of [request({status:'done'}),request({fulfillment:[{store:'everything',outcome:'purged',evidenceSha256:null,recordedAt:'x'}]}),request({legalHold:'no'})]){
      const t=setup([bad]);await expect(t.adapter.listPrivacyRequests(context)).rejects.toMatchObject({code:'storage_unavailable'});
    }
    const list=setup([request(),request({kind:'correction',privacyRequestId:req})]);
    expect((await list.adapter.listPrivacyRequests(context)).map(r=>r.kind)).toEqual(['deletion','correction']);
  });
  it('is reachable through the API without any feature scope and with strict bodies',async()=>{
    const config:OwnedConsumerApiConfiguration={consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/consumer',consumerAudience:'12345678901234567890',
      phiAllowed:true,activationState:'approved',activationEvidenceSha256:'a'.repeat(64),allowedScopes:['forms_checkins']};
    const query=vi.fn(async(sql:string)=>({rows:[{result:String(sql).includes('list_owned')?[request()]:request({duplicate:false})}]}));
    const transaction=vi.fn(async work=>work({query}));
    const handler=createOwnedConsumerApi({configuration:config,adapter:()=>createOwnedConsumerRecordsAdapter({transaction} as unknown as ClinicalCoreDatabase),now:()=>now});
    const claims={iss:config.consumerIssuer,aud:config.consumerAudience,token_use:'id',sub:'consumer-person',email_verified:'true','custom:person_id':uuid,'custom:organization_id':uuid,'custom:production_bound':'true',exp:now/1000+600,iat:now/1000-60};
    const event=(route:string,body?:unknown):ApiGatewayV2Event=>({routeKey:route,...(body?{body:JSON.stringify(body),headers:{'content-type':'application/json'}}:{queryStringParameters:{}}),requestContext:{authorizer:{jwt:{claims}}}});
    const listed=await handler(event('GET /clinical-core/consumer/personal/privacy-request'));
    expect(listed.statusCode).toBe(200);const data=JSON.parse(listed.body).data;expect(data.requests).toHaveLength(1);expect(data.coverage.completeAccountDeletion).toBe(false);
    expect((await handler(event('POST /clinical-core/consumer/personal/privacy-request',{requestId:req,kind:'deletion'}))).statusCode).toBe(200);
    expect((await handler(event('POST /clinical-core/consumer/personal/privacy-request',{requestId:req,kind:'deletion',ownerId:uuid}))).statusCode).toBe(400);
    expect((await handler(event('POST /clinical-core/consumer/personal/privacy-request/tombstone',{requestId:req}))).statusCode).toBe(400);
    expect(query.mock.calls.every(([sql])=>!String(sql).includes('tombstone_owned'))).toBe(true);
  });
});
