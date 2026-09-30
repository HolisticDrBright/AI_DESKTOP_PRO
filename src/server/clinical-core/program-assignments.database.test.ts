import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {programAssignmentResponse,type ProgramAssignmentRequest} from '../../contracts/programAssignments';
import {createProgramAssignments} from './program-assignments';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {SyntheticRequestContext} from './aws-identity-consent';

const id=(n:number)=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),otherOrg=id(2),owner=id(3),other=id(4),clinician=id(5),outside=id(6);
const patient=id(7),connection=id(8),program=id(9),published=id(10),draft=id(11);
let db:PGlite,serial=100;
const context=(actor=owner,organization=org,pool:'consumer'|'workforce'='consumer'):SyntheticRequestContext=>({
 actorPersonId:actor,organizationId:organization,identityPool:pool,identitySubject:'subject-'+actor,
 purpose:'clinical_data',environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,realPatientData:false});
// Mirror the deployed driver, which classifies by the SQL error name rather than by
// SQLSTATE. A harness that collapsed everything to one category would report an
// invalid request as an authorization refusal and hide exactly that mistake.
const REQUEST_INVALID=/\bprogram_assignment_invalid\b/;
const REFUSED=/\b(program_assignment_refused|program_assignment_unpublished|program_item_held|program_assignment_immutable)\b/;
const CONFLICT=/\b(program_assignment_conflict|program_assignment_version_changed|program_assignment_revision_stale|program_review_stale|program_assignment_state_invalid|program_tasks_remaining|program_phase_not_due|program_check_in_required|program_practitioner_review_required|program_clinical_items_held)\b/;
function classify(cause:unknown):'request_invalid'|'operation_refused'|'conflict'{
 const message=cause instanceof Error?cause.message:String(cause);
 return REQUEST_INVALID.test(message)?'request_invalid':CONFLICT.test(message)?'conflict':REFUSED.test(message)?'operation_refused':'operation_refused';
}
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role clinical_core_api');
 return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
  try{return await tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p));}
  catch(cause){throw new ClinicalCoreDatabaseRejection(classify(cause));}
 }});
})};
const call=(input:ProgramAssignmentRequest,actor=owner,organization=org,pool:'consumer'|'workforce'='consumer')=>
 createProgramAssignments(database)(context(actor,organization,pool),input);

const lesson=(suffix:string)=>({id:'lesson-'+suffix,title:'Fictional lesson '+suffix,kind:'lesson' as const,
 instructions:'Read the fictional lesson.',released:true});
const supplementItem=()=>({id:'supp-1',title:'Fictional supplement step',kind:'supplement' as const,
 instructions:'Fictional instruction.',released:true,
 product:{id:'product-fictional-1',ingredientKeys:['fictional-mineral'],dose:'100 mg',purchaseUrl:null}});
const phases=(over:{transition?:'scheduled'|'check_in'|'practitioner';extra?:unknown[]}={})=>[
 {id:'phase-1',title:'Phase one',days:1,transition:over.transition??'scheduled',items:[lesson('a'),...(over.extra??[])]},
 {id:'phase-2',title:'Phase two',days:1,transition:'scheduled' as const,items:[lesson('b')]},
] as ProgramAssignmentRequest extends never?never:never[]as never;

async function assign(content:unknown,versionId=published,actor=clinician){
 return call({action:'assign',connectionId:connection,programVersionId:versionId,
  title:'Fictional thyroid guide',phases:content as never},actor,org,'workforce');
}
async function readOwn(enrollmentId:string,actor=owner){
 const result=await call({action:'read',enrollmentId},actor);
 if(result.action!=='read')throw Error();return result;
}

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional A'),($2,'Fictional B')",[org,otherOrg]);
 for(const [person,pool] of [[owner,'consumer'],[other,'consumer'],[clinician,'workforce'],[outside,'workforce']]){
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[person,'syn_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)',[person,pool,'subject-'+person]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($3,$4,'practitioner')",[org,clinician,otherOrg,outside]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_programs_01')",[patient,org]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",[connection,org,patient,owner]);
 await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional thyroid program','published',$3)",[program,org,clinician]);
 await db.query("insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,created_by_person_id) values($1,$2,$3,1,'published',$4),($5,$2,$3,2,'draft',$4)",
  [published,org,program,clinician,draft]);
},60000);
afterAll(async()=>{await db?.close();});

async function fresh(content:unknown=phases()){
 // One live assignment per (connection, version), so each case needs its own version.
 const version=id(++serial);
 await db.query("insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,created_by_person_id) values($1,$2,$3,$4,'published',$5)",
  [version,org,program,serial,clinician]);
 const assigned=await assign(content,version);
 if(assigned.action!=='assign')throw Error();
 return assigned;
}

describe('program assignment service: real adapter and PostgreSQL, not hosted AWS',()=>{
 it('carries a published version through assignment, review, tasks, check-in and clinic status',async()=>{
  const assigned=await fresh(phases({transition:'check_in'}));
  expect(assigned).toMatchObject({action:'assign',state:'offered',revision:'1',duplicate:false});
  const offered=await readOwn(assigned.enrollmentId);
  expect(offered.assignment).toMatchObject({state:'offered',phaseIndex:0,finished:false,startedAt:null});
  // The pinned program version travels with the artifact, so a screen can name it.
  expect(offered.assignment.programVersion).toMatch(/^[0-9]+$/);
  expect(offered.review).toMatchObject({add:['lesson-a','lesson-b'],duplicate:[],held:[],conflicts:[],inventoryComplete:false});
  expect(programAssignmentResponse.safeParse(offered).success).toBe(true);
  const owned={enrollmentId:assigned.enrollmentId,sourceDigest:assigned.sourceDigest};
  const accepted=await call({action:'accept',...owned,expectedRevision:'1',planRevision:offered.review.planRevision});
  expect(accepted).toMatchObject({action:'accept',state:'active',revision:'2',duplicate:false});
  const done=await call({action:'complete',...owned,expectedRevision:'2',itemId:'lesson-a'});
  expect(done).toMatchObject({action:'complete',itemId:'lesson-a',revision:'3'});
  const checked=await call({action:'check_in',...owned,expectedRevision:'3'});
  expect(checked).toMatchObject({action:'check_in',phaseId:'phase-1',revision:'4'});
  const started=await readOwn(assigned.enrollmentId);
  expect(started.completed).toEqual(['lesson-a']);
  expect(started.authorizations).toEqual([{phaseId:'phase-1',kind:'consumer_check_in'}]);
  const status=await call({action:'status',connectionId:connection},clinician,org,'workforce');
  expect(status).toMatchObject({action:'status'});
  if(status.action!=='status')throw Error();
  expect(status.assignments.find(a=>a.enrollmentId===assigned.enrollmentId))
   .toMatchObject({state:'active',phaseIndex:0,phaseCount:2,completedCount:1,finished:false,
    patientRecordId:patient,connectionId:connection});
  // A panel works at clinic scope, so no selector means the whole clinic.
  const clinicWide=await call({action:'status'},clinician,org,'workforce');
  if(clinicWide.action!=='status')throw Error();
  expect(clinicWide.assignments.map(a=>a.enrollmentId)).toContain(assigned.enrollmentId);
  // And the panel can name a patient from the links the workforce already sees.
  const links=await call({action:'connections'},clinician,org,'workforce');
  if(links.action!=='connections')throw Error();
  expect(links.connections).toEqual(expect.arrayContaining([
   expect.objectContaining({connectionId:connection,patientRecordId:patient})]));
  // Neither is reachable from a consumer, and neither leaks another clinic's links.
  await expect(call({action:'connections'},owner)).rejects.toMatchObject({category:'identity_refused'});
  const foreign=await call({action:'connections'},outside,otherOrg,'workforce');
  if(foreign.action!=='connections')throw Error();
  expect(foreign.connections).toEqual([]);
 });
 it('advances only on the server clock, and only once the phase gate is satisfied',async()=>{
  const assigned=await fresh(phases({transition:'check_in'}));
  const owned={enrollmentId:assigned.enrollmentId,sourceDigest:assigned.sourceDigest};
  await call({action:'accept',...owned,expectedRevision:'1',planRevision:(await readOwn(assigned.enrollmentId)).review.planRevision});
  await expect(call({action:'advance',...owned,expectedRevision:'2'})).rejects.toMatchObject({category:'conflict'});
  await call({action:'complete',...owned,expectedRevision:'2',itemId:'lesson-a'});
  // Tasks done, but the phase has not elapsed and the check-in has not happened.
  await expect(call({action:'advance',...owned,expectedRevision:'3'})).rejects.toMatchObject({category:'conflict'});
  await db.query("update clinical_core.program_assignments set phase_started_at=phase_started_at-interval '2 days',revision=revision+1 where id=$1",[assigned.enrollmentId]);
  await expect(call({action:'advance',...owned,expectedRevision:'4'})).rejects.toMatchObject({category:'conflict'});
  await call({action:'check_in',...owned,expectedRevision:'4'});
  const advanced=await call({action:'advance',...owned,expectedRevision:'5'});
  expect(advanced).toMatchObject({action:'advance',phaseIndex:1,finished:false});
  const second=await readOwn(assigned.enrollmentId);
  expect(second.assignment.phaseIndex).toBe(1);
  // The new phase starts from the server's clock, not the old phase's start.
  expect(Date.parse(second.assignment.phaseStartedAt!)).toBeGreaterThan(Date.parse(second.assignment.startedAt!));
 });
 it('requires a practitioner release for a practitioner phase and refuses a self-granted one',async()=>{
  const assigned=await fresh(phases({transition:'practitioner'}));
  const owned={enrollmentId:assigned.enrollmentId,sourceDigest:assigned.sourceDigest};
  await call({action:'accept',...owned,expectedRevision:'1',planRevision:(await readOwn(assigned.enrollmentId)).review.planRevision});
  await call({action:'complete',...owned,expectedRevision:'2',itemId:'lesson-a'});
  await db.query("update clinical_core.program_assignments set phase_started_at=phase_started_at-interval '2 days',revision=revision+1 where id=$1",[assigned.enrollmentId]);
  // A consumer check-in is not a practitioner release, however it is recorded.
  await call({action:'check_in',...owned,expectedRevision:'4'});
  await expect(call({action:'advance',...owned,expectedRevision:'5'})).rejects.toMatchObject({category:'conflict'});
  await expect(call({action:'release',enrollmentId:assigned.enrollmentId,phaseId:'phase-1'})).rejects.toMatchObject({category:'identity_refused'});
  await call({action:'release',enrollmentId:assigned.enrollmentId,phaseId:'phase-1'},clinician,org,'workforce');
  expect(await call({action:'advance',...owned,expectedRevision:'5'})).toMatchObject({action:'advance',phaseIndex:1});
 });
 it('holds every supplement step while governed ingredients cannot be resolved, and will not advance past one',async()=>{
  const assigned=await fresh(phases({extra:[supplementItem()]}));
  const owned={enrollmentId:assigned.enrollmentId,sourceDigest:assigned.sourceDigest};
  const offered=await readOwn(assigned.enrollmentId);
  expect(offered.review).toMatchObject({inventoryComplete:false,held:['supp-1'],add:['lesson-a','lesson-b']});
  await call({action:'accept',...owned,expectedRevision:'1',planRevision:offered.review.planRevision});
  // A held item is not completable, and its phase does not advance. This mirrors the
  // consumer model rather than softening it, so a guide carrying a supplement cannot
  // progress until the inventory can be resolved.
  await expect(call({action:'complete',...owned,expectedRevision:'2',itemId:'supp-1'})).rejects.toMatchObject({category:'identity_refused'});
  await call({action:'complete',...owned,expectedRevision:'2',itemId:'lesson-a'});
  await db.query("update clinical_core.program_assignments set phase_started_at=phase_started_at-interval '2 days',revision=revision+1 where id=$1",[assigned.enrollmentId]);
  await expect(call({action:'advance',...owned,expectedRevision:'4'})).rejects.toMatchObject({category:'conflict'});
 });
 it('refuses a draft version, another clinic, and content the contract rejects',async()=>{
  await expect(assign(phases(),draft)).rejects.toMatchObject({category:'identity_refused'});
  await expect(assign(phases(),published,outside)).rejects.toMatchObject({category:'identity_refused'});
  await expect(call({action:'assign',connectionId:connection,programVersionId:published,title:'Fictional',
   phases:phases()},owner,org,'consumer')).rejects.toMatchObject({category:'identity_refused'});
  for(const bad of [
   [], // no phases
   [{id:'phase-1',title:'Phase',days:0,transition:'scheduled',items:[]}],
   [{id:'phase-1',title:'Phase',days:1,transition:'whenever',items:[]}],
   [{id:'phase-1',title:'Phase',days:1,transition:'scheduled',items:[{...lesson('a'),product:{id:'p',ingredientKeys:['k'],dose:'1',purchaseUrl:null}}]}],
   [{id:'phase-1',title:'Phase',days:1,transition:'scheduled',items:[{...supplementItem(),product:undefined}]}],
   [{id:'phase-1',title:'Phase',days:1,transition:'scheduled',items:[{...supplementItem(),product:{...supplementItem().product,purchaseUrl:'http://insecure.example.com'}}]}],
   [{id:'phase-1',title:'Phase',days:1,transition:'scheduled',items:[lesson('a'),lesson('a')]}],
  ])await expect(assign(bad)).rejects.toMatchObject({category:'request_invalid'});
 });
 it('lets only the owner act, and never another patient or clinic',async()=>{
  const assigned=await fresh();
  const owned={enrollmentId:assigned.enrollmentId,sourceDigest:assigned.sourceDigest};
  for(const [actor,organization] of [[other,org],[owner,otherOrg]] as const){
   await expect(call({action:'read',enrollmentId:assigned.enrollmentId},actor,organization)).rejects.toMatchObject({category:'identity_refused'});
   await expect(call({action:'accept',...owned,expectedRevision:'1',planRevision:'none'},actor,organization)).rejects.toMatchObject({category:'identity_refused'});
  }
  expect(await call({action:'list'},other)).toMatchObject({action:'list',assignments:[]});
 });
 it('applies one of two competing devices and tells the loser its state is stale',async()=>{
  const assigned=await fresh();
  const owned={enrollmentId:assigned.enrollmentId,sourceDigest:assigned.sourceDigest};
  const planRevision=(await readOwn(assigned.enrollmentId)).review.planRevision;
  expect(await call({action:'accept',...owned,expectedRevision:'1',planRevision})).toMatchObject({duplicate:false});
  // The second device replays the same revision it last saw.
  await expect(call({action:'accept',...owned,expectedRevision:'1',planRevision})).rejects.toMatchObject({category:'conflict'});
  // Re-reading, it learns the assignment is already accepted rather than failing.
  expect(await call({action:'accept',...owned,expectedRevision:'2',planRevision})).toMatchObject({state:'active',duplicate:true});
  await expect(call({action:'complete',...owned,expectedRevision:'2',itemId:'lesson-a'})).resolves.toMatchObject({revision:'3'});
  await expect(call({action:'complete',...owned,expectedRevision:'2',itemId:'lesson-a'})).rejects.toMatchObject({category:'conflict'});
 });
 it('refuses a review the owner saw against a plan that has since moved',async()=>{
  const assigned=await fresh();
  const owned={enrollmentId:assigned.enrollmentId,sourceDigest:assigned.sourceDigest};
  await expect(call({action:'accept',...owned,expectedRevision:'1',planRevision:'a-plan-revision-that-is-not-current'}))
   .rejects.toMatchObject({category:'conflict'});
  // And a digest that is not this artifact is refused before the revision is read.
  await expect(call({action:'accept',enrollmentId:assigned.enrollmentId,sourceDigest:'f'.repeat(64),
   expectedRevision:'1',planRevision:'none'})).rejects.toMatchObject({category:'conflict'});
 });
 it('pauses, resumes and withdraws without touching the clinical record',async()=>{
  const assigned=await fresh();
  const owned={enrollmentId:assigned.enrollmentId,sourceDigest:assigned.sourceDigest};
  await call({action:'accept',...owned,expectedRevision:'1',planRevision:(await readOwn(assigned.enrollmentId)).review.planRevision});
  expect(await call({action:'pause',...owned,expectedRevision:'2'})).toMatchObject({state:'paused'});
  await expect(call({action:'complete',...owned,expectedRevision:'3',itemId:'lesson-a'})).rejects.toMatchObject({category:'conflict'});
  expect(await call({action:'resume',...owned,expectedRevision:'3'})).toMatchObject({state:'active'});
  expect(await call({action:'withdraw',...owned,expectedRevision:'4'})).toMatchObject({state:'withdrawn'});
  // Withdrawal removes the guide from the owner's list and refuses further action.
  const list=await call({action:'list'});
  if(list.action!=='list')throw Error();
  expect(list.assignments.map(a=>a.enrollmentId)).not.toContain(assigned.enrollmentId);
  await expect(call({action:'resume',...owned,expectedRevision:'5'})).rejects.toMatchObject({category:'conflict'});
  // The clinic still sees it, and the patient's own records were never involved.
  const status=await call({action:'status',connectionId:connection},clinician,org,'workforce');
  if(status.action!=='status')throw Error();
  expect(status.assignments.find(a=>a.enrollmentId===assigned.enrollmentId)).toMatchObject({state:'withdrawn'});
  expect((await db.query('select count(*)::int as n from clinical_core.consumer_clinical_record_versions')).rows[0]).toEqual({n:0});
 });
 it('refuses to re-pin different content under the same published version',async()=>{
  const assigned=await fresh();
  const same=await db.query<{program_version_id:string}>('select program_version_id from clinical_core.program_assignments where id=$1',[assigned.enrollmentId]);
  const versionId=same.rows[0]!.program_version_id;
  expect(await assign(phases(),versionId)).toMatchObject({enrollmentId:assigned.enrollmentId,duplicate:true});
  await expect(assign(phases({extra:[lesson('c')]}),versionId)).rejects.toMatchObject({category:'conflict'});
 });
 it('keeps the pinned artifact immutable and the tables sealed',async()=>{
  const assigned=await fresh();
  await expect(db.query("update clinical_core.program_assignments set title='Changed' where id=$1",[assigned.enrollmentId])).rejects.toThrow('program_assignment_immutable');
  await expect(db.query("update clinical_core.program_assignments set content='[]'::jsonb,revision=revision+1 where id=$1",[assigned.enrollmentId])).rejects.toThrow('program_assignment_immutable');
  await expect(db.query("update clinical_core.program_assignments set revision=revision-1 where id=$1",[assigned.enrollmentId])).rejects.toThrow('program_assignment_immutable');
  await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');
   await tx.query('select * from clinical_core.program_assignments');})).rejects.toThrow('permission denied');
  await expect(db.exec('delete from clinical_core.program_assignment_audit')).rejects.toThrow();
  const audit=await db.query('select * from clinical_core.program_assignment_audit limit 1');
  expect(audit.rows[0]).not.toHaveProperty('content');expect(audit.rows[0]).not.toHaveProperty('title');
 });
 it('refuses production and a missing enrollment before touching the database',async()=>{
  await expect(createProgramAssignments({transaction:()=>{throw Error('must not run');}})(
   {...context(),environment:'production'} as unknown as SyntheticRequestContext,{action:'list'})).rejects.toMatchObject({category:'identity_refused'});
  await expect(call({action:'read',enrollmentId:id(++serial)})).rejects.toMatchObject({category:'identity_refused'});
 });
 it('computes the overlap review from an inventory, independently of what this target can resolve',async()=>{
  // The algorithm is exercised directly, because the inventory source in this
  // database cannot yet resolve governed ingredients and would hold everything.
  const content=JSON.stringify([{id:'phase-1',title:'Phase',days:1,transition:'scheduled',
   items:[supplementItem(),{...supplementItem(),id:'supp-2',product:{id:'product-fictional-2',ingredientKeys:['other-mineral'],dose:'5 mg',purchaseUrl:null}},
    {...lesson('a'),released:false}]}]);
  const review=async(products:unknown[])=>{
   const result=await db.query<{data:Record<string,unknown>}>('select clinical_private.program_review($1::jsonb,$2::jsonb) as data',
    [content,JSON.stringify({revision:'plan-1',inventoryComplete:true,products})]);
   return result.rows[0]!.data;
  };
  expect(await review([])).toMatchObject({add:['supp-1','supp-2'],duplicate:[],conflicts:[],held:['lesson-a']});
  expect(await review([{productId:'product-fictional-1',ingredientKeys:['fictional-mineral'],dose:'100 mg'}]))
   .toMatchObject({duplicate:['supp-1'],add:['supp-2'],conflicts:[]});
  expect(await review([{productId:'product-fictional-1',ingredientKeys:['fictional-mineral'],dose:'200 mg'}]))
   .toMatchObject({conflicts:['supp-1'],add:['supp-2'],duplicate:[]});
  expect(await review([{productId:'product-other',ingredientKeys:['fictional-mineral'],dose:'100 mg'}]))
   .toMatchObject({conflicts:['supp-1'],add:['supp-2'],duplicate:[]});
  // And the inventory this target actually produces refuses to guess.
  const inventory=await db.query<{data:Record<string,unknown>}>('select clinical_private.program_plan_inventory($1) as data',[connection]);
  expect(inventory.rows[0]!.data).toMatchObject({inventoryComplete:false,products:[],
   incompleteReason:'governed_ingredients_unavailable_in_target'});
 });
});
