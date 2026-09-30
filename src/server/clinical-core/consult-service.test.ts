import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {createPublicConsultIntake,createConsultLinkAdmin,createConsultRequestReview,ConsultRequestError} from './consult-requests';
import {createIntakeFormAdmin,createIntakePacketWorkforce,createIntakePacketConsumer,IntakeFormError} from './intake-forms';
import {consultContactBinding,contactDigestFor,openVisitorContact,prepareConsultSubmission,
 seal,typedNameDigestFor} from '../consult/consultContactEnvelope';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {ClinicalRequestContext} from './aws-identity-consent';

/**
 * The services, the sealing and the database together.
 *
 * The assertion that matters most is negative: every parameter sent to the database is
 * captured, and the visitor's name and address must not appear in any of them. A sealing
 * step that is bypassed on one path is worse than no sealing at all, because the rows look
 * safe and one of them is not.
 */
const id=(n:number)=>'80000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),clinician=id(2),consumer=id(3),patient=id(4),connection=id(5);
const key=randomBytes(32);
const VISITOR={name:'Fictional Visitor','email':'Visitor.One@Example.Invalid ',phone:'+1 555 0100'};
let db:PGlite;
const sent:string[]=[];

// The deployed driver classifies by the authored marker in the SQL error message, so the
// harness must do the same or it would report a refusal as a fault and hide it.
const CATEGORY:Array<[RegExp,ClinicalCoreDatabaseRejection['category']]>=[
 [/\b(consult_request_invalid|consult_link_invalid|consult_review_invalid|intake_form_invalid|intake_packet_invalid|intake_form_content_invalid|intake_answers_invalid|intake_item_not_questionnaire|intake_item_not_document)\b/,'request_invalid'],
 [/\b(consult_request_forbidden|intake_packet_forbidden)\b/,'identity_refused'],
 [/\bintake_consent_absent\b/,'consent_required'],
 [/\b(consult_link_unavailable|consult_request_unavailable|consult_link_absent|consult_request_absent|consult_request_immutable|intake_form_unpublished|intake_form_absent|intake_packet_absent|intake_item_absent|intake_form_immutable|intake_connection_absent|intake_connection_unavailable)\b/,'operation_refused'],
 [/\b(consult_link_closed|consult_link_slug_taken|consult_record_key_taken|consult_reference_unavailable|consult_request_state_invalid|consult_request_revision_stale|intake_form_not_draft|intake_form_not_published|intake_packet_state_invalid|intake_packet_revision_stale|intake_packet_past_due|intake_response_recorded|intake_signature_recorded|intake_form_changed|intake_agreement_changed)\b/,'conflict'],
];
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role clinical_core_api');
 return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
  const values=parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p);
  for(const value of values)if(typeof value==='string')sent.push(value);
  try{return await tx.query<Row>(sql,values);}
  catch(cause){
   const text=cause instanceof Error?cause.message:String(cause);
   const found=CATEGORY.find(([pattern])=>pattern.test(text));
   throw new ClinicalCoreDatabaseRejection(found?found[1]:'identity_refused');
  }
 }});
})};
const context=(actor:string,pool:'workforce'|'consumer'):ClinicalRequestContext=>({
 actorPersonId:actor,organizationId:org,identityPool:pool,identitySubject:'subject-'+actor,
 purpose:'clinical_data',environment:'synthetic-staging',dataClassification:'synthetic_only',
 containsPhi:false,realPatientData:false});
const intake=createPublicConsultIntake(database);
const links=createConsultLinkAdmin(database);
const review=createConsultRequestReview(database);
const forms=createIntakeFormAdmin(database);
const packets=createIntakePacketWorkforce(database);
const mine=createIntakePacketConsumer(database);
const asClinic=<T>(call:(c:ClinicalRequestContext,b:unknown)=>Promise<T>)=>(body:unknown)=>call(context(clinician,'workforce'),body);
const asPatient=<T>(call:(c:ClinicalRequestContext,b:unknown)=>Promise<T>)=>(body:unknown)=>call(context(consumer,'consumer'),body);

const DOCUMENT={body:[{heading:'Telehealth consent',paragraphs:['Fictional consent text.']}],
 agreement:{statement:'I have read this fictional consent document and I agree to it.',requiresTypedName:true as const}};

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional Longevity Clinic')",[org]);
 for(const [person,pool] of [[clinician,'workforce'],[consumer,'consumer']]){
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[person,'syn_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)',[person,pool,'subject-'+person]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,clinician]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_service_0001')",[patient,org]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",[connection,org,patient,consumer]);
 const {rows}=await db.query<{id:string}>("insert into clinical_core.consent_artifacts(organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,'forms_checkins','1',$2,'US-CA','approved',now(),$3) returning id",
  [org,createHash('sha256').update('artifact').digest('hex'),clinician]);
 await db.query("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'forms_checkins','granted','patient_app','self',1,$5)",
  [org,patient,connection,rows[0].id,clinician]);
 await asClinic(links)({action:'create',slug:'fictional-longevity',label:'New patient consult',
  visitTypes:['initial'],reasonCodes:['new_consultation','lab_review']});
},90000);
afterAll(async()=>{await db?.close();});

describe('consult request service: real services, sealing and PostgreSQL',()=>{
 it('seals the visitor contact before it reaches the database and gives it back to the clinic',async()=>{
  const prepared=prepareConsultSubmission(key,{action:'submit',slug:'fictional-longevity',
   name:VISITOR.name,email:VISITOR.email,phone:VISITOR.phone,visitType:'initial',
   reasonCode:'new_consultation',preferredWindows:[],timeZone:'America/Los_Angeles'});
  if(prepared.action!=='submit')throw new Error('unexpected');
  // The address is normalised before it is hashed, because the same person types it both ways.
  expect(prepared.contactDigest).toBe(contactDigestFor('visitor.one@example.invalid'));
  const submitted=await intake(prepared);
  if(submitted.action!=='submit'||submitted.outcome!=='received')throw new Error('unexpected');
  const everything=sent.join('\u0000');
  expect(everything).not.toContain('Fictional Visitor');
  expect(everything.toLowerCase()).not.toContain('visitor.one@example.invalid');
  expect(everything).not.toContain('555 0100');

  const listed=await asClinic(review)({action:'list',status:'received'});
  if(listed.action!=='list')throw new Error('unexpected');
  const entry=listed.requests.find(request=>request.reference===submitted.reference)!;
  const opened=await asClinic(review)({action:'open',requestId:entry.requestId});
  if(opened.action!=='open')throw new Error('unexpected');
  expect(openVisitorContact(key,opened)).toEqual({name:'Fictional Visitor',
   email:'visitor.one@example.invalid',phone:'+1 555 0100'});
 });

 it('will not open an envelope that was sealed for a different request',async()=>{
  const digest=contactDigestFor('elsewhere@example.invalid');
  const foreign=seal(key,consultContactBinding('another-clinic',digest),
   JSON.stringify({name:'Fictional Elsewhere',email:'elsewhere@example.invalid',phone:null}));
  expect(()=>openVisitorContact(key,{slug:'fictional-longevity',contactDigest:digest,contact:foreign}))
   .toThrow(/not_authentic/);
 });

 it('refuses a submission the contract does not describe, before any database call',async()=>{
  const before=sent.length;
  await expect(intake({action:'submit',slug:'fictional-longevity',symptoms:'chest pain'}))
   .rejects.toBeInstanceOf(ConsultRequestError);
  await expect(intake({action:'describe',slug:'Not A Slug'})).rejects.toMatchObject({category:'request_invalid'});
  expect(sent.length).toBe(before);
 });

 it('answers an unavailable link as a refusal about the object, not a fault',async()=>{
  await expect(intake({action:'describe',slug:'never-published'}))
   .rejects.toMatchObject({category:'operation_refused'});
 });

 it('keeps the clinic vocabulary away from a patient session and the reverse',async()=>{
  await expect(review(context(consumer,'consumer'),{action:'list'}))
   .rejects.toMatchObject({category:'identity_refused'});
  await expect(mine(context(clinician,'workforce'),{action:'list'}))
   .rejects.toBeInstanceOf(IntakeFormError);
 });
});

describe('intake packet service: real services, sealing and PostgreSQL',()=>{
 it('records a signature bound to the sentence agreed to, under the name the patient typed',async()=>{
  const drafted=await asClinic(forms)({action:'draft',formKey:'telehealth-consent',
   title:'Telehealth consent',kind:'consent_document',content:DOCUMENT});
  if(drafted.action!=='draft')throw new Error('unexpected');
  const published=await asClinic(forms)({action:'publish',formVersionId:drafted.formVersionId});
  if(published.action!=='publish')throw new Error('unexpected');
  const packet=await asClinic(packets)({action:'assign',connectionId:connection,label:'Before your visit',
   forms:[{formVersionId:published.formVersionId,required:true}]});
  if(packet.action!=='assign')throw new Error('unexpected');
  const opened=await asPatient(mine)({action:'open',packetId:packet.packetId});
  if(opened.action!=='open')throw new Error('unexpected');
  const item=opened.items[0];
  expect(item.kind).toBe('consent_document');
  expect(item.agreementSha256).not.toBeNull();

  const sign=(over:Record<string,unknown>={})=>asPatient(mine)({action:'sign',packetId:packet.packetId,
   itemId:item.itemId,contentSha256:item.contentSha256,agreementSha256:item.agreementSha256!,
   signerName:'Fictional Patient',signerNameDigest:typedNameDigestFor('Fictional Patient'),
   signerAuthority:'self',...over});
  // The digest must be of the name that arrived, or the record would name one person and
  // attest to another.
  await expect(sign({signerNameDigest:typedNameDigestFor('Someone Else')}))
   .rejects.toMatchObject({category:'request_invalid'});
  const signed=await sign();
  if(signed.action!=='sign')throw new Error('unexpected');
  expect(signed.packetStatus).toBe('completed');

  const read=await asClinic(packets)({action:'open',packetId:packet.packetId});
  if(read.action!=='open')throw new Error('unexpected');
  expect(read.items[0].signature).toMatchObject({authority:'self',signerName:'Fictional Patient',
   signerNameDigest:typedNameDigestFor('Fictional Patient')});
 });

 it('refuses a packet for a connection with no granted forms consent',async()=>{
  const other=id(11),otherPatient=id(12);
  await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_service_0002')",[otherPatient,org]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,state) values($1,$2,$3,'invitation_pending')",[other,org,otherPatient]);
  const drafted=await asClinic(forms)({action:'draft',formKey:'consent-two',title:'Consent two',
   kind:'consent_document',content:DOCUMENT});
  if(drafted.action!=='draft')throw new Error('unexpected');
  const published=await asClinic(forms)({action:'publish',formVersionId:drafted.formVersionId});
  if(published.action!=='publish')throw new Error('unexpected');
  await expect(packets(context(clinician,'workforce'),{action:'assign',connectionId:other,
   label:'No consent',forms:[{formVersionId:published.formVersionId,required:true}]}))
   .rejects.toMatchObject({category:'consent_required'});
 });
});
