import {describe,it,expect,vi} from "vitest";
import {createHash} from 'node:crypto';
import {createOwnedConsumerApi,type OwnedConsumerApiConfiguration} from "./owned-consumer-api";
import {createOwnedConsumerRecordsAdapter} from "./owned-consumer-records";
import {clinicalUuid,ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from "./database";
import type {ApiGatewayV2Event} from "./aws-identity-api";
const id="11111111-1111-4111-8111-111111111111";
const now=Date.parse("2026-09-08T00:00:00Z");
const config:OwnedConsumerApiConfiguration={consumerIssuer:"https://cognito-idp.us-east-2.amazonaws.com/consumer",consumerAudience:"12345678901234567890",phiAllowed:true,activationState:"approved",activationEvidenceSha256:"a".repeat(64),allowedScopes:["forms_checkins"]};
function event(route="GET /clinical-core/consumer/personal/records"):ApiGatewayV2Event { return {routeKey:route,queryStringParameters:{collection:"wellness_profiles"},requestContext:{authorizer:{jwt:{claims:{iss:config.consumerIssuer,aud:config.consumerAudience,token_use:"id",sub:"consumer-person",email_verified:"true","custom:person_id":id,"custom:organization_id":id,"custom:production_bound":"true",exp:now/1000+600,iat:now/1000-60}}}}}; }
function setup(c=config) { const query=vi.fn(async()=>({rows:[{result:[]}]})); const transaction=vi.fn(async work=>work({query})); const adapter=vi.fn(()=>createOwnedConsumerRecordsAdapter({transaction} as ClinicalCoreDatabase)); return {handler:createOwnedConsumerApi({configuration:c,adapter,now:()=>now}),adapter,query}; }
describe("independent consumer API",()=>{
  it('returns the deletion write fence as a safe explicit refusal, not a sign-in or outage error',async()=>{
    const s=setup();s.query.mockRejectedValueOnce(new ClinicalCoreDatabaseRejection('account_deletion_write_blocked'));
    const response=await s.handler(event());
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({error:'account_deletion_write_blocked'});
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it("is blocked before any data access and rejects incomplete activation",async()=>{
    const s=setup({...config,phiAllowed:false,activationState:"blocked",allowedScopes:[]});
    expect((await s.handler(event())).statusCode).toBe(503); expect(s.adapter).not.toHaveBeenCalled();
    expect(()=>setup({...config,activationEvidenceSha256:undefined})).toThrow("owned_api_activation_invalid");
  });
  it("reads with verified ownership, without a fixed clinic organization",async()=>{
    const s=setup(); const e=event(); e.requestContext!.authorizer!.jwt!.claims!["custom:organization_id"]="22222222-2222-4222-8222-222222222222";
    const r=await s.handler(e); expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).data).toEqual({items:[],nextCursor:null});
    expect(s.query.mock.calls.length).toBe(2); expect(r.headers["cache-control"]).toBe("no-store");
  });
  it("rejects wrong issuer/audience, expired, unverified, and synthetic claims",async()=>{
    for(const patch of [{iss:"workforce"},{aud:"other"},{exp:now/1000},{email_verified:"false"},{"custom:synthetic_attested":"true"},{"custom:production_bound":"false"},{iat:now/1000+120},{iat:''},{iat:0},{iat:null}]) {
      const s=setup(); const e=event(); Object.assign(e.requestContext!.authorizer!.jwt!.claims!,patch);
      expect((await s.handler(e)).statusCode).toBe(401); expect(s.adapter).not.toHaveBeenCalled();
    }
  });
  it("ignores unverified authorization headers",async()=>{const s=setup(); const e=event(); delete e.requestContext; e.headers={authorization:"Bearer any-token"}; expect((await s.handler(e)).statusCode).toBe(401);});
  it("refuses owner injection, malformed cursors and unknown routes",async()=>{
    const s=setup(); const e=event(); e.queryStringParameters!.ownerId=id;
    expect((await s.handler(e)).statusCode).toBe(400);
    e.queryStringParameters={collection:"wellness_profiles",cursor:"bad"}; expect((await s.handler(e)).statusCode).toBe(400);
    e.routeKey="GET /clinical-core/workforce/personal/records"; expect((await s.handler(e)).statusCode).toBe(404);
  });
  it("publishes the deployment's enabled scopes as posture without touching stored data",async()=>{
    const s=setup({...config,allowedScopes:["lab_history","ai_context","forms_checkins"]});
    const e=event("GET /clinical-core/consumer/personal/posture");e.queryStringParameters={};
    const r=await s.handler(e);expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).data).toEqual({contractVersion:"personal-posture/1",launchTier:"core",enabledScopes:["ai_context","forms_checkins","lab_history"]});
    expect(s.adapter).not.toHaveBeenCalled();expect(r.headers["cache-control"]).toBe("no-store");
    e.queryStringParameters={collection:"wellness_profiles"};expect((await s.handler(e)).statusCode).toBe(400);
    const unverified=event("GET /clinical-core/consumer/personal/posture");unverified.queryStringParameters={};delete unverified.requestContext;
    expect((await s.handler(unverified)).statusCode).toBe(401);
  });
  it("lists tombstones only through the explicit view under the same scope gate",async()=>{
    const list=vi.fn(async()=>[]),listTombstones=vi.fn(async()=>[{recordId:id,revision:2,deleted:true,receivedAt:"2026-09-01T00:00:00.000Z"}]);
    const adapter=()=>({list,listTombstones}) as unknown as ReturnType<typeof createOwnedConsumerRecordsAdapter>;
    const handler=createOwnedConsumerApi({configuration:config,adapter,now:()=>now});
    const e=event();e.queryStringParameters={collection:"wellness_profiles",view:"tombstones",limit:"5"};
    const r=await handler(e);expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).data).toEqual({items:[{recordId:id,revision:2,deleted:true,receivedAt:"2026-09-01T00:00:00.000Z"}],nextCursor:null});
    expect(listTombstones).toHaveBeenCalledWith(expect.anything(),{collection:"wellness_profiles",limit:5});expect(list).not.toHaveBeenCalled();
    e.queryStringParameters={collection:"wellness_profiles",view:"live"};expect((await handler(e)).statusCode).toBe(400);
    e.queryStringParameters={collection:"wearable_daily_records",view:"tombstones"};
    expect(JSON.parse((await handler(e)).body).error).toBe("feature_scope_not_enabled");expect(listTombstones).toHaveBeenCalledTimes(1);
  });
  it("does not activate wearable or reproductive scopes with Core identity alone",async()=>{
    const s=setup(); const e=event(); e.queryStringParameters={collection:"wearable_daily_records"};
    expect(JSON.parse((await s.handler(e)).body).error).toBe("feature_scope_not_enabled"); expect(s.adapter).not.toHaveBeenCalled();
  });
  it("preserves empty results and sanitizes unexpected failures",async()=>{
    const s=setup(); s.adapter.mockImplementation(()=>{throw new Error("secret private health content")});
    const r=await s.handler(event()); expect(r.statusCode).toBe(503); expect(r.body).toBe('{"error":"storage_unavailable"}');
  });
  it('allows withdrawal when a formerly enabled feature is removed from rollout',async()=>{
    const setConsent=vi.fn(async()=>({revision:2,status:'revoked'}));
    const adapter=()=>({setConsent}) as unknown as ReturnType<typeof createOwnedConsumerRecordsAdapter>;
    const handler=createOwnedConsumerApi({configuration:config,adapter,now:()=>now});
    const e=event('POST /clinical-core/consumer/personal/consent');
    e.queryStringParameters={};e.headers={'content-type':'application/json'};
    e.body=JSON.stringify({scope:'wearables',status:'revoked',expectedRevision:1});
    expect((await handler(e)).statusCode).toBe(200);expect(setConsent).toHaveBeenCalledTimes(1);
    e.body=JSON.stringify({scope:'wearables',status:'granted',expectedRevision:2,releaseVersion:'test/1'});
    expect((await handler(e)).statusCode).toBe(403);expect(setConsent).toHaveBeenCalledTimes(1);
  });
});
describe('authoritative active plan routes',()=>{
  const plansConfig:OwnedConsumerApiConfiguration={...config,allowedScopes:['protocols_supplements']};
  const state={current:null,history:[],historyLimit:100};
  it('requires the plans scope, exact bodies, and never adopts from a GET',async()=>{
    const s=setup({...config,allowedScopes:['forms_checkins']});
    const e=event('GET /clinical-core/consumer/personal/active-plan');e.queryStringParameters={};
    expect((await s.handler(e)).statusCode).toBe(403);expect(s.query).not.toHaveBeenCalled();
    const t=setup(plansConfig);(t.query as unknown as {mockResolvedValue:(v:unknown)=>void}).mockResolvedValue({rows:[{result:state}]});
    const g=event('GET /clinical-core/consumer/personal/active-plan');g.queryStringParameters={};
    const read=await t.handler(g);expect(read.statusCode).toBe(200);expect(JSON.parse(read.body).data).toEqual({version:'owned-active-plan/1',...state});
    expect((t.query as unknown as {mock:{calls:unknown[][]}}).mock.calls.some(([sql])=>String(sql).includes('adopt_owned_active_plan'))).toBe(false);
    const bad=event('POST /clinical-core/consumer/personal/active-plan');bad.queryStringParameters=undefined;bad.headers={'content-type':'application/json'};
    bad.body=JSON.stringify({recordId:id,revision:1,contentSha256:'a'.repeat(64),consentRevision:1,requestId:id,expectedPrevious:null,ownerId:id});
    expect((await t.handler(bad)).statusCode).toBe(400);
  });
  it('adopts and releases through the verified context with the exact database calls',async()=>{
    const t=setup(plansConfig);
    const hash=createHash('sha256').update('{}').digest('hex');
    (t.query as unknown as {mockImplementation:(v:unknown)=>void}).mockImplementation(async(sql:string)=>({rows:[{result:sql.includes('get_owned_consumer_record(')?{recordId:id,revision:1,deleted:false,payload:{}}:{current:{recordId:id,revision:1,contentSha256:hash,consentRevision:1,adoptedAt:'2026-09-16T00:00:00.000Z',adoptionRequestId:id,supersedes:null},history:[],historyLimit:100,duplicate:false}}]}));
    const adopt=event('POST /clinical-core/consumer/personal/active-plan');adopt.queryStringParameters=undefined;adopt.headers={'content-type':'application/json'};
    adopt.body=JSON.stringify({recordId:id,revision:1,contentSha256:hash,consentRevision:1,requestId:id,expectedPrevious:null});
    const adopted=await t.handler(adopt);expect(adopted.statusCode).toBe(200);expect(JSON.parse(adopted.body).data.current.recordId).toBe(id);
    expect((t.query as unknown as {mock:{calls:unknown[][]}}).mock.calls.find(([sql])=>String(sql).includes('adopt_owned_active_plan'))?.[1]).toEqual([clinicalUuid(id),1,hash,1,clinicalUuid(id),null,null]);
    (t.query as unknown as {mockResolvedValue:(v:unknown)=>void}).mockResolvedValue({rows:[{result:{current:null,history:[],historyLimit:100,duplicate:false}}]});
    const release=event('POST /clinical-core/consumer/personal/active-plan/release');release.queryStringParameters=undefined;release.headers={'content-type':'application/json'};
    release.body=JSON.stringify({requestId:id,expected:{recordId:id,revision:1}});
    const released=await t.handler(release);expect(released.statusCode).toBe(200);expect(JSON.parse(released.body).data.current).toBeNull();
  });
});

describe('large-export job routes',()=>{
  const job={contract:'personal-storage-export-job/1',jobId:id,status:'running',asOf:'2026-09-08T00:00:00.000Z',requestedAt:'2026-09-08T00:00:00.000Z',readyAt:null,expiresAt:'2026-09-10T00:00:00.000Z',
    recordCount:6000,consentCount:3,exportedRecords:100,exportedConsents:0,parts:1,bytesWritten:5242880,byteLength:null,objectChecksum:null,failureCode:null,objectDeleted:false,version:3,
    coverage:{completeAccountExport:false,included:[],excluded:[]}};
  function jobSetup(){
    const s=setup();
    const jobs={requestPrivacyExportJob:vi.fn(async()=>({...job,status:'requested',replayed:false})),getPrivacyExportJob:vi.fn(async()=>job),
      advancePrivacyExportJob:vi.fn(async()=>({...job,exportedRecords:300,parts:2})),cancelPrivacyExportJob:vi.fn(async()=>({...job,status:'cancelled'})),
      issuePrivacyExportDownload:vi.fn(async()=>({jobId:id,url:'https://fictional-bucket.s3.us-east-2.amazonaws.com/personal-exports/x/y.json?X-Amz-Expires=300',expiresInSeconds:300,byteLength:12,objectChecksum:'c'})),
      cleanupPrivacyExportJobs:vi.fn(async()=>({cleaned:0,remaining:0})),reconcilePrivacyExportJobs:vi.fn(async()=>({confirmed:0,reopened:0,pending:0}))};
    return {...s,jobs,handler:createOwnedConsumerApi({configuration:config,adapter:s.adapter,now:()=>now,exportJobs:()=>jobs as never,passBudgetMs:1000})};
  }
  const route=(method:'GET'|'POST',suffix='')=>`${method} /clinical-core/consumer/personal/privacy-export/job${suffix}`;
  const call=(s:ReturnType<typeof jobSetup>,r:string,body?:Record<string,unknown>,query?:Record<string,string>,claims:Record<string,unknown>={})=>{
    const e=event(r);e.queryStringParameters=query??{};if(body){e.body=JSON.stringify(body);e.headers={'content-type':'application/json'};}
    Object.assign(e.requestContext!.authorizer!.jwt!.claims!,claims);return s.handler(e);};
  it('refuses every job route with a clear code when no reviewed export delivery is configured',async()=>{
    const s=setup();
    for(const [r,body,query] of [[route('POST'),{requestId:id},undefined],[route('GET'),undefined,{jobId:id}],[route('POST','/cancel'),{jobId:id},undefined],[route('POST','/download'),{jobId:id},undefined]] as const){
      const e=event(r);e.queryStringParameters=query?{...query}:{};if(body){e.body=JSON.stringify(body);e.headers={'content-type':'application/json'};}
      const response=await s.handler(e);expect(response.statusCode).toBe(503);expect(JSON.parse(response.body)).toEqual({error:'export_delivery_not_configured'});
    }
    expect(s.query).not.toHaveBeenCalled();
  });
  it('requests, polls with one bounded pass per advance, cancels with cleanup, and never advances a finished job',async()=>{
    const s=jobSetup();
    const requested=await call(s,route('POST'),{requestId:id});
    expect(requested.statusCode).toBe(200);expect(JSON.parse(requested.body).data).toMatchObject({status:'requested',cleanup:{cleaned:0}});
    expect(s.jobs.requestPrivacyExportJob).toHaveBeenCalledWith(expect.objectContaining({purpose:'consent_management',identityPool:'consumer'}),{requestId:id});
    const polled=await call(s,route('GET'),undefined,{jobId:id});
    expect(JSON.parse(polled.body).data).toMatchObject({status:'running',exportedRecords:100});expect(s.jobs.advancePrivacyExportJob).not.toHaveBeenCalled();
    const advanced=await call(s,route('GET'),undefined,{jobId:id,advance:'true'});
    expect(JSON.parse(advanced.body).data).toMatchObject({exportedRecords:300,parts:2});
    expect(s.jobs.advancePrivacyExportJob).toHaveBeenCalledWith(expect.any(Object),{jobId:id},1000,expect.any(AbortSignal));
    s.jobs.getPrivacyExportJob.mockResolvedValueOnce({...job,status:'ready'});
    await call(s,route('GET'),undefined,{jobId:id,advance:'true'});expect(s.jobs.advancePrivacyExportJob).toHaveBeenCalledTimes(1);
    expect((await call(s,route('GET'),undefined,{jobId:id,advance:'yes'})).statusCode).toBe(400);
    expect((await call(s,route('GET'),undefined,{jobId:id,ownerId:id})).statusCode).toBe(400);
    const cancelled=await call(s,route('POST','/cancel'),{jobId:id});
    expect(JSON.parse(cancelled.body).data).toMatchObject({status:'cancelled',cleanup:{cleaned:0,remaining:0},reconcile:{confirmed:0,reopened:0,pending:0}});
    expect(s.jobs.cleanupPrivacyExportJobs).toHaveBeenCalledTimes(2);
  });
  it('issues a download only with a sign-in in the last five minutes and never echoes a non-https link',async()=>{
    const s=jobSetup();
    const fresh=await call(s,route('POST','/download'),{jobId:id},undefined,{auth_time:now/1000-120});
    expect(fresh.statusCode).toBe(200);expect(JSON.parse(fresh.body).data.url).toMatch(/^https:\/\//);
    expect(s.jobs.issuePrivacyExportDownload).toHaveBeenCalledWith(expect.any(Object),{jobId:id},(now/1000-120)*1000,expect.any(AbortSignal));
    expect((await call(s,route('POST','/download'),{jobId:id})).statusCode).toBe(401);
    expect(JSON.parse((await call(s,route('POST','/download'),{jobId:id})).body)).toEqual({error:'reauth_required'});
    expect((await call(s,route('POST','/download'),{jobId:id,confirm:true},undefined,{auth_time:now/1000-120})).statusCode).toBe(400);
    expect(s.jobs.issuePrivacyExportDownload).toHaveBeenCalledTimes(1);
  });
});
