import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';

/**
 * Compiling a purchasable cart from a published protocol.
 *
 * The assertions that carry weight are about what never reaches a cart. Iron must be excluded
 * because its dose depends on a ferritin the cart cannot see. Anything touching pregnancy,
 * nursing or fertility must be excluded for the same reason. An excluded line must still be in
 * the manifest with its reason, because a product that silently disappears between the protocol
 * and the cart is worse than one that is visibly withheld. And nothing may be compiled from an
 * unpublished version, or from anything a caller sends.
 */
const id=(n:number)=>'e0000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),clinician=id(2),consumer=id(3),program=id(4),v1=id(5),v2=id(6),draft=id(7);
let db:PGlite;
type Json={[key:string]:unknown};
type Line={itemId:string;productId:string;included:boolean;exclusionReason:string|null};

async function rpc(fn:string,request:unknown,actor=clinician,pool:'workforce'|'consumer'='workforce'){
 return db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
   [actor,org,pool,'subject-'+actor,'clinical_data','synthetic-staging','synthetic_only']);
  const {rows}=await tx.query<{data:Json}>(`select clinical_core.${fn}($1::jsonb) as data`,
   [JSON.stringify(request)]);
  return rows[0].data;
 });
}
const message=async(work:Promise<unknown>)=>{
 try{await work;return 'resolved';}catch(cause){return cause instanceof Error?cause.message:String(cause);}
};

const supplement=(suffix:string,ingredientKeys:string[],purchaseUrl:string|null='https://fictional-dispensary.example/p/'+suffix)=>({
 id:'item-'+suffix,title:'Fictional supplement '+suffix,kind:'supplement',released:true,
 instructions:'Take as directed in the fictional protocol.',
 product:{id:'prod-'+suffix,dose:'1 capsule daily',ingredientKeys,purchaseUrl}});
const lesson=(suffix:string)=>({id:'lesson-'+suffix,title:'Fictional lesson '+suffix,kind:'lesson',
 instructions:'Read the fictional lesson.',released:true});
const content=(items:unknown[])=>JSON.stringify({consumerProgram:{
 title:'Fictional thyroid guide',
 phases:[{id:'phase-1',title:'Phase one',days:1,transition:'scheduled',items}]}});

const everything=[
 supplement('magnesium',['magnesium_glycinate']),
 supplement('ironblend',['iron_bisglycinate','vitamin_c']),
 supplement('prenatal',['folate','pregnancy_support_blend']),
 supplement('noaddress',['zinc_picolinate'],null),
 lesson('a'),
];

async function publish(versionId:string,items:unknown[],version:number,status='published'){
 await db.query(`insert into clinical_core.synthetic_desktop_program_versions
  (id,organization_id,program_id,version,status,content,created_by_person_id)
  values($1,$2,$3,$4,$5,$6::jsonb,$7)`,
  [versionId,org,program,version,status,content(items),clinician]);
}

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
 await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional thyroid program','published',$3)",[program,org,clinician]);
},90000);
afterAll(async()=>{await db?.close();});

beforeEach(async()=>{
 // Both tables are append-only by design; a fixture reset is the one place that is bypassed.
 await db.exec("set session_replication_role = 'replica'");
 await db.exec('delete from clinical_core.protocol_cart_manifests');
 await db.exec('delete from clinical_core.synthetic_desktop_program_versions');
 await db.exec("set session_replication_role = 'origin'");
 await publish(v1,everything,1);
});

describe('what never reaches a cart',()=>{
 it('excludes iron, reproductive ingredients and missing destinations, and says why',async()=>{
  const compiled=await rpc('protocol_cart_workforce',{action:'compile',programVersionId:v1});
  expect(compiled.includedCount).toBe(1);
  expect(compiled.excludedCount).toBe(3);
  const read=await rpc('protocol_cart_workforce',{action:'read',manifestId:compiled.manifestId});
  const lines=read.lines as Line[];
  expect(lines.map(l=>[l.productId,l.exclusionReason])).toEqual([
   ['prod-magnesium',null],
   ['prod-ironblend','iron_requires_individual_review'],
   ['prod-prenatal','reproductive_requires_individual_review'],
   ['prod-noaddress','no_purchase_destination'],
  ]);
 });

 it('keeps every excluded line in the manifest rather than dropping it',async()=>{
  const compiled=await rpc('protocol_cart_workforce',{action:'compile',programVersionId:v1});
  const read=await rpc('protocol_cart_workforce',{action:'read',manifestId:compiled.manifestId});
  // Four supplements in, four lines out. A cart that quietly lost three would look complete.
  expect((read.lines as Line[])).toHaveLength(4);
  expect((read.lines as Line[]).filter(l=>l.included)).toHaveLength(1);
 });

 it('catches iron under any of the words a label uses for it',async()=>{
  const names=['ferrous_sulfate','ferric_citrate','heme_iron','ferritin_support'];
  for(const [index,key] of names.entries()){
   const versionId=id(20+index);
   await publish(versionId,[supplement('x'+index,[key])],10+index);
   const compiled=await rpc('protocol_cart_workforce',{action:'compile',programVersionId:versionId});
   expect(compiled.includedCount,key).toBe(0);
  }
 });

 it('never lets a supplement into a cart on a caller’s word',async()=>{
  // The request may name a version. It cannot describe one: there is nowhere to put content.
  expect(await message(rpc('protocol_cart_workforce',{action:'compile',programVersionId:v1,
   lines:[{productId:'prod-ironblend',included:true}]})))
   .toBe('protocol_cart_invalid');
 });
});

describe('what may be compiled',()=>{
 it('refuses a version that is not published',async()=>{
  await publish(draft,[supplement('magnesium',['magnesium_glycinate'])],3,'draft');
  expect(await message(rpc('protocol_cart_workforce',{action:'compile',programVersionId:draft})))
   .toBe('protocol_cart_version_unpublished');
 });

 it('refuses a protocol with no supplements rather than compiling an empty cart',async()=>{
  await publish(v2,[lesson('a')],2);
  expect(await message(rpc('protocol_cart_workforce',{action:'compile',programVersionId:v2})))
   .toBe('protocol_cart_no_supplements');
 });

 it('records the version content digest it compiled from',async()=>{
  const compiled=await rpc('protocol_cart_workforce',{action:'compile',programVersionId:v1});
  const read=await rpc('protocol_cart_workforce',{action:'read',manifestId:compiled.manifestId});
  expect(read.versionContentSha256).toMatch(/^[a-f0-9]{64}$/);
  const {rows}=await db.query<{digest:string}>(
   `select encode(public.digest(convert_to(content::text,'UTF8'),'sha256'),'hex') as digest
    from clinical_core.synthetic_desktop_program_versions where id=$1`,[v1]);
  expect(read.versionContentSha256).toBe(rows[0].digest);
 });

 it('returns the manifest that exists instead of compiling a second one',async()=>{
  const first=await rpc('protocol_cart_workforce',{action:'compile',programVersionId:v1});
  expect(first.replayed).toBe(false);
  const again=await rpc('protocol_cart_workforce',{action:'compile',programVersionId:v1});
  expect(again).toMatchObject({manifestId:first.manifestId,replayed:true});
  const {rows}=await db.query<{count:number}>('select count(*)::int as count from clinical_core.protocol_cart_manifests');
  expect(rows[0].count).toBe(1);
 });
});

describe('a compiled manifest afterwards',()=>{
 it('supersedes an earlier version’s cart without destroying it',async()=>{
  const first=await rpc('protocol_cart_workforce',{action:'compile',programVersionId:v1});
  await publish(v2,[supplement('magnesium',['magnesium_glycinate'])],2);
  const second=await rpc('protocol_cart_workforce',{action:'compile',programVersionId:v2});
  const listed=await rpc('protocol_cart_workforce',{action:'list',programId:program});
  expect((listed.manifests as {manifestId:string;status:string}[]).map(m=>[m.manifestId,m.status]))
   .toEqual([[second.manifestId,'compiled'],[first.manifestId,'superseded']]);
 });

 it('cannot be rewritten or deleted',async()=>{
  const compiled=await rpc('protocol_cart_workforce',{action:'compile',programVersionId:v1});
  expect(await message(db.query(
   'update clinical_core.protocol_cart_manifests set lines=$1::jsonb where id=$2',
   [JSON.stringify([]),compiled.manifestId]))).toContain('protocol_cart_immutable');
  expect(await message(db.query(
   'update clinical_core.protocol_cart_manifests set included_count=99 where id=$1',
   [compiled.manifestId]))).toContain('protocol_cart_immutable');
  expect(await message(db.query(
   'delete from clinical_core.protocol_cart_manifests where id=$1',[compiled.manifestId])))
   .toContain('protocol_cart_immutable');
 });

 it('says in the answer that nothing has been sent anywhere',async()=>{
  const compiled=await rpc('protocol_cart_workforce',{action:'compile',programVersionId:v1});
  const read=await rpc('protocol_cart_workforce',{action:'read',manifestId:compiled.manifestId});
  expect(read.delivery).toEqual({state:'not_implemented',
   detail:'no_cart_is_created_at_any_provider'});
 });

 it('does not answer a patient',async()=>{
  expect(await message(rpc('protocol_cart_workforce',{action:'list',programId:program},consumer,'consumer')))
   .toBe('protocol_cart_forbidden');
 });
});
