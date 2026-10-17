import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

// The OAuth callback's outcomes. Before this change every failure came back as `connection_failed`, which the card read
// as "Fullscript did not authorize this connection. Confirm the account…" whatever happened: a replayed link after a
// success, an outage, another session, all blamed the practitioner's account, beside a "Connected" badge. Each outcome
// is now one true statement, and a second connection over a live one is refused before any code is exchanged.
const jar=vi.hoisted(()=>({cookies:[] as Array<{name:string;value:string}>}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>jar.cookies.find(cookie=>cookie.name===name),
  getAll:(name?:string)=>name?jar.cookies.filter(cookie=>cookie.name===name):jar.cookies}),headers:async()=>new Headers()}));
import {NextRequest} from 'next/server';
import {DynamoDBClient,PutItemCommand} from '@aws-sdk/client-dynamodb';
const admissionStore=vi.hoisted(()=>({observe:vi.fn(),install:vi.fn()}));
vi.mock('@/server/fullscript/connection-admission',()=>({createAwsFullscriptConnectionAdmission:()=>admissionStore}));
import {GET} from '../../app/api/live/fullscript/oauth/callback/route';
import {createFullscriptAuthorization,readFullscriptConfiguration} from './client';
import {fullscriptActor} from './runtime';
import {FULLSCRIPT_CALLBACK_OUTCOMES,fullscriptPanelState} from '@/lib/fullscript-presentation';

const ORIGIN='https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const clinic='a1234567-1234-4123-8123-123456789012',subject='b1234567-1234-4123-8123-123456789012',email='fictional.practitioner@example.test';
const idToken=['{"alg":"RS256","kid":"fictional"}',JSON.stringify({sub:subject,email,token_use:'id'})]
  .map(part=>Buffer.from(part).toString('base64url')).join('.')+'.fictional-signature';
const actor=fullscriptActor({signedIn:true,email,orgId:clinic,token:idToken,expired:false,expiresAt:null});
const live={previousPayload:'{"fictional":"saved"}',previousCurrent:true},superseded={previousPayload:'{"fictional":"saved"}',previousCurrent:false};
let tokenAnswer:()=>Response,spent:Set<string>,fetcher:ReturnType<typeof vi.fn>;
const exchanges=()=>(fetcher.mock.calls as Array<[string]>).filter(([url])=>url.endsWith('/oauth/token'));
const revocations=()=>(fetcher.mock.calls as Array<[string]>).filter(([url])=>url.endsWith('/oauth/revoke'));
const issued=()=>new Response(JSON.stringify({oauth:{access_token:'fictional-access-token-abcdefghijklmnopqrstuvwxyz',
  refresh_token:'fictional-refresh-token-abcdefghijklmnopqrstuvwxyz',expires_in:3600,created_at:new Date().toISOString(),
  scope:'catalog:read',resource_owner:{id:'fictional-practitioner-id',type:'Practitioner'}}}),{status:200,headers:{'content-type':'application/json'}});

beforeEach(()=>{
  vi.spyOn(console,'error').mockImplementation(()=>undefined);
  spent=new Set();tokenAnswer=issued;
  vi.stubEnv('FULLSCRIPT_ENVIRONMENT','sandbox_us');vi.stubEnv('FULLSCRIPT_CLIENT_ID','fictional-client-id-abcdefghijklmnopqrstuvwxyz');
  vi.stubEnv('FULLSCRIPT_CLIENT_SECRET','fictional-client-secret-abcdefghijklmnopqrstuvwxyz');
  vi.stubEnv('FULLSCRIPT_REDIRECT_URI','https://fictional.example.test/api/live/fullscript/oauth/callback');
  vi.stubEnv('FULLSCRIPT_OAUTH_STATE_SECRET','fictional-state-secret-longer-than-32-characters');
  vi.stubEnv('FULLSCRIPT_TOKEN_TABLE','fictional-token-table');vi.stubEnv('AWS_REGION','us-east-2');
  vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN',ORIGIN);
  jar.cookies=[{name:'aidp_at',value:idToken},{name:'aidp_exp',value:String(Date.now()+3_600_000)},{name:'aidp_em',value:email},{name:'aidp_org',value:clinic}];
  admissionStore.observe.mockReset().mockResolvedValue({previousPayload:null,previousCurrent:null});
  admissionStore.install.mockReset().mockResolvedValue(undefined);
  // The single-use nonce, as the token table holds it: a second use of the same link is refused.
  vi.spyOn(DynamoDBClient.prototype,'send').mockImplementation(async command=>{
    if(command instanceof PutItemCommand){
      const nonce=JSON.stringify(command.input.Item);
      if(spent.has(nonce))throw Object.assign(new Error('fictional replay'),{name:'ConditionalCheckFailedException'});
      spent.add(nonce);
    }
    return {} as never;
  });
  fetcher=vi.fn(async(url:string)=>url.startsWith(ORIGIN)
    ?new Response(JSON.stringify({data:[{organization_id:clinic,name:'Fictional',slug:'f',role:'practitioner'}]}),{status:200})
    :url.endsWith('/oauth/revoke')?new Response('{}',{status:200,headers:{'content-type':'application/json'}}):tokenAnswer());
  vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();jar.cookies=[];});
const callback=(nonce:string,extra:Record<string,string>={})=>{
  const {state}=createFullscriptAuthorization({configuration:readFullscriptConfiguration(),...actor,subject,nonce});
  const url=new URL('https://fictional.example.test/api/live/fullscript/oauth/callback');
  url.searchParams.set('state',state);url.searchParams.set('code','fictional-authorization-code-abcdefghijklmnopqrstuvwxyz');
  for(const [k,v] of Object.entries(extra))url.searchParams.set(k,v);
  return GET(new NextRequest(url)).then(r=>new URL(r.headers.get('location')!).searchParams.get('fullscript'));
};
const NONCE='fictional-first-nonce-abcdefghijklmnopqrstuvwxyz';

describe('the Fullscript OAuth callback says what happened',()=>{
  it('a live connection is never replaced: refused before the nonce is spent or any code exchanged',async()=>{
    admissionStore.observe.mockResolvedValue(live);
    expect(await callback(NONCE)).toBe('already_connected');
    expect(spent.size).toBe(0);expect(exchanges()).toEqual([]);expect(admissionStore.install).not.toHaveBeenCalled();
  });

  it('a superseded connection does not block a reconnect: the install (which queues it for revocation) runs',async()=>{
    admissionStore.observe.mockResolvedValue(superseded);
    expect(await callback(NONCE)).toBe('connected');
    expect(admissionStore.install).toHaveBeenCalledOnce();
    expect(admissionStore.install.mock.calls[0]![1]).toEqual(superseded);
  });

  it('a live connection that appears during the exchange is refused by the install, and the new token is revoked',async()=>{
    admissionStore.install.mockRejectedValue(Object.assign(new Error('fictional'),{name:'FullscriptAlreadyConnectedError'}));
    expect(await callback(NONCE)).toBe('already_connected');
    expect(revocations()).toHaveLength(1);
  });

  it('the same link opened again after a success is "already used", not "Fullscript refused you"; nothing is exchanged twice',async()=>{
    expect(await callback(NONCE)).toBe('connected');
    expect(await callback(NONCE)).toBe('link_used');
    expect(exchanges()).toHaveLength(1);expect(admissionStore.install).toHaveBeenCalledOnce();
  });

  it('a tampered or expired link is "already used or expired", with nothing exchanged',async()=>{
    const url=new URL('https://fictional.example.test/api/live/fullscript/oauth/callback');
    url.searchParams.set('state','not.a.valid-state');url.searchParams.set('code','fictional-authorization-code-abcdefghijklmnopqrstuvwxyz');
    expect(new URL((await GET(new NextRequest(url))).headers.get('location')!).searchParams.get('fullscript')).toBe('link_used');
    expect(exchanges()).toEqual([]);
  });

  it('the practitioner declining at Fullscript, or Fullscript refusing the grant, is "not authorized", with nothing saved',async()=>{
    expect(await callback(NONCE,{error:'access_denied'})).toBe('not_authorized');
    expect(exchanges()).toEqual([]);
    tokenAnswer=()=>new Response('{"error":"invalid_grant"}',{status:400,headers:{'content-type':'application/json'}});
    expect(await callback('fictional-second-nonce-abcdefghijklmnopqrstuvwxyz')).toBe('not_authorized');
    expect(admissionStore.install).not.toHaveBeenCalled();
  });

  it('an outage is "couldn\'t connect right now", never a claim about the practitioner\'s account',async()=>{
    tokenAnswer=()=>new Response('{"error":"fictional"}',{status:503,headers:{'content-type':'application/json'}});
    expect(await callback(NONCE)).toBe('unavailable');
    admissionStore.observe.mockRejectedValue(new Error('fictional fence table down'));
    expect(await callback('fictional-second-nonce-abcdefghijklmnopqrstuvwxyz')).toBe('unavailable');
    expect(admissionStore.install).not.toHaveBeenCalled();
  });

  it('every outcome is one the card knows, and every failure says nothing was changed or saved',()=>{
    for(const outcome of FULLSCRIPT_CALLBACK_OUTCOMES){
      const {notice}=fullscriptPanelState({posture:null,loadError:null,outcome,busy:null});
      if(outcome==='connected'){expect(notice).toBeNull();continue;}
      expect([outcome,notice]).toEqual([outcome,expect.any(String)]);
      if(outcome!=='not_authorized')expect([outcome,notice]).toEqual([outcome,expect.stringMatching(/nothing was (changed|saved)/)]);
    }
  });
});
