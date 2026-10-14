import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {ClinicalCoreDatabase} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256,LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256} from './lab-observation-attestation';
import {createLabAttestationReview,labAttestationReviewActivationState,DISABLED_LAB_ATTESTATION_REVIEW_ACTIVATION,
 LAB_ATTESTATION_REVIEW_CANDIDATE_SHA256,labAttestationReviewHttp} from './lab-attestation-review';
import {classifyDatabaseRejection} from './rds-data-database';
import {boundAttestation,labAttestationReview,verifiedByView,type LabAttestationReview} from '../../contracts/labAttestationReview';

/**
 * The BLOCKED reviewer successor (lab-attestation-review.sql) over the two BLOCKED lab candidates, against the actual
 * 106-migration production artifact, through the API role, with fictional identities only. Nothing here is registered
 * or applied anywhere; all three activation rows start disabled and the first block proves it.
 */
const TRANSFER='infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql';
const ATTESTATION='infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql';
const REVIEW='infra/aws-clinical-core/production-candidates/lab-attestation-review.sql';
let db:PGlite,org:string,otherOrg:string,staff:string,second:string,assistant:string,outsider:string,consumer:string,patient:string,otherPatient:string,connection:string,otherConnection:string,otherConsumer:string;
const subject=(id:string)=>'fictional-'+id;
const DOC='d'.repeat(64),OTHER_DOC='e'.repeat(64);
const DRAWN='2026-10-01T09:00:00.000Z';
async function as<T=Record<string,unknown>>(person:string,pool:'workforce'|'consumer',organization:string,sql:string,params:unknown[]=[]):Promise<T[]>{
 return db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[person,organization,pool,subject(person),'clinical_data','production-clinical','clinical_phi']);
  return (await tx.query<T>(sql,params)).rows;
 });
}
async function refused(work:Promise<unknown>):Promise<string>{
 try{await work;}catch(error){return error instanceof Error?error.message:String(error);}
 throw new Error('expected a refusal');
}
const transfer=(parts:Record<string,unknown>={},result:Record<string,unknown>={},provenance:Record<string,unknown>={},markerId='marker_'+randomUUID().replaceAll('-',''))=>({
 schemaVersion:'lab-result/2',provider:'alp_patient_sync',providerEventId:'lab:'+randomUUID().replaceAll('-',''),connectionId:connection,
 resourceVersion:'f'.repeat(16)+randomUUID().replaceAll('-',''),occurredAt:new Date().toISOString(),
 source:{system:'ai_longevity_pro_v2',recordType:'lab_panels',panelId:'panel_'+'1'.repeat(32),markerId},
 panel:{name:'Fictional iron panel',collectedAt:DRAWN,sourceLabel:'Fictional upload'},
 result:{name:'Ferritin',value:420.0,unit:'ng/mL',referenceRange:{min:30,max:400},...result},
 provenance:{origin:'uploaded_report_analysis',documents:[DOC],reportedVerification:'analysis_cross_checked',...provenance},...parts});
const importV2=(body:unknown,person=consumer)=>as<{event_id:string;state:string}>(person,'consumer',org,'select * from clinical_core.record_lab_import_v2($1::jsonb)',[JSON.stringify(body)]);
async function accepted(body=transfer(),note:string|null=null):Promise<string>{
 const [row]=await importV2(body);
 const [review]=await as<{observation_id:string}>(staff,'workforce',org,"select * from clinical_core.review_lab_import($1,'accept',$2)",[row!.event_id,note]);
 return review!.observation_id;
}
const reviewOf=(observation:string,person=staff,organization=org,patientRecordId=patient)=>as<{data:LabAttestationReview}>(person,'workforce',organization,
 'select clinical_core.lab_attestation_review($1::jsonb) as data',[JSON.stringify({contract:'lab-attestation-review/1',patientRecordId,observationId:observation})]).then(r=>labAttestationReview.parse(r[0]!.data));
const restated={marker:'Ferritin',value:420,unit:'ng/mL',observedAt:DRAWN};
const bound=(view:LabAttestationReview,parts:{outcome?:'verified'|'refuted';restated?:Partial<typeof restated>;documentSha256?:string;requestId?:string}={})=>
 boundAttestation(view,{requestId:parts.requestId??randomUUID(),outcome:parts.outcome??'verified',restated:{...restated,...parts.restated},documentSha256:parts.documentSha256??DOC});
const attest=(body:unknown,person=staff,organization=org)=>as<{data:Record<string,unknown>}>(person,'workforce',organization,
 'select clinical_core.attest_reviewed_lab_observation($1::jsonb) as data',[JSON.stringify(body)]).then(r=>r[0]!.data);
const verified=(observation:string)=>db.query<{v:boolean}>('select clinical_private.lab_observation_verified($1) as v',[observation]).then(r=>r.rows[0]!.v);
async function enable(table:'lab_result_transfer_v2_activation'|'lab_observation_attestation_activation'|'lab_attestation_review_activation',enabled:boolean){
 await db.query(`update clinical_core.${table} set enabled=$1,evidence_sha256=case when $1 then repeat('e',64) else null end,reviewed_by=case when $1 then 'FICTIONAL REVIEW FIXTURE' else null end,reviewed_at=case when $1 then now() else null end`,[enabled]);
}

beforeAll(async()=>{
 const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',timeout:20_000,maxBuffer:8*1024*1024}));
 expect(manifest.migrations).toHaveLength(106);
 expect(manifest.migrations.some((m:{file:string})=>/lab_result_transfer_v2|lab_observation_attestation|lab_attestation_review/.test(m.file))).toBe(false);
 db=new PGlite({extensions:{pgcrypto}});
 for(const migration of manifest.migrations)await db.exec(files[migration.file]);
 for(const file of [TRANSFER,ATTESTATION,REVIEW])await db.exec(readFileSync(file,'utf8'));
},120_000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
 [org,otherOrg,staff,second,assistant,outsider,consumer,patient,otherPatient,connection,otherConnection,otherConsumer]=Array.from({length:12},()=>randomUUID());
 for(const table of ['lab_result_transfer_v2_activation','lab_observation_attestation_activation','lab_attestation_review_activation'] as const)await enable(table,true);
 await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC A'),($2,'FICTIONAL CLINIC B')",[org,otherOrg]);
 for(const [person,pool] of [[staff,'workforce'],[second,'workforce'],[assistant,'workforce'],[outsider,'workforce'],[consumer,'consumer'],[otherConsumer,'consumer']] as const){
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[person,'subject_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[person,pool,subject(person)]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($1,$3,'practitioner'),($1,$4,'staff'),($5,$6,'practitioner')",[org,staff,second,assistant,otherOrg,outsider]);
 for(const [id,key] of [[patient,'a'],[otherPatient,'b']])
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')",[id,org,'patient_fixture_'+key+id.replaceAll('-','')]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now()),($5,$2,$6,$7,'verified',now())",[connection,org,patient,consumer,otherConnection,otherPatient,otherConsumer]);
 await db.query("insert into clinical_core.sync_providers(organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state,reviewed_by_person_id,reviewed_at) values($1,'alp_patient_sync','patient-sync/1','lab-result/1','fictional-1','active',$2,now())",[org,staff]);
 const [artifact]=(await db.query<{id:string}>("insert into clinical_core.consent_artifacts(organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,'lab_results_import','fictional-1',$2,'US-FICTIONAL','approved',now(),$3) returning id",[org,'a'.repeat(64),staff])).rows;
 for(const [p,c,who] of [[patient,connection,consumer],[otherPatient,otherConnection,otherConsumer]])
  await db.query("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'lab_results_import','granted','patient_app','self',1,$5)",[org,p,c,artifact!.id,who]);
});

describe('disabled by default and unwritable by the API role',()=>{
 it('refuses the view and the attestation while any of the three activation rows is off, and the API role cannot flip its own row',async()=>{
  const observation=await accepted();
  const view=await reviewOf(observation);
  for(const table of ['lab_attestation_review_activation','lab_observation_attestation_activation'] as const){
   await enable(table,false);
   expect(await refused(reviewOf(observation))).toMatch(/lab_attestation_disabled/);
   expect(await refused(attest(bound(view)))).toMatch(/lab_attestation_disabled/);
   await enable(table,true);
  }
  await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.exec('update clinical_core.lab_attestation_review_activation set enabled=true');})).rejects.toThrow(/permission denied/);
  expect(await verified(observation)).toBe(false);
 });
});

describe('the view: the clinic reading exactly as stored, beside the transferred report',()=>{
 it('shows marker, the stored value and its own text, unit and draw time as stored, the recorded documents, no laboratory flag and no verification',async()=>{
  const observation=await accepted(transfer({},{},{documents:[OTHER_DOC,DOC]}));
  const view=await reviewOf(observation);
  expect(view).toMatchObject({patientRecordId:patient,observationId:observation,
   reading:{marker:'Ferritin',value:420,unit:'ng/mL',observedAt:DRAWN},reviewStatus:'unreviewed',
   transfer:{contract:'lab-result/2',origin:'uploaded_report_analysis',documents:[DOC,OTHER_DOC],reportedVerification:'analysis_cross_checked',appAssessment:null,laboratoryFlag:null},
   supersededBy:null,verification:{state:'needs_human_review',current:null,rangeVerified:false,history:[]},attestable:true,blockedBy:null});
  // The value as the database holds it: 420.0 was sent as 420 and stored as numeric 420.
  const stored=(await db.query<{v:string}>('select value_numeric::text as v from clinical_core.lab_observations where id=$1',[observation])).rows[0]!.v;
  expect(view.reading.valueText).toBe(stored);
  expect(JSON.stringify(view)).not.toMatch(/"(critical|high|status|flag)"\s*:/i);
 });
 it('names a legacy /1 status only as the app’s assessment, never a laboratory flag, and the reading cannot be attested',async()=>{
  const [row]=await as<{event_id:string}>(consumer,'consumer',org,
   "select * from clinical_core.record_lab_import($1,'alp_patient_sync',$2,'panel_1','marker_1','1','Fictional panel','',$3,$4::numeric,'ng/mL',30::numeric,400::numeric,'critical',$5::timestamptz,now(),$6)",
   [connection,'lab:'+randomUUID().replaceAll('-',''),'Ferritin',900,DRAWN,'c'.repeat(64)]);
  const [review]=await as<{observation_id:string}>(staff,'workforce',org,"select * from clinical_core.review_lab_import($1,'accept',null)",[row!.event_id]);
  const view=await reviewOf(review!.observation_id);
  expect(view.transfer).toEqual({contract:'lab-result/1',origin:'not_recorded',documents:[],reportedVerification:'not_recorded',appAssessment:'critical',laboratoryFlag:null});
  expect(view).toMatchObject({attestable:false,blockedBy:'document_unknown'});
  expect(await refused(attest(bound(view,{restated:{value:900}})))).toMatch(/lab_attestation_document_unknown/);
  expect(await verified(review!.observation_id)).toBe(false);
 });
 it('refuses another patient’s reading, a reading in another clinic and one that does not exist with one refusal, and refuses a consumer or a staff member without a clinical role',async()=>{
  const observation=await accepted();
  const messages=[
   await refused(reviewOf(observation,staff,org,otherPatient)),
   await refused(reviewOf(randomUUID())),
   await refused(reviewOf(observation,outsider,otherOrg)),
  ];
  for(const message of messages)expect(message).toMatch(/lab_attestation_review_refused/);
  expect(new Set(messages.map(m=>m.replace(/\s+/g,' ')))).toHaveProperty('size',1);
  expect(await refused(reviewOf(observation,assistant))).toMatch(/clinical_role_required/);
  expect(await refused(as(consumer,'consumer',org,'select clinical_core.lab_attestation_review($1::jsonb)',[JSON.stringify({contract:'lab-attestation-review/1',patientRecordId:patient,observationId:observation})]))).toMatch(/lab_attestation_refused/);
 });
});

describe('the bound attestation: actor, clinic, patient, reading revision and document',()=>{
 it('verifies only through the reviewed function, returns the view as it now stands, and the readback names this attestation as current',async()=>{
  const observation=await accepted();
  const view=await reviewOf(observation);
  const receipt=await attest(bound(view));
  expect(receipt).toMatchObject({observationId:observation,patientRecordId:patient,outcome:'verified',scope:'measured_value',rangeVerified:false,duplicate:false});
  const after=await reviewOf(observation);
  expect(verifiedByView(after,{attestationId:receipt.attestationId as string,outcome:'verified'})).toBe(true);
  expect(after.readingRevision).not.toBe(view.readingRevision);
  expect((receipt.view as LabAttestationReview).readingRevision).toBe(after.readingRevision);
  expect(await verified(observation)).toBe(true);
  const row=(await db.query<Record<string,unknown>>('select reviewer_person_id,reviewer_role,patient_record_id,organization_id,document_sha256 from clinical_core.lab_observation_attestations where id=$1',[receipt.attestationId])).rows[0];
  expect(row).toEqual({reviewer_person_id:staff,reviewer_role:'practitioner',patient_record_id:patient,organization_id:org,document_sha256:DOC});
 });
 it('refuses another patient than the one open, a missing or changed document, and a restated field that differs',async()=>{
  const observation=await accepted();
  const view=await reviewOf(observation);
  expect(await refused(attest({...bound(view),patientRecordId:otherPatient}))).toMatch(/lab_attestation_review_refused/);
  expect(await refused(attest(bound(view,{documentSha256:OTHER_DOC})))).toMatch(/lab_attestation_document_mismatch/);
  for(const change of [{value:421},{unit:'ug/L'},{marker:'Iron'},{observedAt:'2026-10-02T09:00:00.000Z'}])
   expect(await refused(attest(bound(view,{restated:change})))).toMatch(/lab_attestation_mismatch/);
  for(const origin of ['owner_entered','personal_import']){
   const unsourced=await accepted(transfer({},{},{origin,documents:[],reportedVerification:'not_recorded'}));
   const unsourcedView=await reviewOf(unsourced);
   expect(unsourcedView.blockedBy).toBe('document_unknown');
   expect(await refused(attest(bound(unsourcedView)))).toMatch(/lab_attestation_document_unknown/);
  }
  expect(await verified(observation)).toBe(false);
 });
 it('refuses a reviewer whose authority was withdrawn after the view loaded, a reviewer from another clinic, and a staff member without a clinical role',async()=>{
  const observation=await accepted();
  const view=await reviewOf(observation);
  await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2",[org,staff]);
  expect(await refused(attest(bound(view)))).toMatch(/clinical_role_required/);
  expect(await refused(attest(bound(view),outsider,otherOrg))).toMatch(/lab_attestation_review_refused/);
  expect(await refused(attest(bound(view),assistant))).toMatch(/clinical_role_required/);
  await db.query("update clinical_core.identities set status='disabled' where person_id=$1",[second]);
  // A disabled identity is refused by the platform's own request context before any attestation function runs.
  expect(await refused(attest(bound(view),second))).toMatch(/request_context_refused|lab_attestation_refused/);
  expect(await verified(observation)).toBe(false);
 });
 it('a view that changed since it loaded is stale: another attestation, a changed review state',async()=>{
  const observation=await accepted();
  const view=await reviewOf(observation);
  await db.query("update clinical_core.lab_observations set review_status='flagged' where id=$1",[observation]);
  expect(await refused(attest(bound(view)))).toMatch(/lab_attestation_stale/);
  const fresh=await reviewOf(observation);
  await attest(bound(fresh));
  expect(await refused(attest(bound(fresh,{outcome:'refuted'})))).toMatch(/lab_attestation_stale/);
 });
 it('a retried request returns its own record even though the revision moved; the same request id with another binding is a conflict',async()=>{
  const observation=await accepted();
  const view=await reviewOf(observation);
  const body=bound(view);
  const first=await attest(body);
  expect(await attest(body)).toMatchObject({attestationId:first.attestationId,duplicate:true});
  expect(await refused(attest({...body,attestation:{...body.attestation,outcome:'refuted'}}))).toMatch(/lab_attestation_conflict/);
  expect(await refused(attest({...body,patientRecordId:otherPatient}))).toMatch(/lab_attestation_review_refused/);
 });
});

describe('correction and supersession',()=>{
 it('a corrected reading supersedes the original: the original can no longer be attested, the correction can, and a refutation ends verification',async()=>{
  const markerId='marker_'+randomUUID().replaceAll('-','');
  const original=await accepted(transfer({},{value:80},{},markerId));
  const originalView=await reviewOf(original);
  // The patient app sends a corrected value for the same source marker; a practitioner accepts it with a note.
  const correction=await accepted(transfer({},{value:420},{},markerId),'Corrected report received');
  const stale=await reviewOf(original);
  expect(stale).toMatchObject({supersededBy:correction,attestable:false,blockedBy:'reading_superseded'});
  expect(await refused(attest(bound(originalView,{restated:{value:80}})))).toMatch(/lab_attestation_reading_superseded/);
  expect(await refused(attest(bound(stale,{restated:{value:80}})))).toMatch(/lab_attestation_reading_superseded/);
  expect(await verified(original)).toBe(false);
  const correctedView=await reviewOf(correction);
  expect(correctedView).toMatchObject({supersededBy:null,attestable:true,reading:{value:420}});
  const verifiedReceipt=await attest(bound(correctedView));
  expect(await verified(correction)).toBe(true);
  const afterVerify=await reviewOf(correction);
  await attest(bound(afterVerify,{outcome:'refuted'}));
  const afterRefute=await reviewOf(correction);
  expect(afterRefute.verification).toMatchObject({state:'refuted'});
  expect(afterRefute.verification.history.map(h=>h.outcome)).toEqual(['refuted','verified']);
  expect(afterRefute.verification.history[0]!.supersedes).toBe(verifiedReceipt.attestationId);
  expect(await verified(correction)).toBe(false);
 });
 it('the reviewed function alone would attest the superseded original: the successor exists to refuse it',async()=>{
  const markerId='marker_'+randomUUID().replaceAll('-','');
  const original=await accepted(transfer({},{value:80},{},markerId));
  await accepted(transfer({},{value:420},{},markerId),'Corrected report received');
  const direct=await as<{data:Record<string,unknown>}>(staff,'workforce',org,'select clinical_core.attest_lab_observation($1::jsonb) as data',[JSON.stringify({
   statement:'lab-reading-attestation/1',requestId:randomUUID(),observationId:original,outcome:'verified',
   reading:{...restated,value:80},documentSha256:DOC,supersedes:null})]);
  expect(direct[0]!.data).toMatchObject({outcome:'verified'});
  expect(await verified(original)).toBe(true);
 });
});

describe('two practitioners racing',()=>{
 it('on the same reading: both loaded the same revision, the first wins and the second is refused as stale, whatever its outcome',async()=>{
  const observation=await accepted();
  const [mine,theirs]=await Promise.all([reviewOf(observation,staff),reviewOf(observation,second)]);
  expect(mine.readingRevision).toBe(theirs.readingRevision);
  const results=await Promise.allSettled([attest(bound(mine),staff),attest(bound(theirs,{outcome:'refuted'}),second)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
  expect(String(rejected.reason?.message??rejected.reason)).toMatch(/lab_attestation_stale/);
  expect((await reviewOf(observation)).verification.history).toHaveLength(1);
 });
 it('on different revisions of one source marker: the attestation of the superseded original is refused, the attestation of the correction stands',async()=>{
  const markerId='marker_'+randomUUID().replaceAll('-','');
  const original=await accepted(transfer({},{value:80},{},markerId));
  const originalView=await reviewOf(original,staff);
  const correction=await accepted(transfer({},{value:420},{},markerId),'Corrected report received');
  const correctedView=await reviewOf(correction,second);
  const results=await Promise.allSettled([attest(bound(originalView,{restated:{value:80}}),staff),attest(bound(correctedView),second)]);
  expect(results[0]).toMatchObject({status:'rejected'});
  expect(String((results[0] as PromiseRejectedResult).reason?.message)).toMatch(/lab_attestation_reading_superseded/);
  expect(results[1]).toMatchObject({status:'fulfilled'});
  expect([await verified(original),await verified(correction)]).toEqual([false,true]);
 });
});

describe('the default-disabled adapter and its HTTP handler',()=>{
 const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
 const evidence=()=>({contract:'lab-attestation-review-activation/1',enabled:true,target:'production-clinical',
  transferCandidateSha256:LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256,attestationCandidateSha256:LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256,
  reviewCandidateSha256:LAB_ATTESTATION_REVIEW_CANDIDATE_SHA256,evidenceSha256:'e'.repeat(64),reviewedBy:'FICTIONAL REVIEW FIXTURE',reviewedAt:'2026-10-14T00:00:00Z'});
 const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>
   tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&'value' in p?(p as {value:unknown}).value:p))});
 })};
 const reviewer=(person=staff):ProductionClinicalRequestContext=>({actorPersonId:person,organizationId:org,identitySubject:subject(person),identityPool:'workforce',
  purpose:'clinical_data',environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true});
 const spy:ClinicalCoreDatabase={transaction:(()=>{throw new Error('database touched');}) as ClinicalCoreDatabase['transaction']};
 it('is pinned to the candidate on disk; absent, disabled or mismatched evidence refuses before any database work',async()=>{
  expect(sha(REVIEW)).toBe(LAB_ATTESTATION_REVIEW_CANDIDATE_SHA256);
  expect(sha(TRANSFER)).toBe(LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256);
  expect(sha(ATTESTATION)).toBe(LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256);
  expect(labAttestationReviewActivationState(undefined)).toEqual(DISABLED_LAB_ATTESTATION_REVIEW_ACTIVATION);
  for(const wrong of [{reviewCandidateSha256:'f'.repeat(64)},{attestationCandidateSha256:'f'.repeat(64)},{target:'synthetic-staging'},{enabled:'true'}])
   expect(labAttestationReviewActivationState({...evidence(),...wrong})).toEqual(DISABLED_LAB_ATTESTATION_REVIEW_ACTIVATION);
  for(const activation of [undefined,DISABLED_LAB_ATTESTATION_REVIEW_ACTIVATION,{...evidence(),reviewCandidateSha256:'f'.repeat(64)}]){
   const service=createLabAttestationReview({database:spy,activation});
   await expect(service.review(reviewer(),{contract:'lab-attestation-review/1',patientRecordId:patient,observationId:randomUUID()})).rejects.toMatchObject({category:'activation_refused',reason:'lab_attestation_disabled'});
   expect(await labAttestationReviewHttp(service)('/clinical-core/workforce/lab-attestations',reviewer(),{})).toEqual({status:409,body:{error:{code:'lab_attestation_disabled'}}});
  }
 });
 it('with evidence: reads the view, attests through the successor, and maps every refusal to its own status without leaking text',async()=>{
  const observation=await accepted();
  const service=createLabAttestationReview({database,activation:evidence()});
  const http=labAttestationReviewHttp(service);
  const view=await service.review(reviewer(),{contract:'lab-attestation-review/1',patientRecordId:patient,observationId:observation});
  expect(view.attestable).toBe(true);
  const receipt=await service.attest(reviewer(),bound(view));
  expect(verifiedByView(receipt.view,receipt)).toBe(true);
  expect(await http('/clinical-core/workforce/lab-attestations',reviewer(),bound(view))).toEqual({status:409,body:{error:{code:'lab_attestation_stale'}}});
  expect(await http('/clinical-core/workforce/lab-attestations/review',reviewer(),{contract:'lab-attestation-review/1',patientRecordId:otherPatient,observationId:observation}))
   .toEqual({status:404,body:{error:{code:'lab_attestation_review_refused'}}});
  expect(await http('/clinical-core/workforce/lab-attestations',reviewer(),{...bound(view),verified:true})).toEqual({status:400,body:{error:{code:'lab_attestation_invalid'}}});
  expect(await http('/clinical-core/workforce/lab-attestations',reviewer(assistant),bound(await reviewOf(observation)))).toEqual({status:403,body:{error:{code:'clinical_role_required'}}});
  // The spy proves a client "verified" boolean is refused before the database.
  await expect(createLabAttestationReview({database:spy,activation:evidence()}).attest(reviewer(),{...bound(view),attestation:{...bound(view).attestation,verified:true}})).rejects.toMatchObject({category:'request_invalid'});
 });
 it('the hosted classifier names each attestation refusal by token only',()=>{
  for(const [token,category] of [['lab_attestation_stale','conflict'],['lab_attestation_reading_superseded','conflict'],['lab_attestation_review_refused','identity_refused'],
   ['lab_attestation_disabled','operation_refused'],['lab_attestation_invalid','request_invalid']] as const){
   const rejection=classifyDatabaseRejection({name:'DatabaseErrorException',message:`ERROR: ${token} at line 9 of fictional SQL`});
   expect(rejection).toMatchObject({category,reason:token});
   expect(JSON.stringify(rejection)).not.toMatch(/line 9|SQL/);
  }
  expect(classifyDatabaseRejection({name:'DatabaseErrorException',message:'ERROR: lab_attestation_made_up'})).toBeUndefined();
 });
});
