import {describe,it,expect,vi} from 'vitest';
import {validateOwnedPayload} from './owned-lab-observations';
import {buildOwnedChatContext} from './owned-chat-context';
import type {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
const observation={id:'10000000-0000-4000-8000-000000000001',panelId:'20000000-0000-4000-8000-000000000001',markerId:'30000000-0000-4000-8000-000000000001',panelName:'Synthetic panel',name:'Ferritin',value:0,unit:'ng/mL',drawnAt:'2026-01-01T00:00:00.000Z',reportedRange:{low:1,high:2},sourceStatus:'consumer_import_unverified'};
function fixture(granted=true,count=1){
  const consentState=vi.fn(async(_c:unknown,scope:string)=>({activeRevision:scope==='lab_history'&&!granted?null:1}));
  const rows=Array.from({length:count},(_,i)=>({recordId:String(i),receivedAt:'2026-01-01T00:00:00Z',revision:1,payload:{...observation,name:i===100?'Iron':'Ferritin'}}));
  const list=vi.fn(async(_c:unknown,input:{after?:{recordId:string}})=>{const start=input.after?Number(input.after.recordId)+1:0;return rows.slice(start,start+100);});
  return {consentState,list,adapter:{consentState,list} as unknown as ReturnType<typeof createOwnedConsumerRecordsAdapter>};
}
describe('personal lab history',()=>{
  it('retains measured zero and rejects fabricated authority, invalid dates and extra fields',()=>{
    expect(()=>validateOwnedPayload('lab_observations',observation)).not.toThrow();
    for(const patch of [{sourceStatus:'independently_verified'},{functionalRange:{low:1,high:2}},{value:NaN},{drawnAt:'2026-02-30T00:00:00.000Z'},{drawnAt:'2099-01-01T00:00:00.000Z'},{reportedRange:{low:2,high:1}},{ownerId:observation.id}])expect(()=>validateOwnedPayload('lab_observations',{...observation,...patch})).toThrow();
  });
  it('loads beyond the first page while never presenting imported ranges as verified',async()=>{
    const f=fixture(true,101);const result=await buildOwnedChatContext(f.adapter,{} as ProductionClinicalRequestContext,['ai_context','lab_history']);
    expect(f.list).toHaveBeenCalledTimes(2);expect(result.labs).toHaveLength(101);
    expect(result.labs.find(l=>l.name==='Iron')).toMatchObject({value:0,functionalRange:null,conventionalRange:null,sourceStatus:'consumer_import_unverified'});
  });
  it('does not read lab data without both release scope and specific consent',async()=>{
    const f=fixture(false);expect((await buildOwnedChatContext(f.adapter,{} as ProductionClinicalRequestContext,['ai_context','lab_history'])).labs).toEqual([]);expect(f.list).not.toHaveBeenCalled();
    const g=fixture();await buildOwnedChatContext(g.adapter,{} as ProductionClinicalRequestContext,['ai_context']);expect(g.list).not.toHaveBeenCalled();
  });
  it('refuses withdrawal during assembly, repeated pages, and oversized histories',async()=>{
    const f=fixture();f.consentState.mockImplementation(async(_c,scope)=>({activeRevision:scope==='lab_history'&&f.list.mock.calls.length?null:1}));await expect(buildOwnedChatContext(f.adapter,{} as ProductionClinicalRequestContext,['ai_context','lab_history'])).rejects.toThrow('consent_required');
    const g=fixture(true,1001);await expect(buildOwnedChatContext(g.adapter,{} as ProductionClinicalRequestContext,['ai_context','lab_history'])).rejects.toThrow('storage_unavailable');
    const h=fixture(true,100);const page=await h.list({},{});h.list.mockResolvedValue(page);await expect(buildOwnedChatContext(h.adapter,{} as ProductionClinicalRequestContext,['ai_context','lab_history'])).rejects.toThrow('storage_unavailable');
  });
});
