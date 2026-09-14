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
  const plan={name:'Fictional Core plan',version:2,status:'active',
    supplements_json:[{name:'Fictional product',dose:'Recorded dose',frequency:'Recorded schedule',orderingLink:'https://example.invalid/private'}],
    lifestyle_tasks_json:[{name:'Fictional walking task',frequency:'daily'}],
    peptides_json:[{name:'Excluded peptide'}],generation_json:{source:'aws_lab_analysis',clinicianApproved:true},approved:true};
  it('includes consented personal plan history without upgrading it to clinical approval or eligible products',async()=>{
    const s=setup({protocols:[plan]},['ai_context','protocols_supplements']);
    const r=await buildOwnedChatContext(s.adapter,context,['ai_context','protocols_supplements'],now);
    expect(r.personalPlan).toMatchObject({contractVersion:'consumer-plan-context/1',reviewStatus:'not_clinician_reviewed',sourceStatus:'consumer_saved_unverified',name:plan.name,version:2,
      recordedSupplements:[{name:'Fictional product',dose:'Recorded dose',frequency:'Recorded schedule'}]});
    expect(r.protocol).toBeNull();expect(r.governedOptions).toEqual([]);
    expect(JSON.stringify(r.personalPlan)).not.toMatch(/clinicianApproved|orderingLink|Excluded peptide|aws_lab_analysis/);
  });
  it.each([false,true])('does not read personal plans without both allowed scope and consent (grant=%s)',async grant=>{
    const s=setup({protocols:[plan]},grant?['ai_context','protocols_supplements']:['ai_context']);
    const r=await buildOwnedChatContext(s.adapter,context,grant?['ai_context']:['ai_context','protocols_supplements'],now);
    expect(r.personalPlan).toBeNull();expect(s.recent).not.toHaveBeenCalled();
  });
  it('discards personal context when protocol consent changes during assembly',async()=>{
    const s=setup({protocols:[plan]},['ai_context','protocols_supplements']);
    s.consentState.mockImplementation(async(_ctx,scope)=>({activeRevision:scope==='protocols_supplements'&&s.recent.mock.calls.length?2:1}));
    await expect(buildOwnedChatContext(s.adapter,context,['ai_context','protocols_supplements'],now)).rejects.toThrow('consent_required');
  });
  it('selects the most recently saved active plan, not a newer paused or archived plan',async()=>{
    const s=setup({protocols:[{...plan,status:'archived'},{...plan,status:'paused'},plan]},['ai_context','protocols_supplements']);
    expect((await buildOwnedChatContext(s.adapter,context,['ai_context','protocols_supplements'],now)).personalPlan?.recordId).toBe('2');
    const empty=setup({protocols:[{...plan,status:'completed'}]},['ai_context','protocols_supplements']);
    expect((await buildOwnedChatContext(empty.adapter,context,['ai_context','protocols_supplements'],now)).personalPlan).toBeNull();
  });
  it('rejects malformed saved product data rather than inventing instructions',async()=>{
    const s=setup({protocols:[{...plan,supplements_json:[{name:'Fictional product',dose:999}]}]},['ai_context','protocols_supplements']);
    await expect(buildOwnedChatContext(s.adapter,context,['ai_context','protocols_supplements'],now)).rejects.toThrow('storage_unavailable');
  });
  it('keeps absent recorded instructions unknown instead of inventing doses or dropping the plan',async()=>{
    const s=setup({protocols:[{...plan,supplements_json:[{name:'Fictional product'}]}]},['ai_context','protocols_supplements']);
    const r=await buildOwnedChatContext(s.adapter,context,['ai_context','protocols_supplements'],now);
    expect(r.personalPlan?.recordedSupplements).toEqual([{name:'Fictional product',dose:null,frequency:null}]);
  });
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
