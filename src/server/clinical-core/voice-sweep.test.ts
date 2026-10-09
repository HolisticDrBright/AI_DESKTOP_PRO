import {describe,it,expect,vi} from 'vitest';
import {VoiceJobs,type VoiceRepository,type VoiceProvider,type VoiceDueCursor} from './voice-jobs';
import {createVoiceWorkBudget,VoiceWorkDeferred} from './voice-work-budget';
const id=(n:number)=>n.toString(16).padStart(64,'0');
function fixture(count=60){
  const ids=Array.from({length:count},(_,i)=>id(i+1));
  const repo:VoiceRepository={get:vi.fn(),insert:vi.fn(),acquire:vi.fn(),release:vi.fn(),cancel:vi.fn(),
    due:vi.fn(async(_now:number,after?:VoiceDueCursor)=>{
      const start=after?ids.indexOf(after.id)+1:0,chunk=ids.slice(start,start+25);
      return {ids:chunk,next:start+25<count?{id:chunk.at(-1)!,pending:'work' as const,nextWork:1}:null};
    })};
  const provider:VoiceProvider={upload:vi.fn(),start:vi.fn(),status:vi.fn(),transcript:vi.fn(),remove:vi.fn()};
  let remaining=30000;
  const budget=createVoiceWorkBudget(()=>remaining,()=>0),service=new VoiceJobs(repo,provider,()=>1000,undefined,budget);
  const advance=vi.spyOn(service,'advance').mockResolvedValue();
  return {repo,service,advance,budget,setRemaining:(v:number)=>{remaining=v;}};
}
describe('voice backlog traversal and invocation budget',()=>{
  it('visits all pages with one fixed cutoff and passes the full continuation key',async()=>{
    const f=fixture();const result=await f.service.sweep();
    expect(result).toEqual({attempted:60,failed:0,pages:3,stopReason:'exhausted',backlogCleared:false});
    expect(f.advance).toHaveBeenCalledTimes(60);
    expect(f.repo.due).toHaveBeenNthCalledWith(2,1000,{id:id(25),pending:'work',nextWork:1});
    expect(f.repo.due).toHaveBeenNthCalledWith(3,1000,{id:id(50),pending:'work',nextWork:1});
  });
  it('does not let the first leased page hide later eligible work',async()=>{
    const f=fixture(26);f.advance.mockRestore();
    vi.mocked(f.repo.acquire).mockImplementation(async key=>key===id(26)?{
      id:key,owner:'fictional',inputHash:'x',format:'wav',state:'queued',cancelled:false,
      consentVersion:'test',consentAcceptedAt:1,createdAt:1,readableUntil:2000,nextWork:1,
    }:undefined);
    const result=await f.service.sweep();
    expect(result.attempted).toBe(26);expect(f.repo.acquire).toHaveBeenCalledTimes(26);
    expect(f.repo.release).toHaveBeenCalledTimes(1);expect(f.repo.release).toHaveBeenCalledWith(id(26),expect.any(String),expect.any(Object));
  });
  it('continues past held jobs, retaining a failing invocation for alarm/retry',async()=>{
    const f=fixture(26);f.advance.mockImplementation(async key=>{if(key===id(1))throw new Error('held');});
    await expect(f.service.sweep()).rejects.toThrow('voice_cleanup_retry_required');
    expect(f.advance).toHaveBeenLastCalledWith(id(26));
  });
  it('stops before acquiring another job when the reserved deadline is reached',async()=>{
    const f=fixture();f.advance.mockImplementationOnce(async()=>{f.setRemaining(12000);});
    expect(await f.service.sweep()).toMatchObject({attempted:1,stopReason:'budget',backlogCleared:false});
    expect(f.advance).toHaveBeenCalledOnce();expect(f.repo.due).toHaveBeenCalledOnce();
  });
  it('does not even query with insufficient startup time',async()=>{
    const f=fixture();f.setRemaining(11000);
    expect(await f.service.sweep()).toMatchObject({attempted:0,pages:0,stopReason:'budget'});
    expect(f.repo.due).not.toHaveBeenCalled();
  });
  it('defers deadline refusal without reporting successful cleanup',async()=>{
    const f=fixture();f.advance.mockRejectedValueOnce(new VoiceWorkDeferred());
    expect(await f.service.sweep()).toMatchObject({attempted:1,stopReason:'budget',backlogCleared:false});
    expect(f.advance).toHaveBeenCalledOnce();
  });
  it('bounds work to 20 pages without claiming the backlog is cleared',async()=>{
    const f=fixture(501);expect(await f.service.sweep()).toMatchObject({attempted:500,pages:20,stopReason:'limit',backlogCleared:false});
    expect(f.advance).not.toHaveBeenCalledWith(id(501));
  });
  it.each([
    {ids:[id(1)],next:{id:id(1),pending:'other',nextWork:1}},
    {ids:[id(1)],next:{id:id(1),pending:'work',nextWork:1001}},
    {ids:[id(1)],next:{id:id(1),pending:'work',nextWork:1,owner:'foreign'}},
    {ids:['foreign'],next:null},
    {ids:Array.from({length:26},(_,i)=>id(i)),next:null},
  ])('rejects malformed pages before any mutation: %j',async page=>{
    const f=fixture();vi.mocked(f.repo.due).mockResolvedValue(page as Awaited<ReturnType<VoiceRepository['due']>>);
    await expect(f.service.sweep()).rejects.toThrow('voice_inventory_invalid');expect(f.advance).not.toHaveBeenCalled();
  });
  it('rejects looping cursors and skips GSI duplicate job IDs',async()=>{
    const f=fixture();const next={id:id(25),pending:'work' as const,nextWork:1};
    vi.mocked(f.repo.due).mockResolvedValueOnce({ids:[id(1)],next}).mockResolvedValueOnce({ids:[id(1),id(2)],next:null});
    expect(await f.service.sweep()).toMatchObject({attempted:2});expect(f.advance).toHaveBeenCalledTimes(2);
    const loop=fixture();vi.mocked(loop.repo.due).mockResolvedValue({ids:[id(1)],next});
    await expect(loop.service.sweep()).rejects.toThrow('voice_inventory_invalid');expect(loop.advance).toHaveBeenCalledOnce();
  });
});
describe('deadline checks',()=>{
  it('uses elapsed time even when a remaining-time source is constant and reserves release time',()=>{
    let now=0;const budget=createVoiceWorkBudget(()=>30000,()=>now);
    expect(budget.canStart()).toBe(true);now=25001;
    expect(budget.canStart()).toBe(false);expect(()=>budget.signal()).toThrow('voice_work_deferred');
    expect(budget.signal(true)).toBeInstanceOf(AbortSignal);now=29001;
    expect(()=>budget.signal(true)).toThrow('voice_work_deferred');
  });
  it('caps oversized and invalid time sources',()=>{
    let now=0;const budget=createVoiceWorkBudget(()=>600000,()=>now);now=30001;
    expect(()=>budget.check()).toThrow('voice_work_deferred');
    for(const value of [NaN,Infinity,-1])expect(()=>createVoiceWorkBudget(()=>value)).toThrow('voice_work_deferred');
    let remaining=30000;const invalid=createVoiceWorkBudget(()=>remaining);remaining=NaN;
    expect(()=>invalid.signal()).toThrow('voice_work_deferred');
  });
});
