import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

/**
 * The consumer boundary of the production program family (program-consumer-boundary/1), BLOCKED, against the actual
 * 106-migration production artifact, the two lab candidates and the unchanged program candidate. Every call here is
 * SQL made AS THE API ROLE (`set local role clinical_core_api`), never through the TypeScript adapter: the point is
 * what the database itself will hand the API, whatever adapter sits in front of it. Fictional identities and a
 * fictional destination only.
 *
 * Order matters and is part of the evidence. The first block runs against the parent alone and characterizes the
 * gap (it passes on the base: the API role is handed the authored destination). The boundary is applied after it;
 * the blocks after that fail on the base because the boundary does not exist there. The rollback block is last.
 */
const PARENT='infra/aws-clinical-core/production-candidates/production-program-assignments.sql';
const BOUNDARY='infra/aws-clinical-core/production-candidates/production-program-consumer-boundary.sql';
const ROLLBACK='infra/aws-clinical-core/production-candidates/production-program-consumer-boundary-rollback.sql';
const LAB_CANDIDATES=['infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql','infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql'];
const DESTINATION='https://shop.example.test/fictional-destination-0f3c';
let db:PGlite;
let org:string,otherOrg:string,staff:string,outsider:string,consumer:string,other:string,patient:string,connection:string,program:string,version:string,product:string,productVersion:string,batch:string;
const subject=(id:string)=>'fictional-'+id;
type Pool='workforce'|'consumer';
type Json=Record<string,any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- answers are checked field by field below

/** One request through `fn`, as the API role, with a production request context for `person`. */
async function asApi(fn:string,person:string,pool:Pool,request:unknown,organization=org):Promise<{data:Json;text:string}>{
 return db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[person,organization,pool,subject(person),'clinical_data','production-clinical','clinical_phi']);
  const raw=(await tx.query<{data:unknown}>(`select ${fn}($1::jsonb) as data`,[JSON.stringify(request)])).rows[0]?.data;
  const data=(typeof raw==='string'?JSON.parse(raw):raw) as Json;
  return {data,text:JSON.stringify(data)};
 });
}
const bounded=(person:string,pool:Pool,request:unknown,organization=org)=>asApi('clinical_core.production_program_bounded_request',person,pool,request,organization);
const parent=(person:string,pool:Pool,request:unknown,organization=org)=>asApi('clinical_core.production_program_assignment_request',person,pool,request,organization);
/** The refusal message the database raised; a request that was answered is a failure of the test. */
async function refused(call:Promise<unknown>):Promise<string>{
 try{await call;}catch(error){return error instanceof Error?error.message:String(error);}
 throw new Error('expected a refusal');
}
/** What a refused or answered completion left behind: nothing, unless it was applied. */
async function writes(enrollmentId:string){
 const [row]=(await db.query<{revision:string;completions:number;audit:number}>(`select a.revision::text as revision,
   (select count(*)::int from clinical_core.program_assignment_completions c where c.assignment_id=a.id) as completions,
   (select count(*)::int from clinical_core.program_assignment_audit x where x.assignment_id=a.id and x.action='complete') as audit
  from clinical_core.program_assignments a where a.id=$1`,[enrollmentId])).rows;
 return row!;
}

const lesson=(suffix:string)=>({id:'lesson-'+suffix,title:'Fictional lesson '+suffix,kind:'lesson',instructions:'Read the fictional lesson.',released:true,authorship:'practitioner_authored'});
const supplement=()=>({id:'supp-1',title:'Fictional supplement step',kind:'supplement',instructions:'Fictional instruction.',released:true,
 product:{id:'product-fictional-1',ingredientKeys:['fictional_other_mineral'],dose:'100 mg',purchaseUrl:DESTINATION,
  catalog:{stableId:'prd_fictional_mineral',version:1,target:'production-clinical'}}});
const phases=()=>[{id:'phase-1',title:'Phase one',days:1,transition:'scheduled',items:[lesson('a'),lesson('c'),supplement()]},
 {id:'phase-2',title:'Phase two',days:1,transition:'scheduled',items:[lesson('b')]}];
async function publish(versionId=version){
 await db.query(`update clinical_core.program_versions set content=$2::jsonb,content_sha256=encode(public.digest(convert_to(($2::jsonb)::text,'UTF8'),'sha256'),'hex') where id=$1`,
  [versionId,JSON.stringify({title:'Fictional',modules:[],consumerProgram:{title:'Fictional mineral guide',phases:phases()}})]);
}
async function setActivation(table:'production_program_activation'|'program_consumer_boundary_activation',enabled:boolean){
 await db.query(`update clinical_core.${table} set enabled=$1,evidence_sha256=case when $1 then repeat('e',64) else null end,reviewed_by=case when $1 then 'FICTIONAL REVIEW FIXTURE' else null end,reviewed_at=case when $1 then now() else null end`,[enabled]);
}
const planEntry=()=>({id:'item-1',status:'active',dose:'1 capsule daily',governedProduct:{productId:product,labelVersionId:productVersion}});
async function planVersion(record:string,revision:number,note:string){
 const payload={status:'active',supplements_json:[planEntry()],peptides_json:[],note};
 const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 await db.query(`insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
  values($1,'protocols',$2,$3,$4,$5,$6::jsonb,false,1)`,[consumer,record,revision,randomUUID(),digest,JSON.stringify(payload)]);
 return digest;
}
/** An adopted plan whose one supplement resolves to a verified ingredient release: the inventory is complete, so the
 * program's supplement step is available rather than held. */
async function completeInventory(){
 await db.query('insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note) values($1,$2,$3)',[productVersion,staff,JSON.stringify({
  contract:'production-catalog-ingredient-release/1',productId:product,productVersion:1,productContentSha256:'a'.repeat(64),labelVersionId:productVersion,
  labelSha256:'b'.repeat(64),completeness:'complete',sourceVerification:'V',ingredientKeys:['magnesium_glycinate'],sourceRefs:['fictional-source']})]);
 const record=randomUUID();
 const digest=await planVersion(record,1,'first');
 await db.query(`insert into clinical_core.owned_consumer_active_plans(owner_id,record_id,revision,content_sha256,consent_revision,adopted_at,adoption_request_id)
  values($1,$2,1,$3,1,now(),$4)`,[consumer,record,digest,randomUUID()]);
 return record;
}
/** The plan changes on another device: a new revision of the adopted record becomes the active plan. */
async function changePlan(record:string){
 const digest=await planVersion(record,2,'revised elsewhere');
 await db.query('update clinical_core.owned_consumer_active_plans set revision=2,content_sha256=$2 where owner_id=$1',[consumer,digest]);
}
async function labHistory(){
 await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'lab_history',1,'granted','program-fixture')",[consumer]);
}
/** A personal reading, or a correction of one (a later revision of the same record supersedes it). */
async function reading(value:number,record=randomUUID(),revision=1){
 const payload={id:record,panelId:randomUUID(),markerId:randomUUID(),panelName:'Fictional panel',name:'Fictional marker',value,unit:'U',drawnAt:'2026-10-01',
  reportedRange:{low:1,high:100},sourceStatus:'consumer_import_unverified'};
 await db.query(`insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
  values($1,'lab_observations',$2,$3,$4,$5,$6::jsonb,false,1)`,[consumer,record,revision,randomUUID(),'c'.repeat(64),JSON.stringify(payload)]);
 return record;
}

beforeAll(async()=>{
 const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',timeout:20_000,maxBuffer:8*1024*1024}));
 expect(manifest.migrations).toHaveLength(106);
 db=new PGlite({extensions:{pgcrypto}});
 for(const migration of manifest.migrations)await db.exec(files[migration.file]);
 for(const candidate of LAB_CANDIDATES)await db.exec(readFileSync(candidate,'utf8'));
 await db.exec(readFileSync(PARENT,'utf8'));
 for(const scope of ['protocols_supplements','lab_history'])await db.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
  values($1,'program-fixture','FICTIONAL ONLY',encode(public.digest('FICTIONAL ONLY','sha256'),'hex'),'FIXTURE NOT APPROVAL',now()-interval '1 day')`,[scope]);
},120_000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
 [org,otherOrg,staff,outsider,consumer,other,patient,connection,program,version,productVersion,batch]=Array.from({length:12},()=>randomUUID());
 product='prd_fixture_'+randomUUID().replaceAll('-','');
 await setActivation('production_program_activation',true);
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
  values($1,$2,$3,1,'published',$4,$4,clock_timestamp(),clock_timestamp())`,[version,org,program,staff]);
 await publish();
});

describe('the parent alone (characterization: passes on the base, and is the gap the boundary closes)',()=>{
 it('the API role is handed the authored purchase destination by the consumer read and by the workforce preview',async()=>{
  const assigned=(await parent(staff,'workforce',{action:'assign',connectionId:connection,programVersionId:version})).data;
  const read=await parent(consumer,'consumer',{action:'read',enrollmentId:assigned.enrollmentId});
  expect(read.data.assignment.phases[0].items[2].product.purchaseUrl).toBe(DESTINATION);
  const preview=await parent(staff,'workforce',{action:'preview',programVersionId:version});
  expect(preview.text).toContain(DESTINATION);
 });
 it('the parent applies a completion made against a review that a new reading has already changed: nothing names the plan revision',async()=>{
  await labHistory();
  const offer=(await parent(staff,'workforce',{action:'assign',connectionId:connection,programVersionId:version})).data;
  const offered=(await parent(consumer,'consumer',{action:'read',enrollmentId:offer.enrollmentId})).data;
  await parent(consumer,'consumer',{action:'accept',enrollmentId:offer.enrollmentId,sourceDigest:offer.sourceDigest,expectedRevision:offered.assignment.revision,planRevision:offered.review.planRevision});
  const seen=(await parent(consumer,'consumer',{action:'read',enrollmentId:offer.enrollmentId})).data;
  await reading(42);
  expect((await parent(consumer,'consumer',{action:'read',enrollmentId:offer.enrollmentId})).data.review.planRevision).not.toBe(seen.review.planRevision);
  const before=await writes(offer.enrollmentId);
  await parent(consumer,'consumer',{action:'complete',enrollmentId:offer.enrollmentId,sourceDigest:seen.assignment.sourceDigest,expectedRevision:seen.assignment.revision,itemId:'lesson-a'});
  expect(await writes(offer.enrollmentId)).toMatchObject({completions:before.completions+1,audit:before.audit+1});
 });
});

describe('with the consumer boundary applied',()=>{
 beforeAll(async()=>{await db.exec(readFileSync(BOUNDARY,'utf8'));});
 beforeEach(async()=>{await setActivation('program_consumer_boundary_activation',true);});
 async function assigned(){return (await bounded(staff,'workforce',{action:'assign',connectionId:connection,programVersionId:version})).data as {enrollmentId:string;sourceDigest:string;revision:string};}
 async function view(enrollmentId:string,person=consumer){return (await bounded(person,'consumer',{action:'read',enrollmentId})).data;}
 async function active(){
  const offer=await assigned();
  const seen=await view(offer.enrollmentId);
  await bounded(consumer,'consumer',{action:'accept',enrollmentId:offer.enrollmentId,sourceDigest:seen.assignment.sourceDigest,
   expectedRevision:seen.assignment.revision,planRevision:seen.review.planRevision});
  return offer.enrollmentId;
 }
 const complete=(seen:Json,itemId:string,person=consumer,organization=org)=>bounded(person,'consumer',{action:'complete',enrollmentId:seen.assignment.enrollmentId,
  sourceDigest:seen.assignment.sourceDigest,expectedRevision:seen.assignment.revision,planRevision:seen.review.planRevision,itemId},organization);

 describe('BLOCKED: disabled, unflippable, and the only door',()=>{
  it('refuses everything while its own row is disabled, writes nothing, and the API role can neither flip the row nor reach the parent or the tables',async()=>{
   const offer=await assigned();
   await setActivation('program_consumer_boundary_activation',false);
   const before=await writes(offer.enrollmentId);
   for(const request of [{action:'read',enrollmentId:offer.enrollmentId},{action:'list'},{action:'complete',enrollmentId:offer.enrollmentId,sourceDigest:offer.sourceDigest,
    expectedRevision:offer.revision,planRevision:'any',itemId:'lesson-a'}])expect(await refused(bounded(consumer,'consumer',request))).toMatch(/\bprogram_boundary_disabled\b/);
   expect(await refused(bounded(staff,'workforce',{action:'preview',programVersionId:version}))).toMatch(/\bprogram_boundary_disabled\b/);
   expect(await writes(offer.enrollmentId)).toEqual(before);
   const asRole=(sql:string)=>refused(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.query(sql);}));
   expect(await asRole('update clinical_core.program_consumer_boundary_activation set enabled=true')).toMatch(/permission denied/);
   expect(await asRole(`select clinical_core.production_program_assignment_request('{"action":"list"}'::jsonb)`)).toMatch(/permission denied/);
   expect(await asRole('select content from clinical_core.program_assignments')).toMatch(/permission denied/);
   expect(await asRole('select content from clinical_core.program_versions')).toMatch(/permission denied/);
   expect(await asRole(`select clinical_private.production_program_bounded_complete('{}'::jsonb)`)).toMatch(/permission denied/);
  });
 });

 describe('work package 1: no purchase destination leaves the database through the API role',()=>{
  it('available step: read, list, accept, complete and the workforce preview carry no destination; the authored record still holds it',async()=>{
   await completeInventory();
   const offer=await assigned();
   const seen=await bounded(consumer,'consumer',{action:'read',enrollmentId:offer.enrollmentId});
   expect(seen.data.review.add).toContain('supp-1');
   expect(seen.data.assignment.phases[0].items[2].product).toEqual({id:'product-fictional-1',ingredientKeys:['fictional_other_mineral'],dose:'100 mg',purchaseUrl:null,
    catalog:{stableId:'prd_fictional_mineral',version:1,target:'production-clinical'}});
   const answers=[seen,await bounded(consumer,'consumer',{action:'list'}),
    await bounded(consumer,'consumer',{action:'accept',enrollmentId:offer.enrollmentId,sourceDigest:seen.data.assignment.sourceDigest,expectedRevision:seen.data.assignment.revision,planRevision:seen.data.review.planRevision}),
    await bounded(staff,'workforce',{action:'preview',programVersionId:version})];
   const accepted=await view(offer.enrollmentId);
   answers.push(await complete(accepted,'supp-1'));
   for(const answer of answers){expect(answer.text).not.toContain(DESTINATION);expect(answer.text).not.toMatch(/"purchaseUrl":"/);}
   expect(answers[3]!.data.phases[0].items[2].product.purchaseUrl).toBeNull();
   // The practitioner-authored record is preserved, in the published version and in the pinned assignment.
   expect(JSON.stringify((await db.query('select content from clinical_core.program_versions where id=$1',[version])).rows[0])).toContain(DESTINATION);
   expect(JSON.stringify((await db.query('select content from clinical_core.program_assignments where id=$1',[offer.enrollmentId])).rows[0])).toContain(DESTINATION);
   // The digest the person accepted is the digest of the authored artifact, unchanged by the redaction.
   expect(seen.data.assignment.sourceDigest).toBe(offer.sourceDigest);
  });
  it('held step: the same read carries no destination for the step it holds',async()=>{
   const offer=await assigned();
   const seen=await bounded(consumer,'consumer',{action:'read',enrollmentId:offer.enrollmentId});
   expect(seen.data.review).toMatchObject({inventoryComplete:false,held:['supp-1']});
   expect(seen.text).not.toContain(DESTINATION);
   expect(seen.data.assignment.phases[0].items[2].product.purchaseUrl).toBeNull();
  });
  it('stale: refusals of a stale accept or completion name a reason and nothing else',async()=>{
   const offer=await assigned();
   const seen=await view(offer.enrollmentId);
   const messages=[await refused(bounded(consumer,'consumer',{action:'accept',enrollmentId:offer.enrollmentId,sourceDigest:offer.sourceDigest,expectedRevision:seen.assignment.revision,planRevision:'stale'})),
    await refused(bounded(consumer,'consumer',{action:'accept',enrollmentId:offer.enrollmentId,sourceDigest:offer.sourceDigest,expectedRevision:'99',planRevision:seen.review.planRevision})),
    await refused(complete({...seen,review:{...seen.review,planRevision:'stale'}},'lesson-a')),
    await refused(bounded(consumer,'consumer',{action:'read'}))];
   expect(messages).toEqual([expect.stringMatching(/^program_review_stale$/),expect.stringMatching(/^program_assignment_revision_stale$/),
    expect.stringMatching(/^program_review_stale$/),expect.stringMatching(/^program_assignment_invalid$/)]);
   for(const message of messages)expect(message).not.toContain(DESTINATION);
  });
  it('cross-owner and cross-clinic: one refusal, no destination, no answer',async()=>{
   const offer=await assigned();
   const seen=await view(offer.enrollmentId);
   const messages=[await refused(bounded(other,'consumer',{action:'read',enrollmentId:offer.enrollmentId})),
    await refused(bounded(consumer,'consumer',{action:'read',enrollmentId:offer.enrollmentId},otherOrg)),
    await refused(complete(seen,'lesson-a',other)),
    await refused(bounded(outsider,'workforce',{action:'preview',programVersionId:version},otherOrg))];
   expect(messages).toEqual(['program_assignment_refused','program_assignment_refused','program_assignment_refused','program_assignment_unpublished']);
   expect((await bounded(other,'consumer',{action:'list'})).data.assignments).toEqual([]);
   expect((await bounded(outsider,'workforce',{action:'status'},otherOrg)).data.assignments).toEqual([]);
  });
  it('every other projection the API role can ask for answers without a destination, and the authoring surface refuses a consumer',async()=>{
   await assigned();
   for(const request of [{action:'status'},{action:'programs'},{action:'connections'}]){
    const answer=await bounded(staff,'workforce',request);
    expect(answer.text).not.toContain(DESTINATION);
   }
   const studio=await refused(db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[consumer,org,'consumer',subject(consumer),'clinical_data','production-clinical','clinical_phi']);
    await tx.query(`select clinical_core.invoke_program_operation('get_program_studio','{}'::jsonb)`);
   }));
   expect(studio).not.toContain(DESTINATION);
  });
 });

 describe('work package 2: a completion is decided against the review the person was shown',()=>{
  it('a completion that does not name the plan revision is refused before anything is written',async()=>{
   const id=await active();const seen=await view(id);const before=await writes(id);
   expect(await refused(bounded(consumer,'consumer',{action:'complete',enrollmentId:id,sourceDigest:seen.assignment.sourceDigest,expectedRevision:seen.assignment.revision,itemId:'lesson-a'})))
    .toBe('program_assignment_invalid');
   expect(await writes(id)).toEqual(before);
  });
  it('an authorized completion at the current revisions is recorded once, with one audit row, and moves the assignment revision',async()=>{
   const id=await active();const seen=await view(id);const before=await writes(id);
   const done=(await complete(seen,'lesson-a')).data;
   expect(done).toEqual({action:'complete',enrollmentId:id,revision:String(Number(before.revision)+1),itemId:'lesson-a'});
   expect(await writes(id)).toEqual({revision:done.revision,completions:before.completions+1,audit:before.audit+1});
   expect((await view(id)).completed).toEqual(['lesson-a']);
  });
  it('race, result first: a reading recorded after the read refuses the completion made against it, writes nothing, though the step is still listed as available',async()=>{
   await labHistory();
   const id=await active();const seen=await view(id);const before=await writes(id);
   await reading(42);
   const now=await view(id);
   expect(now.review.add).toContain('lesson-a');
   expect(now.review.planRevision).not.toBe(seen.review.planRevision);
   expect(await refused(complete(seen,'lesson-a'))).toBe('program_review_stale');
   expect(await writes(id)).toEqual(before);
   // The current review is completed as it stands.
   expect((await complete(now,'lesson-a')).data.itemId).toBe('lesson-a');
   expect(await writes(id)).toMatchObject({completions:before.completions+1,audit:before.audit+1});
  });
  it('race, completion first: the completion stands; a second completion against the view from before the new reading is refused',async()=>{
   await labHistory();
   const id=await active();
   await complete(await view(id),'lesson-a');
   const after=await view(id);const before=await writes(id);
   await reading(42);
   expect(await refused(complete(after,'lesson-c'))).toBe('program_review_stale');
   expect(await writes(id)).toEqual(before);
   expect((await view(id)).completed).toEqual(['lesson-a']);
  });
  it('a corrected reading (a later revision superseding it) and a plan changed on another device each refuse a completion made against the older review',async()=>{
   await labHistory();const record=await completeInventory();
   const first=await reading(42);
   const id=await active();
   const seen=await view(id);const before=await writes(id);
   await reading(43,first,2);
   expect(await refused(complete(seen,'lesson-a'))).toBe('program_review_stale');
   const corrected=await view(id);
   await changePlan(record);
   expect(await refused(complete(corrected,'lesson-a'))).toBe('program_review_stale');
   expect(await writes(id)).toEqual(before);
  });
  it('two devices on the same view: the first completion moves the revision and the second is refused as stale, writing nothing',async()=>{
   const id=await active();const seen=await view(id);
   await complete(seen,'lesson-a');
   const after=await writes(id);
   expect(await refused(complete(seen,'lesson-c'))).toBe('program_assignment_revision_stale');
   expect(await writes(id)).toEqual(after);
  });
  it('a retried completion is never recorded twice, and a refused one is never turned into a success',async()=>{
   await labHistory();
   const id=await active();const seen=await view(id);
   await complete(seen,'lesson-a');
   const after=await writes(id);
   // The reply was lost and the same request is sent again: it names a revision that no longer holds.
   expect(await refused(complete(seen,'lesson-a'))).toBe('program_assignment_revision_stale');
   expect(await writes(id)).toEqual(after);
   // A completion refused as stale and retried unchanged stays refused.
   const current=await view(id);
   await reading(42);
   expect(await refused(complete(current,'lesson-c'))).toBe('program_review_stale');
   expect(await refused(complete(current,'lesson-c'))).toBe('program_review_stale');
   expect(await writes(id)).toEqual(after);
  });
  it('held, cross-owner and cross-clinic completions are refused before any write',async()=>{
   const id=await active();const seen=await view(id);const before=await writes(id);
   expect(seen.review.held).toContain('supp-1');
   expect(await refused(complete(seen,'supp-1'))).toBe('program_item_held');
   expect(await refused(complete(seen,'lesson-a',other))).toBe('program_assignment_refused');
   expect(await refused(complete(seen,'lesson-a',consumer,otherOrg))).toBe('program_assignment_refused');
   expect(await writes(id)).toEqual(before);
  });
 });

 describe('rollback (runs last: it removes the boundary)',()=>{
  it('switches the family off first, gives the API role the parent back only while it refuses, and leaves stored rows untouched',async()=>{
   const id=await active();
   await complete(await view(id),'lesson-a');
   const snapshot=async()=>JSON.stringify((await db.query(`select a.content,a.revision,(select jsonb_agg(c.item_id order by c.item_id) from clinical_core.program_assignment_completions c where c.assignment_id=a.id) as done
    from clinical_core.program_assignments a where a.id=$1`,[id])).rows);
   const before=await snapshot();
   await db.exec(readFileSync(ROLLBACK,'utf8'));
   expect((await db.query<{enabled:boolean}>('select enabled from clinical_core.production_program_activation')).rows[0]?.enabled).toBe(false);
   expect(await refused(bounded(consumer,'consumer',{action:'list'}))).toMatch(/does not exist/);
   expect(await refused(parent(consumer,'consumer',{action:'read',enrollmentId:id}))).toBe('production_program_disabled');
   expect((await db.query(`select to_regclass('clinical_core.program_consumer_boundary_activation') as t,
    to_regprocedure('clinical_private.production_program_bounded_complete(jsonb)') as c,to_regprocedure('clinical_private.production_program_without_destinations(jsonb)') as w`)).rows[0])
    .toEqual({t:null,c:null,w:null});
   expect(await snapshot()).toBe(before);
  });
 });
});
