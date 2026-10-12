import {beforeAll, beforeEach, afterAll, describe, it, expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import type {ClinicalCoreDatabase} from '@/server/clinical-core/database';
import type {ClinicalRequestContext} from '@/server/clinical-core/aws-identity-consent';
import {createProgramMediaNativeLedger} from './program-media-native-ledger';
import {createProgramMediaAuthoring} from './program-media-authoring';
import {createFictionalProgramMediaStore} from './program-media-fictional';

const id=(n:number)=>'71000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1), actor=id(2), program=id(3), otherOrg=id(4), otherActor=id(5), otherProgram=id(6), staff=id(7);
const subject='syn_media_native_educator';
const context={actorPersonId:actor,organizationId:org,identityPool:'workforce',identitySubject:subject,purpose:'clinical_data',
 environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,realPatientData:false} as ClinicalRequestContext;
const storage={purpose:'educational_media' as const,phiAllowed:false as const,dedicated:true as const,bucket:'alp-synthetic-lessons',expectedBucketOwner:'588966314750',
 region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:588966314750:key/71000000-0000-4000-8000-000000000099',
 maxImageBytes:16777216,maxVideoBytes:268435456,publicOrigin:'https://lessons.example.test/'};
let db:PGlite, ledger:ReturnType<typeof createProgramMediaNativeLedger>;
const bytes=new TextEncoder().encode('fictional educational PNG bytes');
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const prepare=(commandId=randomUUID(),data=bytes)=>({commandId,programId:program,kind:'image',contentType:'image/png',bytes:data.length,sha256:hash(data),fileName:'lesson.png'});
function runtime(){return createProgramMediaAuthoring({ledger,store:createFictionalProgramMediaStore({kmsKeyArn:storage.kmsKeyArn}),storage,activation:{enabled:true,reason:'Fictional embedded test only'}});}
async function active(enabled:boolean){
 await db.query(`update clinical_core.program_media_activation set enabled=$1,evidence_sha256=$2,reviewed_by='Fictional fixture operator',reviewed_at=clock_timestamp(),
 storage_bucket=$3,public_origin=$4,native_evidence_sha256=$2,expected_bucket_owner=$5,region=$6,kms_key_arn=$7,max_image_bytes=$8,max_video_bytes=$9`,
 [enabled,'a'.repeat(64),storage.bucket,storage.publicOrigin,storage.expectedBucketOwner,storage.region,storage.kmsKeyArn,storage.maxImageBytes,storage.maxVideoBytes]);
}
beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const m of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+m.file,'utf8'));
 for(const [file,digest] of [['program-media-ledger.sql','6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d'],
 ['program-media-settlement.sql','74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04']]){
  const sql=readFileSync('infra/aws-clinical-core/source-candidates/'+file,'utf8');expect(hash(sql)).toBe(digest);await db.exec(sql);
 }
 const nativeSql=readFileSync('infra/aws-clinical-core/source-candidates/program-media-native-ledger.sql','utf8');
 expect(hash(nativeSql)).toBe('69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7');
 await db.exec(nativeSql);
 await db.query(`insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional media clinic'),($2,'Fictional other clinic')`,[org,otherOrg]);
 for(const [person,sub,clinic,role] of [[actor,subject,org,'practitioner'],[otherActor,'syn_media_other_educator',otherOrg,'owner'],[staff,'syn_media_staff_member',org,'staff']]){
  await db.query(`insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)`,[person,'syn_'+String(person).replaceAll('-','')]);
  await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)`,[person,sub]);
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)`,[clinic,person,role]);
 }
 await db.query(`insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,created_by_person_id) values($1,$2,'Fictional lesson',$3),($4,$5,'Fictional unrelated lesson',$6)`,[program,org,actor,otherProgram,otherOrg,otherActor]);
 const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
  await tx.exec('set local role program_media_worker');
  return work({query:async(sql,parameters)=>await tx.query(sql,parameters?.map(p=>typeof p==='object'&&p!==null&&'kind' in p&&'value' in p?p.value:p)??[]) as never});
 })};
 ledger=createProgramMediaNativeLedger(database,{evidenceSha256:'a'.repeat(64),storage});
},120000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await active(true);});

describe('complete native media ledger under the restricted worker role',()=>{
 it('is unavailable by default and exposes neither tables nor private settlement to the worker/API',async()=>{
  await active(false);
  await expect(db.transaction(async tx=>{
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[actor,org,'workforce',subject,'clinical_data','synthetic-staging','synthetic_only']);
   await tx.exec('set local role program_media_authority');
   await tx.exec('select clinical_private.program_media_require_actor()');
  })).rejects.toThrow('pm.program_media_disabled');
  await expect(ledger.authorize(context,program)).rejects.toThrow('program_media_disabled');
  for(const role of ['program_media_worker','clinical_core_api']){
   await expect(db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.exec('select * from clinical_core.program_media_artifacts');})).rejects.toThrow(/permission denied/);
   await expect(db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query('select clinical_private.program_media_begin_work($1,$2,$3,$4,$5)',[org,actor,randomUUID(),randomUUID(),'admit']);})).rejects.toThrow(/permission denied/);
  }
  expect((await db.query('select enabled from clinical_core.program_media_activation')).rows).toEqual([{enabled:false}]);
 });
 it('completes prepare upload caption publication retirement with exact historical receipts',async()=>{
  const api=runtime(),r=await api.prepare(context,prepare());
  const a=await api.admit(context,{artifactId:r.artifactId,sha256:r.sha256,bytes:r.bytes},bytes);
  expect(a.state).toBe('ready');
  const text=await api.attachText(context,{artifactId:a.artifactId,expectedVersion:a.version,slot:'caption',text:'Fictional supplied lesson caption',source:'supplied_by_author',format:'plain'});
  const ref=await api.publish(context,{artifactId:a.artifactId,expectedVersion:text.version});
  expect((await api.describeReference(context,ref)).current).toBe(true);
  const retired=await api.retire(context,{artifactId:a.artifactId,expectedVersion:text.version});
  expect(retired.state).toBe('retired');
  expect(await api.describeReference(context,ref)).toEqual({reference:ref,current:false,historical:true});
  await expect(api.publish(context,{artifactId:a.artifactId,expectedVersion:retired.version})).rejects.toThrow('retired');
 });
 it('replays one command across fresh adapters and refuses changed bytes under it',async()=>{
  const api=runtime(),command=randomUUID(),first=await api.prepare(context,prepare(command));
  const again=await api.prepare(context,prepare(command));expect(again.artifactId).toBe(first.artifactId);expect(again.replayed).toBe(true);
  await expect(api.prepare(context,prepare(command,new TextEncoder().encode('different fictional bytes')))).rejects.toThrow('conflict');
  expect((await db.query<{n:number}>('select count(*)::int as n from clinical_core.program_media_artifacts where command_id=$1',[command])).rows[0].n).toBe(1);
 });
 it('refuses other clinic, staff, consumer, disabled identity/person and suspended membership',async()=>{
  expect(await ledger.authorize(context,otherProgram)).toBe(false);
  await expect(ledger.authorize({...context,actorPersonId:staff,identitySubject:'syn_media_staff_member'},program)).rejects.toThrow('access_refused');
  await expect(ledger.authorize({...context,identityPool:'consumer'},program)).rejects.toThrow('access_refused');
  await db.query(`update clinical_core.identities set status='disabled' where person_id=$1`,[actor]);
  await expect(ledger.authorize(context,program)).rejects.toThrow('access_refused');
  await db.query(`update clinical_core.identities set status='active' where person_id=$1`,[actor]);
  await db.query(`update clinical_core.persons set status='disabled' where id=$1`,[actor]);
  await expect(ledger.authorize(context,program)).rejects.toThrow('access_refused');
  await db.query(`update clinical_core.persons set status='active' where id=$1`,[actor]);
  await db.query(`update clinical_core.organization_memberships set status='suspended' where person_id=$1`,[actor]);
  await expect(ledger.authorize(context,program)).rejects.toThrow('access_refused');
  await db.query(`update clinical_core.organization_memberships set status='active' where person_id=$1`,[actor]);
 });
 it('rechecks rights for mutation after a writer admission and preserves unresolved work',async()=>{
  const r=await runtime().prepare(context,prepare()),claim=randomUUID();
  expect(await ledger.beginWriter(context,r.artifactId,claim,'admit','')).toBe(true);
  await db.query(`update clinical_core.organization_memberships set status='suspended' where person_id=$1`,[actor]);
  await expect(ledger.commit(context,r.artifactId,'fictional-object',new Date().toISOString(),claim)).rejects.toThrow('access_refused');
  expect((await db.query<{state:string}>('select state from clinical_core.program_media_artifacts where id=$1',[r.artifactId])).rows[0].state).toBe('reserved');
  expect((await db.query<{state:string}>('select state from clinical_private.program_media_work where claim_id=$1',[claim])).rows[0].state).toBe('open');
  await db.query(`update clinical_core.organization_memberships set status='active' where person_id=$1`,[actor]);
  await ledger.finishWriter(context,r.artifactId,claim,'settled');
 });
 it('uses database time and makes late writer and cleanup races follow the same durable seal',async()=>{
  const r=await runtime().prepare(context,prepare()),claim=randomUUID();
  await db.exec('alter table clinical_core.program_media_artifacts disable trigger program_media_artifact_transition');
  await db.query(`update clinical_core.program_media_artifacts set created_at=clock_timestamp()-interval '1 hour',accept_before=clock_timestamp()-interval '1 minute' where id=$1`,[r.artifactId]);
  await db.exec('alter table clinical_core.program_media_artifacts enable trigger program_media_artifact_transition');
  expect(await ledger.beginWriter(context,r.artifactId,claim,'admit','2099-01-01T00:00:00Z')).toBe(false);
  expect(await ledger.beginWriter(context,r.artifactId,claim,'reconcile','')).toBe(true);
  expect(await ledger.beginCleanup(context,r.artifactId,randomUUID(),'')).toBe(false);
  await ledger.finishWriter(context,r.artifactId,claim,'settled');
  const cleanup=randomUUID();expect(await ledger.beginCleanup(context,r.artifactId,cleanup,'')).toBe(true);
  expect(await ledger.beginWriter(context,r.artifactId,randomUUID(),'reconcile','')).toBe(false);
  await ledger.certifyCleanup(context,r.artifactId,cleanup,{artifactId:r.artifactId,claimId:cleanup,objectKey:r.objectKey,checkedAt:new Date().toISOString(),complete:true,remainingVersions:0,removedVersions:[]});
  expect((await ledger.artifact(context,r.artifactId))?.state).toBe('abandoned');
 });
 it('refuses a supplied text digest that does not match its exact UTF8 bytes',async()=>{
  const api=runtime(),data=new TextEncoder().encode('another fictional PNG'),r=await api.prepare(context,prepare(randomUUID(),data));
  const a=await api.admit(context,{artifactId:r.artifactId,sha256:r.sha256,bytes:r.bytes},data);
  await expect(ledger.attachText(context,a.artifactId,a.version,'caption',{text:'Supplied text',source:'supplied_by_author',format:'plain',sha256:'0'.repeat(64)})).rejects.toThrow('request_invalid');
  expect((await ledger.artifact(context,a.artifactId))?.version).toBe(a.version);
 });
 it('refuses a retired storage release after writer admission without releasing unresolved work',async()=>{
  const r=await runtime().prepare(context,prepare()),claim=randomUUID();
  expect(await ledger.beginWriter(context,r.artifactId,claim,'admit','')).toBe(true);
  await db.query("update clinical_core.program_media_activation set native_evidence_sha256=$1",['b'.repeat(64)]);
  await expect(ledger.commit(context,r.artifactId,'fictional-object',new Date().toISOString(),claim)).rejects.toThrow('storage_unverified');
  expect((await db.query<{state:string}>('select state from clinical_core.program_media_artifacts where id=$1',[r.artifactId])).rows[0].state).toBe('reserved');
  expect((await db.query<{state:string}>('select state from clinical_private.program_media_work where claim_id=$1',[claim])).rows[0].state).toBe('open');
 });
 it('requires every binding before activation and keeps the definer non-bypass and unavailable to workers',async()=>{
  for(const column of ['native_evidence_sha256','expected_bucket_owner','region','kms_key_arn','max_image_bytes','max_video_bytes']){
   await expect(db.exec('update clinical_core.program_media_activation set '+column+'=null')).rejects.toThrow(/program_media_native_activation_complete/);
  }
  expect((await db.query("select rolcanlogin,rolbypassrls,rolsuper from pg_roles where rolname='program_media_authority'")).rows).toEqual([{rolcanlogin:false,rolbypassrls:false,rolsuper:false}]);
  expect((await db.query("select pg_has_role('program_media_worker','program_media_authority','MEMBER') as member,has_table_privilege('program_media_worker','clinical_core.program_media_activation','SELECT,UPDATE') as table_access")).rows).toEqual([{member:false,table_access:false}]);
 });
});
