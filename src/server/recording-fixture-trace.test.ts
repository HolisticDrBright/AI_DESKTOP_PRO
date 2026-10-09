import { afterEach, describe, expect, it, vi } from 'vitest';
const boundary=vi.hoisted(()=>({allowed:true}));
vi.mock('./runtime/contractFixture',()=>({isContractFixtureAllowed:()=>boundary.allowed}));
import { withRecordingFixtureTrace } from './recording-fixture-trace';
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();boundary.allowed=true;});
describe('recording local-stage evidence',()=>{
  it.each([false,true])('is inert without BOTH explicit opt-in and allowed fixture (boundary %s)',async allowed=>{
    boundary.allowed=allowed;vi.stubEnv('E2E_RECORDING_DIAGNOSTICS',allowed?'':'1');
    const log=vi.spyOn(console,'info').mockImplementation(()=>{});
    expect(await withRecordingFixtureTrace(new Request('http://localhost/test',{method:'PATCH'}),async step=>{step('upstream_start');return 42;})).toBe(42);
    expect(log).not.toHaveBeenCalled();
  });
  it('logs only bounded stages and timing; never copies sensitive URL, headers, body, error or results',async()=>{
    vi.stubEnv('E2E_RECORDING_DIAGNOSTICS','1');const log=vi.spyOn(console,'info').mockImplementation(()=>{});
    const request=new Request('http://localhost/private-patient?token=secret',{method:'PATCH',headers:{authorization:'Bearer secret'},body:'private-record'});
    const result=await withRecordingFixtureTrace(request,async step=>{
      step('request_body_read');step('token_start');step('token_ready');step('upstream_start');step('upstream_headers');step('upstream_decoded');
      // Runtime guard rejects even a future caller that evades the typed API.
      (step as (value:string)=>void)('private-record');return {private:'result'};
    });
    expect(result).toEqual({private:'result'});
    const entries=log.mock.calls.map(args=>JSON.parse(args[0]));
    expect(entries.map(e=>e.stage)).toEqual(['request_received','request_body_read','token_start','token_ready','upstream_start','upstream_headers','upstream_decoded','route_settled']);
    for(const row of entries){expect(Object.keys(row).sort()).toEqual(['check','elapsedMs','method','stage','trace']);expect(row.trace).toMatch(/^[a-f0-9-]{36}$/);expect(row.elapsedMs).toBeGreaterThanOrEqual(0);}
    expect(new Set(entries.map(e=>e.trace)).size).toBe(1);
    expect(JSON.stringify(entries)).not.toMatch(/secret|private|Bearer/);
  });
  it('marks cancellation/settlement without logging the exception and removes the listener',async()=>{
    vi.stubEnv('E2E_RECORDING_DIAGNOSTICS','1');const log=vi.spyOn(console,'info').mockImplementation(()=>{});
    const cancel=new AbortController();const request=new Request('http://localhost/test',{method:'PATCH',signal:cancel.signal});
    const removal=vi.spyOn(request.signal,'removeEventListener');
    await expect(withRecordingFixtureTrace(request,async()=>{cancel.abort();throw new Error('private failure');})).rejects.toThrow('private failure');
    expect(log.mock.calls.map(args=>JSON.parse(args[0]).stage)).toEqual(['request_received','request_aborted','route_settled']);
    expect(removal).toHaveBeenCalledWith('abort',expect.any(Function));expect(JSON.stringify(log.mock.calls)).not.toContain('private failure');
  });
  it('does not let logging failures alter service behavior',async()=>{
    vi.stubEnv('E2E_RECORDING_DIAGNOSTICS','1');vi.spyOn(console,'info').mockImplementation(()=>{throw new Error('logger down');});
    expect(await withRecordingFixtureTrace(new Request('http://localhost/test',{method:'PATCH'}),async step=>{step('upstream_start');return 'same';})).toBe('same');
  });
});
