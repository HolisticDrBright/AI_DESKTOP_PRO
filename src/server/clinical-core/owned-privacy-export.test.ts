import {describe,it,expect,vi} from 'vitest';
import {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {createOwnedConsumerApi,type OwnedConsumerApiConfiguration} from './owned-consumer-api';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import type {ClinicalCoreDatabase} from './database';
const id='11111111-1111-4111-8111-111111111111';
const at='2026-09-16T00:00:00.000Z';
const context:ProductionClinicalRequestContext={actorPersonId:id,organizationId:id,identitySubject:'consumer-test-owner',identityPool:'consumer',purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
const row={collection:'wellness_profiles',recordId:id,revision:1,payload:{legacyField:'retained as originally saved'},deleted:false,consentRevision:1,receivedAt:at};
const page={exportId:id,asOf:at,section:'records',items:[row],next:null};
function setup(value:unknown){
  const query=vi.fn().mockResolvedValue({rows:[{result:value}]});
  const transaction=vi.fn(async work=>work({query}));
  return {query,transaction,adapter:createOwnedConsumerRecordsAdapter({transaction} as ClinicalCoreDatabase)};
}
describe('personal storage privacy export',()=>{
  it('returns an explicit partial-coverage manifest and strips DB-only fields',async()=>{
    const s=setup({exportId:id,asOf:at,expiresAt:'2026-09-16T00:15:00.000Z',recordCount:2,consentCount:3,ownerId:'never-forwarded'});
    const manifest=await s.adapter.startPrivacyExport(context,{requestId:id});
    expect(manifest.coverage.completeAccountExport).toBe(false);
    expect(manifest.coverage.excluded).toContain('other_device_local_caches_and_recovery_archives');
    expect(manifest).not.toHaveProperty('ownerId');
    expect(s.query.mock.calls[0][1]).toContain('consent_management');
  });
  it('refuses caller owners, nonconsumer identity and wrong purpose before data access',async()=>{
    const s=setup(page);
    await expect(s.adapter.startPrivacyExport(context,{requestId:id,ownerId:id} as {requestId:string})).rejects.toThrow('request_invalid');
    for(const patch of [{identityPool:'workforce'},{purpose:'clinical_data'},{productionBound:false}]){
      await expect(s.adapter.startPrivacyExport({...context,...patch} as ProductionClinicalRequestContext,{requestId:id})).rejects.toThrow('owner_required');
    }
    expect(s.query).not.toHaveBeenCalled();
  });
  it('exports historical payload without applying the newest clinical schema',async()=>{
    const s=setup({...page,items:[{...row,internalRequestId:'not-exported'}]});
    expect((await s.adapter.readPrivacyExport(context,{exportId:id,section:'records',limit:25})).items).toEqual([row]);
  });
  it('binds cursors to session and section, accepts tombstones and checks progression',async()=>{
    const next={key:row.collection,recordId:id,revision:1};
    const s=setup({...page,next});
    const first=await s.adapter.readPrivacyExport(context,{exportId:id,section:'records',limit:1});
    expect(first.nextCursor).toBeTruthy();
    for(const input of [{exportId:'22222222-2222-4222-8222-222222222222',section:'records' as const},{exportId:id,section:'consents' as const}]){
      await expect(s.adapter.readPrivacyExport(context,{...input,limit:1,cursor:first.nextCursor!})).rejects.toThrow('request_invalid');
    }
    await expect(s.adapter.readPrivacyExport(context,{exportId:id,section:'records',limit:1,cursor:first.nextCursor!})).rejects.toThrow('storage_unavailable');
    s.query.mockResolvedValue({rows:[{result:{...page,items:[{...row,revision:2,deleted:true,payload:{}}]}}]});
    expect((await s.adapter.readPrivacyExport(context,{exportId:id,section:'records',limit:1,cursor:first.nextCursor!})).items[0]).toMatchObject({revision:2,deleted:true,payload:{}});
  });
  it('rejects malformed responses instead of silently returning incomplete data',async()=>{
    for(const value of [{...page,items:[{...row,deleted:true}]},{...page,items:[row,row]},
      {...page,next:{key:row.collection,recordId:id,revision:2}},{...page,next:undefined},
      {...page,items:[{...row,revision:0}]},{...page,exportId:'other'}]){
      const s=setup(value);
      await expect(s.adapter.readPrivacyExport(context,{exportId:id,section:'records',limit:2})).rejects.toThrow('storage_unavailable');
    }
  });
  it('allows a byte-limited short page only with an exact progressing cursor',async()=>{
    const s=setup({...page,next:{key:row.collection,recordId:id,revision:1}});
    const value=await s.adapter.readPrivacyExport(context,{exportId:id,section:'records',limit:100});
    expect(value.items).toHaveLength(1);expect(value.nextCursor).not.toBeNull();
  });
  it('requires valid pagination and never accepts an owner selector',async()=>{
    const s=setup(page);
    for(const patch of [{limit:0},{limit:101},{cursor:'bad'},{ownerId:id},{section:'everything'}]){
      await expect(s.adapter.readPrivacyExport(context,{exportId:id,section:'records',limit:25,...patch} as Parameters<typeof s.adapter.readPrivacyExport>[1])).rejects.toThrow('request_invalid');
    }
    expect(s.query).not.toHaveBeenCalled();
  });
  it('routes privacy access independently of enabled feature scopes but preserves PHI activation',async()=>{
    const s=setup({exportId:id,asOf:at,expiresAt:'2026-09-16T00:15:00.000Z',recordCount:0,consentCount:0});
    const config:OwnedConsumerApiConfiguration={consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/test',consumerAudience:'12345678901234567890',phiAllowed:true,activationState:'approved',activationEvidenceSha256:'a'.repeat(64),allowedScopes:['forms_checkins']};
    const event={routeKey:'POST /clinical-core/consumer/personal/privacy-export',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:id}),requestContext:{authorizer:{jwt:{claims:{iss:config.consumerIssuer,aud:config.consumerAudience,sub:context.identitySubject,token_use:'id',email_verified:'true',iat:Date.parse(at)/1000,exp:Date.parse(at)/1000+600,'custom:person_id':id,'custom:organization_id':id,'custom:production_bound':'true'}}}}};
    const handler=createOwnedConsumerApi({configuration:config,adapter:()=>s.adapter,now:()=>Date.parse(at)});
    const result=await handler(event);expect(result.statusCode).toBe(200);expect(result.headers['cache-control']).toBe('no-store');
    const blocked=createOwnedConsumerApi({configuration:{...config,phiAllowed:false,activationState:'blocked'},adapter:()=>s.adapter});
    expect((await blocked(event)).statusCode).toBe(503);
    expect((await handler({...event,body:JSON.stringify({requestId:id,ownerId:id})})).statusCode).toBe(400);
  });
});
