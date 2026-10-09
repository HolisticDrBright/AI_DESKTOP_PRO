import {afterEach,describe,expect,it,vi} from 'vitest';
import {prepareCapture} from './capture-start';
afterEach(()=>vi.useRealTimers());
function device(){const stop=vi.fn();return {stop,stream:{getTracks:()=>[{stop}]} as unknown as MediaStream};}
describe('bounded capture preparation',()=>{
  it('hands off the microphone only after successful authorization',async()=>{
    const d=device(),authorize=vi.fn().mockResolvedValue({ok:true});
    const r=await prepareCapture({signal:new AbortController().signal,microphone:async()=>d.stream,authorize});
    expect(r).toEqual({stream:d.stream,authorization:{ok:true}});expect(d.stop).not.toHaveBeenCalled();expect(authorize).toHaveBeenCalledOnce();
  });
  it('stops the microphone and aborts an uncertain authorization without replay',async()=>{
    vi.useFakeTimers();const d=device();let signal:AbortSignal|undefined;
    const authorize=vi.fn((s:AbortSignal)=>{signal=s;return new Promise(()=>{});});
    const result=prepareCapture({signal:new AbortController().signal,microphone:async()=>d.stream,authorize});
    const check=expect(result).rejects.toMatchObject({code:'authorization_unconfirmed'});
    await vi.advanceTimersByTimeAsync(8000);await check;
    expect(d.stop).toHaveBeenCalledOnce();expect(signal?.aborted).toBe(true);expect(authorize).toHaveBeenCalledOnce();
  });
  it('stops a late granted microphone after cancellation and never authorizes it',async()=>{
    const d=device(),controller=new AbortController(),authorize=vi.fn();let grant!:(s:MediaStream)=>void;
    const result=prepareCapture({signal:controller.signal,microphone:()=>new Promise(resolve=>{grant=resolve;}),authorize});
    const check=expect(result).rejects.toMatchObject({code:'cancelled'});controller.abort();await check;
    grant(d.stream);await Promise.resolve();await Promise.resolve();expect(d.stop).toHaveBeenCalledOnce();expect(authorize).not.toHaveBeenCalled();
  });
  it('times out a microphone prompt and closes a later permission grant',async()=>{
    vi.useFakeTimers();const d=device(),authorize=vi.fn();let grant!:(s:MediaStream)=>void;
    const result=prepareCapture({signal:new AbortController().signal,microphone:()=>new Promise(resolve=>{grant=resolve;}),authorize});
    const check=expect(result).rejects.toMatchObject({code:'microphone_timeout'});await vi.advanceTimersByTimeAsync(30000);await check;
    grant(d.stream);await Promise.resolve();expect(d.stop).toHaveBeenCalledOnce();expect(authorize).not.toHaveBeenCalled();
  });
  it('stops on navigation even when a late authorization response succeeds',async()=>{
    const d=device(),controller=new AbortController();let finish!:(v:string)=>void;
    const result=prepareCapture({signal:controller.signal,microphone:async()=>d.stream,authorize:()=>new Promise(resolve=>{finish=resolve;})});
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    const check=expect(result).rejects.toMatchObject({code:'cancelled'});controller.abort();await check;finish('late token');
    expect(d.stop).toHaveBeenCalledOnce();
  });
  it('never contacts the server when the microphone is denied',async()=>{
    const authorize=vi.fn();await expect(prepareCapture({signal:new AbortController().signal,
      microphone:async()=>{throw new Error('private device detail');},authorize})).rejects.toMatchObject({code:'microphone_denied'});
    expect(authorize).not.toHaveBeenCalled();
  });
});
