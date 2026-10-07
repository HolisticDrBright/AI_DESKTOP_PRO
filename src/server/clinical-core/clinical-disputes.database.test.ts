import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

/**
 * A contestable record, and a delivered record that can be corrected after delivery.
 *
 * The assertions that carry weight are the ones about what does NOT happen. A dispute the
 * clinician upholds must still be visible on the item, because a disagreement that disappears
 * when it is rejected is a suggestion box. A clinician's answer must not be rewritable, or the
 * record of the decision is worth nothing. And a revision must not mutate what a patient is
 * already holding, because changing someone's protocol without anyone deciding to is the
 * failure this whole feature exists to prevent.
 */
const id=(n:number)=>'a0000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),clinician=id(2),owner=id(3),other=id(4);
const patient=id(5),connection=id(6),otherPatient=id(7),otherConnection=id(8);
const program=id(9),v1=id(10),v2=id(11),draft=id(12);
let db:PGlite;
type Json={[key:string]:unknown};

const purposeFor=(fn:string)=>fn.startsWith('care_data')?'consent_management':'clinical_data';
async function rpc(fn:string,request:unknown,actor=owner,pool:'workforce'|'consumer'='consumer'){
 const erased=fn==='care_data_erase';
 if(erased){fn='care_data_erasure_request';request={...(request as Record<string,unknown>),action:'erase_request',requestId:randomUUID()};}
 return db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
   [actor,org,pool,'subject-'+actor,purposeFor(fn),'synthetic-staging','synthetic_only']);
  const {rows}=await tx.query<{data:Json}>(`select clinical_core.${fn}($1::jsonb) as data`,
   [JSON.stringify(request)]);
  return erased?rows[0].data.receipt as Record<string,unknown>:rows[0].data;
 });
}
const asClinic=(fn:string,request:unknown)=>rpc(fn,request,clinician,'workforce');
const message=async(work:Promise<unknown>)=>{
 try{await work;return 'resolved';}catch(cause){return cause instanceof Error?cause.message:String(cause);}
};

const lesson=(suffix:string,instructions='Read the fictional lesson.')=>({
 id:'lesson-'+suffix,title:'Fictional lesson '+suffix,kind:'lesson',instructions,released:true});
const phases=(items:unknown[])=>[
 {id:'phase-1',title:'Phase one',days:1,transition:'scheduled',items},
];
const versionContent=(items:unknown[])=>JSON.stringify({
 consumerProgram:{title:'Fictional thyroid guide',phases:phases(items)}});

/** An assignment of v1, made the way the service makes one. */
async function assign(connectionId=connection){
 const assigned=await asClinic('program_assignment_request',
  {action:'assign',connectionId,programVersionId:v1});
 return assigned.enrollmentId as string;
}

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional Longevity Clinic')",[org]);
 for(const [person,pool] of [[clinician,'workforce'],[owner,'consumer'],[other,'consumer']]){
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[person,'syn_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)',[person,pool,'subject-'+person]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,clinician]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_dispute_001'),($3,$2,'patient_syn_dispute_002')",
  [patient,org,otherPatient]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now()),($5,$2,$6,$7,'verified',now())",
  [connection,org,patient,owner,otherConnection,otherPatient,other]);
 await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional thyroid program','published',$3)",[program,org,clinician]);
 // v1 carries two lessons; v2 drops one, changes one and adds one, so the counts have
 // something real to report.
 await db.query(`insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id)
  values($1,$2,$3,1,'published',$4::jsonb,$5),($6,$2,$3,2,'published',$7::jsonb,$5),($8,$2,$3,3,'draft',$7::jsonb,$5)`,
  [v1,org,program,versionContent([lesson('a'),lesson('b')]),clinician,
   v2,versionContent([lesson('a','Read the revised fictional lesson.'),lesson('c')]),draft]);
},90000);
afterAll(async()=>{await db?.close();});

beforeEach(async()=>{
 await db.exec("set session_replication_role = 'replica'");
 for(const table of ['clinical_dispute_statements','clinical_disputes','content_revision_notices',
  'program_assignment_completions','program_phase_authorizations','program_assignments','care_data_erasures']){
  await db.query('delete from clinical_core.'+table);
 }
 await db.exec("set session_replication_role = 'origin'");
});

describe('contesting a record: real migration SQL, not hosted AWS',()=>{
 it('carries a dispute from the patient to the clinic and back with an answer',async()=>{
  const enrollment=await assign();
  const raised=await rpc('clinical_dispute_consumer',{action:'raise',
   subjectKind:'program_assignment',subjectId:enrollment,reasonCode:'disagree_with_conclusion',
   statement:'I have never had a thyroid problem and this guide assumes I do.'});
  expect(raised).toMatchObject({action:'raise',status:'open'});

  const queue=await asClinic('clinical_dispute_workforce',{action:'list',status:'open'});
  const entry=(queue.disputes as Json[])[0];
  expect(entry).toMatchObject({subjectKind:'program_assignment',subjectId:enrollment,
   reasonCode:'disagree_with_conclusion',status:'open'});
  expect((entry.statements as Json[])[0].body).toContain('never had a thyroid problem');

  const acknowledged=await asClinic('clinical_dispute_workforce',{action:'acknowledge',
   disputeId:entry.disputeId,expectedRevision:entry.revision});
  expect(acknowledged).toMatchObject({status:'acknowledged'});
  const resolved=await asClinic('clinical_dispute_workforce',{action:'resolve',
   disputeId:entry.disputeId,expectedRevision:acknowledged.revision,resolution:'corrected',
   clinicianResponse:'You are right — the guide was assigned in error and has been withdrawn.'});
  expect(resolved).toMatchObject({status:'resolved',resolution:'corrected'});

  const mine=await rpc('clinical_dispute_consumer',{action:'list'});
  expect((mine.disputes as Json[])[0]).toMatchObject({status:'resolved',resolution:'corrected',
   clinicianResponse:'You are right — the guide was assigned in error and has been withdrawn.'});
 });

 it('keeps an upheld disagreement attached to the item instead of closing it away',async()=>{
  const enrollment=await assign();
  await rpc('clinical_dispute_consumer',{action:'raise',subjectKind:'program_assignment',subjectId:enrollment,reasonCode:'not_true_of_me',
   statement:'This is not right about me.'});
  const queue=await asClinic('clinical_dispute_workforce',{action:'list'});
  const entry=(queue.disputes as Json[])[0];
  await asClinic('clinical_dispute_workforce',{action:'resolve',disputeId:entry.disputeId,
   expectedRevision:entry.revision,resolution:'upheld',
   clinicianResponse:'The finding stands, and your disagreement is recorded with it.'});

  // The item still reports a dispute after it was rejected. This is the assertion the whole
  // feature turns on: a disagreement the clinician did not accept stays visible.
  const summary=await asClinic('clinical_dispute_workforce',{action:'summary',
   subjectKind:'program_assignment',subjectIds:[enrollment]});
  expect(summary.subjects).toHaveLength(1);
  expect((summary.subjects as Json[])[0]).toMatchObject({subjectId:enrollment,
   status:'resolved',resolution:'upheld'});
 });

 it('refuses a resolution with no answer, and will not let an answer be rewritten',async()=>{
  const enrollment=await assign();
  await rpc('clinical_dispute_consumer',{action:'raise',subjectKind:'program_assignment',subjectId:enrollment,reasonCode:'other',
   statement:'Something is wrong here.'});
  const entry=(await asClinic('clinical_dispute_workforce',{action:'list'})).disputes as Json[];
  const dispute=entry[0];
  expect(await message(asClinic('clinical_dispute_workforce',{action:'resolve',
   disputeId:dispute.disputeId,expectedRevision:dispute.revision,resolution:'declined'})))
   .toMatch(/clinical_dispute_invalid/);
  await asClinic('clinical_dispute_workforce',{action:'resolve',disputeId:dispute.disputeId,
   expectedRevision:dispute.revision,resolution:'declined',clinicianResponse:'Please raise this at your visit.'});
  await expect(db.query("update clinical_core.clinical_disputes set clinician_response='Never mind.'"))
   .rejects.toThrow(/clinical_dispute_immutable/);
  await expect(db.query("update clinical_core.clinical_disputes set resolution='corrected'"))
   .rejects.toThrow(/clinical_dispute_immutable/);
  await expect(db.query('delete from clinical_core.clinical_disputes'))
   .rejects.toThrow(/append_only_record/);
  await expect(db.query("update clinical_core.clinical_dispute_statements set body='different'"))
   .rejects.toThrow(/append_only_record/);
 });

 it('will not contest something that is not theirs, or does not exist',async()=>{
  const enrollment=await assign();
  const theirs=await assign(otherConnection);
  // Another patient's assignment is not a subject this account may contest.
  expect(await message(rpc('clinical_dispute_consumer',{action:'raise',subjectKind:'program_assignment',subjectId:theirs,reasonCode:'other',statement:'Not mine.'})))
   .toMatch(/clinical_dispute_subject_absent/);
  // And the other account cannot reach this one's assignment either: the connection search
  // runs over the caller's own links only.
  expect(await message(rpc('clinical_dispute_consumer',{action:'raise',
   subjectKind:'program_assignment',subjectId:enrollment,reasonCode:'other',statement:'Not mine.'},
   other,'consumer'))).toMatch(/clinical_dispute_subject_absent/);
  expect(await message(rpc('clinical_dispute_consumer',{action:'raise',subjectKind:'lab_observation',subjectId:id(999),reasonCode:'other',statement:'No such thing.'})))
   .toMatch(/clinical_dispute_subject_absent/);
  // And a clinic session cannot raise a dispute on a patient's behalf.
  expect(await message(rpc('clinical_dispute_consumer',{action:'list'},clinician,'workforce')))
   .toMatch(/clinical_dispute_forbidden/);
 });

 it('lets a patient add to and withdraw an open dispute, but not a resolved one',async()=>{
  const enrollment=await assign();
  const raised=await rpc('clinical_dispute_consumer',{action:'raise',subjectKind:'program_assignment',subjectId:enrollment,reasonCode:'missing_context',
   statement:'First thing.'});
  await rpc('clinical_dispute_consumer',{action:'add_statement',disputeId:raised.disputeId,
   statement:'Second thing I forgot.'});
  const mine=await rpc('clinical_dispute_consumer',{action:'list'});
  expect((mine.disputes as Json[])[0].statements).toHaveLength(2);
  // A duplicate complaint about the same item adds to the trail rather than forking it.
  expect(await message(rpc('clinical_dispute_consumer',{action:'raise',subjectKind:'program_assignment',subjectId:enrollment,reasonCode:'other',statement:'Again.'})))
   .toMatch(/clinical_dispute_exists/);
  const entry=(await asClinic('clinical_dispute_workforce',{action:'list'})).disputes as Json[];
  await asClinic('clinical_dispute_workforce',{action:'resolve',disputeId:entry[0].disputeId,
   expectedRevision:entry[0].revision,resolution:'upheld',clinicianResponse:'Recorded.'});
  const after=(await rpc('clinical_dispute_consumer',{action:'list'})).disputes as Json[];
  expect(await message(rpc('clinical_dispute_consumer',{action:'withdraw',
   disputeId:after[0].disputeId,expectedRevision:after[0].revision})))
   .toMatch(/clinical_dispute_closed/);
  expect(await message(rpc('clinical_dispute_consumer',{action:'add_statement',
   disputeId:after[0].disputeId,statement:'One more.'}))).toMatch(/clinical_dispute_closed/);
 });
});

describe('correcting a record after it was delivered',()=>{
 it('counts what changed and tells everyone holding the older version',async()=>{
  const enrollment=await assign();
  const preview=await asClinic('content_revision_workforce',{action:'preview',toVersionId:v2});
  expect(preview).toMatchObject({affected:1});
  // v2 drops lesson-b, changes lesson-a's instructions and adds lesson-c.
  expect((preview.assignments as Json[])[0]).toMatchObject({assignmentId:enrollment,
   itemsAdded:1,itemsRemoved:1,itemsChanged:1});

  const published=await asClinic('content_revision_workforce',{action:'publish_notices',
   toVersionId:v2,revisionClass:'correction',statement:'The phase-one lesson was reworded.'});
  expect(published).toMatchObject({noticesCreated:1,revisionClass:'correction'});

  const before=await db.query<{content:Json;source_digest:string}>(
   'select content,source_digest from clinical_core.program_assignments where id=$1',[enrollment]);
  const mine=await rpc('content_revision_consumer',{action:'list'});
  expect((mine.notices as Json[])[0]).toMatchObject({assignmentId:enrollment,
   revisionClass:'correction',itemsAdded:1,itemsRemoved:1,itemsChanged:1,
   requiresAcknowledgement:false});
  // What they are already holding is untouched. A notice tells them; it does not swap the
  // protocol under them.
  const after=await db.query<{content:Json;source_digest:string}>(
   'select content,source_digest from clinical_core.program_assignments where id=$1',[enrollment]);
  expect(after.rows[0]).toEqual(before.rows[0]);

  // Reading it is delivery; saying so is acknowledgement. The clinic can tell them apart.
  const {rows}=await db.query<{status:string}>(
   'select status from clinical_core.content_revision_notices where assignment_id=$1',[enrollment]);
  expect(rows[0].status).toBe('delivered');
  const notice=(mine.notices as Json[])[0];
  expect(await rpc('content_revision_consumer',{action:'acknowledge',noticeId:notice.noticeId}))
   .toMatchObject({status:'acknowledged'});
 });

 it('requires a clinician statement for a safety withdrawal and flags it for acknowledgement',async()=>{
  const enrollment=await assign();
  expect(await message(asClinic('content_revision_workforce',{action:'publish_notices',
   toVersionId:v2,revisionClass:'safety_withdrawal'})))
   .toMatch(/revision_statement_required/);
  await asClinic('content_revision_workforce',{action:'publish_notices',toVersionId:v2,
   revisionClass:'safety_withdrawal',
   statement:'Stop the phase-one supplement. It has been withdrawn for safety.'});
  const mine=await rpc('content_revision_consumer',{action:'list'});
  expect((mine.notices as Json[])[0]).toMatchObject({revisionClass:'safety_withdrawal',
   requiresAcknowledgement:true});
  expect((mine.notices as Json[])[0].statement).toContain('withdrawn for safety');
  expect(enrollment).toMatch(/^[0-9a-f-]{36}$/);
 });

 it('never announces a draft, and never notices the same revision twice',async()=>{
  await assign();
  expect(await message(asClinic('content_revision_workforce',{action:'publish_notices',
   toVersionId:draft,revisionClass:'correction'}))).toMatch(/revision_version_unpublished/);
  const first=await asClinic('content_revision_workforce',{action:'publish_notices',
   toVersionId:v2,revisionClass:'enhancement'});
  expect(first).toMatchObject({noticesCreated:1});
  const again=await asClinic('content_revision_workforce',{action:'publish_notices',
   toVersionId:v2,revisionClass:'enhancement'});
  expect(again).toMatchObject({noticesCreated:0});
 });

 it('leaves a withdrawn assignment out: nobody needs telling about something they stopped',async()=>{
  const enrollment=await assign();
  // Set directly, with the triggers suspended, because this is a fixture: what is under test
  // is that a withdrawn assignment is left out, not the path that withdraws one.
  await db.exec("set session_replication_role = 'replica'");
  await db.query("update clinical_core.program_assignments set state='withdrawn' where id=$1",[enrollment]);
  await db.exec("set session_replication_role = 'origin'");
  const preview=await asClinic('content_revision_workforce',{action:'preview',toVersionId:v2});
  expect(preview).toMatchObject({affected:0});
 });

 it('will not rewrite or delete a notice once it is made',async()=>{
  await assign();
  await asClinic('content_revision_workforce',{action:'publish_notices',toVersionId:v2,
   revisionClass:'correction',statement:'Reworded.'});
  await expect(db.query("update clinical_core.content_revision_notices set revision_class='enhancement'"))
   .rejects.toThrow(/revision_notice_immutable/);
  await expect(db.query('delete from clinical_core.content_revision_notices'))
   .rejects.toThrow(/append_only_record/);
 });
});

describe('lifecycle for the contested and corrected record',()=>{
 async function history(){
  const enrollment=await assign();
  await rpc('clinical_dispute_consumer',{action:'raise',subjectKind:'program_assignment',subjectId:enrollment,reasonCode:'not_true_of_me',
   statement:'My own words about this.'});
  const entry=(await asClinic('clinical_dispute_workforce',{action:'list'})).disputes as Json[];
  await asClinic('clinical_dispute_workforce',{action:'resolve',disputeId:entry[0].disputeId,
   expectedRevision:entry[0].revision,resolution:'upheld',clinicianResponse:'Recorded and kept.'});
  await asClinic('content_revision_workforce',{action:'publish_notices',toVersionId:v2,
   revisionClass:'correction',statement:'Reworded.'});
  return enrollment;
 }

 it('puts the dispute, the words and the notice in the owner export',async()=>{
  await history();
  const disputes=await rpc('care_data_export',{action:'export',section:'disputes'});
  expect(disputes.items).toHaveLength(1);
  const dispute=(disputes.items as Json[])[0];
  expect(dispute).toMatchObject({resolution:'upheld',clinicianResponse:'Recorded and kept.'});
  expect((dispute.statements as Json[])[0].body).toBe('My own words about this.');
  const notices=await rpc('care_data_export',{action:'export',section:'revision_notices'});
  expect(notices.items).toHaveLength(1);
  expect((notices.items as Json[])[0]).toMatchObject({revisionClass:'correction'});
 });

 it('erases their words on a domain erase and keeps the decision, with a reason',async()=>{
  await history();
  const erased=await rpc('care_data_erase',{action:'erase',scope:'domain'});
  // The decision survives; their words do not. The notice goes with the assignment it is
  // about, because a notice with no delivered program to be about reads as nothing.
  expect(erased).toMatchObject({scope:'domain',disputeStatementsErased:1,
   disputesRetained:1,disputesErased:0,revisionNoticesErased:1,
   disputesRetainedReason:'dispute_records_a_decision_and_the_disagreement_with_it'});
  const after=await rpc('care_data_export',{action:'export',section:'disputes'});
  expect((after.items as Json[])[0].statements).toEqual([]);
  expect((after.items as Json[])[0]).toMatchObject({resolution:'upheld'});
 });

 it('removes both when the account closes, and reports it in the history',async()=>{
  await history();
  const closed=await rpc('care_data_erase',{action:'erase',scope:'account_closure'});
  expect(closed).toMatchObject({scope:'account_closure',disputeStatementsErased:1,
   disputesErased:1,disputesRetained:0,revisionNoticesErased:1});
  for(const section of ['disputes','revision_notices']){
   expect(await rpc('care_data_export',{action:'export',section})).toMatchObject({items:[]});
  }
  const log=await rpc('care_data_erasure_history',{action:'erasure_history'});
  expect((log.erasures as Json[])[0]).toMatchObject({disputeStatementsErased:1,disputesErased:1,
   revisionNoticesErased:1});
 });
});
