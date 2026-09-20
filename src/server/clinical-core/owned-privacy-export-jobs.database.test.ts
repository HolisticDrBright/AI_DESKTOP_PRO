import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {createOwnedPrivacyExportJobs,createPrivacyExportRetention,privacyExportPrefix,type PrivacyExportStore,type PrivacyExportObjectStorage} from './owned-privacy-export-job';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase,type ClinicalCoreTransaction} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';

// Executable production SQL over fictional in-memory rows with a fictional object
// store. No bucket, hosted database, signed link or real account is involved.
const owner=randomUUID(),other=randomUUID(),operator=randomUUID(),unassigned=randomUUID(),reviewer=randomUUID(),org=randomUUID();
let db:PGlite;
const context=(who=owner):ProductionClinicalRequestContext=>({actorPersonId:who,organizationId:org,identityPool:'consumer',identitySubject:'subject-'+who,
  purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true});
const operatorContext=(who=operator):ProductionClinicalRequestContext=>({...context(who),identityPool:'workforce'});
// Replaces only the RDS transport: the same server-authored codes are classified the way rds-data-database does.
function classify(error:unknown){
  const message=error instanceof Error?error.message:'';
  if(/\b(privacy_export_job_state|privacy_export_job_busy|privacy_export_conflict)\b/.test(message))return new ClinicalCoreDatabaseRejection('conflict');
  if(/\b(privacy_export_job_refused|consumer_owner_required|privacy_operator_required|privacy_operator_assignment_required|request_context_refused|retention_service_release_required)\b/.test(message))return new ClinicalCoreDatabaseRejection('identity_refused');
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
  const checksums=new Map<string,string>(); // key+'\n'+version → the checksum S3 would return
  let versions=0;const version=()=>'v'+(++versions);
  const put=(key:string,bytes:Uint8Array,checksum:string)=>{const v=version();if(!objects.has(key))objects.set(key,new Map());objects.get(key)!.set(v,bytes);checksums.set(key+'\n'+v,checksum);return v;};
  // S3 semantics: a single PUT carries the full-object SHA-256; a multipart object carries the composite of its part digests with the part count.
  const fullChecksum=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('base64');
  const composite=(parts:Uint8Array[])=>createHash('sha256').update(Buffer.concat(parts.map(p=>createHash('sha256').update(p).digest()))).digest('base64')+'-'+parts.length;
  const store:PrivacyExportStore={
    createUpload:vi.fn(async(_s,key)=>{const uploadId='u-'+randomUUID();uploads.set(uploadId,{key,parts:new Map()});return {uploadId};}),
    uploadPart:vi.fn(async(_s,key,uploadId,partNumber,body,sha)=>{const u=uploads.get(uploadId);if(!u||u.key!==key)throw new Error('NoSuchUpload');
      if(createHash('sha256').update(body).digest('hex')!==sha)throw new Error('BadDigest');const etag='"'+createHash('md5').update(body).digest('hex')+'"';u.parts.set(partNumber,{bytes:body,etag});return {etag};}),
    completeUpload:vi.fn(async(_s,key,uploadId,parts)=>{const u=uploads.get(uploadId);if(!u||u.key!==key)throw new Error('NoSuchUpload');
      const ordered=parts.map((p:{partNumber:number;etag:string})=>{const stored=u.parts.get(p.partNumber);if(!stored||stored.etag!==p.etag)throw new Error('InvalidPart');return stored.bytes;});
      const bytes=Buffer.concat(ordered),checksum=composite(ordered);uploads.delete(uploadId);return {version:put(key,bytes,checksum),checksum};}),
    abortUpload:vi.fn(async(_s,_key,uploadId)=>{uploads.delete(uploadId);}),
    put:vi.fn(async(_s,key,body,sha)=>{if(createHash('sha256').update(body).digest('hex')!==sha)throw new Error('BadDigest');return {version:put(key,body,fullChecksum(body))};}),
    get:vi.fn(async(_s,key,v,max)=>{const b=objects.get(key)?.get(v);if(!b)throw new Error('NoSuchVersion');if(b.byteLength>max)throw new Error('too large');return b;}),
    head:vi.fn(async(_s,key,v,_signal,options)=>{const b=objects.get(key)?.get(v);
      return b?{exists:true,bytes:b.byteLength,encryption:'aws:kms',kmsKeyArn:storage.kmsKeyArn,...(options?.checksum?{checksum:checksums.get(key+'\n'+v)}:{})}:{exists:false};}),
    deleteVersion:vi.fn(async(_s,key,v)=>{objects.get(key)?.delete(v);}),
    signDownload:vi.fn(async(_s,key,v,seconds,name)=>`https://fictional-export-bucket.s3.us-east-2.amazonaws.com/${key}?versionId=${v}&X-Amz-Expires=${seconds}&name=${encodeURIComponent(name)}`),
    listUploads:vi.fn(async(_s,prefix)=>[...uploads.entries()].filter(([,u])=>u.key.startsWith(prefix)).map(([uploadId,u])=>({key:u.key,uploadId}))),
    listVersions:vi.fn(async(_s,prefix)=>[...objects.entries()].filter(([k])=>k.startsWith(prefix)).flatMap(([key,vs])=>[...vs.entries()].map(([version,b])=>({key,version,bytes:b.byteLength,deleteMarker:false})))),
  };
  return {store,objects,uploads,checksums};
}
const PRIVACY_EXPORT_TEST_LARGE_PART=64*1024;
const jobsWith=(store:PrivacyExportStore,partBytes=8192,now?:()=>number)=>createOwnedPrivacyExportJobs((c,work)=>adapter().runPrivacy(c,work),{store,storage,partBytes,...(now?{now}:{})});
// A clock that exhausts the pass budget after one page read, so passes end with a staging object.
const onePagePerPass=()=>{let t=1_700_000_000_000;return()=>{t+=15_000;return t;};};
// The operator path sets the request context the way privacy-operations does: no consumer adapter, the same transport shim.
const workforceRun=(c:ProductionClinicalRequestContext,work:(tx:ClinicalCoreTransaction)=>Promise<unknown>)=>database.transaction(async tx=>{
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[c.actorPersonId,c.organizationId,c.identityPool,c.identitySubject,c.purpose,c.environment,c.dataClassification]);
  return work(tx);
});
const retentionWith=(store:PrivacyExportStore,authority:'operator'|'retention_service'='operator')=>createPrivacyExportRetention(workforceRun as never,{store,storage},authority);
const retentionService=randomUUID(); // a workforce identity that a reviewed release row may name as the retention service (never seeded)
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000}));
  db=new PGlite({extensions:{pgcrypto}});for(const m of manifest.migrations)await db.exec(files[m.file]);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')",[org]);
  for(const [id,pool] of [[owner,'consumer'],[other,'consumer'],[operator,'workforce'],[unassigned,'workforce'],[reviewer,'workforce'],[retentionService,'workforce']]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[id,pool,'subject-'+id]);
  }
  await db.query(`insert into clinical_private.owned_privacy_operator_assignments(operator_id,owner_id,reviewed_by,evidence_sha256,approved_at,expires_at)
    values($1,$2,$3,$4,now()-interval '1 day',now()+interval '1 day')`,[operator,owner,reviewer,'a'.repeat(64)]);
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
  // Earlier tests' finished jobs are past their settlement window and backoff here (their fictional stores are gone); each test states its own cases.
  await db.query("update clinical_private.owned_privacy_export_jobs set lease_until=null,next_cleanup_at=null where status in ('cancelled','failed','expired')");
});
const drive=async(jobs:ReturnType<typeof jobsWith>,jobId:string,who=owner)=>{
  let view=await jobs.getPrivacyExportJob(context(who),{jobId});let passes=0;
  while(['requested','running'].includes(view.status)&&passes<200){view=await jobs.advancePrivacyExportJob(context(who),{jobId},20000,new AbortController().signal);passes++;}
  return {view,passes};
};

describe('Codex migration95 adversarial boundaries',()=>{
  it('does not recover a same-length object with a checksum unrelated to the recorded parts',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    let partLengths:number[]=[];
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    const realComplete=vi.mocked(f.store.completeUpload).getMockImplementation()!;
    vi.mocked(f.store.completeUpload).mockImplementationOnce(async(...args)=>{
      partLengths=args[3].map(p=>f.uploads.get(args[2])!.parts.get(p.partNumber)!.bytes.length);
      await realComplete(...args);throw new Error('fictional lost completion response');
    });
    await expect(drive(jobs,job)).rejects.toThrow('storage_unavailable');
    const key=[...f.objects.keys()].find(k=>k.endsWith('.json'))!;
    const [version,bytes]=[...f.objects.get(key)!.entries()][0];
    const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
    f.objects.get(key)!.set(version,changed);
    let offset=0;
    const partDigests=partLengths.map(n=>{const digest=createHash('sha256').update(changed.subarray(offset,offset+n)).digest();offset+=n;return digest;});
    const changedComposite=createHash('sha256').update(Buffer.concat(partDigests)).digest('base64')+'-'+partLengths.length;
    const realHead=vi.mocked(f.store.head).getMockImplementation()!;
    vi.mocked(f.store.head).mockImplementation(async(...args)=>{
      const h=await realHead(...args);
      return h?.exists?{...h,checksum:changedComposite}:h;
    });
    await db.query('update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1',[job]);
    expect((await drive(jobs,job)).view).toMatchObject({status:'failed',failureCode:'object_mismatch'});
  });
  it('does not certify removal before a cancelled in-flight create-upload operation has finished',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    const realCreate=vi.mocked(f.store.createUpload).getMockImplementation()!;
    vi.mocked(f.store.createUpload).mockImplementationOnce(async(...args)=>{
      // Storage request is in flight. Cancellation and both empty listings happen before it lands.
      await jobs.cancelPrivacyExportJob(context(),{jobId:job});
      await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
      return realCreate(...args);
    });
    await expect(jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal)).rejects.toThrow();
    expect(f.uploads.size).toBe(1);
    await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    const current=await jobs.getPrivacyExportJob(context(),{jobId:job});
    expect(current.objectDeleted&&f.uploads.size>0).toBe(false);
  });
});

describe('Codex recheck export failure boundaries',()=>{
  it('durably expires an unfinished job so its open upload becomes cleanup eligible',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal);
    await db.query("update clinical_private.owned_privacy_export_jobs set expires_at=clock_timestamp()-interval '1 second',lease_until=null where id=$1",[job]);
    await expect(jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal)).rejects.toThrow('conflict');
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({status:'failed',failureCode:'deadline_passed'});
    await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    expect(f.uploads.size).toBe(0);
  });
  it('does not certify deletion when aborting an open multipart upload is denied',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal);
    expect(f.uploads.size).toBe(1);
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    vi.mocked(f.store.abortUpload).mockRejectedValue(new Error('AccessDenied'));
    await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    expect(f.uploads.size).toBe(1);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({objectDeleted:false});
  });
  it('cleans the upload created before a failed first part, including after retry and cancellation',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    vi.mocked(f.store.uploadPart).mockRejectedValueOnce(new Error('fictional network failure'));
    await expect(jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal)).rejects.toThrow('storage_unavailable');
    await db.query('update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1',[job]);
    await drive(jobs,job);
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    expect(f.uploads.size).toBe(0);
  });
  it('recovers the completed object when the database completion receipt is interrupted',async()=>{
    const f=fakeStore();let failCompletion=true;
    const jobs=createOwnedPrivacyExportJobs((c,work)=>adapter().runPrivacy(c,tx=>work({
      ...tx,query:async(sql:string,args?:unknown[])=>{
        if(failCompletion&&sql.includes('complete_owned_privacy_export_job')){failCompletion=false;throw new Error('fictional database interruption');}
        return tx.query(sql,args);
      },
    } as ClinicalCoreTransaction)),{store:f.store,storage,partBytes:8192});
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await expect(drive(jobs,job)).rejects.toThrow('storage_unavailable');
    expect([...f.objects.keys()].some(k=>k.endsWith('.json'))).toBe(true);
    await db.query('update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1',[job]);
    await expect(drive(jobs,job)).resolves.toMatchObject({view:{status:'ready'}});
  });
});

describe('export failure matrix: store refusals, lost responses and ambiguous completion',()=>{
  it('keeps a denied or timed-out abort pending and certifies only once the store shows nothing under the key',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    const timeout=Object.assign(new Error('TimeoutError'),{name:'TimeoutError'});
    vi.mocked(f.store.abortUpload).mockRejectedValueOnce(new Error('AccessDenied')).mockRejectedValueOnce(timeout);
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toMatchObject({remaining:1});
    // Each failure defers the job with backoff (migration 97); the backoff is aged here as the clock would age it.
    await db.query('update clinical_private.owned_privacy_export_jobs set next_cleanup_at=null where id=$1',[job]);
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toMatchObject({remaining:1});
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({status:'cancelled',objectDeleted:false});
    expect(f.uploads.size).toBe(1);
    await db.query('update clinical_private.owned_privacy_export_jobs set next_cleanup_at=null where id=$1',[job]);
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(f.uploads.size).toBe(0);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({objectDeleted:true});
  });
  it('does not certify while an abort that returned without error still leaves the upload listed (parts landing in flight)',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    vi.mocked(f.store.abortUpload).mockResolvedValueOnce(undefined);
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:0,remaining:1});
    expect(f.uploads.size).toBe(1);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({objectDeleted:false});
    await db.query('update clinical_private.owned_privacy_export_jobs set next_cleanup_at=null where id=$1',[job]);
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(f.uploads.size).toBe(0);
  });
  it('certifies a job whose recorded upload is already gone without calling abort, and a never-started job without any store call',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    f.uploads.clear(); // removed outside the job, e.g. by a bucket lifecycle rule
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(f.store.abortUpload).not.toHaveBeenCalled();
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({status:'cancelled',objectDeleted:true});
    await db.query("update clinical_private.owned_privacy_export_jobs set created_at=created_at-interval '2 hours'");
    const idle=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await db.query("update clinical_private.owned_privacy_export_jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[idle]);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:idle})).toMatchObject({status:'failed',failureCode:'deadline_passed'});
    vi.mocked(f.store.deleteVersion).mockClear();vi.mocked(f.store.abortUpload).mockClear();
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(f.store.deleteVersion).not.toHaveBeenCalled();expect(f.store.abortUpload).not.toHaveBeenCalled();
    expect(await jobs.getPrivacyExportJob(context(),{jobId:idle})).toMatchObject({status:'failed',objectDeleted:true});
  });
  it('records the upload id before the first part, and finds an upload whose creation response was lost',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    const real=vi.mocked(f.store.createUpload).getMockImplementation()!;
    vi.mocked(f.store.createUpload).mockImplementationOnce(async(s,key,signal)=>{await real(s,key,signal);throw new Error('fictional lost response');});
    await expect(jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal)).rejects.toThrow('storage_unavailable');
    expect(f.uploads.size).toBe(1);
    expect((await db.query<{upload_id:string|null}>('select upload_id from clinical_private.owned_privacy_export_jobs where id=$1',[job])).rows[0].upload_id).toBeNull();
    await db.query('update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1',[job]);
    // A part failure after creation leaves the id on record, so the retry reuses that upload.
    vi.mocked(f.store.uploadPart).mockRejectedValueOnce(new Error('fictional network failure'));
    await expect(jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal)).rejects.toThrow('storage_unavailable');
    const recorded=(await db.query<{upload_id:string|null}>('select upload_id from clinical_private.owned_privacy_export_jobs where id=$1',[job])).rows[0].upload_id;
    expect(recorded).toMatch(/^u-/);expect(f.uploads.size).toBe(2);
    await db.query('update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1',[job]);
    const {view}=await drive(jobs,job);
    expect(view.status).toBe('ready');expect(f.store.createUpload).toHaveBeenCalledTimes(2);
    expect(f.uploads.size).toBe(1); // the orphan from the lost response
    await db.query("update clinical_private.owned_privacy_export_jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[job]);
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(f.uploads.size).toBe(0);expect([...f.objects.values()].every(v=>v.size===0)).toBe(true);
  });
  it('removes a superseded staging version that failed to delete during the pass, once the job is finished',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store,PRIVACY_EXPORT_TEST_LARGE_PART,onePagePerPass());
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    vi.mocked(f.store.deleteVersion).mockRejectedValueOnce(new Error('fictional delete failure'));
    const {view,passes}=await drive(jobs,job);
    expect(view.status).toBe('ready');expect(passes).toBeGreaterThanOrEqual(2);expect(f.store.put).toHaveBeenCalled();
    const key=[...f.objects.keys()].find(k=>k.endsWith('.json'))!;
    expect(f.objects.get(key+'.staging')!.size).toBeGreaterThanOrEqual(1);
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(f.objects.get(key+'.staging')!.size).toBe(0);expect(f.objects.get(key)!.size).toBe(0);
  });
  it('recovers when the completion response is lost, and fails closed on a mismatched or ambiguous object instead of resending parts',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    const real=vi.mocked(f.store.completeUpload).getMockImplementation()!;
    vi.mocked(f.store.completeUpload).mockImplementationOnce(async(...a)=>{await real(...a);throw new Error('fictional lost response');});
    await expect(drive(jobs,job)).rejects.toThrow('storage_unavailable');
    await db.query('update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1',[job]);
    vi.mocked(f.store.uploadPart).mockClear();
    const {view}=await drive(jobs,job);
    expect(view.status).toBe('ready');expect(f.store.uploadPart).not.toHaveBeenCalled();
    const key=[...f.objects.keys()].find(k=>k.endsWith('.json'))!;
    expect(f.objects.get(key)!.size).toBe(1);
    // Ambiguity: a second full version under the job's key fails the job; cleanup removes both.
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    await db.query("update clinical_private.owned_privacy_export_jobs set created_at=created_at-interval '2 hours'");
    const second=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    vi.mocked(f.store.completeUpload).mockImplementationOnce(async(...a)=>{const r=await real(...a);const k=a[1] as string;f.objects.get(k)!.set('v-stray',Buffer.from('{}'));return r;});
    vi.mocked(f.store.completeUpload).mockImplementationOnce(async()=>{throw new Error('fictional interruption');});
    let failedOnce=false;
    const guarded=createOwnedPrivacyExportJobs((c,work)=>adapter().runPrivacy(c,tx=>work({...tx,query:async(sql:string,args?:unknown[])=>{
      if(!failedOnce&&sql.includes('complete_owned_privacy_export_job')){failedOnce=true;throw new Error('fictional database interruption');}return tx.query(sql,args);}} as ClinicalCoreTransaction)),{store:f.store,storage,partBytes:8192});
    await expect(drive(guarded,second)).rejects.toThrow('storage_unavailable');
    await db.query('update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1',[second]);
    const failed=await drive(guarded,second);
    expect(failed.view).toMatchObject({status:'failed',failureCode:'object_ambiguous'});
    const key2=[...f.objects.keys()].filter(k=>k.endsWith('.json')).find(k=>k!==key)!;
    expect(f.objects.get(key2)!.size).toBe(2);
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(f.objects.get(key2)!.size).toBe(0);
  });
  it('lets exactly one of two concurrent polls run a pass; the other sees a conflict and nothing is written twice',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    const results=await Promise.allSettled([1,2].map(()=>jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:expect.objectContaining({message:'conflict'})});
    expect(f.store.uploadPart).toHaveBeenCalledTimes(1);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({status:'running',parts:1});
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
  });
});

describe('assigned-operator retention pass (migration 95)',()=>{
  it('removes finished and deadline-passed export objects of assigned owners with listing proof, audits the operator, and stays pending when the store refuses',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store),retention=retentionWith(f.store);
    // Earlier tests' finished jobs (their fictional stores are gone) are certified first so this pass is about one job.
    await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    const abandoned=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:abandoned},20000,new AbortController().signal);
    await db.query("update clinical_private.owned_privacy_export_jobs set expires_at=clock_timestamp()-interval '1 second',lease_until=null where id=$1",[abandoned]);
    expect(f.uploads.size).toBe(1);
    // A still-running job the owner never came back for is failed by the operator's listing and its upload removed.
    vi.mocked(f.store.abortUpload).mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await retention.cleanupAssignedPrivacyExports(operatorContext(),10,new AbortController().signal)).toMatchObject({cleaned:0,remaining:1,deferred:1,items:[{jobId:abandoned,status:'failed',outcome:'deferred'}]});
    expect(f.uploads.size).toBe(1);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:abandoned})).toMatchObject({status:'failed',failureCode:'deadline_passed',objectDeleted:false});
    await db.query('update clinical_private.owned_privacy_export_jobs set next_cleanup_at=null where id=$1',[abandoned]);
    expect(await retention.cleanupAssignedPrivacyExports(operatorContext(),10,new AbortController().signal)).toMatchObject({cleaned:1,remaining:0,items:[{jobId:abandoned,outcome:'deleted'}]});
    expect(f.uploads.size).toBe(0);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:abandoned})).toMatchObject({objectDeleted:true});
    const audit=(await db.query<{action:string;operator_id:string|null}>(`select e.action,e.operator_id from clinical_audit.owned_privacy_export_events e
      join clinical_private.owned_privacy_export_jobs j on j.export_id=e.export_id where j.id=$1 and e.action in ('job.failed','object.deleted') order by e.recorded_at`,[abandoned])).rows;
    expect(audit).toEqual([{action:'job.failed',operator_id:operator},{action:'object.deleted',operator_id:operator}]);
  });
  it('includes a ready copy past expiry after the owner account closed, and never touches unassigned owners or accepts consumers',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store),retention=retentionWith(f.store);
    await db.query("update clinical_private.owned_privacy_export_jobs set created_at=created_at-interval '2 hours'");
    const ready=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    expect((await drive(jobs,ready)).view.status).toBe('ready');
    const foreign=(await jobs.requestPrivacyExportJob(context(other),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(other),{jobId:foreign},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(other),{jobId:foreign});
    await db.query("update clinical_private.owned_privacy_export_jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[ready]);
    await db.query("update clinical_core.persons set status='disabled' where id=$1",[owner]);
    try{
      await expect(jobs.getPrivacyExportJob(context(),{jobId:ready})).rejects.toThrow('owner_required');
      const key=[...f.objects.keys()].find(k=>k.endsWith('.json')&&k.startsWith(privacyExportPrefix(owner)))!;
      expect(f.objects.get(key)!.size).toBe(1);
      const result=await retention.cleanupAssignedPrivacyExports(operatorContext(),10,new AbortController().signal);
      expect(result).toMatchObject({cleaned:1,remaining:0,items:[{jobId:ready,status:'expired',outcome:'deleted'}]});
      expect(f.objects.get(key)!.size).toBe(0);
      // The other owner's cancelled copy (one fictional record completes in a single pass) is not this operator's to touch.
      const foreignKey=[...f.objects.keys()].find(k=>k.endsWith('.json')&&k.startsWith(privacyExportPrefix(other)))!;
      expect(f.objects.get(foreignKey)!.size).toBe(1);
      expect((await db.query<{status:string;deleted:boolean}>('select status,object_deleted_at is not null deleted from clinical_private.owned_privacy_export_jobs where id=$1',[ready])).rows[0]).toEqual({status:'expired',deleted:true});
      expect(await retention.cleanupAssignedPrivacyExports(operatorContext(unassigned),10,new AbortController().signal)).toEqual({cleaned:0,remaining:0,deferred:0,items:[]});
      await expect(retention.cleanupAssignedPrivacyExports(context(),10,new AbortController().signal)).rejects.toThrow('owner_required');
      await expect(retention.cleanupAssignedPrivacyExports(operatorContext(),11,new AbortController().signal)).rejects.toThrow('request_invalid');
      await expect(db.query('select clinical_private.record_privacy_export_object_deleted_by_operator($1,$2,1)',[other,foreign])).rejects.toThrow();
    }finally{
      await db.query("update clinical_core.persons set status='active' where id=$1",[owner]);
      expect(await jobs.cleanupPrivacyExportJobs(context(other),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    }
  });
});

describe('integrity binding and settlement (migration 96)',()=>{
  const lostCompletion=async(f:ReturnType<typeof fakeStore>,jobs:ReturnType<typeof jobsWith>,who=owner)=>{
    const job=(await jobs.requestPrivacyExportJob(context(who),{requestId:randomUUID()})).jobId;
    const real=vi.mocked(f.store.completeUpload).getMockImplementation()!;
    vi.mocked(f.store.completeUpload).mockImplementationOnce(async(...a)=>{await real(...a);throw new Error('fictional lost completion response');});
    await expect(drive(jobs,job,who)).rejects.toThrow('storage_unavailable');
    await db.query('update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1',[job]);
    const key=[...f.objects.keys()].find(k=>k.endsWith('.json'))!;
    return {job,key,version:[...f.objects.get(key)!.keys()][0]};
  };
  it('recovers only the object whose composite checksum is the one the recorded part digests fix; missing, malformed and reordered checksums fail closed',async()=>{
    for(const [label,tamper] of [
      ['missing',()=>undefined as string|undefined],
      ['malformed',(c:string|undefined)=>c!.replace(/-\d+$/,'')],
      ['part count',(c:string|undefined)=>c!.replace(/-(\d+)$/,(_m,n)=>'-'+(Number(n)+1))],
    ] as [string,(c:string|undefined)=>string|undefined][]){
      const f=fakeStore(),jobs=jobsWith(f.store);
      const {job,key,version}=await lostCompletion(f,jobs);
      const good=f.checksums.get(key+'\n'+version)!;
      f.checksums.set(key+'\n'+version,tamper(good) as string);
      expect((await drive(jobs,job)).view,label).toMatchObject({status:'failed',failureCode:'object_mismatch'});
      await db.query("update clinical_private.owned_privacy_export_jobs set created_at=created_at-interval '2 hours'");
    }
    // Reordered parts: the same bytes in a different part order give a different composite; the recorded order is the only acceptable one.
    const f=fakeStore(),jobs=jobsWith(f.store);
    const {job,key,version}=await lostCompletion(f,jobs);
    const parts=(await db.query<{p:string[]}>('select part_sha256s p from clinical_private.owned_privacy_export_jobs where id=$1',[job])).rows[0].p;
    expect(parts.length).toBeGreaterThan(1);
    const reordered=[parts[1],parts[0],...parts.slice(2)];
    f.checksums.set(key+'\n'+version,createHash('sha256').update(Buffer.concat(reordered.map(h=>Buffer.from(h,'hex')))).digest('base64')+'-'+parts.length);
    expect((await drive(jobs,job)).view).toMatchObject({status:'failed',failureCode:'object_mismatch'});
    // Correct recovery (the other fictional owner, so this owner's download audit count stays that of the download test), then the
    // download HEAD must still carry that exact checksum.
    const g=fakeStore(),good=jobsWith(g.store);
    const ok=await lostCompletion(g,good,other);
    const ready=(await drive(good,ok.job,other)).view;
    expect(ready).toMatchObject({status:'ready',objectChecksum:g.checksums.get(ok.key+'\n'+ok.version)});
    expect(ready.objectChecksum).toMatch(/^[A-Za-z0-9+/]{43}=-\d+$/);
    await expect(good.issuePrivacyExportDownload(context(other),{jobId:ok.job},Date.now(),new AbortController().signal)).resolves.toMatchObject({objectChecksum:ready.objectChecksum});
    g.checksums.set(ok.key+'\n'+ok.version,'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=-1');
    await expect(good.issuePrivacyExportDownload(context(other),{jobId:ok.job},Date.now(),new AbortController().signal)).rejects.toThrow('storage_unavailable');
    await good.cancelPrivacyExportJob(context(other),{jobId:ok.job});
    expect(await good.cleanupPrivacyExportJobs(context(other),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
  });
  it('fails a completed upload whose returned checksum differs from the recorded parts instead of marking it ready',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    const real=vi.mocked(f.store.completeUpload).getMockImplementation()!;
    vi.mocked(f.store.completeUpload).mockImplementationOnce(async(...a)=>({...(await real(...a)),checksum:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=-1'}));
    expect((await drive(jobs,job)).view).toMatchObject({status:'failed',failureCode:'object_mismatch'});
    const cleaned=await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    expect(cleaned.cleaned).toBeGreaterThanOrEqual(1);expect(cleaned.remaining).toBe(0);
    expect([...f.objects.values()].every(v=>v.size===0)).toBe(true);
  });
  it('keeps a cancelled or expired job pending while a pass may still be writing (staging put, part, completion), then removes what landed late',async()=>{
    for(const [label,method,finish] of [
      ['staging put','put',(jobs:ReturnType<typeof jobsWith>,job:string)=>jobs.cancelPrivacyExportJob(context(),{jobId:job})],
      ['upload part','uploadPart',(jobs:ReturnType<typeof jobsWith>,job:string)=>jobs.cancelPrivacyExportJob(context(),{jobId:job})],
      ['completion','completeUpload',async(_jobs:ReturnType<typeof jobsWith>,job:string)=>{await db.query("update clinical_private.owned_privacy_export_jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[job]);}],
    ] as [string,'put'|'uploadPart'|'completeUpload',(jobs:ReturnType<typeof jobsWith>,job:string)=>Promise<unknown>][]){
      const f=fakeStore(),jobs=jobsWith(f.store,method==='put'?PRIVACY_EXPORT_TEST_LARGE_PART:8192,method==='put'?onePagePerPass():undefined);
      const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
      const real=vi.mocked(f.store[method]).getMockImplementation()! as (...a:unknown[])=>Promise<unknown>;
      vi.mocked(f.store[method] as unknown as (...a:unknown[])=>Promise<unknown>).mockImplementationOnce(async(...a:unknown[])=>{
        await finish(jobs,job);
        expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal),label).toEqual({cleaned:0,remaining:1});
        return real(...a);
      });
      await expect(drive(jobs,job),label).rejects.toThrow(/conflict|storage_unavailable/);
      const landed=[...f.objects.values()].some(v=>v.size>0)||f.uploads.size>0;
      expect(landed,label).toBe(true);
      // Still inside the settlement window: honest pending, never a certificate beside a surviving object.
      expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal),label).toEqual({cleaned:0,remaining:1});
      expect(await jobs.getPrivacyExportJob(context(),{jobId:job}),label).toMatchObject({objectDeleted:false});
      // The window passes (the lease is aged, as the clock would): the late artefact is found by listing and removed before certification.
      await db.query("update clinical_private.owned_privacy_export_jobs set lease_until=clock_timestamp()-interval '61 seconds' where id=$1",[job]);
      expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal),label).toEqual({cleaned:1,remaining:0});
      expect(f.uploads.size,label).toBe(0);expect([...f.objects.values()].every(v=>v.size===0),label).toBe(true);
      expect(await jobs.getPrivacyExportJob(context(),{jobId:job}),label).toMatchObject({objectDeleted:true});
      await db.query("update clinical_private.owned_privacy_export_jobs set created_at=created_at-interval '2 hours'");
    }
  });
  it('applies the same settlement to the operator pass and refuses certification of an unsettled job at the SQL boundary',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store),retention=retentionWith(f.store);
    await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    vi.mocked(f.store.uploadPart).mockRejectedValueOnce(new Error('fictional network failure'));
    await expect(jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal)).rejects.toThrow('storage_unavailable');
    await jobs.cancelPrivacyExportJob(context(),{jobId:job}); // lease kept: the failed pass may still have a request in flight
    expect(await retention.cleanupAssignedPrivacyExports(operatorContext(),10,new AbortController().signal)).toMatchObject({cleaned:0,remaining:1,items:[{jobId:job,outcome:'pending'}]});
    const version=(await db.query<{version:string}>('select version::text from clinical_private.owned_privacy_export_jobs where id=$1',[job])).rows[0].version;
    await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'consent_management','production-clinical','clinical_phi')",[operator,org,'subject-'+operator]);
      await tx.query('select clinical_private.record_privacy_export_object_deleted_by_operator($1,$2,$3::bigint)',[owner,job,version]);})).rejects.toThrow('privacy_export_job_state');
    await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,'consent_management','production-clinical','clinical_phi')",[owner,org,'subject-'+owner]);
      await tx.query('select clinical_core.record_owned_privacy_export_object_deleted($1,$2::bigint)',[job,version]);})).rejects.toThrow('privacy_export_job_state');
    expect(f.uploads.size).toBe(1);
    await db.query("update clinical_private.owned_privacy_export_jobs set lease_until=clock_timestamp()-interval '61 seconds' where id=$1",[job]);
    expect(await retention.cleanupAssignedPrivacyExports(operatorContext(),10,new AbortController().signal)).toMatchObject({cleaned:1,remaining:0});
    expect(f.uploads.size).toBe(0);
  });
});

describe('settlement qualification and operated retention (migration 97)',()=>{
  const age=(job:string,seconds:number)=>db.query("update clinical_private.owned_privacy_export_jobs set lease_until=clock_timestamp()-make_interval(secs=>$2) where id=$1",[job,seconds]);
  const certifiedAgo=(job:string,seconds:number)=>db.query("update clinical_private.owned_privacy_export_jobs set object_deleted_at=clock_timestamp()-make_interval(secs=>$2),reconciled_at=null where id=$1",[job,seconds]);
  it('a write that lands after the settlement window and after the certificate is found by reconciliation, reopens the obligation, and is removed before the certificate is restored',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({objectDeleted:true,retention:'removal_recorded'});
    // The certificate exists. A request that outlived every bound lands now: the fictional store gains an upload under the job's key.
    const key=[...f.objects.keys()].find(k=>k.endsWith('.json'))??(await db.query<{k:string}>('select object_key k from clinical_private.owned_privacy_export_jobs where id=$1',[job])).rows[0].k;
    f.uploads.set('u-late',{key,parts:new Map()});
    // Not yet due: reconciliation waits for the settlement window after the certificate.
    expect(await jobs.reconcilePrivacyExportJobs(context(),new AbortController().signal)).toEqual({confirmed:0,reopened:0,pending:0});
    await certifiedAgo(job,61);
    expect(await jobs.reconcilePrivacyExportJobs(context(),new AbortController().signal)).toEqual({confirmed:0,reopened:1,pending:0});
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({objectDeleted:false,retention:'cleanup_pending'});
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(f.uploads.size).toBe(0);
    await certifiedAgo(job,61);
    expect(await jobs.reconcilePrivacyExportJobs(context(),new AbortController().signal)).toEqual({confirmed:1,reopened:0,pending:0});
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({objectDeleted:true,retention:'removal_verified'});
    const audit=(await db.query<{action:string;n:number}>(`select e.action,count(*)::int n from clinical_audit.owned_privacy_export_events e
      join clinical_private.owned_privacy_export_jobs j on j.export_id=e.export_id where j.id=$1 group by e.action`,[job])).rows;
    expect(Object.fromEntries(audit.map(r=>[r.action,r.n]))).toMatchObject({'object.deleted':2,'object.reappeared':1,'object.reconciled':1});
  });
  it('process loss mid-request (a storage call that never returns) leaves a settling job; nothing is certified until the lease has aged, then the late artefact is removed',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    const real=vi.mocked(f.store.uploadPart).getMockImplementation()!;
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
    vi.mocked(f.store.uploadPart).mockImplementationOnce((...a)=>new Promise((resolve,reject)=>{
      (a[6] as AbortSignal).addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})));
      void gate.then(()=>real(...a).then(resolve,reject)); // the request still lands after the caller gave up
    }));
    const controller=new AbortController();
    const pass=jobs.advancePrivacyExportJob(context(),{jobId:job},20000,controller.signal);
    await new Promise(r=>setTimeout(r,20));
    controller.abort(); // the process is gone from the caller's point of view; the request may still land
    await expect(pass).rejects.toThrow('storage_unavailable');
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:0,remaining:1});
    release();await new Promise(r=>setTimeout(r,20));
    expect(f.uploads.size).toBe(1);
    expect(await jobs.getPrivacyExportJob(context(),{jobId:job})).toMatchObject({objectDeleted:false,retention:'cleanup_pending'});
    await age(job,61);
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(f.uploads.size).toBe(0);
  });
  it('concurrent owner and operator cleanup of the same job certifies exactly once and leaves nothing behind',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store),retention=retentionWith(f.store);
    await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    const [ownerResult,operatorResult]=await Promise.all([jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal),retention.cleanupAssignedPrivacyExports(operatorContext(),10,new AbortController().signal)]);
    expect(ownerResult.cleaned+operatorResult.cleaned).toBe(1);
    expect(f.uploads.size).toBe(0);
    const row=(await db.query<{deleted:boolean;n:number}>(`select j.object_deleted_at is not null deleted,(select count(*)::int from clinical_audit.owned_privacy_export_events e where e.export_id=j.export_id and e.action='object.deleted') n
      from clinical_private.owned_privacy_export_jobs j where j.id=$1`,[job])).rows[0];
    expect(row).toEqual({deleted:true,n:1});
  });
  it('a failing job backs off with exponential deferral and does not starve another owner job in the same pass; the deferral is audited',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const stuck=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:stuck},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(),{jobId:stuck});
    await db.query("update clinical_private.owned_privacy_export_jobs set created_at=created_at-interval '2 hours'");
    const fine=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:fine},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(),{jobId:fine});
    const stuckKey=(await db.query<{k:string}>('select object_key k from clinical_private.owned_privacy_export_jobs where id=$1',[stuck])).rows[0].k;
    const stuckUpload=[...f.uploads.entries()].find(([,u])=>u.key===stuckKey)![0];
    vi.mocked(f.store.abortUpload).mockImplementation(async(_s,_key,uploadId)=>{if(uploadId===stuckUpload)throw new Error('AccessDenied');f.uploads.delete(uploadId);});
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:1});
    const after=(await db.query<{attempts:number;next:string|null;err:string|null}>('select cleanup_attempts attempts,next_cleanup_at::text next,last_cleanup_error err from clinical_private.owned_privacy_export_jobs where id=$1',[stuck])).rows[0];
    expect(after.attempts).toBe(1);expect(after.next).not.toBeNull();expect(after.err).toBe('storage_failure');
    // Deferred: still counted as remaining, but no store work is done for it until it is due.
    vi.mocked(f.store.listUploads).mockClear();
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:0,remaining:1});
    expect(f.store.listUploads).not.toHaveBeenCalled();
    // Due again (as time would make it), still failing: attempts grow and the wait doubles.
    await db.query('update clinical_private.owned_privacy_export_jobs set next_cleanup_at=clock_timestamp() where id=$1',[stuck]);
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:0,remaining:1});
    const again=(await db.query<{attempts:number;wait:number}>("select cleanup_attempts attempts,extract(epoch from next_cleanup_at-clock_timestamp())::int wait from clinical_private.owned_privacy_export_jobs where id=$1",[stuck])).rows[0];
    expect(again.attempts).toBe(2);expect(again.wait).toBeGreaterThan(100);expect(again.wait).toBeLessThanOrEqual(120); // 1 min, then 2 min, doubling to a 6 h cap
    expect((await db.query<{n:number}>(`select count(*)::int n from clinical_audit.owned_privacy_export_events e join clinical_private.owned_privacy_export_jobs j on j.export_id=e.export_id where j.id=$1 and e.action='cleanup.deferred'`,[stuck])).rows[0].n).toBe(2);
    // The store recovers: the due job is cleaned and the deferral state cleared.
    vi.mocked(f.store.abortUpload).mockImplementation(async(_s,_key,uploadId)=>{f.uploads.delete(uploadId);});
    await db.query('update clinical_private.owned_privacy_export_jobs set next_cleanup_at=clock_timestamp() where id=$1',[stuck]);
    expect(await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect((await db.query<{next:string|null;err:string|null}>('select next_cleanup_at::text next,last_cleanup_error err from clinical_private.owned_privacy_export_jobs where id=$1',[stuck])).rows[0]).toEqual({next:null,err:null});
  });
  it('the operator backlog counts states for assigned owners only and reports the oldest pending age; operator reconciliation reopens and re-certifies',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store),retention=retentionWith(f.store);
    await db.query("update clinical_private.owned_privacy_export_jobs set next_cleanup_at=null where owner_id=$1",[owner]); // earlier tests' backoffs have elapsed
    await jobs.cleanupPrivacyExportJobs(context(),new AbortController().signal);await jobs.reconcilePrivacyExportJobs(context(),new AbortController().signal);
    await db.query("update clinical_private.owned_privacy_export_jobs set reconciled_at=clock_timestamp() where owner_id=$1 and object_deleted_at is not null",[owner]);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(),{jobId:job},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(),{jobId:job});
    await db.query("update clinical_private.owned_privacy_export_jobs set finished_at=clock_timestamp()-interval '2 hours' where id=$1",[job]);
    const before=await retention.privacyExportBacklog(operatorContext());
    expect(before).toMatchObject({scope:'assigned_owners',cleanupPending:1,settling:0,deferred:0,retainedUnderHold:0,removalRecorded:0});
    expect(before.oldestOverdueSeconds).toBeGreaterThanOrEqual(7190);expect(before.oldestPendingSince).not.toBeNull();
    expect(await retention.cleanupAssignedPrivacyExports(operatorContext(),10,new AbortController().signal)).toMatchObject({cleaned:1,remaining:0,deferred:0});
    const key=(await db.query<{k:string}>('select object_key k from clinical_private.owned_privacy_export_jobs where id=$1',[job])).rows[0].k;
    f.objects.set(key,new Map([['v-late',Buffer.from('{}')]]));
    await certifiedAgo(job,61);
    expect(await retention.privacyExportBacklog(operatorContext())).toMatchObject({removalRecorded:1,reconcileDue:1,cleanupPending:0});
    expect(await retention.reconcilePrivacyExports(operatorContext(),10,new AbortController().signal)).toMatchObject({confirmed:0,reopened:1,pending:0,items:[{jobId:job,outcome:'reopened'}]});
    const reopened=await retention.privacyExportBacklog(operatorContext());
    expect(reopened).toMatchObject({cleanupPending:1,removalRecorded:0});expect(reopened.reopened).toBe(before.reopened+1);
    expect(await retention.cleanupAssignedPrivacyExports(operatorContext(),10,new AbortController().signal)).toMatchObject({cleaned:1});
    expect(f.objects.get(key)!.size).toBe(0);
    expect(await retentionWith(f.store).privacyExportBacklog(operatorContext(unassigned))).toMatchObject({scope:'assigned_owners',cleanupPending:0,removalRecorded:0,oldestOverdueSeconds:0,oldestPendingSince:null});
    await expect(retention.privacyExportBacklog(context())).rejects.toThrow('owner_required');
  });
  it('the retention service sweep is refused until a reviewed release names the identity, then covers every owner without an assignment, and is refused again once revoked',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store),sweep=retentionWith(f.store,'retention_service');
    const serviceContext=operatorContext(retentionService);
    for(const attempt of [()=>sweep.cleanupAssignedPrivacyExports(serviceContext,100,new AbortController().signal),()=>sweep.reconcilePrivacyExports(serviceContext,100,new AbortController().signal),()=>sweep.privacyExportBacklog(serviceContext)])
      await expect(attempt()).rejects.toThrow('owner_required');
    await jobs.cleanupPrivacyExportJobs(context(other),new AbortController().signal);
    const foreign=(await jobs.requestPrivacyExportJob(context(other),{requestId:randomUUID()})).jobId; // an owner nobody is assigned to
    await jobs.advancePrivacyExportJob(context(other),{jobId:foreign},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(other),{jobId:foreign});
    await db.query(`insert into clinical_private.privacy_retention_service_releases(version,service_person_id,identity_subject,evidence_sha256,approved_by,approved_at)
      values('test-release',$1,$2,$3,$4,clock_timestamp()-interval '1 minute')`,[retentionService,'subject-'+retentionService,'b'.repeat(64),reviewer]);
    try{
      // Another workforce identity is not the service even with a release present.
      await expect(retentionWith(f.store,'retention_service').privacyExportBacklog(operatorContext(unassigned))).rejects.toThrow('owner_required');
      const backlog=await sweep.privacyExportBacklog(serviceContext);
      expect(backlog).toMatchObject({scope:'all_owners'});expect(backlog.cleanupPending).toBeGreaterThanOrEqual(1);
      const swept=await sweep.cleanupAssignedPrivacyExports(serviceContext,100,new AbortController().signal);
      expect(swept.items.some(i=>i.jobId===foreign&&i.outcome==='deleted')).toBe(true);
      expect((await db.query<{op:string|null}>(`select e.operator_id::text op from clinical_audit.owned_privacy_export_events e join clinical_private.owned_privacy_export_jobs j on j.export_id=e.export_id where j.id=$1 and e.action='object.deleted'`,[foreign])).rows).toEqual([{op:retentionService}]);
      await expect(jobs.cleanupPrivacyExportJobs(context(other),new AbortController().signal)).resolves.toEqual({cleaned:0,remaining:0});
      await db.query("update clinical_private.privacy_retention_service_releases set revoked_at=clock_timestamp() where version='test-release'");
      await expect(sweep.privacyExportBacklog(serviceContext)).rejects.toThrow('owner_required');
    }finally{await db.query("delete from clinical_private.privacy_retention_service_releases where version='test-release'");}
  });
});

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

// The activation path for the scheduled sweep, executed locally: the operator release module inserts the release row
// with the same checks the sweep applies, and the sweep entry point itself runs against the executable SQL with the
// fictional store. This is the only run of the sweep so far; nothing hosted has executed it.
import {runRetentionSweep,type RetentionSweepConfiguration} from './privacy-retention-sweep-lambda';
import {inspectRetentionServiceReleases,releaseRetentionService,revokeRetentionServiceRelease} from './retention-service-release';
// The operator path: the administrative role, no API role switch, the same parameter unwrapping.
const adminDatabase:ClinicalCoreDatabase={transaction:async work=>db.transaction(async tx=>work({query:async(sql:string,args:unknown[]=[])=>
  tx.query(sql,args.map(v=>typeof v==='object'&&v!==null&&'kind' in v&&v.kind==='uuid'&&'value' in v?v.value:v))} as unknown as ClinicalCoreTransaction))} as ClinicalCoreDatabase;
describe('retention sweep activation path (release row operator and a local sweep run)',()=>{
  const sweepConfiguration=(patch:Partial<RetentionSweepConfiguration>={}):RetentionSweepConfiguration=>({enabled:true,phiAllowed:true,evidenceSha256:'b'.repeat(64),servicePersonId:retentionService,
    serviceSubject:'subject-'+retentionService,organizationId:org,bucket:storage.bucket,kmsKeyArn:storage.kmsKeyArn,bucketOwner:storage.expectedBucketOwner,region:storage.region,...patch});
  const release=(patch:Partial<Parameters<typeof releaseRetentionService>[1]>={})=>releaseRetentionService(adminDatabase,{version:'ops-2026-09-20',servicePersonId:retentionService,
    serviceSubject:'subject-'+retentionService,approvedByPersonId:reviewer,evidenceSha256:'b'.repeat(64),...patch});
  it('refuses a release that the sweep would later refuse, and never inserts on refusal',async()=>{
    for(const [patch,code] of [[{version:''},'retention_release_invalid'],[{version:'x'.repeat(81)},'retention_release_invalid'],[{evidenceSha256:'B'.repeat(64)},'retention_release_invalid'],
      [{serviceSubject:'short'},'retention_release_invalid'],[{approvedByPersonId:retentionService},'retention_release_self_approval'],
      [{serviceSubject:'subject-'+operator},'retention_service_identity_required'],[{servicePersonId:owner,serviceSubject:'subject-'+owner},'retention_service_identity_required'],
      [{servicePersonId:randomUUID(),serviceSubject:'subject-nobody-here'},'retention_service_identity_required'],[{approvedByPersonId:owner},'retention_approver_required'],
      [{approvedByPersonId:randomUUID()},'retention_approver_required']] as const)
      await expect(release(patch),JSON.stringify(patch)).rejects.toThrow(code);
    expect(await inspectRetentionServiceReleases(adminDatabase)).toEqual({releases:[],live:0});
  });
  it('is refused with no live release, acts once released, reports counts only, and is refused again once revoked',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store),lines:string[]=[];
    const emit=(line:string)=>lines.push(line);
    await expect(runRetentionSweep(database,sweepConfiguration({enabled:false}),{store:f.store as never,emit})).rejects.toThrow('retention_sweep_configuration_invalid');
    await expect(runRetentionSweep(database,sweepConfiguration({phiAllowed:false}),{store:f.store as never,emit})).rejects.toThrow('retention_sweep_configuration_invalid');
    await expect(runRetentionSweep(database,sweepConfiguration({bucket:'Bad Bucket'}),{store:f.store as never,emit})).rejects.toThrow('retention_sweep_configuration_invalid');
    await jobs.cleanupPrivacyExportJobs(context(other),new AbortController().signal);
    const foreign=(await jobs.requestPrivacyExportJob(context(other),{requestId:randomUUID()})).jobId;
    await jobs.advancePrivacyExportJob(context(other),{jobId:foreign},20000,new AbortController().signal);
    await jobs.cancelPrivacyExportJob(context(other),{jobId:foreign});
    const refused=await runRetentionSweep(database,sweepConfiguration(),{store:f.store as never,emit});
    expect(refused).toEqual({ok:false,refused:'retention_service_release_required',cleanup:null,reconcile:null,backlog:null});
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({SweepRefused:1,Cleaned:0,ok:false,refused:'retention_service_release_required'});
    expect((await jobs.getPrivacyExportJob(context(other),{jobId:foreign})).objectDeleted).toBe(false);
    try{
      const released=await release();
      expect(released).toMatchObject({version:'ops-2026-09-20',servicePersonId:retentionService,identitySubject:'subject-'+retentionService,approvedBy:reviewer,revokedAt:null,live:true});
      await expect(release()).rejects.toThrow('retention_release_exists');
      await expect(release({version:'ops-2026-09-21'})).rejects.toThrow('retention_release_live');
      expect(await inspectRetentionServiceReleases(adminDatabase)).toMatchObject({live:1,releases:[{version:'ops-2026-09-20',live:true}]});
      const swept=await runRetentionSweep(database,sweepConfiguration(),{store:f.store as never,emit});
      expect(swept.ok).toBe(true);expect(swept.refused).toBeNull();
      expect(swept.cleanup!.cleaned).toBeGreaterThanOrEqual(1);
      expect(swept.reconcile).toEqual({confirmed:expect.any(Number),reopened:expect.any(Number),pending:expect.any(Number)});
      expect(swept.backlog).toMatchObject({scope:'all_owners'});
      expect((await jobs.getPrivacyExportJob(context(other),{jobId:foreign})).objectDeleted).toBe(true);
      const metrics=JSON.parse(lines.at(-1)!);
      expect(metrics).toMatchObject({SweepRefused:0,ok:true,refused:null});
      expect(metrics._aws.CloudWatchMetrics[0].Namespace).toBe('ALP/PrivacyExportRetention');
      // Counts only: no job, owner or key identifiers leave the sweep.
      expect(JSON.stringify(metrics)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|personal-exports/);
      const revoked=await revokeRetentionServiceRelease(adminDatabase,'ops-2026-09-20');
      expect(revoked.live).toBe(false);expect(revoked.revokedAt).not.toBeNull();
      await expect(revokeRetentionServiceRelease(adminDatabase,'ops-2026-09-20')).rejects.toThrow('retention_release_not_live');
      expect((await runRetentionSweep(database,sweepConfiguration(),{store:f.store as never,emit})).refused).toBe('retention_service_release_required');
      // A revoked row stays as history; a new version for the same identity may be released afterwards.
      const again=await release({version:'ops-2026-09-21'});
      expect(again.live).toBe(true);
      expect((await inspectRetentionServiceReleases(adminDatabase)).releases.map(r=>[r.version,r.live])).toEqual([['ops-2026-09-20',false],['ops-2026-09-21',true]]);
    }finally{await db.query("delete from clinical_private.privacy_retention_service_releases where version like 'ops-2026-09-%'");}
  });
});

// Cross-store coverage (migration 20260920180000): where the deployment names the lab and voice stores, the prepared copy
// carries `labs` and `voice` sections read through owner-authorized readers after records and consents; where it does not,
// the sections are absent and the coverage statement says so. The stores here are fictional readers, never AWS.
import type {CrossStoreExportReader} from './aws-cross-store-export-reader';
describe('cross-store export coverage',()=>{
  const fakeCrossStore=(configured:{labs:boolean;voice:boolean}):CrossStoreExportReader&{reads:string[]}=>{
    const reads:string[]=[];
    return {reads,configured:section=>configured[section],read:async(c,section,cursor)=>{
      reads.push(`${section}:${cursor??'start'}`);
      if(c.actorPersonId!==owner)throw new Error('wrong owner');
      if(section==='labs')return cursor===null?{items:[{kind:'lab_job',jobId:'11111111-1111-4111-8111-111111111111',state:'completed',result:{summary:'FICTIONAL'},documents:[{clientDocumentId:'22222222-2222-4222-8222-222222222222',contentType:'application/pdf',byteSize:3,checksumSHA256:'x',encoding:'base64',content:'JVBE'}]}],nextCursor:'page2',skipped:0}
        :{items:[{kind:'lab_job',jobId:'33333333-3333-4333-8333-333333333333',state:'failed',result:null,documents:[]}],nextCursor:null,skipped:1};
      return {items:[{kind:'voice_job',jobId:'a'.repeat(64),state:'ready',transcript:'FICTIONAL TRANSCRIPT'}],nextCursor:null,skipped:0};
    }};
  };
  const document=async(f:ReturnType<typeof fakeStore>)=>{
    const key=[...f.objects.keys()].find(k=>k.endsWith('.json'))!;
    const [,bytes]=[...f.objects.get(key)!.entries()][0];
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string,unknown>;
  };
  it('appends labs and voice sections after consents when both stores are configured, paging each store and recording progress across passes',async()=>{
    const f=fakeStore(),cross=fakeCrossStore({labs:true,voice:true});
    const jobs=createOwnedPrivacyExportJobs((c,work)=>adapter().runPrivacy(c,work),{store:f.store,storage,partBytes:8192,crossStore:cross,now:onePagePerPass()});
    const requested=await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()});
    expect(requested.coverage).toMatchObject({completeAccountExport:false,crossStore:{labs:'included',voice:'included'}});
    expect(requested.coverage.included).toEqual(expect.arrayContaining(['lab_processing_jobs_and_documents','chat_and_voice_transcripts']));
    expect(requested.coverage.excluded).not.toContain('lab_processing_jobs_and_documents');
    const {view}=await drive(jobs,requested.jobId);
    expect(view.status).toBe('ready');
    const doc=await document(f);
    expect((doc.manifest as {coverage:{crossStore:unknown}}).coverage.crossStore).toEqual({labs:'included',voice:'included'});
    expect((doc.records as unknown[]).length).toBe(view.recordCount);expect((doc.consents as unknown[]).length).toBe(view.consentCount);
    expect(doc.labs).toEqual([expect.objectContaining({jobId:'11111111-1111-4111-8111-111111111111'}),expect.objectContaining({jobId:'33333333-3333-4333-8333-333333333333'})]);
    expect(doc.voice).toEqual([{kind:'voice_job',jobId:'a'.repeat(64),state:'ready',transcript:'FICTIONAL TRANSCRIPT'}]);
    expect(Object.keys(doc)).toEqual(['contract','manifest','records','consents','labs','voice']);
    // Each store page was read exactly once: progress is recorded in the cursor between passes, never re-read or duplicated.
    expect(cross.reads).toEqual(['labs:start','labs:page2','voice:start']);
  });
  it('skips an unconfigured store, says so in the coverage statement, and leaves the document without that section',async()=>{
    const f=fakeStore(),cross=fakeCrossStore({labs:false,voice:true});
    const jobs=createOwnedPrivacyExportJobs((c,work)=>adapter().runPrivacy(c,work),{store:f.store,storage,partBytes:8192,crossStore:cross});
    const requested=await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()});
    expect(requested.coverage.crossStore).toEqual({labs:'not_configured',voice:'included'});
    expect(requested.coverage.excluded).toContain('lab_processing_jobs_and_documents');
    expect((await drive(jobs,requested.jobId)).view.status).toBe('ready');
    const doc=await document(f);
    expect(Object.keys(doc)).toEqual(['contract','manifest','records','consents','voice']);
    expect(cross.reads).toEqual(['voice:start']);
    // Without any reader the copy is the two-section document it always was, and the statement says both stores are not configured.
    // One open job per owner and one request per hour: close the ready job and age it before the next request.
    await jobs.cancelPrivacyExportJob(context(),{jobId:requested.jobId});
    await db.query("update clinical_private.owned_privacy_export_jobs set created_at=created_at-interval '2 hours'");
    const g=fakeStore(),plain=jobsWith(g.store);
    const plainJob=await plain.requestPrivacyExportJob(context(),{requestId:randomUUID()});
    expect(plainJob.coverage.crossStore).toEqual({labs:'not_configured',voice:'not_configured'});
    expect((await drive(plain,plainJob.jobId)).view.status).toBe('ready');
    expect(Object.keys(await document(g))).toEqual(['contract','manifest','records','consents']);
  });
  it('refuses a section moving backwards or past done at the SQL boundary',async()=>{
    const f=fakeStore(),jobs=jobsWith(f.store);
    const job=(await jobs.requestPrivacyExportJob(context(),{requestId:randomUUID()})).jobId;
    const pass=(section:string,version:number)=>adapter().runPrivacy(context(),tx=>tx.query("select clinical_core.record_owned_privacy_export_pass($1,$2::bigint,null,null,null,null,null,$3,'{}'::jsonb,0,0)",[job,version,section]));
    const place=async(section:string)=>{
      await db.query("update clinical_private.owned_privacy_export_jobs set status='running',section=$2,lease_until=clock_timestamp()+interval '1 minute' where id=$1",[job,section]);
      return (await db.query<{version:number}>('select version from clinical_private.owned_privacy_export_jobs where id=$1',[job])).rows[0].version;
    };
    let version=await place('voice');
    for(const earlier of ['labs','consents','records'])await expect(pass(earlier,version)).rejects.toThrow('conflict');
    await expect(pass('elsewhere',version)).rejects.toThrow('request_invalid');
    // Forward moves are accepted: voice to done is the last transition and nothing follows it.
    await expect(pass('done',version)).resolves.toBeDefined();
    version=await place('done');
    await expect(pass('done',version)).rejects.toThrow('conflict');
    version=await place('labs');
    await expect(pass('voice',version)).resolves.toBeDefined();
  });
});
