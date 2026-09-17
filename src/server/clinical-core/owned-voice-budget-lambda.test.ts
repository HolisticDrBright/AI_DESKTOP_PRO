import {describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({budgets:[] as unknown[],create:vi.fn()}));
vi.mock('./owned-voice-api',()=>({createOwnedVoiceApi:(configuration:unknown)=>{
  mocks.create(configuration);
  return async(_event:unknown,budget:unknown)=>{mocks.budgets.push(budget);return {statusCode:200,body:'{}',headers:{}};};
}}));
import {handler} from './owned-voice-api-lambda';
import type {VoiceWorkBudget} from './voice-work-budget';
describe('warm production voice Lambda budget wiring',()=>{
  it('creates a fresh remaining-time budget even when the API closure is cached',async()=>{
    let first=30000,second=30000;
    await handler({source:'aws.events'},{getRemainingTimeInMillis:()=>first});
    first=0;
    await handler({source:'aws.events'},{getRemainingTimeInMillis:()=>second});
    expect(mocks.create).toHaveBeenCalledOnce();
    const [a,b]=mocks.budgets as VoiceWorkBudget[];
    expect(a).not.toBe(b);expect(a.canStart()).toBe(false);expect(b.canStart()).toBe(true);
    second=1000;expect(b.canStart()).toBe(false);expect(()=>b.signal()).toThrow('voice_work_deferred');
  });
});
