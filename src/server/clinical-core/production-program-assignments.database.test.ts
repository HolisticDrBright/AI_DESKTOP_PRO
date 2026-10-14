import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {ClinicalCoreDatabase} from './database';
import {ClinicalCoreDatabaseRejection} from './database';
import {classifyDatabaseRejection} from './rds-data-database';
import type {ClinicalRequestContext,ProductionClinicalRequestContext,SyntheticRequestContext} from './aws-identity-consent';
import {createProductionProgramAssignments,activationState,PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256,ProductionProgramAssignmentError} from './production-program-assignments';
import type {ProgramAssignmentRequest} from '../../contracts/programAssignments';
import {DISABLED_PRODUCTION_PROGRAM_ACTIVATION} from '../../contracts/productionProgramActivation';

/**
 * The separate, default-disabled production program family, against the actual 106-migration
 * production artifact plus the unregistered candidate, through the API role, with fictional
 * identities only. The first block is the point: nothing works until both the adapter's evidence
 * and the database's activation row say so, and a disabled implementation is not a capability.
 * The rest exercises every authority the candidate re-checks once it is enabled in this test.
 */
const CANDIDATE='infra/aws-clinical-core/production-candidates/production-program-assignments.sql';
// The lab-aware review reads attested clinic readings, so the two lab candidates come first (their documented order).
const LAB_CANDIDATES=['infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql','infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql'];
let db:PGlite,org:string,otherOrg:string,staff:string,outsider:string,consumer:string,other:string,patient:string,connection:string,program:string,version:string,draft:string,product:string,productVersion:string,batch:string;
const subject=(id:string)=>'fictional-'+id;
const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const production=(person:string,pool:'workforce'|'consumer',organization=org):ProductionClinicalRequestContext=>({
 actorPersonId:person,organizationId:organization,identitySubject:subject(person),identityPool:pool,purpose:'clinical_data',
 environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true});
const synthetic=(person:string,pool:'workforce'|'consumer'):SyntheticRequestContext=>({
 actorPersonId:person,organizationId:org,identityPool:pool,identitySubject:subject(person),purpose:'clinical_data',
 environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,realPatientData:false});
const REQUEST_INVALID=/\bprogram_assignment_invalid\b/;
const CONFLICT=/\b(program_assignment_conflict|program_assignment_version_changed|program_assignment_revision_stale|program_review_stale|program_assignment_state_invalid|program_tasks_remaining|program_phase_not_due|program_check_in_required|program_practitioner_review_required|program_clinical_items_held)\b/;
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role clinical_core_api');
 return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
  try{return await tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p));}
  catch(cause){
   const message=cause instanceof Error?cause.message:String(cause);
   throw classifyDatabaseRejection({name:'DatabaseErrorException',message})??new ClinicalCoreDatabaseRejection(
    REQUEST_INVALID.test(message)?'request_invalid':CONFLICT.test(message)?'conflict':'operation_refused');
  }
 }});
})};
const enabledEvidence=()=>({contract:'production-program-activation/1',enabled:true,target:'production-clinical',
 schemaCandidateSha256:PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256,evidenceSha256:'e'.repeat(64),reviewedBy:'FICTIONAL REVIEW FIXTURE',reviewedAt:'2026-10-11T00:00:00Z'});
const core=vi.fn<(authorization:string)=>Promise<void>>();
const service=(activation:unknown=enabledEvidence())=>createProductionProgramAssignments({database,activation,verifyConsumerCore:core});
const call=(input:ProgramAssignmentRequest,context:ClinicalRequestContext=production(consumer,'consumer'),activation?:unknown)=>service(activation)(context,input,'Bearer fictional-token');
async function refusal(input:ProgramAssignmentRequest,context:ClinicalRequestContext=production(consumer,'consumer'),activation?:unknown){
 try{await call(input,context,activation);}catch(error){if(error instanceof ProductionProgramAssignmentError)return error;throw error;}
 throw new Error('expected a refusal');
}
const lesson=(suffix:string)=>({id:'lesson-'+suffix,title:'Fictional lesson '+suffix,kind:'lesson',instructions:'Read the fictional lesson.',released:true,authorship:'practitioner_authored'});
const supplement=(productId='product-fictional-1',ingredients=['fictional_other_mineral'],dose='100 mg')=>({id:'supp-1',title:'Fictional supplement step',kind:'supplement',
 instructions:'Fictional instruction.',released:true,product:{id:productId,ingredientKeys:ingredients,dose,purchaseUrl:null,catalog:{stableId:'prd_fictional_magnesium',version:1,target:'production-clinical'}}});
const phases=(items:unknown[]=[lesson('a')])=>[{id:'phase-1',title:'Phase one',days:1,transition:'scheduled',items},{id:'phase-2',title:'Phase two',days:1,transition:'scheduled',items:[lesson('b')]}];
async function publish(content:unknown,versionId=version){
 await db.query(`update clinical_core.program_versions set content=$2::jsonb,content_sha256=encode(public.digest(convert_to(($2::jsonb)::text,'UTF8'),'sha256'),'hex') where id=$1`,
  [versionId,JSON.stringify({title:'Fictional',modules:[],consumerProgram:{title:'Fictional thyroid guide',phases:content}})]);
}
async function setActivation(enabled:boolean){
 await db.query(`update clinical_core.production_program_activation set enabled=$1,evidence_sha256=case when $1 then repeat('e',64) else null end,reviewed_by=case when $1 then 'FICTIONAL REVIEW FIXTURE' else null end,reviewed_at=case when $1 then now() else null end`,[enabled]);
}
async function adoptPlan(entries:unknown[]){
 const record=randomUUID(),request=randomUUID();
 const payload={status:'active',supplements_json:entries,peptides_json:[]};
 const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 await db.query(`insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
  values($1,'protocols',$2,1,$3,$4,$5::jsonb,false,1)`,[consumer,record,request,digest,JSON.stringify(payload)]);
 await db.query(`insert into clinical_core.owned_consumer_active_plans(owner_id,record_id,revision,content_sha256,consent_revision,adopted_at,adoption_request_id)
  values($1,$2,1,$3,1,now(),$4)`,[consumer,record,digest,randomUUID()]);
 return record;
}
const proof=()=>({contract:'production-catalog-ingredient-release/1',productId:product,productVersion:1,productContentSha256:'a'.repeat(64),
 labelVersionId:productVersion,labelSha256:'b'.repeat(64),completeness:'complete',sourceVerification:'V',ingredientKeys:['magnesium_glycinate'],sourceRefs:['fictional-source']});
async function assign(versionId=version,actor=staff,organization=org){
 const result=await call({action:'assign',connectionId:connection,programVersionId:versionId},production(actor,'workforce',organization));
 if(result.action!=='assign')throw new Error('bad');return result;
}
async function read(enrollmentId:string,actor=consumer){const r=await call({action:'read',enrollmentId},production(actor,'consumer'));if(r.action!=='read')throw new Error('bad');return r;}
async function accept(enrollmentId:string){
 const current=await read(enrollmentId);
 return call({action:'accept',enrollmentId,sourceDigest:current.assignment.sourceDigest,expectedRevision:current.assignment.revision,planRevision:current.review.planRevision});
}

beforeAll(async()=>{
 const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',timeout:20_000,maxBuffer:8*1024*1024}));
 expect(manifest.migrations).toHaveLength(106);
 expect(manifest.migrations.some((m:{file:string})=>m.file.includes('production_program_assignments'))).toBe(false);
 db=new PGlite({extensions:{pgcrypto}});
 for(const migration of manifest.migrations)await db.exec(files[migration.file]);
 for(const candidate of LAB_CANDIDATES)await db.exec(readFileSync(candidate,'utf8'));
 await db.exec(readFileSync(CANDIDATE,'utf8'));
 for(const scope of ['protocols_supplements','lab_history'])await db.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
  values($1,'program-fixture','FICTIONAL ONLY',encode(public.digest('FICTIONAL ONLY','sha256'),'hex'),'FIXTURE NOT APPROVAL',now()-interval '1 day')`,[scope]);
},120_000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
 core.mockReset();core.mockResolvedValue(undefined);
 [org,otherOrg,staff,outsider,consumer,other,patient,connection,program,version,draft,productVersion,batch]=Array.from({length:13},()=>randomUUID());
 product='prd_fixture_'+randomUUID().replaceAll('-','');
 await setActivation(true);
 await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC A'),($2,'FICTIONAL CLINIC B')",[org,otherOrg]);
 for(const [person,pool] of [[staff,'workforce'],[outsider,'workforce'],[consumer,'consumer'],[other,'consumer']] as const){
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[person,'subject_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[person,pool,subject(person)]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($3,$4,'practitioner')",[org,staff,otherOrg,outsider]);
 for(const owner of [consumer,other])await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',1,'granted','program-fixture')",[owner]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')",[patient,org,'patient_fixture_'+patient.replaceAll('-','')]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",[connection,org,patient,consumer]);
 await db.query(`insert into clinical_reference.catalog_import_batches(id,contract_version,source_package_id,source_package_version,manifest_sha256,environment,status)
  values($1,'FICTIONAL/1',$2,'FICTIONAL/1',$3,'production-clinical','succeeded')`,[batch,'fixture-'+batch,batch.replaceAll('-','').repeat(2)]);
 await db.query("insert into clinical_reference.catalog_products(stable_id,review_status,active_version,environment) values($1,'approved',1,'production-clinical')",[product]);
 await db.query(`insert into clinical_reference.catalog_product_versions(id,product_stable_id,version,display_name,product_type,access_tier,direct_order_allowed,label_sha256,content_sha256,clinical_payload,source_refs,review_status,import_batch_id)
  values($1,$2,1,'FICTIONAL magnesium','supplement','open',true,$3,$4,'{}','["fictional-source"]','approved',$5)`,[productVersion,product,'b'.repeat(64),'a'.repeat(64),batch]);
 await db.query("insert into clinical_core.programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'FICTIONAL program','active',$3)",[program,org,staff]);
 await db.query(`insert into clinical_core.program_versions(id,organization_id,program_id,version,status,created_by_person_id,approved_by_person_id,approved_at,published_at)
  values($1,$2,$3,1,'published',$4,$4,clock_timestamp(),clock_timestamp()),($5,$2,$3,2,'draft',$4,null,null,null)`,[version,org,program,staff,draft]);
 await publish(phases());
});

describe('disabled by default, at both locks',()=>{
 it('the adapter is built against the exact candidate on disk, and absent, disabled or mismatched evidence leaves it disabled without touching the database',async()=>{
  expect(sha(CANDIDATE)).toBe(PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256);
  expect(activationState(undefined)).toEqual(DISABLED_PRODUCTION_PROGRAM_ACTIVATION);
  expect(activationState({contract:'production-program-activation/1',enabled:true,target:'production-clinical'})).toEqual(DISABLED_PRODUCTION_PROGRAM_ACTIVATION);
  expect(activationState({...enabledEvidence(),schemaCandidateSha256:'f'.repeat(64)})).toEqual(DISABLED_PRODUCTION_PROGRAM_ACTIVATION);
  expect(activationState({...enabledEvidence(),target:'synthetic-staging'})).toEqual(DISABLED_PRODUCTION_PROGRAM_ACTIVATION);
  expect(activationState(enabledEvidence()).enabled).toBe(true);
  const spy:ClinicalCoreDatabase={transaction:vi.fn()};
  for(const evidence of [undefined,DISABLED_PRODUCTION_PROGRAM_ACTIVATION,{...enabledEvidence(),schemaCandidateSha256:'f'.repeat(64)}]){
   await expect(createProductionProgramAssignments({database:spy,activation:evidence,verifyConsumerCore:core})(production(staff,'workforce'),{action:'programs'},'Bearer x'))
    .rejects.toMatchObject({category:'activation_refused'});
  }
  expect(spy.transaction).not.toHaveBeenCalled();expect(core).not.toHaveBeenCalled();
 });
 it('the database refuses every request while its own activation row is disabled, whatever the adapter was told, and the API role cannot flip the row',async()=>{
  await setActivation(false);
  expect((await refusal({action:'programs'},production(staff,'workforce'))).category).toBe('identity_refused');
  await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.exec('update clinical_core.production_program_activation set enabled=true');})).rejects.toThrow(/permission denied/);
  await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.exec("select clinical_private.set_request_context('"+staff+"','"+org+"','workforce','"+subject(staff)+"','clinical_data','production-clinical','clinical_phi')");
   await tx.query("select clinical_core.production_program_assignment_request('{\"action\":\"programs\"}'::jsonb)");})).rejects.toThrow(/production_program_disabled/);
 });
 it('the identity API still refuses program routes outside the synthetic boundary; this family is not wired in',()=>{
  const api=readFileSync('src/server/clinical-core/aws-identity-api.ts','utf8');
  expect(api).toContain('if(input.boundary!=="synthetic")return response(403,{error:"pilot_scope_refused"});');
  expect(api).not.toContain('production-program-assignments');
  const synthetic=readFileSync('src/server/clinical-core/program-assignments.ts','utf8');
  expect(synthetic).toContain("if(context.environment!=='synthetic-staging'||context.dataClassification!=='synthetic_only')throw new ProgramAssignmentError('identity_refused');");
 });
});

describe('authority once enabled in this test',()=>{
 it('a synthetic context is the wrong target, a wrong pool is refused, and a consumer without current Core is refused before the database is reached',async()=>{
  expect((await refusal({action:'list'},synthetic(consumer,'consumer'))).category).toBe('identity_refused');
  expect((await refusal({action:'programs'},production(consumer,'consumer'))).category).toBe('identity_refused');
  expect((await refusal({action:'list'},production(staff,'workforce'))).category).toBe('identity_refused');
  core.mockRejectedValueOnce(new Error('core_subscription_unavailable'));
  expect((await refusal({action:'list'})).category).toBe('entitlement_refused');
  await call({action:'programs'},production(staff,'workforce'));
  expect(core).toHaveBeenCalledTimes(1);expect(core).toHaveBeenCalledWith('Bearer fictional-token');
 });
 it('assigns a published version with a compiled program, offers it to the connected consumer, and refuses a draft, another clinic and an altered artifact',async()=>{
  const offered=await assign();
  expect(offered).toMatchObject({state:'offered',revision:'1',duplicate:false});
  const list=await call({action:'list'});
  expect(list.action==='list'&&list.assignments.map(a=>a.state)).toEqual(['offered']);
  expect((await refusal({action:'assign',connectionId:connection,programVersionId:draft},production(staff,'workforce'))).category).toBe('identity_refused');
  expect((await refusal({action:'assign',connectionId:connection,programVersionId:version},production(outsider,'workforce',otherOrg))).category).toBe('identity_refused');
  await publish(phases([lesson('changed')]));
  expect((await refusal({action:'assign',connectionId:connection,programVersionId:version},production(staff,'workforce'))).category).toBe('conflict');
  const current=await read(offered.enrollmentId);
  expect(current.assignment.phases[0]!.items[0]).toMatchObject({id:'lesson-a',authorship:'practitioner_authored'});
 });
 it('withholds an authored purchase URL in the consumer read while purchase is unreleased',async()=>{
  const base=supplement();
  const step={...base,product:{...base.product,purchaseUrl:'https://shop.example.test/fictional-product'}};
  await publish(phases([step]));
  const offered=await assign();
  const answer=await read(offered.enrollmentId);
  expect(answer.assignment.phases[0]?.items[0]?.product?.purchaseUrl).toBeNull();
  const stored=await db.query<{content:{items:{product:{purchaseUrl:string}}[]}[]}>(
   'select content from clinical_core.program_assignments where id=$1',[offered.enrollmentId]);
  expect(stored.rows[0]?.content[0]?.items[0]?.product.purchaseUrl).toBe('https://shop.example.test/fictional-product');
 });
 it('refuses the wrong owner, a revoked connection and a replaced connection, and a withdrawn consent',async()=>{
  const offered=await assign();
  expect((await refusal({action:'read',enrollmentId:offered.enrollmentId},production(other,'consumer'))).category).toBe('identity_refused');
  await db.query("update clinical_core.patient_connections set state='revoked',revoked_at=now() where id=$1",[connection]);
  expect((await refusal({action:'read',enrollmentId:offered.enrollmentId})).category).toBe('identity_refused');
  const replacement=randomUUID();
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",[replacement,org,patient,other]);
  expect((await refusal({action:'read',enrollmentId:offered.enrollmentId},production(other,'consumer'))).category).toBe('identity_refused');
  // One live connection per patient: the replacement is revoked before the original is restored.
  await db.query("update clinical_core.patient_connections set state='revoked',revoked_at=now() where id=$1",[replacement]);
  await db.query("update clinical_core.patient_connections set state='verified',revoked_at=null where id=$1",[connection]);
  await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',2,'revoked','program-fixture')",[consumer]);
  expect((await refusal({action:'read',enrollmentId:offered.enrollmentId})).category).toBe('consent_refused');
 });
 it('accepts once at the reviewed plan revision, reports a replay as duplicate, and refuses a stale revision, a concurrent withdraw and an advance after withdrawal',async()=>{
  const offered=await assign();
  const accepted=await accept(offered.enrollmentId);
  expect(accepted).toMatchObject({action:'accept',state:'active',revision:'2',duplicate:false});
  const stale=await refusal({action:'accept',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:'1',planRevision:'none'});
  expect(stale).toMatchObject({category:'conflict',reason:'program_revision_stale'});
  const replay=await call({action:'accept',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:'2',planRevision:(await read(offered.enrollmentId)).review.planRevision});
  expect(replay).toMatchObject({duplicate:true,revision:'2'});
  const withdrawn=await call({action:'withdraw',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:'2'});
  expect(withdrawn).toMatchObject({state:'withdrawn',revision:'3'});
  const concurrent=await refusal({action:'withdraw',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:'2'});
  expect(concurrent).toMatchObject({category:'conflict',reason:'program_revision_stale'});
  const afterWithdraw=await refusal({action:'advance',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:'3'});
  expect(afterWithdraw).toMatchObject({category:'conflict',reason:'program_not_active'});
  const changed=await refusal({action:'pause',enrollmentId:offered.enrollmentId,sourceDigest:'f'.repeat(64),expectedRevision:'3'});
  expect(changed).toMatchObject({category:'conflict',reason:'program_changed'});
 });
 it('holds every supplement step without an adopted, verified plan inventory, so a phase with one never advances',async()=>{
  await publish(phases([lesson('a'),supplement()]));
  const offered=await assign();
  const current=await read(offered.enrollmentId);
  expect(current.review).toMatchObject({inventoryComplete:false,held:['supp-1'],add:['lesson-a','lesson-b'],planRevision:expect.stringMatching(/^none:labs:[0-9a-f]{32}$/)});
  await accept(offered.enrollmentId);
  const afterAccept=await read(offered.enrollmentId);
  await call({action:'complete',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:afterAccept.assignment.revision,itemId:'lesson-a'});
  expect((await refusal({action:'complete',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:String(Number(afterAccept.assignment.revision)+1),itemId:'supp-1'})).category).toBe('identity_refused');
  await db.query("update clinical_core.program_assignments set phase_started_at=now()-interval '2 days',revision=revision+1 where id=$1",[offered.enrollmentId]);
  const due=await read(offered.enrollmentId);
  const held=await refusal({action:'advance',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:due.assignment.revision});
  expect(held).toMatchObject({category:'conflict',reason:'program_clinical_items_held'});
 });
 it('with an adopted plan whose active supplements resolve to verified releases, the inventory is complete: a new product is added, the same product is a duplicate, an overlapping one conflicts',async()=>{
  await db.query('insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note) values($1,$2,$3)',[productVersion,staff,JSON.stringify(proof())]);
  await adoptPlan([{id:'item-1',status:'active',dose:'1 capsule daily',governedProduct:{productId:product,labelVersionId:productVersion}}]);
  await publish(phases([supplement('product-new',['fictional_other_mineral'],'100 mg')]));
  const added=await read((await assign()).enrollmentId);
  expect(added.review).toMatchObject({inventoryComplete:true,add:['supp-1','lesson-b'],held:[],duplicate:[],conflicts:[]});
  expect(added.review.planRevision).toMatch(/^[0-9a-f-]{36}:1:[0-9a-f]{64}:1:labs:[0-9a-f]{32}$/);
  const second=randomUUID();
  await db.query(`insert into clinical_core.program_versions(id,organization_id,program_id,version,status,created_by_person_id,approved_by_person_id,approved_at,published_at) values($1,$2,$3,3,'published',$4,$4,clock_timestamp(),clock_timestamp())`,[second,org,program,staff]);
  await publish(phases([supplement(product,['magnesium_glycinate'],'1 capsule daily')]),second);
  const duplicate=await read((await assign(second)).enrollmentId);
  expect(duplicate.review).toMatchObject({duplicate:['supp-1'],conflicts:[]});
  const third=randomUUID();
  await db.query(`insert into clinical_core.program_versions(id,organization_id,program_id,version,status,created_by_person_id,approved_by_person_id,approved_at,published_at) values($1,$2,$3,4,'published',$4,$4,clock_timestamp(),clock_timestamp())`,[third,org,program,staff]);
  await publish(phases([supplement('product-overlap',['Magnesium_Glycinate','zinc'],'2 capsules')]),third);
  const conflict=await read((await assign(third)).enrollmentId);
  expect(conflict.review).toMatchObject({conflicts:['supp-1'],duplicate:[]});
 });
 it('an unverified release, a missing dose or a missing product identity in the adopted plan keeps the inventory incomplete, and a withdrawn verification does not fall back to an older one',async()=>{
  await adoptPlan([{id:'item-1',status:'active',dose:'1 capsule daily',governedProduct:{productId:product,labelVersionId:productVersion}}]);
  await publish(phases([supplement('product-new')]));
  const unverified=await read((await assign()).enrollmentId);
  expect(unverified.review).toMatchObject({inventoryComplete:false,held:['supp-1']});
  await db.query('insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note) values($1,$2,$3)',[productVersion,staff,JSON.stringify(proof())]);
  await db.query('insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note,verified_at) values($1,$2,$3,now()+interval \'1 second\')',[productVersion,staff,JSON.stringify({contract:'production-catalog-ingredient-withdrawal/1'})]);
  const withdrawn=await read((await assign()).enrollmentId);
  expect(withdrawn.review.inventoryComplete).toBe(false);
  await db.query('delete from clinical_core.owned_consumer_active_plans where owner_id=$1',[consumer]);
  await adoptPlan([{id:'item-2',status:'active',governedProduct:{productId:product,labelVersionId:productVersion}}]);
  expect((await read((await assign()).enrollmentId)).review.inventoryComplete).toBe(false);
 });
 it('the workforce preview compiles the published artifact with every supplement held, and the programs listing says which versions are assignable',async()=>{
  await publish(phases([lesson('a'),supplement()]));
  const preview=await call({action:'preview',programVersionId:version},production(staff,'workforce'));
  expect(preview.action==='preview'&&preview.review).toMatchObject({inventoryComplete:false,held:['supp-1']});
  await db.query(`update clinical_core.program_versions set content='{"title":"Studio only","modules":[]}'::jsonb where id=$1`,[version]);
  const programs=await call({action:'programs'},production(staff,'workforce'));
  expect(programs.action==='programs'&&programs.programs.map(p=>[p.programVersionId,p.assignable])).toEqual([[version,false]]);
  expect((await refusal({action:'assign',connectionId:connection,programVersionId:version},production(staff,'workforce'))).category).toBe('identity_refused');
 });
});

/**
 * Lab follow-up 2026-10-13 (WP1): the service reads the owner's saved results itself before it declares a supplement
 * step available. Personal copies never verify anything; a clinic reading is verified only by a reviewer's current
 * attestation, made through the attestation candidate's own function. Fictional readings only.
 */
describe('the lab-aware review (program-lab-review/1)',()=>{
 const DOC='d'.repeat(64);
 const iron=()=>supplement('product-iron',['iron_bisglycinate'],'18 mg');
 async function exec(person:string,pool:'workforce'|'consumer',sql:string,params:unknown[]=[]){
  return db.transaction(async tx=>{
   await tx.exec('set local role clinical_core_api');
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[person,org,pool,subject(person),'clinical_data','production-clinical','clinical_phi']);
   return (await tx.query<Record<string,unknown>>(sql,params)).rows;
  });
 }
 /** A complete, verified plan inventory, so the step would otherwise be available. */
 async function completeInventory(){
  await db.query('insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note) values($1,$2,$3)',[productVersion,staff,JSON.stringify(proof())]);
  await adoptPlan([{id:'item-1',status:'active',dose:'1 capsule daily',governedProduct:{productId:product,labelVersionId:productVersion}}]);
 }
 async function labHistory(owner=consumer){
  await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'lab_history',1,'granted','program-fixture')",[owner]);
 }
 /** A personal copy of a reading: the app's import, never verified. */
 async function ownedReading(value:number,drawnAt:string,owner=consumer,name='Ferritin',reportedRange={low:30,high:400}){
  const id=randomUUID();
  const payload={id,panelId:randomUUID(),markerId:randomUUID(),panelName:'Fictional panel',name,value,unit:'ng/mL',drawnAt,
   reportedRange,sourceStatus:'consumer_import_unverified'};
  await db.query(`insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
   values($1,'lab_observations',$2,1,$3,$4,$5::jsonb,false,1)`,[owner,id,randomUUID(),'c'.repeat(64),JSON.stringify(payload)]);
 }
 let providerReady=false;
 /** A clinic reading for the enrolled patient record, sent as lab-result/2 and accepted by the practice. */
 async function clinicReading(value:number,collectedAt:string,name='Ferritin',target={person:consumer,connection,patient},range={min:30,max:400}){
  if(!providerReady){
   await db.query("update clinical_core.lab_result_transfer_v2_activation set enabled=true,evidence_sha256=repeat('e',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()");
   await db.query("update clinical_core.lab_observation_attestation_activation set enabled=true,evidence_sha256=repeat('e',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()");
   providerReady=true;
  }
  if(!(await db.query('select 1 from clinical_core.sync_providers where organization_id=$1',[org])).rows.length){
   await db.query("insert into clinical_core.sync_providers(organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state,reviewed_by_person_id,reviewed_at) values($1,'alp_patient_sync','patient-sync/1','lab-result/1','fictional-1','active',$2,now())",[org,staff]);
   await db.query("insert into clinical_core.consent_artifacts(organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,'lab_results_import','fictional-1',$2,'US-FICTIONAL','approved',now(),$3)",[org,'a'.repeat(64),staff]);
  }
  if(!(await db.query("select 1 from clinical_core.consent_grants where connection_id=$1 and scope='lab_results_import'",[target.connection])).rows.length){
   const [artifact]=(await db.query<{id:string}>("select id from clinical_core.consent_artifacts where organization_id=$1 and scope='lab_results_import'",[org])).rows;
   await db.query("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'lab_results_import','granted','patient_app','self',1,$5)",[org,target.patient,target.connection,artifact!.id,target.person]);
  }
  const body={schemaVersion:'lab-result/2',provider:'alp_patient_sync',providerEventId:'lab:'+randomUUID().replaceAll('-',''),connectionId:target.connection,
   resourceVersion:'f'.repeat(64),occurredAt:new Date().toISOString(),
   source:{system:'ai_longevity_pro_v2',recordType:'lab_panels',panelId:'panel_'+'1'.repeat(32),markerId:'marker_'+randomUUID().replaceAll('-','')},
   panel:{name:'Fictional iron panel',collectedAt},result:{name,value,unit:'ng/mL',referenceRange:range},
   provenance:{origin:'uploaded_report_analysis',documents:[DOC],reportedVerification:'needs_human_review'}};
  const [event]=await exec(target.person,'consumer','select * from clinical_core.record_lab_import_v2($1::jsonb)',[JSON.stringify(body)]);
  const [review]=await exec(staff,'workforce',"select * from clinical_core.review_lab_import($1,'accept',null)",[event!.event_id]);
  return {observation:review!.observation_id as string,name,value,collectedAt};
 }
 async function attest(reading:{observation:string;name:string;value:number;collectedAt:string},outcome:'verified'|'refuted'='verified',supersedes:string|null=null){
  const [row]=await exec(staff,'workforce','select clinical_core.attest_lab_observation($1::jsonb) as data',[JSON.stringify({statement:'lab-reading-attestation/1',
   requestId:randomUUID(),observationId:reading.observation,outcome,reading:{marker:reading.name,value:reading.value,unit:'ng/mL',observedAt:reading.collectedAt},
   documentSha256:DOC,supersedes})]);
  return (row!.data as {attestationId:string}).attestationId;
 }
 const reviewOf=async()=>(await read((await assign()).enrollmentId)).review;

 it('a high ferritin beside an iron step: the service holds the step itself, names why, and refuses to complete it (fails before: it was available)',async()=>{
  await completeInventory();await labHistory();
  await ownedReading(420,'2026-10-01');
  await publish(phases([lesson('a'),iron()]));
  const offered=await assign();
  const current=await read(offered.enrollmentId);
  expect(current.review).toMatchObject({inventoryComplete:true,add:['lesson-a','lesson-b'],held:['supp-1'],
   labHolds:[{itemId:'supp-1',nutrient:'iron',reason:'measured_above_range',decision:'clinician_review'}]});
  // A reason, never the reading: no value, range, marker or direction leaves the service.
  expect(Object.keys(current.review.labHolds![0]!).sort()).toEqual(['decision','itemId','nutrient','reason']);
  const {planRevision:_bound,...decided}=current.review;
  expect(JSON.stringify(decided)).not.toMatch(/420|400|ferritin|ng\/mL|"direction"|"value"|"unit"/i);
  await accept(offered.enrollmentId);
  const active=await read(offered.enrollmentId);
  expect((await refusal({action:'complete',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:active.assignment.revision,itemId:'supp-1'})).category).toBe('identity_refused');
  await db.query("update clinical_core.program_assignments set phase_started_at=now()-interval '2 days',revision=revision+1 where id=$1",[offered.enrollmentId]);
  const due=await read(offered.enrollmentId);
  await call({action:'complete',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:due.assignment.revision,itemId:'lesson-a'});
  expect(await refusal({action:'advance',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:String(Number(due.assignment.revision)+1)}))
   .toMatchObject({category:'conflict',reason:'program_clinical_items_held'});
 });
 it('missing or unverified readings are not reassurance for iron: none, a personal copy, an accepted but unattested clinic reading, or a refuted one all hold',async()=>{
  await completeInventory();
  await publish(phases([iron()]));
  expect(await reviewOf()).toMatchObject({held:['supp-1'],labHolds:[{itemId:'supp-1',reason:'status_not_verified'}]});
  await labHistory();await ownedReading(80,'2026-10-01');
  expect(await reviewOf()).toMatchObject({held:['supp-1'],labHolds:[{itemId:'supp-1',reason:'status_not_verified'}]});
  const clinic=await clinicReading(80,'2026-10-02T09:00:00.000Z');
  expect(await reviewOf()).toMatchObject({held:['supp-1'],labHolds:[{itemId:'supp-1',reason:'status_not_verified'}]});
  const verified=await attest(clinic);
  expect(await reviewOf()).toMatchObject({add:['supp-1','lesson-b'],held:[],labHolds:[]});
  await attest(clinic,'refuted',verified);
  expect(await reviewOf()).toMatchObject({held:['supp-1'],labHolds:[{itemId:'supp-1',reason:'status_not_verified'}]});
 });
 it('a normal verified result leaves an iron step as the service otherwise decided, and a step without a lab-sensitive nutrient is untouched',async()=>{
  await completeInventory();
  await attest(await clinicReading(80,'2026-10-02T09:00:00.000Z'));
  await publish(phases([iron()]));
  expect(await reviewOf()).toMatchObject({inventoryComplete:true,add:['supp-1','lesson-b'],held:[],duplicate:[],conflicts:[],labHolds:[]});
  const second=randomUUID();
  await db.query(`insert into clinical_core.program_versions(id,organization_id,program_id,version,status,created_by_person_id,approved_by_person_id,approved_at,published_at) values($1,$2,$3,3,'published',$4,$4,clock_timestamp(),clock_timestamp())`,[second,org,program,staff]);
  await publish(phases([supplement('product-other',['fictional_other_mineral'],'1 capsule')]),second);
  expect((await read((await assign(second)).enrollmentId)).review).toMatchObject({add:['supp-1','lesson-b'],labHolds:[]});
 });
 it('conflicting readings: an older high personal copy and a newer verified normal clinic reading disagree, and the step stays held',async()=>{
  await completeInventory();await labHistory();
  await ownedReading(420,'2026-09-01');
  await attest(await clinicReading(80,'2026-10-02T09:00:00.000Z'));
  await publish(phases([iron()]));
  expect(await reviewOf()).toMatchObject({held:['supp-1'],labHolds:[{itemId:'supp-1',nutrient:'iron',reason:'results_disagree'}]});
 });
 it('a non-iron nutrient holds only on a reading above its own range; without readings it is decided as before',async()=>{
  await completeInventory();await labHistory();
  await publish(phases([supplement('product-d',['vitamin_d3'],'1000 IU')]));
  expect(await reviewOf()).toMatchObject({add:['supp-1','lesson-b'],labHolds:[]});
  await ownedReading(60,'2026-10-01',consumer,'25-OH Vitamin D',{low:30,high:100});
  expect(await reviewOf()).toMatchObject({add:['supp-1','lesson-b'],labHolds:[]});
  await ownedReading(150,'2026-10-02',consumer,'25-OH Vitamin D',{low:30,high:100});
  expect(await reviewOf()).toMatchObject({held:['supp-1'],labHolds:[{itemId:'supp-1',nutrient:'vitamin_d',reason:'measured_above_range'}]});
 });
 it('stale revisions: a result recorded after the person read the review refuses the accept made against it, and the fresh review is accepted',async()=>{
  await completeInventory();await labHistory();
  await publish(phases([supplement('product-d',['vitamin_d3'],'1000 IU')]));
  const offered=await assign();
  const seen=await read(offered.enrollmentId);
  expect(seen.review.add).toContain('supp-1');
  await ownedReading(150,'2026-10-01',consumer,'Vitamin D',{low:30,high:100});
  expect(await refusal({action:'accept',enrollmentId:offered.enrollmentId,sourceDigest:offered.sourceDigest,expectedRevision:seen.assignment.revision,planRevision:seen.review.planRevision}))
   .toMatchObject({category:'conflict',reason:'program_review_stale'});
  const fresh=await read(offered.enrollmentId);
  expect(fresh.review.planRevision).not.toBe(seen.review.planRevision);
  expect(fresh.review).toMatchObject({held:['supp-1'],labHolds:[{reason:'measured_above_range'}]});
  expect(await accept(offered.enrollmentId)).toMatchObject({state:'active',duplicate:false});
  // Withdrawing lab history consent changes what the service can read, so it changes the revision too.
  const before=(await read(offered.enrollmentId)).review.planRevision;
  await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'lab_history',2,'revoked','program-fixture')",[consumer]);
  const after=await read(offered.enrollmentId);
  expect(after.review.planRevision).not.toBe(before);
  expect(after.review).toMatchObject({add:['supp-1','lesson-b'],labHolds:[]});
 });
 it('cross-owner access: another person’s readings never move this review, and this person’s readings never leave it',async()=>{
  await completeInventory();
  await labHistory(other);await ownedReading(420,'2026-10-01',other);
  await publish(phases([supplement('product-d',['vitamin_d3'],'1000 IU')]));
  await labHistory();
  const offered=await assign();
  const mine=await read(offered.enrollmentId);
  expect(mine.review).toMatchObject({add:['supp-1','lesson-b'],labHolds:[]});
  await ownedReading(150,'2026-10-01',other,'Vitamin D',{low:30,high:100});
  expect((await read(offered.enrollmentId)).review.planRevision).toBe(mine.review.planRevision);
  // A high clinic reading for another patient of the same clinic, accepted by the practice, does not reach this enrollment.
  const elsewhere=randomUUID(),theirs=randomUUID();
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','OTHER')",[elsewhere,org,'patient_fixture_'+elsewhere.replaceAll('-','')]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",[theirs,org,elsewhere,other]);
  await clinicReading(150,'2026-10-02T09:00:00.000Z','Vitamin D',{person:other,connection:theirs,patient:elsewhere},{min:30,max:100});
  expect((await db.query("select count(*)::int as n from clinical_core.lab_observations where patient_record_id=$1",[elsewhere])).rows[0]).toEqual({n:1});
  expect((await read(offered.enrollmentId)).review).toMatchObject({planRevision:mine.review.planRevision,add:['supp-1','lesson-b'],labHolds:[]});
  // And the other consumer cannot read this enrollment's review at all.
  expect((await refusal({action:'read',enrollmentId:offered.enrollmentId},production(other,'consumer'))).category).toBe('identity_refused');
 });
 it('the workforce preview has no owner, reads no results and carries no lab holds; supplement steps stay held as before',async()=>{
  await publish(phases([lesson('a'),iron()]));
  const preview=await call({action:'preview',programVersionId:version},production(staff,'workforce'));
  expect(preview.action==='preview'&&preview.review).toMatchObject({inventoryComplete:false,held:['supp-1'],planRevision:'none'});
  expect(preview.action==='preview'&&preview.review.labHolds).toBeUndefined();
 });
});
