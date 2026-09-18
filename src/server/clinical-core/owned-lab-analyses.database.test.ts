import {beforeAll,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {deterministicUuid,publicationEnvelope,type PublishableLabJob} from './owned-lab-publication';
const owner=randomUUID(),other=randomUUID(),org=randomUUID(),jobId=randomUUID();let db:PGlite;
const authorization={version:'owned-lab/1' as const,personId:owner,organizationId:org,identitySubject:'subject-'+owner,consents:{ai_context:{revision:1,releaseVersion:'fictional-lab',contentSha256:'a'.repeat(64)},lab_history:{revision:1,releaseVersion:'fictional-lab',contentSha256:'a'.repeat(64)}}};
const result={analysisId:randomUUID(),reviewState:'consumer_education',summary:'Fictional summary '.repeat(2000),biomarkers:[{canonicalName:'Ferritin',value:12}]};
const job:PublishableLabJob={pk:`job#${jobId}`,ownerSub:'subject-'+owner,organizationId:org,personId:owner,state:'completed',authorization,result,updatedAt:'2026-01-01T00:00:00.000Z'};
const envelope=publicationEnvelope(job,()=>Date.parse('2026-01-02T00:00:00Z'))!;
async function actor(sql:string,params:unknown[]=[],who=owner,purpose='clinical_data'){
  return db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,$4,'production-clinical','clinical_phi')",[who,org,'subject-'+who,purpose]);
    return tx.query(sql,params);});
}
const write=(collection:string,p:unknown,recordId:string,revision=0,request=randomUUID())=>actor(
  "select clinical_core.write_owned_consumer_record($1,$2,$3,$4,$5::jsonb,false,1) as result",[collection,recordId,revision,request,JSON.stringify(p)]);
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000}));
  db=new PGlite({extensions:{pgcrypto}});for(const m of manifest.migrations)await db.exec(files[m.file]);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'Fictional publication test')",[org]);
  for(const who of [owner,other]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[who,'subject_'+who.replaceAll('-','')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)",[who,'subject-'+who]);
  }
  await db.exec("insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at) values('lab_history','fictional-lab','Fictional only',encode(public.digest('Fictional only','sha256'),'hex'),'TEST NOT APPROVAL',now())");
  for(const who of [owner,other])await actor("select clinical_core.set_owned_consumer_consent('lab_history','granted','fictional-lab',0)",[],who,'consent_management');
},30000);
afterAll(async()=>{await db?.close();});
it('stores a whole completed result above the ordinary record budget under lab_history consent, with exact replay and owner isolation',async()=>{
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(16384);
  const request=randomUUID();
  const first=(await write('lab_analyses',envelope,envelope.id,0,request)).rows[0] as {result:{revision:number;duplicate:boolean}};
  expect(first.result).toMatchObject({revision:1,duplicate:false});
  const replay=(await write('lab_analyses',envelope,envelope.id,0,request)).rows[0] as {result:{revision:number;duplicate:boolean}};
  expect(replay.result).toMatchObject({revision:1,duplicate:true});
  await expect(write('lab_analyses',envelope,envelope.id,0)).rejects.toThrow(/owned_record_revision_conflict/);
  const listed=(await actor("select clinical_core.list_owned_consumer_records('lab_analyses',10) as result")).rows[0] as {result:{recordId:string;payload:{resultSha256:string}}[]};
  expect(listed.result).toHaveLength(1);expect(listed.result[0]!.payload.resultSha256).toBe(envelope.resultSha256);
  const isolated=(await actor("select clinical_core.list_owned_consumer_records('lab_analyses',10) as result",[],other)).rows[0] as {result:unknown[]};
  expect(isolated.result).toEqual([]);
  const scope=(await db.query("select clinical_private.consumer_collection_scope('lab_analyses') as scope")).rows[0] as {scope:string};
  expect(scope.scope).toBe('lab_history');
});
it('keeps the 16 KiB budget for every other collection and refuses malformed analysis envelopes',async()=>{
  const bigObservation={id:randomUUID(),panelId:randomUUID(),markerId:randomUUID(),panelName:'x'.repeat(200),name:'Ferritin',value:0,unit:null,drawnAt:'2026-01-01T00:00:00.000Z',reportedRange:null,sourceStatus:'consumer_import_unverified',filler:'y'.repeat(17000)};
  await expect(write('lab_observations',bigObservation,bigObservation.id)).rejects.toThrow(/owned_record_request_invalid|owned_lab_observation_invalid/);
  for(const bad of [{...envelope,version:'personal-lab-analysis/2'},{...envelope,sourceStatus:'approved'},{...envelope,kind:'clinic'},{...envelope,resultSha256:'nothex'},{...envelope,completedAt:'2099-01-01T00:00:00.000Z'},{...envelope,result:[]},{...envelope,extra:true}]){
    await expect(write('lab_analyses',bad,envelope.id,1)).rejects.toThrow(/owned_lab_analysis_invalid|owned_record_request_invalid/);
  }
  await expect(write('lab_analyses',envelope,deterministicUuid('other-record'))).rejects.toThrow(/owned_lab_analysis_invalid/);
  const oversized={...envelope,result:{...result,summary:'z'.repeat(270_000)}};
  await expect(write('lab_analyses',oversized,envelope.id,1)).rejects.toThrow(/owned_record_request_invalid/);
});
