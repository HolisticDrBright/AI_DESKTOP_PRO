import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {ClinicalCoreDatabase} from '../clinical-core/database';
import {ClinicalCoreDatabaseRejection} from '../clinical-core/database';
import {classifyDatabaseRejection} from '../clinical-core/rds-data-database';
import type {ProductionClinicalRequestContext} from '../clinical-core/aws-identity-consent';
import {createProductionProgramAssignments,PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256} from '../clinical-core/production-program-assignments';
import type {ProgramAssignmentRequest} from '../../contracts/programAssignments';
import type {GovernedCatalogProduct,GovernedCommercialOffer} from '../clinical-core/aws-governed-catalog-reader';
import {CONSUMER_PURCHASE_RELEASES,consumerPurchaseCandidate,createConsumerPurchaseCandidate,type AdmissionRecord,type ConsumerPurchasePorts,
 type ConsumerPurchaseRelease,type ConsumerSession,type ProductActionRecord} from './consumer-product-action';
import {createProgramStepDatabasePorts,createProgramStepPurchase,programStepPurchaseActivationState,DISABLED_PROGRAM_STEP_PURCHASE_ACTIVATION,
 PROGRAM_STEP_PURCHASE_CANDIDATE_SHA256} from './program-step-purchase';
import {PROGRAM_STEP_PURCHASE_RELEASED,type ProgramStepBinding} from '../../contracts/programStepPurchase';

/**
 * A program step's purchase action bound to the program's CURRENT clinical review: the BLOCKED successor
 * (program-step-purchase.sql) over the actual 106-migration artifact and its three predecessors, through the API role,
 * with the disabled consumer-action candidate in front of it. Fictional identities, products, readings and addresses
 * only. Nothing here is registered, applied or released; the education-only Core release has no purchase release.
 */
const CANDIDATES=['infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql','infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql',
 'infra/aws-clinical-core/production-candidates/production-program-assignments.sql'];
const STEP_CANDIDATE='infra/aws-clinical-core/production-candidates/program-step-purchase.sql';
const IRON='prd_fictional_iron',OTHER='prd_fictional_other',HOST='us.fullscript.com',SLUG='fictional-test-dispensary';
const DESTINATION=`https://${HOST}/s/${SLUG}/shop/product/RklDVElPTkFMMQ==`;
const DOC='d'.repeat(64);
let db:PGlite,org:string,otherOrg:string,staff:string,consumer:string,other:string,patient:string,connection:string,program:string,version:string,product:string,productVersion:string,batch:string;
const subject=(id:string)=>'fictional-'+id;
const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const production=(person:string,pool:'workforce'|'consumer',organization=org):ProductionClinicalRequestContext=>({
 actorPersonId:person,organizationId:organization,identitySubject:subject(person),identityPool:pool,purpose:'clinical_data',
 environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true});
// The hosted classification in front of the embedded database: refusals reach the adapter by token only.
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role clinical_core_api');
 return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
  try{return await tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p));}
  catch(cause){const message=cause instanceof Error?cause.message:String(cause);
   throw classifyDatabaseRejection({name:'DatabaseErrorException',message})??new ClinicalCoreDatabaseRejection('operation_refused');}
 }});
})};
const programs=createProductionProgramAssignments({database,verifyConsumerCore:vi.fn(async()=>undefined),activation:{contract:'production-program-activation/1',enabled:true,
 target:'production-clinical',schemaCandidateSha256:PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256,evidenceSha256:'e'.repeat(64),reviewedBy:'FICTIONAL REVIEW FIXTURE',reviewedAt:'2026-10-11T00:00:00Z'}});
const call=(input:ProgramAssignmentRequest,context=production(consumer,'consumer'))=>programs(context,input,'Bearer fictional-token');
const evidence=(parts:Record<string,unknown>={})=>({contract:'program-step-purchase-activation/1',enabled:true,target:'production-clinical',
 programCandidateSha256:PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256,stepCandidateSha256:PROGRAM_STEP_PURCHASE_CANDIDATE_SHA256,evidenceSha256:'e'.repeat(64),
 reviewedBy:'FICTIONAL REVIEW FIXTURE',reviewedAt:'2026-10-14T00:00:00Z',...parts});
const lesson=(suffix:string)=>({id:'lesson-'+suffix,title:'Fictional lesson '+suffix,kind:'lesson',instructions:'Read the fictional lesson.',released:true,authorship:'practitioner_authored'});
const ironStep=(id='supp-iron')=>({id,title:'Fictional iron step',kind:'supplement',instructions:'Fictional instruction.',released:true,
 product:{id:'product-iron',ingredientKeys:['iron_bisglycinate'],dose:'18 mg',purchaseUrl:null,catalog:{stableId:IRON,version:1,target:'production-clinical'}}});
async function publish(phases:unknown){
 await db.query(`update clinical_core.program_versions set content=$2::jsonb,content_sha256=encode(public.digest(convert_to(($2::jsonb)::text,'UTF8'),'sha256'),'hex') where id=$1`,
  [version,JSON.stringify({title:'Fictional',modules:[],consumerProgram:{title:'Fictional iron guide',phases}})]);
}
const phases=(first:unknown[]=[lesson('a'),ironStep()],second:unknown[]=[lesson('b')])=>[{id:'phase-1',title:'Phase one',days:1,transition:'scheduled',items:first},
 {id:'phase-2',title:'Phase two',days:1,transition:'scheduled',items:second}];
async function exec(person:string,pool:'workforce'|'consumer',sql:string,params:unknown[]=[]){
 return db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[person,org,pool,subject(person),'clinical_data','production-clinical','clinical_phi']);
  return (await tx.query<Record<string,unknown>>(sql,params)).rows;
 });
}
/** A complete, verified plan inventory (an unrelated magnesium product), so the iron step is otherwise available. */
async function completeInventory(){
 const proof={contract:'production-catalog-ingredient-release/1',productId:product,productVersion:1,productContentSha256:'a'.repeat(64),labelVersionId:productVersion,
  labelSha256:'b'.repeat(64),completeness:'complete',sourceVerification:'V',ingredientKeys:['magnesium_glycinate'],sourceRefs:['fictional-source']};
 await db.query('insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note) values($1,$2,$3)',[productVersion,staff,JSON.stringify(proof)]);
 const record=randomUUID(),payload={status:'active',supplements_json:[{id:'item-1',status:'active',dose:'1 capsule daily',governedProduct:{productId:product,labelVersionId:productVersion}}],peptides_json:[]};
 const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 await db.query(`insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
  values($1,'protocols',$2,1,$3,$4,$5::jsonb,false,1)`,[consumer,record,randomUUID(),digest,JSON.stringify(payload)]);
 await db.query(`insert into clinical_core.owned_consumer_active_plans(owner_id,record_id,revision,content_sha256,consent_revision,adopted_at,adoption_request_id)
  values($1,$2,1,$3,1,now(),$4)`,[consumer,record,digest,randomUUID()]);
}
/** A clinic reading for the enrolled patient, sent as lab-result/2 and accepted by the practice. */
async function clinicReading(value:number,collectedAt:string){
 const body={schemaVersion:'lab-result/2',provider:'alp_patient_sync',providerEventId:'lab:'+randomUUID().replaceAll('-',''),connectionId:connection,resourceVersion:'f'.repeat(64),
  occurredAt:new Date().toISOString(),source:{system:'ai_longevity_pro_v2',recordType:'lab_panels',panelId:'panel_'+'1'.repeat(32),markerId:'marker_'+randomUUID().replaceAll('-','')},
  panel:{name:'Fictional iron panel',collectedAt},result:{name:'Ferritin',value,unit:'ng/mL',referenceRange:{min:30,max:400}},
  provenance:{origin:'uploaded_report_analysis',documents:[DOC],reportedVerification:'needs_human_review'}};
 const [event]=await exec(consumer,'consumer','select * from clinical_core.record_lab_import_v2($1::jsonb)',[JSON.stringify(body)]);
 const [review]=await exec(staff,'workforce',"select * from clinical_core.review_lab_import($1,'accept',null)",[event!.event_id]);
 return {observation:review!.observation_id as string,value,collectedAt};
}
async function attest(reading:{observation:string;value:number;collectedAt:string}){
 await exec(staff,'workforce','select clinical_core.attest_lab_observation($1::jsonb) as data',[JSON.stringify({statement:'lab-reading-attestation/1',requestId:randomUUID(),
  observationId:reading.observation,outcome:'verified',reading:{marker:'Ferritin',value:reading.value,unit:'ng/mL',observedAt:reading.collectedAt},documentSha256:DOC,supersedes:null})]);
}
async function ownedReading(value:number,drawnAt:string){
 await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'lab_history',1,'granted','program-fixture') on conflict do nothing",[consumer]);
 const id=randomUUID();
 await db.query(`insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
  values($1,'lab_observations',$2,1,$3,$4,$5::jsonb,false,1)`,[consumer,id,randomUUID(),'c'.repeat(64),JSON.stringify({id,panelId:randomUUID(),markerId:randomUUID(),
  panelName:'Fictional panel',name:'Ferritin',value,unit:'ng/mL',drawnAt,reportedRange:{low:30,high:400},sourceStatus:'consumer_import_unverified'})]);
}
async function setStepActivation(enabled:boolean){
 await db.query(`update clinical_core.program_step_purchase_activation set enabled=$1,evidence_sha256=case when $1 then repeat('e',64) else null end,reviewed_by=case when $1 then 'FICTIONAL REVIEW FIXTURE' else null end,reviewed_at=case when $1 then now() else null end`,[enabled]);
}
/** An active enrollment and the binding the person would be shown for its iron step. */
async function enrolled(stepId='supp-iron'):Promise<{enrollmentId:string;step:ProgramStepBinding}>{
 const assigned=await call({action:'assign',connectionId:connection,programVersionId:version},production(staff,'workforce'));
 if(assigned.action!=='assign')throw new Error('bad');
 const offered=await call({action:'read',enrollmentId:assigned.enrollmentId});
 if(offered.action!=='read')throw new Error('bad');
 await call({action:'accept',enrollmentId:assigned.enrollmentId,sourceDigest:offered.assignment.sourceDigest,expectedRevision:offered.assignment.revision,planRevision:offered.review.planRevision});
 return {enrollmentId:assigned.enrollmentId,step:await binding(assigned.enrollmentId,stepId)};
}
async function binding(enrollmentId:string,itemId='supp-iron'):Promise<ProgramStepBinding>{
 const current=await call({action:'read',enrollmentId});
 if(current.action!=='read')throw new Error('bad');
 return {enrollmentId,itemId,assignmentRevision:current.assignment.revision,planRevision:current.review.planRevision,sourceDigest:current.assignment.sourceDigest,
  connectionId:connection,catalog:{stableId:IRON,version:1,target:'production-clinical'}};
}

const release=():ConsumerPurchaseRelease=>({contract:'consumer-purchase-release/1',environment:'production-clinical',tier:'clinician_connected',jurisdictions:['US-TX'],
 provider:{name:'fullscript',host:HOST,dispensarySlug:SLUG,organizationId:org},licensure:'buyer_jurisdiction_verified',directProducts:'withheld',
 disclosure:'FICTIONAL disclosure for tests only.',effectiveFrom:'2026-01-01T00:00:00Z'});
const catalogProduct=(stableId:string):GovernedCatalogProduct=>({stableId,version:1,displayName:'Fictional '+stableId,productType:'supplement',accessTier:'open',declaredRestricted:false,
 directOrderAllowed:true,clinical:{},sourceRefs:['synthetic:step'],reviewStatus:'approved',label:{stableId:'lbl_'+stableId.slice(4),version:1,label:{},crosscheck:{},reviewStatus:'approved'}});
const catalogOffer=(stableId:string):GovernedCommercialOffer=>({stableId:'off_'+stableId.slice(4),version:1,productStableId:stableId,destinationUrl:DESTINATION,trackingMetadata:{},reviewStatus:'approved'});
const action=(stableId=IRON)=>({contract:'fullscript-consumer-action/2',kind:'product_patient_action',purpose:'supplement_purchase',requestId:randomUUID(),
 binding:{productStableId:stableId,productVersion:1,labelStableId:'lbl_'+stableId.slice(4),labelVersion:1,offerStableId:'off_'+stableId.slice(4),offerVersion:1}});
/** The purchase world: the consumer candidate over fictional in-memory commerce ports, its program holds from the database. */
function world(releases:readonly ConsumerPurchaseRelease[]=[release()]){
 const actions=new Map<string,ProductActionRecord>(),used=new Set<string>(),admissions=new Map<string,AdmissionRecord>();
 const ports=createProgramStepDatabasePorts(database,accountId=>production(accountId,'consumer'));
 const commerce:ConsumerPurchasePorts={
  catalog:{current:async id=>[IRON,OTHER].includes(id)?{product:catalogProduct(id),offers:[catalogOffer(id)]}:null},
  patientLinks:{forAccount:async account=>account===consumer?[{connectionId:connection,organizationId:org,state:'verified'}]:[]},
  practitionerAuthority:{verifiedJurisdictions:async id=>id===org?['US-TX']:[]},
  programHolds:ports.programHolds,
  admissions:{current:async a=>admissions.get(a)??null,record:async r=>{admissions.set(r.accountId,r);}},
  actions:{insertIfNew:async r=>{if(used.has(r.requestId))return false;used.add(r.requestId);actions.set(r.actionId,structuredClone(r));return true;},
   get:async id=>structuredClone(actions.get(id)??null),spend:async(id,at)=>{const r=actions.get(id);if(!r||r.redeemedAt)return false;r.redeemedAt=at;return true;}},
  clock:{now:()=>new Date()},
 };
 const purchase=createConsumerPurchaseCandidate(commerce,'production-clinical',releases);
 const steps=createProgramStepPurchase({purchase,steps:ports.steps,activation:evidence()});
 const session=(account=consumer):ConsumerSession=>({accountId:account,sessionId:'session-'+account,authenticatedAt:new Date(Date.now()-60_000).toISOString(),revoked:false});
 return {purchase,steps,ports,session,actions,
  admit:async()=>expect(await purchase.declare(session(),{contract:'purchase-admission/1',jurisdiction:'US-TX',practitioner:{relationship:'connected',connectionId:connection}})).toMatchObject({ok:true,status:{state:'admitted'}})};
}
const noDestination=(value:unknown)=>expect(JSON.stringify(value)).not.toMatch(/destinationUrl|fullscript\.com|purchaseUrl|orderingLink/);

beforeAll(async()=>{
 const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',timeout:20_000,maxBuffer:8*1024*1024}));
 expect(manifest.migrations).toHaveLength(106);
 expect(manifest.migrations.some((m:{file:string})=>/program_step_purchase|production_program_assignments/.test(m.file))).toBe(false);
 db=new PGlite({extensions:{pgcrypto}});
 for(const migration of manifest.migrations)await db.exec(files[migration.file]);
 for(const candidate of [...CANDIDATES,STEP_CANDIDATE])await db.exec(readFileSync(candidate,'utf8'));
 for(const scope of ['protocols_supplements','lab_history'])await db.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
  values($1,'program-fixture','FICTIONAL ONLY',encode(public.digest('FICTIONAL ONLY','sha256'),'hex'),'FIXTURE NOT APPROVAL',now()-interval '1 day')`,[scope]);
 for(const table of ['production_program_activation','lab_result_transfer_v2_activation','lab_observation_attestation_activation'])
  await db.query(`update clinical_core.${table} set enabled=true,evidence_sha256=repeat('e',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()`);
},120_000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
 [org,otherOrg,staff,consumer,other,patient,connection,program,version,productVersion,batch]=Array.from({length:11},()=>randomUUID());
 product='prd_fixture_'+randomUUID().replaceAll('-','');
 await setStepActivation(true);
 await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC A'),($2,'FICTIONAL CLINIC B')",[org,otherOrg]);
 for(const [person,pool] of [[staff,'workforce'],[consumer,'consumer'],[other,'consumer']] as const){
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[person,'subject_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[person,pool,subject(person)]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,staff]);
 for(const owner of [consumer,other])await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',1,'granted','program-fixture')",[owner]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')",[patient,org,'patient_fixture_'+patient.replaceAll('-','')]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",[connection,org,patient,consumer]);
 await db.query("insert into clinical_core.sync_providers(organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state,reviewed_by_person_id,reviewed_at) values($1,'alp_patient_sync','patient-sync/1','lab-result/1','fictional-1','active',$2,now())",[org,staff]);
 const [artifact]=(await db.query<{id:string}>("insert into clinical_core.consent_artifacts(organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,'lab_results_import','fictional-1',$2,'US-FICTIONAL','approved',now(),$3) returning id",[org,'a'.repeat(64),staff])).rows;
 await db.query("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'lab_results_import','granted','patient_app','self',1,$5)",[org,patient,connection,artifact!.id,consumer]);
 await db.query(`insert into clinical_reference.catalog_import_batches(id,contract_version,source_package_id,source_package_version,manifest_sha256,environment,status)
  values($1,'FICTIONAL/1',$2,'FICTIONAL/1',$3,'production-clinical','succeeded')`,[batch,'fixture-'+batch,batch.replaceAll('-','').repeat(2)]);
 await db.query("insert into clinical_reference.catalog_products(stable_id,review_status,active_version,environment) values($1,'approved',1,'production-clinical')",[product]);
 await db.query(`insert into clinical_reference.catalog_product_versions(id,product_stable_id,version,display_name,product_type,access_tier,direct_order_allowed,label_sha256,content_sha256,clinical_payload,source_refs,review_status,import_batch_id)
  values($1,$2,1,'FICTIONAL magnesium','supplement','open',true,$3,$4,'{}','["fictional-source"]','approved',$5)`,[productVersion,product,'b'.repeat(64),'a'.repeat(64),batch]);
 await db.query("insert into clinical_core.programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'FICTIONAL program','active',$3)",[program,org,staff]);
 await db.query(`insert into clinical_core.program_versions(id,organization_id,program_id,version,status,created_by_person_id,approved_by_person_id,approved_at,published_at)
  values($1,$2,$3,1,'published',$4,$4,clock_timestamp(),clock_timestamp())`,[version,org,program,staff]);
 await publish(phases());
 await completeInventory();
 // A verified ferritin within its range: the iron step is available.
 await attest(await clinicReading(80,'2026-09-01T09:00:00.000Z'));
});

describe('disabled by default and pinned',()=>{
 it('the adapter is built against the exact candidate; absent or mismatched evidence refuses before anything is read, and the release flag is off',async()=>{
  expect(sha(STEP_CANDIDATE)).toBe(PROGRAM_STEP_PURCHASE_CANDIDATE_SHA256);
  expect(PROGRAM_STEP_PURCHASE_RELEASED).toBe(false);
  expect(programStepPurchaseActivationState(undefined)).toEqual(DISABLED_PROGRAM_STEP_PURCHASE_ACTIVATION);
  for(const wrong of [{stepCandidateSha256:'f'.repeat(64)},{programCandidateSha256:'f'.repeat(64)},{target:'synthetic-staging'}])
   expect(programStepPurchaseActivationState(evidence(wrong))).toEqual(DISABLED_PROGRAM_STEP_PURCHASE_ACTIVATION);
  const read=vi.fn();
  const spyPurchase={issueForProgramStep:read,redeemForProgramStep:read} as never;
  for(const activation of [undefined,evidence({stepCandidateSha256:'f'.repeat(64)})]){
   const adapter=createProgramStepPurchase({purchase:spyPurchase,steps:{check:read},activation});
   expect(await adapter.issue({accountId:consumer,sessionId:'s',authenticatedAt:new Date().toISOString(),revoked:false},{})).toEqual({ok:false,refused:'program_step_purchase_disabled'});
   expect(await adapter.redeem({accountId:consumer,sessionId:'s',authenticatedAt:new Date().toISOString(),revoked:false},{contract:'program-step-purchase/1',actionId:'act_'+'a'.repeat(32)})).toEqual({ok:false,refused:'program_step_purchase_disabled'});
  }
  expect(read).not.toHaveBeenCalled();
 });
 it('the database refuses the step check while its own activation row is off, and the API role cannot flip it; the held-products guard keeps working',async()=>{
  const {step}=await enrolled();
  await setStepActivation(false);
  const w=world();
  expect(await w.ports.steps.check(w.session(),step)).toBe('program_step_purchase_disabled');
  await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.exec('update clinical_core.program_step_purchase_activation set enabled=true');})).rejects.toThrow(/permission denied/);
  expect(await w.ports.programHolds.heldProductStableIds(consumer)).toEqual([]);
 });
});

describe('the iron step and a high or conflicting result (the key regression)',()=>{
 it('available, an action is issued; then a high ferritin arrives: redemption is refused, a fresh binding is lab-held, and neither a copied id nor an old client gets the destination',async()=>{
  const {enrollmentId,step}=await enrolled();
  const w=world();await w.admit();
  expect(await w.ports.steps.check(w.session(),step)).toBeNull();
  const issued=await w.steps.issue(w.session(),{contract:'program-step-purchase/1',step,action:action()});
  expect(issued).toMatchObject({ok:true});
  noDestination(issued);
  const actionId=(issued as {issued:{data:{actionId:string}}}).issued.data.actionId;
  expect(w.actions.get(actionId)!.programStep).toEqual(step);

  await clinicReading(420,'2026-10-10T09:00:00.000Z');
  const redeemed=await w.steps.redeem(w.session(),{contract:'program-step-purchase/1',actionId});
  expect(redeemed).toEqual({ok:false,refused:'program_review_stale'});
  noDestination(redeemed);
  const fresh=await binding(enrollmentId);
  expect(fresh.planRevision).not.toBe(step.planRevision);
  expect(await w.steps.issue(w.session(),{contract:'program-step-purchase/1',step:fresh,action:action()})).toEqual({ok:false,refused:'program_step_lab_held'});
  // A copied action id on the plain path does not exist there; an old client asking for the product plainly is refused.
  expect(await w.purchase.redeem(w.session(),{contract:'fullscript-consumer-action/2',actionId})).toEqual({ok:false,refused:'action_not_found'});
  expect(await w.purchase.issue(w.session(),action())).toEqual({ok:false,refused:'product_unavailable'});
  expect(await w.ports.programHolds.heldProductStableIds(consumer)).toEqual([IRON]);
  expect(w.actions.get(actionId)!.redeemedAt).toBeNull();
 });
 it('a conflicting personal result between issue and redemption holds the step the same way',async()=>{
  const {step}=await enrolled();
  const w=world();await w.admit();
  const issued=await w.steps.issue(w.session(),{contract:'program-step-purchase/1',step,action:action()});
  const actionId=(issued as {issued:{data:{actionId:string}}}).issued.data.actionId;
  await ownedReading(420,'2026-10-12');
  expect(await w.steps.redeem(w.session(),{contract:'program-step-purchase/1',actionId})).toEqual({ok:false,refused:'program_review_stale'});
  expect(await w.purchase.issue(w.session(),action())).toEqual({ok:false,refused:'product_unavailable'});
 });
 it('with the step still available at redemption, the bound action redeems once; a product outside the program behaves exactly as before',async()=>{
  const {step}=await enrolled();
  const w=world();await w.admit();
  const issued=await w.steps.issue(w.session(),{contract:'program-step-purchase/1',step,action:action()});
  const actionId=(issued as {issued:{data:{actionId:string}}}).issued.data.actionId;
  const redeemed=await w.steps.redeem(w.session(),{contract:'program-step-purchase/1',actionId});
  expect(redeemed).toMatchObject({ok:true,redeemed:{data:{destinationUrl:DESTINATION}}});
  expect(await w.steps.redeem(w.session(),{contract:'program-step-purchase/1',actionId})).toEqual({ok:false,refused:'action_used'});
  const plain=await w.purchase.issue(w.session(),action(OTHER));
  expect(plain).toMatchObject({ok:true});
  const plainId=(plain as {issued:{data:{actionId:string}}}).issued.data.actionId;
  // A plain action is not redeemable on the program path, and redeems on its own path as it always did.
  expect(await w.steps.redeem(w.session(),{contract:'program-step-purchase/1',actionId:plainId})).toEqual({ok:false,refused:'action_not_found'});
  expect(await w.purchase.redeem(w.session(),{contract:'fullscript-consumer-action/2',actionId:plainId})).toMatchObject({ok:true});
 });
});

describe('every other binding the step must match now',()=>{
 it('refuses a stale enrollment revision, another program version, a paused or withdrawn enrollment, a step not in the current phase and another catalog product',async()=>{
  const {enrollmentId,step}=await enrolled();
  const w=world();const check=(binding:ProgramStepBinding)=>w.ports.steps.check(w.session(),binding);
  expect(await check({...step,assignmentRevision:String(Number(step.assignmentRevision)-1)})).toBe('program_step_stale');
  expect(await check({...step,sourceDigest:'0'.repeat(64)})).toBe('program_step_superseded');
  expect(await check({...step,catalog:{...step.catalog,version:2}})).toBe('program_step_catalog_changed');
  expect(await check({...step,catalog:{...step.catalog,stableId:OTHER}})).toBe('program_step_catalog_changed');
  expect(await check({...step,itemId:'lesson-a'})).toBe('program_step_catalog_changed');
  expect(await check({...step,itemId:'lesson-b'})).toBe('program_step_not_current');
  await call({action:'pause',enrollmentId,sourceDigest:step.sourceDigest,expectedRevision:step.assignmentRevision});
  const paused=await binding(enrollmentId);
  expect(await check(paused)).toBe('program_step_not_active');
  await call({action:'withdraw',enrollmentId,sourceDigest:step.sourceDigest,expectedRevision:paused.assignmentRevision});
  expect(await check(await binding(enrollmentId).catch(()=>({...paused,assignmentRevision:String(Number(paused.assignmentRevision)+1)})))).toBe('program_step_withdrawn');
 });
 it('refuses another owner, another clinic and another care link with one refusal',async()=>{
  const {step}=await enrolled();
  const otherOwner=createProgramStepDatabasePorts(database,()=>production(other,'consumer'));
  const otherClinic=createProgramStepDatabasePorts(database,()=>production(consumer,'consumer',otherOrg));
  const session={accountId:consumer,sessionId:'s',authenticatedAt:new Date().toISOString(),revoked:false};
  expect(await otherOwner.steps.check(session,step)).toBe('program_step_refused');
  expect(await otherClinic.steps.check(session,step)).toBe('program_step_refused');
  expect(await world().ports.steps.check(session,{...step,connectionId:randomUUID()})).toBe('program_step_refused');
 });
 it('a step held for any reason in the current review is never bought, and the held list names only catalog ids',async()=>{
  await publish(phases([lesson('a'),{...ironStep(),released:false}]));
  const {step}=await enrolled();
  const w=world();
  expect(await w.ports.steps.check(w.session(),step)).toBe('program_step_held');
  expect(await w.ports.programHolds.heldProductStableIds(consumer)).toEqual([IRON]);
 });
});

describe('education-only Core exposes no destination, even to a crafted request',()=>{
 it('with no purchase release, every program and plain request ends at commerce_disabled before any port is read and carries no address',async()=>{
  expect(CONSUMER_PURCHASE_RELEASES).toEqual([]);
  const {step}=await enrolled();
  const touched=vi.fn(async()=>{throw new Error('port read');});
  const ports:ConsumerPurchasePorts={catalog:{current:touched},patientLinks:{forAccount:touched},practitionerAuthority:{verifiedJurisdictions:touched},
   programHolds:{heldProductStableIds:touched},admissions:{current:touched,record:touched},actions:{insertIfNew:touched,get:touched,spend:touched},clock:{now:()=>new Date()}};
  const purchase=consumerPurchaseCandidate(ports,'production-clinical');
  const adapter=createProgramStepPurchase({purchase,steps:{check:touched},activation:evidence()});
  const session={accountId:consumer,sessionId:'s',authenticatedAt:new Date(Date.now()-60_000).toISOString(),revoked:false};
  const crafted=[
   await adapter.issue(session,{contract:'program-step-purchase/1',step,action:action()}),
   await adapter.redeem(session,{contract:'program-step-purchase/1',actionId:'act_'+'b'.repeat(32)}),
   await purchase.issue(session,action()),
   await purchase.redeem(session,{contract:'fullscript-consumer-action/2',actionId:'act_'+'b'.repeat(32)}),
  ];
  for(const result of crafted)expect(result).toEqual({ok:false,refused:'commerce_disabled'});
  noDestination(crafted);
  expect(touched).not.toHaveBeenCalled();
 });
 it('a request naming a destination, a price, a purchase link or another product than the step is refused before anything is read',async()=>{
  const {step}=await enrolled();
  const w=world();await w.admit();
  for(const body of [{contract:'program-step-purchase/1',step,action:action(),destinationUrl:DESTINATION},
   {contract:'program-step-purchase/1',step:{...step,purchaseUrl:DESTINATION},action:action()},
   {contract:'program-step-purchase/1',step,action:{...action(),price:12}},
   {contract:'program-step-purchase/1',step,action:action(OTHER)}])
   expect(await w.steps.issue(w.session(),body)).toEqual({ok:false,refused:'request_invalid'});
 });
});
