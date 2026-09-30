import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

/**
 * Owner export and erasure for the consult-request and pre-visit-form domains.
 *
 * The domains shipped with no lifecycle, which is the same failure the messaging domains had:
 * an owner asking for a copy would have been handed messages and programs and told that was
 * everything, while their intake answers, their signatures and the request that first reached
 * the clinic sat outside it.
 *
 * The assertions that matter most are about what is *kept* and whether the answer says so. A
 * domain erase that silently destroyed a signed consent, or silently kept answers while
 * reporting them erased, would both be worse than refusing.
 */
const id=(n:number)=>'90000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),clinician=id(2),owner=id(3),other=id(4);
const patient=id(5),connection=id(6),otherPatient=id(7),otherConnection=id(8),link=id(9);
let db:PGlite;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

// The lifecycle functions run under `consent_management` and the domain functions under
// `clinical_data`; the purpose follows the function rather than the pool, because that is how
// each one asserts its context.
const purposeFor=(fn:string)=>fn.startsWith('care_data')?'consent_management':'clinical_data';
async function rpc(fn:string,request:unknown,actor=owner,pool:'workforce'|'consumer'='consumer'){
 return db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
   [actor,org,pool,'subject-'+actor,purposeFor(fn),'synthetic-staging','synthetic_only']);
  const {rows}=await tx.query<{data:Record<string,unknown>}>(
   `select clinical_core.${fn}($1::jsonb) as data`,[JSON.stringify(request)]);
  return rows[0].data;
 });
}
/** The clinic's own calls need `clinical_data`, so they get their own helper. */
const asClinic=(fn:string,request:unknown)=>rpc(fn,request,clinician,'workforce');
const exportSection=(section:string)=>rpc('care_data_export',{action:'export',section});

const QUESTIONNAIRE={sections:[{id:'history',title:'Your history',questions:[
 {id:'goal',prompt:'What brings you in?',type:'single_choice',required:true,
  options:[{value:'fatigue',label:'Fatigue'},{value:'thyroid',label:'Thyroid'}]},
]}]};
const DOCUMENT={body:[{heading:'Telehealth consent',paragraphs:['Fictional consent text.']}],
 agreement:{statement:'I have read this fictional consent document and I agree to it.',requiresTypedName:true}};
const AGREEMENT=digest(DOCUMENT.agreement.statement);

async function publish(formKey:string,kind:'questionnaire'|'consent_document',content:unknown){
 const drafted=await asClinic('intake_form_admin',{action:'draft',formKey,title:'Fictional '+formKey,kind,content});
 return asClinic('intake_form_admin',{action:'publish',formVersionId:drafted.formVersionId});
}
/** A packet with both a questionnaire and a document, answered and signed. */
async function completedPacket(suffix:string){
 const questionnaire=await publish('history-'+suffix,'questionnaire',QUESTIONNAIRE);
 const consent=await publish('consent-'+suffix,'consent_document',DOCUMENT);
 const packet=await asClinic('intake_packet_workforce',{action:'assign',connectionId:connection,
  label:'Before your visit '+suffix,
  forms:[{formVersionId:questionnaire.formVersionId,required:true},
   {formVersionId:consent.formVersionId,required:true}]});
 const opened=await rpc('intake_packet_consumer',{action:'open',packetId:packet.packetId});
 const items=opened.items as Array<Record<string,string>>;
 await rpc('intake_packet_consumer',{action:'submit',packetId:packet.packetId,itemId:items[0].itemId,
  contentSha256:items[0].contentSha256,answers:{goal:'fatigue'}});
 await rpc('intake_packet_consumer',{action:'sign',packetId:packet.packetId,itemId:items[1].itemId,
  contentSha256:items[1].contentSha256,agreementSha256:AGREEMENT,signerName:'Fictional Owner',
  signerNameDigest:digest('Fictional Owner'),signerAuthority:'self'});
 return packet.packetId as string;
}
/** A converted consult request, which is the only kind an account can reach. */
async function convertedRequest(email:string){
 const submitted=await db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  const {rows}=await tx.query<{data:Record<string,unknown>}>(
   'select clinical_core.consult_intake_public($1::jsonb) as data',
   [JSON.stringify({action:'submit',slug:'fictional-longevity',
     contact:{ciphertext:Buffer.from(email).toString('base64'),iv:'AAAAAAAAAAAAAAAA',tag:'AAAAAAAAAAAAAAAAAAAAAAA='},
     contactDigest:digest(email),visitType:'initial',reasonCode:'new_consultation'})]);
  return rows[0].data;
 });
 const listed=await asClinic('consult_request_review',{action:'list',status:'received'});
 const entry=(listed.requests as Array<Record<string,string>>)
  .find(request=>request.reference===submitted.reference)!;
 const accepted=await asClinic('consult_request_review',{action:'accept',requestId:entry.requestId,
  expectedRevision:entry.revision});
 // Conversion makes a fresh record and connection; the fixture then points it at the owner's
 // own connection, because that is the link an account actually reaches its request through.
 const converted=await asClinic('consult_request_review',{action:'convert',requestId:entry.requestId,
  expectedRevision:accepted.revision,syntheticRecordKey:'patient_syn_'+digest(email).slice(0,16)});
 await db.query('update clinical_core.consult_requests set connection_id=$2,patient_record_id=$3 where id=$1',
  [entry.requestId,connection,patient]);
 return {requestId:entry.requestId as string,connectionId:converted.connectionId as string};
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
 await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_lifecycle_001'),($3,$2,'patient_syn_lifecycle_002')",
  [patient,org,otherPatient]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now()),($5,$2,$6,$7,'verified',now())",
  [connection,org,patient,owner,otherConnection,otherPatient,other]);
 for(const [record,conn] of [[patient,connection],[otherPatient,otherConnection]]){
  const {rows}=await db.query<{id:string}>("insert into clinical_core.consent_artifacts(organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,'forms_checkins',$2,$3,'US-CA','approved',now(),$4) returning id",
   [org,'v-'+conn,digest('artifact-'+conn),clinician]);
  await db.query("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'forms_checkins','granted','patient_app','self',1,$5)",
   [org,record,conn,rows[0].id,clinician]);
 }
 await db.query("insert into clinical_core.consult_links(id,organization_id,slug,label,visit_types,reason_codes,created_by_person_id) values($1,$2,'fictional-longevity','New patient consult','{initial}','{new_consultation}',$3)",
  [link,org,clinician]);
},90000);
afterAll(async()=>{await db?.close();});

beforeEach(async()=>{
 // Append-only tables refuse ordinary deletes, so a reset has to suspend the triggers. This
 // is the only place that is acceptable, and it is why it is scoped to the reset.
 await db.exec("set session_replication_role = 'replica'");
 for(const table of ['document_signatures','intake_form_responses','intake_packet_items','intake_packets',
  'consult_requests','care_data_erasures']){
  await db.query('delete from clinical_core.'+table);
 }
 await db.query('delete from clinical_core.intake_form_versions');
 await db.exec("set session_replication_role = 'origin'");
});

describe('owner lifecycle for intake forms and consult requests: real migration SQL',()=>{
 it('puts the packet, the answers, the signed document and the request in the owner export',async()=>{
  await completedPacket('export');
  const {requestId}=await convertedRequest('export@example.invalid');

  const packets=await exportSection('intake_packets');
  expect(packets.items).toHaveLength(1);
  const packet=(packets.items as Array<Record<string,unknown>>)[0];
  expect(packet).toMatchObject({label:'Before your visit export',status:'completed'});
  expect(packet.forms).toHaveLength(2);

  const answers=await exportSection('intake_responses');
  expect(answers.items).toHaveLength(1);
  expect((answers.items as Array<Record<string,unknown>>)[0]).toMatchObject({answers:{goal:'fatigue'}});

  const signatures=await exportSection('signatures');
  expect(signatures.items).toHaveLength(1);
  const signature=(signatures.items as Array<Record<string,unknown>>)[0];
  // A copy of what they signed, not merely proof that they did: the sentence and the document
  // body both travel, or the owner can show nobody anything.
  expect(signature).toMatchObject({signerName:'Fictional Owner',signerAuthority:'self',
   agreementStatement:DOCUMENT.agreement.statement,agreementSha256:AGREEMENT});
  expect(signature.document).toMatchObject({agreement:{statement:DOCUMENT.agreement.statement}});

  const requests=await exportSection('consult_requests');
  expect(requests.items).toHaveLength(1);
  expect((requests.items as Array<Record<string,unknown>>)[0])
   .toMatchObject({requestId,visitType:'initial',reasonCode:'new_consultation',status:'converted'});
  // The sealed contact is not in the export, because this database cannot open it and a
  // ciphertext is not a copy of anything the owner can read.
  expect(JSON.stringify(requests.items)).not.toContain('ciphertext');
 });

 it('shows an owner only their own records, not another patient of the same clinic',async()=>{
  await completedPacket('isolation');
  for(const section of ['intake_packets','intake_responses','signatures','consult_requests']){
   const mine=await rpc('care_data_export',{action:'export',section},other);
   expect(mine.items).toEqual([]);
  }
 });

 it('erases answers, keeps the signature and the packet, and says which and why',async()=>{
  await completedPacket('domain');
  const erased=await rpc('care_data_erase',{action:'erase',scope:'domain'});
  expect(erased).toMatchObject({scope:'domain',responsesErased:1,
   signaturesRetained:1,signaturesErased:0,packetsRetained:1,packetsErased:0,consultRequestsErased:0,
   signaturesRetainedReason:'signature_is_the_recorded_basis_for_care_already_given',
   packetsRetainedReason:'packet_is_the_clinic_record_of_what_was_asked'});
  // And the claim is true, not just reported.
  expect(await exportSection('intake_responses')).toMatchObject({items:[]});
  expect((await exportSection('signatures')).items).toHaveLength(1);
  expect((await exportSection('intake_packets')).items).toHaveLength(1);
 });

 it('removes the signature, the packet and the request only when the account closes',async()=>{
  await completedPacket('closure');
  await convertedRequest('closure@example.invalid');
  const closed=await rpc('care_data_erase',{action:'erase',scope:'account_closure'});
  expect(closed).toMatchObject({scope:'account_closure',responsesErased:1,signaturesErased:1,
   signaturesRetained:0,packetsErased:1,packetsRetained:0,consultRequestsErased:1,
   signaturesRetainedReason:null,packetsRetainedReason:null});
  for(const section of ['intake_packets','intake_responses','signatures','consult_requests']){
   expect(await exportSection(section)).toMatchObject({items:[]});
  }
 });

 it('records the new counts in the owner’s own erasure history',async()=>{
  await completedPacket('history');
  await rpc('care_data_erase',{action:'erase',scope:'domain'});
  const history=await rpc('care_data_erasure_history',{action:'erasure_history'});
  expect((history.erasures as Array<Record<string,unknown>>)[0]).toMatchObject({scope:'domain',
   responsesErased:1,signaturesRetained:1,packetsRetained:1,consultRequestsErased:0});
 });

 it('still refuses an ordinary delete or update outside an erasure',async()=>{
  await completedPacket('immutable');
  await expect(db.query('delete from clinical_core.document_signatures')).rejects.toThrow(/append_only_record/);
  await expect(db.query('delete from clinical_core.intake_form_responses')).rejects.toThrow(/append_only_record/);
  await expect(db.query("update clinical_core.document_signatures set signer_name='Someone Else'"))
   .rejects.toThrow(/append_only_record/);
  await convertedRequest('immutable@example.invalid');
  await expect(db.query('delete from clinical_core.consult_requests')).rejects.toThrow(/append_only_record/);
  await expect(db.query("update clinical_core.consult_requests set visit_type='urgent_question'"))
   .rejects.toThrow(/consult_request_immutable/);
 });

 it('lets the audit release a reference to a deleted request, and nothing else',async()=>{
  await convertedRequest('audit@example.invalid');
  // Every other update on the audit stays refused, so narrowing that refusal for the one
  // case the closure needs has not made the audit editable.
  await expect(db.query("update clinical_core.consult_request_audit set action='request_declined'"))
   .rejects.toThrow(/append_only_record/);
  await expect(db.query('update clinical_core.consult_request_audit set actor_id=null'))
   .rejects.toThrow(/append_only_record/);
  await expect(db.query('delete from clinical_core.consult_request_audit'))
   .rejects.toThrow(/append_only_record/);
  const before=await db.query<{count:number}>('select count(*) as count from clinical_core.consult_request_audit');
  await rpc('care_data_erase',{action:'erase',scope:'account_closure'});
  const after=await db.query<{count:number}>('select count(*) as count from clinical_core.consult_request_audit');
  // The rows survive the closure; only their pointer to the gone request is released.
  expect(after.rows[0].count).toBe(before.rows[0].count);
  const orphaned=await db.query<{count:number}>(
   'select count(*) as count from clinical_core.consult_request_audit where request_id is null');
  expect(Number(orphaned.rows[0].count)).toBeGreaterThan(0);
 });

 it('leaves another owner’s records alone when one owner closes their account',async()=>{
  await completedPacket('neighbour');
  const questionnaire=await publish('history-neighbour-2','questionnaire',QUESTIONNAIRE);
  const theirs=await asClinic('intake_packet_workforce',{action:'assign',connectionId:otherConnection,
   label:'Their packet',forms:[{formVersionId:questionnaire.formVersionId,required:true}]});
  const opened=await rpc('intake_packet_consumer',{action:'open',packetId:theirs.packetId},other);
  const items=opened.items as Array<Record<string,string>>;
  await rpc('intake_packet_consumer',{action:'submit',packetId:theirs.packetId,itemId:items[0].itemId,
   contentSha256:items[0].contentSha256,answers:{goal:'thyroid'}},other);

  await rpc('care_data_erase',{action:'erase',scope:'account_closure'});
  const neighbour=await rpc('care_data_export',{action:'export',section:'intake_responses'},other);
  expect(neighbour.items).toHaveLength(1);
  expect((neighbour.items as Array<Record<string,unknown>>)[0]).toMatchObject({answers:{goal:'thyroid'}});
 });
});
