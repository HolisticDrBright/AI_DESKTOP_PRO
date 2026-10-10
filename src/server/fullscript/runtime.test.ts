import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {RequestSession} from '../session';
import type {StoredFullscriptConnection} from './token-store';
import {readFullscriptConfiguration, type FullscriptToken} from './client';
import {connectedFullscriptClient, disconnectFullscript, fullscriptActor, fullscriptPosture} from './runtime';

const mocks=vi.hoisted(()=>({get:vi.fn(),put:vi.fn(),replace:vi.fn(),remove:vi.fn(),refresh:vi.fn(),configuration:vi.fn(),revoke:vi.fn()}));
vi.mock('./token-store',async importOriginal=>({...await importOriginal<typeof import('./token-store')>(),
  createAwsFullscriptTokenStore:()=>({get:mocks.get,put:mocks.put,replace:mocks.replace,delete:mocks.remove})}));
vi.mock('./client',async importOriginal=>({...await importOriginal<typeof import('./client')>(),
  readFullscriptConfiguration:mocks.configuration,refreshFullscriptToken:mocks.refresh,revokeFullscriptToken:mocks.revoke}));
const session:RequestSession={signedIn:true,email:'fictional@example.test',orgId:'a1234567-1234-4123-8123-123456789012',
  token:'fictional-identity-token',expired:false,expiresAt:null};
let config:ReturnType<typeof readFullscriptConfiguration>;
const fixture=():StoredFullscriptConnection=>({...fullscriptActor(session),environment:'sandbox_us',
  accessToken:'fictional-access-token-abcdefghijklmnopqrstuvwxyz',refreshToken:'fictional-refresh-token-abcdefghijklmnopqrstuvwxyz',
  expiresAt:new Date(Date.now()+30_000).toISOString(),connectedAt:new Date(Date.now()-3600_000).toISOString(),
  resourceOwner:{id:'fictional-practitioner-id',type:'Practitioner'},scope:['clinic:read','clinic:write']});
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
  it('returns only a fixed unavailable code, never an AWS/provider error or secret',async()=>{
    mocks.get.mockRejectedValue(new Error('fictional-access-token-abcdefghijklmnopqrstuvwxyz raw private provider details'));
    expect(await fullscriptPosture(session)).toEqual({configured:false,connected:false,environment:null,reason:'unavailable'});
  });
  it('revokes the observed token then conditionally removes only that connection',async()=>{
    const saved=fixture();mocks.get.mockResolvedValue(saved);
    await disconnectFullscript(session);
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith({configuration:config,token:saved.accessToken});
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(saved);
  });
  it('does not report a new connection disconnected if custody changed during revocation',async()=>{
    mocks.get.mockResolvedValue(fixture());mocks.remove.mockResolvedValue(false);
    await expect(disconnectFullscript(session)).rejects.toMatchObject({code:'fullscript_unavailable'});
  });
});
