import {beforeAll,afterAll,afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import type {ClinicalCoreDatabase,ClinicalCoreTransaction} from '../clinical-core/database';
import type {ProductionClinicalRequestContext} from '../clinical-core/aws-identity-consent';
import {createCanonicalProtocolCartWorkforce} from '../clinical-core/canonical-protocol-carts';
import {createCanonicalDraftAuthority} from './canonical-draft-authority';
import {createDraftDeliveryService,type DraftDeliveryActor} from './draft-delivery';
import type {FullscriptSupplementDraftInput} from './protocol-draft';
import type {RequestSession} from '../session';
import {createCanonicalFullscriptDelivery} from './canonical-delivery-runtime';
import * as credentialBinding from './credential-binding';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {fullscriptActor} from './runtime';
import {FULLSCRIPT_DRAFT_SCOPES} from './draft-scopes';
import type {StoredFullscriptConnection} from './token-store';

// Actual immutable 106 prefix + unreleased candidates, real API/worker roles.
// All reviews here are FICTIONAL fixtures, not deployment approvals. PGlite
// serializes DB transactions; these are not hosted multi-session race evidence.
let db:PGlite,org:string,staff:string,consumer:string,other:string,patient:string,connection:string,program:string,version:string,
 product:string,productVersion:string,batch:string,manifestId:string,catalogHash:string,enrollment:string;
let releases:Record<string,string>,contents:Record<string,Record<string,unknown>>;
const subject=(id:string)=>'fictional-'+id;
const sha=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
const cfg={execution:'qualification',account:'588966314750',phiAllowed:false};
const actor=(person=staff,pool:'workforce'|'consumer'='workforce'):DraftDeliveryActor=>({organizationId:org,personId:person,
 identitySubject:subject(person),identityPool:pool,environment:'synthetic-staging',phiAllowed:false});
const context=(person=staff,pool:'workforce'|'consumer'='workforce',purpose:ProductionClinicalRequestContext['purpose']='clinical_data'):ProductionClinicalRequestContext=>({
 actorPersonId:person,organizationId:org,identitySubject:subject(person),identityPool:pool,purpose,
 environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true});
const database=(role='fullscript_draft_worker'):ClinicalCoreDatabase=>({transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role '+role);
 const query:ClinicalCoreTransaction['query']=(sql,args=[])=>tx.query(sql,args.map(v=>v&&typeof v==='object'&&'kind' in v&&'value' in v?v.value:v));
 return work({query});
})});
const consentRequest=(request:unknown,a=actor(consumer,'consumer'))=>database().transaction(async tx=>
 (await tx.query<{data:Record<string,unknown>}>('select fullscript_delivery.external_consent_request($1::jsonb,$2::jsonb) as data',
  [JSON.stringify(a),JSON.stringify(request)])).rows[0].data);
const provider={create:vi.fn(async(input:FullscriptSupplementDraftInput)=>({contract:'fullscript-draft-observation/1',planId:'fictional-plan-id',
 patientId:input.fullscriptPatientId,practitionerId:input.practitionerId,state:'draft',metadataId:input.idempotencyKey,labs:[],recommendations:input.recommendations})),
 findByMetadata:vi.fn<(key:string)=>Promise<unknown[]>>(async()=>[])};
const service=()=>createDraftDeliveryService(database(),createCanonicalDraftAuthority(cfg),provider);
const prepare=()=>service().prepare(actor(),{manifestId,patientRecordId:patient});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
async function release(kind:string,subjectId:string,content:Record<string,unknown>,revision=1){
 const id=randomUUID(),json=JSON.stringify(content);
 await db.query(`insert into fullscript_delivery.authority_releases(id,organization_id,kind,subject_id,revision,content,content_sha256,
  approved_by_person_id,approved_at) values($1,$2,$3,$4,$5,$6::jsonb,
  encode(public.digest(convert_to(($6::jsonb)::text,'UTF8'),'sha256'),'hex'),$7,clock_timestamp())`,[id,org,kind,subjectId,revision,json,staff]);
 return id;
}
async function careConsent(scope:string){
 const id=randomUUID(),copy='I share FICTIONAL TEST '+scope+' with this FICTIONAL clinic. Not external-provider permission.';
 await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,
  approved_by_person_id,approved_at) values($1,$2,$3,'fictional/1',$4,'TEST','approved',$5,clock_timestamp())`,[id,org,scope,sha(copy),staff]);
 await db.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)',[id,org,copy,sha(copy)]);
 await database('clinical_core_api').transaction(async tx=>{
  const c=context(consumer,'consumer','consent_management');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[consumer,org,c.identityPool,c.identitySubject,c.purpose,c.environment,c.dataClassification]);
  await tx.query('select clinical_core.production_care_connection_request($1::jsonb)',[JSON.stringify({action:'grant',connectionId:connection,
   scope,artifactId:id,contentSha256:sha(copy),expectedVersion:0})]);
 });
}
const externalGrant=async()=>{
 const shown=await consentRequest({action:'read',connectionId:connection});
 const r=shown.release as {id:string;sha256:string};
 return consentRequest({action:'grant',connectionId:connection,releaseId:r.id,contentSha256:r.sha256,expectedRevision:shown.revision});
};
beforeAll(async()=>{
 const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],
  {encoding:'utf8',timeout:20_000,maxBuffer:8*1024*1024}));expect(manifest.migrations).toHaveLength(106);
 db=new PGlite({extensions:{pgcrypto}});
 for(const migration of manifest.migrations)await db.exec(files[migration.file]);
 // Raw migration-file fixtures do not run the operator that creates its ledger.
 // Reproduce that table and its exact generated entries before worker grants.
 await db.exec(`create table clinical_core.schema_migrations(version text primary key,name text not null,
  sha256 text not null check(sha256~'^[0-9a-f]{64}$'),applied_at timestamptz not null default clock_timestamp())`);
 for(const migration of manifest.migrations)await db.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',
  [migration.version,migration.file.slice(15,-4),sha(files[migration.file])]);
 for(const name of ['fullscript-draft-ledger','canonical-protocol-carts','fullscript-canonical-authority'])
  await db.exec(readFileSync('infra/aws-clinical-core/source-candidates/'+name+'.sql','utf8'));
},90_000);
afterAll(async()=>{await db?.close();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('worker has a narrow metadata function, not direct clinical-schema access',async()=>{
 const rows=await database().transaction(tx=>tx.query<{ledger:Array<{version:string;name:string;sha256:string}>}>('select fullscript_delivery.migration_ledger() as ledger'));
 expect(rows.rows[0].ledger).toHaveLength(106);
 expect(Object.keys(rows.rows[0].ledger[0]).sort()).toEqual(['name','sha256','version']);
 await expect(database().transaction(tx=>tx.query('select applied_at from clinical_core.schema_migrations'))).rejects.toThrow(/permission denied/);
 await expect(database().transaction(tx=>tx.query("update clinical_core.schema_migrations set name='forged'"))).rejects.toThrow(/permission denied/);
 await expect(database().transaction(tx=>tx.query('select * from clinical_core.patient_records'))).rejects.toThrow(/permission denied/);
 await expect(database('clinical_core_api').transaction(tx=>tx.query('select fullscript_delivery.migration_ledger()'))).rejects.toThrow(/permission denied/);
});
beforeEach(async()=>{
 [org,staff,consumer,other,patient,connection,program,version,productVersion,batch,enrollment]=Array.from({length:11},()=>randomUUID());
 product='prd_fixture_'+randomUUID().replaceAll('-','');releases={};contents={};provider.create.mockClear();provider.findByMetadata.mockClear();
 await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL TEST CLINIC')",[org]);
 for(const [id,pool] of [[staff,'workforce'],[consumer,'consumer'],[other,'consumer']]){
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[id,pool,subject(id)]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'owner')",[org,staff]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')",[patient,org,'patient_syn_'+patient.replaceAll('-','')]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',clock_timestamp())",[connection,org,patient,consumer]);
 await careConsent('programs');await careConsent('protocols_supplements');
 await db.query(`insert into clinical_reference.catalog_import_batches(id,contract_version,source_package_id,source_package_version,
  manifest_sha256,environment,status) values($1,'FICTIONAL/1',$2,'FICTIONAL/1',$3,'production-clinical','succeeded')`,[batch,'fixture-'+batch,sha(batch)]);
 await db.query("insert into clinical_reference.catalog_products(stable_id,review_status,active_version,environment) values($1,'approved',1,'production-clinical')",[product]);
 await db.query(`insert into clinical_reference.catalog_product_versions(id,product_stable_id,version,display_name,product_type,access_tier,
  direct_order_allowed,label_sha256,content_sha256,clinical_payload,source_refs,review_status,import_batch_id)
  values($1,$2,1,'FICTIONAL magnesium','supplement','open',true,$3,$4,'{}','["fictional-source"]','approved',$5)`,[productVersion,product,'b'.repeat(64),'a'.repeat(64),batch]);
 await db.query('insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note) values($1,$2,$3)',
  [productVersion,staff,JSON.stringify({contract:'production-catalog-ingredient-release/1',productId:product,productVersion:1,
   productContentSha256:'a'.repeat(64),labelVersionId:productVersion,labelSha256:'b'.repeat(64),completeness:'complete',sourceVerification:'V',
   ingredientKeys:['magnesium_glycinate'],sourceRefs:['fictional-source']})]);
 const offer='off_fixture_'+randomUUID().replaceAll('-','');
 await db.query("insert into commercial_reference.affiliate_offers(stable_id,product_stable_id,review_status,active_version) values($1,$2,'approved',1)",[offer,product]);
 await db.query(`insert into commercial_reference.affiliate_offer_versions(offer_stable_id,version,destination_url,direct_order_allowed,
  content_sha256,review_status,environment,import_batch_id) values($1,1,'https://fictional.example.test/product',true,$2,'approved','production-clinical',$3)`,[offer,'c'.repeat(64),batch]);
 await db.query("insert into clinical_core.programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'FICTIONAL program','active',$3)",[program,org,staff]);
 const content=JSON.stringify({consumerProgram:{title:'FICTIONAL program',phases:[{id:'phase-1',title:'FICTIONAL phase',days:7,transition:'scheduled',items:[
  {id:'item-magnesium',title:'FICTIONAL supplement',kind:'supplement',released:true,instructions:'FICTIONAL instructions',
   product:{id:product,dose:'1 capsule daily',ingredientKeys:['magnesium_glycinate'],purchaseUrl:'https://fictional.example.test/product'}}]}]}});
 await db.query(`insert into clinical_core.program_versions(id,organization_id,program_id,version,status,created_by_person_id,approved_by_person_id,
  approved_at,published_at,content,content_sha256) values($1,$2,$3,1,'published',$4,$4,clock_timestamp(),clock_timestamp(),$5::jsonb,
  encode(public.digest(convert_to(($5::jsonb)::text,'UTF8'),'sha256'),'hex'))`,[version,org,program,staff,content]);
 await db.query('update clinical_core.programs set active_version_id=$2 where id=$1',[program,version]);
 await db.query("insert into clinical_core.program_enrollments(id,organization_id,patient_record_id,program_id,program_version_id,status,enrolled_by_person_id) values($1,$2,$3,$4,$5,'active',$6)",[enrollment,org,patient,program,version,staff]);
 const m=await createCanonicalProtocolCartWorkforce(database('clinical_core_api'),cfg)(context(),{action:'compile',programVersionId:version});
 if(m.action!=='compile')throw new Error('fixture');manifestId=m.manifestId;
 catalogHash=(await db.query<{sha:string}>('select catalog_source_sha256 as sha from fullscript_delivery.protocol_manifests where id=$1',[manifestId])).rows[0].sha;
 contents.provider={contract:'fullscript-sandbox-provider-release/1',environment:'sandbox_us',apiOrigin:'https://api-us-snd.fullscript.io/api',
  clinicId:'fictional-clinic-id',tokenBindingSha256:'d'.repeat(64),
  scopes:['clinic:read','clinic:write','catalog:read','patients:treatment_plan_history']};
 releases.provider=await release('provider',org,contents.provider);
 contents.recipient={contract:'fullscript-recipient-binding/1',patientRecordId:patient,consumerPersonId:consumer,connectionId:connection,
  providerReleaseId:releases.provider,fullscriptPatientId:'fictional-patient-id'};
 contents.practitioner={contract:'fullscript-practitioner-binding/1',practitionerPersonId:staff,providerReleaseId:releases.provider,fullscriptPractitionerId:'fictional-practitioner-id'};
 contents.mapping={contract:'fullscript-variant-mapping-release/1',manifestId,manifestContentSha256:m.contentSha256,catalogSourceSha256:catalogHash,
  providerReleaseId:releases.provider,lines:[{phaseId:'phase-1',itemId:'item-magnesium',productId:product,variantId:'fictional-variant-id',unitsToPurchase:'2'}]};
 const copy='I agree to share FICTIONAL TEST supplement instructions with the FICTIONAL external provider. No real personal or health data.';
 contents.consent={contract:'fullscript-external-consent/1',providerReleaseId:releases.provider,content:copy,contentSha256:sha(copy),jurisdiction:'TEST'};
 for(const [kind,id] of [['recipient',patient],['practitioner',staff],['mapping',manifestId],['consent',releases.provider]])
  releases[kind]=await release(kind,id,contents[kind]);
 await externalGrant();
});

describe('same-target Fullscript authority with canonical SQL and fictional reviews',()=>{
 it('returns only the current same-target provider release after full authority and actor checks',async()=>{
  const authority=createCanonicalDraftAuthority(cfg);
  await database().transaction(async tx=>{
   const b=await authority.resolve(tx,actor(),{manifestId,patientRecordId:patient});
   expect(await authority.providerRelease(tx,actor(),b)).toEqual(contents.provider);
   await expect(authority.providerRelease(tx,actor(consumer,'consumer'),b)).rejects.toThrow('fullscript_delivery_refused');
   await expect(authority.providerRelease(tx,actor(other,'workforce'),b)).rejects.toThrow('fullscript_delivery_refused');
  });
 });
 it.each(['retirement','withdrawal','changed-review'])('does not load an obsolete provider release after %s',async mode=>{
  const authority=createCanonicalDraftAuthority(cfg);
  const b=await database().transaction(tx=>authority.resolve(tx,actor(),{manifestId,patientRecordId:patient}));
  if(mode==='retirement')await db.query('update fullscript_delivery.authority_releases set retired_at=clock_timestamp() where id=$1',[releases.provider]);
  if(mode==='withdrawal')await consentRequest({action:'withdraw',connectionId:connection,expectedRevision:1});
  if(mode==='changed-review')await release('provider',org,{...contents.provider,tokenBindingSha256:'e'.repeat(64)},2);
  await expect(database().transaction(tx=>authority.providerRelease(tx,actor(),b))).rejects.toThrow('fullscript_delivery_refused');
 });
 it('prepares and replays from actual grants, published enrollment and reviewed mappings, sending once',async()=>{
  const a=await prepare(),b=await prepare();expect(b.id).toBe(a.id);
  const sent=await service().send(actor(),a.id);expect(sent).toMatchObject({state:'verified',includedCount:1,excludedCount:0,patientSent:false,phiAllowed:false});
  expect(await service().send(actor(),a.id)).toEqual(sent);expect(provider.create).toHaveBeenCalledOnce();
  expect(provider.create.mock.calls[0][0]).toMatchObject({fullscriptPatientId:'fictional-patient-id',practitionerId:'fictional-practitioner-id',
   recommendations:[{variantId:'fictional-variant-id',unitsToPurchase:'2',instructions:'1 capsule daily'}]});
  expect(await service().read(actor(consumer,'consumer'),a.id)).toEqual(sent);
 });
 it('clinic sharing alone cannot authorize the external provider; grant/withdraw are audited and replayable',async()=>{
  expect(await consentRequest({action:'withdraw',connectionId:connection,expectedRevision:1})).toEqual({status:'withdrawn',revision:2});
  await expect(prepare()).rejects.toThrow('fullscript_delivery_refused');
  expect(await consentRequest({action:'withdraw',connectionId:connection,expectedRevision:1})).toEqual({status:'withdrawn',revision:2});
  expect(await externalGrant()).toEqual({status:'granted',revision:3});
  await prepare();
  expect((await db.query('select action from clinical_audit.fullscript_consent_events where organization_id=$1 order by occurred_at,id',[org])).rows)
   .toEqual([{action:'granted'},{action:'withdrawn'},{action:'granted'}]);
 });
 it.each(['provider','recipient','practitioner','mapping','consent'])('newest retired %s release never falls back to an older approval',async kind=>{
  const subjects:Record<string,string>={provider:org,recipient:patient,practitioner:staff,mapping:manifestId,consent:releases.provider};
  const next=await release(kind,subjects[kind],contents[kind],2);
  await db.query('update fullscript_delivery.authority_releases set retired_at=clock_timestamp() where id=$1',[next]);
  await expect(prepare()).rejects.toThrow('fullscript_delivery_refused');expect(provider.create).not.toHaveBeenCalled();
 });
 it.each(['consumer','connection','provider','practitioner','catalog','manifest','quantity','unknown-field','bad-copy'])('refuses %s binding tampering in a new reviewed fixture',async mode=>{
  const kind=mode==='consumer'||mode==='connection'||mode==='provider'?'recipient':mode==='practitioner'?'practitioner':mode==='bad-copy'?'consent':'mapping';
  const content=structuredClone(contents[kind]);
  if(mode==='consumer')content.consumerPersonId=other;
  if(mode==='connection')content.connectionId=randomUUID();
  if(mode==='provider')content.providerReleaseId=randomUUID();
  if(mode==='practitioner')content.practitionerPersonId=other;
  if(mode==='catalog')content.catalogSourceSha256='e'.repeat(64);
  if(mode==='manifest')content.manifestContentSha256='e'.repeat(64);
  if(mode==='quantity')content.lines=[{...(content.lines as Record<string,unknown>[])[0],unitsToPurchase:'0'}];
  if(mode==='unknown-field')content.override=true;
  if(mode==='bad-copy')content.contentSha256='e'.repeat(64);
  const subjects:Record<string,string>={recipient:patient,practitioner:staff,consent:releases.provider,mapping:manifestId};
  await release(kind,subjects[kind],content,2);
  await expect(prepare()).rejects.toThrow('fullscript_delivery_refused');expect(provider.create).not.toHaveBeenCalled();
 });
 it.each(['external-consent','clinic-consent','enrollment','hold','deletion','consumer-identity','reviewer','catalog','link'])
 ('commits withheld after %s loss without calling the provider',async reason=>{
  const p=await prepare();await revoke(reason);
  if(reason==='consumer-identity')await expect(service().read(actor(consumer,'consumer'),p.id)).rejects.toThrow('fullscript_delivery_refused');
  else expect(await service().read(actor(consumer,'consumer'),p.id)).toMatchObject({state:'withheld',providerPlanId:null});
  if(reason!=='reviewer')expect(await service().send(actor(),p.id)).toMatchObject({state:'withheld'});
  expect(provider.create).not.toHaveBeenCalled();
 });
 it.each(['external-consent','clinic-consent','deletion','reviewer','link'])('preserves a late known receipt after %s loss without SQL transaction abortion',async reason=>{
  const p=await prepare(),started=deferred<void>(),reply=deferred<ReturnType<typeof provider.create> extends Promise<infer T>?T:never>();
  const normal=provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async _input=>{started.resolve();return reply.promise;});
  const sending=service().send(actor(),p.id);await started.promise;await revoke(reason);
  reply.resolve(await normal({fullscriptPatientId:'fictional-patient-id',practitionerId:'fictional-practitioner-id',
   idempotencyKey:provider.create.mock.calls.at(-1)![0].idempotencyKey,
   recommendations:[{variantId:'fictional-variant-id',unitsToPurchase:'2',instructions:'1 capsule daily'}]}));
  expect(await sending).toMatchObject({state:'withheld',providerPlanId:null,writerPending:false});
  expect((await db.query('select provider_plan_id,writer_settled from fullscript_delivery.draft_intents where id=$1',[p.id])).rows[0])
   .toEqual({provider_plan_id:'fictional-plan-id',writer_settled:true});
 });
 it('refuses cross-owner, cross-clinic, wrong subject, injected releases and production construction',async()=>{
  const p=await prepare();
  for(const a of [actor(other,'consumer'),{...actor(consumer,'consumer'),organizationId:randomUUID()},
   {...actor(),identitySubject:'wrong'}, {...actor(),phiAllowed:true}])await expect(service().read(a,p.id)).rejects.toThrow('fullscript_delivery_refused');
  await expect(service().prepare(actor(),{manifestId,patientRecordId:patient,provider:contents.provider})).rejects.toThrow();
  for(const config of [{...cfg,phiAllowed:true},{...cfg,execution:'production'},{...cfg,account:'173535830222'}])
   expect(()=>createCanonicalDraftAuthority(config)).toThrow('fullscript_delivery_refused');
 });
 it('a replacement link cannot grant its new owner access to an old recipient receipt',async()=>{
  const p=await prepare();await revoke('link');
  await db.query("insert into clinical_core.patient_connections(organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,'verified',clock_timestamp())",[org,patient,other]);
  expect(await service().read(actor(consumer,'consumer'),p.id)).toMatchObject({state:'withheld',providerPlanId:null});
  await expect(service().read(actor(other,'consumer'),p.id)).rejects.toThrow('fullscript_delivery_refused');
  await expect(prepare()).rejects.toThrow('fullscript_delivery_refused');
  expect(provider.create).not.toHaveBeenCalled();
 });
 it('exports withheld historical custody only to its original active owner under the actual worker/authority roles',async()=>{
  const p=await prepare();await service().send(actor(),p.id);await revoke('link');
  await db.query("insert into clinical_core.patient_connections(organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,'verified',clock_timestamp())",[org,patient,other]);
  const exported=await service().exportForOwner(actor(consumer,'consumer'),p.id);
  expect(exported).toMatchObject({state:'withheld',phiAllowed:false,externalCustody:{providerPlanId:'fictional-plan-id',
   providerCopyRemoval:'not_verified',backupRemoval:'not_verified'}});
  expect(exported.audit.events.some(e=>e.nextState==='withheld')).toBe(true);
  await expect(service().exportForOwner(actor(other,'consumer'),p.id)).rejects.toThrow('fullscript_delivery_refused');
  expect(provider.create).toHaveBeenCalledOnce();expect(provider.findByMetadata).not.toHaveBeenCalled();
 });
 it('refuses wrong actual subject and disabled owner exports; the API role cannot call private owner-page functions',async()=>{
  const p=await prepare();
  await expect(service().exportForOwner({...actor(consumer,'consumer'),identitySubject:subject(other)},p.id)).rejects.toThrow('fullscript_delivery_refused');
  await expect(database('clinical_core_api').transaction(tx=>tx.query('select fullscript_delivery.owner_event_page($1::uuid,null)',[p.id])))
   .rejects.toThrow('permission denied');
  await revoke('consumer-identity');
  await expect(service().exportForOwner(actor(consumer,'consumer'),p.id)).rejects.toThrow('fullscript_delivery_refused');
  expect((await db.query("select event_id from fullscript_delivery.draft_events where intent_id=$1::uuid and action='owner_export_read'",[p.id])).rows).toHaveLength(0);
 });
 it('withdrawal remains possible after the reviewed provider/consent copy disappears',async()=>{
  await db.query('update fullscript_delivery.authority_releases set retired_at=clock_timestamp() where id=$1',[releases.provider]);
  expect(await consentRequest({action:'read',connectionId:connection})).toMatchObject({currentGrant:false,release:null});
  expect(await consentRequest({action:'withdraw',connectionId:connection,expectedRevision:1})).toEqual({status:'withdrawn',revision:2});
  await expect(externalGrant()).rejects.toThrow();
 });
 it('a new consent copy requires a fresh exact grant, never silent carry-over',async()=>{
  const next=await release('consent',releases.provider,contents.consent,2);
  expect(await consentRequest({action:'read',connectionId:connection})).toMatchObject({status:'granted',currentGrant:false,release:{id:next}});
  await expect(prepare()).rejects.toThrow('fullscript_delivery_refused');
  await externalGrant();expect(await consentRequest({action:'read',connectionId:connection})).toMatchObject({currentGrant:true,revision:2});
  await prepare();
 });
 it.each(['origin','environment','duplicate-scopes','old-insufficient-scopes','missing-history','missing-metadata','unknown-field'])('refuses %s in a newer provider release',async reason=>{
  const content={...contents.provider};
  if(reason==='origin')content.apiOrigin='https://unreviewed.example.test/api';
  if(reason==='environment')content.environment='production_us';
  if(reason==='duplicate-scopes')content.scopes=['clinic:read','clinic:write','catalog:read','catalog:read'];
  if(reason==='old-insufficient-scopes')content.scopes=['clinic:read','clinic:write'];
  if(reason==='missing-history')content.scopes=['clinic:read','clinic:write','catalog:read'];
  if(reason==='missing-metadata')content.scopes=['clinic:read','clinic:write','patients:treatment_plan_history'];
  if(reason==='unknown-field')content.override=true;
  await release('provider',org,content,2);
  await expect(prepare()).rejects.toThrow('fullscript_delivery_refused');expect(provider.create).not.toHaveBeenCalled();
 });
 it('refuses stale consent hashes, unowned withdrawal, extra fields and malformed external consent copies',async()=>{
  const q={action:'grant',connectionId:connection,expectedRevision:1,releaseId:releases.consent,contentSha256:'e'.repeat(64)};
  await expect(consentRequest(q)).rejects.toThrow('fullscript_consent_refused');
  await expect(consentRequest({action:'withdraw',connectionId:connection,expectedRevision:1},actor(other,'consumer'))).rejects.toThrow();
  await expect(consentRequest({action:'read',connectionId:connection,override:true})).rejects.toThrow();
  await release('consent',releases.provider,{...contents.consent,contentSha256:'e'.repeat(64)},2);
  expect(await consentRequest({action:'read',connectionId:connection})).toMatchObject({release:null});
  await expect(consentRequest(q)).rejects.toThrow();
 });
 it('denies API/worker raw authority table access and immutable approval, consent, audit and hold edits',async()=>{
  for(const role of ['clinical_core_api','fullscript_draft_worker'])for(const table of ['authority_releases','external_consents','recipient_holds'])
   await expect(database(role).transaction(tx=>tx.query('select * from fullscript_delivery.'+table))).rejects.toThrow('permission denied');
  await expect(database('clinical_core_api').transaction(tx=>tx.query('select fullscript_delivery.authority_source($1::jsonb,$2::uuid,$3::uuid)',
   [JSON.stringify(actor()),manifestId,patient]))).rejects.toThrow('permission denied');
  await expect(db.query('update fullscript_delivery.authority_releases set revision=99 where id=$1',[releases.mapping])).rejects.toThrow('fullscript_authority_immutable');
  await expect(db.query('delete from fullscript_delivery.external_consents where connection_id=$1',[connection])).rejects.toThrow('append_only_record');
  await expect(db.query('delete from clinical_audit.fullscript_consent_events where organization_id=$1',[org])).rejects.toThrow('append_only_record');
  await revoke('hold');
  await expect(db.query("update fullscript_delivery.recipient_holds set reason='privacy_request' where organization_id=$1",[org])).rejects.toThrow('fullscript_hold_immutable');
 });
});

describe('canonical delivery composition, fictional SQL and provider observations, not hosted qualification',()=>{
 const session=():RequestSession=>({signedIn:true,email:'fictional.practitioner@example.test',orgId:org,
  expired:false,expiresAt:null,token:'fictional-identity-token'});
 const runtime=(a=actor(),s:RequestSession|null=session(),target=database(),providerEnvironment?:()=>Promise<NodeJS.ProcessEnv>)=>createCanonicalFullscriptDelivery({
  database:target,configuration:cfg,actor:a,session:s??undefined,providerEnvironment});
 const bridge=(duringCredentialObservation?:()=>Promise<void>)=>vi.spyOn(credentialBinding,'createCredentialBoundFullscriptDraftProvider')
  .mockImplementation((_s,_review,check)=>({
   create:async input=>{await duringCredentialObservation?.();await check?.();return provider.create(input);},
   findByMetadata:async key=>{await duringCredentialObservation?.();await check?.();return provider.findByMetadata(key);},
  }));
 it('joins canonical authority, durable admission and database-loaded credential review; replay sends once',async()=>{
  const factory=bridge(),r=runtime(),p=await r.prepare({manifestId,patientRecordId:patient});
  expect(factory).not.toHaveBeenCalled();
  expect(await r.send(p.id)).toMatchObject({state:'verified',includedCount:1,patientSent:false});
  expect(await r.send(p.id)).toMatchObject({state:'verified'});
  expect(factory).toHaveBeenCalledOnce();expect(provider.create).toHaveBeenCalledOnce();
  expect(factory.mock.calls[0][0]).toEqual(session());
  expect(factory.mock.calls[0][1]).toEqual(contents.provider);
  expect(typeof factory.mock.calls[0][2]).toBe('function');
 });
 it('consumer status, cancel and owner export use no provider credentials even with no session',async()=>{
  const load=vi.fn(async()=>({...process.env})),factory=bridge(),p=await runtime(actor(),session(),database(),load).prepare({manifestId,patientRecordId:patient});
  const owner=runtime(actor(consumer,'consumer'),null,database(),load);
  expect(await owner.read(p.id)).toMatchObject({state:'prepared'});
  expect(await owner.exportForOwner(p.id)).toMatchObject({contract:'fullscript-draft-owner-export/1'});
  expect(await owner.cancel(p.id)).toMatchObject({state:'cancelled'});
  await expect(owner.send(p.id)).rejects.toThrow('fullscript_delivery_refused');
  await expect(owner.reconcile(p.id)).rejects.toThrow('fullscript_delivery_refused');
  await expect(owner.prepare({manifestId,patientRecordId:patient})).rejects.toThrow('fullscript_delivery_refused');
  expect(factory).not.toHaveBeenCalled();expect(provider.create).not.toHaveBeenCalled();expect(load).not.toHaveBeenCalled();
 });
 it.each(['external-consent','clinic-consent','enrollment','hold','deletion','consumer-identity','reviewer','catalog','link'])
 ('rechecks %s loss during credential I/O before POST, settles withheld and emits no provider body',async reason=>{
  const p=await runtime().prepare({manifestId,patientRecordId:patient});
  const factory=bridge(()=>revoke(reason));
  expect(await runtime().send(p.id)).toMatchObject({state:'withheld',providerPlanId:null,writerPending:false});
  expect(factory).toHaveBeenCalledOnce();expect(provider.create).not.toHaveBeenCalled();
  const row=(await db.query<{state:string;provider_plan_id:null}>('select state,provider_plan_id from fullscript_delivery.draft_intents where id=$1',[p.id])).rows[0];
  expect(row).toEqual({state:'withheld',provider_plan_id:null});
 });
 it('preserves a positive external receipt if consent is withdrawn after admitted provider work',async()=>{
  bridge();const r=runtime(),p=await r.prepare({manifestId,patientRecordId:patient});
  provider.create.mockImplementationOnce(async request=>{
   await revoke('external-consent');
   return {contract:'fullscript-draft-observation/1',planId:'fictional-late-plan',patientId:request.fullscriptPatientId,
    practitionerId:request.practitionerId,state:'draft',metadataId:request.idempotencyKey,labs:[],recommendations:request.recommendations};
  });
  expect(await r.send(p.id)).toMatchObject({state:'withheld',providerPlanId:null,writerPending:false});
  const exported=await runtime(actor(consumer,'consumer'),null).exportForOwner(p.id);
  expect(exported.externalCustody).toMatchObject({providerPlanId:'fictional-late-plan',providerCopyRemoval:'not_verified'});
  expect(await r.send(p.id)).toMatchObject({state:'withheld'});expect(provider.create).toHaveBeenCalledOnce();
 });
 it('recovers through read-only metadata using the current database review; empty results never create again',async()=>{
  const factory=bridge(),r=runtime(),p=await r.prepare({manifestId,patientRecordId:patient});
  provider.create.mockRejectedValueOnce(new Error('fictional transport timeout'));
  expect(await r.send(p.id)).toMatchObject({state:'uncertain',writerPending:false});
  await expect(r.reconcile(p.id)).rejects.toThrow('fullscript_delivery_refused');
  expect(await r.send(p.id)).toMatchObject({state:'uncertain'});
  expect(provider.create).toHaveBeenCalledOnce();expect(provider.findByMetadata).toHaveBeenCalledOnce();
  expect(factory.mock.calls[1][1]).toEqual(contents.provider);
 });
 it.each(['owner','clinic'])('refuses foreign %s reads before constructing a credential provider',async mode=>{
  const factory=bridge(),p=await runtime().prepare({manifestId,patientRecordId:patient});
  const a=mode==='owner'?actor(other,'consumer'):{...actor(consumer,'consumer'),organizationId:randomUUID()};
  await expect(runtime(a,null).read(p.id)).rejects.toThrow('fullscript_delivery_refused');
  expect(factory).not.toHaveBeenCalled();
 });
 it.each(['missing','expired','clinic','email'])('refuses a %s workforce session before database or provider access',mode=>{
  const factory=bridge(),s=session();
  if(mode==='expired')s.expired=true;
  if(mode==='clinic')s.orgId=randomUUID();
  if(mode==='email')s.email=null;
  expect(()=>createCanonicalFullscriptDelivery({database:database(),configuration:cfg,actor:actor(),session:mode==='missing'?undefined:s}))
   .toThrow('fullscript_delivery_refused');expect(factory).not.toHaveBeenCalled();
 });
 it('accepts actual Aurora string JSON cells without weakening exact admitted-input and actor binding',async()=>{
  const factory=bridge();
  const target:ClinicalCoreDatabase={transaction:work=>database().transaction(async tx=>{
   const query:ClinicalCoreTransaction['query']=async<Row extends Record<string,unknown>>(sql:string,args:readonly unknown[]=[])=>{
    const result=await tx.query<Row>(sql,args);
    if(sql.startsWith('select manifest_id,patient_record_id'))return {...result,rows:result.rows.map(row=>({...row,
     input:JSON.stringify(row.input),writer_actor:JSON.stringify(row.writer_actor)} as Row))};
    return result;
   };
   return work({query});
  })};
  const r=runtime(actor(),session(),target),p=await r.prepare({manifestId,patientRecordId:patient});
  expect(await r.send(p.id)).toMatchObject({state:'verified'});expect(factory).toHaveBeenCalledOnce();
 });
 it('rejects production construction rather than exposing the qualification adapter to PHI',()=>{
  expect(()=>createCanonicalFullscriptDelivery({database:database(),configuration:{...cfg,execution:'production',phiAllowed:true},
   actor:actor(),session:session()})).toThrow('fullscript_delivery_refused');
 });
 it('does not start POST when the admitted writer expires during credential observation',async()=>{
  let expired=false;
  const target:ClinicalCoreDatabase={transaction:work=>database().transaction(async tx=>{
   const query:ClinicalCoreTransaction['query']=async<Row extends Record<string,unknown>>(sql:string,args:readonly unknown[]=[])=>{
    const result=await tx.query<Row>(sql,args);
    if(expired&&sql.startsWith('select manifest_id,patient_record_id'))return {...result,rows:result.rows.map(row=>({...row,writer_live:false} as Row))};
    return result;
   };return work({query});
  })};
  bridge(async()=>{expired=true;});const r=runtime(actor(),session(),target),p=await r.prepare({manifestId,patientRecordId:patient});
  expect(await r.send(p.id)).toMatchObject({state:'uncertain',writerPending:false});
  expect(provider.create).not.toHaveBeenCalled();
  expect(await r.send(p.id)).toMatchObject({state:'uncertain'});expect(provider.create).not.toHaveBeenCalled();
 });
 it.each(['positive','withdrawal-during-clinic-read'])('composes actual SQL and native credential/HTTP decoders: %s',async mode=>{
  // Only AWS/HTTP transports are fictional. The authority, ledger, credential
  // store parser, observed-clinic binding and provider decoder are real code.
  vi.stubEnv('FULLSCRIPT_ENVIRONMENT','sandbox_us');vi.stubEnv('FULLSCRIPT_CLIENT_ID','fictional-client-abcdefghijklmnopqrstuvwxyz');
  vi.stubEnv('FULLSCRIPT_CLIENT_SECRET','fictional-secret-abcdefghijklmnopqrstuvwxyz');
  vi.stubEnv('FULLSCRIPT_REDIRECT_URI','https://fictional.example.test/api/live/fullscript/oauth/callback');
  vi.stubEnv('FULLSCRIPT_OAUTH_STATE_SECRET','fictional-state-secret-longer-than-32-characters');
  vi.stubEnv('FULLSCRIPT_TOKEN_TABLE','fictional-token-table');vi.stubEnv('AWS_REGION','us-east-2');
  const saved:StoredFullscriptConnection={...fullscriptActor(session()),environment:'sandbox_us',
   installationId:randomUUID(),oauthClientId:'fictional-client-abcdefghijklmnopqrstuvwxyz',
   oauthRedirectUri:'https://fictional.example.test/api/live/fullscript/oauth/callback',
   accessToken:'fictional-access-token-abcdefghijklmnopqrstuvwxyz',refreshToken:'fictional-refresh-token-abcdefghijklmnopqrstuvwxyz',
   connectedAt:'2026-10-09T10:00:00.000Z',expiresAt:new Date(Date.now()+3600_000).toISOString(),
   resourceOwner:{id:'fictional-practitioner-id',type:'Practitioner'},scope:[...FULLSCRIPT_DRAFT_SCOPES]};
  vi.spyOn(DynamoDBClient.prototype,'send').mockImplementation(async()=>({Item:{payload:{S:JSON.stringify(saved)}}}) as never);
  let withdraw=false;
  const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
   if(new URL(String(url)).pathname==='/api/clinic'){
    if(withdraw)await consentRequest({action:'withdraw',connectionId:connection,expectedRevision:2});
    return new Response(JSON.stringify({clinic:{id:'fictional-clinic-id'}}),{status:200,headers:{'content-type':'application/json'}});
   }
   if(init?.method!=='POST')throw new Error('unexpected fictional request');
   const body=JSON.parse(String(init.body)),key=body.metadata.id;
   return new Response(JSON.stringify({treatment_plan:{id:'fictional-native-plan',patient:{id:'fictional-patient-id'},
    practitioner:{id:'fictional-practitioner-id'},state:'draft',available_at:null,metadata:{id:key},lab_recommendations:[],resources:[],
    recommendations:[{variant_id:'fictional-variant-id',units_to_purchase:2,refill:false,dosage:{additional_info:'1 capsule daily'}}]}}),{status:201,headers:{'content-type':'application/json'}});
  });vi.stubGlobal('fetch',fetcher);
  const observed=await credentialBinding.observeFullscriptDraftInstallation(session());
  contents.provider={...contents.provider,tokenBindingSha256:observed.tokenBindingSha256};
  releases.provider=await release('provider',org,contents.provider,2);
  for(const [kind,id] of [['recipient',patient],['practitioner',staff],['mapping',manifestId],['consent',releases.provider]]){
   contents[kind]={...contents[kind],providerReleaseId:releases.provider};
   releases[kind]=await release(kind,id,contents[kind],kind==='consent'?1:2);
  }
  await externalGrant();fetcher.mockClear();
  const scoped={...process.env},load=vi.fn(async()=>scoped);
  // Version-pinned secret values belong to this request, not shared globals.
  vi.stubEnv('FULLSCRIPT_ENVIRONMENT','production_us');vi.stubEnv('FULLSCRIPT_TOKEN_TABLE','untrusted-global-table');
  const r=runtime(actor(),session(),database(),load),p=await r.prepare({manifestId,patientRecordId:patient});withdraw=mode!=='positive';
  expect(load).not.toHaveBeenCalled();
  const result=await r.send(p.id);
  expect(load).toHaveBeenCalledOnce();
  expect(result).toMatchObject({state:withdraw?'withheld':'verified',patientSent:false,phiAllowed:false});
  expect(fetcher.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(withdraw?0:1);
  if(!withdraw){
   const post=fetcher.mock.calls.find(c=>c[1]?.method==='POST')!;
   expect(String(post[0])).toBe('https://api-us-snd.fullscript.io/api/clinic/patients/fictional-patient-id/treatment_plans');
   expect(post[1]).toMatchObject({redirect:'manual',headers:{authorization:'Bearer '+saved.accessToken}});
   expect(result.providerPlanId).toBe('fictional-native-plan');
  }
  expect(provider.create).not.toHaveBeenCalled();
 });
});

async function revoke(reason:string){
 if(reason==='external-consent')await consentRequest({action:'withdraw',connectionId:connection,expectedRevision:1});
 if(reason==='clinic-consent'){
  await database('clinical_core_api').transaction(async tx=>{
   const c=context(consumer,'consumer','consent_management');
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[consumer,org,c.identityPool,c.identitySubject,c.purpose,c.environment,c.dataClassification]);
   await tx.query('select clinical_core.production_care_connection_request($1::jsonb)',[JSON.stringify({action:'withdraw',connectionId:connection,scope:'programs',expectedVersion:1})]);
  });
 }
 if(reason==='enrollment')await db.query("update clinical_core.program_enrollments set status='paused',version=version+1 where id=$1",[enrollment]);
 if(reason==='hold')await db.query("insert into fullscript_delivery.recipient_holds(organization_id,patient_record_id,reason,placed_by_person_id) values($1,$2,'clinical_safety',$3)",[org,patient,staff]);
 if(reason==='deletion')await db.query("insert into clinical_private.owned_privacy_requests(owner_id,request_id,kind,status) values($1,$2,'deletion','submitted')",[consumer,randomUUID()]);
 if(reason==='consumer-identity')await db.query("update clinical_core.identities set status='disabled' where person_id=$1",[consumer]);
 if(reason==='reviewer')await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1",[staff]);
 if(reason==='catalog')await db.query("insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note) values($1,$2,'not-json')",[productVersion,staff]);
 if(reason==='link')await db.query("update clinical_core.patient_connections set state='revoked',revoked_at=clock_timestamp(),version=version+1 where id=$1",[connection]);
}
