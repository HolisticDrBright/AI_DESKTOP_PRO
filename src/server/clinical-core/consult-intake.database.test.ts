import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

/**
 * The public consult link, the requests it produces, and the pre-visit paperwork.
 *
 * These run the real migration SQL, because everything worth asserting here is a refusal
 * the database makes: an unauthenticated surface that must not become a way to enumerate
 * clinics or to write narrative health information; a packet that must never deliver an
 * unpublished draft; and a signature that must be bound to the exact sentence the patient
 * was shown rather than to whatever the clinic later says the document contained.
 */
const id=(n:number)=>'70000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),otherOrg=id(2),clinician=id(3),outsider=id(4),consumer=id(5),stranger=id(6);
const patient=id(7),connection=id(8),unconsented=id(9),unconsentedPatient=id(10);
let db:PGlite;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const envelope=(value:string)=>({ciphertext:Buffer.from(value).toString('base64'),
 iv:'AAAAAAAAAAAAAAAA',tag:'AAAAAAAAAAAAAAAAAAAAAAA='});

/** A call with no request context at all, which is what a visitor has. */
async function pub(request:unknown){
 return db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  const {rows}=await tx.query<{data:Record<string,unknown>}>(
   'select clinical_core.consult_intake_public($1::jsonb) as data',[JSON.stringify(request)]);
  return rows[0].data;
 });
}
/** A call as a verified member of a pool, through the same context every service uses. */
async function rpc(fn:string,request:unknown,actor=clinician,pool:'workforce'|'consumer'='workforce',organization=org){
 return db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
   [actor,organization,pool,'subject-'+actor,'clinical_data','synthetic-staging','synthetic_only']);
  const {rows}=await tx.query<{data:Record<string,unknown>}>(
   `select clinical_core.${fn}($1::jsonb) as data`,[JSON.stringify(request)]);
  return rows[0].data;
 });
}
/**
 * A jsonb row, read without claiming to know its type.
 *
 * These come back from the database as JSON, so they are typed as JSON and read through
 * `dig` rather than cast to `any`: an assertion that reads a field the server stopped
 * sending should fail here, not silently compare undefined to undefined.
 */
type JsonValue=string|number|boolean|null|JsonValue[]|{[key:string]:JsonValue};
type JsonRow={[key:string]:JsonValue};
function dig(value:JsonValue|undefined,...path:Array<string|number>):JsonValue|undefined{
 let current:JsonValue|undefined=value;
 for(const key of path){
  if(current===null||current===undefined||typeof current!=='object')return undefined;
  current=Array.isArray(current)?current[Number(key)]:current[String(key)];
 }
 return current;
}
const message=async(work:Promise<unknown>)=>{
 try{await work;return 'resolved';}catch(cause){return cause instanceof Error?cause.message:String(cause);}
};

const QUESTIONNAIRE={sections:[{id:'history',title:'Your history',questions:[
 {id:'goal',prompt:'What brings you in?',type:'single_choice',required:true,
  options:[{value:'fatigue',label:'Fatigue'},{value:'thyroid',label:'Thyroid'}]},
 {id:'sleep',prompt:'Nights of poor sleep each week',type:'scale',required:true,min:0,max:7},
 {id:'supplements',prompt:'Which do you take?',type:'multi_choice',required:false,
  options:[{value:'magnesium',label:'Magnesium'},{value:'vitamin_d',label:'Vitamin D'}]},
 {id:'notes',prompt:'Anything else',type:'short_text',required:false,maxLength:200},
 {id:'first_visit',prompt:'Is this your first visit?',type:'boolean',required:true},
]}]};
const DOCUMENT={body:[{heading:'Telehealth consent',paragraphs:['Fictional consent text for a synthetic clinic.']}],
 agreement:{statement:'I have read this fictional consent document and I agree to it.',requiresTypedName:true}};
const ANSWERS={goal:'fatigue',sleep:3,first_visit:false};

async function publishForm(kind:'questionnaire'|'consent_document',content:unknown,formKey:string){
 const drafted=await rpc('intake_form_admin',{action:'draft',formKey,title:'Fictional '+formKey,kind,content});
 const published=await rpc('intake_form_admin',{action:'publish',formVersionId:drafted.formVersionId});
 return published as {formVersionId:string;contentSha256:string};
}

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional Longevity Clinic'),($2,'Fictional Other Clinic')",[org,otherOrg]);
 for(const [person,pool] of [[clinician,'workforce'],[outsider,'workforce'],[consumer,'consumer'],[stranger,'consumer']]){
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[person,'syn_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)',[person,pool,'subject-'+person]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($3,$4,'practitioner')",[org,clinician,otherOrg,outsider]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_consult_0001'),($3,$2,'patient_syn_consult_0002')",[patient,org,unconsentedPatient]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now()),($5,$2,$6,$7,'verified',now())",
  [connection,org,patient,consumer,unconsented,unconsentedPatient,stranger]);
 // Only the first connection has a granted forms consent, so the refusal has something to
 // refuse and the acceptance has something to accept.
 const {rows}=await db.query<{id:string}>("insert into clinical_core.consent_artifacts(organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,'forms_checkins','1',$2,'US-CA','approved',now(),$3) returning id",
  [org,digest('forms-artifact'),clinician]);
 await db.query("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'forms_checkins','granted','patient_app','self',1,$5)",
  [org,patient,connection,rows[0].id,clinician]);
 await rpc('consult_link_admin',{action:'create',slug:'fictional-longevity',label:'New patient consult',
  visitTypes:['initial','follow_up'],reasonCodes:['new_consultation','lab_review']});
},90000);
afterAll(async()=>{await db?.close();});

describe('public consult link: real migration SQL, not hosted AWS',()=>{
 it('describes only what the clinic published on the link',async()=>{
  const described=await pub({action:'describe',slug:'fictional-longevity'});
  expect(described).toMatchObject({action:'describe',slug:'fictional-longevity',
   clinic:'Fictional Longevity Clinic',label:'New patient consult',acceptingRequests:true});
  expect(described.visitTypes).toEqual(['initial','follow_up']);
  expect(described.reasonCodes).toEqual(['new_consultation','lab_review']);
  // Nothing about patients, practitioners or availability reaches an unauthenticated caller.
  expect(Object.keys(described).sort()).toEqual(
   ['acceptingRequests','action','clinic','label','reasonCodes','slug','visitTypes']);
 });

 it('gives one answer for absent, disabled and expired links so a prober learns nothing',async()=>{
  const unknown=await message(pub({action:'describe',slug:'no-such-clinic'}));
  expect(unknown).toMatch(/consult_link_unavailable/);
  const created=await rpc('consult_link_admin',{action:'create',slug:'temporary-link',label:'Temporary',
   visitTypes:['initial'],reasonCodes:['new_consultation']});
  await rpc('consult_link_admin',{action:'disable',linkId:created.linkId});
  expect(await message(pub({action:'describe',slug:'temporary-link'}))).toMatch(/consult_link_unavailable/);
  const expired=await rpc('consult_link_admin',{action:'create',slug:'expired-link',label:'Expired',
   visitTypes:['initial'],reasonCodes:['new_consultation']});
  await rpc('consult_link_admin',{action:'update',linkId:expired.linkId,expiresAt:'2026-01-01T00:00:00.000Z'});
  expect(await message(pub({action:'describe',slug:'expired-link'}))).toMatch(/consult_link_unavailable/);
 });

 it('accepts a request, shows it in the clinic queue and converts it to a chart',async()=>{
  const contact=digest('visitor-one@example.invalid');
  const submitted=await pub({action:'submit',slug:'fictional-longevity',contact:envelope('Fictional Visitor One'),
   contactDigest:contact,visitType:'initial',reasonCode:'new_consultation',
   preferredWindows:[{from:'2026-10-12T16:00:00.000Z',to:'2026-10-12T20:00:00.000Z'}],timeZone:'America/Los_Angeles'});
  expect(submitted).toMatchObject({action:'submit',outcome:'received',status:'received'});
  expect(submitted.reference).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
  const listed=await rpc('consult_request_review',{action:'list',status:'received'});
  const entry=(listed.requests as Array<Record<string,unknown>>).find(r=>r.reference===submitted.reference);
  expect(entry).toMatchObject({visitType:'initial',reasonCode:'new_consultation',status:'received',
   slug:'fictional-longevity',timeZone:'America/Los_Angeles'});
  // The queue carries no contact details. Opening the envelope is a separate, recorded act.
  expect(Object.keys(entry!)).not.toContain('contact');
  const opened=await rpc('consult_request_review',{action:'open',requestId:entry!.requestId});
  expect(Buffer.from((opened.contact as {ciphertext:string}).ciphertext,'base64').toString('utf8'))
   .toBe('Fictional Visitor One');
  expect(await db.query<{count:string}>(
   "select count(*) as count from clinical_core.consult_request_audit where action='contact_opened'"))
   .toMatchObject({rows:[{count:1}]});
  const accepted=await rpc('consult_request_review',{action:'accept',requestId:entry!.requestId,
   expectedRevision:entry!.revision});
  expect(accepted).toMatchObject({action:'accept',status:'accepted'});
  const converted=await rpc('consult_request_review',{action:'convert',requestId:entry!.requestId,
   expectedRevision:accepted.revision,syntheticRecordKey:'patient_syn_from_link_01'});
  expect(converted).toMatchObject({action:'convert',status:'converted'});
  const {rows}=await db.query<{state:string}>('select state from clinical_core.patient_connections where id=$1',
   [converted.connectionId]);
  // A converted request produces a chart and a link waiting for an invitation, not a
  // verified connection: nobody has proved they are this person yet.
  expect(rows[0].state).toBe('invitation_pending');
 });

 it('refuses a visit type or reason the link does not offer, and free-text fields it never declared',async()=>{
  const base={action:'submit',slug:'fictional-longevity',contact:envelope('Fictional Visitor Two'),
   contactDigest:digest('visitor-two@example.invalid'),visitType:'initial',reasonCode:'new_consultation'};
  expect(await message(pub({...base,visitType:'urgent_question'}))).toMatch(/consult_request_invalid/);
  expect(await message(pub({...base,reasonCode:'insurance_question'}))).toMatch(/consult_request_invalid/);
  // The public form has no narrative field, and a caller cannot invent one.
  expect(await message(pub({...base,symptoms:'chest pain since Tuesday'}))).toMatch(/consult_request_invalid/);
  expect(await message(pub({...base,preferredWindows:[{from:'2026-10-12T20:00:00.000Z',to:'2026-10-12T16:00:00.000Z'}]})))
   .toMatch(/consult_request_invalid/);
  expect(await message(pub({...base,preferredWindows:[{from:'2026-10-12T16:00:00.000Z',to:'2026-10-12T16:00:00.000Z',note:'urgent'}]})))
   .toMatch(/consult_request_invalid/);
 });

 it('throttles repeat submissions from one contact and refuses a closed link',async()=>{
  const contact=digest('repeat@example.invalid');
  const submit=()=>pub({action:'submit',slug:'fictional-longevity',contact:envelope('Fictional Repeat'),
   contactDigest:contact,visitType:'follow_up',reasonCode:'lab_review'});
  await submit();await submit();await submit();
  // Returned rather than raised, so the throttle is still recorded: a raise would roll the
  // audit row back with it and an unauthenticated endpoint's limiter would leave no trace.
  expect(await submit()).toMatchObject({action:'submit',outcome:'throttled',reference:null});
  expect(await db.query<{count:number}>(
   "select count(*) as count from clinical_core.consult_request_audit where action='request_throttled'"))
   .toMatchObject({rows:[{count:1}]});
  expect(await db.query<{count:number}>(
   'select count(*) as count from clinical_core.consult_requests where contact_digest=$1',[contact]))
   .toMatchObject({rows:[{count:3}]});
  const created=await rpc('consult_link_admin',{action:'create',slug:'closed-link',label:'Closed',
   visitTypes:['initial'],reasonCodes:['new_consultation']});
  await rpc('consult_link_admin',{action:'update',linkId:created.linkId,acceptingRequests:false});
  expect(await message(pub({action:'submit',slug:'closed-link',contact:envelope('Fictional Three'),
   contactDigest:digest('three@example.invalid'),visitType:'initial',reasonCode:'new_consultation'})))
   .toMatch(/consult_link_closed/);
 });

 it('lets a visitor withdraw with the reference and their own contact, and nobody else',async()=>{
  const contact=digest('withdrawer@example.invalid');
  const submitted=await pub({action:'submit',slug:'fictional-longevity',contact:envelope('Fictional Withdrawer'),
   contactDigest:contact,visitType:'initial',reasonCode:'new_consultation'});
  // A guessed reference must not confirm itself: the wrong contact is the same answer as
  // a wrong reference.
  expect(await message(pub({action:'withdraw',reference:submitted.reference,contactDigest:digest('someone-else')})))
   .toMatch(/consult_request_unavailable/);
  expect(await pub({action:'withdraw',reference:submitted.reference,contactDigest:contact}))
   .toMatchObject({action:'withdraw',status:'withdrawn'});
  expect(await message(pub({action:'withdraw',reference:submitted.reference,contactDigest:contact})))
   .toMatch(/consult_request_unavailable/);
 });

 it('keeps requests inside the clinic that was asked, and refuses a consumer session',async()=>{
  const listed=await rpc('consult_request_review',{action:'list'},outsider,'workforce',otherOrg);
  expect(listed.requests).toEqual([]);
  expect(await message(rpc('consult_request_review',{action:'list'},consumer,'consumer')))
   .toMatch(/consult_request_forbidden/);
  expect(await message(rpc('consult_link_admin',{action:'list'},consumer,'consumer')))
   .toMatch(/consult_request_forbidden/);
 });

 it('will not rewrite what a request said, or delete that it was made',async()=>{
  const {rows}=await db.query<{id:string}>('select id from clinical_core.consult_requests limit 1');
  await expect(db.query("update clinical_core.consult_requests set visit_type='urgent_question' where id=$1",[rows[0].id]))
   .rejects.toThrow(/consult_request_immutable/);
  await expect(db.query('delete from clinical_core.consult_requests where id=$1',[rows[0].id]))
   .rejects.toThrow(/append_only_record/);
 });

 it('refuses to convert anything but an accepted request, and a stale revision',async()=>{
  const submitted=await pub({action:'submit',slug:'fictional-longevity',contact:envelope('Fictional Declined'),
   contactDigest:digest('declined@example.invalid'),visitType:'initial',reasonCode:'new_consultation'});
  const listed=await rpc('consult_request_review',{action:'list',status:'received'});
  const entry=(listed.requests as Array<Record<string,unknown>>).find(r=>r.reference===submitted.reference)!;
  expect(await message(rpc('consult_request_review',{action:'convert',requestId:entry.requestId,
   expectedRevision:entry.revision,syntheticRecordKey:'patient_syn_declined_01'})))
   .toMatch(/consult_request_state_invalid/);
  const declined=await rpc('consult_request_review',{action:'decline',requestId:entry.requestId,
   expectedRevision:entry.revision,declineReason:'outside_scope'});
  expect(declined).toMatchObject({status:'declined',declineReason:'outside_scope'});
  expect(await message(rpc('consult_request_review',{action:'accept',requestId:entry.requestId,
   expectedRevision:entry.revision}))).toMatch(/consult_request_revision_stale/);
 });
});

describe('pre-visit forms and signatures: real migration SQL, not hosted AWS',()=>{
 it('refuses a questionnaire whose required fields are absent or null, not only wrong',async()=>{
  const without=structuredClone(QUESTIONNAIRE) as {sections:Array<{questions:Array<Record<string,unknown>>}>};
  delete without.sections[0].questions[0].required;
  expect(await message(rpc('intake_form_admin',{action:'draft',formKey:'absent-field',title:'Absent',
   kind:'questionnaire',content:without}))).toMatch(/question_required_invalid/);
  const nulled=structuredClone(QUESTIONNAIRE) as {sections:Array<{questions:Array<Record<string,unknown>>}>};
  nulled.sections[0].questions[0].required=null;
  expect(await message(rpc('intake_form_admin',{action:'draft',formKey:'null-field',title:'Null',
   kind:'questionnaire',content:nulled}))).toMatch(/question_required_invalid/);
  const extra=structuredClone(QUESTIONNAIRE) as {sections:Array<{questions:Array<Record<string,unknown>>}>};
  extra.sections[0].questions[0].weight=2;
  expect(await message(rpc('intake_form_admin',{action:'draft',formKey:'extra-field',title:'Extra',
   kind:'questionnaire',content:extra}))).toMatch(/question_unknown_field/);
  const choice=structuredClone(QUESTIONNAIRE) as {sections:Array<{questions:Array<{options?:unknown}>}>};
  choice.sections[0].questions[0].options=[{value:'only',label:'Only one'}];
  expect(await message(rpc('intake_form_admin',{action:'draft',formKey:'one-option',title:'One',
   kind:'questionnaire',content:choice}))).toMatch(/options_out_of_range/);
 });

 it('requires a consent document to ask for a typed name',async()=>{
  const unsigned=structuredClone(DOCUMENT) as {agreement:{requiresTypedName:boolean}};
  unsigned.agreement.requiresTypedName=false;
  expect(await message(rpc('intake_form_admin',{action:'draft',formKey:'no-name',title:'No name',
   kind:'consent_document',content:unsigned}))).toMatch(/agreement_typed_name_required/);
 });

 it('never delivers a draft, and never assigns without a granted forms consent',async()=>{
  const drafted=await rpc('intake_form_admin',{action:'draft',formKey:'draft-only',title:'Draft only',
   kind:'questionnaire',content:QUESTIONNAIRE});
  expect(await message(rpc('intake_packet_workforce',{action:'assign',connectionId:connection,
   label:'Before your visit',forms:[{formVersionId:drafted.formVersionId,required:true}]})))
   .toMatch(/intake_form_unpublished/);
  const published=await publishForm('questionnaire',QUESTIONNAIRE,'history-form');
  expect(await message(rpc('intake_packet_workforce',{action:'assign',connectionId:unconsented,
   label:'Before your visit',forms:[{formVersionId:published.formVersionId,required:true}]})))
   .toMatch(/intake_consent_absent/);
 });

 it('carries a published packet to the patient, validates the answers and records the signature',async()=>{
  const questionnaire=await publishForm('questionnaire',QUESTIONNAIRE,'intake-history');
  const document=await publishForm('consent_document',DOCUMENT,'telehealth-consent');
  const packet=await rpc('intake_packet_workforce',{action:'assign',connectionId:connection,
   label:'Before your first visit',dueBefore:'2027-01-01T00:00:00.000Z',
   forms:[{formVersionId:questionnaire.formVersionId,required:true},
    {formVersionId:document.formVersionId,required:true}]});
  expect(packet).toMatchObject({action:'assign',status:'open'});
  const mine=await rpc('intake_packet_consumer',{action:'list'},consumer,'consumer');
  expect((mine.packets as Array<Record<string,unknown>>).find(p=>p.packetId===packet.packetId))
   .toMatchObject({status:'open',outstanding:2});
  const opened=await rpc('intake_packet_consumer',{action:'open',packetId:packet.packetId},consumer,'consumer');
  const items=opened.items as JsonRow[];
  expect(items).toHaveLength(2);
  // The patient is shown the published version's own content, digest included, so the
  // client can prove what it rendered when it submits.
  expect(items[0].contentSha256).toBe(questionnaire.contentSha256);
  expect(dig(items[0].content,'sections',0,'questions',0,'prompt')).toBe('What brings you in?');

  const item=items[0];
  const refuse=(answers:unknown)=>message(rpc('intake_packet_consumer',{action:'submit',
   packetId:packet.packetId,itemId:item.itemId,contentSha256:item.contentSha256,answers},consumer,'consumer'));
  expect(await refuse({goal:'fatigue',first_visit:false})).toMatch(/answer_missing/);
  expect(await refuse({...ANSWERS,unknown_question:'x'})).toMatch(/answer_unknown_question/);
  expect(await refuse({...ANSWERS,goal:'insomnia'})).toMatch(/answer_not_offered/);
  expect(await refuse({...ANSWERS,sleep:9})).toMatch(/answer_out_of_range/);
  expect(await refuse({...ANSWERS,sleep:3.5})).toMatch(/answer_invalid/);
  expect(await refuse({...ANSWERS,notes:'x'.repeat(201)})).toMatch(/answer_too_long/);
  expect(await refuse({...ANSWERS,supplements:['magnesium','magnesium']})).toMatch(/answer_invalid/);
  expect(await message(rpc('intake_packet_consumer',{action:'submit',packetId:packet.packetId,
   itemId:item.itemId,contentSha256:digest('a different form'),answers:ANSWERS},consumer,'consumer')))
   .toMatch(/intake_form_changed/);

  const submitted=await rpc('intake_packet_consumer',{action:'submit',packetId:packet.packetId,
   itemId:item.itemId,contentSha256:item.contentSha256,answers:{...ANSWERS,supplements:['magnesium']}},
   consumer,'consumer');
  // One item answered is not a completed packet: the document is still unsigned.
  expect(submitted).toMatchObject({action:'submit',packetStatus:'open'});
  expect(await message(rpc('intake_packet_consumer',{action:'submit',packetId:packet.packetId,
   itemId:item.itemId,contentSha256:item.contentSha256,answers:ANSWERS},consumer,'consumer')))
   .toMatch(/intake_response_recorded/);

  const consent=items[1];
  expect(consent.kind).toBe('consent_document');
  const agreement=digest(DOCUMENT.agreement.statement);
  expect(consent.agreementSha256).toBe(agreement);
  const sign=(overrides:Record<string,unknown>={})=>rpc('intake_packet_consumer',{action:'sign',
   packetId:packet.packetId,itemId:consent.itemId,contentSha256:consent.contentSha256,
   agreementSha256:agreement,signerName:'Fictional Patient',
   signerNameDigest:digest('Fictional Patient'),signerAuthority:'self',...overrides},consumer,'consumer');
  // A signature that cannot name the sentence it agreed to is not recorded.
  expect(await message(sign({agreementSha256:digest('some other promise')}))).toMatch(/intake_agreement_changed/);
  expect(await message(sign({signerAuthority:'friend'}))).toMatch(/intake_packet_invalid/);
  const signed=await sign();
  expect(signed).toMatchObject({action:'sign',packetStatus:'completed',agreementSha256:agreement,
   signerAuthority:'self'});
  // Signing the last required item completes the packet, so a second attempt is refused by
  // the packet's state rather than by the signature already on file. Both are closed doors;
  // this is the one the patient actually reaches.
  expect(await message(sign())).toMatch(/intake_packet_state_invalid/);

  const read=await rpc('intake_packet_workforce',{action:'open',packetId:packet.packetId});
  expect(read).toMatchObject({status:'completed'});
  const clinic=read.items as JsonRow[];
  expect(clinic[0].answers).toMatchObject({goal:'fatigue',supplements:['magnesium']});
  expect(clinic[1].signature).toMatchObject({authority:'self',agreementSha256:agreement,
   signerName:'Fictional Patient',signerNameDigest:digest('Fictional Patient')});
  // Signing the last required item completed the packet, so a further attempt is refused by
  // the packet's state. The digest check itself is asserted where a packet is still open.
  expect(await message(sign({signerNameDigest:digest('Someone Else')}))).toMatch(/intake_packet_state_invalid/);
 });

 it('keeps a packet to the patient it was sent to, and refuses a cancelled one',async()=>{
  const questionnaire=await publishForm('questionnaire',QUESTIONNAIRE,'isolation-form');
  const packet=await rpc('intake_packet_workforce',{action:'assign',connectionId:connection,
   label:'Isolation check',forms:[{formVersionId:questionnaire.formVersionId,required:true}]});
  expect(await message(rpc('intake_packet_consumer',{action:'open',packetId:packet.packetId},stranger,'consumer')))
   .toMatch(/intake_packet_absent/);
  const cancelled=await rpc('intake_packet_workforce',{action:'cancel',packetId:packet.packetId,
   expectedRevision:packet.revision});
  expect(cancelled).toMatchObject({status:'cancelled'});
  const opened=await rpc('intake_packet_consumer',{action:'open',packetId:packet.packetId},consumer,'consumer');
  const item=(opened.items as JsonRow[])[0];
  expect(await message(rpc('intake_packet_consumer',{action:'submit',packetId:packet.packetId,
   itemId:item.itemId,contentSha256:item.contentSha256,answers:ANSWERS},consumer,'consumer')))
   .toMatch(/intake_packet_state_invalid/);
 });

 it('will not rewrite published text, a recorded answer or a signature',async()=>{
  const published=await publishForm('questionnaire',QUESTIONNAIRE,'immutable-form');
  await expect(db.query("update clinical_core.intake_form_versions set content='{}'::jsonb where id=$1",
   [published.formVersionId])).rejects.toThrow(/intake_form_immutable/);
  await expect(db.query('delete from clinical_core.intake_form_versions where id=$1',[published.formVersionId]))
   .rejects.toThrow(/intake_form_immutable/);
  await expect(db.query("update clinical_core.intake_form_responses set answers='{}'::jsonb"))
   .rejects.toThrow(/append_only_record/);
  await expect(db.query('delete from clinical_core.document_signatures')).rejects.toThrow(/append_only_record/);
 });

 it('refuses a second signature on an item that already has one',async()=>{
  const first=await publishForm('consent_document',DOCUMENT,'dual-consent-a');
  const second=await publishForm('consent_document',DOCUMENT,'dual-consent-b');
  const packet=await rpc('intake_packet_workforce',{action:'assign',connectionId:connection,
   label:'Two documents',forms:[{formVersionId:first.formVersionId,required:true},
    {formVersionId:second.formVersionId,required:true}]});
  const opened=await rpc('intake_packet_consumer',{action:'open',packetId:packet.packetId},consumer,'consumer');
  const item=(opened.items as JsonRow[])[0];
  const sign=()=>rpc('intake_packet_consumer',{action:'sign',packetId:packet.packetId,itemId:item.itemId,
   contentSha256:item.contentSha256,agreementSha256:item.agreementSha256,
   signerName:'Fictional Patient',signerNameDigest:digest('Fictional Patient'),
   signerAuthority:'self'},consumer,'consumer');
  // A digest that is not of the name that arrived is refused, so the record cannot name one
  // person while attesting to another. Asserted here, where the packet stays open.
  expect(await message(rpc('intake_packet_consumer',{action:'sign',packetId:packet.packetId,
   itemId:item.itemId,contentSha256:item.contentSha256,agreementSha256:item.agreementSha256,
   signerName:'Fictional Patient',signerNameDigest:digest('Someone Else'),signerAuthority:'self'},
   consumer,'consumer'))).toMatch(/intake_packet_invalid/);
  expect(await sign()).toMatchObject({action:'sign',packetStatus:'open'});
  // The other document is still outstanding, so the packet is open and this refusal is the
  // signature guard itself rather than the packet's state.
  expect(await message(sign())).toMatch(/intake_signature_recorded/);
 });

 it('refuses a packet whose due date has passed',async()=>{
  const questionnaire=await publishForm('questionnaire',QUESTIONNAIRE,'overdue-form');
  const packet=await rpc('intake_packet_workforce',{action:'assign',connectionId:connection,
   label:'Overdue',forms:[{formVersionId:questionnaire.formVersionId,required:true}]});
  await db.query("update clinical_core.intake_packets set due_before=now()-interval '1 day' where id=$1",
   [packet.packetId]);
  const opened=await rpc('intake_packet_consumer',{action:'open',packetId:packet.packetId},consumer,'consumer');
  const item=(opened.items as JsonRow[])[0];
  expect(await message(rpc('intake_packet_consumer',{action:'submit',packetId:packet.packetId,
   itemId:item.itemId,contentSha256:item.contentSha256,answers:ANSWERS},consumer,'consumer')))
   .toMatch(/intake_packet_past_due/);
 });
});
