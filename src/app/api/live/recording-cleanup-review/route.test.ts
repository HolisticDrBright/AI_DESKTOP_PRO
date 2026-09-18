import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const session=vi.hoisted(()=>vi.fn());
vi.mock('@/server/session',()=>({getRequestSession:session}));
vi.mock('@/adapters/mode',()=>({USE_LIVE_API:true}));
import {POST} from './route';
const id='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const capabilities={review:true,dispatch:false,storageDeletion:false};
const payload={data:{items:[],nextAfter:null},capabilities};
const upstream=vi.fn();
function req(data:unknown={action:'queue'},headers:Record<string,string>={},query=''){
  return new Request('https://desktop.example/api/live/recording-cleanup-review'+query,{method:'POST',
    headers:{origin:'https://desktop.example','content-type':'application/json',...headers},body:JSON.stringify(data)});
}
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('fetch',upstream);
  vi.stubEnv('RECORDING_CLEANUP_REVIEW_API_ORIGIN','https://abcdefghij.execute-api.us-east-2.amazonaws.com');
  session.mockResolvedValue({signedIn:true,token:'fictional-workforce-cookie'});
  upstream.mockImplementation(async()=>Response.json(payload));});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();});
it('forwards only the cookie identity to the independent read-only endpoint',async()=>{
  const response=await POST(req({action:'queue'},{authorization:'Bearer client-override'}));
  expect(response.status).toBe(200);expect(await response.json()).toEqual(payload);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(upstream).toHaveBeenCalledOnce();
  expect(upstream.mock.calls[0][0]).toBe('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/encounter-recording/cleanup-review');
  expect(upstream.mock.calls[0][1]).toMatchObject({method:'POST',cache:'no-store',redirect:'error',body:'{"action":"queue"}',
    headers:{Authorization:'Bearer fictional-workforce-cookie'}});
});
it.each<Record<string,string>>([{origin:''},{origin:'https://evil.example'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'cross-site'}])
  ('refuses origin mismatch before identity: %o',async headers=>{
    expect((await POST(req(undefined,headers))).status).toBe(403);expect(session).not.toHaveBeenCalled();expect(upstream).not.toHaveBeenCalled();});
it.each([{signedIn:false,token:'fixture'},{signedIn:true,token:null}])('requires a real signed-in cookie: %o',async state=>{
  session.mockResolvedValue(state);expect((await POST(req())).status).toBe(401);expect(upstream).not.toHaveBeenCalled();});
it.each([{action:'run',recordingId:id},{action:'queue',actorPersonId:id},{action:'history'},{action:'queue',after:'invalid'},
  {action:'queue',releaseId:id},{action:'history',recordingId:id,storageDeletion:true}])('rejects injected authority or malformed input: %o',async body=>{
    expect((await POST(req(body))).status).toBe(400);expect(upstream).not.toHaveBeenCalled();});
it('rejects query parameters, non-JSON and oversized input',async()=>{
  expect((await POST(req(undefined,{},'?actor='+id))).status).toBe(400);
  expect((await POST(req(undefined,{'content-type':'text/plain'}))).status).toBe(400);
  expect((await POST(req({action:'queue',extra:'x'.repeat(2049)}))).status).toBe(413);expect(upstream).not.toHaveBeenCalled();
});
it.each(['','http://abcdefghij.execute-api.us-east-2.amazonaws.com','https://evil.example',
  'https://user@abcdefghij.execute-api.us-east-2.amazonaws.com','https://abcdefghij.execute-api.us-east-2.amazonaws.com/path',
  'https://abcdefghij.execute-api.us-east-2.amazonaws.com?override=true','https://abcdefghij.execute-api.us-east-2.amazonaws.com:8443'])
('fails closed on a missing or unapproved origin: %s',async origin=>{vi.stubEnv('RECORDING_CLEANUP_REVIEW_API_ORIGIN',origin);
  expect((await POST(req())).status).toBe(503);expect(upstream).not.toHaveBeenCalled();});
it.each([400,401,403,409,503])('sanitizes upstream %i without relaying secrets',async status=>{
  upstream.mockResolvedValue(new Response('private SQL token patient content',{status}));
  const response=await POST(req());expect(response.status).toBe(status);expect(await response.text()).not.toMatch(/private|SQL|token|patient/);});
it.each([
  {data:{items:[],nextAfter:id},capabilities},
  {data:{items:[],nextAfter:null},capabilities:{...capabilities,dispatch:true}},
  {...payload,secret:'hidden'},
  {data:{recordingId:id,runs:[],nextAfter:null},capabilities},
])('rejects malformed, foreign-action or extra-field receipts',async value=>{
  upstream.mockResolvedValue(Response.json(value));expect((await POST(req())).status).toBe(503);});
it('correlates history with the exact recording',async()=>{
  upstream.mockResolvedValue(Response.json({data:{recordingId:other,runs:[],nextAfter:null},capabilities}));
  expect((await POST(req({action:'history',recordingId:id}))).status).toBe(503);
});
it('bounds stalled response bodies',async()=>{
  vi.useFakeTimers();const cancel=vi.fn();upstream.mockResolvedValue(new Response(new ReadableStream({cancel}),{headers:{'content-type':'application/json'}}));
  const pending=POST(req());await vi.advanceTimersByTimeAsync(10001);
  expect((await pending).status).toBe(503);expect(cancel).toHaveBeenCalledOnce();
});
it('bounds fetch independently even when transport ignores abort',async()=>{
  vi.useFakeTimers();let resolve!:(r:Response)=>void;upstream.mockImplementation(()=>new Promise<Response>(r=>{resolve=r;}));
  const pending=POST(req());await vi.advanceTimersByTimeAsync(15001);expect((await pending).status).toBe(503);
  expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
  const cancel=vi.fn();resolve(new Response(new ReadableStream({cancel})));await vi.advanceTimersByTimeAsync(1);expect(cancel).toHaveBeenCalledOnce();
});
it('propagates browser cancellation without waiting for a stuck transport',async()=>{
  const controller=new AbortController();upstream.mockImplementation(()=>new Promise(()=>{}));
  const input=req();const pending=POST(new Request(input,{signal:controller.signal}));
  await vi.waitFor(()=>expect(upstream).toHaveBeenCalledOnce());controller.abort();expect((await pending).status).toBe(503);
});
it('rejects oversized and malformed UTF-8 responses',async()=>{
  upstream.mockResolvedValue(new Response('x'.repeat(128001),{headers:{'content-type':'application/json'}}));
  expect((await POST(req())).status).toBe(503);
  upstream.mockResolvedValue(new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}));
  expect((await POST(req())).status).toBe(503);
});
