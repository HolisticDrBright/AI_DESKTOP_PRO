import {describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {LAB_RESULT_TRANSFER_V2_ACCEPTED,labResultTransferV2,labTransferProvenanceView,legacyLabTransferProvenance} from './labResultTransfer';

/** The mirrored lab-result/2 contract. AI_LONGEVITY_PRO_V2 expo/__tests__/lab-result-transfer-contract.test.ts pins the
 * same digest, so a change on one side without the other fails both suites. */
const PIN='fc4ec19fc5b8bb06db6b11206906a5b4fa96b7041b591fd654f23f3a20f8cbcb';
const valid=()=>({schemaVersion:'lab-result/2',provider:'alp_patient_sync',providerEventId:'lab:'+'1'.repeat(32)+':'+'2'.repeat(16),
 connectionId:'44444444-4444-4444-8444-444444444444',resourceVersion:'f'.repeat(64),occurredAt:'2026-10-13T12:00:00.000Z',
 source:{system:'ai_longevity_pro_v2',recordType:'lab_panels',panelId:'panel_'+'1'.repeat(32),markerId:'marker_'+'2'.repeat(32)},
 panel:{name:'Fictional panel',collectedAt:'2026-10-01T09:00:00.000Z',sourceLabel:'Fictional upload'},
 result:{name:'Ferritin',value:80,unit:'ng/mL',referenceRange:{min:30,max:400}},
 provenance:{origin:'uploaded_report_analysis',documents:['d'.repeat(64)],reportedVerification:'analysis_cross_checked'}});
describe('lab-result/2 (mirrored contract)',()=>{
 it('is byte-identical to the pinned mirror and is not accepted',()=>{
  expect(createHash('sha256').update(readFileSync('src/contracts/labResultTransfer.ts')).digest('hex')).toBe(PIN);
  expect(LAB_RESULT_TRANSFER_V2_ACCEPTED).toBe(false);
 });
 it('carries provenance and nothing that could read as a laboratory flag or as verification',()=>{
  expect(labResultTransferV2.parse(valid())).toEqual(valid());
  const view=labTransferProvenanceView(labResultTransferV2.parse(valid()));
  expect(view).toEqual({contract:'lab-result/2',origin:'uploaded_report_analysis',documents:['d'.repeat(64)],
   reportedVerification:'analysis_cross_checked',verificationAtTransfer:'needs_human_review',appAssessment:null,laboratoryFlag:null});
 });
 const refusals:Record<string,(v:ReturnType<typeof valid>)=>void>={
  'an app or analyzer status':v=>Object.assign(v.result,{sourceStatus:'critical'}),
  'a status':v=>Object.assign(v.result,{status:'high'}),
  'a flag':v=>Object.assign(v.result,{flag:'H'}),
  'a verified boolean on the result':v=>Object.assign(v.result,{verified:true}),
  'a verified boolean in the provenance':v=>Object.assign(v.provenance,{verified:true}),
  'a verification state chosen by the client':v=>Object.assign(v.provenance,{verification:'independently_verified'}),
  'an uploaded report without its document':v=>{v.provenance.documents=[];},
  'an owner-entered reading claiming a document':v=>{v.provenance.origin='owner_entered';},
  'a repeated document':v=>{v.provenance.documents=['d'.repeat(64),'d'.repeat(64)];},
  'an uppercase digest':v=>{v.provenance.documents=['D'.repeat(64)];},
  'an inverted range':v=>{v.result.referenceRange={min:400,max:30};},
  'the legacy version':v=>{(v as {schemaVersion:string}).schemaVersion='lab-result/1';},
  'an unknown origin':v=>{(v.provenance as {origin:string}).origin='laboratory_interface';},
 };
 for(const [name,change] of Object.entries(refusals))it('refuses '+name,()=>{
  const v=valid();change(v);expect(labResultTransferV2.safeParse(v).success).toBe(false);
 });
 it('a legacy /1 reading stays readable: unverified, no document, and its status named as the app’s assessment',()=>{
  expect(legacyLabTransferProvenance('critical')).toEqual({contract:'lab-result/1',origin:'not_recorded',documents:[],
   reportedVerification:'not_recorded',verificationAtTransfer:'needs_human_review',appAssessment:'critical',laboratoryFlag:null});
  expect(legacyLabTransferProvenance(undefined).appAssessment).toBeNull();
  expect(legacyLabTransferProvenance('  ').appAssessment).toBeNull();
 });
});
