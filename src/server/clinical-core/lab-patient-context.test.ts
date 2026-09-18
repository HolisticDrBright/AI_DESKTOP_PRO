import {describe,it,expect} from 'vitest';
import {safePatientContext,labContextFingerprint} from './aws-lab-analysis-api';
const context=()=>({ageYears:40,sex:'male',pregnancyStatus:'not_applicable',nursing:false,
  mainComplaint:null,complaintDuration:null,complaintSeverity:null as number|null,conditions:[],medications:[],allergies:[],topSymptomSignals:[],
  lifestyle:{sleepHours:7,sleepQuality:0,stressLevel:0,dietType:'omnivore',exerciseFrequency:0}});
describe('reported patient context',()=>{
  it('matches the mobile plan-context/1 canonical fixture',()=>{
    expect(labContextFingerprint(context())).toBe('d352732875dd2a3f9349f6d562a1f9e12486c4ddc2db08e37a352ccce6b5203f');
    expect(labContextFingerprint(Object.fromEntries(Object.entries(context()).reverse()))).toBe(labContextFingerprint(context()));
  });
  it.each([0,1,10,null])('preserves explicitly reported complaint severity %s',value=>{
    const input={...context(),complaintSeverity:value};expect(safePatientContext(input)).toEqual(input);
  });
  it.each([-1,11,1.5,NaN,Infinity])('refuses invalid severity %s',value=>expect(()=>safePatientContext({...context(),complaintSeverity:value})).toThrow());
  it.each(['sleepHours','sleepQuality','stressLevel','exerciseFrequency'])('refuses non-finite %s',key=>{
    const input=context();Reflect.set(input.lifestyle,key,NaN);expect(()=>safePatientContext(input)).toThrow();
  });
  it('rejects hidden fields rather than granting unreviewed context to the model',()=>{
    expect(()=>safePatientContext({...context(),lifestyle:{...context().lifestyle,hiddenDefault:true}})).toThrow();
    expect(()=>safePatientContext({...context(),topSymptomSignals:[{categoryId:'sleep',percentage:50,diagnosis:'unverified'}]})).toThrow();
  });
});
