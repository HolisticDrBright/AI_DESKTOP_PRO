-- ============================================================
-- Test: 0022 consent-gated recording + AI scribe (Milestone 1)
--
-- Rolled-back, against the real project. Proves, with role switching:
--   - cross-organization references refused (42501) on consent + recording RPCs
--   - consent gate: no participants / partial consent → begin_recording 55000
--   - representative authority required when a participant cannot self-consent
--   - ACTIVE revocation: withdrawal revokes live authorizations + session and
--     pauses capture immediately; heartbeat/chunk/resume/completion all refuse
--   - late participant join pauses capture until identified + consented
--   - capture tokens: opaque (raw value stored nowhere), bound to recording +
--     object + action + size; chunk tokens cannot complete uploads; replay
--     against another recording refused; expiry enforced; rotation via heartbeat
--   - provider enablement: aws_healthscribe refused without a fully configured,
--     enabled row (an enabled flag alone is NOT sufficient)
--   - state machine: forward-only; duplicate callbacks idempotent; backward
--     transitions → 40003; quarantine on content-validation failure
--   - raw ASR immutable; provider revisions + practitioner corrections are
--     separate versioned layers; transcript revision tracks both
--   - scribe drafts NEVER overwrite practitioner notes (always a new note),
--     idempotent per (transcript, revision, template), consent-gated
--   - durable deletion: legal hold blocks; failed job leaves deletion_pending;
--     'deleted' only after every job confirms; terminal thereafter
--   - audit domains: access events in security_access_log only; no transcript
--     text in audit_events / transitions / security log
--   - RLS: outsiders see zero rows, direct writes refused for authenticated
-- Every row must show passed = true.
-- Run inside a transaction and roll back (see docs/live-api.md).
-- ============================================================

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;
create temp table _tok(k text primary key, v text) on commit drop;
grant all on _v to authenticated;
grant all on _ids to authenticated;
grant all on _tok to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000051','pract22@verify.local'),
  ('11111111-0000-0000-0000-000000000052','outsider22@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000031','Verify Org A 22','verify-a-0022'),
  ('bbbbbbbb-0000-0000-0000-000000000032','Verify Org B 22','verify-b-0022');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000031','11111111-0000-0000-0000-000000000051','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000032','11111111-0000-0000-0000-000000000052','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000031','bbbbbbbb-0000-0000-0000-000000000031','OrgA','Recorded'),
  ('cccccccc-0000-0000-0000-000000000032','bbbbbbbb-0000-0000-0000-000000000032','OrgB','Elsewhere');
insert into public.practitioner_patient_relationships(organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000031','11111111-0000-0000-0000-000000000051','cccccccc-0000-0000-0000-000000000031','active'),
  ('bbbbbbbb-0000-0000-0000-000000000032','11111111-0000-0000-0000-000000000052','cccccccc-0000-0000-0000-000000000032','active');
insert into public.encounters(id,organization_id,patient_id,status) values
  ('eeeeeeee-0000-0000-0000-000000000031','bbbbbbbb-0000-0000-0000-000000000031','cccccccc-0000-0000-0000-000000000031','in_progress'),
  ('eeeeeeee-0000-0000-0000-000000000032','bbbbbbbb-0000-0000-0000-000000000031','cccccccc-0000-0000-0000-000000000031','in_progress');
-- the exact consent artifacts presented (req 2: full immutable content)
insert into public.consent_documents(id,organization_id,scope,version,locale,jurisdiction,title,body,presentation_format,content_sha256) values
  ('99999999-0000-0000-0000-000000000131','bbbbbbbb-0000-0000-0000-000000000031','recording',1,'en','US-CA',
   'Recording consent','You agree this visit may be audio recorded.','text/markdown', repeat('1',64)),
  ('99999999-0000-0000-0000-000000000132','bbbbbbbb-0000-0000-0000-000000000031','transcription',1,'en','US-CA',
   'Transcription consent','You agree the recording may be transcribed.','text/markdown', repeat('2',64)),
  ('99999999-0000-0000-0000-000000000133','bbbbbbbb-0000-0000-0000-000000000031','ai_drafting',1,'en','US-CA',
   'AI drafting consent','You agree an AI scribe may draft a note for practitioner review.','text/markdown', repeat('3',64));

-- ===== as practitioner P (org A) =====
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000051","role":"authenticated"}', true);

-- no participants yet → consent cannot be complete
do $$
begin
  perform public.begin_recording('eeeeeeee-0000-0000-0000-000000000031','fixture','audio/webm',1000000,120);
  insert into _v values('begin refused with no participants', false, 'no error');
exception when others then
  insert into _v values('begin refused with no participants', sqlstate='55000', sqlstate);
end $$;

do $$
declare _pp uuid; _pr uuid;
begin
  _pp := public.add_recording_participant('eeeeeeee-0000-0000-0000-000000000031','patient','Pat Recorded',null,null,true);
  _pr := public.add_recording_participant('eeeeeeee-0000-0000-0000-000000000031','practitioner','Dr P',null,'11111111-0000-0000-0000-000000000051',true);
  insert into _ids values('pp_pat', _pp), ('pp_prac', _pr);
  insert into _v select 'participants registered',
    (select count(*) from public.encounter_recording_participants where encounter_id='eeeeeeee-0000-0000-0000-000000000031')=2, '';
exception when others then
  insert into _v values('participants registered', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.begin_recording('eeeeeeee-0000-0000-0000-000000000031','fixture','audio/webm',1000000,120);
  insert into _v values('begin refused before any consent', false, 'no error');
exception when others then
  insert into _v values('begin refused before any consent', sqlstate='55000', sqlstate);
end $$;

do $$
declare _c uuid; _c2 uuid;
begin
  _c := public.record_consent((select v from _ids where k='pp_pat'),'recording','99999999-0000-0000-0000-000000000131',
        'electronic_signature','I agree this visit may be recorded.','US-CA');
  insert into _ids values('c_pat_rec', _c);
  _c2 := public.record_consent((select v from _ids where k='pp_pat'),'recording','99999999-0000-0000-0000-000000000131',
        'electronic_signature','I agree this visit may be recorded.','US-CA');
  insert into _v select 'patient recording consent recorded once (idempotent)',
    _c = _c2 and (select count(*) from public.encounter_consents
                  where participant_id=(select v from _ids where k='pp_pat') and scope='recording' and status='granted')=1, _c::text;
exception when others then
  insert into _v values('patient recording consent recorded once (idempotent)', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.record_consent((select v from _ids where k='pp_pat'),'recording','99999999-0000-0000-0000-000000000132',
    'electronic_signature','ack','US-CA');
  insert into _v values('consent doc must match the scope', false, 'no error');
exception when others then
  insert into _v values('consent doc must match the scope', sqlstate='22023', sqlstate);
end $$;

do $$
begin
  perform public.begin_recording('eeeeeeee-0000-0000-0000-000000000031','fixture','audio/webm',1000000,120);
  insert into _v values('begin refused while any participant is unconsented', false, 'no error');
exception when others then
  insert into _v values('begin refused while any participant is unconsented', sqlstate='55000', sqlstate);
end $$;

-- ===== cross-organization references (outsider from org B) =====
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000052","role":"authenticated"}', true);
do $$
begin
  perform public.record_consent((select v from _ids where k='pp_prac'),'recording','99999999-0000-0000-0000-000000000131',
    'verbal_attested','x',null);
  insert into _v values('cross-org record_consent refused', false, 'no error');
exception when others then
  insert into _v values('cross-org record_consent refused', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.begin_recording('eeeeeeee-0000-0000-0000-000000000031','fixture','audio/webm',1000000,120);
  insert into _v values('cross-org begin_recording refused', false, 'no error');
exception when others then
  insert into _v values('cross-org begin_recording refused', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.withdraw_consent((select v from _ids where k='c_pat_rec'), 'not mine');
  insert into _v values('cross-org withdraw_consent refused', false, 'no error');
exception when others then
  insert into _v values('cross-org withdraw_consent refused', sqlstate='42501', sqlstate);
end $$;

-- ===== back to practitioner P =====
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000051","role":"authenticated"}', true);

do $$
begin
  perform public.record_consent((select v from _ids where k='pp_prac'),'recording','99999999-0000-0000-0000-000000000131',
    'electronic_signature','I consent to recording this visit.','US-CA');
  insert into _v values('practitioner recording consent recorded', true, '');
exception when others then
  insert into _v values('practitioner recording consent recorded', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.begin_recording('eeeeeeee-0000-0000-0000-000000000031','fixture','text/html',1000000,120);
  insert into _v values('unsupported content type refused', false, 'no error');
exception when others then
  insert into _v values('unsupported content type refused', sqlstate='22023', sqlstate);
end $$;

do $$
declare r jsonb;
begin
  r := public.begin_recording('eeeeeeee-0000-0000-0000-000000000031','fixture','audio/webm',1000000,120);
  insert into _ids values('rec1',(r->>'recording_id')::uuid), ('sess1',(r->>'session_id')::uuid);
  insert into _tok values('tok1', r->>'token');
  insert into _v select 'begin_recording: capturing + server-owned object key',
    exists (select 1 from public.encounter_recordings
            where id=(r->>'recording_id')::uuid and status='capturing'
              and storage_object_key = r->>'storage_object_key'
              and storage_object_key like 'rec/%' and encryption_state='fixture_local')
    and exists (select 1 from public.recording_state_transitions
            where recording_id=(r->>'recording_id')::uuid and from_status='authorized' and to_status='capturing'),
    r->>'storage_object_key';
exception when others then
  insert into _v values('begin_recording: capturing + server-owned object key', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'raw token is stored nowhere (hash only)',
  not exists (select 1 from public.capture_authorizations a, _tok t
              where position(t.v in a::text) > 0)
  and (select count(*) from public.capture_authorizations
       where recording_id=(select v from _ids where k='rec1') and length(token_sha256)=64)=1, '';

do $$
begin
  perform public.begin_recording('eeeeeeee-0000-0000-0000-000000000031','fixture','audio/webm',1000000,120);
  insert into _v values('second live recording per encounter refused', false, 'no error');
exception when others then
  insert into _v values('second live recording per encounter refused', sqlstate='55000', sqlstate);
end $$;

do $$
declare r jsonb;
begin
  r := public.authorize_chunk((select v from _ids where k='rec1'),(select v from _tok where k='tok1'), 512);
  insert into _v select 'authorize_chunk validates the bound token',
    r->>'storage_object_key' = (select storage_object_key from public.encounter_recordings where id=(select v from _ids where k='rec1')), r::text;
exception when others then
  insert into _v values('authorize_chunk validates the bound token', false, sqlstate||' '||sqlerrm);
end $$;
do $$
begin
  perform public.authorize_chunk((select v from _ids where k='rec1'),(select v from _tok where k='tok1'), 5000000);
  insert into _v values('oversized chunk refused', false, 'no error');
exception when others then
  insert into _v values('oversized chunk refused', sqlstate='55000', sqlstate);
end $$;
do $$
begin
  perform public.authorize_chunk((select v from _ids where k='rec1'),'not-a-real-token', 10);
  insert into _v values('unknown token refused', false, 'no error');
exception when others then
  insert into _v values('unknown token refused', sqlstate='55000', sqlstate);
end $$;

do $$
declare r jsonb; c jsonb;
begin
  r := public.heartbeat_capture((select v from _ids where k='sess1'));
  insert into _tok values('tok1b', r->>'token');
  c := public.authorize_chunk((select v from _ids where k='rec1'), r->>'token', 512);
  insert into _v select 'heartbeat rotates a fresh chunk token',
    (r->>'ok')::boolean and c ? 'storage_object_key', r->>'status';
exception when others then
  insert into _v values('heartbeat rotates a fresh chunk token', false, sqlstate||' '||sqlerrm);
end $$;

-- ===== late participant join =====
do $$
declare _pm uuid;
begin
  _pm := public.add_recording_participant('eeeeeeee-0000-0000-0000-000000000031','other','Minor Child','child of patient',null,false);
  insert into _ids values('pp_minor', _pm);
  insert into _v select 'late join pauses session + recording',
    exists (select 1 from public.capture_sessions where id=(select v from _ids where k='sess1')
            and status='paused' and pause_reason='participant_joined')
    and exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec1') and status='paused')
    and exists (select 1 from public.recording_state_transitions
            where recording_id=(select v from _ids where k='rec1') and from_status='capturing' and to_status='paused'), '';
exception when others then
  insert into _v values('late join pauses session + recording', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.authorize_chunk((select v from _ids where k='rec1'),(select v from _tok where k='tok1b'), 10);
  insert into _v values('paused capture refuses chunks server-side', false, 'no error');
exception when others then
  insert into _v values('paused capture refuses chunks server-side', sqlstate='55000', sqlstate);
end $$;

do $$
declare r jsonb;
begin
  r := public.heartbeat_capture((select v from _ids where k='sess1'));
  insert into _v select 'heartbeat reports paused (no token issued)',
    (r->>'ok')::boolean = false and (r ? 'token') = false, r::text;
exception when others then
  insert into _v values('heartbeat reports paused (no token issued)', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.resume_capture((select v from _ids where k='sess1'));
  insert into _v values('resume refused until late joiner consents', false, 'no error');
exception when others then
  insert into _v values('resume refused until late joiner consents', sqlstate='55000', sqlstate);
end $$;

do $$
begin
  perform public.record_consent((select v from _ids where k='pp_minor'),'recording','99999999-0000-0000-0000-000000000131',
    'verbal_attested','Guardian agreed on behalf of the child.',null);
  insert into _v values('rep authority required for non-self-consenting participant', false, 'no error');
exception when others then
  insert into _v values('rep authority required for non-self-consenting participant', sqlstate='22023', sqlstate);
end $$;

do $$
declare _c uuid;
begin
  _c := public.record_consent((select v from _ids where k='pp_minor'),'recording','99999999-0000-0000-0000-000000000131',
    'verbal_attested','Guardian agreed on behalf of the child.','US-CA',
    'Pat Recorded Sr','parent','minor_guardian','custodial parent per intake record');
  insert into _v select 'representative consent stored with basis + authority',
    exists (select 1 from public.encounter_consents where id=_c and representative_basis='minor_guardian'
            and representative_authority is not null and signer_acknowledgment like 'Guardian%'), _c::text;
exception when others then
  insert into _v values('representative consent stored with basis + authority', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.resume_capture((select v from _ids where k='sess1'));
  insert into _v select 'resume restores active session + capturing',
    exists (select 1 from public.capture_sessions where id=(select v from _ids where k='sess1') and status='active')
    and exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec1') and status='capturing'), '';
exception when others then
  insert into _v values('resume restores active session + capturing', false, sqlstate||' '||sqlerrm);
end $$;

-- ===== ACTIVE revocation =====
do $$
begin
  perform public.withdraw_consent((select v from _ids where k='c_pat_rec'), 'changed my mind');
  insert into _v select 'withdrawal revokes tokens + session and pauses capture',
    (select count(*) from public.capture_authorizations
      where recording_id=(select v from _ids where k='rec1') and consumed_at is null and revoked_at is null)=0
    and exists (select 1 from public.capture_sessions where id=(select v from _ids where k='sess1')
            and status='revoked' and pause_reason='consent_withdrawn')
    and exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec1') and status='paused'), '';
exception when others then
  insert into _v values('withdrawal revokes tokens + session and pauses capture', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.authorize_chunk((select v from _ids where k='rec1'),(select v from _tok where k='tok1b'), 10);
  insert into _v values('revoked token refused at chunk time', false, 'no error');
exception when others then
  insert into _v values('revoked token refused at chunk time', sqlstate='55000', sqlstate);
end $$;
do $$
begin
  perform public.heartbeat_capture((select v from _ids where k='sess1'));
  insert into _v values('heartbeat on revoked session refused', false, 'no error');
exception when others then
  insert into _v values('heartbeat on revoked session refused', sqlstate='55000', sqlstate);
end $$;
do $$
begin
  perform public.resume_capture((select v from _ids where k='sess1'));
  insert into _v values('revoked session cannot resume', false, 'no error');
exception when others then
  insert into _v values('revoked session cannot resume', sqlstate='55000', sqlstate);
end $$;
do $$
begin
  perform public.issue_completion_authorization((select v from _ids where k='sess1'), 120);
  insert into _v values('revoked session cannot authorize completion', false, 'no error');
exception when others then
  insert into _v values('revoked session cannot authorize completion', sqlstate='55000', sqlstate);
end $$;
do $$
begin
  perform public.withdraw_consent((select v from _ids where k='c_pat_rec'), 'again');
  insert into _v select 'duplicate withdrawal is a safe no-op',
    (select count(*) from public.encounter_consents where id=(select v from _ids where k='c_pat_rec') and status='withdrawn')=1, '';
exception when others then
  insert into _v values('duplicate withdrawal is a safe no-op', false, sqlstate||' '||sqlerrm);
end $$;

-- ===== deletion after withdrawal (failure + retry + confirm) =====
do $$
declare _j uuid; r jsonb;
begin
  perform public.request_recording_deletion((select v from _ids where k='rec1'));
  select id into _j from public.recording_deletion_jobs where recording_id=(select v from _ids where k='rec1') and target='local';
  perform public.fail_deletion_job(_j, 'simulated storage outage');
  insert into _v select 'failed deletion job leaves recording deletion_pending',
    exists (select 1 from public.recording_deletion_jobs where id=_j and status='failed' and attempts=1 and last_error like 'simulated%')
    and exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec1') and status='deletion_pending' and audio_deleted_at is null), '';
  r := public.confirm_deletion_job(_j, 'local-purge-proof-rec1');
  insert into _v select 'deleted only after every job confirms (proof retained)',
    r->>'recording_status'='deleted'
    and exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec1')
            and status='deleted' and audio_deleted_at is not null and deletion_proof='local-purge-proof-rec1'), r::text;
exception when others then
  insert into _v values('failed deletion job leaves recording deletion_pending', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.mark_recording_failed((select v from _ids where k='rec1'),'too late');
  insert into _v values('deleted is terminal (backward transition 40003)', false, 'no error');
exception when others then
  insert into _v values('deleted is terminal (backward transition 40003)', sqlstate='40003', sqlstate);
end $$;

insert into _v
select 'rec1 transition log matches its lifecycle',
  (select count(*) from public.recording_state_transitions where recording_id=(select v from _ids where k='rec1') and to_status='capturing')=2
  and (select count(*) from public.recording_state_transitions where recording_id=(select v from _ids where k='rec1') and to_status='paused')=2
  and (select count(*) from public.recording_state_transitions where recording_id=(select v from _ids where k='rec1') and to_status='deletion_pending')=1
  and (select count(*) from public.recording_state_transitions where recording_id=(select v from _ids where k='rec1') and to_status='deleted')=1, '';

-- ===== encounter 2: provider gate, upload, transcript, scribe =====
do $$
declare _pp uuid; _pr uuid;
begin
  _pp := public.add_recording_participant('eeeeeeee-0000-0000-0000-000000000032','patient','Pat Recorded',null,null,true);
  _pr := public.add_recording_participant('eeeeeeee-0000-0000-0000-000000000032','practitioner','Dr P',null,'11111111-0000-0000-0000-000000000051',true);
  insert into _ids values('e2_pat', _pp), ('e2_prac', _pr);
  perform public.record_consent(_pp,'recording','99999999-0000-0000-0000-000000000131','electronic_signature','I agree to recording.','US-CA');
  perform public.record_consent(_pr,'recording','99999999-0000-0000-0000-000000000131','electronic_signature','I agree to recording.','US-CA');
  insert into _v values('encounter 2 participants consented (recording only)', true, '');
exception when others then
  insert into _v values('encounter 2 participants consented (recording only)', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.begin_recording('eeeeeeee-0000-0000-0000-000000000032','aws_healthscribe','audio/webm',1000000,120);
  insert into _v values('healthscribe refused with no enablement', false, 'no error');
exception when others then
  insert into _v values('healthscribe refused with no enablement', sqlstate='55000', sqlstate);
end $$;

-- an enabled flag WITHOUT full config is still not enough (req 8)
insert into public.provider_enablements(organization_id,provider,enabled,region,encryption_config,retention_config,readiness_ref)
values ('bbbbbbbb-0000-0000-0000-000000000031','aws_healthscribe',true,'us-west-2','{"mode":"sse_kms"}','{}','ORR-2026-001');
do $$
begin
  perform public.begin_recording('eeeeeeee-0000-0000-0000-000000000032','aws_healthscribe','audio/webm',1000000,120);
  insert into _v values('healthscribe refused when config is incomplete', false, 'no error');
exception when others then
  insert into _v values('healthscribe refused when config is incomplete', sqlstate='55000', sqlstate);
end $$;

do $$
declare r jsonb;
begin
  r := public.begin_recording('eeeeeeee-0000-0000-0000-000000000032','fixture','audio/webm',1000000,120);
  insert into _ids values('rec2',(r->>'recording_id')::uuid), ('sess2',(r->>'session_id')::uuid);
  insert into _tok values('tok2', r->>'token'), ('obj2', null);
  update _tok set v = r->>'storage_object_key' where k='obj2';
  insert into _v values('fixture recording 2 started', true, '');
exception when others then
  insert into _v values('fixture recording 2 started', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.authorize_chunk((select v from _ids where k='rec2'),(select v from _tok where k='tok1b'), 10);
  insert into _v values('token replay against another recording refused', false, 'no error');
exception when others then
  insert into _v values('token replay against another recording refused', sqlstate='55000', sqlstate);
end $$;

do $$
begin
  perform public.complete_upload((select v from _ids where k='rec2'),(select v from _tok where k='tok2'),
    (select v from _tok where k='obj2'), repeat('a',64), 52340, 'audio/webm', 61000);
  insert into _v values('chunk token cannot complete an upload', false, 'no error');
exception when others then
  insert into _v values('chunk token cannot complete an upload', sqlstate='55000', sqlstate);
end $$;

do $$
declare r jsonb;
begin
  r := public.issue_completion_authorization((select v from _ids where k='sess2'), 120);
  insert into _tok values('ctok2', r->>'token');
  insert into _v values('completion authorization issued', (r ? 'token'), '');
exception when others then
  insert into _v values('completion authorization issued', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.complete_upload((select v from _ids where k='rec2'),(select v from _tok where k='ctok2'),
    'rec/someone-elses-object', repeat('a',64), 52340, 'audio/webm', 61000);
  insert into _v values('completion bound to its storage object', false, 'no error');
exception when others then
  insert into _v values('completion bound to its storage object', sqlstate='55000', sqlstate);
end $$;

do $$
declare r jsonb; r2 jsonb;
begin
  r := public.complete_upload((select v from _ids where k='rec2'),(select v from _tok where k='ctok2'),
    (select v from _tok where k='obj2'), repeat('a',64), 52340, 'audio/webm', 61000);
  r2 := public.complete_upload((select v from _ids where k='rec2'),(select v from _tok where k='ctok2'),
    (select v from _tok where k='obj2'), repeat('a',64), 52340, 'audio/webm', 61000);
  insert into _v select 'upload completes then duplicate callback is idempotent',
    r->>'status'='uploaded' and (r->>'idempotent')::boolean = false
    and r2->>'status'='uploaded' and (r2->>'idempotent')::boolean = true
    and exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec2')
            and status='uploaded' and audio_sha256=repeat('a',64) and (validation_result->>'ok')::boolean)
    and (select count(*) from public.recording_state_transitions
         where recording_id=(select v from _ids where k='rec2') and to_status='uploaded')=1
    and exists (select 1 from public.capture_sessions where id=(select v from _ids where k='sess2') and status='closed'), '';
exception when others then
  insert into _v values('upload completes then duplicate callback is idempotent', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.resume_capture((select v from _ids where k='sess2'));
  insert into _v values('backward transition uploaded→capturing refused (40003)', false, 'no error');
exception when others then
  insert into _v values('backward transition uploaded→capturing refused (40003)', sqlstate='40003', sqlstate);
end $$;

do $$
begin
  perform public.ingest_transcript_batch((select v from _ids where k='rec2'),'fixture-job-1',
    '[{"speaker":"clinician","startMs":0,"endMs":4000,"text":"BP one eighteen over seventy six.","confidence":0.94}]'::jsonb);
  insert into _v values('ingest refused before transcription is queued', false, 'no error');
exception when others then
  insert into _v values('ingest refused before transcription is queued', sqlstate='55000', sqlstate);
end $$;

-- NOTE: queue_transcription must live in its OWN block — an expected exception
-- in the same block would roll back the queueing (block-level subtransaction).
do $$
begin
  perform public.queue_transcription((select v from _ids where k='rec2'));
  insert into _v select 'transcription queued',
    exists (select 1 from public.encounter_recordings
            where id=(select v from _ids where k='rec2') and status='transcription_queued'), '';
exception when others then
  insert into _v values('transcription queued', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.ingest_transcript_batch((select v from _ids where k='rec2'),'fixture-job-1',
    '[{"speaker":"clinician","startMs":0,"endMs":4000,"text":"BP one eighteen over seventy six.","confidence":0.94}]'::jsonb);
  insert into _v values('ingest refused without transcription consent', false, 'no error');
exception when others then
  insert into _v values('ingest refused without transcription consent', sqlstate='55000', sqlstate);
end $$;

do $$
declare _t uuid; _t2 uuid;
begin
  perform public.record_consent((select v from _ids where k='e2_pat'),'transcription','99999999-0000-0000-0000-000000000132','electronic_signature','I agree to transcription.','US-CA');
  perform public.record_consent((select v from _ids where k='e2_prac'),'transcription','99999999-0000-0000-0000-000000000132','electronic_signature','I agree to transcription.','US-CA');
  _t := public.ingest_transcript_batch((select v from _ids where k='rec2'),'fixture-job-1',
    '[{"speaker":"clinician","startMs":0,"endMs":4000,"text":"BP one eighteen over seventy six.","confidence":0.94},
      {"speaker":"patient","startMs":4200,"endMs":9000,"text":"I have been sleeping poorly for two weeks.","confidence":0.91}]'::jsonb);
  insert into _ids values('t2', _t);
  _t2 := public.ingest_transcript_batch((select v from _ids where k='rec2'),'fixture-job-1',
    '[{"speaker":"clinician","text":"dup"}]'::jsonb);
  insert into _v select 'transcript ingested once (duplicate callback returns same id)',
    _t = _t2
    and (select count(*) from public.transcript_segments where transcript_id=_t)=2
    and exists (select 1 from public.encounter_transcripts where id=_t and revision=1 and status='accepted')
    and exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec2') and status='transcript_ready'), _t::text;
exception when others then
  insert into _v values('transcript ingested once (duplicate callback returns same id)', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  update public.transcript_segments set text='tampered'
   where transcript_id=(select v from _ids where k='t2');
  insert into _v values('raw ASR segments are immutable', false, 'no error');
exception when others then
  insert into _v values('raw ASR segments are immutable', true, sqlstate);
end $$;

do $$
declare _seg uuid; _rev integer; _ver integer;
begin
  select id into _seg from public.transcript_segments
   where transcript_id=(select v from _ids where k='t2') and seq=1;
  insert into _ids values('seg1', _seg);
  _rev := public.add_segment_revision(_seg, 'BP one eighteen over seventy-six.', 0.99, 'fixture-job-1r');
  insert into _v select 'provider revision appended (original untouched)',
    _rev = 1
    and exists (select 1 from public.transcript_segments where id=_seg and text like 'BP one eighteen over seventy six%')
    and exists (select 1 from public.encounter_transcripts where id=(select v from _ids where k='t2') and revision=2), '';
  _ver := public.correct_transcript_segment(_seg, 'BP 118/76 seated, left arm.', 'expanded shorthand');
  insert into _v select 'practitioner correction is a separate versioned overlay',
    _ver = 1
    and exists (select 1 from public.transcript_corrections where segment_id=_seg and version=1 and source_revision=1)
    and exists (select 1 from public.encounter_transcripts where id=(select v from _ids where k='t2') and status='corrected' and revision=3), '';
exception when others then
  insert into _v values('provider revision appended (original untouched)', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.set_transcript_review((select v from _ids where k='t2'));
  insert into _v select 'transcript review moves recording to review_pending',
    exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec2') and status='review_pending'), '';
exception when others then
  insert into _v values('transcript review moves recording to review_pending', false, sqlstate||' '||sqlerrm);
end $$;

-- ===== scribe: never overwrite practitioner work =====
do $$
declare r jsonb;
begin
  r := public.save_note_draft('bbbbbbbb-0000-0000-0000-000000000031','eeeeeeee-0000-0000-0000-000000000032',
    'soap','{"S":"Practitioner-authored subjective. Do not overwrite.","O":"","A":"","P":""}'::jsonb,0,null,'manual','[]'::jsonb);
  insert into _ids values('note_manual',(r->>'note_id')::uuid);
  insert into _v values('practitioner draft exists before scribe runs', (r->>'version')='1', '');
exception when others then
  insert into _v values('practitioner draft exists before scribe runs', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.generate_scribe_draft((select v from _ids where k='t2'),'soap','fixture-model-1','fixture','tmpl-v1');
  insert into _v values('scribe refused without ai_drafting consent', false, 'no error');
exception when others then
  insert into _v values('scribe refused without ai_drafting consent', sqlstate='55000', sqlstate);
end $$;

do $$
declare r jsonb; r2 jsonb; _cad uuid;
begin
  _cad := public.record_consent((select v from _ids where k='e2_pat'),'ai_drafting','99999999-0000-0000-0000-000000000133','electronic_signature','I agree to AI drafting.','US-CA');
  insert into _ids values('c_e2pat_ai', _cad);
  perform public.record_consent((select v from _ids where k='e2_prac'),'ai_drafting','99999999-0000-0000-0000-000000000133','electronic_signature','I agree to AI drafting.','US-CA');
  r := public.generate_scribe_draft((select v from _ids where k='t2'),'soap','fixture-model-1','fixture','tmpl-v1');
  insert into _ids values('note_scribe',(r->>'note_id')::uuid);
  r2 := public.generate_scribe_draft((select v from _ids where k='t2'),'soap','fixture-model-1','fixture','tmpl-v1');
  insert into _v select 'scribe creates a NEW proposed note, never touching the manual draft',
    (r->>'note_id')::uuid <> (select v from _ids where k='note_manual')
    and (r->>'idempotent')::boolean = false and (r2->>'idempotent')::boolean = true
    and r2->>'note_id' = r->>'note_id'
    and exists (select 1 from public.clinical_note_versions
            where note_id=(select v from _ids where k='note_manual') and version=1
              and content->>'S' like 'Practitioner-authored%')
    and exists (select 1 from public.clinical_note_versions
            where note_id=(r->>'note_id')::uuid and version=1
              and content->>'S' like 'AI scribe draft%' and content->>'S' like '%BP 118/76%'), r::text;
  insert into _v select 'generation provenance persisted (model/provider/template/revision/validation)',
    exists (select 1 from public.scribe_generations
            where transcript_id=(select v from _ids where k='t2') and source_transcript_revision=3
              and model='fixture-model-1' and provider='fixture' and prompt_template_version='tmpl-v1'
              and validation_result is not null and status='proposed'
              and note_id=(r->>'note_id')::uuid)
    and exists (select 1 from public.note_provenance_refs
            where note_id=(r->>'note_id')::uuid and ref_type='transcript'
              and ref_id=(select v from _ids where k='t2') and label like '%r3%'), '';
exception when others then
  insert into _v values('scribe creates a NEW proposed note, never touching the manual draft', false, sqlstate||' '||sqlerrm);
end $$;

do $$
declare r jsonb;
begin
  perform public.withdraw_consent((select v from _ids where k='c_e2pat_ai'), 'no AI please');
  begin
    perform public.generate_scribe_draft((select v from _ids where k='t2'),'soap','fixture-model-1','fixture','tmpl-v2');
    insert into _v values('scribe refused after ai_drafting withdrawal', false, 'no error');
  exception when others then
    insert into _v values('scribe refused after ai_drafting withdrawal', sqlstate='55000', sqlstate);
  end;
  perform public.record_consent((select v from _ids where k='e2_pat'),'ai_drafting','99999999-0000-0000-0000-000000000133','electronic_signature','I agree again to AI drafting.','US-CA');
  r := public.generate_scribe_draft((select v from _ids where k='t2'),'soap','fixture-model-1','fixture','tmpl-v2');
  insert into _v select 're-grant creates a new consent row; new template → new draft',
    (select count(*) from public.encounter_consents
      where participant_id=(select v from _ids where k='e2_pat') and scope='ai_drafting')=2
    and (select count(*) from public.encounter_consents
      where participant_id=(select v from _ids where k='e2_pat') and scope='ai_drafting' and status='granted')=1
    and (r->>'note_id')::uuid <> (select v from _ids where k='note_scribe'), '';
exception when others then
  insert into _v values('re-grant creates a new consent row; new template → new draft', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.finalize_transcript((select v from _ids where k='t2'));
  insert into _v select 'finalize freezes transcript + recording',
    exists (select 1 from public.encounter_transcripts where id=(select v from _ids where k='t2') and status='finalized')
    and exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec2') and status='finalized'), '';
exception when others then
  insert into _v values('finalize freezes transcript + recording', false, sqlstate||' '||sqlerrm);
end $$;
do $$
begin
  perform public.correct_transcript_segment((select v from _ids where k='seg1'), 'too late', null);
  insert into _v values('corrections refused after finalize', false, 'no error');
exception when others then
  insert into _v values('corrections refused after finalize', sqlstate='22023', sqlstate);
end $$;

-- ===== audit domain separation =====
do $$
begin
  perform public.log_transcript_access((select v from _ids where k='t2'),'accessed');
  begin
    perform public.log_transcript_access((select v from _ids where k='t2'),'bogus');
    insert into _v values('invalid access kind refused', false, 'no error');
  exception when others then
    insert into _v values('invalid access kind refused', sqlstate='22023', sqlstate);
  end;
  insert into _v select 'access events land in security_access_log, not audit_events',
    (select count(*) from public.security_access_log
      where organization_id='bbbbbbbb-0000-0000-0000-000000000031' and action='transcript.accessed')=1
    and (select count(*) from public.audit_events
      where organization_id='bbbbbbbb-0000-0000-0000-000000000031' and action like 'transcript.accessed%')=0, '';
exception when others then
  insert into _v values('access events land in security_access_log, not audit_events', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'no transcript text leaks into any log or transition',
  not exists (select 1 from public.audit_events
              where organization_id in ('bbbbbbbb-0000-0000-0000-000000000031','bbbbbbbb-0000-0000-0000-000000000032')
                and (coalesce(safe_message,'')||coalesce(metadata::text,'')) ilike '%one eighteen%')
  and not exists (select 1 from public.recording_state_transitions t
              join public.encounter_recordings r on r.id=t.recording_id
              where r.organization_id='bbbbbbbb-0000-0000-0000-000000000031'
                and coalesce(t.reason,'') ilike '%one eighteen%')
  and not exists (select 1 from public.security_access_log
              where organization_id='bbbbbbbb-0000-0000-0000-000000000031'
                and coalesce(action,'')||coalesce(resource_type,'')||coalesce(resource_id,'') ilike '%one eighteen%'), '';

do $$
begin
  update public.security_access_log set action='rewritten'
   where organization_id='bbbbbbbb-0000-0000-0000-000000000031';
  insert into _v values('security access log is append-only', false, 'no error');
exception when others then
  insert into _v values('security access log is append-only', true, sqlstate);
end $$;
do $$
begin
  update public.consent_documents set body='rewritten'
   where id='99999999-0000-0000-0000-000000000131';
  insert into _v values('consent documents are immutable', false, 'no error');
exception when others then
  insert into _v values('consent documents are immutable', true, sqlstate);
end $$;

-- ===== durable deletion with legal hold (rec2) =====
do $$
declare _j uuid;
begin
  perform public.set_legal_hold((select v from _ids where k='rec2'), true);
  begin
    perform public.request_recording_deletion((select v from _ids where k='rec2'));
    insert into _v values('legal hold blocks deletion', false, 'no error');
  exception when others then
    insert into _v values('legal hold blocks deletion', sqlstate='55000', sqlstate);
  end;
  perform public.set_legal_hold((select v from _ids where k='rec2'), false);
  perform public.request_recording_deletion((select v from _ids where k='rec2'));
  select id into _j from public.recording_deletion_jobs where recording_id=(select v from _ids where k='rec2') and target='local';
  perform public.confirm_deletion_job(_j, 'local-purge-proof-rec2');
  insert into _v select 'fixture deletion needs only the local target; proof retained',
    (select count(*) from public.recording_deletion_jobs where recording_id=(select v from _ids where k='rec2'))=1
    and exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec2')
            and status='deleted' and deletion_proof='local-purge-proof-rec2'), '';
exception when others then
  insert into _v values('fixture deletion needs only the local target; proof retained', false, sqlstate||' '||sqlerrm);
end $$;

-- transcript + scribe evidence survive audio deletion (retention split)
insert into _v
select 'transcript, corrections and scribe drafts survive audio deletion',
  (select count(*) from public.transcript_segments where transcript_id=(select v from _ids where k='t2'))=2
  and (select count(*) from public.transcript_corrections where transcript_id=(select v from _ids where k='t2'))=1
  and (select count(*) from public.scribe_generations where transcript_id=(select v from _ids where k='t2'))=2, '';

-- ===== quarantine + token expiry (rec3) =====
do $$
declare r jsonb; c jsonb; q jsonb;
begin
  r := public.begin_recording('eeeeeeee-0000-0000-0000-000000000032','fixture','audio/webm',1000000,120);
  insert into _ids values('rec3',(r->>'recording_id')::uuid), ('sess3',(r->>'session_id')::uuid);
  insert into _tok values('tok3', r->>'token');
  c := public.issue_completion_authorization((select v from _ids where k='sess3'), 120);
  q := public.complete_upload((select v from _ids where k='rec3'), c->>'token',
    r->>'storage_object_key', repeat('b',64), 2000000, 'audio/webm', 61000);
  insert into _v select 'oversized upload is quarantined, not processed',
    q->>'status'='quarantined'
    and exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec3')
            and status='quarantined' and (validation_result->>'ok')::boolean = false), q::text;
  begin
    perform public.issue_completion_authorization((select v from _ids where k='sess3'), 120);
    insert into _v values('quarantined recording cannot be re-completed', false, 'no error');
  exception when others then
    insert into _v values('quarantined recording cannot be re-completed', sqlstate='55000', sqlstate);
  end;
exception when others then
  insert into _v values('oversized upload is quarantined, not processed', false, sqlstate||' '||sqlerrm);
end $$;

update public.capture_authorizations set expires_at = now() - interval '1 second'
 where recording_id=(select v from _ids where k='rec3') and permitted_action='chunk_upload';
do $$
begin
  perform public.authorize_chunk((select v from _ids where k='rec3'),(select v from _tok where k='tok3'), 10);
  insert into _v values('expired token refused', false, 'no error');
exception when others then
  insert into _v values('expired token refused', sqlstate='55000', sqlstate);
end $$;

do $$
begin
  perform public.request_recording_deletion((select v from _ids where k='rec3'));
  insert into _v select 'quarantined recording flows to deletion',
    exists (select 1 from public.encounter_recordings where id=(select v from _ids where k='rec3') and status='deletion_pending'), '';
exception when others then
  insert into _v values('quarantined recording flows to deletion', false, sqlstate||' '||sqlerrm);
end $$;

-- ===== RLS: outsider sees nothing, direct writes refused =====
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000052","role":"authenticated"}', true);
set local role authenticated;
insert into _v
select 'RLS: outsider sees no recording/consent/transcript rows',
  (select count(*) from public.encounter_recordings where organization_id='bbbbbbbb-0000-0000-0000-000000000031')=0
  and (select count(*) from public.encounter_consents where organization_id='bbbbbbbb-0000-0000-0000-000000000031')=0
  and (select count(*) from public.encounter_transcripts)=0
  and (select count(*) from public.transcript_segments)=0
  and (select count(*) from public.capture_authorizations)=0
  and (select count(*) from public.consent_documents where organization_id='bbbbbbbb-0000-0000-0000-000000000031')=0
  and (select count(*) from public.security_access_log where organization_id='bbbbbbbb-0000-0000-0000-000000000031')=0, '';
do $$
begin
  insert into public.encounter_recordings(organization_id,encounter_id,patient_id,provider,deletion_deadline)
  values ('bbbbbbbb-0000-0000-0000-000000000032','eeeeeeee-0000-0000-0000-000000000031','cccccccc-0000-0000-0000-000000000032','fixture', now());
  insert into _v values('RLS: direct recording insert refused', false, 'no error');
exception when others then
  insert into _v values('RLS: direct recording insert refused', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  insert into public.security_access_log(organization_id,action) values ('bbbbbbbb-0000-0000-0000-000000000032','fake.event');
  insert into _v values('RLS: direct security-log insert refused', false, 'no error');
exception when others then
  insert into _v values('RLS: direct security-log insert refused', sqlstate='42501', sqlstate);
end $$;
reset role;

-- practitioner (authenticated role) reads the full chain; tokens stay opaque
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000051","role":"authenticated"}', true);
set local role authenticated;
insert into _v
select 'RLS: practitioner reads recordings, transcripts and consent artifacts',
  (select count(*) from public.encounter_recordings where organization_id='bbbbbbbb-0000-0000-0000-000000000031')=3
  and (select count(*) from public.encounter_transcripts)=1
  and (select count(*) from public.transcript_segments)=2
  and (select count(*) from public.consent_documents where organization_id='bbbbbbbb-0000-0000-0000-000000000031' and body <> '')=3
  and not exists (select 1 from public.capture_authorizations a, _tok t
                  where t.k <> 'obj2' and t.v is not null and position(t.v in a::text) > 0), '';
reset role;

select name, passed, detail from _v order by name;
rollback;
