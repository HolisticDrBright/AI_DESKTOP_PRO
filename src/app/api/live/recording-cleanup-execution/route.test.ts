import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const session=vi.hoisted(()=>vi.fn());
vi.mock('@/server/session',()=>({getRequestSession:session}));
vi.mock('@/adapters/mode',()=>({USE_LIVE_API:true}));
import {POST} from './route';
import {recordingCleanupExecutionConfigured} from '@/adapters/recording-cleanup-execution.server';
const id='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222';
const request={recordingId:id,version:2,requestId,confirmation:'run_bounded_cleanup_pass'};
const capabilities={boundedPass:true,scheduledDispatch:false,holdMutation:false,wholeRecordingErasure:false};
const payload={data:{state:'already_claimed',runId:requestId,recordingId:id,audioDeleted:false,requiresRecheck:true},capabilities};
const upstream=vi.fn();
function req(data:unknown=request,headers:Record<string,string>={},query=''){
  return new Request('https://desktop.example/api/live/recording-cleanup-execution'+query,{method:'POST',
    headers:{origin:'https://desktop.example','content-type':'application/json',...headers},body:JSON.stringify(data)});
}
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('fetch',upstream);
  vi.stubEnv('RECORDING_CLEANUP_EXECUTION_API_ORIGIN','https://abcdefghij.execute-api.us-east-2.amazonaws.com');
  vi.stubEnv('RECORDING_CLEANUP_EXECUTION_UI','enabled');session.mockResolvedValue({signedIn:true,token:'fictional-workforce-cookie'});
  upstream.mockImplementation(async()=>Response.json(payload));});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();});
it('forwards only the cookie identity and preserves the stable request reference on retry',async()=>{
  expect(recordingCleanupExecutionConfigured()).toBe(true);
  for(let n=0;n<2;n++){
    const response=await POST(req(request,{authorization:'Bearer client-override'}));expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);expect(response.headers.get('cache-control')).toBe('no-store');
  }
  for(const call of upstream.mock.calls){
    expect(call[0]).toBe('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/encounter-recording/cleanup-execution');
    expect(call[1]).toMatchObject({method:'POST',cache:'no-store',redirect:'error',body:JSON.stringify(request),headers:{Authorization:'Bearer fictional-workforce-cookie'}});
  }
});
it.each(['','false','approved'])('keeps execution disabled unless explicitly configured: %s',async flag=>{
  vi.stubEnv('RECORDING_CLEANUP_EXECUTION_UI',flag);expect(recordingCleanupExecutionConfigured()).toBe(false);
  expect((await POST(req())).status).toBe(503);expect(upstream).not.toHaveBeenCalled();
});
it.each<Record<string,string>>([{origin:''},{origin:'https://evil.example'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'cross-site'}])(
  'refuses cross-origin requests before identity: %o',async headers=>{
    expect((await POST(req(request,headers))).status).toBe(403);expect(session).not.toHaveBeenCalled();expect(upstream).not.toHaveBeenCalled();
  });
it.each([{signedIn:false,token:'fixture'},{signedIn:true,token:null}])('requires a workforce cookie: %o',async state=>{
  session.mockResolvedValue(state);expect((await POST(req())).status).toBe(401);expect(upstream).not.toHaveBeenCalled();
});
it.each([{actorPersonId:id},{organizationId:id},{workerSha256:'a'.repeat(64)},{cleanupReleaseId:id},{version:0},
  {confirmation:undefined},{requestId:'bad'},{purpose:'clinical_data'}])('rejects injection and malformed confirmation: %o',async fields=>{
    expect((await POST(req({...request,...fields}))).status).toBe(400);expect(upstream).not.toHaveBeenCalled();
  });
it('rejects query parameters, non-JSON and oversized inputs',async()=>{
  expect((await POST(req(request,{},'?actor='+id))).status).toBe(400);
  expect((await POST(req(request,{'content-type':'text/plain'}))).status).toBe(400);
  expect((await POST(req({...request,extra:'x'.repeat(2049)}))).status).toBe(413);expect(upstream).not.toHaveBeenCalled();
});
it.each(['','http://abcdefghij.execute-api.us-east-2.amazonaws.com','https://evil.example','https://user@abcdefghij.execute-api.us-east-2.amazonaws.com',
  'https://abcdefghij.execute-api.us-east-2.amazonaws.com/path','https://abcdefghij.execute-api.us-east-2.amazonaws.com?override=true',
  'https://abcdefghij.execute-api.us-east-2.amazonaws.com:8443'])('refuses invalid origin %s without a capture/review fallback',async origin=>{
    vi.stubEnv('RECORDING_CLEANUP_EXECUTION_API_ORIGIN',origin);vi.stubEnv('RECORDING_CLEANUP_REVIEW_API_ORIGIN','https://abcdefghij.execute-api.us-east-2.amazonaws.com');
    expect(recordingCleanupExecutionConfigured()).toBe(false);expect((await POST(req())).status).toBe(503);expect(upstream).not.toHaveBeenCalled();
  });
it.each([400,401,403,409,503])('sanitizes upstream %i',async status=>{
  upstream.mockResolvedValue(new Response('secret SQL patient payload',{status}));const response=await POST(req());
  expect(response.status).toBe(status);expect(await response.text()).not.toMatch(/secret|SQL|patient/);
});
it.each([{...payload,data:{...payload.data,runId:id}},{...payload,data:{...payload.data,recordingId:requestId}},
  {...payload,capabilities:{...capabilities,scheduledDispatch:true}},{...payload,data:{...payload.data,audioDeleted:true}},
  {...payload,extra:'SECRET'}])('refuses mismatched or overstated receipts',async result=>{
    upstream.mockResolvedValue(Response.json(result));const response=await POST(req());expect(response.status).toBe(503);expect(await response.text()).not.toContain('SECRET');
  });
it('bounds stalled bodies and refuses oversized or invalid UTF-8 responses',async()=>{
  vi.useFakeTimers();const cancel=vi.fn();upstream.mockResolvedValue(new Response(new ReadableStream({cancel}),{headers:{'content-type':'application/json'}}));
  const pending=POST(req());await vi.advanceTimersByTimeAsync(5001);expect((await pending).status).toBe(503);expect(cancel).toHaveBeenCalledOnce();
  upstream.mockResolvedValue(new Response('x'.repeat(4097),{headers:{'content-type':'application/json'}}));expect((await POST(req())).status).toBe(503);
  upstream.mockResolvedValue(new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}));expect((await POST(req())).status).toBe(503);
});
it('bounds uncooperative fetch and ignores its late body without claiming cancellation of server work',async()=>{
  vi.useFakeTimers();let resolve!:(r:Response)=>void;upstream.mockImplementation(()=>new Promise<Response>(r=>{resolve=r;}));
  const pending=POST(req());await vi.advanceTimersByTimeAsync(35001);const response=await pending;
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:{code:'unavailable'}});expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
  const cancel=vi.fn();resolve(new Response(new ReadableStream({cancel})));await vi.advanceTimersByTimeAsync(1);expect(cancel).toHaveBeenCalledOnce();
});
it('propagates browser abort without issuing another request',async()=>{
  const controller=new AbortController();upstream.mockImplementation(()=>new Promise(()=>{}));
  const pending=POST(new Request(req(),{signal:controller.signal}));await vi.waitFor(()=>expect(upstream).toHaveBeenCalledOnce());controller.abort();
  expect((await pending).status).toBe(503);expect(upstream).toHaveBeenCalledOnce();
});
