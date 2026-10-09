import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const session=vi.hoisted(()=>vi.fn());
vi.mock('@/server/session',()=>({getRequestSession:session}));
vi.mock('@/adapters/mode',()=>({USE_LIVE_API:true}));
import {POST} from './route';
const upstream=vi.fn();
const host='penrnyupn3.us-east-2.awsapprunner.com';
function req(headers:Record<string,string>={},url='http://0.0.0.0:3000/api/live/care-messages'){
 return new Request(url,{method:'POST',headers:{host,origin:'https://'+host,'sec-fetch-site':'same-origin','content-type':'application/json',...headers},body:JSON.stringify({action:'list'})});
}
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('fetch',upstream);
 vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN','https://abcdefghij.execute-api.us-east-2.amazonaws.com');
 session.mockResolvedValue({token:'fictional-workforce-token'});
 upstream.mockResolvedValue(Response.json({data:{action:'list',threads:[],nextBefore:null}}));
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('accepts the browser public origin behind TLS termination without trusting the internal listener URL',async()=>{
 const result=await POST(req());expect(result.status).toBe(200);
 expect(upstream).toHaveBeenCalledOnce();
 expect(upstream.mock.calls[0][1].headers.authorization).toBe('Bearer fictional-workforce-token');
});
it.each<Record<string,string>>([
 {origin:'https://evil.example'}, {origin:''}, {host:''}, {origin:'http://'+host},
 {origin:'https://'+host+'/path'}, {'sec-fetch-site':'cross-site'}, {'sec-fetch-site':'same-site'},
 {origin:'https://evil.example','x-forwarded-host':'evil.example'},
])('refuses unsafe origins before accessing credentials: %o',async headers=>{
 expect((await POST(req(headers))).status).toBe(403);expect(session).not.toHaveBeenCalled();expect(upstream).not.toHaveBeenCalled();
});
it('preserves loopback-only HTTP development',async()=>{
 expect((await POST(req({host:'localhost:3164',origin:'http://localhost:3164'},'http://localhost:3164/api/live/care-messages'))).status).toBe(200);
});
it('requires the authenticated cookie session after origin validation',async()=>{
 session.mockResolvedValue({token:null});expect((await POST(req())).status).toBe(401);expect(upstream).not.toHaveBeenCalled();
});
