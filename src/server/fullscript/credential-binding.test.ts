import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import type {RequestSession} from '../session';
import {fullscriptActor} from './runtime';
import {FULLSCRIPT_DRAFT_SCOPES} from './draft-scopes';
import {createCredentialBoundFullscriptDraftProvider,observeFullscriptDraftInstallation} from './credential-binding';
import {FullscriptApiClient,readFullscriptConfiguration} from './client';
import type {StoredFullscriptConnection} from './token-store';

const session:RequestSession={signedIn:true,email:'fictional@example.test',orgId:'a1234567-1234-4123-8123-123456789012',
  expired:false,expiresAt:null,token:'fictional-identity-token'};
const fixture=():StoredFullscriptConnection=>({...fullscriptActor(session),environment:'sandbox_us',
  accessToken:'fictional-access-token-abcdefghijklmnopqrstuvwxyz',refreshToken:'fictional-refresh-token-abcdefghijklmnopqrstuvwxyz',
  expiresAt:new Date(Date.now()+3600_000).toISOString(),connectedAt:'2026-10-09T10:00:00.000Z',
  installationId:'b1234567-1234-4123-8123-123456789012',
  oauthClientId:'fictional-client-id-abcdefghijklmnopqrstuvwxyz',
  oauthRedirectUri:'https://fictional.example.test/api/live/fullscript/oauth/callback',
  resourceOwner:{id:'fictional-practitioner-id',type:'Practitioner'},scope:[...FULLSCRIPT_DRAFT_SCOPES]});
const input={fullscriptPatientId:'fictional-patient-id',practitionerId:'fictional-practitioner-id',
  idempotencyKey:'alp-cart-'+'a'.repeat(64),recommendations:[{variantId:'fictional-variant-id',unitsToPurchase:'1',instructions:'Fictional existing directions'}]};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
let saved:StoredFullscriptConnection|null,clinic:unknown,fetcher:ReturnType<typeof vi.fn>;
const plan=()=>({treatment_plan:{id:'fictional-plan-id',patient:{id:input.fullscriptPatientId},practitioner:{id:input.practitionerId},
  state:'draft',available_at:null,metadata:{id:input.idempotencyKey},lab_recommendations:[],resources:[],
  recommendations:[{variant_id:input.recommendations[0].variantId,units_to_purchase:1,refill:false,
    dosage:{additional_info:input.recommendations[0].instructions}}]}});
beforeEach(()=>{
  vi.stubEnv('FULLSCRIPT_ENVIRONMENT','sandbox_us');vi.stubEnv('FULLSCRIPT_CLIENT_ID','fictional-client-id-abcdefghijklmnopqrstuvwxyz');
  vi.stubEnv('FULLSCRIPT_CLIENT_SECRET','fictional-client-secret-abcdefghijklmnopqrstuvwxyz');
  vi.stubEnv('FULLSCRIPT_REDIRECT_URI','https://fictional.example.test/api/live/fullscript/oauth/callback');
  vi.stubEnv('FULLSCRIPT_OAUTH_STATE_SECRET','fictional-state-secret-longer-than-32-characters');
  vi.stubEnv('FULLSCRIPT_TOKEN_TABLE','fictional-token-table');vi.stubEnv('AWS_REGION','us-east-2');
  saved=fixture();clinic={clinic:{id:'fictional-clinic-id',name:'Unretained name',dispensary_url:'https://never-follow.example.test'}};
  vi.spyOn(DynamoDBClient.prototype,'send').mockImplementation(async()=>
    (saved?{Item:{payload:{S:JSON.stringify(saved)}}}:{}) as never);
  fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    const u=new URL(String(url));
    if(u.pathname==='/api/clinic')return response(clinic);
    if(init?.method==='POST')return response(plan(),201);
    if(u.pathname==='/api/clinic/metadata')return response({metadata:[{id:input.idempotencyKey,type:'treatment_plan',data:{id:'fictional-plan-id'}}],
      meta:{current_page:1,next_page:null,prev_page:null,total_pages:1,total_count:1}});
    return response(plan());
  });vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const review=async()=>{
  const o=await observeFullscriptDraftInstallation(session);
  return {contract:'fullscript-sandbox-provider-release/1',environment:o.environment,apiOrigin:o.apiOrigin,
    clinicId:o.clinicId,tokenBindingSha256:o.tokenBindingSha256,scopes:[...FULLSCRIPT_DRAFT_SCOPES]};
};
describe('Observed Fullscript installation, not deployed approval or hosted acceptance',()=>{
  it.each(['create','recover'])('refuses replaced credential custody during authority recheck before %s transport',async mode=>{
    const r=await review();fetcher.mockClear();
    const check=vi.fn(async()=>{saved={...saved!,installationId:'d1234567-1234-4123-8123-123456789012'};});
    const p=createCredentialBoundFullscriptDraftProvider(session,r,check);
    await expect(mode==='create'?p.create(input):p.findByMetadata(input.idempotencyKey)).rejects.toThrow('fullscript_delivery_refused');
    expect(check).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe('/api/clinic');
  });
  it.each(['create','recover'])('rechecks current authority after clinic observation before %s transport',async mode=>{
    const r=await review();fetcher.mockClear();
    const check=vi.fn(async()=>{throw new Error('fictional authority withdrawn');});
    const p=createCredentialBoundFullscriptDraftProvider(session,r,check);
    await expect(mode==='create'?p.create(input):p.findByMetadata(input.idempotencyKey))
      .rejects.toThrow('fullscript_delivery_refused');
    expect(check).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api-us-snd.fullscript.io/api/clinic');
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
  });
  it.each(['client','callback'])('refuses a current %s that differs from saved OAuth authorization before provider I/O',async mode=>{
    if(mode==='client')vi.stubEnv('FULLSCRIPT_CLIENT_ID','fictional-other-client-abcdefghijklmnopqrstuvwxyz');
    else vi.stubEnv('FULLSCRIPT_REDIRECT_URI','https://other.example.test/api/live/fullscript/oauth/callback');
    await expect(observeFullscriptDraftInstallation(session)).rejects.toThrow('fullscript_delivery_refused');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['oauthClientId','oauthRedirectUri'] as const)('refuses a legacy installation without %s',async field=>{
    delete saved![field];await expect(observeFullscriptDraftInstallation(session)).rejects.toThrow('fullscript_delivery_refused');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['legacy','client','callback','staff','scopes'])('does not refresh an expired refused %s installation',async mode=>{
    saved={...saved!,expiresAt:new Date(Date.now()-1000).toISOString()};
    if(mode==='legacy')delete saved.installationId;
    if(mode==='client')vi.stubEnv('FULLSCRIPT_CLIENT_ID','fictional-other-client-abcdefghijklmnopqrstuvwxyz');
    if(mode==='callback')vi.stubEnv('FULLSCRIPT_REDIRECT_URI','https://other.example.test/api/live/fullscript/oauth/callback');
    if(mode==='staff')saved.resourceOwner.type='Staff';
    if(mode==='scopes')saved.scope=['clinic:read'];
    await expect(observeFullscriptDraftInstallation(session)).rejects.toThrow('fullscript_delivery_refused');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reads actual credential-bound clinic; exposes no token, secret, patient or provider URL',async()=>{
    const observed=await observeFullscriptDraftInstallation(session);
    expect(observed).toMatchObject({clinicId:'fictional-clinic-id',environment:'sandbox_us'});
    expect(observed.tokenBindingSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(observed)).not.toMatch(/access-token|refresh-token|client-secret|dispensary|Unretained|fictional-patient/);
    expect(fetcher).toHaveBeenCalledOnce();expect(String(fetcher.mock.calls[0][0])).toBe('https://api-us-snd.fullscript.io/api/clinic');
    expect(fetcher.mock.calls[0][1]).toMatchObject({method:'GET',redirect:'manual',headers:{authorization:'Bearer '+saved!.accessToken}});
  });
  it('keeps fingerprint stable across credential rotation and scope ordering',async()=>{
    const before=await observeFullscriptDraftInstallation(session);
    saved={...saved!,accessToken:'fictional-rotated-token-abcdefghijklmnopqrstuvwxyz',refreshToken:'fictional-rotated-refresh-abcdefghijklmnopqrstuvwxyz',
      expiresAt:new Date(Date.now()+7200_000).toISOString(),scope:[...saved!.scope].reverse()};
    expect((await observeFullscriptDraftInstallation(session)).tokenBindingSha256).toBe(before.tokenBindingSha256);
  });
  it.each(['installation','owner','scope','client','callback','clinic'])('changes fingerprint on %s replacement',async mode=>{
    const old=await observeFullscriptDraftInstallation(session);
    if(mode==='installation')saved={...saved!,installationId:'c1234567-1234-4123-8123-123456789012'};
    if(mode==='owner')saved={...saved!,resourceOwner:{id:'fictional-other-practitioner',type:'Practitioner'}};
    if(mode==='scope')saved={...saved!,scope:[...saved!.scope,'labs:read']};
    if(mode==='client'){vi.stubEnv('FULLSCRIPT_CLIENT_ID','fictional-other-client-abcdefghijklmnopqrstuvwxyz');
      saved={...saved!,oauthClientId:'fictional-other-client-abcdefghijklmnopqrstuvwxyz'};}
    if(mode==='callback'){vi.stubEnv('FULLSCRIPT_REDIRECT_URI','https://other.example.test/api/live/fullscript/oauth/callback');
      saved={...saved!,oauthRedirectUri:'https://other.example.test/api/live/fullscript/oauth/callback'};}
    if(mode==='clinic')clinic={clinic:{id:'fictional-other-clinic'}};
    expect((await observeFullscriptDraftInstallation(session)).tokenBindingSha256).not.toBe(old.tokenBindingSha256);
  });
  it.each(['absent','legacy','staff','scopes','expired-session','production'])('refuses %s before provider I/O',async mode=>{
    let active=session;
    if(mode==='absent')saved=null;
    if(mode==='legacy')delete saved!.installationId;
    if(mode==='staff')saved={...saved!,resourceOwner:{...saved!.resourceOwner,type:'Staff'}};
    if(mode==='scopes')saved={...saved!,scope:['clinic:read','clinic:write']};
    if(mode==='expired-session')active={...session,expired:true};
    if(mode==='production'){vi.stubEnv('FULLSCRIPT_ENVIRONMENT','production_us');vi.stubEnv('PHI_ALLOWED','true');
      vi.stubEnv('FULLSCRIPT_PRODUCTION_APPROVED','true');saved={...saved!,environment:'production_us'};}
    await expect(observeFullscriptDraftInstallation(active)).rejects.toThrow('fullscript_delivery_refused');expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{}, {clinic:{}},{clinic:{id:'short'}},{clinic:[]},{clinic:{id:'https://bad.example.test'}}])('refuses malformed clinic reply',async value=>{
    clinic=value;await expect(observeFullscriptDraftInstallation(session)).rejects.toThrow('fullscript_delivery_refused');
  });
  it.each(['disconnect','reconnect','rotate'])('refuses custody changed during clinic I/O: %s',async mode=>{
    fetcher.mockImplementationOnce(async()=>{
      if(mode==='disconnect')saved=null;
      if(mode==='reconnect')saved={...saved!,installationId:'c1234567-1234-4123-8123-123456789012'};
      if(mode==='rotate')saved={...saved!,accessToken:'fictional-rotated-token-abcdefghijklmnopqrstuvwxyz'};
      return response(clinic);
    });await expect(observeFullscriptDraftInstallation(session)).rejects.toThrow('fullscript_delivery_refused');
  });
  it('binds native POST and independent metadata/plan GETs to current observation',async()=>{
    const provider=createCredentialBoundFullscriptDraftProvider(session,await review());fetcher.mockClear();
    expect(await provider.create(input)).toMatchObject({planId:'fictional-plan-id',state:'draft'});
    expect(fetcher.mock.calls.map(c=>[new URL(String(c[0])).pathname,c[1]?.method])).toEqual([
      ['/api/clinic','GET'],['/api/clinic/patients/fictional-patient-id/treatment_plans','POST']]);
    fetcher.mockClear();expect(await provider.findByMetadata(input.idempotencyKey)).toHaveLength(1);
    expect(fetcher.mock.calls.map(c=>new URL(String(c[0])).pathname)).toEqual([
      '/api/clinic','/api/clinic/metadata','/api/clinic/treatment_plans/fictional-plan-id']);
  });
  it.each(['hash','clinic','reconnect','practitioner'])('refuses %s mismatch before draft POST',async mode=>{
    const reviewed=await review();
    if(mode==='hash')reviewed.tokenBindingSha256='b'.repeat(64);
    if(mode==='clinic')reviewed.clinicId='fictional-other-clinic';
    const provider=createCredentialBoundFullscriptDraftProvider(session,reviewed);fetcher.mockClear();
    if(mode==='reconnect')saved={...saved!,installationId:'c1234567-1234-4123-8123-123456789012'};
    await expect(provider.create(mode==='practitioner'?{...input,practitionerId:'fictional-other-practitioner'}:input)).rejects.toThrow('fullscript_delivery_refused');
    expect(fetcher.mock.calls.every(c=>c[1]?.method==='GET')).toBe(true);
  });
  it('reobserves before reconciliation; changed installation never reaches metadata search',async()=>{
    const provider=createCredentialBoundFullscriptDraftProvider(session,await review());fetcher.mockClear();
    clinic={clinic:{id:'fictional-other-clinic'}};
    await expect(provider.findByMetadata(input.idempotencyKey)).rejects.toThrow('fullscript_delivery_refused');expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not leak upstream body/error text',async()=>{
    fetcher.mockResolvedValueOnce(response({error:'fictional-access-token secret patient body'},403));
    await expect(observeFullscriptDraftInstallation(session)).rejects.toThrow(/^fullscript_delivery_refused$/);
  });
  it('requires sandbox clinic:read before identity/config projection',()=>{
    const denied=new FullscriptApiClient(readFullscriptConfiguration(),saved!.accessToken,fetch,[]);
    expect(()=>denied.retrieveSandboxClinic()).toThrow();expect(()=>denied.sandboxInstallationConfiguration()).toThrow();expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses caller approval flags and missing/duplicate scopes at construction',async()=>{
    const reviewed=await review();
    for(const bad of [{...reviewed,approved:true},{...reviewed,scopes:['clinic:read','clinic:read','catalog:read','patients:treatment_plan_history']},
      {...reviewed,scopes:['clinic:read']},{...reviewed,environment:'production_us'}])
      expect(()=>createCredentialBoundFullscriptDraftProvider(session,bad)).toThrow('fullscript_delivery_refused');
  });
  it.each(['create','recover'])('uses one request-scoped credential environment for all %s custody reads, not poisoned shared settings',async mode=>{
    const reviewed=await review(),scoped={...process.env};fetcher.mockClear();
    vi.stubEnv('FULLSCRIPT_ENVIRONMENT','production_us');vi.stubEnv('FULLSCRIPT_CLIENT_ID','untrusted-global-client');
    vi.stubEnv('FULLSCRIPT_TOKEN_TABLE','untrusted-global-table');
    const load=vi.fn(async()=>scoped),p=createCredentialBoundFullscriptDraftProvider(session,reviewed,undefined,load);
    expect(load).not.toHaveBeenCalled();
    expect(mode==='create'?await p.create(input):await p.findByMetadata(input.idempotencyKey)).toBeTruthy();
    expect(load).toHaveBeenCalledOnce();expect(process.env.FULLSCRIPT_ENVIRONMENT).toBe('production_us');
    expect(fetcher.mock.calls.every(call=>new URL(String(call[0])).origin==='https://api-us-snd.fullscript.io')).toBe(true);
  });
  it('secret refusal is opaque and makes no token-store or upstream request',async()=>{
    const reviewed=await review();fetcher.mockClear();
    const tokenRead=vi.spyOn(DynamoDBClient.prototype,'send');tokenRead.mockClear();
    const load=vi.fn(async():Promise<NodeJS.ProcessEnv>=>{throw Error('FICTIONAL secret internal failure');});
    const p=createCredentialBoundFullscriptDraftProvider(session,reviewed,undefined,load);
    await expect(p.create(input)).rejects.toThrow(/^fullscript_delivery_refused$/);
    expect(load).toHaveBeenCalledOnce();expect(tokenRead).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
  });
});
