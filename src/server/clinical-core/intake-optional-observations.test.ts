import {expect,it} from 'vitest';
import {validateCollectionPayload,canonicalPayload} from './aws-consumer-clinical-records';
const intake={id:'synthetic-intake',chiefComplaint:{description:'Synthetic concern'},associatedSymptoms:[],
  createdAt:'2026-09-15T00:00:00Z',updatedAt:'2026-09-15T00:00:00Z'};
it('accepts an intake with unasked observations absent, without supplying defaults',()=>{
  const original=structuredClone(intake);validateCollectionPayload('clinical_intakes',intake);
  expect(intake).toEqual(original);expect(JSON.parse(canonicalPayload(intake))).not.toHaveProperty('energyLevel');
  expect(intake).not.toHaveProperty('temperatureSensitivity');
});
it('still accepts explicit observations and rejects absent required sections or unrelated fields',()=>{
  expect(()=>validateCollectionPayload('clinical_intakes',{...intake,energyLevel:0,temperatureSensitivity:'cold'})).not.toThrow();
  const missing:Record<string,unknown>={...intake};delete missing.chiefComplaint;
  expect(()=>validateCollectionPayload('clinical_intakes',missing)).toThrow();
  expect(()=>validateCollectionPayload('clinical_intakes',{...intake,assumeNormal:true})).toThrow();
});
