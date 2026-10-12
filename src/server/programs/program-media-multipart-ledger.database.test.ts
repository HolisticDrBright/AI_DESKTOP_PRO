import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import type {ClinicalCoreDatabase} from '@/server/clinical-core/database';
import type {ClinicalRequestContext} from '@/server/clinical-core/aws-identity-consent';
import {createProgramMediaNativeLedger} from './program-media-native-ledger';
import {createProgramMediaMultipartLedger} from './program-media-multipart-ledger';
import {programMediaCompositeChecksum,PROGRAM_MEDIA_PART_BYTES} from './program-media-parts';

const id=(n:number)=>'72000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),actor=id(2),program=id(3),otherOrg=id(4),otherActor=id(5),otherProgram=id(6),colleague=id(7);
const subject='syn_multipart_educator';
const context={actorPersonId:actor,organizationId:org,identityPool:'workforce',identitySubject:subject,purpose:'clinical_data',
 environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,realPatientData:false} as ClinicalRequestContext;
const storage={purpose:'educational_media' as const,phiAllowed:false as const,dedicated:true as const,bucket:'alp-synthetic-lessons',
 expectedBucketOwner:'588966314750',region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:588966314750:key/'+id(99),
 maxImageBytes:16777216,maxVideoBytes:268435456,publicOrigin:'https://lessons.example.test/'};
const release={evidenceSha256:'a'.repeat(64),storage},activation={enabled:true,evidenceSha256:'b'.repeat(64)};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const recipe={totalBytes:PROGRAM_MEDIA_PART_BYTES+3,parts:[{partNumber:1,bytes:PROGRAM_MEDIA_PART_BYTES,sha256:sha('fictional first part')},
 {partNumber:2,bytes:3,sha256:sha('fictional final part')}]};
let db:PGlite,database:ClinicalCoreDatabase,native:ReturnType<typeof createProgramMediaNativeLedger>,
 ledger:ReturnType<typeof createProgramMediaMultipartLedger>;
const roleProbes=new Map<string,PGlite>();
const call=(operation:string,parameters:Record<string,unknown>,c=context)=>ledger.execute(c,{operation,parameters});
async function reserve(manifest=recipe){
 const artifactId=randomUUID(),now=new Date().toISOString();
 await native.reserve(context,{artifactId,clinic:org,programId:program,commandId:randomUUID(),kind:'video',contentType:'video/mp4',
  bytes:manifest.totalBytes,sha256:sha('fictional whole video'),objectKey:'program-media/'+org+'/'+program+'/'+artifactId+'/'+sha('fictional whole video')+'.mp4',
  state:'reserved',acceptBefore:new Date(Date.now()+900000).toISOString(),createdAt:now,failure:null});
 return artifactId;
}
async function start(manifest=recipe){
 const artifactId=await reserve(manifest),writerClaimId=randomUUID();
 return (await call('start',{artifactId,manifest,writerClaimId})).session;
}
async function upload(){
 const s=await start(),claimId=randomUUID();
 expect((await call('admitCreation',{artifactId:s.artifactId,claimId})).admitted).toBe(true);
 return (await call('recordUpload',{artifactId:s.artifactId,claimId,uploadId:'fictional-upload-'+s.artifactId})).session;
}
const receipt=(part:typeof recipe.parts[number])=>({bytes:part.bytes,checksum:Buffer.from(part.sha256,'hex').toString('base64'),etag:'"fictional-part-'+part.partNumber+'"'});
async function allParts(){
 const s=await upload();
 for(const part of recipe.parts){
  const claimId=randomUUID();
  await call('admitPart',{artifactId:s.artifactId,claimId,partNumber:part.partNumber});
  await call('recordPart',{artifactId:s.artifactId,claimId,partNumber:part.partNumber,receipt:receipt(part)});
 }
 return (await call('status',{artifactId:s.artifactId})).session;
}
async function expire(artifactId:string){
 await db.exec('alter table clinical_core.program_media_artifacts disable trigger program_media_artifact_transition');
 await db.query("update clinical_core.program_media_artifacts set created_at=clock_timestamp()-interval '1 hour',accept_before=clock_timestamp()-interval '1 minute' where id=$1",[artifactId]);
 await db.exec('alter table clinical_core.program_media_artifacts enable trigger program_media_artifact_transition');
}
async function installSource(target:PGlite){
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const m of manifest.migrations)await target.exec(readFileSync('infra/aws-clinical-core/migrations/'+m.file,'utf8'));
 for(const [file,digest] of [
  ['program-media-ledger.sql','6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d'],
  ['program-media-settlement.sql','74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04'],
  ['program-media-native-ledger.sql','69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7']]){
  const sql=readFileSync('infra/aws-clinical-core/source-candidates/'+file,'utf8');expect(sha(sql)).toBe(digest);await target.exec(sql);
 }
 await target.exec(readFileSync('infra/aws-clinical-core/source-candidates/program-media-multipart.sql','utf8'));
}
beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 await installSource(db);
 // Session-authorization probes use independent connections with the same
 // exact artifact. Their non-admin identity must never leak into the operator
 // fixture or force the tests to rely on execution order.
 for(const role of ['program_media_worker','clinical_core_api']){
  const probe=new PGlite({extensions:{pgcrypto}});await installSource(probe);roleProbes.set(role,probe);
 }
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional media clinic'),($2,'Fictional other clinic')",[org,otherOrg]);
 for(const [person,sub,clinic] of [[actor,subject,org],[otherActor,'syn_other_multipart_educator',otherOrg],[colleague,'syn_multipart_colleague',org]]){
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[person,'syn_'+person.replaceAll('-','')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)",[person,sub]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[clinic,person]);
 }
 await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,created_by_person_id) values($1,$2,'Fictional course',$3),($4,$5,'Other fictional course',$6)",[program,org,actor,otherProgram,otherOrg,otherActor]);
 database={transaction:work=>db.transaction(async tx=>{
  await tx.exec('set local role program_media_worker');
  return work({query:async(sql,parameters)=>await tx.query(sql,parameters?.map(p=>typeof p==='object'&&p!==null&&'kind' in p&&'value' in p?p.value:p)??[]) as never});
 })};
 native=createProgramMediaNativeLedger(database,release);
 ledger=createProgramMediaMultipartLedger(database,release,activation);
},120000);
beforeEach(async()=>{
 await db.query("update clinical_core.program_media_activation set enabled=true,evidence_sha256=$1,native_evidence_sha256=$1,reviewed_by='Fictional operator',reviewed_at=clock_timestamp(),storage_bucket=$2,public_origin=$3,expected_bucket_owner=$4,region=$5,kms_key_arn=$6,max_image_bytes=$7,max_video_bytes=$8,multipart_enabled=true,multipart_evidence_sha256=$9",
  [release.evidenceSha256,storage.bucket,storage.publicOrigin,storage.expectedBucketOwner,storage.region,storage.kmsKeyArn,storage.maxImageBytes,storage.maxVideoBytes,activation.evidenceSha256]);
});
afterAll(async()=>{await db?.close();for(const probe of roleProbes.values())await probe.close();});

describe('durable multipart authority under the real restricted SQL worker',()=>{
 it('is off by default and gives workers neither tables nor the authority role',async()=>{
  await expect(createProgramMediaMultipartLedger(database,release).execute(context,{operation:'status',parameters:{artifactId:randomUUID()}})).rejects.toThrow('program_media_disabled');
  await db.exec('update clinical_core.program_media_activation set multipart_enabled=false');
  await expect(call('start',{artifactId:randomUUID(),manifest:recipe,writerClaimId:randomUUID()})).rejects.toThrow('program_media_disabled');
  for(const role of ['program_media_worker','clinical_core_api']){
   await expect(db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.exec('select * from clinical_private.program_media_multipart');})).rejects.toThrow(/permission denied/);
   // SET ROLE alone keeps the superuser session identity in this fixture.
   // Reduce session authority as well to test the real non-admin refusal.
   const probe=roleProbes.get(role)!;
   await expect(probe.transaction(async tx=>{await tx.exec('set local session authorization '+role);await tx.exec('set local role program_media_authority');})).rejects.toThrow(/permission denied/);
  }
 });
 it('replays one immutable manifest and writer claim across fresh adapters without permission to create twice',async()=>{
  const s=await start(),again=await call('start',{artifactId:s.artifactId,manifest:recipe,writerClaimId:randomUUID()});
  expect(again.admitted).toBe(false);expect(again.session.writerClaimId).toBe(s.writerClaimId);
  const claimId=randomUUID();
  expect((await call('admitCreation',{artifactId:s.artifactId,claimId})).admitted).toBe(true);
  const restarted=createProgramMediaMultipartLedger(database,release,activation);
  expect((await restarted.execute(context,{operation:'admitCreation',parameters:{artifactId:s.artifactId,claimId}})).admitted).toBe(false);
  await expect(call('admitCreation',{artifactId:s.artifactId,claimId:randomUUID()})).rejects.toThrow('conflict');
  expect((await native.beginCleanup(context,s.artifactId,randomUUID(),'')).toString()).toBe('false');
 });
 it('rejects altered, reordered, undersized and full-file-size-mismatched manifests',async()=>{
  const s=await start(),changed={...recipe,parts:recipe.parts.map((p,i)=>({...p,sha256:i===0?'0'.repeat(64):p.sha256}))};
  await expect(call('start',{artifactId:s.artifactId,manifest:changed,writerClaimId:randomUUID()})).rejects.toThrow('conflict');
  for(const manifest of [{...recipe,parts:[...recipe.parts].reverse()},{...recipe,parts:recipe.parts.map(p=>({...p,bytes:1}))},{totalBytes:1,parts:[{...recipe.parts[0],bytes:1}]}]){
   await expect(call('start',{artifactId:s.artifactId,manifest,writerClaimId:randomUUID()})).rejects.toThrow(/request_invalid|conflict/);
  }
 });
 it('keeps the 256 MiB ceiling as exactly 32 admitted immutable parts, not a smaller substitute',async()=>{
  const manifest={totalBytes:268435456,parts:Array.from({length:32},(_,i)=>({partNumber:i+1,bytes:PROGRAM_MEDIA_PART_BYTES,sha256:sha('fictional-part-'+i)}))};
  const s=await start(manifest);expect(s.manifest).toEqual(manifest);expect(s.checksum).toBe(programMediaCompositeChecksum(manifest));
 });
 it('records a lost creation reply idempotently and never replaces its provider identity',async()=>{
  const s=await start(),claimId=randomUUID();await call('admitCreation',{artifactId:s.artifactId,claimId});
  const p={artifactId:s.artifactId,claimId,uploadId:'fictional-upload'};
  await call('recordUpload',p);expect((await call('recordUpload',p)).session.uploadId).toBe(p.uploadId);
  await expect(call('recordUpload',{...p,uploadId:'other-upload'})).rejects.toThrow('conflict');
  expect((await db.query("select actor_id,multipart_evidence_sha256 from clinical_private.program_media_multipart_events where artifact_id=$1 and operation='recordUpload'",[s.artifactId])).rows)
   .toEqual([{actor_id:actor,multipart_evidence_sha256:activation.evidenceSha256}]);
  await expect(db.query('delete from clinical_private.program_media_multipart_events where artifact_id=$1',[s.artifactId])).rejects.toThrow('append_only_record');
 });
 it('allows one pending part writer, preserves uncertainty and does not resend on restart',async()=>{
  const s=await upload(),claimId=randomUUID();
  expect((await call('admitPart',{artifactId:s.artifactId,partNumber:1,claimId})).admitted).toBe(true);
  expect((await call('admitPart',{artifactId:s.artifactId,partNumber:1,claimId})).admitted).toBe(false);
  await call('settleAttempt',{artifactId:s.artifactId,claimId,outcome:'uncertain'});
  await expect(call('admitPart',{artifactId:s.artifactId,partNumber:1,claimId:randomUUID()})).rejects.toThrow('conflict');
  expect((await call('status',{artifactId:s.artifactId})).session.pending).toEqual([expect.objectContaining({claimId,state:'uncertain'})]);
  await call('recordPart',{artifactId:s.artifactId,partNumber:1,claimId,receipt:receipt(recipe.parts[0])});
  expect((await call('status',{artifactId:s.artifactId})).session.pending).toEqual([]);
 });
 it('refuses receipt substitution and completion with missing or unsettled parts',async()=>{
  const s=await upload(),claimId=randomUUID();await call('admitPart',{artifactId:s.artifactId,partNumber:1,claimId});
  await expect(call('recordPart',{artifactId:s.artifactId,partNumber:1,claimId,receipt:{...receipt(recipe.parts[0]),checksum:Buffer.alloc(32).toString('base64')}})).rejects.toThrow('request_invalid');
  await expect(call('admitCompletion',{artifactId:s.artifactId,claimId:randomUUID()})).rejects.toThrow('conflict');
  await call('recordPart',{artifactId:s.artifactId,partNumber:1,claimId,receipt:receipt(recipe.parts[0])});
  await expect(call('admitCompletion',{artifactId:s.artifactId,claimId:randomUUID()})).rejects.toThrow('conflict');
 });
 it('requires the exact composite version AND a matching host whole-file observation receipt before committing',async()=>{
  const s=await allParts(),claimId=randomUUID();await call('admitCompletion',{artifactId:s.artifactId,claimId});
  await expect(call('recordCompletion',{artifactId:s.artifactId,claimId,objectVersion:'fictional-version',checksum:s.sha256})).rejects.toThrow('request_invalid');
  await call('recordCompletion',{artifactId:s.artifactId,claimId,objectVersion:'fictional-version',checksum:s.checksum});
  expect((await native.artifact(context,s.artifactId))?.state).toBe('reserved');
  const proof={objectVersion:'fictional-version',checksum:s.checksum,sha256:s.sha256,bytes:s.totalBytes};
  for(const bad of [{...proof,sha256:'0'.repeat(64)},{...proof,bytes:1},{...proof,objectVersion:'other-version'}]){
   await expect(call('commit',{artifactId:s.artifactId,proof:bad})).rejects.toThrow('request_invalid');
  }
  expect((await call('commit',{artifactId:s.artifactId,proof})).session.state).toBe('committed');
  expect((await call('commit',{artifactId:s.artifactId,proof})).session.state).toBe('committed');
  expect((await native.artifact(context,s.artifactId))?.state).toBe('ready');
 });
 it('refuses new parts after cancel but records a previously admitted late part without certifying deletion',async()=>{
  const s=await upload(),claimId=randomUUID();await call('admitPart',{artifactId:s.artifactId,partNumber:1,claimId});
  await call('cancel',{artifactId:s.artifactId});
  await expect(call('admitPart',{artifactId:s.artifactId,partNumber:2,claimId:randomUUID()})).rejects.toThrow('conflict');
  expect((await call('recordPart',{artifactId:s.artifactId,partNumber:1,claimId,receipt:receipt(recipe.parts[0])})).session.state).toBe('abort_requested');
  expect((await native.artifact(context,s.artifactId))?.state).toBe('reserved');
  expect(await native.beginCleanup(context,s.artifactId,randomUUID(),'')).toBe(false);
 });
 it('retains late completion after cancellation and refuses commit or absence while a writer is unresolved',async()=>{
  const s=await allParts(),claimId=randomUUID();await call('admitCompletion',{artifactId:s.artifactId,claimId});
  await call('cancel',{artifactId:s.artifactId});
  const proof={complete:true,remainingUploads:0,remainingVersions:0,checkedAt:new Date().toISOString(),objectKey:s.objectKey};
  await expect(call('certifyAbort',{artifactId:s.artifactId,proof})).rejects.toThrow('conflict');
  await call('recordCompletion',{artifactId:s.artifactId,claimId,objectVersion:'late-version',checksum:s.checksum});
  await expect(call('commit',{artifactId:s.artifactId,proof:{objectVersion:'late-version',checksum:s.checksum,sha256:s.sha256,bytes:s.totalBytes}})).rejects.toThrow('conflict');
  expect((await call('status',{artifactId:s.artifactId})).session.state).toBe('abort_requested');
 });
 it('allows resumed admissions only before database expiry while preserving late admitted receipts',async()=>{
  const s=await upload(),claimId=randomUUID();await call('admitPart',{artifactId:s.artifactId,partNumber:1,claimId});
  await expire(s.artifactId);
  await expect(call('admitPart',{artifactId:s.artifactId,partNumber:2,claimId:randomUUID()})).rejects.toThrow('conflict');
  await call('recordPart',{artifactId:s.artifactId,partNumber:1,claimId,receipt:receipt(recipe.parts[0])});
  expect((await call('status',{artifactId:s.artifactId})).session.parts).toHaveLength(1);
 });
 it('rechecks owner, membership and the exact release for every receipt without settling uncertain work',async()=>{
  const s=await upload(),claimId=randomUUID();await call('admitPart',{artifactId:s.artifactId,partNumber:1,claimId});
  for(const c of [{...context,actorPersonId:otherActor,organizationId:otherOrg,identitySubject:'syn_other_multipart_educator'},
   {...context,actorPersonId:colleague,identitySubject:'syn_multipart_colleague'},{...context,identityPool:'consumer'}]){
   await expect(call('status',{artifactId:s.artifactId},c as ClinicalRequestContext)).rejects.toThrow(/access_refused|not_found/);
  }
  await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1",[actor]);
  await expect(call('recordPart',{artifactId:s.artifactId,partNumber:1,claimId,receipt:receipt(recipe.parts[0])})).rejects.toThrow('access_refused');
  await db.query("update clinical_core.organization_memberships set status='active' where person_id=$1",[actor]);
  await db.query('update clinical_core.program_media_activation set multipart_evidence_sha256=$1',['c'.repeat(64)]);
  await expect(call('recordPart',{artifactId:s.artifactId,partNumber:1,claimId,receipt:receipt(recipe.parts[0])})).rejects.toThrow('storage_unverified');
  expect((await db.query('select state from clinical_private.program_media_multipart_attempts where claim_id=$1',[claimId])).rows).toEqual([{state:'open'}]);
 });
 it('only releases the parent fence after all writers settle and exact-key complete absence is observed',async()=>{
  const s=await start(),claimId=randomUUID();await call('admitCreation',{artifactId:s.artifactId,claimId});
  await call('cancel',{artifactId:s.artifactId});
  const proof={complete:true,remainingUploads:0,remainingVersions:0,checkedAt:new Date().toISOString(),objectKey:s.objectKey};
  await expect(call('certifyAbort',{artifactId:s.artifactId,proof})).rejects.toThrow('conflict');
  await call('settleAttempt',{artifactId:s.artifactId,claimId,outcome:'not_sent'});
  await expect(call('certifyAbort',{artifactId:s.artifactId,proof:{...proof,objectKey:'other-key'}})).rejects.toThrow('request_invalid');
  expect((await call('certifyAbort',{artifactId:s.artifactId,proof:{...proof,checkedAt:new Date().toISOString()}})).session.state).toBe('aborted');
  await expire(s.artifactId);
  expect(await native.beginCleanup(context,s.artifactId,randomUUID(),'')).toBe(true);
 });
 it('cannot bypass multipart proof or drain through the existing native entry point',async()=>{
  const s=await start();
  await expect(native.commit(context,s.artifactId,'unverified-version','',s.writerClaimId)).rejects.toThrow('conflict');
  await expect(native.finishWriter(context,s.artifactId,s.writerClaimId,'settled')).rejects.toThrow('conflict');
  await expect(native.finishWriter(context,s.artifactId,s.writerClaimId,'uncertain')).rejects.toThrow('conflict');
  await expect(native.beginWriter(context,s.artifactId,randomUUID(),'reconcile','')).rejects.toThrow('conflict');
  expect((await native.artifact(context,s.artifactId))?.state).toBe('reserved');
  expect((await db.query('select state from clinical_private.program_media_work where claim_id=$1',[s.writerClaimId])).rows).toEqual([{state:'open'}]);
 });
 it('preserves the other cancellation race order and refuses a previously completed but unverified object',async()=>{
  const s=await allParts(),claimId=randomUUID();await call('admitCompletion',{artifactId:s.artifactId,claimId});
  await call('recordCompletion',{artifactId:s.artifactId,claimId,objectVersion:'observed-version',checksum:s.checksum});
  expect((await call('cancel',{artifactId:s.artifactId})).session.state).toBe('abort_requested');
  await expect(call('commit',{artifactId:s.artifactId,proof:{objectVersion:'observed-version',checksum:s.checksum,sha256:s.sha256,bytes:s.totalBytes}})).rejects.toThrow('conflict');
  expect((await native.artifact(context,s.artifactId))?.state).toBe('reserved');
 });
 it('only admits a new attempt after definitive pre-mutation failure, never after uncertainty',async()=>{
  const s=await start(),claimId=randomUUID();await call('admitCreation',{artifactId:s.artifactId,claimId});
  await call('settleAttempt',{artifactId:s.artifactId,claimId,outcome:'not_sent'});
  const next=randomUUID();expect((await call('admitCreation',{artifactId:s.artifactId,claimId:next})).admitted).toBe(true);
  await call('settleAttempt',{artifactId:s.artifactId,claimId:next,outcome:'uncertain'});
  await expect(call('settleAttempt',{artifactId:s.artifactId,claimId:next,outcome:'not_sent'})).rejects.toThrow('conflict');
  await expect(call('admitCreation',{artifactId:s.artifactId,claimId:randomUUID()})).rejects.toThrow('conflict');
 });
 it('allows existing parent activation withdrawal without also editing the new candidate',async()=>{
  const s=await upload(),claimId=randomUUID();await call('admitPart',{artifactId:s.artifactId,partNumber:1,claimId});
  await db.exec('update clinical_core.program_media_activation set enabled=false');
  await expect(call('recordPart',{artifactId:s.artifactId,partNumber:1,claimId,receipt:receipt(recipe.parts[0])})).rejects.toThrow('program_media_disabled');
  expect((await db.query('select state from clinical_private.program_media_multipart_attempts where claim_id=$1',[claimId])).rows).toEqual([{state:'open'}]);
 });
 it('rejects a null raw SQL outcome instead of settling an unknown writer',async()=>{
  const s=await start(),claimId=randomUUID();await call('admitCreation',{artifactId:s.artifactId,claimId});
  const answer=await database.transaction(async tx=>{
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[actor,org,'workforce',subject,'clinical_data','synthetic-staging','synthetic_only']);
   return tx.query<{data:{ok:boolean;error:string}}>('select clinical_core.program_media_multipart_request($1::jsonb) as data',
    [JSON.stringify({operation:'settleAttempt',parameters:{artifactId:s.artifactId,claimId,outcome:null},release,multipartEvidenceSha256:activation.evidenceSha256})]);
  });
  expect(answer.rows[0].data).toMatchObject({ok:false,error:'request_invalid'});
  expect((await db.query('select state from clinical_private.program_media_multipart_attempts where claim_id=$1',[claimId])).rows).toEqual([{state:'open'}]);
 });
 it.each([
  {state:'open',outcome:null,receipt:{uploadId:'unearned-receipt'},settledAt:null},
  {state:'settled',outcome:'uncertain',receipt:null,settledAt:'2026-10-11T00:00:00Z'},
 ])('keeps attempt receipt and settlement invariants null-safe even for operator writes: %j',async({state,outcome,receipt,settledAt})=>{
  const s=await start();
  // This intentionally uses the privileged fixture, not an alleged worker
  // exploit. The real worker has no raw-table access, tested above.
  await expect(db.query('insert into clinical_private.program_media_multipart_attempts(claim_id,artifact_id,organization_id,actor_id,kind,state,outcome,receipt,settled_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
   [randomUUID(),s.artifactId,org,actor,'creation',state,outcome,receipt===null?null:JSON.stringify(receipt),settledAt])).rejects.toThrow(/check constraint/);
 });
});
