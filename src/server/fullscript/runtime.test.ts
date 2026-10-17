import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {RequestSession} from '../session';
import type {StoredFullscriptConnection} from './token-store';
import {readFullscriptConfiguration, type FullscriptToken} from './client';
import {connectedFullscriptClient, disconnectFullscript, fullscriptActionError, fullscriptActor, fullscriptPosture, FULLSCRIPT_ACTION_UNAVAILABLE, FULLSCRIPT_DISCONNECT_CHANGED,
  FULLSCRIPT_DISCONNECT_UNCONFIRMED, FULLSCRIPT_NOT_CONNECTED, FULLSCRIPT_RECONNECT_REQUIRED, FULLSCRIPT_STATUS_UNAVAILABLE} from './runtime';
import {FullscriptUnavailableError} from './client';
import {FULLSCRIPT_RECONNECT_AFTER_MEMBERSHIP_CHANGE} from './membership-generation';
import type {AdapterError} from '@/adapters/errors';
import {FULLSCRIPT_DRAFT_SCOPES} from './draft-scopes';

const mocks=vi.hoisted(()=>({get:vi.fn(),put:vi.fn(),replace:vi.fn(),remove:vi.fn(),refresh:vi.fn(),configuration:vi.fn(),revoke:vi.fn()}));
vi.mock('./token-store',async importOriginal=>({...await importOriginal<typeof import('./token-store')>(),
  createAwsFullscriptTokenStore:()=>({get:mocks.get,put:mocks.put,replace:mocks.replace,delete:mocks.remove})}));
const generation=vi.hoisted(()=>({value:{protocol:'fullscript-generation/1' as const,subjectFence:3,clinicFence:5},supersede:vi.fn(async()=>'moved' as const)}));
vi.mock('./membership-generation',async importOriginal=>({...await importOriginal<typeof import('./membership-generation')>(),
  createAwsFullscriptGenerationReader:()=>({current:async()=>generation.value}),
  createAwsFullscriptRevocationOutbox:()=>({supersede:generation.supersede,pending:vi.fn(async()=>[]),settle:vi.fn()})}));
vi.mock('./client',async importOriginal=>({...await importOriginal<typeof import('./client')>(),
  readFullscriptConfiguration:mocks.configuration,refreshFullscriptToken:mocks.refresh,revokeFullscriptToken:mocks.revoke}));
// A fictional, unsigned ID token: the saved connection is keyed by its subject (the account), not its email.
const FICTIONAL_ID_TOKEN=[{alg:'RS256',kid:'fictional'},{sub:'b1234567-1234-4123-8123-123456789012',email:'fictional@example.test',token_use:'id'}].map(p=>Buffer.from(JSON.stringify(p)).toString('base64url')).join('.')+'.fictional-signature';
const session:RequestSession={signedIn:true,email:'fictional@example.test',orgId:'a1234567-1234-4123-8123-123456789012',
  token:FICTIONAL_ID_TOKEN,expired:false,expiresAt:null};
let config:ReturnType<typeof readFullscriptConfiguration>;
const fixture=():StoredFullscriptConnection=>({...fullscriptActor(session),environment:'sandbox_us',
  accessToken:'fictional-access-token-abcdefghijklmnopqrstuvwxyz',refreshToken:'fictional-refresh-token-abcdefghijklmnopqrstuvwxyz',
  expiresAt:new Date(Date.now()+30_000).toISOString(),connectedAt:new Date(Date.now()-3600_000).toISOString(),
  resourceOwner:{id:'fictional-practitioner-id',type:'Practitioner'},scope:['clinic:read','clinic:write'],membershipGeneration:generation.value});
const refreshed=(connection:StoredFullscriptConnection):FullscriptToken=>({accessToken:'fictional-rotated-token-abcdefghijklmnopqrstuvwxyz',
  refreshToken:'fictional-rotated-refresh-abcdefghijklmnopqrstuvwxyz',expiresAt:new Date(Date.now()+3600_000).toISOString(),
  resourceOwner:{...connection.resourceOwner},scope:[...connection.scope].reverse()});
beforeEach(async()=>{
  vi.clearAllMocks();
  const original=await vi.importActual<typeof import('./client')>('./client');
  config=original.readFullscriptConfiguration({NODE_ENV:'test',FULLSCRIPT_ENVIRONMENT:'sandbox_us',FULLSCRIPT_CLIENT_ID:'fictional-client-abcdefghijklmnopqrstuvwxyz',
    FULLSCRIPT_CLIENT_SECRET:'fictional-secret-abcdefghijklmnopqrstuvwxyz',FULLSCRIPT_REDIRECT_URI:'https://fictional.example.test/api/live/fullscript/oauth/callback',
    FULLSCRIPT_OAUTH_STATE_SECRET:'fictional-state-secret-longer-than-32-characters'});
  mocks.configuration.mockReturnValue(config);
  mocks.replace.mockResolvedValue(true);
  mocks.remove.mockResolvedValue(true);
});

describe('Fullscript refresh retains installation authority',()=>{
  it('preserves saved installation/client/callback through a valid draft refresh',async()=>{
    const saved={...fixture(),installationId:'c1234567-1234-4123-8123-123456789012',
      oauthClientId:config.clientId,oauthRedirectUri:config.redirectUri,scope:[...FULLSCRIPT_DRAFT_SCOPES]};
    const next=refreshed(saved);mocks.get.mockResolvedValue(saved);mocks.refresh.mockResolvedValue(next);
    const result=await connectedFullscriptClient(session,true);
    expect(result.connection).toEqual({...saved,...next});
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(saved,{...saved,...next});
  });
  it('refuses a changed saved OAuth client before refresh even outside draft mode',async()=>{
    mocks.get.mockResolvedValue({...fixture(),oauthClientId:'fictional-other-client-abcdefghijklmnopqrstuvwxyz'});
    await expect(connectedFullscriptClient(session)).rejects.toThrow();expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('never reports a different-environment saved connection as connected',async()=>{
    mocks.get.mockResolvedValue({...fixture(),environment:'production_us'});
    await expect(fullscriptPosture(session)).rejects.toMatchObject({code:'unavailable',message:FULLSCRIPT_STATUS_UNAVAILABLE});
  });
  it('validates posture against actor custody even when a substituted port returns a wrong key',async()=>{
    mocks.get.mockResolvedValue({...fixture(),actorKey:'b'.repeat(64)});
    await expect(fullscriptPosture(session)).rejects.toMatchObject({code:'unavailable',message:FULLSCRIPT_STATUS_UNAVAILABLE});
  });
  it('rotates credentials while preserving exact owner and scope set; does not require scope order',async()=>{
    const saved=fixture(),next=refreshed(saved);mocks.get.mockResolvedValue(saved);mocks.refresh.mockResolvedValue(next);
    const result=await connectedFullscriptClient(session);
    expect(result.connection).toEqual({...saved,...next});expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(saved,{...saved,...next});
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({configuration:config,refreshToken:saved.refreshToken});
  });
  it.each(['owner-id','owner-type','extra-scope','missing-scope','duplicate-scope','expired','bad-date','malformed-token'])
  ('refuses changed %s without overwriting custody or returning a client',async mode=>{
    const saved=fixture(),next=refreshed(saved);mocks.get.mockResolvedValue(saved);
    if(mode==='owner-id')next.resourceOwner.id='fictional-different-practitioner';
    if(mode==='owner-type')next.resourceOwner.type='Staff';
    if(mode==='extra-scope')next.scope.push('catalog:read');
    if(mode==='missing-scope')next.scope=['clinic:read'];
    if(mode==='duplicate-scope')next.scope=['clinic:read','clinic:read'];
    if(mode==='expired')next.expiresAt=new Date(Date.now()-1000).toISOString();
    if(mode==='bad-date')next.expiresAt='bad-date';
    if(mode==='malformed-token')next.accessToken='short';
    mocks.refresh.mockResolvedValue(next);
    await expect(connectedFullscriptClient(session)).rejects.toMatchObject({code:'fullscript_unavailable'});
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it('refuses a misbound record even if a substituted store port returns it',async()=>{
    mocks.get.mockResolvedValue({...fixture(),organizationId:'b1234567-1234-4123-8123-123456789012'});
    await expect(connectedFullscriptClient(session)).rejects.toMatchObject({code:'fullscript_unavailable'});
    expect(mocks.refresh).not.toHaveBeenCalled();expect(mocks.put).not.toHaveBeenCalled();
  });
  it('does not refresh a valid unexpired connection',async()=>{
    const saved={...fixture(),expiresAt:new Date(Date.now()+3600_000).toISOString()};mocks.get.mockResolvedValue(saved);
    expect((await connectedFullscriptClient(session)).connection).toEqual(saved);
    expect(mocks.refresh).not.toHaveBeenCalled();expect(mocks.put).not.toHaveBeenCalled();
  });
  it('refuses a different provider environment and an unsigned-in session',async()=>{
    mocks.get.mockResolvedValue({...fixture(),environment:'production_us'});
    await expect(connectedFullscriptClient(session)).rejects.toThrow();
    mocks.get.mockClear();await expect(connectedFullscriptClient({...session,signedIn:false})).rejects.toThrow();
    expect(mocks.get).not.toHaveBeenCalled();expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('cannot resurrect or overwrite a disconnected/reconnected installation after a refresh',async()=>{
    const saved=fixture();mocks.get.mockResolvedValue(saved);mocks.refresh.mockResolvedValue(refreshed(saved));
    mocks.replace.mockResolvedValue(false);
    await expect(connectedFullscriptClient(session)).rejects.toMatchObject({code:'fullscript_unavailable'});
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('refuses an expired identity session before accessing credentials',async()=>{
    await expect(connectedFullscriptClient({...session,expired:true})).rejects.toThrow();expect(mocks.get).not.toHaveBeenCalled();
  });
  it('never sends a stored token to a different environment during disconnect',async()=>{
    mocks.get.mockResolvedValue({...fixture(),environment:'production_us'});
    await expect(disconnectFullscript(session)).rejects.toThrow();expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it('answers a failed read with a fixed unavailable code, never an AWS/provider error or secret, and never "not configured"',async()=>{
    mocks.get.mockRejectedValue(new Error('fictional-access-token-abcdefghijklmnopqrstuvwxyz raw private provider details'));
    const failure=await fullscriptPosture(session).then(()=>null,(error:unknown)=>error) as AdapterError;
    expect(failure).toMatchObject({code:'unavailable',message:FULLSCRIPT_STATUS_UNAVAILABLE});
    expect(JSON.stringify(failure.toJSON())).not.toMatch(/fictional-access-token|raw private|configured/);
  });
  it('revokes the observed token then conditionally removes only that connection',async()=>{
    const saved=fixture();mocks.get.mockResolvedValue(saved);
    await disconnectFullscript(session);
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith({configuration:config,token:saved.accessToken});
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(saved);
  });
  it('does not report a new connection disconnected if custody changed during revocation',async()=>{
    mocks.get.mockResolvedValue(fixture());mocks.remove.mockResolvedValue(false);
    await expect(disconnectFullscript(session)).rejects.toMatchObject({code:'conflict',message:FULLSCRIPT_DISCONNECT_CHANGED});
  });
});

describe('the status and the disconnect say only what is known',()=>{
  it('a deployment without Fullscript is "not configured", and reads nothing',async()=>{
    mocks.configuration.mockImplementation(()=>{throw new FullscriptUnavailableError();});
    expect(await fullscriptPosture(session)).toEqual({configured:false,connected:false,environment:null,reason:'not_configured'});
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('a live connection reads as connected; one made before the clinic access changed asks for a reconnect, saying why',async()=>{
    mocks.get.mockResolvedValue(fixture());
    expect(await fullscriptPosture(session)).toMatchObject({configured:true,connected:true});
    mocks.get.mockResolvedValue({...fixture(),membershipGeneration:{...generation.value,subjectFence:2}});
    expect(await fullscriptPosture(session)).toMatchObject({configured:true,connected:false,reconnectRequired:true,reconnectReason:'membership_changed'});
  });
  it('a revocation Fullscript does not confirm keeps the connection, and says it is still active (failing before: a bare 500, no test)',async()=>{
    const saved=fixture();mocks.get.mockResolvedValue(saved);mocks.revoke.mockRejectedValue(new FullscriptUnavailableError('Fullscript disconnect failed.'));
    await expect(disconnectFullscript(session)).rejects.toMatchObject({code:'unavailable',message:FULLSCRIPT_DISCONNECT_UNCONFIRMED});
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('a provider action that needs a reconnect says so (409, in its own words); anything else is unavailable, never "Something went wrong"',()=>{
    for(const message of [FULLSCRIPT_RECONNECT_REQUIRED,FULLSCRIPT_RECONNECT_AFTER_MEMBERSHIP_CHANGE,FULLSCRIPT_NOT_CONNECTED]){
      expect(fullscriptActionError(new FullscriptUnavailableError(message))).toMatchObject({code:'conflict',message});
    }
    for(const error of [new FullscriptUnavailableError(),new Error('fictional-access-token-abcdefghijklmnopqrstuvwxyz raw')]){
      const mapped=fullscriptActionError(error);
      expect(mapped).toMatchObject({code:'unavailable',message:FULLSCRIPT_ACTION_UNAVAILABLE});
      expect(JSON.stringify(mapped.toJSON())).not.toContain('fictional-access-token');
    }
  });
});
