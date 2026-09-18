import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceWorkforceSessionChange, onWorkforceSessionChange } from './workforce-session-change';
afterEach(() => vi.unstubAllGlobals());
describe('workforce invalidation without sensitive payloads', () => {
  it('invalidates same-document owners before writing the cross-tab marker and removes subscriptions', () => {
    const target = new EventTarget(), events:string[]=[];
    vi.stubGlobal('window', target);
    vi.stubGlobal('localStorage', { setItem: vi.fn((key:string,value:string) => {
      events.push('storage'); expect(key).toBe('alp-workforce-session-change'); expect(value).toMatch(/^[a-f0-9-]{36}$/);
    }) });
    const invalidate=vi.fn(()=>events.push('stop'));
    const unsubscribe=onWorkforceSessionChange(invalidate);
    announceWorkforceSessionChange();expect(events).toEqual(['stop','storage']);
    target.dispatchEvent(Object.assign(new Event('storage'),{key:'another-key'}));expect(invalidate).toHaveBeenCalledTimes(1);
    target.dispatchEvent(Object.assign(new Event('storage'),{key:'alp-workforce-session-change'}));expect(invalidate).toHaveBeenCalledTimes(2);
    unsubscribe();announceWorkforceSessionChange();expect(invalidate).toHaveBeenCalledTimes(2);
  });
  it('still stops same-document owners when browser storage is unavailable', () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('blocked'); } });
    const invalidate=vi.fn(), unsubscribe=onWorkforceSessionChange(invalidate);
    expect(()=>announceWorkforceSessionChange()).not.toThrow();expect(invalidate).toHaveBeenCalledOnce();unsubscribe();
  });
});
