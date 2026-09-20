import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {createOwnedPrivacyExportJobs,privacyExportPrefix,type PrivacyExportStore,type PrivacyExportObjectStorage} from './owned-privacy-export-job';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase,type ClinicalCoreTransaction} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';

// Executable production SQL over fictional in-memory rows with a fictional object
// store. No bucket, hosted database, signed link or real account is involved.
const owner=randomUUID(),other=randomUUID(),org=randomUUID();
let db:PGlite;
const context=(who=owner):ProductionClinicalRequestContext=>({actorPersonId:who,organizationId:org,identityPool:'consumer',identitySubject:'subject-'+who,
  purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true});
// Replaces only the RDS transport: the same server-authored codes are classified the way rds-data-database does.
function classify(error:unknown){
  const message=error instanceof Error?error.message:'';
  if(/\b(privacy_export_job_state|privacy_export_job_busy|privacy_export_conflict)\b/.test(message))return new ClinicalCoreDatabaseRejection('conflict');
  if(/\b(privacy_export_job_refused|consumer_owner_required)\b/.test(message))return new ClinicalCoreDatabaseRejection('identity_refused');
  if(/\bprivacy_export_request_invalid\b/.test(message))return new ClinicalCoreDatabaseRejection('request_invalid');
  return error;
}
const database:ClinicalCoreDatabase={transaction:async work=>db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');
  return work({query:async(sql:string,args:unknown[]=[])=>{try{return await tx.query(sql,args.map(v=>typeof v==='object'&&v!==null&&'kind' in v&&v.kind==='uuid'&&'value' in v?v.value:v));}
    catch(error){throw classify(error);}}} as unknown as ClinicalCoreTransaction);})} as ClinicalCoreDatabase;
const adapter=()=>createOwnedConsumerRecordsAdapter(database);
const storage:PrivacyExportObjectStorage={bucket:'fictional-export-bucket',region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111',expectedBucketOwner:'123456789012'};
function fakeStore(){
  const objects=new Map<string,Map<string,Uint8Array>>(),uploads=new Map<string,{key:string;parts:Map<number,{bytes:Uint8Array;etag:string}>}>();
  let versions=0;const version=()=>'v'+(++versions);
  const put=(key:string,bytes:Uint8Array)=>{const v=version();if(!objects.has(key))objects.set(key,new Map());objects.get(key)!.set(v,bytes);return v;};
  const store:PrivacyExportStore={
    createUpload:vi.fn(async(_s,key)=>{const uploadId='u-'+randomUUID();uploads.set(uploadId,{key,parts:new Map()});return {uploadId};}),
    uploadPart:vi.fn(async(_s,key,uploadId,partNumber,body,sha)=>{const u=uploads.get(uploadId);if(!u||u.key!==key)throw new Error('NoSuchUpload');
      if(createHash('sha256').update(body).digest('hex')!==sha)throw new Error('BadDigest');const etag='"'+createHash('md5').update(body).digest('hex')+'"';u.parts.set(partNumber,{bytes:body,etag});return {etag};}),
    completeUpload:vi.fn(async(_s,key,uploadId,parts)=>{const u=uploads.get(uploadId);if(!u||u.key!==key)throw new Error('NoSuchUpload');
      const ordered=parts.map((p:{partNumber:number;etag:string})=>{const stored=u.parts.get(p.partNumber);if(!stored||stored.etag!==p.etag)throw new Error('InvalidPart');return stored.bytes;});
      const bytes=Buffer.concat(ordered);uploads.delete(uploadId);return {version:put(key,bytes),checksum:createHash('sha256').update(bytes).digest('base64')+'-'+parts.length};}),
    abortUpload:vi.fn(async(_s,_key,uploadId)=>{uploads.delete(uploadId);}),
    put:vi.fn(async(_s,key,body,sha)=>{if(createHash('sha256').update(body).digest('hex')!==sha)throw new Error('BadDigest');return {version:put(key,body)};}),
    get:vi.fn(async(_s,key,v,max)=>{const b=objects.get(key)?.get(v);if(!b)throw new Error('NoSuchVersion');if(b.byteLength>max)throw new Error('too large');return b;}),
    head:vi.fn(async(_s,key,v)=>{const b=objects.get(key)?.get(v);return b?{exists:true,bytes:b.byteLength,encryption:'aws:kms',kmsKeyArn:storage.kmsKeyArn,checksum:'x'}:{exists:false};}),
    deleteVersion:vi.fn(async(_s,key,v)=>{objects.get(key)?.delete(v);}),
    signDownload:vi.fn(async(_s,key,v,seconds,name)=>`https://fictional-export-bucket.s3.us-east-2.amazonaws.com/${key}?versionId=${v}&X-Amz-Expires=${seconds}&name=${encodeURIComponent(name)}`),
  };
  return {store,objects,uploads};
}
const jobsWith=(store:PrivacyExportStore,partBytes=8192)=>createOwnedPrivacyExportJobs((c,work)=>adapter().runPrivacy(c,work),{store,storage,partBytes});
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000}));
  db=new PGlite({extensions:{pgcrypto}});for(const m of manifest.migrations)await db.exec(files[m.file]);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')",[org]);
  for(const id of [owner,other]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)",[id,'subject-'+id]);
  }
  await db.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
    values('forms_checkins','export-fixture','Fictional only',encode(public.digest('Fictional only','sha256'),'hex'),'FICTIONAL TEST',now())`);
  for(const id of [owner,other])await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'forms_checkins',1,'granted','export-fixture')",[id]);
  // Sixty fictional records of ~600 bytes each: several parts at an 8 KiB test part size, well under the 16 MiB inline bound.
  const write=(who:string,payload:unknown)=>db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,'clinical_data','production-clinical','clinical_phi')",[who,org,'subject-'+who]);
    await tx.query("select clinical_core.write_owned_consumer_record('wellness_profiles',$1,0,$2,$3::jsonb,false,1)",[randomUUID(),randomUUID(),JSON.stringify(payload)]);
  });
  for(let i=0;i<60;i++)await write(owner,{index:i,note:'FICTIONAL '.repeat(50)});
  await write(other,{note:'OTHER OWNER FICTIONAL'});
},60000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
  // Each test starts without an open job and outside the hourly request limit; earlier tests' objects are irrelevant to it.
  await db.query("update clinical_private.owned_privacy_export_jobs set status='cancelled',cancelled_at=clock_timestamp(),ready_at=null,lease_until=null,version=version+1 where status in ('requested','running','ready')");
  await db.query("update clinical_private.owned_privacy_export_jobs set created_at=created_at-interval '2 hours'");
});
const drive=async(jobs:ReturnType<typeof jobsWith>,jobId:string,who=owner)=>{
  let view=await jobs.getPrivacyExportJob(context(who),{jobId});let passes=0;
  while(['requested','running'].includes(view.status)&&passes<200){view=await jobs.advancePrivacyExportJob(context(who),{jobId},20000,new AbortController().signal);passes++;}
  return {view,passes};
};

describe('large personal-storage export jobs (migration 93)',()=>{
  it('packages the snapshot in bounded passes into one encrypted object under the owner digest prefix, with counts that match the inline export exactly',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const requestId=randomUUID();
    const requested=await jobs.requestPrivacyExportJob(context(),{requestId});
    expect(requested).toMatchObject({status:'requested',recordCount:60,consentCount:1,exportedRecords:0,parts:0,replayed:false,coverage:{completeAccountExport:false}});
    expect(await jobs.requestPrivacyExportJob(context(),{requestId})).toMatchObject({jobId:requested.jobId,replayed:true});
    await expect(jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).rejects.toThrow('conflict');
    const {view,passes}=await drive(jobs,requested.jobId);
    expect(view).toMatchObject({status:'ready',exportedRecords:60,exportedConsents:1,objectDeleted:false});
    expect(view.parts).toBeGreaterThan(1);expect(passes).toBeGreaterThanOrEqual(view.parts);
    expect(f.uploads.size).toBe(0);
    const keys=[...f.objects.keys()];
    const objectKey=keys.find(k=>k.endsWith('.json'))!;
    expect(objectKey.startsWith(privacyExportPrefix(owner))).toBe(true);expect(objectKey).not.toContain(owner);
    // The staging object left no live version behind.
    expect([...(f.objects.get(objectKey+'.staging')?.values()??[])]).toEqual([]);
    const versions=[...f.objects.get(objectKey)!.values()];expect(versions).toHaveLength(1);
    const document=JSON.parse(Buffer.from(versions[0]).toString('utf8'));
    expect(document.contract).toBe('personal-storage-export-job/1');
    expect(document.manifest).toMatchObject({version:'personal-storage-export/1',recordCount:60,consentCount:1,coverage:{completeAccountExport:false}});
    expect(document.records).toHaveLength(60);expect(document.consents).toEqual([expect.objectContaining({scope:'forms_checkins',revision:1,status:'granted'})]);
    expect(new Set(document.records.map((r:{recordId:string})=>r.recordId)).size).toBe(60);
    expect(document.records.every((r:{payload:{note:string}})=>r.payload.note.startsWith('FICTIONAL'))).toBe(true);
    expect(JSON.stringify(document)).not.toContain('OTHER OWNER');
    expect(view.byteLength).toBe(versions[0].byteLength);
    // The snapshot row the job pinned agrees with the account's real row counts at that cut-off.
    const snapshot=(await db.query<{record_count:string;consent_count:string;n:string}>(`select e.record_count::text,e.consent_count::text,
      (select count(*)::text from clinical_core.owned_consumer_record_versions r where r.owner_id=e.owner_id and r.received_at<=e.as_of) n
      from clinical_private.owned_privacy_exports e join clinical_private.owned_privacy_export_jobs j on j.export_id=e.id where j.id=$1`,[requested.jobId])).rows[0];
    expect(snapshot).toEqual({record_count:'60',consent_count:'1',n:'60'});
  });
  it('issues a short-lived signed link for the exact ready version only to a freshly signed-in owner, never to another owner or a stale session',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await expect(jobs.issuePrivacyExportDownload(context(),{jobId:job},Date.now(),new AbortController().signal)).rejects.toThrow('conflict');
    await drive(jobs,job);
    await expect(jobs.issuePrivacyExportDownload(context(),{jobId:job},Date.now()-6*60_000,new AbortController().signal)).rejects.toThrow('owner_required');
    await expect(jobs.issuePrivacyExportDownload(context(other),{jobId:job},Date.now(),new AbortController().signal)).rejects.toThrow('owner_required');
    const issued=await jobs.issuePrivacyExportDownload(context(),{jobId:job},Date.now()-30_000,new AbortController().signal);
    expect(issued).toMatchObject({jobId:job,expiresInSeconds:300});
    expect(issued.url).toMatch(/^https:\/\//);expect(issued.url).toContain('X-Amz-Expires=300');expect(issued.url).not.toContain(owner);
    expect((await db.query("select count(*)::int n from clinical_audit.owned_privacy_export_events where owner_id=$1 and action='download.issued'",[owner])).rows[0]).toEqual({n:1});
  });
  it('cancels a running job, aborts the open upload, removes staging and object versions with verification, and refuses a second open job until then',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    const first=await jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal);
    expect(first.status).toBe('running');expect(first.parts).toBe(1);
    expect(f.uploads.size).toBe(1);
    const cancelled=await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    expect(cancelled.status).toBe('cancelled');
    await expect(jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal)).rejects.toThrow('conflict');
    const cleaned=await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    // Earlier tests' finished jobs are cleaned in the same owner pass; this job's open upload is the only one aborted.
    expect(cleaned.cleaned).toBeGreaterThanOrEqual(1);expect(cleaned.remaining).toBe(0);
    expect(f.uploads.size).toBe(0);expect(f.store.abortUpload).toHaveBeenCalledTimes(1);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({status:'cancelled',objectDeleted:true});
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:0,remaining:0});
    await expect(jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).rejects.toThrow('conflict');
  });
  it('expires a ready copy, refuses its download, deletes the object on the owner next cleanup, and resumes an interrupted pass from the recorded state',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    // A storage failure mid-pass records nothing and the job stays running for the next poll.
    vi.mocked(f.store.uploadPart).mockRejectedValueOnce(new Error('fictional network failure'));
    await expect(jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal)).rejects.toThrow('storage_unavailable');
    const stalled=await jobs.getPrivacyExportJob(context(),{jobId:job});
    expect(stalled).toMatchObject({status:'running',parts:0,exportedRecords:0});
    await db.query("update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1",[job]);
    const {view}=await drive(jobs,job);
    expect(view.status).toBe('ready');
    await db.query("update clinical_private.owned_privacy_export_jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[job]);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({status:'expired',readyAt:null,objectDeleted:false});
    await expect(jobs.issuePrivacyExportDownload(context(),{jobId:job},Date.now(),new AbortController().signal)).rejects.toThrow('conflict');
    const objectKey=[...f.objects.keys()].find(k=>k.endsWith('.json'))!;
    expect(f.objects.get(objectKey)!.size).toBe(1);
    const cleaned=await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    expect(cleaned.cleaned).toBeGreaterThanOrEqual(1);expect(cleaned.remaining).toBe(0);
    expect(f.objects.get(objectKey)!.size).toBe(0);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({status:'expired',objectDeleted:true});
    const audit=(await db.query<{action:string;n:number}>(`select e.action,count(*)::int n from clinical_audit.owned_privacy_export_events e
      join clinical_private.owned_privacy_export_jobs j on j.export_id=e.export_id where j.id=$1 group by e.action order by e.action`,[job])).rows;
    expect(Object.fromEntries(audit.map(r=>[r.action,r.n]))).toMatchObject({'job.requested':1,'job.completed':1,'job.expired':1,'object.deleted':1});
    expect(audit.find(r=>r.action==='job.pass')!.n).toBeGreaterThanOrEqual(2);
    expect(audit.find(r=>r.action==='records.read')!.n).toBeGreaterThanOrEqual(1);
  });
  it('never lets another owner read, advance, cancel or clean a job, and never accepts caller-chosen owners or prefixes',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    for(const attempt of [()=>jobs.getPrivacyExportJob(context(other),{jobId:job}),()=>jobs.advancePrivacyExportJob(context(other),{jobId:job},20000,new AbortController().signal),
      ()=>jobs.cancelPrivacyExportJob(context(other),{jobId:job})])await expect(attempt()).rejects.toThrow('owner_required');
    expect(await jobs.cleanupPrivacyExportJobs(context(other),new AbortController().signal)).toEqual({cleaned:0,remaining:0});
    await expect(db.query("select clinical_core.request_owned_privacy_export_job($1,'personal-exports/not-a-digest/')",[randomUUID()])).rejects.toThrow();
    await expect(jobs.requestPrivacyExportJob(context(),{requestId:randomUUID(),ownerId:other} as never)).rejects.toThrow('request_invalid');
    await expect(jobs.getPrivacyExportJob({...context(),identityPool:'workforce'},{jobId:job})).rejects.toThrow('owner_required');
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
  });
});
