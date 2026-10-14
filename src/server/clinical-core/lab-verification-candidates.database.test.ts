import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {ClinicalCoreDatabase} from './database';
import {createAwsProductionClinicalStateAdapter,labResultV2Content} from './aws-clinical-state';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {labResultTransferV2} from '../../contracts/labResultTransfer';
import {createHash} from 'node:crypto';
import {createLabObservationAttestation,labAttestationActivationState,DISABLED_LAB_ATTESTATION_ACTIVATION,
 LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256,LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256} from './lab-observation-attestation';

/**
 * The two BLOCKED lab candidates — lab-result/2 (lab-result-transfer-v2.sql) and the reviewer attestation
 * (lab-observation-attestation.sql) — against the actual 106-migration production artifact, through the API role,
 * with fictional identities only. Nothing here is registered or applied anywhere; both activation rows start
 * disabled and the first block proves it.
 */
const TRANSFER='infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql';
const ATTESTATION='infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql';
let db:PGlite,org:string,otherOrg:string,staff:string,assistant:string,outsider:string,consumer:string,other:string,patient:string,connection:string;
const subject=(id:string)=>'fictional-'+id;
const DOC='d'.repeat(64),OTHER_DOC='e'.repeat(64);
/** Fictional golden /2 payload. expo/__tests__/lab-result-v2-prepared.test.ts pins the same digest for the sender's content. */
const LAB_RESULT_V2_GOLDEN=labResultTransferV2.parse({schemaVersion:'lab-result/2',provider:'alp_patient_sync',providerEventId:'lab:'+'a'.repeat(32)+':'+'b'.repeat(16),
 connectionId:'33333333-3333-4333-8333-333333333333',resourceVersion:'c'.repeat(64),occurredAt:'2026-10-14T00:00:00.000Z',
 source:{system:'ai_longevity_pro_v2',recordType:'lab_panels',panelId:'panel_'+'a'.repeat(32),markerId:'marker_'+'d'.repeat(32)},
 panel:{name:'Fictional iron panel',collectedAt:'2026-09-30T00:00:00.000Z',sourceLabel:'upload'},
 result:{name:'Ferritin',value:420,unit:'ng/mL',referenceRange:{min:30,max:400}},
 provenance:{origin:'uploaded_report_analysis',documents:['e'.repeat(64),'d'.repeat(64)],reportedVerification:'analysis_cross_checked'}});
const LAB_RESULT_V2_GOLDEN_SHA256='858f1f3b8ed29cd5a23014c92fdd13a7621a0c1280263352f1d8e89085f2d6e2';
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
const transfer=(parts:Record<string,unknown>={},result:Record<string,unknown>={},provenance:Record<string,unknown>={})=>({
 schemaVersion:'lab-result/2',provider:'alp_patient_sync',providerEventId:'lab:'+randomUUID().replaceAll('-',''),connectionId:connection,
 resourceVersion:'f'.repeat(64),occurredAt:new Date().toISOString(),
 source:{system:'ai_longevity_pro_v2',recordType:'lab_panels',panelId:'panel_'+'1'.repeat(32),markerId:'marker_'+randomUUID().replaceAll('-','')},
 panel:{name:'Fictional iron panel',collectedAt:'2026-10-01T09:00:00.000Z',sourceLabel:'Fictional upload'},
 result:{name:'Ferritin',value:80,unit:'ng/mL',referenceRange:{min:30,max:400},...result},
 provenance:{origin:'uploaded_report_analysis',documents:[DOC],reportedVerification:'analysis_cross_checked',...provenance},...parts});
const importV2=(body:unknown,person=consumer)=>as<{event_id:string;state:string;duplicate:boolean}>(person,'consumer',org,'select * from clinical_core.record_lab_import_v2($1::jsonb)',[JSON.stringify(body)]);
async function accepted(body=transfer()):Promise<string>{
 const [row]=await importV2(body);
 const [review]=await as<{observation_id:string}>(staff,'workforce',org,"select * from clinical_core.review_lab_import($1,'accept',null)",[row!.event_id]);
 return review!.observation_id;
}
const attestation=(observationId:string,parts:Record<string,unknown>={},reading:Record<string,unknown>={})=>({
 statement:'lab-reading-attestation/1',requestId:randomUUID(),observationId,outcome:'verified',
 reading:{marker:'Ferritin',value:80,unit:'ng/mL',observedAt:'2026-10-01T09:00:00.000Z',...reading},documentSha256:DOC,supersedes:null,...parts});
const attest=(body:unknown,person=staff,organization=org)=>as<{data:Record<string,unknown>}>(person,'workforce',organization,'select clinical_core.attest_lab_observation($1::jsonb) as data',[JSON.stringify(body)]).then(r=>r[0]!.data);
const verification=(observation:string)=>as<{data:Record<string,unknown>}>(staff,'workforce',org,'select clinical_core.lab_observation_verification($1) as data',[observation]).then(r=>r[0]!.data);
const verified=(observation:string)=>db.query<{v:boolean}>('select clinical_private.lab_observation_verified($1) as v',[observation]).then(r=>r.rows[0]!.v);
async function enable(table:'lab_result_transfer_v2_activation'|'lab_observation_attestation_activation',enabled:boolean){
 await db.query(`update clinical_core.${table} set enabled=$1,evidence_sha256=case when $1 then repeat('e',64) else null end,reviewed_by=case when $1 then 'FICTIONAL REVIEW FIXTURE' else null end,reviewed_at=case when $1 then now() else null end`,[enabled]);
}

beforeAll(async()=>{
 const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',timeout:20_000,maxBuffer:8*1024*1024}));
 expect(manifest.migrations).toHaveLength(106);
 expect(manifest.migrations.some((m:{file:string})=>/lab_result_transfer_v2|lab_observation_attestation/.test(m.file))).toBe(false);
 db=new PGlite({extensions:{pgcrypto}});
 for(const migration of manifest.migrations)await db.exec(files[migration.file]);
 await db.exec(readFileSync(TRANSFER,'utf8'));
 await db.exec(readFileSync(ATTESTATION,'utf8'));
},120_000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
 [org,otherOrg,staff,assistant,outsider,consumer,other,patient,connection]=Array.from({length:9},()=>randomUUID());
 await enable('lab_result_transfer_v2_activation',true);await enable('lab_observation_attestation_activation',true);
 await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC A'),($2,'FICTIONAL CLINIC B')",[org,otherOrg]);
 for(const [person,pool] of [[staff,'workforce'],[assistant,'workforce'],[outsider,'workforce'],[consumer,'consumer'],[other,'consumer']] as const){
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[person,'subject_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[person,pool,subject(person)]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($1,$3,'staff'),($4,$5,'practitioner')",[org,staff,assistant,otherOrg,outsider]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')",[patient,org,'patient_fixture_'+patient.replaceAll('-','')]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",[connection,org,patient,consumer]);
 await db.query("insert into clinical_core.sync_providers(organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state,reviewed_by_person_id,reviewed_at) values($1,'alp_patient_sync','patient-sync/1','lab-result/1','fictional-1','active',$2,now())",[org,staff]);
 const [artifact]=(await db.query<{id:string}>("insert into clinical_core.consent_artifacts(organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,'lab_results_import','fictional-1',$2,'US-FICTIONAL','approved',now(),$3) returning id",[org,'a'.repeat(64),staff])).rows;
 await db.query("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'lab_results_import','granted','patient_app','self',1,$5)",[org,patient,connection,artifact!.id,consumer]);
});

describe('both candidates are disabled by default and unwritable by the API role',()=>{
 it('refuses every transfer and every attestation while its own activation row is disabled, and the API role cannot flip either row',async()=>{
  await enable('lab_result_transfer_v2_activation',false);
  expect(await refused(importV2(transfer()))).toMatch(/lab_result_v2_disabled/);
  await enable('lab_result_transfer_v2_activation',true);
  const observation=await accepted();
  await enable('lab_observation_attestation_activation',false);
  expect(await refused(attest(attestation(observation)))).toMatch(/lab_attestation_disabled/);
  for(const table of ['lab_result_transfer_v2_activation','lab_observation_attestation_activation'])
   await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.exec(`update clinical_core.${table} set enabled=true`);})).rejects.toThrow(/permission denied/);
  await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.exec('select * from clinical_core.lab_observation_attestations');})).rejects.toThrow(/permission denied/);
 });
});

describe('lab-result/2: provenance travels, a laboratory flag cannot',()=>{
 it('records the origin, the document digests and the app claim as a claim, verification needs_human_review, and no status at all',async()=>{
  const [row]=await importV2(transfer({},{},{documents:[OTHER_DOC,DOC]}));
  expect(row).toMatchObject({state:'review_pending',duplicate:false});
  const stored=(await db.query<{source_status:string|null;transfer_provenance:Record<string,unknown>}>('select source_status,transfer_provenance from clinical_core.lab_import_events where id=$1',[row!.event_id])).rows[0]!;
  expect(stored.source_status).toBeNull();
  expect(stored.transfer_provenance).toEqual({contract:'lab-result/2',origin:'uploaded_report_analysis',documents:[DOC,OTHER_DOC],
   reportedVerification:'analysis_cross_checked',verification:'needs_human_review'});
  const [shown]=await as<{data:Record<string,unknown>}>(staff,'workforce',org,'select clinical_core.lab_import_provenance($1) as data',[row!.event_id]);
  expect(shown!.data).toMatchObject({contract:'lab-result/2',verificationAtTransfer:'needs_human_review',appAssessment:null,laboratoryFlag:null});
  // A retry is a duplicate; the same identity with a changed value is a conflict.
  const body=transfer();
  await importV2(body);
  expect((await importV2(body))[0]).toMatchObject({duplicate:true});
  expect(await refused(importV2({...body,result:{...body.result,value:81}}))).toMatch(/provider_event_conflict/);
 });
 it.each([
  ['an app or analyzer status',{},{sourceStatus:'critical'},{}],
  ['a status under another name',{},{status:'high'},{}],
  ['a flag',{},{flag:'H'},{}],
  ['an interpretation',{},{interpretation:'above range'},{}],
  ['a client "verified" boolean in the provenance',{},{},{verified:true}],
  ['a client "verified" boolean on the result',{},{verified:true},{}],
  ['a verification state chosen by the client',{},{},{verification:'independently_verified'}],
  ['an uploaded-report origin without a document',{},{},{documents:[]}],
  ['an owner-entered reading claiming a document',{},{},{origin:'owner_entered'}],
  ['a malformed document digest',{},{},{documents:['not-a-digest']}],
  ['a repeated document digest',{},{},{documents:[DOC,DOC]}],
  ['an unknown origin',{},{},{origin:'laboratory_interface'}],
  ['the legacy schema version',{schemaVersion:'lab-result/1'},{},{}],
  ['an inverted range',{},{referenceRange:{min:400,max:30}},{}],
 ] as const)('refuses %s',async(_name,parts,result,provenance)=>{
  expect(await refused(importV2(transfer(parts,result,provenance)))).toMatch(/lab_import_invalid/);
 });
 it('refuses another consumer, a withdrawn consent and another clinic context, as /1 does',async()=>{
  expect(await refused(importV2(transfer(),other))).toMatch(/consumer_connection_refused|production_context_refused/);
  await db.query("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,representative_authority,reason_code,version,recorded_by_person_id) values($1,$2,$3,'lab_results_import','revoked','patient_app','self','patient_request',2,$4)",[org,patient,connection,consumer]);
  expect(await refused(importV2(transfer()))).toMatch(/lab_import_consent_required/);
 });
 it('a legacy lab-result/1 import stays readable, reads as unverified, and its stored status is named the app’s assessment, never a laboratory flag',async()=>{
  const [row]=await as<{event_id:string}>(consumer,'consumer',org,
   "select * from clinical_core.record_lab_import($1,'alp_patient_sync',$2,'panel_1','marker_1','1','Fictional panel','',$3,$4::numeric,'ng/mL',30::numeric,400::numeric,'critical',$5::timestamptz,now(),$6)",
   [connection,'lab:'+randomUUID().replaceAll('-',''),'Ferritin',900,'2026-10-01T09:00:00Z','c'.repeat(64)]);
  const [shown]=await as<{data:Record<string,unknown>}>(staff,'workforce',org,'select clinical_core.lab_import_provenance($1) as data',[row!.event_id]);
  expect(shown!.data).toEqual({contract:'lab-result/1',origin:'not_recorded',documents:[],reportedVerification:'not_recorded',
   verificationAtTransfer:'needs_human_review',appAssessment:'critical',laboratoryFlag:null});
  const [review]=await as<{observation_id:string}>(staff,'workforce',org,"select * from clinical_core.review_lab_import($1,'accept',null)",[row!.event_id]);
  expect(await verified(review!.observation_id)).toBe(false);
  // Accepting the import is practitioner approval of the transfer, not verification of the value.
  expect(await verification(review!.observation_id)).toMatchObject({state:'needs_human_review',current:null,rangeVerified:false});
  expect(await refused(attest(attestation(review!.observation_id,{},{marker:'Ferritin',value:900,observedAt:'2026-10-01T09:00:00.000Z'})))).toMatch(/lab_attestation_document_unknown/);
 });
 it('the measured fields of an import and of an accepted reading cannot be changed after the fact',async()=>{
  const observation=await accepted();
  await expect(db.query("update clinical_core.lab_observations set value_numeric=81 where id=$1",[observation])).rejects.toThrow(/lab_observation_measurement_immutable/);
  await expect(db.query("update clinical_core.lab_import_events set unit='mg/L' where id=(select import_event_id from clinical_core.lab_observations where id=$1)",[observation])).rejects.toThrow(/lab_import_measurement_immutable/);
  // Review state still moves as it always has.
  await db.query("update clinical_core.lab_observations set review_status='flagged' where id=$1",[observation]);
 });
});

describe('a reviewer attestation: bound to the exact reading, document and reviewer authority',()=>{
 it('verifies the measured value only, never the range, and records who attested with what role',async()=>{
  const observation=await accepted();
  expect(await verified(observation)).toBe(false);
  const result=await attest(attestation(observation));
  expect(result).toMatchObject({outcome:'verified',scope:'measured_value',rangeVerified:false,duplicate:false});
  expect(await verified(observation)).toBe(true);
  const row=(await db.query<Record<string,unknown>>('select reviewer_person_id,reviewer_role,document_sha256,marker_name,unit,statement_version from clinical_core.lab_observation_attestations where id=$1',[result.attestationId])).rows[0];
  expect(row).toEqual({reviewer_person_id:staff,reviewer_role:'practitioner',document_sha256:DOC,marker_name:'Ferritin',unit:'ng/mL',statement_version:'lab-reading-attestation/1'});
  expect(await verification(observation)).toMatchObject({state:'verified',current:result.attestationId,rangeVerified:false});
 });
 it.each([
  ['a different value',{},{value:81}],
  ['a different unit',{},{unit:'ug/L'}],
  ['a different marker',{},{marker:'Iron'}],
  ['a different draw time',{},{observedAt:'2026-10-02T09:00:00.000Z'}],
 ] as const)('refuses %s than the stored reading',async(_name,parts,reading)=>{
  const observation=await accepted();
  expect(await refused(attest(attestation(observation,parts,reading)))).toMatch(/lab_attestation_mismatch/);
  expect(await verified(observation)).toBe(false);
 });
 it('refuses a document the transfer did not record, a client "verified" boolean, a signature, a range claim and a free-text outcome',async()=>{
  const observation=await accepted();
  expect(await refused(attest(attestation(observation,{documentSha256:OTHER_DOC})))).toMatch(/lab_attestation_document_mismatch/);
  for(const extra of [{verified:true},{signature:'Dr. Fictional'},{rangeVerified:true},{referenceRange:{min:30,max:400}}])
   expect(await refused(attest({...attestation(observation),...extra}))).toMatch(/lab_attestation_invalid/);
  expect(await refused(attest(attestation(observation,{outcome:'looks fine'})))).toMatch(/lab_attestation_invalid/);
  expect(await refused(attest(attestation(observation,{},{verified:true})))).toMatch(/lab_attestation_invalid/);
  expect(await verified(observation)).toBe(false);
 });
 it('refuses a staff member without a clinical role, a reviewer from another clinic, a consumer, and a rejected reading',async()=>{
  const observation=await accepted();
  expect(await refused(attest(attestation(observation),assistant))).toMatch(/clinical_role_required/);
  expect(await refused(attest(attestation(observation),outsider,otherOrg))).toMatch(/lab_attestation_refused/);
  expect(await refused(as(consumer,'consumer',org,'select clinical_core.attest_lab_observation($1::jsonb)',[JSON.stringify(attestation(observation))]))).toMatch(/lab_attestation_refused/);
  await db.query("update clinical_core.lab_observations set review_status='rejected' where id=$1",[observation]);
  expect(await refused(attest(attestation(observation)))).toMatch(/lab_attestation_reading_rejected/);
 });
 it('a reading with no recorded document cannot be attested: owner-entered and personally imported readings stay unverified',async()=>{
  for(const origin of ['owner_entered','personal_import']){
   const observation=await accepted(transfer({},{},{origin,documents:[],reportedVerification:'not_recorded'}));
   expect(await refused(attest(attestation(observation)))).toMatch(/lab_attestation_document_unknown/);
   expect(await verified(observation)).toBe(false);
  }
 });
 it('supersedes only by naming the current attestation: a stale view is refused, a refutation ends verification, and history is append-only',async()=>{
  const observation=await accepted();
  const first=await attest(attestation(observation));
  expect(await refused(attest(attestation(observation)))).toMatch(/lab_attestation_stale/);
  const refuted=await attest(attestation(observation,{outcome:'refuted',supersedes:first.attestationId}));
  expect(await verified(observation)).toBe(false);
  expect(await verification(observation)).toMatchObject({state:'refuted',current:refuted.attestationId});
  expect(await refused(attest(attestation(observation,{supersedes:first.attestationId})))).toMatch(/lab_attestation_stale/);
  const again=await attest(attestation(observation,{supersedes:refuted.attestationId}));
  expect(await verified(observation)).toBe(true);
  const history=(await verification(observation)).history as {attestationId:string}[];
  expect(history.map(h=>h.attestationId)).toEqual([again.attestationId,refuted.attestationId,first.attestationId]);
  await expect(db.query("update clinical_core.lab_observation_attestations set outcome='verified' where id=$1",[refuted.attestationId])).rejects.toThrow(/append_only_record/);
  await expect(db.query('delete from clinical_core.lab_observation_attestations where id=$1',[first.attestationId])).rejects.toThrow(/append_only_record/);
 });
 it('a retried request returns its own record; the same request identity with another binding is a conflict',async()=>{
  const observation=await accepted();
  const body=attestation(observation);
  const first=await attest(body);
  expect(await attest(body)).toMatchObject({attestationId:first.attestationId,duplicate:true});
  expect(await refused(attest({...body,outcome:'refuted'}))).toMatch(/lab_attestation_conflict/);
 });
 it('a later rejection of the reading ends its verification without touching the attestation',async()=>{
  const observation=await accepted();
  await attest(attestation(observation));
  await db.query("update clinical_core.lab_observations set review_status='rejected' where id=$1",[observation]);
  expect(await verified(observation)).toBe(false);
 });
});

describe('the Desktop adapter path for lab-result/2 (reached only once the gate is on)',()=>{
 const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>
   tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&'value' in p?(p as {value:unknown}).value:p))});
 })};
 const context=():ProductionClinicalRequestContext=>({actorPersonId:consumer,organizationId:org,identitySubject:subject(consumer),
  identityPool:'consumer',purpose:'clinical_data',environment:'production-clinical',dataClassification:'clinical_phi',
  productionBound:true,containsPhi:true,realPatientData:true});
 it('sends the contract-parsed transfer to the candidate function, which records it unverified and without a status',async()=>{
  const body=transfer();
  expect(labResultTransferV2.parse(body)).toEqual(body);
  const adapter=createAwsProductionClinicalStateAdapter(database);
  const receipt=await adapter.importLabResultV2!(context(),labResultTransferV2.parse(body));
  expect(receipt).toMatchObject({state:'review_pending',duplicate:false});
  const stored=(await db.query<{source_status:string|null;transfer_provenance:{verification:string}}>('select source_status,transfer_provenance from clinical_core.lab_import_events where id=$1',[receipt.eventId])).rows[0]!;
  expect(stored).toMatchObject({source_status:null,transfer_provenance:{verification:'needs_human_review'}});
  await expect(adapter.importLabResultV2!(context(),{...body,result:{...body.result,sourceStatus:'critical'}} as never)).rejects.toMatchObject({category:'request_invalid'});
 });
 it('answers /2 with a lab-import-receipt/2 the V2 journal can match byte for byte: its digest is the sender\'s resourceVersion',async()=>{
  // Built the way the V2 sender builds it: resourceVersion is the SHA-256 of the content in the sender's key order.
  const base=transfer({},{},{documents:[OTHER_DOC,DOC]});
  const content={schemaVersion:base.schemaVersion,source:base.source,panel:base.panel,result:base.result,provenance:{...base.provenance,documents:[DOC,OTHER_DOC]}};
  const resourceVersion=createHash('sha256').update(JSON.stringify(content)).digest('hex');
  const body=labResultTransferV2.parse({...base,resourceVersion,providerEventId:`lab:${'1'.repeat(32)}:${resourceVersion.slice(0,16)}`});
  expect(labResultV2Content(body)).toBe(JSON.stringify(content));
  const receipt=await createAwsProductionClinicalStateAdapter(database).importLabResultV2!(context(),body);
  expect(receipt.receipt).toEqual({version:'lab-import-receipt/2',contract:'lab-result/2',connectionId:connection,providerEventId:body.providerEventId,
   resourceVersion,payloadSha256:resourceVersion,documents:[DOC,OTHER_DOC],verification:'needs_human_review'});
 });
 it('the /2 receipt digest matches the cross-repository golden vector the V2 journal pins too',()=>{
  expect(createHash('sha256').update(labResultV2Content(LAB_RESULT_V2_GOLDEN)).digest('hex')).toBe(LAB_RESULT_V2_GOLDEN_SHA256);
 });
});

describe('the default-disabled attestation adapter',()=>{
 const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
 const evidence=()=>({contract:'lab-attestation-activation/1',enabled:true,target:'production-clinical',
  transferCandidateSha256:LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256,attestationCandidateSha256:LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256,
  evidenceSha256:'e'.repeat(64),reviewedBy:'FICTIONAL REVIEW FIXTURE',reviewedAt:'2026-10-13T00:00:00Z'});
 const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>
   tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&'value' in p?(p as {value:unknown}).value:p))});
 })};
 const reviewer=():ProductionClinicalRequestContext=>({actorPersonId:staff,organizationId:org,identitySubject:subject(staff),identityPool:'workforce',
  purpose:'clinical_data',environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true});
 it('is built against the exact candidates on disk; absent, disabled or mismatched evidence leaves it disabled without touching the database',async()=>{
  expect(sha(TRANSFER)).toBe(LAB_RESULT_TRANSFER_V2_CANDIDATE_SHA256);
  expect(sha(ATTESTATION)).toBe(LAB_OBSERVATION_ATTESTATION_CANDIDATE_SHA256);
  expect(labAttestationActivationState(undefined)).toEqual(DISABLED_LAB_ATTESTATION_ACTIVATION);
  expect(labAttestationActivationState({...evidence(),attestationCandidateSha256:'f'.repeat(64)})).toEqual(DISABLED_LAB_ATTESTATION_ACTIVATION);
  expect(labAttestationActivationState({...evidence(),target:'synthetic-staging'})).toEqual(DISABLED_LAB_ATTESTATION_ACTIVATION);
  const spy:ClinicalCoreDatabase={transaction:(()=>{throw new Error('database touched');}) as ClinicalCoreDatabase['transaction']};
  for(const activation of [undefined,DISABLED_LAB_ATTESTATION_ACTIVATION,{...evidence(),transferCandidateSha256:'f'.repeat(64)}])
   await expect(createLabObservationAttestation({database:spy,activation})(reviewer(),attestation(randomUUID()))).rejects.toMatchObject({category:'activation_refused'});
 });
 it('with evidence naming both candidates, attests through the candidate function; a "verified" boolean is refused before the database',async()=>{
  const observation=await accepted();
  const attest=createLabObservationAttestation({database,activation:evidence()});
  expect(await attest(reviewer(),attestation(observation))).toMatchObject({outcome:'verified',scope:'measured_value',rangeVerified:false,duplicate:false});
  expect(await verified(observation)).toBe(true);
  const spy:ClinicalCoreDatabase={transaction:(()=>{throw new Error('database touched');}) as ClinicalCoreDatabase['transaction']};
  await expect(createLabObservationAttestation({database:spy,activation:evidence()})(reviewer(),{...attestation(observation),verified:true})).rejects.toMatchObject({category:'request_invalid'});
  await expect(attest({...reviewer(),identityPool:'consumer',actorPersonId:consumer,identitySubject:subject(consumer)},attestation(observation))).rejects.toMatchObject({category:'identity_refused'});
  await expect(attest(reviewer(),attestation(observation))).rejects.toMatchObject({category:'conflict',reason:'lab_attestation_stale'});
 });
});
