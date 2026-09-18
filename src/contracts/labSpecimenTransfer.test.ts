import {describe,it,expect} from 'vitest';
import {labSpecimenTransferSchema,specimenContent} from './labSpecimenTransfer';
const id='10000000-0000-4000-8000-000000000001';
const fixture=()=>({version:'lab-specimen-context/1',connectionId:id,labEventId:id,labPayloadSha256:'a'.repeat(64),
 requestId:id,expectedRevision:0,consentVersion:1,reproductiveConsentVersion:null,
 context:{source:'patient_reported',verification:'unverified',recordedAt:'2026-01-03T00:00:00.000Z',observedOn:'2026-01-02',
 ageAtDraw:{value:35,unit:'years'},sex:'female',assayId:null,pregnancyStatus:null,cyclePhase:null,reproductiveStage:null,contraception:null,pregnancyTrimester:null}});
describe('versioned clinic specimen context contract',()=>{
 it('preserves nullable facts, completed age and unverified patient provenance',()=>{
  expect(labSpecimenTransferSchema.parse(fixture())).toEqual(fixture());
 });
 it('requires separate reproductive consent only when those dimensions are present',()=>{
  const p=fixture();
  expect(labSpecimenTransferSchema.safeParse({...p,context:{...p.context,cyclePhase:'luteal'}}).success).toBe(false);
  expect(labSpecimenTransferSchema.safeParse({...p,reproductiveConsentVersion:1}).success).toBe(false);
  expect(labSpecimenTransferSchema.safeParse({...p,reproductiveConsentVersion:1,context:{...p.context,cyclePhase:'luteal'}}).success).toBe(true);
 });
 it('rejects unknown fields, invalid dates, invented verification and contradictory context',()=>{
  const p=fixture();
  for(const context of [{...p.context,dateOfBirth:'1990-01-01'},{...p.context,verification:'verified'},
    {...p.context,observedOn:'2026-02-30'},{...p.context,ageAtDraw:{unit:'years',value:126}},
    {...p.context,pregnancyTrimester:2},{...p.context,email:'fictional@example.invalid'}]){
    expect(labSpecimenTransferSchema.safeParse({...p,context}).success).toBe(false);
  }
  expect(labSpecimenTransferSchema.safeParse({...p,containsPhi:false}).success).toBe(false);
 });
 it('freezes and canonicalizes property order without silently dropping data',()=>{
  const p=labSpecimenTransferSchema.parse(fixture()),q=Object.fromEntries(Object.entries(p).reverse());
  expect(specimenContent(labSpecimenTransferSchema.parse(q))).toBe(specimenContent(p));
  const frozen=labSpecimenTransferSchema.parse(p);p.context.ageAtDraw.value=1;
  expect(frozen.context.ageAtDraw.value).toBe(35);
 });
});

