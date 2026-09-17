import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createOwnedVoiceApi,type OwnedVoiceConfiguration,type OwnedVoiceEvent} from './owned-voice-api';
import {VoiceJobs,type VoiceJob,type VoiceRepository,type VoiceProvider} from './voice-jobs';
import {OwnedStorageError,type StorageConsentState} from './owned-consumer-records';
import {createOwnedVoiceAuthorization,voiceOwner} from './owned-voice-authorization';
import {ownedConsumerIdentity} from './owned-consumer-api';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {CoreSubscriptionError} from './core-subscription-guard';

const now=Date.parse('2026-09-15T12:00:00Z'),uuid='11111111-1111-4111-8111-111111111111';
const config:OwnedVoiceConfiguration={consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/consumer',consumerAudience:'12345678901234567890',
  phiAllowed:true,activationState:'approved',activationEvidenceSha256:'a'.repeat(64),providerEvidenceSha256:'b'.repeat(64),allowedScopes:['ai_context','voice_transcription']};
const input={requestId:uuid,audioBase64:Buffer.alloc(64,1).toString('base64'),mimeType:'audio/wav',consentVersion:'patient-chat-consent/1',purpose:'patient_chat_voice_input'};
function event(method='POST',id?:string):OwnedVoiceEvent{return {rawPath:'/clinical-core/consumer/chat-transcription/jobs'+(id?'/'+id:''),
  ...(method==='POST'?{body:JSON.stringify(input)}:{}),headers:{'content-type':'application/json'},
  requestContext:{http:{method},authorizer:{jwt:{claims:{iss:config.consumerIssuer,aud:config.consumerAudience,sub:'owned-consumer-a',token_use:'id',
    email_verified:'true','custom:person_id':uuid,'custom:organization_id':uuid,'custom:production_bound':'true',iat:now/1000-60,exp:now/1000+600}}}}};}
let rows:Map<string,VoiceJob>,repo:VoiceRepository,provider:VoiceProvider,consentState:ReturnType<typeof vi.fn<(context:ProductionClinicalRequestContext,scope:StorageConsentState['scope'])=>Promise<StorageConsentState>>>,seconds:number;
function state(scope:StorageConsentState['scope'],revision=1):StorageConsentState{return {scope,release:{version:'approved-fixture/1',content:'test only',contentSha256:'a'.repeat(64),approvedAt:new Date(now-1000).toISOString()},
  current:{status:'granted',revision,releaseVersion:'approved-fixture/1',recordedAt:new Date(now-500).toISOString()},history:[],historyLimit:100,activeRevision:revision};}
function setup(c=config){const adapter=vi.fn(()=>({consentState}));const factory=vi.fn(policy=>new VoiceJobs(repo,provider,()=>seconds,policy));
  const requireCore=vi.fn(async()=>{});
  return {adapter,factory,requireCore,handler:createOwnedVoiceApi({configuration:c,adapter,service:factory,now:()=>now,requireCore})};}
beforeEach(()=>{
  seconds=now/1000;rows=new Map();consentState=vi.fn(async(_context,scope)=>state(scope));
  repo={get:async id=>rows.has(id)?structuredClone(rows.get(id)!):undefined,
    insert:async job=>{if(rows.has(job.id))return false;rows.set(job.id,structuredClone(job));return true;},
    acquire:async(id,token,time)=>{const r=rows.get(id);if(!r||(r.leaseUntil??0)>=time)return;Object.assign(r,{leaseToken:token,leaseUntil:time+90});return structuredClone(r);},
    release:async(id,token,changes)=>{const r=rows.get(id)!;if(r.leaseToken!==token)throw new Error('lease_lost');Object.assign(r,changes);delete r.leaseToken;delete r.leaseUntil;if(r.state==='cleaned'){r.pending='work';delete r.expiresAt;}},
    cancel:async(id,owner)=>{const r=rows.get(id)!;if(r.owner!==owner)throw new Error('wrong_owner');r.cancelled=true;r.nextWork=seconds;},
    due:async t=>({ids:[...rows.values()].filter(r=>r.pending&&r.nextWork<=t).map(r=>r.id),next:null})};
  provider={upload:vi.fn().mockResolvedValue(undefined),start:vi.fn().mockResolvedValue(undefined),status:vi.fn().mockResolvedValue('missing'),
    transcript:vi.fn().mockResolvedValue('Fictional voice.'),remove:vi.fn().mockResolvedValue(undefined)};
});
describe('independent production voice',()=>{
  it('returns a safe hold refusal on cleanup-triggering reads without claiming erasure',async()=>{
    const s=setup(),created=JSON.parse((await s.handler(event())).body);
    rows.get(created.jobId)!.cancelled=true;
    vi.mocked(provider.remove).mockRejectedValue(new OwnedStorageError('legal_hold'));
    const response=await s.handler(event('GET',created.jobId));
    expect(response.statusCode).toBe(409);expect(JSON.parse(response.body)).toEqual({error:'voice_deletion_held'});
    expect(rows.get(created.jobId)!.state).not.toBe('cleaned');expect(provider.transcript).not.toHaveBeenCalled();
  });
  const drainConfig:OwnedVoiceConfiguration={...config,phiAllowed:false,activationState:'draining',allowedScopes:[],cleanupEvidenceSha256:'c'.repeat(64)};
  it.each([{phiAllowed:true},{allowedScopes:['voice_transcription']},{cleanupEvidenceSha256:undefined},
    {cleanupEvidenceSha256:'not-reviewed'},{activationEvidenceSha256:undefined},{providerEvidenceSha256:undefined}])
    ('refuses malformed drain configuration %j',patch=>{
      expect(()=>setup({...drainConfig,...patch})).toThrow('owned_voice_cleanup_configuration_invalid');
    });
  it('drain refuses every public route and forged scheduler envelopes before identity/data access',async()=>{
    const s=setup(drainConfig);
    for(const request of [event(),event('GET','a'.repeat(64)),event('DELETE','a'.repeat(64)),
      {...event(),source:'aws.events'},{source:'aws.events',rawPath:'/anything'},{source:'aws.events',body:'{}'}]){
      expect((await s.handler(request)).statusCode).toBe(503);
    }
    expect(s.adapter).not.toHaveBeenCalled();expect(s.factory).not.toHaveBeenCalled();expect(s.requireCore).not.toHaveBeenCalled();
  });
  it.each(['uploading','queued','ready'] as const)('drain cancels %s without fresh processing consent (cleanup provider mocked)',async phase=>{
    const created=JSON.parse((await setup().handler(event())).body);
    rows.get(created.jobId)!.state=phase;seconds+=61;
    vi.clearAllMocks();consentState.mockRejectedValue(new Error('identity database offline'));
    const s=setup(drainConfig);await s.handler({source:'aws.events'});
    expect(rows.get(created.jobId)).toMatchObject({state:'cleaned',cancelled:true});
    expect(rows.get(created.jobId)).toMatchObject({pending:'work',cleanupWatchVersion:'voice-cleanup-watch/1',lastCleanupAt:seconds});
    expect(rows.get(created.jobId)?.expiresAt).toBeUndefined();
    expect(s.adapter).not.toHaveBeenCalled();expect(s.requireCore).not.toHaveBeenCalled();
    expect(provider.upload).not.toHaveBeenCalled();expect(provider.start).not.toHaveBeenCalled();expect(provider.transcript).not.toHaveBeenCalled();
    expect(provider.remove).toHaveBeenCalledOnce();
  });
  it('drain waits for a running provider then cleans on a restarted worker',async()=>{
    const created=JSON.parse((await setup().handler(event())).body);seconds+=61;
    vi.mocked(provider.status).mockResolvedValue('processing');
    await setup(drainConfig).handler({source:'aws.events'});
    expect(rows.get(created.jobId)).toMatchObject({cancelled:true,pending:'work'});
    expect(rows.get(created.jobId)?.expiresAt).toBeUndefined();expect(provider.remove).not.toHaveBeenCalled();
    seconds+=61;vi.mocked(provider.status).mockResolvedValue('ready');
    await setup(drainConfig).handler({source:'aws.events'});
    expect(rows.get(created.jobId)?.state).toBe('cleaned');expect(provider.start).not.toHaveBeenCalled();expect(provider.transcript).not.toHaveBeenCalled();
  });
  it('drain cleanup failure is retryable and does not falsely expire the pending record',async()=>{
    const created=JSON.parse((await setup().handler(event())).body);seconds+=61;
    vi.mocked(provider.remove).mockRejectedValueOnce(new Error('sensitive provider details'));
    await expect(setup(drainConfig).handler({source:'aws.events'})).rejects.toThrow('owned_voice_sweep_retry_required');
    expect(rows.get(created.jobId)).toMatchObject({cancelled:true,pending:'work'});expect(rows.get(created.jobId)?.expiresAt).toBeUndefined();
    seconds+=61;await setup(drainConfig).handler({source:'aws.events'});
    expect(rows.get(created.jobId)?.state).toBe('cleaned');
  });
  it('refuses blocked deployment before DB, storage or provider access',async()=>{
    const s=setup({...config,phiAllowed:false,activationState:'blocked',allowedScopes:[]});
    expect((await s.handler(event())).statusCode).toBe(503);expect(s.adapter).not.toHaveBeenCalled();expect(s.factory).not.toHaveBeenCalled();
    expect(()=>setup({...config,providerEvidenceSha256:undefined})).toThrow('owned_voice_activation_invalid');
  });
  it.each([{iss:'wrong'},{aud:'workforce'},{token_use:'access'},{exp:now/1000},{iat:now/1000+200},{email_verified:'false'},
    {'custom:production_bound':'false'},{'custom:synthetic_attested':'true'},{'custom:person_id':'invalid'}])('rejects invalid claims %j without data access',async patch=>{
    const s=setup(),e=event();Object.assign(e.requestContext!.authorizer!.jwt!.claims!,patch);
    expect((await s.handler(e)).statusCode).toBe(401);expect(s.adapter).not.toHaveBeenCalled();expect(provider.upload).not.toHaveBeenCalled();
  });
  it('uses active DB identity and refuses missing server consent',async()=>{
    const s=setup();consentState.mockRejectedValueOnce(new OwnedStorageError('owner_required'));
    expect((await s.handler(event())).statusCode).toBe(401);
    consentState.mockImplementation(async(_c,scope)=>({...state(scope),activeRevision:null}));
    expect((await s.handler(event())).statusCode).toBe(403);expect(rows.size).toBe(0);
  });
  it('checks paid Core on creation but never paywalls owner cancellation',async()=>{
    const s=setup();s.requireCore.mockRejectedValueOnce(new CoreSubscriptionError());
    expect((await s.handler(event())).statusCode).toBe(402);expect(rows.size).toBe(0);
    const first=JSON.parse((await s.handler(event())).body);s.requireCore.mockRejectedValue(new CoreSubscriptionError());
    expect((await s.handler(event('DELETE',first.jobId))).statusCode).toBe(202);expect(s.requireCore).toHaveBeenCalledTimes(2);
  });
  it('stores exact server-issued owner/consent proof with one idempotent recording',async()=>{
    const s=setup(),r=await s.handler(event());expect(r.statusCode).toBe(202);
    const body=JSON.parse(r.body);expect(JSON.parse((await s.handler(event())).body)).toEqual(body);expect(provider.upload).toHaveBeenCalledOnce();
    expect(rows.get(body.jobId)).toMatchObject({owner:`production:${uuid}:${uuid}:owned-consumer-a`,authorization:{version:'owned-voice/1',personId:uuid,
      consents:{ai_context:{revision:1},voice_transcription:{revision:1}}}});
    expect(consentState.mock.calls.every(([c])=>c.purpose==='consent_management'&&c.identityPool==='consumer')).toBe(true);
  });
  it('accepts an identical retry when the database changes JSON map key ordering',async()=>{
    const s=setup(),first=JSON.parse((await s.handler(event())).body),record=rows.get(first.jobId)!;
    const a=record.authorization!;
    record.authorization={consents:{voice_transcription:{...a.consents.voice_transcription},ai_context:{...a.consents.ai_context}},
      identitySubject:a.identitySubject,organizationId:a.organizationId,personId:a.personId,version:a.version};
    expect((await s.handler(event())).statusCode).toBe(202);expect(provider.upload).toHaveBeenCalledOnce();
  });
  it('denies another account and ignores caller-injected ownership or authorization',async()=>{
    const s=setup(),first=JSON.parse((await s.handler(event())).body),other=event('GET',first.jobId);
    other.requestContext!.authorizer!.jwt!.claims!.sub='owned-consumer-b';
    expect((await s.handler(other)).statusCode).toBe(404);expect(provider.status).not.toHaveBeenCalled();
    const injected=event();injected.body=JSON.stringify({...input,authorization:{personId:uuid}});
    expect((await s.handler(injected)).statusCode).toBe(400);
  });
  it('withdrawal stops dispatch and sweep cleans without new consent',async()=>{
    const s=setup(),first=JSON.parse((await s.handler(event())).body);seconds+=61;
    consentState.mockImplementation(async(_c,scope)=>scope==='voice_transcription'?{...state(scope),activeRevision:null}:state(scope));
    expect((await s.handler({source:'aws.events'})).statusCode).toBe(200);
    expect(provider.start).not.toHaveBeenCalled();expect(provider.remove).toHaveBeenCalledOnce();expect(rows.get(first.jobId)?.state).toBe('cleaned');
  });
  it('DB outages neither dispatch nor falsely revoke consent or complete cleanup',async()=>{
    const s=setup(),first=JSON.parse((await s.handler(event())).body);seconds+=61;
    consentState.mockRejectedValue(new OwnedStorageError('storage_unavailable'));
    await expect(s.handler({source:'aws.events'})).rejects.toThrow('owned_voice_sweep_retry_required');
    expect(rows.get(first.jobId)).toMatchObject({cancelled:false,pending:'work'});expect(provider.start).not.toHaveBeenCalled();expect(provider.remove).not.toHaveBeenCalled();
  });
  it('consent regrant cannot revive a recording made under an earlier revision',async()=>{
    const s=setup(),first=JSON.parse((await s.handler(event())).body);
    consentState.mockImplementation(async(_c,scope)=>state(scope,3));
    expect((await s.handler(event())).statusCode).toBe(403);expect(provider.upload).toHaveBeenCalledOnce();
    expect(JSON.parse((await s.handler(event('GET',first.jobId))).body).state).toBe('cancelled');
  });
  it('withdrawal during transcript retrieval never returns the text',async()=>{
    const s=setup(),first=JSON.parse((await s.handler(event())).body);
    vi.mocked(provider.status).mockResolvedValue('ready');
    vi.mocked(provider.transcript).mockImplementation(async()=>{consentState.mockImplementation(async(_c,scope)=>({...state(scope),activeRevision:null}));return 'PRIVATE FIXTURE';});
    const r=await s.handler(event('GET',first.jobId));expect(r.statusCode).toBe(403);expect(r.body).not.toContain('PRIVATE');
  });
  it('feature removal still permits owner cancellation and cleanup',async()=>{
    const s=setup(),first=JSON.parse((await s.handler(event())).body),disabled=setup({...config,allowedScopes:[]});
    expect((await disabled.handler(event())).statusCode).toBe(403);
    expect((await disabled.handler(event('DELETE',first.jobId))).statusCode).toBe(202);
    expect((await disabled.handler({source:'aws.events'})).statusCode).toBe(200);expect(provider.remove).toHaveBeenCalledOnce();
  });
  it('successful transcript remains owner-bound and requires unchanged current approval',async()=>{
    const s=setup(),first=JSON.parse((await s.handler(event())).body);vi.mocked(provider.status).mockResolvedValue('ready');
    expect(JSON.parse((await s.handler(event('GET',first.jobId))).body).transcript).toBe('Fictional voice.');
    consentState.mockImplementation(async(_c,scope)=>({...state(scope),release:{...state(scope).release!,version:'new-approval'}}));
    expect(JSON.parse((await s.handler(event('GET',first.jobId))).body).state).toBe('cancelled');
  });
  it('binds exact consent copy even if an administrator edits the same release version',async()=>{
    const s=setup(),first=JSON.parse((await s.handler(event())).body);
    consentState.mockImplementation(async(_c,scope)=>({...state(scope),release:{...state(scope).release!,contentSha256:'c'.repeat(64)}}));
    expect(JSON.parse((await s.handler(event('GET',first.jobId))).body).state).toBe('cancelled');
    expect(provider.start).not.toHaveBeenCalled();expect(provider.transcript).not.toHaveBeenCalled();
  });
  it('malformed or mismatched stored bindings cannot start work',async()=>{
    const context=ownedConsumerIdentity(event(),config,'consent_management',now),auth=createOwnedVoiceAuthorization(()=>({consentState}),()=>now);
    const proof=await auth.capture(context);
    await expect(auth.policy.verify({owner:'different',authorization:proof})).rejects.toThrow('voice_consent_required');
    await expect(auth.policy.verify({owner:voiceOwner(context)})).rejects.toThrow('voice_consent_required');
    const service=new VoiceJobs(repo,provider,()=>seconds,auth.policy);
    await expect(service.start(voiceOwner(context),input)).rejects.toThrow('voice_consent_required');expect(rows.size).toBe(0);
  });
});
