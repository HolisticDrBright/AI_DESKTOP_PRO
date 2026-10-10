import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import type {ClinicalCoreDatabase,ClinicalCoreTransaction} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {createCanonicalProtocolCartWorkforce} from './canonical-protocol-carts';
let db:PGlite,org:string,staff:string,consumer:string,program:string,version:string,product:string,productVersion:string,batch:string;
const subject=(id:string)=>'fictional-'+id;
const cfg={execution:'qualification',account:'588966314750',phiAllowed:false};
const context=(person=staff,pool:'workforce'|'consumer'='workforce',organization=org):ProductionClinicalRequestContext=>({
 actorPersonId:person,organizationId:organization,identitySubject:subject(person),identityPool:pool,purpose:'clinical_data',
 environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true,
});
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role clinical_core_api');
 const query:ClinicalCoreTransaction['query']=(sql,args=[])=>tx.query(sql,args.map(v=>v&&typeof v==='object'&&'kind' in v&&'value' in v?v.value:v));
 return work({query});
})};
const call=(request:unknown,c=context())=>createCanonicalProtocolCartWorkforce(database,cfg)(c,request);
const compile=async()=>{const result=await call({action:'compile',programVersionId:version});if(result.action!=='compile')throw new Error('bad result');return result;};
const read=(manifestId:string)=>call({action:'read',manifestId});
const proof=()=>({contract:'production-catalog-ingredient-release/1',productId:product,productVersion:1,
 productContentSha256:'a'.repeat(64),labelVersionId:productVersion,labelSha256:'b'.repeat(64),
 completeness:'complete',sourceVerification:'V',ingredientKeys:['magnesium_glycinate'],sourceRefs:['fictional-source']});
const item=(suffix='magnesium',released=true,ingredients=['magnesium_glycinate'],productId=product)=>({
 id:'item-'+suffix,title:'FICTIONAL '+suffix,kind:'supplement',released,instructions:'FICTIONAL TEST DIRECTIONS',
 product:{id:productId,dose:'1 capsule daily',ingredientKeys:ingredients,purchaseUrl:'https://fictional.example.test/product'}});
async function writeProgram(items:unknown[]=[item()]){
 const content=JSON.stringify({consumerProgram:{title:'FICTIONAL program',phases:[{id:'phase-1',title:'FICTIONAL phase',days:7,
  transition:'scheduled',items}]}});
 await db.query(`update clinical_core.program_versions set content=$2::jsonb,
  content_sha256=encode(public.digest(convert_to(($2::jsonb)::text,'UTF8'),'sha256'),'hex') where id=$1`,[version,content]);
}
async function verification(note:unknown=proof()){
 await db.query('insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note) values($1,$2,$3)',
  [productVersion,staff,typeof note==='string'?note:JSON.stringify(note)]);
}
beforeAll(async()=>{
 const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],
  {encoding:'utf8',timeout:20_000,maxBuffer:8*1024*1024}));
 expect(manifest.migrations).toHaveLength(106);
 db=new PGlite({extensions:{pgcrypto}});
 for(const migration of manifest.migrations)await db.exec(files[migration.file]);
 await db.exec(readFileSync('infra/aws-clinical-core/source-candidates/fullscript-draft-ledger.sql','utf8'));
 await db.exec(readFileSync('infra/aws-clinical-core/source-candidates/canonical-protocol-carts.sql','utf8'));
},90_000);
afterAll(async()=>{await db.close();});
beforeEach(async()=>{
 [org,staff,consumer,program,version,productVersion,batch]=Array.from({length:7},()=>randomUUID());
 product='prd_fixture_'+randomUUID().replaceAll('-','');
 await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL TEST CLINIC')",[org]);
 for(const [person,pool] of [[staff,'workforce'],[consumer,'consumer']]){
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[person,'subject_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[person,pool,subject(person)]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'owner')",[org,staff]);
 await db.query(`insert into clinical_reference.catalog_import_batches(id,contract_version,source_package_id,source_package_version,
  manifest_sha256,environment,status) values($1,'FICTIONAL/1',$2,'FICTIONAL/1',$3,'production-clinical','succeeded')`,[batch,'fixture-'+batch,batch.replaceAll('-','').repeat(2)]);
 await db.query(`insert into clinical_reference.catalog_products(stable_id,review_status,active_version,environment)
  values($1,'approved',1,'production-clinical')`,[product]);
 await db.query(`insert into clinical_reference.catalog_product_versions(id,product_stable_id,version,display_name,product_type,
  access_tier,direct_order_allowed,label_sha256,content_sha256,clinical_payload,source_refs,review_status,import_batch_id)
  values($1,$2,1,'FICTIONAL magnesium','supplement','open',true,$3,$4,'{}','["fictional-source"]','approved',$5)`,
  [productVersion,product,'b'.repeat(64),'a'.repeat(64),batch]);
 await verification();
 const offer='off_fixture_'+randomUUID().replaceAll('-','');
 await db.query("insert into commercial_reference.affiliate_offers(stable_id,product_stable_id,review_status,active_version) values($1,$2,'approved',1)",[offer,product]);
 await db.query(`insert into commercial_reference.affiliate_offer_versions(offer_stable_id,version,destination_url,direct_order_allowed,
  content_sha256,review_status,environment,import_batch_id) values($1,1,'https://fictional.example.test/product',true,$2,'approved','production-clinical',$3)`,
  [offer,'c'.repeat(64),batch]);
 await db.query("insert into clinical_core.programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'FICTIONAL program','active',$3)",[program,org,staff]);
 await db.query(`insert into clinical_core.program_versions(id,organization_id,program_id,version,status,created_by_person_id,
  approved_by_person_id,approved_at,published_at) values($1,$2,$3,1,'published',$4,$4,clock_timestamp(),clock_timestamp())`,[version,org,program,staff]);
 await db.query('update clinical_core.programs set active_version_id=$2 where id=$1',[program,version]);
 await writeProgram();
});
describe('canonical program cart source, actual 106 schema and API role with fictional review fixtures',()=>{
 it('compiles exact published canonical content, includes reviewed products and replays one immutable manifest',async()=>{
  const a=await compile(),b=await compile();expect(b.manifestId).toBe(a.manifestId);expect(b.replayed).toBe(true);
  expect(a).toMatchObject({includedCount:1,excludedCount:0});
  const result=await read(a.manifestId);expect(result).toMatchObject({status:'compiled',includedCount:1,
   delivery:{state:'not_implemented'}});
  expect((await db.query('select id from fullscript_delivery.protocol_manifests where organization_id=$1',[org])).rows).toHaveLength(1);
  expect((await db.query("select action from clinical_audit.protocol_cart_events where organization_id=$1 order by occurred_at,id",[org])).rows)
   .toEqual([{action:'compiled'},{action:'read'}]);
 });
 it('preserves every withheld product: iron, reproductive, unreleased and missing catalog authority',async()=>{
  await writeProgram([item(),item('iron',true,['iron_bisglycinate'],'prd_iron'),
   item('reproductive',true,['fertility_blend'],'prd_reproductive'),item('held',false),item('unknown',true,['zinc'],'prd_unknown')]);
  const result=await read((await compile()).manifestId);
  if(result.action!=='read')throw new Error('bad result');
  expect(result.lines.map(x=>x.exclusionReason)).toEqual([null,'iron_requires_individual_review',
   'reproductive_requires_individual_review','program_step_unreleased','catalog_authority_unavailable']);
  expect(result).toMatchObject({includedCount:1,excludedCount:4});
 });
 it.each(['R','withdrawal','malformed','missing-field','duplicate-source','extra-field'])('holds %s ingredient evidence rather than falling back to old approval',async mode=>{
  await verification(mode==='R'?{...proof(),sourceVerification:'R'}:mode==='withdrawal'?{contract:'production-catalog-ingredient-withdrawal/1'}:
   mode==='malformed'?'not-json':mode==='missing-field'?{...proof(),ingredientKeys:null}:
   mode==='duplicate-source'?{...proof(),sourceRefs:['fictional-source','fictional-source']}:{...proof(),unreviewedOverride:true});
  const result=await read((await compile()).manifestId);
  expect(result).toMatchObject({includedCount:0,excludedCount:1});
 });
 it('does not treat a program URL or ingredient list as catalog authority',async()=>{
  await writeProgram([item('wrong-ingredients',true,['zinc'])]);expect(await compile()).toMatchObject({includedCount:0});
  await db.query("update commercial_reference.affiliate_offers set review_status='rejected' where product_stable_id=$1",[product]);
  await writeProgram();const result=await read((await compile()).manifestId);
  if(result.action!=='read')throw new Error('bad result');expect(result.lines[0].exclusionReason).toBe('no_purchase_destination');
 });
 it('supersedes a saved cart after latest ingredient evidence changes without rewriting its lines',async()=>{
  const p=await compile();await verification({...proof(),sourceVerification:'R'});
  expect(await read(p.manifestId)).toMatchObject({status:'superseded',includedCount:1});
  const next=await compile();expect(next.manifestId).not.toBe(p.manifestId);expect(next.includedCount).toBe(0);
 });
 it('refuses consumer, wrong clinic, wrong subject and supplied cart content',async()=>{
  const p=await compile();
  for(const c of [context(consumer,'consumer'),context(staff,'workforce',randomUUID()),{...context(),identitySubject:'wrong'}])
   await expect(call({action:'read',manifestId:p.manifestId},c)).rejects.toThrow();
  await expect(call({action:'compile',programVersionId:version,lines:[]})).rejects.toThrow('request_invalid');
  for(const config of [{...cfg,phiAllowed:true},{...cfg,execution:'production'},{...cfg,account:'173535830222'}])
   expect(()=>createCanonicalProtocolCartWorkforce(database,config)).toThrow('identity_refused');
 });
 it('refuses draft, missing/future approval, stale publication hash and duplicate steps',async()=>{
  await db.query("update clinical_core.program_versions set status='draft' where id=$1",[version]);await expect(compile()).rejects.toThrow();
  await db.query("update clinical_core.program_versions set status='published',approved_at=clock_timestamp()+interval '1 hour' where id=$1",[version]);await expect(compile()).rejects.toThrow();
  await db.query("update clinical_core.program_versions set approved_at=clock_timestamp(),content_sha256=repeat('e',64) where id=$1",[version]);await expect(compile()).rejects.toThrow();
  await writeProgram([item(),item()]);await expect(compile()).rejects.toThrow();
 });
 it('revoked reviewer/catalog approval cannot keep a saved cart current, and direct table mutations are denied',async()=>{
  const p=await compile();await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1",[staff]);
  await expect(read(p.manifestId)).rejects.toThrow();
  await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.exec('select * from fullscript_delivery.protocol_manifests');})).rejects.toThrow('permission denied');
  await expect(db.query('update fullscript_delivery.protocol_manifests set included_count=99 where id=$1',[p.manifestId])).rejects.toThrow('protocol_cart_immutable');
  await expect(db.query('delete from clinical_audit.protocol_cart_events where manifest_id=$1',[p.manifestId])).rejects.toThrow('protocol_cart_audit_immutable');
 });
 it('binds the approval record as well as the program content and catalog',async()=>{
  const previous=await compile();
  await db.query("update clinical_core.program_versions set approved_at=approved_at-interval '1 second' where id=$1",[version]);
  expect(await read(previous.manifestId)).toMatchObject({status:'superseded'});
  const next=await compile();expect(next.manifestId).not.toBe(previous.manifestId);
  expect(await compile()).toMatchObject({manifestId:next.manifestId,replayed:true});
 });
 it.each(['rejected-product','rejected-version','restricted','blocked','failed-import','unverified-label','missing-approval'])
 ('does not hide the product when %s, but prevents its inclusion',async mode=>{
  if(mode==='rejected-product')await db.query("update clinical_reference.catalog_products set review_status='rejected' where stable_id=$1",[product]);
  if(['rejected-version','restricted','blocked'].includes(mode)){
   const successor=randomUUID();
   await db.query(`insert into clinical_reference.catalog_product_versions(id,product_stable_id,version,display_name,product_type,
    access_tier,declared_restricted,direct_order_allowed,label_sha256,content_sha256,clinical_payload,source_refs,review_status,import_batch_id)
    select $2,product_stable_id,2,display_name,product_type,
     case when $3='blocked' then 'blocked' when $3='restricted' then 'practitioner_gated' else access_tier end,
     $3='restricted',case when $3='restricted' then false else direct_order_allowed end,label_sha256,repeat('d',64),clinical_payload,source_refs,
     case when $3='rejected-version' then 'rejected' else review_status end,import_batch_id
    from clinical_reference.catalog_product_versions where id=$1`,[productVersion,successor,mode]);
   productVersion=successor;
   await db.query('update clinical_reference.catalog_products set active_version=2 where stable_id=$1',[product]);
   await verification({...proof(),productVersion:2,productContentSha256:'d'.repeat(64)});
  }
  if(mode==='failed-import')await db.query("update clinical_reference.catalog_import_batches set status='failed' where id=$1",[batch]);
  if(mode==='unverified-label')await verification({...proof(),labelSha256:'c'.repeat(64)});
  if(mode==='missing-approval')await verification({...proof(),sourceRefs:['unapproved-source']});
  const result=await read((await compile()).manifestId);
  expect(result).toMatchObject({includedCount:0,excludedCount:1,lines:[{productId:product,exclusionReason:'catalog_authority_unavailable'}]});
 });
 it('does not expose another clinic manifest even to another valid workforce identity',async()=>{
  const previous=await compile(),otherOrg=randomUUID();
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL OTHER CLINIC')",[otherOrg]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'owner')",[otherOrg,staff]);
  await expect(call({action:'read',manifestId:previous.manifestId},context(staff,'workforce',otherOrg))).rejects.toThrow();
  expect(await call({action:'list',programId:program},context(staff,'workforce',otherOrg))).toEqual({action:'list',manifests:[]});
 });
 it('a different authorized practitioner cannot reuse a withdrawn catalog reviewer approval',async()=>{
  const other=randomUUID();
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[other,'subject_'+other.replaceAll('-','')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)",[other,subject(other)]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'owner')",[org,other]);
  await db.query('update clinical_core.program_versions set approved_by_person_id=$2 where id=$1',[version,other]);
  const c=context(other),request={action:'compile',programVersionId:version};
  const previous=await call(request,c);if(previous.action!=='compile')throw new Error('bad result');
  expect(previous.includedCount).toBe(1);
  await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1",[staff]);
  expect(await call({action:'read',manifestId:previous.manifestId},c)).toMatchObject({status:'superseded'});
  expect(await call(request,c)).toMatchObject({includedCount:0,excludedCount:1});
 });
});
