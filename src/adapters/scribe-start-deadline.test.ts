import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('./session.server',()=>({getClinicalAccessToken:vi.fn().mockResolvedValue('synthetic-token')}));
vi.mock('./config',()=>({TRPC_BASE_URL:'http://127.0.0.1:3999/api/trpc'}));
import {scribeLive} from './scribe.live';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
describe('scribe begin upstream deadline',()=>{
  it('aborts stalled upstream authorization with a safe error and no retry',async()=>{
    vi.useFakeTimers();const controller=new AbortController();
    const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{setTimeout(()=>controller.abort(),ms);return controller.signal;});
    const fetcher=vi.fn((_url:string,init:RequestInit)=>new Promise((_resolve,reject)=>{
      init.signal!.addEventListener('abort',()=>reject(new Error('private upstream detail')),{once:true});
    }));vi.stubGlobal('fetch',fetcher);
    const request=scribeLive.beginRecording({encounterId:'fictional',contentType:'audio/webm'},'synthetic-token');
    const checked=expect(request).rejects.toMatchObject({code:'unavailable'});
    await vi.advanceTimersByTimeAsync(7000);await checked;
    expect(timeout).toHaveBeenCalledWith(7000);expect(fetcher).toHaveBeenCalledOnce();expect(controller.signal.aborted).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({method:'POST',cache:'no-store',signal:controller.signal});
  });
  it('preserves successful authorization without replay',async()=>{
    const value={recordingId:'fictional-recording',sessionId:'fictional-session',captureToken:'synthetic-only'};
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({result:{data:{json:value}}})));vi.stubGlobal('fetch',fetcher);
    expect(await scribeLive.beginRecording({encounterId:'fictional',contentType:'audio/webm'})).toEqual(value);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
