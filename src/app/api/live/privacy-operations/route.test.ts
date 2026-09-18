import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({session:vi.fn(),client:vi.fn()}));
vi.mock('@/server/session',()=>({getRequestSession:mocks.session}));
vi.mock('@/server/clinical-core/privacy-operations-client',()=>({requestPrivacyOperation:mocks.client}));
vi.mock('../route-helpers',()=>({liveGuard:()=>null}));
import {POST} from './route';
const request=(body:unknown={action:'list',includeClosed:false},origin='https://desktop.example')=>new NextRequest('https://desktop.example/api/live/privacy-operations',{
  method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({token:'fixture-token'});mocks.client.mockResolvedValue({items:[],nextAfter:null});});
describe('privacy Desktop route',()=>{
  it('refuses missing or cross-origin requests before session or data access',async()=>{
    for(const origin of ['','https://foreign.example'])expect((await POST(request(undefined,origin))).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();expect(mocks.client).not.toHaveBeenCalled();
  });
  it('requires an authenticated session',async()=>{
    mocks.session.mockResolvedValue({token:null});expect((await POST(request())).status).toBe(401);expect(mocks.client).not.toHaveBeenCalled();
  });
  it('rejects owner selectors and invalid resolution input',async()=>{
    expect((await POST(request({action:'list',includeClosed:false,ownerId:'injected'}))).status).toBe(400);
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it('returns only validated input to the server client and prevents response caching',async()=>{
    const r=await POST(request());expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');
    expect(mocks.client).toHaveBeenCalledWith('fixture-token',{action:'list',includeClosed:false});
  });
  it('sanitizes unknown failures',async()=>{
    mocks.client.mockRejectedValue(new Error('credential and health payload'));
    const r=await POST(request());expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'service_unavailable'});
  });
});
