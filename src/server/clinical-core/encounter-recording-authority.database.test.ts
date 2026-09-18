import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createEncounterRecordingOperations } from "./encounter-recording-operations";
import { createRecordingAuthorityApi, RECORDING_AUTHORITY_ROUTE } from "./recording-authority-api";
import type { ClinicalCoreDatabase } from "./database";
import type { ApiGatewayV2Event } from "./aws-identity-api";
import { createRecordingSegmentRepository, createRecordingSegmentUploader, type RecordingSegmentReservation } from './recording-segments';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { createRecordingLifecycleRepository, type RecordingRecoveryState, type RecordingLifecycleReceipt } from './recording-lifecycle';
import { createRecordingCaptureApi, RECORDING_CAPTURE_ROUTES as captureRoutes } from './recording-capture-api';
import { createRecordingReconciler, createRecordingReconciliationRepository } from './recording-reconciliation';
import { recordingReadinessSchema, type RecordingReadiness } from '@/contracts/encounterRecordingCapture';
import { createRecordingCleanupAuthority, type RecordingCleanupAdmission } from './recording-cleanup-authority';

let db: PGlite;
const legacyCleanup: { id:string; reason:string }[]=[];
const cleanupFile='20260917140000_production_recording_cleanup_intents.sql';
const org = randomUUID(), otherOrg = randomUUID(), actor = randomUUID(), colleague = randomUUID();
const consumer = randomUUID(), staff = randomUUID(), outsider = randomUUID(), patient = randomUUID();
const tables = ["recording_controls", "recording_consent_releases", "recording_participants",
  "recording_representative_authorities", "recording_consent_grants", "recording_consent_withdrawals",
  "recording_capture_releases", "encounter_captures", "recording_authority_events", "recording_participant_commands", "recording_access_events",
  "recording_storage_releases", "recording_segments", "recording_segment_events", "recording_lifecycle_commands", "recording_dispositions", "recording_lifecycle_events",
  "recording_reconciliation_events"];
type Capture = { recordingId: string; sessionId: string; captureToken: string; authorityEpoch: number; status: string; replayed: boolean };
async function call<T = unknown>(sql: string, args: unknown[] = [], who = actor, pool = "workforce", organization = org) {
  return db.transaction(async tx => {
    await tx.exec("set local role clinical_core_api");
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,'clinical_data','production-clinical','clinical_phi')",
      [who, organization, pool, "subject-" + who]);
    return (await tx.query<{ result: T }>(sql, args)).rows[0]?.result;
  });
}
async function encounter() {
  return (await call<string>("select clinical_core.start_encounter($1,$2) as result", [org, patient]))!;
}
const participant = (e: string, kind = "patient", self = true) => call<string>(
  "select clinical_private.add_encounter_recording_participant($1,$2,'FICTIONAL PARTICIPANT',$3,$4) as result", [e, kind, self, randomUUID()]);
async function release(scope = "recording", options: { organization?: string; corrupt?: boolean; future?: boolean } = {}) {
  const id = randomUUID();
  await db.query(`insert into clinical_private.recording_consent_releases
    (id,organization_id,scope,version,locale,jurisdiction,content,content_sha256,approved_by,approved_at)
    values($1::uuid,$2,$3,($1::uuid)::text,'en','FICTIONAL','FICTIONAL CONSENT ONLY',
      case when $4 then repeat('a',64) else encode(public.digest('FICTIONAL CONSENT ONLY','sha256'),'hex') end,
      'FICTIONAL TEST REVIEW, NOT APPROVAL',clock_timestamp()+case when $5 then interval '1 day' else interval '-1 day' end)`,
    [id, options.organization ?? org, scope, Boolean(options.corrupt), Boolean(options.future)]);
  return id;
}
async function policy(configuration: Record<string, unknown> = { provider: "aws_healthscribe", region: "us-east-2", maxRecordingBytes: 1000000, audioRetentionHours: 24 }) {
  const id = randomUUID();
  await db.query(`insert into clinical_private.recording_capture_releases
    (id,organization_id,configuration,configuration_sha256,qualification_sha256,approved_by,approved_at,expires_at)
    values($1,$2,$3::jsonb,encode(public.digest(($3::jsonb)::text,'sha256'),'hex'),repeat('a',64),
      'FICTIONAL IN-MEMORY QUALIFICATION',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')`,
    [id, org, JSON.stringify(configuration)]);
  return id;
}
const grant = (p: string, d: string | null, command = randomUUID(), authority: string | null = null) => call<string>(
  "select clinical_private.grant_encounter_recording_consent($1,$2,$3,'written','FICTIONAL ACK',$4) as result", [p, d, command, authority]);
const begin = (e: string, config: string, command = randomUUID(), contentType = "audio/webm") => call<Capture>(
  "select clinical_private.begin_encounter_capture($1,$2,$3,$4) as result", [e, config, command, contentType]);
const authorize = (c: Capture, scope = "recording", who = actor) => call(
  "select clinical_private.authorize_encounter_capture($1,$2,$3,$4) as result",
  [c.recordingId, c.sessionId, c.captureToken, scope], who);
const withdraw = (id: string) => call("select clinical_private.withdraw_encounter_recording_consent($1,'FICTIONAL WITHDRAWAL') as result", [id]);
async function ready() {
  const e = await encounter(), p = (await participant(e))!, clinician = (await participant(e, "practitioner"))!;
  const d = await release(), pGrant = (await grant(p, d))!, clinicianGrant = (await grant(clinician, d))!;
  return { e, p, clinician, d, pGrant, clinicianGrant, config: await policy() };
}
const storageConfig = { bucket: 'fictional-recording-storage', expectedBucketOwner: '123456789012', region: 'us-east-2',
  kmsKeyArn: 'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111', maxSegmentBytes: 1000000 };
async function storageRelease(captureRelease: string, configuration: Record<string, unknown> = storageConfig) {
  const id = randomUUID();
  await db.query(`insert into clinical_private.recording_storage_releases
    (id,capture_release_id,configuration,configuration_sha256,qualification_sha256,approved_by,approved_at,expires_at)
    values($1,$2,$3::jsonb,encode(public.digest(($3::jsonb)::text,'sha256'),'hex'),repeat('b',64),
      'FICTIONAL STORAGE QUALIFICATION',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`,
  [id, captureRelease, JSON.stringify(configuration)]);
  return id;
}
const reserveSegment = (c: Capture, sequence = 0, sha = 'a'.repeat(64), bytes = 3, who = actor) => call<RecordingSegmentReservation>(
  'select clinical_private.reserve_recording_segment($1,$2,$3,$4,$5,$6) as result', [c.recordingId, c.sessionId, c.captureToken, sequence, sha, bytes], who);
const completeSegment = (c: Capture, s: RecordingSegmentReservation, version = 'fictional-version-1') => call(
  'select clinical_private.complete_recording_segment($1,$2,$3,$4,$5,$6,$7) as result',
  [c.recordingId, c.sessionId, c.captureToken, s.segmentId, s.sha256, s.bytes, version]);
async function uploadReady() {
  const readyState = await ready();
  const storageReleaseId = await storageRelease(readyState.config);
  return { ...readyState, storageReleaseId, capture: (await begin(readyState.e, readyState.config))! };
}
const recoveryState = (c: Capture, who = actor, pool = 'workforce', organization = org) => call<RecordingRecoveryState>(
  'select clinical_private.get_recording_recovery_state($1) as result', [c.recordingId], who, pool, organization);
const lifecycle = (c: Capture, action: string | null, expectedVersion: number | null, inventory: string | null = null,
  command = randomUUID(), who = actor) => call<RecordingLifecycleReceipt>(
  'select clinical_private.command_recording_lifecycle($1,$2,$3,$4::bigint,$5) as result',
  [c.recordingId, command, action, expectedVersion, inventory], who);

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath,
    ["scripts/build-aws-production-clinical-core.mjs", "--json"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10000 })) as
    { manifest: { migrations: { file: string }[] }; files: Record<string, string> };
  db = new PGlite({ extensions: { pgcrypto } });
  for (const entry of manifest.migrations) {
    if(entry.file>=cleanupFile) continue; // Prove migration backfill against real preceding schema.
    try { await db.exec(files[entry.file]); }
    catch (cause) { throw new Error(entry.file + ": " + (cause instanceof Error ? cause.message : "failed")); }
  }
  // No deployment rows or clinical approvals. Everything below is isolated fictional SQL data.
  for (const table of tables) expect((await db.query<{ n: number }>(`select count(*)::int n from clinical_private.${table}`)).rows[0].n).toBe(0);
  for (const id of [org, otherOrg]) await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [id]);
  for (const id of [actor, colleague, consumer, staff, outsider]) {
    await db.query("insert into clinical_core.persons(id,subject_key) values($1,$2)", [id, "subject_" + id.replaceAll("-", "")]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)",
      [id, id === consumer ? "consumer" : "workforce", "subject-" + id]);
    if (id !== consumer) await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)",
      [id === outsider ? otherOrg : org, id, id === staff ? "staff" : "practitioner"]);
  }
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",
    [patient, org, "patient_" + patient.replaceAll("-", "")]);
  for(const reason of ['retention_deadline','discard','consent_revoked']){
    const r=await uploadReady(), c=r.capture;
    if(reason==='discard') await lifecycle(c,'discard',0,(await recoveryState(c))!.inventorySha256);
    if(reason==='consent_revoked'){
      const s=(await reserveSegment(c))!;await completeSegment(c,s);
      await lifecycle(c,'finish',0,(await recoveryState(c))!.inventorySha256);await withdraw(r.pGrant);
    }
    legacyCleanup.push({id:c.recordingId,reason});
  }
  await db.exec(files[cleanupFile]);
  for(const entry of manifest.migrations.filter(m=>m.file>cleanupFile))await db.exec(files[entry.file]);
}, 30000);
afterAll(async () => { await db?.close(); });

type CleanupIntent={recording_id:string;organization_id:string;patient_record_id:string;capture_release_id:string;reason:string;version:number;due_at:Date|string};
async function cleanupIntent(id:string){return (await db.query<CleanupIntent>('select * from clinical_private.recording_cleanup_intents where recording_id=$1',[id])).rows[0];}
describe('durable recording cleanup handoff; not erasure authority',()=>{
  it('rolls back capture, cleanup intent and event together if the transaction fails',async()=>{
    const r=await ready();await storageRelease(r.config);let id='';
    await expect(db.transaction(async tx=>{
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')",[actor,org,'subject-'+actor]);
      const result=await tx.query<{result:Capture}>("select clinical_private.begin_encounter_capture($1,$2,$3,'audio/webm') as result",[r.e,r.config,randomUUID()]);
      id=result.rows[0].result.recordingId;throw new Error('FICTIONAL ROLLBACK');
    })).rejects.toThrow('FICTIONAL ROLLBACK');
    expect(id).not.toBe('');expect(await cleanupIntent(id)).toBeUndefined();
    expect((await db.query('select * from clinical_private.recording_cleanup_intent_events where recording_id=$1',[id])).rows).toEqual([]);
    expect((await db.query('select * from clinical_private.encounter_captures where id=$1',[id])).rows).toEqual([]);
  });
  it('does not alter an existing legal hold or create any deletion proof when scheduling discard',async()=>{
    const hold=randomUUID();
    await db.query("insert into clinical_private.owned_legal_holds(id,owner_id,reason_code,placed_by) values($1,$2,'litigation',$3)",[hold,consumer,actor]);
    const before=(await db.query('select * from clinical_private.owned_legal_holds where id=$1',[hold])).rows;
    const r=await uploadReady();await lifecycle(r.capture,'discard',0,(await recoveryState(r.capture))!.inventorySha256);
    expect((await db.query('select * from clinical_private.owned_legal_holds where id=$1',[hold])).rows).toEqual(before);
    expect(await recoveryState(r.capture)).toMatchObject({audioDeleted:false});
    expect(await cleanupIntent(r.capture.recordingId)).not.toHaveProperty('audio_deleted');
  });
  it('backfills existing unfinished, discarded and finished-then-withdrawn captures',async()=>{
    for(const r of legacyCleanup){
      const intent=await cleanupIntent(r.id);expect(intent).toMatchObject({reason:r.reason,organization_id:org,patient_record_id:patient});
      const expected=r.reason==='retention_deadline'?1:2;
      expect(Number(intent.version)).toBe(expected);
      expect((await db.query('select * from clinical_private.recording_cleanup_intent_events where recording_id=$1',[r.id])).rows).toHaveLength(expected);
    }
  });
  it('schedules a new capture at its exact original retention deadline without marking audio deleted',async()=>{
    const r=await uploadReady(),intent=await cleanupIntent(r.capture.recordingId);
    expect(intent).toMatchObject({reason:'retention_deadline',capture_release_id:r.config,organization_id:org,patient_record_id:patient});
    const state=(await recoveryState(r.capture))!;
    expect(new Date(intent.due_at).getTime()).toBe(new Date(state.deletionDeadline).getTime());
    expect(state.audioDeleted).toBe(false);
  });
  it('atomically queues discard with unresolved segments, preserving immutable storage inventory and exact retry',async()=>{
    const r=await uploadReady(), c=r.capture;await reserveSegment(c);
    const state=(await recoveryState(c))!, command=randomUUID();
    await lifecycle(c,'discard',0,state.inventorySha256,command);
    const first=await cleanupIntent(c.recordingId);
    expect(first.reason).toBe('discard');expect(Number(first.version)).toBe(2);
    expect(new Date(first.due_at).getTime()).toBeLessThanOrEqual(Date.now());
    await lifecycle(c,'discard',0,state.inventorySha256,command);
    expect(await cleanupIntent(c.recordingId)).toEqual(first);
    expect((await db.query<{status:string}>('select status from clinical_private.recording_segments where recording_id=$1',[c.recordingId])).rows[0].status).toBe('reserved');
    expect(await recoveryState(c)).toMatchObject({audioDeleted:false,pendingSegments:1,disposition:'discard'});
  });
  it('does not accelerate cleanup on finish alone or grant new processing permission',async()=>{
    const r=await uploadReady(),c=r.capture;const s=(await reserveSegment(c))!;await completeSegment(c,s);
    const before=await cleanupIntent(c.recordingId);
    await lifecycle(c,'finish',0,(await recoveryState(c))!.inventorySha256);
    expect(await cleanupIntent(c.recordingId)).toEqual(before);
    expect(await recoveryState(c)).toMatchObject({audioDeleted:false,processingRequested:false});
    await withdraw(r.pGrant);
    expect((await cleanupIntent(c.recordingId)).reason).toBe('consent_revoked');
    expect(await recoveryState(c)).toMatchObject({status:'closed',disposition:'finish',audioDeleted:false});
  });
  it('queues withdrawal once while preserving all consent events and refusing further upload',async()=>{
    const r=await uploadReady();await withdraw(r.pGrant);const before=await cleanupIntent(r.capture.recordingId);
    expect(before.reason).toBe('consent_revoked');expect(Number(before.version)).toBe(2);
    await withdraw(r.pGrant);expect(await cleanupIntent(r.capture.recordingId)).toEqual(before);
    await expect(reserveSegment(r.capture)).rejects.toThrow();
  });
  it('does not enqueue discard when the authoritative inventory comparison fails',async()=>{
    const r=await uploadReady(),before=await cleanupIntent(r.capture.recordingId);
    await expect(lifecycle(r.capture,'discard',0,'f'.repeat(64))).rejects.toThrow('recording_inventory_changed');
    expect(await cleanupIntent(r.capture.recordingId)).toEqual(before);
  });
  it('denies ordinary API table/helper access and disallows rewriting provenance or postponing cleanup',async()=>{
    const r=await uploadReady(),id=r.capture.recordingId;
    for(const table of ['recording_cleanup_intents','recording_cleanup_intent_events']){
      await expect(call(`select * from clinical_private.${table}`)).rejects.toThrow('permission denied');
    }
    await expect(call("select clinical_private.enqueue_recording_cleanup($1,'discard')",[id])).rejects.toThrow('permission denied');
    await expect(db.query("update clinical_private.recording_cleanup_intents set due_at=due_at+interval '1 day',version=version+1 where recording_id=$1",[id])).rejects.toThrow('recording_cleanup_intent_immutable');
    await expect(db.query('delete from clinical_private.recording_cleanup_intents where recording_id=$1',[id])).rejects.toThrow();
    await expect(db.query('delete from clinical_private.recording_cleanup_intent_events where recording_id=$1',[id])).rejects.toThrow();
  });
});

const preflight = (e:string,config:string,who=actor,pool='workforce',organization=org) => call<RecordingReadiness>(
  'select clinical_private.get_recording_capture_readiness($1,$2) as result',[e,config],who,pool,organization);
const cleanupContext:ProductionClinicalRequestContext={actorPersonId:actor,organizationId:org,identityPool:'workforce',
  identitySubject:'subject-'+actor,purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',
  productionBound:true,containsPhi:true,realPatientData:true};
async function cleanupCall<T=unknown>(sql:string,args:unknown[]=[],who:string=actor,pool='workforce',organization:string=org,purpose='consent_management'){
  return db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi')",[who,organization,pool,'subject-'+who,purpose]);
    return (await tx.query<{result:T}>(sql,args)).rows[0]?.result;
  });
}
const admitSql='select clinical_private.admit_recording_cleanup($1,$2::bigint,$3,$4) as result';
async function cleanupReady(options:{pending?:boolean;due?:boolean;policyCorrupt?:boolean;policyRetired?:boolean;future?:boolean;expired?:boolean;wrongStorage?:boolean}={}){
  const r=await uploadReady(),c=r.capture;
  if(options.pending){await reserveSegment(c);await db.query("update clinical_private.recording_segments set accept_before=clock_timestamp()-interval '1 second' where recording_id=$1",[c.recordingId]);}
  if(options.due!==false)await lifecycle(c,'discard',0,(await recoveryState(c))!.inventorySha256);
  const policyVersion='fictional-'+randomUUID(), cleanupRelease=randomUUID();
  await db.query(`insert into clinical_private.owned_retention_policies(version,content,content_sha256,approved_by,approved_at,retired_at)
    values($1,'FICTIONAL RECORDING RETENTION',case when $2 then repeat('a',64) else encode(public.digest('FICTIONAL RECORDING RETENTION','sha256'),'hex') end,
      'FICTIONAL REVIEW ONLY',clock_timestamp()-interval '1 hour',case when $3 then clock_timestamp() else null end)`,[policyVersion,!!options.policyCorrupt,!!options.policyRetired]);
  const storage=options.wrongStorage?await storageRelease(await policy()):r.storageReleaseId;
  await db.query(`insert into clinical_private.recording_cleanup_releases(id,capture_release_id,storage_release_id,retention_policy_version,
    retention_policy_sha256,worker_sha256,qualification_sha256,approved_by,approved_at,expires_at)
    values($1,$2,$3,$4,encode(public.digest('FICTIONAL RECORDING RETENTION','sha256'),'hex'),repeat('c',64),repeat('d',64),
    'FICTIONAL CLEANUP QUALIFICATION',clock_timestamp()+case when $5 then interval '1 hour' else interval '-1 day' end,
    clock_timestamp()+case when $6 then interval '-1 hour' else interval '1 day' end)`,[cleanupRelease,r.config,storage,policyVersion,!!options.future,!!options.expired]);
  const version=Number((await cleanupIntent(c.recordingId)).version);
  return {...r,cleanupRelease,version,args:[c.recordingId,version,cleanupRelease,'c'.repeat(64)],
    request:{recordingId:c.recordingId,version,cleanupReleaseId:cleanupRelease,workerSha256:'c'.repeat(64)}};
}
describe('recording cleanup admission and holds with actual canonical SQL',()=>{
  beforeAll(async()=>{
    for(const table of ['recording_cleanup_operators','recording_cleanup_releases','recording_legal_holds','recording_cleanup_access_events','recording_cleanup_subjects'])
      expect((await db.query<{n:number}>(`select count(*)::int n from clinical_private.${table}`)).rows[0].n).toBe(0);
    await db.query(`insert into clinical_private.recording_cleanup_operators(organization_id,operator_id,reviewed_by,evidence_sha256,approved_at,expires_at)
      values($1,$2,$3,repeat('e',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')`,[org,actor,colleague]);
  });
  it('requires a separately assigned workforce privacy operator, not capture authority or consumer login',async()=>{
    const r=await cleanupReady();
    for(const [who,pool,organization,purpose] of [[actor,'workforce',org,'clinical_data'],[consumer,'consumer',org,'consent_management'],
      [colleague,'workforce',org,'consent_management'],[outsider,'workforce',otherOrg,'consent_management'],[actor,'workforce',otherOrg,'consent_management']])
      await expect(cleanupCall(admitSql,r.args,who,pool,organization,purpose)).rejects.toThrow();
    expect((await db.query("select * from clinical_private.recording_cleanup_access_events where recording_id=$1",[r.capture.recordingId])).rows).toEqual([]);
  });
  it('admits exact reviewed inventory, including unresolved reservations, but never claims deletion',async()=>{
    const r=await cleanupReady({pending:true});
    const a=await cleanupCall<RecordingCleanupAdmission>(admitSql,r.args);
    expect(a).toMatchObject({recordingId:r.capture.recordingId,sessionId:r.capture.sessionId,organizationId:org,patientRecordId:patient,
      version:r.version,storage:storageConfig,audioDeleted:false});
    expect(a?.inventory).toHaveLength(1);expect(a?.inventory[0]).toMatchObject({status:'reserved',objectVersion:null});
    expect((await db.query('select * from clinical_private.recording_cleanup_access_events where recording_id=$1',[r.capture.recordingId])).rows).toHaveLength(1);
    expect(await recoveryState(r.capture)).toMatchObject({pendingSegments:1,audioDeleted:false});
  });
  it.each(['expired','future','revoked'])('refuses an %s cleanup assignment',async state=>{
    const r=await cleanupReady(),operator=randomUUID();
    await db.query("insert into clinical_core.persons(id,subject_key) values($1,$2)",[operator,'subject_'+operator.replaceAll('-','')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)",[operator,'subject-'+operator]);
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'staff')",[org,operator]);
    await db.query(`insert into clinical_private.recording_cleanup_operators(organization_id,operator_id,reviewed_by,evidence_sha256,approved_at,expires_at,revoked_at)
      values($1,$2,$3,repeat('e',64),clock_timestamp()+case when $4='future' then interval '1 hour' else interval '-1 day' end,
        clock_timestamp()+case when $4='expired' then interval '-1 hour' else interval '1 day' end,
        case when $4='revoked' then clock_timestamp() else null end)`,[org,operator,actor,state]);
    await expect(cleanupCall(admitSql,r.args,operator)).rejects.toThrow('recording_cleanup_operator_required');
  });
  it('attaches an existing consumer association when a new recording is created',async()=>{
    const owner=randomUUID(),connection=randomUUID();
    await db.query("insert into clinical_core.persons(id,subject_key) values($1,$2)",[owner,'subject_'+owner.replaceAll('-','')]);
    await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at,revoked_at) values($1,$2,$3,$4,'revoked',clock_timestamp(),clock_timestamp())",[connection,org,patient,owner]);
    const r=await cleanupReady();
    expect((await db.query('select owner_id from clinical_private.recording_cleanup_subjects where recording_id=$1 and owner_id=$2',[r.capture.recordingId,owner])).rows).toEqual([{owner_id:owner}]);
    await db.query('delete from clinical_core.patient_connections where id=$1',[connection]);
  });
  it.each([
    ['not due',{due:false},'recording_cleanup_not_ready'],['bad policy hash',{policyCorrupt:true},'retention_policy_required'],
    ['retired policy',{policyRetired:true},'retention_policy_required'],['future approval',{future:true},'recording_cleanup_release_required'],
    ['expired approval',{expired:true},'recording_cleanup_release_required'],['other storage',{wrongStorage:true},'recording_cleanup_release_required'],
  ] as const)('refuses %s',async(_name,options,error)=>{
    const r=await cleanupReady(options);await expect(cleanupCall(admitSql,r.args)).rejects.toThrow(error);
  });
  it('refuses missing release, wrong worker artifact, stale queue version and active write lease',async()=>{
    const r=await cleanupReady();
    await expect(cleanupCall(admitSql,[r.capture.recordingId,r.version,randomUUID(),'c'.repeat(64)])).rejects.toThrow('recording_cleanup_release_required');
    await expect(cleanupCall(admitSql,[r.capture.recordingId,r.version,r.cleanupRelease,'f'.repeat(64)])).rejects.toThrow('recording_cleanup_release_required');
    await withdraw(r.pGrant);
    await expect(cleanupCall(admitSql,r.args)).rejects.toThrow('recording_cleanup_not_ready');
    const s=await uploadReady();await reserveSegment(s.capture);await lifecycle(s.capture,'discard',0,(await recoveryState(s.capture))!.inventorySha256);
    await expect(cleanupCall(admitSql,[s.capture.recordingId,2,r.cleanupRelease,'c'.repeat(64)])).rejects.toThrow('recording_cleanup_not_ready');
  });
  it('enforces chart holds until an authorized explicit release; capture permission cannot release them',async()=>{
    const r=await cleanupReady();const h=await cleanupCall<string>("select clinical_private.place_recording_legal_hold($1,'litigation') as result",[patient]);
    try{
      await expect(cleanupCall(admitSql,r.args)).rejects.toThrow('recording_cleanup_legal_hold');
      await expect(call('select clinical_private.release_recording_legal_hold($1)',[h])).rejects.toThrow();
      await expect(cleanupCall('select clinical_private.release_recording_legal_hold($1)',[h],colleague)).rejects.toThrow();
    }finally{await cleanupCall('select clinical_private.release_recording_legal_hold($1)',[h]);}
    expect(await cleanupCall(admitSql,r.args)).toMatchObject({audioDeleted:false});
    await cleanupCall('select clinical_private.release_recording_legal_hold($1)',[h]);
    expect((await db.query("select * from clinical_private.recording_cleanup_access_events where resource_id=$1 and action='hold.released'",[h])).rows).toHaveLength(1);
  });
  it('preserves consumer holds through revoked and physically removed connections',async()=>{
    const r=await cleanupReady(),owner=randomUUID(),connection=randomUUID(),hold=randomUUID();
    await db.query("insert into clinical_core.persons(id,subject_key) values($1,$2)",[owner,'subject_'+owner.replaceAll('-','')]);
    await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at,revoked_at) values($1,$2,$3,$4,'revoked',clock_timestamp(),clock_timestamp())",[connection,org,patient,owner]);
    await db.query("insert into clinical_private.owned_legal_holds(id,owner_id,reason_code,placed_by) values($1,$2,'litigation',$3)",[hold,owner,actor]);
    try{
      await expect(cleanupCall(admitSql,r.args)).rejects.toThrow('recording_cleanup_legal_hold');
      await db.query('delete from clinical_core.patient_connections where id=$1',[connection]);
      await expect(cleanupCall(admitSql,r.args)).rejects.toThrow('recording_cleanup_legal_hold');
    }finally{await db.query('update clinical_private.owned_legal_holds set released_at=clock_timestamp(),released_by=$2 where id=$1',[hold,actor]);}
    expect(await cleanupCall(admitSql,r.args)).toMatchObject({audioDeleted:false});
  });
  it('allows cleanup admission on an archived chart and retired capture/storage release without reviving capture',async()=>{
    const r=await cleanupReady();
    await db.query('update clinical_private.recording_capture_releases set retired_at=clock_timestamp() where id=$1',[r.config]);
    await db.query('update clinical_private.recording_storage_releases set retired_at=clock_timestamp() where id=$1',[r.storageReleaseId]);
    await db.query("update clinical_core.patient_records set status='archived' where id=$1",[patient]);
    try{expect(await cleanupCall(admitSql,r.args)).toMatchObject({audioDeleted:false});}
    finally{await db.query("update clinical_core.patient_records set status='active' where id=$1",[patient]);}
    await expect(reserveSegment(r.capture)).rejects.toThrow();
  });
  it('refuses a disabled workforce identity and suspended membership even with an assignment',async()=>{
    const r=await cleanupReady();
    await db.query("update clinical_core.identities set status='disabled' where person_id=$1",[actor]);
    try{await expect(cleanupCall(admitSql,r.args)).rejects.toThrow();}
    finally{await db.query("update clinical_core.identities set status='active' where person_id=$1",[actor]);}
    await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1",[actor]);
    try{await expect(cleanupCall(admitSql,r.args)).rejects.toThrow('recording_cleanup_operator_required');}
    finally{await db.query("update clinical_core.organization_memberships set status='active' where person_id=$1",[actor]);}
  });
  it('keeps approvals/holds/events private and forbids rewriting signed scope or reviving retired releases',async()=>{
    const r=await cleanupReady();
    for(const table of ['recording_cleanup_operators','recording_cleanup_releases','recording_legal_holds','recording_cleanup_subjects','recording_cleanup_access_events'])
      await expect(cleanupCall(`select * from clinical_private.${table}`)).rejects.toThrow('permission denied');
    await expect(db.query("update clinical_private.recording_cleanup_releases set worker_sha256=repeat('a',64) where id=$1",[r.cleanupRelease])).rejects.toThrow('recording_cleanup_review_immutable');
    await db.query('update clinical_private.recording_cleanup_releases set retired_at=clock_timestamp() where id=$1',[r.cleanupRelease]);
    await expect(db.query('update clinical_private.recording_cleanup_releases set retired_at=null where id=$1',[r.cleanupRelease])).rejects.toThrow('recording_cleanup_review_immutable');
    await expect(cleanupCall(admitSql,r.args)).rejects.toThrow('recording_cleanup_release_required');
  });
  it('executes the typed guard inside the actual SQL transaction; rejected work cannot become deletion proof',async()=>{
    const r=await cleanupReady({pending:true});
    const database:ClinicalCoreDatabase={transaction:operation=>db.transaction(async tx=>{
      await tx.exec('set local role clinical_core_api');return operation({query:async(sql,args=[])=>tx.query(sql,
        args.map(v=>typeof v==='object'&&v!==null&&'kind' in v&&v.kind==='uuid'&&'value' in v?v.value:v))});
    })};
    let called=0;
    const guarded=createRecordingCleanupAuthority(database);
    expect(await guarded(cleanupContext,r.request,async(a,signal)=>{called++;expect(signal.aborted).toBe(false);expect(a.inventory[0].status).toBe('reserved');return 'FICTIONAL INVENTORY ONLY';})).toBe('FICTIONAL INVENTORY ONLY');
    const before=(await db.query('select * from clinical_private.recording_cleanup_access_events where recording_id=$1',[r.capture.recordingId])).rows;
    await expect(guarded(cleanupContext,r.request,async()=>{throw new Error('FICTIONAL UNKNOWN STORAGE OUTCOME');})).rejects.toThrow('service_unavailable');
    expect((await db.query('select * from clinical_private.recording_cleanup_access_events where recording_id=$1',[r.capture.recordingId])).rows).toEqual(before);
    expect(called).toBe(1);expect(await recoveryState(r.capture)).toMatchObject({audioDeleted:false,pendingSegments:1});
  });
});
describe('capture readiness with real canonical SQL and fictional records', () => {
  it('returns reviewed bounds and a short-lived advisory without a capture, token, or authority event', async () => {
    const r=await ready(); await storageRelease(r.config);
    const before=await db.query('select * from clinical_private.recording_authority_events where encounter_id=$1',[r.e]);
    const result=recordingReadinessSchema.parse(await preflight(r.e,r.config));
    expect(result).toMatchObject({encounterId:r.e,ready:true,maxSegmentBytes:1000000,maxRecordingBytes:1000000,
      audioRetentionHours:24,maxSegments:4096,captureStarted:false,processingRequested:false});
    expect(Date.parse(result.expiresAt)-Date.parse(result.checkedAt)).toBe(30000);
    expect(await db.query('select * from clinical_private.recording_authority_events where encounter_id=$1',[r.e])).toEqual(before);
    expect((await db.query('select * from clinical_private.encounter_captures where encounter_id=$1',[r.e])).rows).toEqual([]);
    await withdraw(r.pGrant);
    await expect(preflight(r.e,r.config)).rejects.toThrow();
    await expect(begin(r.e,r.config)).rejects.toThrow('recording_consent_required');
  });
  it.each(['missing-storage','capture-retired','storage-retired','consent-retired','withdrawn','extra-participant','closed','existing-capture'])
    ('refuses readiness for %s', async reason => {
      const r=await ready(), s=reason==='missing-storage'?null:await storageRelease(r.config);
      if(reason==='capture-retired') await db.query('update clinical_private.recording_capture_releases set retired_at=clock_timestamp() where id=$1',[r.config]);
      if(reason==='storage-retired') await db.query('update clinical_private.recording_storage_releases set retired_at=clock_timestamp() where id=$1',[s]);
      if(reason==='consent-retired') await db.query('update clinical_private.recording_consent_releases set retired_at=clock_timestamp() where id=$1',[r.d]);
      if(reason==='withdrawn') await withdraw(r.pGrant);
      if(reason==='extra-participant') await participant(r.e,'caregiver');
      if(reason==='closed') await db.query("update clinical_core.encounters set status='completed' where id=$1",[r.e]);
      if(reason==='existing-capture') await begin(r.e,r.config);
      await expect(preflight(r.e,r.config)).rejects.toThrow();
    });
  it('refuses consumer, staff, cross-organization, empty-roster and cross-release checks', async () => {
    const r=await ready(); await storageRelease(r.config);
    await expect(preflight(r.e,r.config,consumer,'consumer')).rejects.toThrow();
    await expect(preflight(r.e,r.config,staff)).rejects.toThrow();
    await expect(preflight(r.e,r.config,outsider,'workforce',otherOrg)).rejects.toThrow();
    await expect(preflight(await encounter(),r.config)).rejects.toThrow('recording_roster_required');
    await expect(preflight(r.e,randomUUID())).rejects.toThrow();
  });
});

const prepareReconciliation = (c: Capture, who = actor, pool = 'workforce', organization = org) => call<RecordingSegmentReservation | null>(
  'select clinical_private.prepare_recording_reconciliation($1) as result', [c.recordingId], who, pool, organization);
const completeReconciliation = (c: Capture, s: RecordingSegmentReservation, version = 'fictional-recovered-version') => call(
  'select clinical_private.complete_recording_reconciliation($1,$2,$3) as result', [c.recordingId,s.segmentId,version]);
describe('recording reconciliation: canonical PostgreSQL and isolated fictional evidence', () => {
  it('recovers after credential loss/expiry while paused without issuing a new capture credential', async () => {
    const r=await uploadReady(), c=r.capture, reserved=(await reserveSegment(c))!;
    await lifecycle(c,'pause',0);
    await db.query("update clinical_private.recording_segments set accept_before=clock_timestamp()-interval '1 second' where id=$1",[reserved.segmentId]);
    await expect(authorize(c)).rejects.toThrow();
    const prepared=(await prepareReconciliation(c))!;
    expect(prepared).toMatchObject({segmentId:reserved.segmentId,status:'reserved',objectKey:reserved.objectKey,objectVersion:null});
    expect(Date.parse(prepared.acceptBefore)).toBeGreaterThan(Date.now());
    const receipt=await completeReconciliation(c,prepared);
    expect(receipt).toMatchObject({segmentId:reserved.segmentId,status:'stored',sha256:reserved.sha256,bytes:reserved.bytes});
    expect(await completeReconciliation(c,prepared)).toEqual(receipt);
    expect(await prepareReconciliation(c)).toBeNull();
    expect(await recoveryState(c)).toMatchObject({status:'paused',credentialVersion:1,pendingSegments:0,storedSegments:1});
    await expect(completeReconciliation(c,prepared,'different-version')).rejects.toThrow('recording_segment_conflict');
    expect((await db.query('select * from clinical_private.recording_reconciliation_events where recording_id=$1 and action=$2',
      [c.recordingId,'segment.reconciled'])).rows).toHaveLength(1);
    await expect(db.query('delete from clinical_private.recording_reconciliation_events where recording_id=$1',[c.recordingId])).rejects.toThrow();
  });
  it('keeps reconciliation owner/organization/workforce scoped even when no pending segment exists', async () => {
    const {capture:c}=await uploadReady();
    expect(await prepareReconciliation(c)).toBeNull();
    for(const who of [colleague,staff]) await expect(prepareReconciliation(c,who)).rejects.toThrow();
    await expect(prepareReconciliation(c,consumer,'consumer')).rejects.toThrow();
    await expect(prepareReconciliation(c,outsider,'workforce',otherOrg)).rejects.toThrow();
    await expect(call('select clinical_private.require_recording_reconciliation($1)',[c.recordingId])).rejects.toThrow('permission denied');
  });
  it.each(['withdrawal','participant-added','storage-retired','capture-retired','consent-retired','deadline','encounter-completed','discarded'])
    ('refuses both preparation and completion after %s; pending data remains unresolved', async reason => {
      const r=await uploadReady(), c=r.capture, s=(await reserveSegment(c))!;
      await prepareReconciliation(c);
      if(reason==='withdrawal') await withdraw(r.pGrant);
      if(reason==='participant-added') await participant(r.e,'caregiver');
      if(reason==='storage-retired') await db.query('update clinical_private.recording_storage_releases set retired_at=clock_timestamp() where id=$1',[r.storageReleaseId]);
      if(reason==='capture-retired') await db.query('update clinical_private.recording_capture_releases set retired_at=clock_timestamp() where id=$1',[r.config]);
      if(reason==='consent-retired') await db.query('update clinical_private.recording_consent_releases set retired_at=clock_timestamp() where id=$1',[r.d]);
      if(reason==='deadline') await db.query("update clinical_private.encounter_captures set deletion_deadline=clock_timestamp()-interval '1 second' where id=$1",[c.recordingId]);
      if(reason==='encounter-completed') await db.query("update clinical_core.encounters set status='completed' where id=$1",[r.e]);
      if(reason==='discarded') await lifecycle(c,'discard',0,(await recoveryState(c))!.inventorySha256);
      await expect(prepareReconciliation(c)).rejects.toThrow();
      await expect(completeReconciliation(c,s)).rejects.toThrow();
      expect((await db.query<{status:string}>('select status from clinical_private.recording_segments where id=$1',[s.segmentId])).rows[0].status).toBe('reserved');
    });
  it('refuses expired completion lease and cross-recording segments', async () => {
    const r=await uploadReady(), c=r.capture, s=(await reserveSegment(c))!;
    await prepareReconciliation(c);
    await db.query("update clinical_private.recording_segments set accept_before=clock_timestamp()-interval '1 second' where id=$1",[s.segmentId]);
    await expect(completeReconciliation(c,s)).rejects.toThrow('recording_reservation_expired');
    const other=await uploadReady();
    await expect(completeReconciliation(other.capture,s)).rejects.toThrow('recording_access_refused');
    for(const v of ['null','','v/invalid space']) await expect(completeReconciliation(c,s,v)).rejects.toThrow();
  });
  it('executes repository/metadata verification/SQL with no lock during storage and rechecks post-HEAD withdrawal', async () => {
    for(const revoke of [false,true]) {
      const r=await uploadReady(), c=r.capture; await reserveSegment(c); await lifecycle(c,'pause',0);
      let transactions=0,heads=0;
      const database:ClinicalCoreDatabase={transaction:operation=>db.transaction(async tx=>{
        transactions++;await tx.exec('set local role clinical_core_api');
        try{return await operation({query:(sql,args=[])=>tx.query(sql,args.map(v=>
          typeof v==='object' && v!==null && 'kind' in v && v.kind==='uuid' && 'value' in v ? v.value:v))});}
        finally{transactions--;}
      })};
      const reconciler=createRecordingReconciler(createRecordingReconciliationRepository(database),{async head(s){
        expect(transactions).toBe(0);heads++;
        if(revoke)await withdraw(r.pGrant);
        return {version:'fictional-recovered-version',bytes:s.bytes,contentType:s.contentType,checksumType:'FULL_OBJECT',
          checksum:Buffer.from(s.sha256,'hex').toString('base64'),encryption:'aws:kms',kmsKeyArn:s.storage.kmsKeyArn,
          metadata:{'segment-id':s.segmentId,'recording-id':s.recordingId,'session-id':s.sessionId,'authority-epoch':String(s.authorityEpoch)}};
      }});
      const context:ProductionClinicalRequestContext={actorPersonId:actor,organizationId:org,identityPool:'workforce',identitySubject:'subject-'+actor,
        purpose:'clinical_data',environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true};
      if(revoke){
        await expect(reconciler(context,{recordingId:c.recordingId})).rejects.toThrow();
        expect(await recoveryState(c)).toMatchObject({status:'revoked',pendingSegments:1,storedSegments:0});
      } else {
        expect(await reconciler(context,{recordingId:c.recordingId})).toMatchObject({outcome:'stored'});
        expect(await reconciler(context,{recordingId:c.recordingId})).toEqual({recordingId:c.recordingId,outcome:'no_pending_segment'});
        const current=(await recoveryState(c))!;
        expect(current).toMatchObject({status:'paused',pendingSegments:0,storedSegments:1});
        await lifecycle(c,'finish',1,current.inventorySha256);
      }
      expect(heads).toBe(1);
    }
  });
});

describe("AWS encounter recording authority: production SQL, fictional in-memory fixtures", () => {
  it("enforces default-deny tables and denies every helper to the API role", async () => {
    for (const table of tables) {
      const r = (await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass", ["clinical_private." + table])).rows[0];
      expect(r).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      await expect(call(`select * from clinical_private.${table}`)).rejects.toThrow("permission denied");
    }
    await expect(call("select clinical_private.lock_recording_encounter($1)", [randomUUID()])).rejects.toThrow("permission denied");
    await expect(call("select clinical_private.recording_grants_for_scope($1,'recording',$2::uuid[])", [randomUUID(), []])).rejects.toThrow("permission denied");
  });
  it("rejects consumer, staff, cross-organization and missing encounter access", async () => {
    const e = await encounter(), sql = "select clinical_private.add_encounter_recording_participant($1,'patient','FICTIONAL',true,gen_random_uuid()) as result";
    await expect(call(sql, [e], consumer, "consumer")).rejects.toThrow();
    await expect(call(sql, [e], staff)).rejects.toThrow("clinical_role_required");
    await expect(call(sql, [e], outsider, "workforce", otherOrg)).rejects.toThrow();
    await expect(call(sql, [randomUUID()])).rejects.toThrow("recording_access_refused");
  });
  it("requires an intact, current, same-organization consent release", async () => {
    const p = (await participant(await encounter()))!;
    for (const d of [randomUUID(), await release("recording", { corrupt: true }), await release("recording", { future: true }),
      await release("recording", { organization: otherOrg })]) await expect(grant(p, d)).rejects.toThrow("recording_consent_release_required");
    const retired = await release();
    await db.query("update clinical_private.recording_consent_releases set retired_at=clock_timestamp() where id=$1", [retired]);
    await expect(grant(p, retired)).rejects.toThrow("recording_consent_release_required");
  });
  it("binds idempotent consent receipts to exact command content, without resurrecting withdrawal", async () => {
    const p = (await participant(await encounter()))!, d = await release(), command = randomUUID();
    const id = (await grant(p, d, command))!;
    expect(await grant(p, d, command)).toBe(id);
    await expect(grant(p, null, command)).rejects.toThrow("recording_consent_conflict");
    await expect(grant(p, await release(), command)).rejects.toThrow("recording_consent_conflict");
    await withdraw(id); expect(await grant(p, d, command)).toBe(id);
    expect((await db.query("select * from clinical_private.recording_consent_withdrawals where grant_id=$1", [id])).rows).toHaveLength(1);
  });
  it("requires reviewed participant-specific representative authority", async () => {
    const p = (await participant(await encounter(), "patient", false))!, d = await release();
    await expect(grant(p, d)).rejects.toThrow("recording_representative_authority_required");
    const a = randomUUID();
    await db.query(`insert into clinical_private.recording_representative_authorities
      (id,participant_id,basis,representative_name,evidence_sha256,reviewed_by,reviewed_at,expires_at)
      values($1,$2,'minor_guardian','FICTIONAL GUARDIAN',repeat('a',64),$3,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')`, [a, p, colleague]);
    expect(await grant(p, d, randomUUID(), a)).toMatch(/^[a-f0-9-]{36}$/);
    const other = (await participant(await encounter(), "patient", false))!;
    await expect(grant(other, d, randomUUID(), a)).rejects.toThrow("recording_representative_authority_required");
  });
  it("requires the roster, every participant's recording consent and a qualified capture release", async () => {
    const e = await encounter(), config = await policy();
    await expect(begin(e, config)).rejects.toThrow("recording_roster_required");
    const p = (await participant(e))!, clinician = (await participant(e, "practitioner"))!, d = await release();
    await grant(p, d);
    await expect(begin(e, config)).rejects.toThrow("recording_consent_required");
    await grant(clinician, d);
    await expect(begin(e, randomUUID())).rejects.toThrow("recording_capture_release_required");
    await expect(begin(e, await policy({ provider: "unapproved", region: "us-east-2", maxRecordingBytes: 100, audioRetentionHours: 24 }))).rejects.toThrow("recording_capture_release_required");
    await expect(begin(e, await policy({ provider: "aws_healthscribe", region: "us-east-2", maxRecordingBytes: 100, audioRetentionHours: 25 }))).rejects.toThrow("recording_capture_release_required");
    expect(await begin(e, config)).toMatchObject({ status: "capturing", replayed: false });
  });
  it("stores hashes only, does not replay capture secrets, and refuses competing starts", async () => {
    const f = await ready(), command = randomUUID(), c = (await begin(f.e, f.config, command))!;
    expect(c.captureToken).toMatch(/^[a-f0-9]{64}$/);
    const replay = (await begin(f.e, f.config, command))!;
    expect(replay).toMatchObject({ recordingId: c.recordingId, sessionId: c.sessionId, replayed: true });
    expect(replay).not.toHaveProperty("captureToken");
    await expect(begin(f.e, f.config, command, "audio/mp4")).rejects.toThrow("recording_capture_conflict");
    await expect(begin(f.e, f.config)).rejects.toThrow("recording_disposition_required");
    const persisted = await db.query("select row_to_json(r) as row from clinical_private.encounter_captures r where id=$1", [c.recordingId]);
    expect(JSON.stringify(persisted.rows)).not.toContain(c.captureToken);
    expect(JSON.stringify((await db.query("select * from clinical_private.recording_authority_events where encounter_id=$1", [f.e])).rows))
      .not.toMatch(/FICTIONAL ACK|FICTIONAL PARTICIPANT|captureToken|token_sha256/);
  });
  it("binds capture to actor/session/token/epoch and independently checks each scope", async () => {
    const f = await ready(), c = (await begin(f.e, f.config))!;
    expect(await authorize(c)).toMatchObject({ recordingId: c.recordingId, scope: "recording" });
    await expect(authorize({ ...c, sessionId: randomUUID() })).rejects.toThrow("recording_capture_refused");
    await expect(authorize({ ...c, captureToken: "0".repeat(64) })).rejects.toThrow("recording_capture_refused");
    await expect(authorize(c, "recording", colleague)).rejects.toThrow("recording_capture_refused");
    await expect(authorize(c, "transcription")).rejects.toThrow("recording_consent_required");
    const d = await release("transcription"); await grant(f.p, d); await grant(f.clinician, d);
    expect(await authorize(c, "transcription")).toMatchObject({ scope: "transcription" });
    await expect(authorize(c, "ai_drafting")).rejects.toThrow("recording_consent_required");
    await expect(authorize(c, "invented")).rejects.toThrow("recording_consent_required");
  });
  it("late join pauses and invalidates the old epoch even after the new participant consents", async () => {
    const f = await ready(), c = (await begin(f.e, f.config))!, late = (await participant(f.e, "caregiver"))!;
    await grant(late, f.d);
    await expect(authorize(c)).rejects.toThrow("recording_capture_refused");
    const row = (await db.query<{ status: string; epoch: number }>(`select r.status,c.authority_epoch::int epoch
      from clinical_private.encounter_captures r join clinical_private.recording_controls c on c.encounter_id=r.encounter_id where r.id=$1`, [c.recordingId])).rows[0];
    expect(row.status).toBe("paused"); expect(row.epoch).toBeGreaterThan(c.authorityEpoch);
  });
  it("withdrawal of transcription revokes capture and re-consent cannot revive an old token", async () => {
    const f = await ready(), d = await release("transcription");
    const grantId = (await grant(f.p, d))!; await grant(f.clinician, d);
    const c = (await begin(f.e, f.config))!;
    await withdraw(grantId); await grant(f.p, d);
    await expect(authorize(c)).rejects.toThrow("recording_capture_refused");
    await expect(begin(f.e, f.config)).rejects.toThrow("recording_disposition_required");
    expect((await db.query<{ status: string }>("select status from clinical_private.encounter_captures where id=$1", [c.recordingId])).rows[0].status).toBe("revoked");
  });
  it("expires authorization and rechecks release retirement and encounter closure", async () => {
    const f = await ready(), c = (await begin(f.e, f.config))!;
    await db.query("update clinical_private.encounter_captures set token_expires_at=clock_timestamp()-interval '1 second' where id=$1", [c.recordingId]);
    await expect(authorize(c)).rejects.toThrow("recording_capture_refused");
    const next = await ready(), fresh = (await begin(next.e, next.config))!;
    await db.query("update clinical_private.recording_capture_releases set retired_at=clock_timestamp() where id=$1", [next.config]);
    await expect(authorize(fresh)).rejects.toThrow("recording_capture_release_required");
    const closed = await ready(), active = (await begin(closed.e, closed.config))!;
    await db.query("update clinical_core.encounters set status='completed' where id=$1", [closed.e]);
    await expect(authorize(active)).rejects.toThrow("recording_capture_refused");
  });
  it("keeps grant/withdrawal/events and release content immutable", async () => {
    const f = await ready(); await withdraw(f.pGrant);
    await expect(db.query("update clinical_private.recording_consent_grants set acknowledgment='changed' where id=$1", [f.pGrant])).rejects.toThrow();
    await expect(db.query("delete from clinical_private.recording_consent_withdrawals where grant_id=$1", [f.pGrant])).rejects.toThrow();
    await expect(db.query("delete from clinical_private.recording_authority_events where encounter_id=$1", [f.e])).rejects.toThrow();
    await expect(db.query("update clinical_private.recording_consent_releases set content='changed' where id=$1", [f.d])).rejects.toThrow("recording_release_immutable");
    await db.query("update clinical_private.recording_consent_releases set retired_at=clock_timestamp() where id=$1", [f.d]);
    await expect(db.query("update clinical_private.recording_consent_releases set retired_at=null where id=$1", [f.d])).rejects.toThrow("recording_release_immutable");
  });
  it.each(["provider", "region", "maxRecordingBytes", "audioRetentionHours"])("refuses null or missing %s in a capture release without writing a capture or audit event", async key => {
    const f = await ready();
    const before = (await db.query("select * from clinical_private.recording_authority_events where encounter_id=$1", [f.e])).rows;
    for (const missing of [false, true]) {
      const configuration: Record<string, unknown> = { provider: "aws_healthscribe", region: "us-east-2", maxRecordingBytes: 100, audioRetentionHours: 1 };
      if (missing) delete configuration[key]; else configuration[key] = null;
      await expect(begin(f.e, await policy(configuration))).rejects.toThrow("recording_capture_release_required");
    }
    expect((await db.query("select * from clinical_private.encounter_captures where encounter_id=$1", [f.e])).rows).toEqual([]);
    expect((await db.query("select * from clinical_private.recording_authority_events where encounter_id=$1", [f.e])).rows).toEqual(before);
  });
  it("rechecks representative revocation on every authorization and preserves the reviewed evidence", async () => {
    const e = await encounter(), p = (await participant(e, "patient", false))!, clinician = (await participant(e, "practitioner"))!;
    const a = randomUUID(), d = await release();
    await db.query(`insert into clinical_private.recording_representative_authorities
      (id,participant_id,basis,representative_name,evidence_sha256,reviewed_by,reviewed_at,expires_at)
      values($1,$2,'minor_guardian','FICTIONAL GUARDIAN',repeat('b',64),$3,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')`, [a, p, colleague]);
    await grant(p, d, randomUUID(), a); await grant(clinician, d);
    const c = (await begin(e, await policy()))!;
    expect(await authorize(c)).toMatchObject({ scope: "recording" });
    await expect(db.query("update clinical_private.recording_representative_authorities set evidence_sha256=repeat('c',64) where id=$1", [a])).rejects.toThrow("recording_authority_immutable");
    await db.query("update clinical_private.recording_representative_authorities set revoked_at=clock_timestamp() where id=$1", [a]);
    await expect(authorize(c)).rejects.toThrow("recording_consent_required");
    await expect(db.query("update clinical_private.recording_representative_authorities set revoked_at=null where id=$1", [a])).rejects.toThrow("recording_authority_immutable");
    await expect(db.query("delete from clinical_private.recording_representative_authorities where id=$1", [a])).rejects.toThrow("recording_authority_immutable");
  });
  it("rechecks workforce membership instead of trusting an issued capture token", async () => {
    const f = await ready(), c = (await begin(f.e, f.config))!;
    await db.query("update clinical_core.organization_memberships set role='staff' where organization_id=$1 and person_id=$2", [org, actor]);
    try { await expect(authorize(c)).rejects.toThrow("clinical_role_required"); }
    finally { await db.query("update clinical_core.organization_memberships set role='practitioner' where organization_id=$1 and person_id=$2", [org, actor]); }
  });
  it("roster command replay preserves participant and epoch; changed content or actor is a conflict", async () => {
    const e = await encounter(), command = randomUUID();
    const sql = "select clinical_private.add_encounter_recording_participant($1,$2,$3,$4,$5) as result";
    const args = [e, "patient", "Fictional retry", true, command];
    const id = await call(sql, args);
    expect(await call(sql, args)).toBe(id);
    expect((await db.query<{ epoch: number }>("select authority_epoch::int epoch from clinical_private.recording_controls where encounter_id=$1", [e])).rows[0].epoch).toBe(1);
    expect((await db.query("select * from clinical_private.recording_authority_events where encounter_id=$1", [e])).rows).toHaveLength(1);
    await expect(call(sql, [e, "patient", "Changed", true, command])).rejects.toThrow("recording_participant_conflict");
    await expect(call(sql, args, colleague)).rejects.toThrow("recording_participant_conflict");
    await expect(call("select clinical_private.add_encounter_recording_participant($1,'patient','OLD',true)", [e])).rejects.toThrow("permission denied");
  });
  it("reads only the encounter's bounded consent state, with exact jurisdiction and current withdrawal status", async () => {
    const f = await ready(), c = (await begin(f.e, f.config))!;
    const sql = "select clinical_private.get_encounter_recording_workspace($1,$2,$3) as result";
    const workspace = await call<{ participants: { consents: { status: string; effective: boolean }[] }[]; consentReleases: unknown[]; activeCapture: { id: string } }>(sql, [f.e, "en", "FICTIONAL"]);
    expect(workspace?.participants).toHaveLength(2); expect(workspace?.activeCapture.id).toBe(c.recordingId);
    expect(JSON.stringify(workspace)).not.toMatch(/token_sha256|captureToken|FICTIONAL ACK|evidence_sha256/);
    const unmatched = await call<{ consentReleases: unknown[] }>(sql, [f.e, "en", "UNREVIEWED"]);
    expect(unmatched?.consentReleases).toEqual([]);
    await withdraw(f.pGrant);
    const changed = await call<{ participants: { id: string; consents: { status: string; effective: boolean }[] }[] }>(sql, [f.e, "en", "FICTIONAL"]);
    expect(changed?.participants.find(p => p.id === f.p)?.consents).toEqual([expect.objectContaining({ status: "withdrawn", effective: false })]);
    await expect(call(sql, [f.e, "en", "FICTIONAL"], outsider, "workforce", otherOrg)).rejects.toThrow();
    await expect(call(sql, [f.e, "en", "FICTIONAL"], consumer, "consumer")).rejects.toThrow();
    await expect(call("select clinical_private.read_recording_encounter($1)", [f.e])).rejects.toThrow("permission denied");
    const doc = await call<{ content: string; contentSha256: string }>("select clinical_private.read_encounter_recording_consent_release($1,$2) as result", [f.e, f.d]);
    expect(doc?.content).toBe("FICTIONAL CONSENT ONLY"); expect(doc?.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(call("select clinical_private.read_encounter_recording_consent_release($1,$2) as result", [f.e, await release("recording", { organization: otherOrg })])).rejects.toThrow("recording_consent_release_required");
    const reads = (await db.query("select * from clinical_private.recording_access_events where encounter_id=$1", [f.e])).rows;
    expect(reads).toHaveLength(4);
    expect(JSON.stringify(reads)).not.toMatch(/FICTIONAL|token|content|evidence/);
    await expect(db.query("delete from clinical_private.recording_access_events where encounter_id=$1", [f.e])).rejects.toThrow();
  });
  it("executes the typed workforce API through real production SQL from workspace to consent withdrawal", async () => {
    // This bridge replaces only the RDS transport, not SQL or authorization.
    const database: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => {
      await tx.exec("set local role clinical_core_api");
      return work({ async query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
        const values = parameters.map(p => p && typeof p === "object" && "kind" in p && p.kind === "uuid" && "value" in p ? p.value : p);
        return tx.query<Row>(sql, values);
      } });
    }) };
    const now = Date.now(), seconds = Math.floor(now / 1000), e = await encounter(), d = await release();
    const issuer = "https://cognito-idp.us-east-2.amazonaws.com/FictionalWorkforce", audience = "12345678901234567890";
    const handler = createRecordingAuthorityApi({ configuration: { workforceIssuer: issuer, workforceAudience: audience,
      organizationId: org, phiAllowed: true, activation: "approved", activationEvidenceSha256: "a".repeat(64), mfaReviewSha256: "b".repeat(64), databaseReviewSha256: "c".repeat(64) },
      operations: () => createEncounterRecordingOperations(database), now: () => now });
    const send = async (body: unknown, who = actor) => {
      const event: ApiGatewayV2Event = { routeKey: RECORDING_AUTHORITY_ROUTE, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        requestContext: { authorizer: { jwt: { claims: { iss: issuer, aud: audience, sub: "subject-" + who,
          token_use: "id", "custom:person_id": who, "custom:organization_id": org, "custom:production_bound": "true",
          email_verified: "true", exp: seconds + 600, iat: seconds, auth_time: seconds } } } } };
      return handler(event);
    };
    const workspace = { action: "workspace", encounterId: e, locale: "en", jurisdiction: "FICTIONAL" };
    const empty = await send(workspace); expect(empty.statusCode, empty.body).toBe(200);
    expect(JSON.parse(empty.body).data.participants).toEqual([]);
    const add = { action: "addParticipant", encounterId: e, commandId: randomUUID(), kind: "patient", displayName: "Fictional API patient", canSelfConsent: true };
    const added = await send(add); expect(added.statusCode, added.body).toBe(200);
    const participantId = JSON.parse(added.body).data.participantId;
    expect(JSON.parse((await send(add)).body).data.participantId).toBe(participantId);
    const document = await send({ action: "readConsentRelease", encounterId: e, releaseId: d });
    expect(document.statusCode, document.body).toBe(200);
    expect(JSON.parse(document.body).data.content).toBe("FICTIONAL CONSENT ONLY");
    const granted = await send({ action: "grantConsent", participantId, releaseId: d, commandId: randomUUID(), method: "written", acknowledgment: "FICTIONAL ACK", representativeAuthorityId: null });
    expect(granted.statusCode, granted.body).toBe(200);
    const consentId = JSON.parse(granted.body).data.consentId;
    const withdrawn = await send({ action: "withdrawConsent", consentId, reason: "Fictional withdrawal" });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    const final = await send(workspace);
    expect(JSON.parse(final.body).data.participants[0].consents[0]).toMatchObject({ status: "withdrawn", effective: false });
    expect(JSON.parse(final.body).capabilities.audioCapture).toBe(false);
    expect((await send(workspace, outsider)).statusCode).not.toBe(200);
    expect((await send({ ...workspace, organizationId: otherOrg })).statusCode).toBe(400);
  });
});

describe('durable recording segments: actual SQL, fictional receipts (not S3 evidence)', () => {
  it('runs the typed upload service through actual SQL, outside network locks, including withdrawal during upload', async () => {
    let transactions = 0;
    const database: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => {
      transactions++;
      try {
        await tx.exec('set local role clinical_core_api');
        return await work({ async query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
          const values = parameters.map(p => p && typeof p === 'object' && 'kind' in p && p.kind === 'uuid' && 'value' in p ? p.value : p);
          return tx.query<Row>(sql, values);
        } });
      } finally { transactions--; }
    }) };
    const context: ProductionClinicalRequestContext = { actorPersonId: actor, organizationId: org, identityPool: 'workforce',
      identitySubject: 'subject-' + actor, purpose: 'clinical_data', environment: 'production-clinical',
      dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true };
    const bytes = Buffer.from('FICTIONAL RECORDING BYTES'), sha256 = createHash('sha256').update(bytes).digest('hex');
    for (const revoke of [false, true]) {
      const r = await uploadReady(); let puts = 0;
      const upload = createRecordingSegmentUploader(createRecordingSegmentRepository(database), {
        async put() {
          expect(transactions).toBe(0); puts++;
          if (revoke) await withdraw(r.pGrant);
          return { version: 'fictional-storage-version' };
        },
        async head(s) {
          expect(transactions).toBe(0);
          return { version: 'fictional-storage-version', bytes: bytes.length, contentType: s.contentType,
            checksum: Buffer.from(sha256, 'hex').toString('base64'), checksumType: 'FULL_OBJECT', encryption: 'aws:kms', kmsKeyArn: s.storage.kmsKeyArn,
            metadata: { 'segment-id': s.segmentId, 'recording-id': s.recordingId, 'session-id': s.sessionId, 'authority-epoch': String(s.authorityEpoch) } };
        },
      });
      const input = { recordingId: r.capture.recordingId, sessionId: r.capture.sessionId, captureToken: r.capture.captureToken,
        sequence: 0, sha256, bytes: bytes.length };
      if (revoke) {
        await expect(upload(context, input, bytes)).rejects.toThrow();
        expect((await db.query<{ status: string }>('select status from clinical_private.recording_segments where recording_id=$1', [r.capture.recordingId])).rows[0].status).toBe('reserved');
      } else {
        const receipt = await upload(context, input, bytes);
        expect(receipt.status).toBe('stored');
        expect(await upload(context, input, bytes)).toEqual(receipt);
      }
      expect(puts).toBe(1);
    }
  });
  it('requires separately reviewed storage and rejects API access to its helper', async () => {
    const r = await ready(), c = (await begin(r.e, r.config))!;
    await expect(reserveSegment(c)).rejects.toThrow('recording_storage_release_required');
    await expect(call('select clinical_private.require_recording_storage_release($1,$2)', [r.config, org])).rejects.toThrow('permission denied');
  });
  it.each([
    { bucket: null }, { expectedBucketOwner: '999999999999' }, { region: 'us-west-2' },
    { kmsKeyArn: 'arn:aws:kms:us-east-2:123456789012:key/------------------------------------' },
    { maxSegmentBytes: null }, { maxSegmentBytes: 4194305 }, { endpoint: 'https://unapproved.invalid' },
  ])('refuses malformed or mismatched reviewed storage %j', async patch => {
    const r = await ready(); await storageRelease(r.config, { ...storageConfig, ...patch });
    await expect(reserveSegment((await begin(r.e, r.config))!)).rejects.toThrow('recording_storage_release_required');
  });
  it('reserves once, pins consent provenance and returns a stable receipt on exact replay', async () => {
    const r = await uploadReady(), s = (await reserveSegment(r.capture))!;
    const replay = (await reserveSegment(r.capture))!;
    expect(replay.segmentId).toBe(s.segmentId);
    expect(replay.objectKey).toBe(s.objectKey);
    expect(s.status).toBe('reserved'); expect(s.objectVersion).toBeNull();
    const stored = (await db.query<{ participant_ids: string[]; recording_grant_ids: string[] }>(
      'select participant_ids,recording_grant_ids from clinical_private.recording_segments where id=$1', [s.segmentId])).rows[0];
    expect(new Set(stored.participant_ids)).toEqual(new Set([r.p, r.clinician]));
    expect(new Set(stored.recording_grant_ids)).toEqual(new Set([r.pGrant, r.clinicianGrant]));
    const receipt = await completeSegment(r.capture, s);
    expect(await completeSegment(r.capture, s)).toEqual(receipt);
    expect((await reserveSegment(r.capture))?.status).toBe('stored');
    const events = await db.query<{ action: string }>('select action from clinical_private.recording_segment_events where segment_id=$1 order by created_at', [s.segmentId]);
    expect(events.rows.map(e => e.action)).toEqual(['segment.reserved', 'segment.stored']);
  });
  it('rejects altered bytes, digest, version, sparse ordering and an outstanding predecessor', async () => {
    const r = await uploadReady();
    await expect(reserveSegment(r.capture, 1)).rejects.toThrow('recording_segment_order_required');
    const s = (await reserveSegment(r.capture))!;
    await expect(reserveSegment(r.capture, 0, 'b'.repeat(64))).rejects.toThrow('recording_segment_conflict');
    await expect(reserveSegment(r.capture, 0, s.sha256, 4)).rejects.toThrow('recording_segment_conflict');
    await expect(reserveSegment(r.capture, 1)).rejects.toThrow('recording_segment_order_required');
    await expect(completeSegment(r.capture, { ...s, sha256: 'b'.repeat(64) })).rejects.toThrow('recording_segment_conflict');
    await expect(completeSegment(r.capture, s, 'null')).rejects.toThrow('recording_segment_conflict');
    await completeSegment(r.capture, s);
    await expect(completeSegment(r.capture, s, 'another-version')).rejects.toThrow('recording_segment_conflict');
    expect((await reserveSegment(r.capture, 1))?.sequence).toBe(1);
  });
  it('counts all reserved bytes against the recording budget and validates chunk bounds', async () => {
    const r = await uploadReady();
    for (const [seq, bytes] of [[-1, 1], [4096, 1], [0, 0], [0, 1000001]])
      await expect(reserveSegment(r.capture, seq, 'a'.repeat(64), bytes)).rejects.toThrow('recording_segment_invalid');
    const s = (await reserveSegment(r.capture, 0, 'a'.repeat(64), 1000000))!;
    await completeSegment(r.capture, s);
    await expect(reserveSegment(r.capture, 1)).rejects.toThrow('recording_size_limit');
  });
  it('cannot accept an object after withdrawal or a late participant; the pending row survives for cleanup', async () => {
    for (const change of ['withdraw', 'participant']) {
      const r = await uploadReady(), s = (await reserveSegment(r.capture))!;
      if (change === 'withdraw') await withdraw(r.pGrant); else await participant(r.e, 'caregiver');
      await expect(completeSegment(r.capture, s)).rejects.toThrow('recording_capture_refused');
      expect((await db.query<{ status: string }>('select status from clinical_private.recording_segments where id=$1', [s.segmentId])).rows[0].status).toBe('reserved');
    }
  });
  it('denies another actor and rechecks storage retirement after reservation', async () => {
    const r = await uploadReady();
    await expect(reserveSegment(r.capture, 0, 'a'.repeat(64), 3, colleague)).rejects.toThrow('recording_capture_refused');
    const s = (await reserveSegment(r.capture))!;
    await db.query('update clinical_private.recording_storage_releases set retired_at=clock_timestamp() where id=$1', [r.storageReleaseId]);
    await expect(completeSegment(r.capture, s)).rejects.toThrow('recording_storage_release_required');
  });
  it('requires a renewed authority-checked reservation after its lease expires', async () => {
    const r = await uploadReady(), s = (await reserveSegment(r.capture))!;
    await db.query("update clinical_private.recording_segments set accept_before=clock_timestamp()-interval '1 second' where id=$1", [s.segmentId]);
    await expect(completeSegment(r.capture, s)).rejects.toThrow('recording_reservation_expired');
    const renewed = (await reserveSegment(r.capture))!;
    expect(renewed.segmentId).toBe(s.segmentId);
    expect(await completeSegment(r.capture, renewed)).toMatchObject({ status: 'stored' });
  });
  it('protects source provenance, accepted receipts and event rows from mutation', async () => {
    const r = await uploadReady(), s = (await reserveSegment(r.capture))!;
    await expect(db.query('update clinical_private.recording_segments set content_sha256=$1 where id=$2', ['b'.repeat(64), s.segmentId])).rejects.toThrow('recording_segment_immutable');
    await completeSegment(r.capture, s);
    await expect(db.query('update clinical_private.recording_segments set accept_before=clock_timestamp() where id=$1', [s.segmentId])).rejects.toThrow('recording_segment_immutable');
    await expect(db.query('delete from clinical_private.recording_segment_events where segment_id=$1', [s.segmentId])).rejects.toThrow();
  });
  it('exposes only bounded recovery state to the owning authorized practitioner', async () => {
    const r = await uploadReady(), c = r.capture;
    const state = (await recoveryState(c))!;
    expect(state).toMatchObject({ recordingId: c.recordingId, sessionId: c.sessionId, status: 'capturing',
      credentialVersion: 0, storedSegments: 0, pendingSegments: 0, reservedBytes: 0, nextSequence: 0,
      disposition: null, processingRequested: false, audioDeleted: false });
    expect(JSON.stringify(state)).not.toMatch(/captureToken|objectKey|FICTIONAL|token_sha256/);
    await expect(recoveryState(c, colleague)).rejects.toThrow('recording_access_refused');
    await expect(recoveryState(c, consumer, 'consumer')).rejects.toThrow();
    await expect(recoveryState(c, outsider, 'workforce', otherOrg)).rejects.toThrow();
    await expect(recoveryState(c, staff)).rejects.toThrow('clinical_role_required');
    await expect(call('select clinical_private.recording_segment_inventory($1)', [c.recordingId])).rejects.toThrow('permission denied');
    await expect(call('select clinical_private.lock_owned_recording($1)', [c.recordingId])).rejects.toThrow('permission denied');
    await expect(lifecycle(c, 'pause', 0, null, randomUUID(), colleague)).rejects.toThrow('recording_access_refused');
  });
  it('pauses, rotates and renews credentials without replaying secrets or accepting the old token', async () => {
    const r = await uploadReady(), c = r.capture, pauseId = randomUUID(), resumeId = randomUUID();
    expect(await lifecycle(c, 'pause', 0, null, pauseId)).toMatchObject({ statusAtCommand: 'paused', credentialVersion: 1, captureToken: null });
    await expect(authorize(c)).rejects.toThrow('recording_capture_refused');
    const resumed = (await lifecycle(c, 'resume', 1, null, resumeId))!;
    expect(resumed).toMatchObject({ statusAtCommand: 'capturing', credentialVersion: 2, requiresCredentialRecovery: false });
    expect(resumed.captureToken).toMatch(/^[a-f0-9]{64}$/);
    expect(resumed.captureToken).not.toBe(c.captureToken);
    expect(await authorize({ ...c, captureToken: resumed.captureToken! })).toMatchObject({ scope: 'recording' });
    await expect(authorize(c)).rejects.toThrow('recording_capture_refused');
    expect(await lifecycle(c, 'resume', 1, null, resumeId)).toMatchObject({ replayed: true, captureToken: null, requiresCredentialRecovery: true });
    // A late command retry is a historical receipt, not a change back to paused.
    expect(await lifecycle(c, 'pause', 0, null, pauseId)).toMatchObject({ replayed: true, statusAtCommand: 'paused' });
    expect((await recoveryState(c))?.status).toBe('capturing');
    await db.query("update clinical_private.encounter_captures set token_expires_at=clock_timestamp()-interval '1 second' where id=$1", [c.recordingId]);
    await expect(authorize({ ...c, captureToken: resumed.captureToken! })).rejects.toThrow('recording_capture_refused');
    const renewed = (await lifecycle(c, 'renew', 2))!;
    expect(await authorize({ ...c, captureToken: renewed.captureToken! })).toMatchObject({ scope: 'recording' });
    expect(renewed.credentialVersion).toBe(3);
    const persisted = JSON.stringify((await db.query('select receipt from clinical_private.recording_lifecycle_commands where recording_id=$1', [c.recordingId])).rows);
    expect(persisted).not.toContain(resumed.captureToken); expect(persisted).not.toContain(renewed.captureToken);
    expect(persisted).not.toContain('captureToken');
  });
  it('uses command identity and expected credential version to refuse stale or conflicting devices', async () => {
    const c = (await uploadReady()).capture, command = randomUUID();
    await lifecycle(c, 'renew', 0, null, command);
    await expect(lifecycle(c, 'pause', 0, null, command)).rejects.toThrow('recording_lifecycle_conflict');
    await expect(lifecycle(c, 'renew', 1, null, command)).rejects.toThrow('recording_lifecycle_conflict');
    await expect(lifecycle(c, 'renew', 0)).rejects.toThrow('recording_lifecycle_conflict');
    const attempts = await Promise.allSettled([lifecycle(c, 'renew', 1), lifecycle(c, 'renew', 1)]);
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(1);
    // PGlite serializes transactions; this tests CAS semantics, not a multi-session Aurora lock exercise.
    expect((await recoveryState(c))?.credentialVersion).toBe(2);
  });
  it.each([
    [null, 0, null], ['invented', 0, null], ['pause', null, null], ['pause', -1, null],
    ['pause', Number.MAX_SAFE_INTEGER, null], ['pause', 0, 'a'.repeat(64)], ['finish', 0, null], ['discard', 0, 'bad'],
  ])('rejects invalid lifecycle action/version/inventory %j %j %j', async (action, version, inventory) => {
    const c = (await uploadReady()).capture;
    await expect(lifecycle(c, action as string | null, version as number | null, inventory as string | null)).rejects.toThrow('recording_lifecycle_invalid');
    expect((await recoveryState(c))?.credentialVersion).toBe(0);
  });
  it.each(['withdrawal', 'late-participant', 'storage-retired', 'capture-retired', 'consent-retired', 'expired', 'completed'])
    ('refuses credential recovery after %s and does not mint or save a token', async reason => {
      const r = await uploadReady(), c = r.capture;
      await lifecycle(c, 'pause', 0);
      if (reason === 'withdrawal') { await withdraw(r.pGrant); await grant(r.p, r.d); }
      if (reason === 'late-participant') { const p = (await participant(r.e, 'caregiver'))!; await grant(p, r.d); }
      if (reason === 'storage-retired') await db.query('update clinical_private.recording_storage_releases set retired_at=clock_timestamp() where id=$1', [r.storageReleaseId]);
      if (reason === 'capture-retired') await db.query('update clinical_private.recording_capture_releases set retired_at=clock_timestamp() where id=$1', [r.config]);
      if (reason === 'consent-retired') await db.query('update clinical_private.recording_consent_releases set retired_at=clock_timestamp() where id=$1', [r.d]);
      if (reason === 'expired') await db.query("update clinical_private.encounter_captures set deletion_deadline=clock_timestamp()-interval '1 second' where id=$1", [c.recordingId]);
      if (reason === 'completed') await db.query("update clinical_core.encounters set status='completed' where id=$1", [r.e]);
      await expect(lifecycle(c, 'resume', 1)).rejects.toThrow();
      expect((await recoveryState(c))?.credentialVersion).toBe(1);
      expect((await db.query('select * from clinical_private.recording_lifecycle_commands where recording_id=$1', [c.recordingId])).rows).toHaveLength(1);
    });
  it('refuses to renew without separately qualified storage', async () => {
    const r = await ready(), c = (await begin(r.e, r.config))!;
    await expect(lifecycle(c, 'renew', 0)).rejects.toThrow('recording_storage_release_required');
  });
  it('requires exact inventory review and resolved stored segments before finish', async () => {
    const r = await uploadReady(), c = r.capture, empty = (await recoveryState(c))!;
    await expect(lifecycle(c, 'finish', 0, empty.inventorySha256)).rejects.toThrow('recording_segments_unresolved');
    const segment = (await reserveSegment(c))!, pending = (await recoveryState(c))!;
    expect(pending).toMatchObject({ storedSegments: 0, pendingSegments: 1, reservedBytes: 3, nextSequence: 1 });
    await expect(lifecycle(c, 'finish', 0, pending.inventorySha256)).rejects.toThrow('recording_segments_unresolved');
    await completeSegment(c, segment);
    await expect(lifecycle(c, 'finish', 0, pending.inventorySha256)).rejects.toThrow('recording_inventory_changed');
    const complete = (await recoveryState(c))!, command = randomUUID();
    expect(complete).toMatchObject({ storedSegments: 1, pendingSegments: 0 });
    expect(await lifecycle(c, 'finish', 0, complete.inventorySha256, command)).toMatchObject({
      statusAtCommand: 'closed', credentialVersion: 1, processingRequested: false, audioDeleted: false });
    expect(await lifecycle(c, 'finish', 0, complete.inventorySha256, command)).toMatchObject({ replayed: true, captureToken: null });
    expect(await recoveryState(c)).toMatchObject({ status: 'closed', disposition: 'finish' });
    await expect(lifecycle(c, 'renew', 1)).rejects.toThrow('recording_lifecycle_conflict');
    await expect(authorize(c)).rejects.toThrow('recording_capture_refused');
    const inventory = (await db.query<{ inventory: unknown }>('select inventory from clinical_private.recording_dispositions where recording_id=$1', [c.recordingId])).rows[0].inventory;
    expect(inventory).toEqual([expect.objectContaining({ segmentId: segment.segmentId, objectVersion: 'fictional-version-1',
      sha256: segment.sha256, bytes: 3, status: 'stored' })]);
    expect((await begin(r.e, r.config))?.recordingId).not.toBe(c.recordingId);
  });
  it('late join permits explicit finish of existing consented bytes but never resumes the old roster', async () => {
    const r = await uploadReady(), c = r.capture, s = (await reserveSegment(c))!;
    await completeSegment(c, s);
    const p = (await participant(r.e, 'caregiver'))!; await grant(p, r.d);
    await expect(lifecycle(c, 'resume', 0)).rejects.toThrow('recording_disposition_required');
    await lifecycle(c, 'finish', 0, (await recoveryState(c))!.inventorySha256);
    const next = (await begin(r.e, r.config))!;
    expect(next.authorityEpoch).toBeGreaterThan(c.authorityEpoch);
  });
  it('discard closes revoked or pending capture without pretending deletion or deleting provenance', async () => {
    const r = await uploadReady(), c = r.capture, s = (await reserveSegment(c))!;
    await withdraw(r.pGrant);
    const state = (await recoveryState(c))!;
    await expect(lifecycle(c, 'finish', 0, state.inventorySha256)).rejects.toThrow('recording_capture_refused');
    expect(await lifecycle(c, 'discard', 0, state.inventorySha256)).toMatchObject({ statusAtCommand: 'closed', audioDeleted: false, processingRequested: false });
    expect(await recoveryState(c)).toMatchObject({ status: 'closed', disposition: 'discard', pendingSegments: 1 });
    expect((await db.query<{ status: string }>('select status from clinical_private.recording_segments where id=$1', [s.segmentId])).rows[0].status).toBe('reserved');
    await expect(completeSegment(c, s)).rejects.toThrow('recording_capture_refused');
    for (const table of ['recording_dispositions', 'recording_lifecycle_commands', 'recording_lifecycle_events'])
      await expect(db.query(`delete from clinical_private.${table} where recording_id=$1`, [c.recordingId])).rejects.toThrow();
    await grant(r.p, r.d);
    expect((await begin(r.e, r.config))?.recordingId).not.toBe(c.recordingId);
  });
  it('drives typed lifecycle repository through real SQL with no storage or provider call', async () => {
    const r = await uploadReady(), c = r.capture;
    const database: ClinicalCoreDatabase = { transaction: operation => db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      return operation({ query: async (sql, args = []) => tx.query(sql,
        args.map(v => typeof v === 'object' && v !== null && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v)) });
    }) };
    const context = { actorPersonId: actor, organizationId: org, identityPool: 'workforce', identitySubject: 'subject-' + actor,
      purpose: 'clinical_data', environment: 'production-clinical', dataClassification: 'clinical_phi', productionBound: true,
      containsPhi: true, realPatientData: true } as ProductionClinicalRequestContext;
    const repository = createRecordingLifecycleRepository(database);
    expect(await repository.state(context, c.recordingId)).toMatchObject({ credentialVersion: 0 });
    const command = { recordingId: c.recordingId, commandId: randomUUID(), action: 'renew', expectedVersion: 0, inventorySha256: null };
    expect(await repository.command(context, command)).toMatchObject({ action: 'renew', credentialVersion: 1 });
    expect(await repository.command(context, command)).toMatchObject({ captureToken: null, requiresCredentialRecovery: true, replayed: true });
  });
  it('requires reviewed storage before qualified start and caps the initial credential to the release expiry', async () => {
    const r = await ready(), command = randomUUID();
    const start = () => call<Record<string, unknown>>('select clinical_private.start_qualified_recording_capture($1,$2,$3,$4) as result',
      [r.e, r.config, command, 'audio/webm']);
    await expect(start()).rejects.toThrow('recording_storage_release_required');
    expect((await db.query('select * from clinical_private.encounter_captures where encounter_id=$1', [r.e])).rows).toHaveLength(0);
    const storage = randomUUID();
    await db.query(`insert into clinical_private.recording_storage_releases
      (id,capture_release_id,configuration,configuration_sha256,qualification_sha256,approved_by,approved_at,expires_at)
      values($1,$2,$3::jsonb,encode(public.digest(($3::jsonb)::text,'sha256'),'hex'),repeat('b',64),
      'FICTIONAL STORAGE QUALIFICATION',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '60 seconds')`,
      [storage, r.config, JSON.stringify(storageConfig)]);
    const first = (await start())!, replay = (await start())!;
    expect(first).toMatchObject({ encounterId: r.e, commandId: command, replayed: false, status: 'capturing', credentialVersion: 0 });
    expect(first.captureToken).toMatch(/^[a-f0-9]{64}$/);
    expect(replay).toMatchObject({ recordingId: first.recordingId, replayed: true, captureToken: null });
    const expiry = (await db.query<{ expires: string }>('select expires_at::text expires from clinical_private.recording_storage_releases where id=$1', [storage])).rows[0].expires;
    expect(Date.parse(first.expiresAt as string)).toBe(Date.parse(expiry));
    await db.query('update clinical_private.recording_storage_releases set retired_at=clock_timestamp() where id=$1', [storage]);
    await expect(start()).rejects.toThrow('recording_storage_release_required');
  });
  it('executes the workforce capture API through actual SQL and simulated versioned storage, including withdrawal during upload', async () => {
    for (const revoke of [false, true]) {
      const r = await ready(); await storageRelease(r.config);
      let transactions = 0, puts = 0;
      const database: ClinicalCoreDatabase = { transaction: operation => db.transaction(async tx => {
        transactions++; await tx.exec('set local role clinical_core_api');
        try { return await operation({ query: (sql, args = []) => tx.query(sql, args.map(v =>
          typeof v === 'object' && v !== null && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v)) }); }
        finally { transactions--; }
      }) };
      const now = Date.now(), seconds = Math.floor(now / 1000), bytes = Buffer.from('FICTIONAL ENDPOINT AUDIO');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const configuration = { workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/fictional', workforceAudience: '12345678901234567890',
        organizationId: org, phiAllowed: true, activation: 'approved' as const, activationEvidenceSha256: 'a'.repeat(64), mfaReviewSha256: 'b'.repeat(64),
        databaseReviewSha256: 'c'.repeat(64), captureReleaseId: r.config, captureReviewSha256: 'd'.repeat(64), storageReviewSha256: 'e'.repeat(64), retentionReviewSha256: 'f'.repeat(64) };
      const request = (route: string, body: unknown): ApiGatewayV2Event => ({ routeKey: route, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
        requestContext: { authorizer: { jwt: { claims: { iss: configuration.workforceIssuer, aud: configuration.workforceAudience, sub: 'subject-' + actor,
          'custom:person_id': actor, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: 'true', token_use: 'id',
          exp: seconds + 600, iat: seconds, auth_time: seconds } } } } });
      const upload = createRecordingSegmentUploader(createRecordingSegmentRepository(database), {
        async put() { expect(transactions).toBe(0); puts++; if (revoke) await withdraw(r.pGrant); return { version: 'fictional-version' }; },
        async head(s) { expect(transactions).toBe(0); return { version: 'fictional-version', bytes: bytes.length, contentType: s.contentType,
          checksum: Buffer.from(sha256, 'hex').toString('base64'), checksumType: 'FULL_OBJECT', encryption: 'aws:kms', kmsKeyArn: s.storage.kmsKeyArn,
          metadata: { 'segment-id': s.segmentId, 'recording-id': s.recordingId, 'session-id': s.sessionId, 'authority-epoch': String(s.authorityEpoch) } }; },
      });
      const api = createRecordingCaptureApi({ configuration, lifecycle: () => createRecordingLifecycleRepository(database), upload: () => upload,
        reconcile: () => createRecordingReconciler(createRecordingReconciliationRepository(database), { async head() { throw new Error('unused test storage'); } }), now: () => now });
      const readyResponse=await api(request(captureRoutes.readiness,{encounterId:r.e}));
      expect(readyResponse.statusCode).toBe(200);
      expect(recordingReadinessSchema.parse(JSON.parse(readyResponse.body).data)).toMatchObject({encounterId:r.e,ready:true,captureStarted:false});
      expect(puts).toBe(0);
      const startEvent = request(captureRoutes.start, { encounterId: r.e, commandId: randomUUID(), contentType: 'audio/webm' });
      const startResponse = await api(startEvent); expect(startResponse.statusCode).toBe(200);
      const capture = JSON.parse(startResponse.body).data as Capture;
      expect(JSON.parse((await api(startEvent)).body).data).toMatchObject({ recordingId: capture.recordingId, captureToken: null, replayed: true });
      const segmentEvent = { ...request(captureRoutes.segment, {}), isBase64Encoded: true, body: bytes.toString('base64'), headers: { 'content-type': 'audio/webm',
        'x-alp-recording-id': capture.recordingId, 'x-alp-session-id': capture.sessionId, 'x-alp-capture-token': capture.captureToken,
        'x-alp-sequence': '0', 'x-alp-sha256': sha256 } };
      expect((await api({ ...segmentEvent, body: Buffer.from('ALTERED').toString('base64') })).statusCode).toBe(400);
      expect(puts).toBe(0);
      const uploaded = await api(segmentEvent);
      if (revoke) {
        // This embedded driver intentionally has no AWS error-envelope adapter;
        // the independent RDS mapping suite proves the deployed 403 category.
        expect(uploaded.statusCode).toBe(503);
        expect((await db.query<{ status: string }>('select status from clinical_private.recording_segments where recording_id=$1', [capture.recordingId])).rows[0].status).toBe('reserved');
      } else {
        expect(uploaded.statusCode).toBe(200); expect((await api(segmentEvent)).body).toBe(uploaded.body);
        const state = JSON.parse((await api(request(captureRoutes.state, { recordingId: capture.recordingId }))).body).data as RecordingRecoveryState;
        expect(state).toMatchObject({ storedSegments: 1, pendingSegments: 0, nextSequence: 1 });
        expect((await api(request(captureRoutes.command, { recordingId: capture.recordingId, commandId: randomUUID(), action: 'finish',
          expectedVersion: 0, inventorySha256: state.inventorySha256 }))).statusCode).toBe(200);
        expect(await recoveryState(capture)).toMatchObject({ status: 'closed', disposition: 'finish', processingRequested: false, audioDeleted: false });
      }
      expect(puts).toBe(1);
    }
  });
});
