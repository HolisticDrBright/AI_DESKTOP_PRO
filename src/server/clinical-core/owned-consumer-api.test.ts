import {describe,it,expect,vi} from "vitest";
import {createOwnedConsumerApi,type OwnedConsumerApiConfiguration} from "./owned-consumer-api";
import {createOwnedConsumerRecordsAdapter} from "./owned-consumer-records";
import type {ClinicalCoreDatabase} from "./database";
import type {ApiGatewayV2Event} from "./aws-identity-api";
const id="11111111-1111-4111-8111-111111111111";
const now=Date.parse("2026-09-08T00:00:00Z");
const config:OwnedConsumerApiConfiguration={consumerIssuer:"https://cognito-idp.us-east-2.amazonaws.com/consumer",consumerAudience:"12345678901234567890",phiAllowed:true,activationState:"approved",activationEvidenceSha256:"a".repeat(64),allowedScopes:["forms_checkins"]};
function event(route="GET /clinical-core/consumer/personal/records"):ApiGatewayV2Event { return {routeKey:route,queryStringParameters:{collection:"wellness_profiles"},requestContext:{authorizer:{jwt:{claims:{iss:config.consumerIssuer,aud:config.consumerAudience,token_use:"id",sub:"consumer-person",email_verified:"true","custom:person_id":id,"custom:organization_id":id,"custom:production_bound":"true",exp:now/1000+600,iat:now/1000-60}}}}}; }
function setup(c=config) { const query=vi.fn(async()=>({rows:[{result:[]}]})); const transaction=vi.fn(async work=>work({query})); const adapter=vi.fn(()=>createOwnedConsumerRecordsAdapter({transaction} as ClinicalCoreDatabase)); return {handler:createOwnedConsumerApi({configuration:c,adapter,now:()=>now}),adapter,query}; }
describe("independent consumer API",()=>{
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
