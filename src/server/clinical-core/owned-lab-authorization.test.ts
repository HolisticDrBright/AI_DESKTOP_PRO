import {describe,it,expect,vi} from 'vitest';
import {createOwnedLabAuthorization,LabAuthorizationRevoked,sameLabAuthorization,LAB_AUTHORIZATION_SCOPES} from './owned-lab-authorization';
import {OwnedStorageError,type StorageConsentState} from './owned-consumer-records';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
const now=Date.parse('2026-09-16T12:00:00Z'),uuid='11111111-1111-4111-8111-111111111111';
const context:ProductionClinicalRequestContext={actorPersonId:uuid,organizationId:uuid,identitySubject:'owned-consumer-a',identityPool:'consumer',purpose:'clinical_data',
  environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
function state(scope:StorageConsentState['scope'],revision=1):StorageConsentState{return {scope,release:{version:'approved-fixture/1',content:'test only',contentSha256:'a'.repeat(64),approvedAt:new Date(now-1000).toISOString()},
  current:{status:'granted',revision,releaseVersion:'approved-fixture/1',recordedAt:new Date(now-500).toISOString()},history:[],historyLimit:100,activeRevision:revision};}
function setup(){const consentState=vi.fn(async(_c:ProductionClinicalRequestContext,scope:StorageConsentState['scope'])=>state(scope));
  return {consentState,auth:createOwnedLabAuthorization(()=>({consentState}),()=>now)};}
describe('owned lab authorization',()=>{
  it('binds both owner-specific scopes with revision, release version and content hash',async()=>{
    const s=setup();const captured=await s.auth.capture(context);
    expect(LAB_AUTHORIZATION_SCOPES).toEqual(['ai_context','lab_history']);
    expect(captured).toEqual({version:'owned-lab/1',personId:uuid,organizationId:uuid,identitySubject:'owned-consumer-a',
      consents:{ai_context:{revision:1,releaseVersion:'approved-fixture/1',contentSha256:'a'.repeat(64)},lab_history:{revision:1,releaseVersion:'approved-fixture/1',contentSha256:'a'.repeat(64)}}});
    expect(s.consentState.mock.calls.map(([c,scope])=>[c.purpose,scope])).toEqual([['consent_management','ai_context'],['consent_management','lab_history']]);
    await s.auth.policy.verify({ownerSub:'owned-consumer-a',organizationId:uuid,personId:uuid,authorization:captured});
  });
  it.each([{current:null},{release:null},{activeRevision:null},{activeRevision:2}])('refuses capture without a current granted release %j',async patch=>{
    const s=setup();s.consentState.mockImplementation(async(_c,scope)=>({...state(scope),...patch}));
    await expect(s.auth.capture(context)).rejects.toBeInstanceOf(LabAuthorizationRevoked);
  });
  it('does not grant processing from AI consent alone or lab-history consent alone',async()=>{
    for(const missing of ['ai_context','lab_history'] as const){
      const s=setup();s.consentState.mockImplementation(async(_c,scope)=>scope===missing?{...state(scope),current:null}:state(scope));
      await expect(s.auth.capture(context)).rejects.toBeInstanceOf(LabAuthorizationRevoked);
    }
  });
  it('revokes when consent is withdrawn, re-granted with a new revision, or the release changes',async()=>{
    const s=setup();const captured=await s.auth.capture(context);const job={ownerSub:'owned-consumer-a',organizationId:uuid,personId:uuid,authorization:captured};
    s.consentState.mockImplementation(async(_c,scope)=>({...state(scope),current:{...state(scope).current!,status:'revoked'}}));
    await expect(s.auth.policy.verify(job)).rejects.toBeInstanceOf(LabAuthorizationRevoked);
    s.consentState.mockImplementation(async(_c,scope)=>state(scope,2));
    await expect(s.auth.policy.verify(job)).rejects.toBeInstanceOf(LabAuthorizationRevoked);
    s.consentState.mockImplementation(async(_c,scope)=>({...state(scope),release:{...state(scope).release!,contentSha256:'b'.repeat(64)}}));
    await expect(s.auth.policy.verify(job)).rejects.toBeInstanceOf(LabAuthorizationRevoked);
  });
  it('refuses a job whose stored identity disagrees with its authorization, and forged shapes',async()=>{
    const s=setup();const captured=await s.auth.capture(context);
    await expect(s.auth.policy.verify({ownerSub:'owned-consumer-b',organizationId:uuid,personId:uuid,authorization:captured})).rejects.toBeInstanceOf(LabAuthorizationRevoked);
    await expect(s.auth.policy.verify({ownerSub:'owned-consumer-a',organizationId:uuid,personId:uuid})).rejects.toBeInstanceOf(LabAuthorizationRevoked);
    await expect(s.auth.policy.verify({ownerSub:'owned-consumer-a',organizationId:uuid,personId:uuid,authorization:{...captured,version:'owned-voice/1' as 'owned-lab/1'}})).rejects.toBeInstanceOf(LabAuthorizationRevoked);
    expect(s.consentState).toHaveBeenCalledTimes(2);
  });
  it('treats identity/consent storage refusals as revocation but a database outage as retryable',async()=>{
    const s=setup();const captured=await s.auth.capture(context);const job={ownerSub:'owned-consumer-a',organizationId:uuid,personId:uuid,authorization:captured};
    s.consentState.mockRejectedValue(new OwnedStorageError('owner_required'));
    await expect(s.auth.policy.verify(job)).rejects.toBeInstanceOf(LabAuthorizationRevoked);
    s.consentState.mockRejectedValue(new Error('identity database offline'));
    await expect(s.auth.policy.verify(job)).rejects.toThrow('identity database offline');
  });
  it('compares authorizations structurally',async()=>{
    const s=setup();const a=await s.auth.capture(context);
    expect(sameLabAuthorization(a,JSON.parse(JSON.stringify(a)))).toBe(true);
    expect(sameLabAuthorization(a,{...a,consents:{...a.consents,lab_history:{...a.consents.lab_history,revision:2}}})).toBe(false);
  });
});
