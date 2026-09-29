import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const session=vi.hoisted(()=>vi.fn());
vi.mock('@/server/session',()=>({getRequestSession:session}));
vi.mock('@/adapters/mode',()=>({USE_LIVE_API:true}));
import {POST} from './route';
const upstream=vi.fn();
const host='penrnyupn3.us-east-2.awsapprunner.com';
const connectionId='11111111-1111-4111-8111-111111111111';
const programVersionId='22222222-2222-4222-8222-222222222222';
const phases=[{id:'phase-1',title:'Phase one',days:7,transition:'scheduled',
 items:[{id:'lesson-a',title:'Fictional lesson',kind:'lesson',instructions:'Read it.',released:true}]}];
const assign={action:'assign',connectionId,programVersionId,title:'Fictional thyroid guide',phases};
function req(body:unknown=assign,headers:Record<string,string>={},url='http://0.0.0.0:3000/api/live/program-assignments'){
 return new Request(url,{method:'POST',headers:{host,origin:'https://'+host,'sec-fetch-site':'same-origin',
  'content-type':'application/json',...headers},body:JSON.stringify(body)});
}
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('fetch',upstream);
 vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN','https://abcdefghij.execute-api.us-east-2.amazonaws.com');
 session.mockResolvedValue({token:'fictional-workforce-token'});
 upstream.mockResolvedValue(Response.json({data:{action:'assign',enrollmentId:connectionId,
  sourceDigest:'a'.repeat(64),state:'offered',revision:'1',duplicate:false}}));
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

it('exchanges the cookie session for the workforce token behind TLS termination',async()=>{
 expect((await POST(req())).status).toBe(200);
 expect(upstream).toHaveBeenCalledOnce();
 const [url,init]=upstream.mock.calls[0] as [string,RequestInit];
 expect(url).toBe('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/programs');
 expect((init.headers as Record<string,string>).authorization).toBe('Bearer fictional-workforce-token');
 expect(String(init.body)).not.toContain('fictional-workforce-token');
});
it.each<Record<string,string>>([
 {origin:'https://evil.example'},{origin:''},{host:''},{origin:'http://'+host},
 {'sec-fetch-site':'cross-site'},{origin:'https://evil.example','x-forwarded-host':'evil.example'},
])('refuses unsafe origins before touching credentials: %o',async headers=>{
 expect((await POST(req(assign,headers))).status).toBe(403);
 expect(session).not.toHaveBeenCalled();expect(upstream).not.toHaveBeenCalled();
});
it('requires the authenticated workforce cookie',async()=>{
 session.mockResolvedValue({token:null});
 expect((await POST(req())).status).toBe(401);expect(upstream).not.toHaveBeenCalled();
});
it('refuses a consumer action posted to the workforce route',async()=>{
 for(const body of [{action:'list'},{action:'read',enrollmentId:connectionId},
  {action:'accept',enrollmentId:connectionId,sourceDigest:'a'.repeat(64),expectedRevision:'1',planRevision:'p1'}]){
  expect((await POST(req(body))).status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
 }
});
it('refuses content the assignment contract rejects, without calling upstream',async()=>{
 for(const body of [{...assign,phases:[]},{...assign,title:''},
  {...assign,phases:[{...phases[0],items:[{...phases[0]!.items[0],kind:'supplement'}]}]}]){
  expect((await POST(req(body))).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
 }
});
it('passes a refusal, an unpublished version and a re-pin conflict through as themselves',async()=>{
 for(const status of [401,403,409,429]){
  upstream.mockResolvedValueOnce(new Response('{}',{status,headers:{'content-type':'application/json'}}));
  expect((await POST(req())).status).toBe(status);
 }
 upstream.mockResolvedValueOnce(new Response('{}',{status:500,headers:{'content-type':'application/json'}}));
 expect((await POST(req())).status).toBe(503);
});
it('refuses an upstream reply that is not an answer to this request',async()=>{
 upstream.mockResolvedValueOnce(Response.json({data:{action:'status',assignments:[]}}));
 expect((await POST(req())).status).toBe(503);
 upstream.mockResolvedValueOnce(new Response('<html/>',{status:200,headers:{'content-type':'text/html'}}));
 expect((await POST(req())).status).toBe(503);
});
