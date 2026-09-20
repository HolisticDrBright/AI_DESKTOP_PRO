import {beforeAll,afterAll,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// Executable production SQL over fictional in-memory rows. No provider call,
// transcript text, clinical note, hosted database or approval is involved.
let db:PGlite;
const org=randomUUID(),otherOrg=randomUUID(),actor=randomUUID(),colleague=randomUUID(),patient=randomUUID();
type Capture={recordingId:string;sessionId:string;captureToken:string};
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
async function transcriptionRelease(){
  const id=randomUUID(),configuration={provider:'aws_transcribe',region:'us-east-2',languageCode:'en-US'};
  await db.query(`insert into clinical_private.recording_transcription_releases(id,organization_id,configuration,configuration_sha256,qualification_sha256,approved_by,approved_at,expires_at)
    values($1,$2,$3::jsonb,encode(public.digest(($3::jsonb)::text,'sha256'),'hex'),repeat('c',64),'FICTIONAL',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')`,[id,org,JSON.stringify(configuration)]);
  return id;
}
async function draftingRelease(configuration:Record<string,unknown>={provider:'openai_responses',model:'fictional-model-1',promptSha256:'7'.repeat(64),zeroDataRetention:true},organization=org){
  const id=randomUUID();
  await db.query(`insert into clinical_private.recording_drafting_releases(id,organization_id,configuration,configuration_sha256,qualification_sha256,approved_by,approved_at,expires_at)
    values($1,$2,$3::jsonb,encode(public.digest(($3::jsonb)::text,'sha256'),'hex'),repeat('d',64),'FICTIONAL PROVIDER QUALIFICATION',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')`,[id,organization,JSON.stringify(configuration)]);
  return id;
}
/** A finished, transcribed recording with recording + transcription consent, and optional ai_drafting consent. */
async function transcribed(options:{draftingConsent?:boolean}={}){
  const e=await encounter(),p=(await participant(e))!,clinician=(await participant(e,'practitioner'))!;
  for(const scope of ['recording','transcription']){const r=await consentRelease(scope);await grant(p,r);await grant(clinician,r);}
  const draftingGrants:string[]=[];
  if(options.draftingConsent!==false){const d=await consentRelease('ai_drafting');draftingGrants.push((await grant(p,d))!,(await grant(clinician,d))!);}
  const config=await captureRelease();
  const c=(await call<Capture>('select clinical_private.begin_encounter_capture($1,$2,$3,$4) as result',[e,config,randomUUID(),'audio/webm']))!;
  const s=(await call<{segmentId:string;sha256:string;bytes:number}>('select clinical_private.reserve_recording_segment($1,$2,$3,$4,$5,$6) as result',[c.recordingId,c.sessionId,c.captureToken,0,'a'.repeat(64),3]))!;
  await call('select clinical_private.complete_recording_segment($1,$2,$3,$4,$5,$6,$7) as result',[c.recordingId,c.sessionId,c.captureToken,s.segmentId,s.sha256,s.bytes,'fictional-version-1']);
  const state=(await call<{inventorySha256:string}>('select clinical_private.get_recording_recovery_state($1) as result',[c.recordingId]))!;
  await call("select clinical_private.command_recording_lifecycle($1,$2,'finish',0::bigint,$3) as result",[c.recordingId,randomUUID(),state.inventorySha256]);
  const job=(await call<{jobId:string}>('select clinical_private.request_recording_transcription($1,$2,$3) as result',[c.recordingId,randomUUID(),await transcriptionRelease()]))!;
  await call('select clinical_private.mark_recording_transcription_processing($1,$2) as result',[job.jobId,'alp-'+job.jobId]);
  const prefix=`encounter-recordings/${org}/${c.recordingId}/transcription/${job.jobId}/`;
  const done=(await call<{transcriptId:string}>('select clinical_private.complete_recording_transcription($1,$2,$3,$4,$5) as result',[job.jobId,prefix+'transcript-v1.txt','5'.repeat(64),120,20]))!;
  return {e,c,transcriptId:done.transcriptId,draftingGrants};
}
const request=(recording:string,transcript:string,release:string,noteType='soap',command=randomUUID(),who=actor)=>call<{jobId:string;status:string;noteType:string;replayed:boolean}>(
  'select clinical_private.request_recording_drafting($1,$2,$3,$4,$5) as result',[recording,transcript,command,release,noteType],who);
const complete=(job:string,key:string,sha:string)=>call<{proposedNoteId:string|null;status:string;version:number|null;failureCode?:string;replayed:boolean}>(
  'select clinical_private.complete_recording_drafting($1,$2,$3,$4,$5,$6) as result',[job,key,sha,900,4,'fictional-model-1']);
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
  for(const table of ['recording_drafting_releases','recording_drafting_jobs','recording_proposed_notes','recording_drafting_events'])
    expect((await db.query<{n:number}>(`select count(*)::int n from clinical_private.${table}`)).rows[0].n).toBe(0);
},60000);
afterAll(async()=>{await db?.close();});

describe('review-only encounter drafting authority',()=>{
  it('requests only from the latest transcript under an approved provider release and every participant’s ai_drafting consent, idempotently',async()=>{
    const release=await draftingRelease();
    const noConsent=await transcribed({draftingConsent:false});
    await expect(request(noConsent.c.recordingId,noConsent.transcriptId,release)).rejects.toThrow(/recording_consent_required/);
    const ready=await transcribed();const command=randomUUID();
    await expect(request(ready.c.recordingId,ready.transcriptId,release,'letter')).rejects.toThrow(/recording_drafting_invalid/);
    await expect(request(ready.c.recordingId,noConsent.transcriptId,release)).rejects.toThrow(/recording_transcript_missing/);
    await expect(request(ready.c.recordingId,ready.transcriptId,await draftingRelease({provider:'openai_responses',model:'fictional-model-1',promptSha256:'7'.repeat(64),zeroDataRetention:false}))).rejects.toThrow(/recording_drafting_release_refused/);
    await expect(request(ready.c.recordingId,ready.transcriptId,await draftingRelease(undefined,otherOrg))).rejects.toThrow(/recording_drafting_release_refused/);
    await expect(request(ready.c.recordingId,ready.transcriptId,release,'soap',randomUUID(),colleague)).rejects.toThrow(/recording_access_refused/);
    const receipt=(await request(ready.c.recordingId,ready.transcriptId,release,'soap',command))!;
    expect(receipt).toMatchObject({status:'requested',noteType:'soap',replayed:false});
    expect((await request(ready.c.recordingId,ready.transcriptId,release,'soap',command))!).toMatchObject({jobId:receipt.jobId,replayed:true});
    await expect(request(ready.c.recordingId,ready.transcriptId,release,'narrative',command)).rejects.toThrow(/recording_drafting_conflict/);
    await expect(request(ready.c.recordingId,ready.transcriptId,release)).rejects.toThrow(/recording_drafting_conflict/);
    // A correction supersedes the transcript; the old version can no longer be drafted from.
    const corrected=await transcribed();
    const prefix=`encounter-recordings/${org}/${corrected.c.recordingId}/transcription/`;
    const jobId=(await db.query<{job_id:string}>('select job_id from clinical_private.recording_transcripts where id=$1',[corrected.transcriptId])).rows[0].job_id;
    const v2=(await call<{transcriptId:string}>('select clinical_private.correct_recording_transcript($1,$2,$3,$4,$5,$6) as result',[corrected.c.recordingId,prefix+jobId+'/transcript-v2.txt','6'.repeat(64),130,21,'speaker fixed']))!;
    await expect(request(corrected.c.recordingId,corrected.transcriptId,release)).rejects.toThrow(/recording_drafting_conflict/);
    expect((await request(corrected.c.recordingId,v2.transcriptId,release))!).toMatchObject({status:'requested'});
  });
  it('supplies bounded processor input, stores one immutable proposed note per job, lists and reads it without text in the database',async()=>{
    const release=await draftingRelease(),f=await transcribed();
    const job=(await request(f.c.recordingId,f.transcriptId,release,'adime'))!;
    const input=(await call<{noteType:string;transcript:{transcriptId:string;objectKey:string;contentSha256:string;byteLength:number};provider:{model:string;promptSha256:string};storage:{bucket:string}}>('select clinical_private.get_recording_drafting_input($1) as result',[job.jobId]))!;
    expect(input).toMatchObject({noteType:'adime',transcript:{transcriptId:f.transcriptId,contentSha256:'5'.repeat(64),byteLength:120},provider:{model:'fictional-model-1',promptSha256:'7'.repeat(64)},storage:{bucket:'fictional-recording-storage'}});
    expect(input.transcript.objectKey).toMatch(/transcript-v1\.txt$/);
    await expect(call('select clinical_private.get_recording_drafting_input($1) as result',[job.jobId],colleague)).rejects.toThrow(/recording_access_refused/);
    const key=`encounter-recordings/${org}/${f.c.recordingId}/drafting/${job.jobId}/proposed-v1.json`;
    const done=(await complete(job.jobId,key,'8'.repeat(64)))!;
    expect(done).toMatchObject({status:'completed',version:1,replayed:false});expect(done.proposedNoteId).toBeTruthy();
    expect((await complete(job.jobId,key,'8'.repeat(64)))!).toMatchObject({proposedNoteId:done.proposedNoteId,replayed:true});
    await expect(complete(job.jobId,key,'9'.repeat(64))).rejects.toThrow(/recording_drafting_conflict/);
    await expect(call('select clinical_private.get_recording_drafting_input($1) as result',[job.jobId])).rejects.toThrow(/recording_drafting_conflict/);
    const listing=(await call<{latestTranscript:{transcriptId:string;version:number};job:{status:string;noteType:string};versions:{proposedNoteId:string;version:number;noteType:string;model:string}[]}>('select clinical_private.list_recording_proposed_notes($1) as result',[f.c.recordingId]))!;
    expect(listing.latestTranscript).toEqual({transcriptId:f.transcriptId,version:1});
    expect(listing.job).toMatchObject({status:'completed',noteType:'adime'});
    expect(listing.versions).toEqual([expect.objectContaining({proposedNoteId:done.proposedNoteId,version:1,noteType:'adime',model:'fictional-model-1'})]);
    expect(JSON.stringify(listing)).not.toMatch(/objectKey|bucket|Subjective|Assessment/);
    const object=(await call<{objectKey:string;contentSha256:string;storage:{bucket:string};noteType:string}>('select clinical_private.get_recording_proposed_note_object($1) as result',[done.proposedNoteId]))!;
    expect(object).toMatchObject({objectKey:key,contentSha256:'8'.repeat(64),noteType:'adime',storage:{bucket:'fictional-recording-storage'}});
    await expect(call('select clinical_private.get_recording_proposed_note_object($1) as result',[done.proposedNoteId],colleague)).rejects.toThrow(/recording_access_refused/);
    await expect(db.query('update clinical_private.recording_proposed_notes set content_sha256=repeat(\'0\',64) where id=$1',[done.proposedNoteId])).rejects.toThrow();
    // No clinical note table was touched.
    expect((await db.query<{n:number}>('select count(*)::int n from clinical_core.encounter_notes where encounter_id=$1',[f.e]).catch(()=>({rows:[{n:0}]}))).rows[0].n).toBe(0);
    // Artifacts register the stored object and appear in the cleanup inventory with the drafting prefix.
    const artifact=(await call<{kind:string;replayed:boolean}>('select clinical_private.register_recording_drafting_artifact($1,$2,$3,$4,$5,$6) as result',[job.jobId,key,'v-p1','8'.repeat(64),900,done.proposedNoteId]))!;
    expect(artifact).toMatchObject({kind:'proposed_note',replayed:false});
    await expect(call('select clinical_private.register_recording_drafting_artifact($1,$2,$3,$4,$5,$6) as result',[job.jobId,key,'v-other','8'.repeat(64),900,done.proposedNoteId])).rejects.toThrow(/recording_transcription_artifact_conflict/);
    await expect(call('select clinical_private.register_recording_drafting_artifact($1,$2,$3,$4,$5,$6) as result',[job.jobId,key.replace('proposed-v1.json','notes.json'),'v','8'.repeat(64),900,done.proposedNoteId])).rejects.toThrow(/recording_transcription_artifact_invalid/);
    const inventory=(await db.query<{result:{kind:string;jobId:string;objectKey:string}[]}>('select clinical_private.recording_transcription_inventory($1) as result',[f.c.recordingId])).rows[0].result;
    expect(inventory).toEqual([{artifactId:expect.any(String),jobId:job.jobId,kind:'proposed_note',objectKey:key,objectVersion:'v-p1',sha256:'8'.repeat(64),bytes:900,transcriptId:null}]);
  });
  it('fails instead of storing when ai_drafting consent is withdrawn after the request, and cancels open jobs on cleanup',async()=>{
    const release=await draftingRelease(),f=await transcribed();
    const job=(await request(f.c.recordingId,f.transcriptId,release))!;
    await withdraw(f.draftingGrants[0]);
    await expect(call('select clinical_private.get_recording_drafting_input($1) as result',[job.jobId])).rejects.toThrow(/recording_consent_required/);
    const key=`encounter-recordings/${org}/${f.c.recordingId}/drafting/${job.jobId}/proposed-v1.json`;
    const outcome=(await complete(job.jobId,key,'8'.repeat(64)))!;
    expect(outcome).toMatchObject({status:'failed',proposedNoteId:null,version:null});expect(outcome.failureCode).toMatch(/recording_consent_required/);
    expect((await db.query<{n:number}>('select count(*)::int n from clinical_private.recording_proposed_notes where recording_id=$1',[f.c.recordingId])).rows[0].n).toBe(0);
    // Cancellation by cleanup: withdrawing recording consent enqueues consent_revoked cleanup.
    const g=await transcribed();
    const open=(await request(g.c.recordingId,g.transcriptId,release))!;
    const recordingGrant=(await db.query<{id:string}>(`select g.id from clinical_private.recording_consent_grants g join clinical_private.recording_consent_releases d on d.id=g.release_id
      where d.scope='recording' and g.participant_id in (select unnest(participant_ids) from clinical_private.encounter_captures where id=$1) order by g.granted_at limit 1`,[g.c.recordingId])).rows[0].id;
    await withdraw(recordingGrant);
    expect((await db.query<{status:string}>('select status from clinical_private.recording_drafting_jobs where id=$1',[open.jobId])).rows[0].status).toBe('cancelled');
    await expect(call('select clinical_private.get_recording_drafting_input($1) as result',[open.jobId])).rejects.toThrow(/recording_drafting_conflict/);
    expect((await db.query<{n:number}>("select count(*)::int n from clinical_private.recording_drafting_events where job_id=$1 and action='drafting.cancelled'",[open.jobId])).rows[0]).toEqual({n:1});
    const failed=(await call<{status:string;replayed:boolean}>("select clinical_private.fail_recording_drafting($1,'provider_unavailable') as result",[job.jobId]))!;
    expect(failed).toMatchObject({status:'failed',replayed:true});
  });
});

describe('declared proposed-note objects for recovery',()=>{
  it('declares a proposed note under the drafting prefix, lists it as a drafting orphan until completion, and registers the orphan for cleanup',async()=>{
    const release=await draftingRelease(),f=await transcribed();
    const job=(await request(f.c.recordingId,f.transcriptId,release))!;
    const key=`encounter-recordings/${org}/${f.c.recordingId}/drafting/${job.jobId}/proposed-v1.json`;
    const declared=(await call<{intentId:string;replayed:boolean}>('select clinical_private.declare_recording_object($1,true,$2,$3,$4,$5::integer) as result',[job.jobId,'proposed_note',key,'8'.repeat(64),900]))!;
    expect(declared).toMatchObject({replayed:false});
    await expect(call('select clinical_private.declare_recording_object($1,true,$2,$3,$4,$5::integer) as result',[job.jobId,'transcript',key,'8'.repeat(64),900])).rejects.toThrow(/recording_transcription_artifact_invalid/);
    await expect(call('select clinical_private.declare_recording_object($1,true,$2,$3,$4,$5::integer) as result',[job.jobId,'proposed_note',key.replace('/drafting/','/transcription/'),'8'.repeat(64),900])).rejects.toThrow(/recording_transcription_artifact_invalid/);
    await expect(call('select clinical_private.declare_recording_object($1,true,$2,$3,$4,$5::integer) as result',[job.jobId,'proposed_note',key,'8'.repeat(64),900],colleague)).rejects.toThrow(/recording_access_refused/);
    const unregistered=(await call<{kind:string;objectKey:string;jobId:string;declared:boolean}[]>('select clinical_private.list_unregistered_recording_objects($1) as result',[f.c.recordingId]))!;
    expect(unregistered.find(o=>o.objectKey===key)).toMatchObject({kind:'orphan',jobId:job.jobId,declared:true});
    const orphan=(await call<{kind:string;jobId:string;replayed:boolean}>('select clinical_private.register_recording_orphan_artifact($1,$2,$3,$4) as result',[key,'v-p1','8'.repeat(64),900]))!;
    expect(orphan).toMatchObject({kind:'orphan',jobId:job.jobId,replayed:false});
    const inventory=(await db.query<{result:{kind:string;jobId:string;objectKey:string}[]}>('select clinical_private.recording_transcription_inventory($1) as result',[f.c.recordingId])).rows[0].result;
    expect(inventory.filter(a=>a.objectKey===key)).toEqual([expect.objectContaining({kind:'orphan',jobId:job.jobId,objectKey:key})]);
    // Completing the job afterwards is refused for that key path only through the ordinary registration, never by re-labelling the orphan.
    await expect(call('select clinical_private.register_recording_drafting_artifact($1,$2,$3,$4,$5,$6) as result',[job.jobId,key,'v-p1','8'.repeat(64),900,randomUUID()])).rejects.toThrow(/recording_transcription_artifact_invalid|recording_transcription_artifact_conflict/);
  });
});
