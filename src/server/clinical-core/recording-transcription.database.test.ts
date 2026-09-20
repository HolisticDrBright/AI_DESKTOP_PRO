import {beforeAll,afterAll,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// Executable production SQL over fictional in-memory rows. No provider, audio
// object, hosted database or clinical approval is involved.
let db:PGlite;
const org=randomUUID(),otherOrg=randomUUID(),actor=randomUUID(),colleague=randomUUID(),patient=randomUUID();
type Capture={recordingId:string;sessionId:string;captureToken:string};
type Reservation={segmentId:string;sha256:string;bytes:number};
async function call<T=unknown>(sql:string,args:unknown[]=[],who=actor,organization=org){
  return db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')",[who,organization,'subject-'+who]);
    return (await tx.query<{result:T}>(sql,args)).rows[0]?.result;
  });
}
const encounter=async()=>(await call<string>('select clinical_core.start_encounter($1,$2) as result',[org,patient]))!;
const participant=(e:string,kind='patient')=>call<string>("select clinical_private.add_encounter_recording_participant($1,$2,'FICTIONAL PARTICIPANT',true,$3) as result",[e,kind,randomUUID()]);
async function consentRelease(scope:string){
  const id=randomUUID();
  await db.query(`insert into clinical_private.recording_consent_releases(id,organization_id,scope,version,locale,jurisdiction,content,content_sha256,approved_by,approved_at)
    values($1::uuid,$2,$3,($1::uuid)::text,'en','FICTIONAL','FICTIONAL CONSENT ONLY',encode(public.digest('FICTIONAL CONSENT ONLY','sha256'),'hex'),'FICTIONAL TEST REVIEW',clock_timestamp()-interval '1 day')`,[id,org,scope]);
  return id;
}
const grant=(p:string,release:string)=>call<string>("select clinical_private.grant_encounter_recording_consent($1,$2,$3,'written','FICTIONAL ACK',null) as result",[p,release,randomUUID()]);
const withdraw=(id:string)=>call("select clinical_private.withdraw_encounter_recording_consent($1,'FICTIONAL WITHDRAWAL') as result",[id]);
async function captureRelease(){
  const id=randomUUID(),configuration={provider:'aws_healthscribe',region:'us-east-2',maxRecordingBytes:1000000,audioRetentionHours:24};
  await db.query(`insert into clinical_private.recording_capture_releases(id,organization_id,configuration,configuration_sha256,qualification_sha256,approved_by,approved_at,expires_at)
    values($1,$2,$3::jsonb,encode(public.digest(($3::jsonb)::text,'sha256'),'hex'),repeat('a',64),'FICTIONAL',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')`,[id,org,JSON.stringify(configuration)]);
  const storage={bucket:'fictional-recording-storage',expectedBucketOwner:'123456789012',region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111',maxSegmentBytes:1000000};
  await db.query(`insert into clinical_private.recording_storage_releases(id,capture_release_id,configuration,configuration_sha256,qualification_sha256,approved_by,approved_at,expires_at)
    values($1,$2,$3::jsonb,encode(public.digest(($3::jsonb)::text,'sha256'),'hex'),repeat('b',64),'FICTIONAL',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`,[randomUUID(),id,JSON.stringify(storage)]);
  return id;
}
async function transcriptionRelease(configuration:Record<string,unknown>={provider:'aws_transcribe',region:'us-east-2',languageCode:'en-US'},organization=org){
  const id=randomUUID();
  await db.query(`insert into clinical_private.recording_transcription_releases(id,organization_id,configuration,configuration_sha256,qualification_sha256,approved_by,approved_at,expires_at)
    values($1,$2,$3::jsonb,encode(public.digest(($3::jsonb)::text,'sha256'),'hex'),repeat('c',64),'FICTIONAL PROVIDER QUALIFICATION',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')`,[id,organization,JSON.stringify(configuration)]);
  return id;
}
/** A finished recording with one stored segment, recording consent for both participants,
 * and optional transcription consent. Returns the grant ids so tests can withdraw. */
async function finished(options:{transcriptionConsent?:boolean;finish?:boolean}={}){
  const e=await encounter(),p=(await participant(e))!,clinician=(await participant(e,'practitioner'))!;
  const recordingRelease=await consentRelease('recording');await grant(p,recordingRelease);await grant(clinician,recordingRelease);
  const grants:string[]=[];
  if(options.transcriptionConsent!==false){const t=await consentRelease('transcription');grants.push((await grant(p,t))!,(await grant(clinician,t))!);}
  const config=await captureRelease();
  const c=(await call<Capture>('select clinical_private.begin_encounter_capture($1,$2,$3,$4) as result',[e,config,randomUUID(),'audio/webm']))!;
  const s=(await call<Reservation>('select clinical_private.reserve_recording_segment($1,$2,$3,$4,$5,$6) as result',[c.recordingId,c.sessionId,c.captureToken,0,'a'.repeat(64),3]))!;
  await call('select clinical_private.complete_recording_segment($1,$2,$3,$4,$5,$6,$7) as result',[c.recordingId,c.sessionId,c.captureToken,s.segmentId,s.sha256,s.bytes,'fictional-version-1']);
  if(options.finish!==false){
    const state=(await call<{inventorySha256:string}>('select clinical_private.get_recording_recovery_state($1) as result',[c.recordingId]))!;
    await call("select clinical_private.command_recording_lifecycle($1,$2,'finish',0::bigint,$3) as result",[c.recordingId,randomUUID(),state.inventorySha256]);
  }
  return {e,c,grants};
}
const request=(recording:string,release:string,command=randomUUID(),who=actor)=>call<{jobId:string;status:string;segmentCount:number;replayed:boolean}>(
  'select clinical_private.request_recording_transcription($1,$2,$3) as result',[recording,command,release],who);
const complete=(job:string,key:string,sha:string)=>call<{transcriptId:string;version:number;replayed:boolean}>(
  'select clinical_private.complete_recording_transcription($1,$2,$3,$4,$5) as result',[job,key,sha,120,20]);
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000}));
  db=new PGlite({extensions:{pgcrypto}});for(const m of manifest.migrations)await db.exec(files[m.file]);
  for(const id of [org,otherOrg])await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')",[id]);
  for(const id of [actor,colleague]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)",[id,'subject-'+id]);
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,id]);
  }
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",[patient,org,'patient_'+patient.replaceAll('-','')]);
  for(const table of ['recording_transcription_releases','recording_transcription_jobs','recording_transcripts','recording_transcription_events'])
    expect((await db.query<{n:number}>(`select count(*)::int n from clinical_private.${table}`)).rows[0].n).toBe(0);
},60000);
afterAll(async()=>{await db?.close();});

describe('encounter transcription authority',()=>{
  it('requests only for a finished recording under an approved provider release and every participant’s transcription consent, idempotently',async()=>{
    const release=await transcriptionRelease();
    const open=await finished({finish:false});
    await expect(request(open.c.recordingId,release)).rejects.toThrow(/recording_transcription_refused/);
    const noConsent=await finished({transcriptionConsent:false});
    await expect(request(noConsent.c.recordingId,release)).rejects.toThrow(/recording_consent_required/);
    const ready=await finished();const command=randomUUID();
    const receipt=(await request(ready.c.recordingId,release,command))!;
    expect(receipt).toMatchObject({status:'requested',segmentCount:1,replayed:false});
    expect((await request(ready.c.recordingId,release,command))!).toMatchObject({jobId:receipt.jobId,replayed:true});
    await expect(request(ready.c.recordingId,release)).rejects.toThrow(/recording_transcription_conflict/);
    await expect(request(ready.c.recordingId,release,randomUUID(),colleague)).rejects.toThrow(/recording_access_refused/);
    await expect(request(ready.c.recordingId,await transcriptionRelease({provider:'other',region:'us-east-2'}))).rejects.toThrow(/recording_transcription_release_refused/);
    await expect(request(ready.c.recordingId,await transcriptionRelease(undefined,otherOrg))).rejects.toThrow(/recording_transcription_release_refused/);
  });
  it('stores an immutable provider transcript on completion, lists it, and exposes its object only to the owner',async()=>{
    const release=await transcriptionRelease(),ready=await finished();
    const job=(await request(ready.c.recordingId,release))!.jobId;
    await expect(complete(job,'transcripts/fictional/1.json','d'.repeat(64))).rejects.toThrow(/recording_transcription_conflict/);
    const media=await call<{contentType:string;storage:{bucket:string};provider:{provider:string};segments:{sequence:number;objectKey:string;sha256:string}[]}>('select clinical_private.get_recording_transcription_media($1) as result',[job]);
    expect(media).toMatchObject({status:'requested',contentType:'audio/webm',storage:{bucket:'fictional-recording-storage'},provider:{provider:'aws_transcribe'}});
    expect(media!.segments).toEqual([expect.objectContaining({sequence:0,sha256:'a'.repeat(64)})]);expect(media!.segments[0].objectKey).toBeTruthy();
    await expect(call('select clinical_private.get_recording_transcription_media($1) as result',[job],colleague)).rejects.toThrow(/recording_access_refused/);
    expect(await call("select clinical_private.mark_recording_transcription_processing($1,'fictional-provider-job') as result",[job])).toMatchObject({status:'processing',replayed:false});
    expect(await call("select clinical_private.mark_recording_transcription_processing($1,'fictional-provider-job') as result",[job])).toMatchObject({replayed:true});
    const stored=(await complete(job,'transcripts/fictional/1.json','d'.repeat(64)))!;
    await expect(call('select clinical_private.get_recording_transcription_media($1) as result',[job])).rejects.toThrow(/recording_transcription_conflict/);
    expect(stored).toMatchObject({version:1,replayed:false});
    expect(await complete(job,'transcripts/fictional/1.json','d'.repeat(64))).toMatchObject({transcriptId:stored.transcriptId,replayed:true});
    await expect(complete(job,'transcripts/fictional/other.json','e'.repeat(64))).rejects.toThrow(/recording_transcription_conflict/);
    const listed=await call<{job:{status:string};versions:{version:number;kind:string}[]}>('select clinical_private.list_recording_transcripts($1) as result',[ready.c.recordingId]);
    expect(listed!.job.status).toBe('completed');expect(listed!.versions).toEqual([expect.objectContaining({version:1,kind:'provider'})]);
    expect(JSON.stringify(listed)).not.toContain('transcripts/fictional');
    expect(await call('select clinical_private.get_recording_transcript_object($1) as result',[stored.transcriptId])).toMatchObject({objectKey:'transcripts/fictional/1.json',version:1,storage:{bucket:'fictional-recording-storage'}});
    await expect(call('select clinical_private.get_recording_transcript_object($1) as result',[stored.transcriptId],colleague)).rejects.toThrow(/recording_access_refused/);
    await expect(db.query("update clinical_private.recording_transcripts set content_sha256=repeat('f',64) where id=$1",[stored.transcriptId])).rejects.toThrow();
  });
  it('fails the job and stores nothing when consent is withdrawn between request and completion',async()=>{
    const release=await transcriptionRelease(),ready=await finished();
    const job=(await request(ready.c.recordingId,release))!.jobId;
    await call("select clinical_private.mark_recording_transcription_processing($1,'fictional-provider-job-2') as result",[job]);
    await withdraw(ready.grants[0]);
    const outcome=await call<{status:string;failureCode:string;transcriptId:null}>('select clinical_private.complete_recording_transcription($1,$2,$3,120,20) as result',[job,'transcripts/fictional/2.json','d'.repeat(64)]);
    expect(outcome).toMatchObject({status:'failed',transcriptId:null});expect(outcome!.failureCode).toMatch(/recording_consent_required|recording_transcription_refused/);
    const row=(await db.query<{status:string;failure_code:string}>('select status,failure_code from clinical_private.recording_transcription_jobs where id=$1',[job])).rows[0];
    expect(row.status).toBe('failed');expect(row.failure_code).toMatch(/recording_consent_required|recording_transcription_refused/);
    expect((await db.query<{n:number}>('select count(*)::int n from clinical_private.recording_transcripts where job_id=$1',[job])).rows[0].n).toBe(0);
    // A withdrawn recording cannot be requested again either.
    await expect(request(ready.c.recordingId,release)).rejects.toThrow(/recording_transcription_refused|recording_consent_required/);
  });
  it('refuses under a legal hold and appends corrections as new immutable versions',async()=>{
    const release=await transcriptionRelease(),ready=await finished();
    const job=(await request(ready.c.recordingId,release))!.jobId;
    await call("select clinical_private.mark_recording_transcription_processing($1,'fictional-provider-job-3') as result",[job]);
    await complete(job,'transcripts/fictional/3.json','d'.repeat(64));
    await expect(call("select clinical_private.correct_recording_transcript($1,'transcripts/fictional/3-same.json',$2,100,18,'no change') as result",[ready.c.recordingId,'d'.repeat(64)])).rejects.toThrow(/recording_transcription_conflict/);
    const corrected=await call<{version:number;supersedesId:string}>("select clinical_private.correct_recording_transcript($1,'transcripts/fictional/3-v2.json',$2,100,18,'Speaker label corrected by clinician') as result",[ready.c.recordingId,'e'.repeat(64)]);
    expect(corrected).toMatchObject({version:2});expect(corrected!.supersedesId).toBeTruthy();
    const hold=randomUUID();
    await db.query("insert into clinical_private.recording_legal_holds(id,organization_id,patient_record_id,reason_code,placed_by) values($1,$2,$3,'litigation',$4)",[hold,org,patient,actor]);
    await expect(call("select clinical_private.correct_recording_transcript($1,'transcripts/fictional/3-v3.json',$2,100,18,'blocked') as result",[ready.c.recordingId,'a'.repeat(64)])).rejects.toThrow(/recording_legal_hold/);
    const held=await finished();
    await expect(request(held.c.recordingId,release)).rejects.toThrow(/recording_legal_hold/);
    await db.query('update clinical_private.recording_legal_holds set released_by=$2,released_at=clock_timestamp() where id=$1',[hold,actor]);
    expect((await request(held.c.recordingId,release))!.status).toBe('requested');
    const events=(await db.query<{action:string}>('select action from clinical_private.recording_transcription_events where recording_id=$1 order by created_at',[ready.c.recordingId])).rows.map(r=>r.action);
    expect(events).toEqual(['transcription.requested','transcription.processing','transcription.completed','transcript.corrected']);
  });
});
