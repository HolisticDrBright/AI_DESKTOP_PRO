import {describe,it,expect,vi} from 'vitest';
import {buildOwnedChatContext} from './owned-chat-context';
import type {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
const context={purpose:'clinical_data'} as ProductionClinicalRequestContext;
const now=Date.parse('2026-09-08T12:00:00Z');
function setup(data:Record<string,Record<string,unknown>[]>={},grants=['ai_context','forms_checkins']){
  const consentState=vi.fn(async(_ctx:unknown,scope:string)=>({activeRevision:grants.includes(scope)?1:null}));
  const recent=vi.fn(async(_ctx:unknown,{collection}:{collection:string})=>(data[collection]??[]).map((payload,i)=>({recordId:String(i),revision:1,payload,receivedAt:'2026-09-08T00:00:00Z'})));
  return {consentState,recent,adapter:{consentState,recent} as unknown as ReturnType<typeof createOwnedConsumerRecordsAdapter>};
}
describe('owned AI context',()=>{
  it('preserves recorded medications without treating them as new recommendations',async()=>{
    const s=setup({contraindications:[{medications:['Fictional prescribed medication'],conditions:[],allergies:[]}]});
    const result=await buildOwnedChatContext(s.adapter,context,['ai_context','forms_checkins'],now);
    expect(result.profile?.medications).toEqual(['Fictional prescribed medication']);expect(result.governedOptions).toEqual([]);
  });
  it('includes recent consented adverse reports and preserves an urgent safety answer',async()=>{
    const report={event_type:'possible_adverse_reaction',symptom:'Fictional rash',severity:4,onset_at:'2026-09-08T01:00:00Z',actions_taken:['Stopped test item'],safety_answers:{breathingDifficulty:false,faceOrThroatSwelling:true,chestPain:false,faintingOrSeizure:false,uncontrolledBleeding:false,immediateDanger:false}};
    const s=setup({adverse_event_reports:[report,{...report,onset_at:'2025-01-01T00:00:00Z'}]},['ai_context','symptoms_adherence']);
    const result=await buildOwnedChatContext(s.adapter,context,['ai_context','symptoms_adherence'],now);
    expect(result.recentReports).toHaveLength(1);expect(result.recentReports[0]).toMatchObject({urgentSafetyAnswer:true,symptom:'Fictional rash'});
    const denied=setup({adverse_event_reports:[report]},['ai_context']);
    expect((await buildOwnedChatContext(denied.adapter,context,['ai_context','symptoms_adherence'],now)).recentReports).toEqual([]);
    expect(denied.recent).not.toHaveBeenCalled();
  });
  it('requires separate AI consent before collecting personal records',async()=>{const s=setup({},['forms_checkins']);await expect(buildOwnedChatContext(s.adapter,context,['forms_checkins','ai_context'])).rejects.toThrow('consent_required');expect(s.recent).not.toHaveBeenCalled();});
  it('uses recorded profile data without inventing demographics, labs, or practitioner approval',async()=>{const s=setup({wellness_profiles:[{goals:['Sleep']}],lifestyle_profiles:[{dietType:'vegetarian',cookingSkill:'beginner'}]});const r=await buildOwnedChatContext(s.adapter,context,['forms_checkins','ai_context']);expect(r.profile).toMatchObject({sex:null,ageYears:null,goals:['Sleep'],dietOfRecord:'vegetarian'});expect(r.labs).toEqual([]);expect(r.protocol).toBeNull();});
  it('withholds a snapshot if consent changes during assembly',async()=>{const s=setup();s.consentState.mockImplementation(async(_ctx,scope)=>({activeRevision:scope==='ai_context'&&s.recent.mock.calls.length?null:1}));await expect(buildOwnedChatContext(s.adapter,context,['forms_checkins','ai_context'])).rejects.toThrow('consent_required');});
  it('includes actual steps without manufacturing recovery or a baseline',async()=>{const s=setup({wearable_daily_records:[{date:'2026-09-08',steps:4300}]},['ai_context','wearables']);const r=await buildOwnedChatContext(s.adapter,context,['ai_context','wearables'],now);expect(r.wearables).toMatchObject({steps:4300,recoveryScore:null,hrvDeltaPercent:null,sleepMinutes:null});});
  it('does not present stale wearable data as current',async()=>{const s=setup({wearable_daily_records:[{date:'2025-09-08',steps:4300}]},['ai_context','wearables']);expect((await buildOwnedChatContext(s.adapter,context,['ai_context','wearables'],now)).wearables).toBeNull();});
  it('does not infer ovulation from a cycle-day number',async()=>{const s=setup({reproductive_profiles:[{stage:'regular_cycle',cycleDay:14,consent:{status:'granted',artifactVersion:'reviewed/1'}}]},['ai_context','reproductive_health']);expect((await buildOwnedChatContext(s.adapter,context,['ai_context','reproductive_health'],now)).cycle).toMatchObject({day:14,phase:'unknown',confidence:'none'});});
});
