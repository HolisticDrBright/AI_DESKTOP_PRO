import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecordingStorageBudget } from './recording-storage-budget';
const now=Date.parse('2026-09-17T00:00:00Z');
afterEach(()=>vi.useRealTimers());
describe('independent recording storage deadline',()=>{
  it('clears its timer on a successful storage operation',async()=>{
    vi.useFakeTimers();let signal!:AbortSignal;
    const budget=createRecordingStorageBudget(new Date(now+30000).toISOString(),20000,()=>now);
    expect(await budget.run(async s=>{signal=s;return 'receipt';})).toBe('receipt');
    expect(vi.getTimerCount()).toBe(0);expect(signal.aborted).toBe(false);
  });
  it('consumes late rejection after timeout without reviving the caller',async()=>{
    vi.useFakeTimers();let fail!:(error:Error)=>void;let signal!:AbortSignal;
    const budget=createRecordingStorageBudget(new Date(now+30000).toISOString(),20000,()=>now);
    const result=budget.run(s=>{signal=s;return new Promise((_resolve,reject)=>{fail=reject;});});
    const checked=expect(result).rejects.toThrow('recording_storage_deadline');
    await vi.advanceTimersByTimeAsync(10000);await checked;
    expect(signal.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
    fail(new Error('late private response'));await vi.advanceTimersByTimeAsync(0);
  });
  it('uses the earlier reservation expiry even when an operation ignores abort',async()=>{
    vi.useFakeTimers();const budget=createRecordingStorageBudget(new Date(now+750).toISOString(),20000,()=>now);
    let aborted=false;
    const result=budget.run(s=>{s.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});});
    const checked=expect(result).rejects.toThrow('recording_storage_deadline');
    await vi.advanceTimersByTimeAsync(749);expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);await checked;expect(aborted).toBe(true);
  });
  it('shares the total budget across PUT and HEAD despite a backwards wall clock',async()=>{
    vi.useFakeTimers();let wall=now,mono=0;
    const budget=createRecordingStorageBudget(new Date(now+30000).toISOString(),12000,()=>wall,()=>mono);
    const first=budget.run(async()=>{mono=9000;wall-=60000;return true;});
    expect(await first).toBe(true);
    let aborted=false;
    const second=budget.run(s=>{s.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});});
    const checked=expect(second).rejects.toThrow('recording_storage_deadline');
    await vi.advanceTimersByTimeAsync(3000);await checked;expect(aborted).toBe(true);
  });
  it('rejects a result that arrives after expiry even before a delayed timer fires',async()=>{
    let mono=0;
    const budget=createRecordingStorageBudget(new Date(now+30000).toISOString(),10000,()=>now,()=>mono);
    await expect(budget.run(async()=>{mono=10001;return 'must not accept';})).rejects.toThrow('recording_storage_deadline');
  });
  it('enforces the individual operation limit even when the total budget has time remaining',async()=>{
    let mono=0;
    const budget=createRecordingStorageBudget(new Date(now+30000).toISOString(),20000,()=>now,()=>mono);
    await expect(budget.run(async()=>{mono=10001;return 'too late';})).rejects.toThrow('recording_storage_deadline');
    // Read-only reconciliation can still use the remainder; no second PUT is required.
    expect(await budget.run(async()=> 'verified HEAD')).toBe('verified HEAD');
  });
  it('checks before invoking queued work and never dispatches after expiry',async()=>{
    let mono=0;const operation=vi.fn();
    const budget=createRecordingStorageBudget(new Date(now+30000).toISOString(),10000,()=>now,()=>mono);
    const request=budget.run(operation);mono=10001;
    await expect(request).rejects.toThrow('recording_storage_deadline');expect(operation).not.toHaveBeenCalled();
  });
  it.each([new Date(now-1).toISOString(),'invalid'])('refuses invalid/expired reservation %s before storage',expiry=>{
    const operation=vi.fn();const budget=createRecordingStorageBudget(expiry,20000,()=>now);
    expect(()=>budget.run(operation)).toThrow('recording_storage_deadline');expect(operation).not.toHaveBeenCalled();
  });
  it('does not leak timers on synchronous storage failure',async()=>{
    vi.useFakeTimers();const budget=createRecordingStorageBudget(new Date(now+30000).toISOString(),20000,()=>now);
    await expect(budget.run(()=>{throw new Error('failed');})).rejects.toThrow('failed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
