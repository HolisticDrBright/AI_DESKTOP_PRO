import {describe,it,expect} from 'vitest';
import {parseProgramAssignmentResponse} from './programAssignments';

const enrollmentId='11111111-1111-4111-8111-111111111111';
const programVersionId='22222222-2222-4222-8222-222222222222';
const connectionId='33333333-3333-4333-8333-333333333333';
const when='2026-10-08T12:00:00Z';
const readInput={action:'read' as const,enrollmentId};
function fixture(){
 return {action:'read',assignment:{enrollmentId,title:'Fictional guide',state:'active',revision:'2',
  sourceDigest:'a'.repeat(64),programVersion:'1',phaseIndex:0,finished:false,startedAt:when,phaseStartedAt:when,
  phases:[{id:'phase-a',title:'Fictional phase',days:7,transition:'scheduled',items:[
   {id:'lesson-a',title:'Fictional lesson',kind:'lesson',instructions:'Fictional education',released:true},
   {id:'product-a',title:'Fictional product',kind:'supplement',instructions:'Fictional reviewed instruction',released:true,
    product:{id:'prd_fictional',ingredientKeys:['fictional-mineral'],dose:'Fictional reviewed dose',purchaseUrl:'https://shop.example.test/product'}}]}]},
  completed:[] as string[],review:{planRevision:'fictional-1',inventoryComplete:false,
   add:['lesson-a'],duplicate:[] as string[],held:['product-a'],conflicts:[] as string[]},
  authorizations:[] as {phaseId:string;kind:string}[]};
}
describe('program response integrity with fictional content only',()=>{
 it('accepts the actual exhaustive held review and a complete approved inventory',()=>{
  expect(parseProgramAssignmentResponse(readInput,fixture()).action).toBe('read');
  const approved=fixture();approved.review.inventoryComplete=true;approved.review.held=[];approved.review.add.push('product-a');
  expect(parseProgramAssignmentResponse(readInput,approved).action).toBe('read');
 });
 const invalid:Record<string,(value:ReturnType<typeof fixture>)=>void>={
  'duplicate phase identities':v=>{v.assignment.phases.push(structuredClone(v.assignment.phases[0]!));},
  'duplicate item identities':v=>{v.assignment.phases[0]!.items.push(structuredClone(v.assignment.phases[0]!.items[0]!));},
  'normalized duplicate ingredients':v=>{v.assignment.phases[0]!.items[1]!.product!.ingredientKeys=['fictional-mineral','FICTIONAL-MINERAL'];},
  'credential-bearing purchase link':v=>{v.assignment.phases[0]!.items[1]!.product!.purchaseUrl='https://user:secret@shop.example.test/product';},
  'oversize purchase link':v=>{v.assignment.phases[0]!.items[1]!.product!.purchaseUrl='https://shop.example.test/'+ 'x'.repeat(2048);},
  'unknown reviewed step':v=>{v.review.add.push('invented-step');},
  'omitted reviewed step':v=>{v.review.add=[];},
  'duplicate reviewed step':v=>{v.review.add.push('lesson-a');},
  'contradictory review decisions':v=>{v.review.held.push('lesson-a');},
  'unreleased lesson listed as available':v=>{v.assignment.phases[0]!.items[0]!.released=false;},
  'unknown inventory releasing a supplement':v=>{v.review.held=[];v.review.add.push('product-a');},
  'lesson treated as duplicate supplement':v=>{v.review.add=[];v.review.duplicate.push('lesson-a');},
  'unknown completed step':v=>{v.completed=['invented-step'];},
  'duplicate completions':v=>{v.completed=['lesson-a','lesson-a'];},
  'authorization for absent phase':v=>{v.authorizations=[{phaseId:'absent',kind:'consumer_check_in'}];},
  'duplicate phase authorization':v=>{v.authorizations=[{phaseId:'phase-a',kind:'consumer_check_in'},{phaseId:'phase-a',kind:'consumer_check_in'}];},
  'phase beyond the actual guide':v=>{v.assignment.phaseIndex=1;},
  'finished paused assignment':v=>{v.assignment.finished=true;v.assignment.state='paused';},
  'active assignment without its start':v=>{Object.assign(v.assignment,{startedAt:null});},
 };
 for(const [name,change]of Object.entries(invalid))it('refuses '+name,()=>{
  const value=fixture();change(value);expect(()=>parseProgramAssignmentResponse(readInput,value)).toThrow();
 });
 it('applies the same truthful review checks to practitioner previews',()=>{
  const v=fixture(),preview={action:'preview',programVersionId,programVersion:'1',title:'Fictional guide',
   phases:v.assignment.phases,sourceDigest:'a'.repeat(64),review:v.review};
  expect(parseProgramAssignmentResponse({action:'preview',programVersionId},preview).action).toBe('preview');
  preview.review.add.push('invented-step');
  expect(()=>parseProgramAssignmentResponse({action:'preview',programVersionId},preview)).toThrow();
 });
 it('binds completion and phase-release receipts to the exact requested step',()=>{
  expect(()=>parseProgramAssignmentResponse({action:'complete',enrollmentId,sourceDigest:'a'.repeat(64),expectedRevision:'2',itemId:'lesson-a'},
   {action:'complete',enrollmentId,revision:'3',itemId:'other'})).toThrow();
  expect(()=>parseProgramAssignmentResponse({action:'release',enrollmentId,phaseId:'phase-a'},
   {action:'release',enrollmentId,phaseId:'other'})).toThrow();
 });
 it('does not accept a pause, withdrawal or acceptance with the opposite state',()=>{
  const owned={enrollmentId,sourceDigest:'a'.repeat(64),expectedRevision:'2'};
  expect(()=>parseProgramAssignmentResponse({action:'accept',...owned,planRevision:'fictional-1'},
   {action:'accept',enrollmentId,revision:'3',state:'paused',duplicate:false})).toThrow();
  expect(()=>parseProgramAssignmentResponse({action:'pause',...owned},{action:'pause',enrollmentId,revision:'3',state:'active'})).toThrow();
  expect(()=>parseProgramAssignmentResponse({action:'withdraw',...owned},{action:'withdraw',enrollmentId,revision:'3',state:'active'})).toThrow();
 });
 it('refuses an assignment status for a different requested connection',()=>{
  const row={enrollmentId,title:'Fictional guide',state:'active',revision:'2',
   patientRecordId:'44444444-4444-4444-8444-444444444444',connectionId,phaseIndex:0,phaseCount:1,
   finished:false,completedCount:0,assignedAt:when,updatedAt:when};
  expect(parseProgramAssignmentResponse({action:'status',connectionId},{action:'status',assignments:[row]}).action).toBe('status');
  expect(()=>parseProgramAssignmentResponse({action:'status',connectionId},{action:'status',assignments:[{...row,connectionId:enrollmentId}]})).toThrow();
  expect(()=>parseProgramAssignmentResponse({action:'status'},{action:'status',assignments:[row,row]})).toThrow();
 });
 it('refuses duplicate linked-patient identities and impossible program availability',()=>{
  const row={connectionId,patientRecordId:enrollmentId,verifiedAt:when};
  expect(()=>parseProgramAssignmentResponse({action:'connections'},{action:'connections',connections:[row,row]})).toThrow();
  const program={programVersionId,programId:enrollmentId,programVersion:'1',programName:'Fictional',title:'Fictional',phaseCount:0,assignable:true,publishedAt:when};
  expect(()=>parseProgramAssignmentResponse({action:'programs'},{action:'programs',programs:[program]})).toThrow();
 });
});
