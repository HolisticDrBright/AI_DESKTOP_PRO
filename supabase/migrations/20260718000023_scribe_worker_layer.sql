-- 0023 — Scribe worker layer: signed-callback ledger + service worker RPCs.
--
-- Backend workers (transcription completion, durable deletion) and the signed
-- provider-callback route run WITHOUT a user JWT. They use SECURITY DEFINER
-- RPCs granted ONLY to service_role. These are not user-facing paths: the
-- callback route authenticates deliveries cryptographically (HMAC signature,
-- timestamp window, nonce/event-id dedupe) before touching any RPC, and the
-- workers act on server-owned job queues. CONSENT IS NOT WAIVABLE by the
-- system identity: worker_ingest_transcript_batch re-checks all-participant
-- transcription consent exactly like the user-facing RPC.
--
-- The callback ledger stores identifiers, hashes, status and errors — NEVER
-- payload content (transcript text stays out of infrastructure tables).
--
-- Errcodes as 0022: 22023 invalid · 55000 precondition · 40003 bad transition.

begin;

-- ------------------------------------------------ callback delivery ledger
create table public.provider_callback_events (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,
  event_id        text not null,          -- provider-assigned delivery id (dedupe key)
  kind            text not null check (kind in ('transcript-ready','transcript-failed','deletion-confirmed')),
  recording_id    uuid references public.encounter_recordings(id) on delete set null,
  payload_sha256  text,                   -- integrity reference only; payloads are never stored
  signature_valid boolean not null,
  status          text not null default 'received'
                    check (status in ('received','processed','deferred','replayed','rejected','dead_letter')),
  attempts        integer not null default 0,
  last_error      text,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  unique (provider, event_id)
);
alter table public.provider_callback_events enable row level security;
-- No authenticated policies on purpose: the ledger is worker infrastructure.
create index pce_recording_idx on public.provider_callback_events (recording_id);

-- Deletion jobs gain a dead-letter marker (attempts cap reached; needs admin).
alter table public.recording_deletion_jobs add column dead_lettered_at timestamptz;

-- -------------------------------------------- record/dedupe one callback
-- Insert-or-detect for a delivery. A delivery whose event_id was already
-- PROCESSED is a replay (idempotent ack, no reprocessing). A known event_id
-- that previously deferred/failed is a legitimate provider retry.
create or replace function public.worker_record_callback_event(
  _provider text, _event_id text, _kind text, _recording_id uuid,
  _payload_sha256 text, _signature_valid boolean
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _existing public.provider_callback_events%rowtype; _id uuid;
begin
  if _provider is null or btrim(_provider) = '' or _event_id is null or btrim(_event_id) = '' then
    raise exception 'provider and event id are required' using errcode = '22023';
  end if;
  select * into _existing from public.provider_callback_events
    where provider = _provider and event_id = _event_id for update;
  if found then
    if _existing.status = 'processed' then
      return jsonb_build_object('id', _existing.id, 'replay', true, 'status', _existing.status);
    end if;
    update public.provider_callback_events
       set attempts = attempts + 1, signature_valid = _signature_valid
     where id = _existing.id;
    return jsonb_build_object('id', _existing.id, 'replay', false, 'retry', true, 'status', _existing.status);
  end if;
  insert into public.provider_callback_events
    (provider, event_id, kind, recording_id, payload_sha256, signature_valid,
     status, attempts)
  values (_provider, _event_id, _kind, _recording_id, _payload_sha256, _signature_valid,
          case when _signature_valid then 'received' else 'rejected' end, 1)
  returning id into _id;
  return jsonb_build_object('id', _id, 'replay', false, 'retry', false, 'status',
    case when _signature_valid then 'received' else 'rejected' end);
end; $$;

create or replace function public.worker_mark_callback_event(_event_uuid uuid, _status text, _error text default null)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if _status not in ('processed','deferred','rejected','dead_letter') then
    raise exception 'invalid callback status' using errcode = '22023';
  end if;
  update public.provider_callback_events
     set status = _status,
         last_error = left(coalesce(_error, last_error), 500),
         processed_at = case when _status = 'processed' then now() else processed_at end
   where id = _event_uuid;
  if not found then raise exception 'callback event not found' using errcode = 'P0002'; end if;
end; $$;

-- ------------------------------------- system transcript ingestion (worker)
-- Same contract as public.ingest_transcript_batch, but with the SYSTEM as the
-- actor (no user JWT). Consent enforcement is preserved verbatim.
create or replace function public.worker_ingest_transcript_batch(
  _recording_id uuid, _provider_job_id text, _segments jsonb
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _r public.encounter_recordings%rowtype; _t uuid; _seg jsonb; _i integer := 0;
begin
  select * into _r from public.encounter_recordings where id = _recording_id;
  if not found then raise exception 'recording not found' using errcode = 'P0002'; end if;
  if not private.all_participants_consented(_r.encounter_id, 'transcription') then
    raise exception 'transcription consent has not been granted by all participants' using errcode = '55000'; end if;
  if jsonb_typeof(_segments) <> 'array' or jsonb_array_length(_segments) = 0 then
    raise exception 'segments must be a non-empty array' using errcode = '22023'; end if;

  select id into _t from public.encounter_transcripts where recording_id = _recording_id;
  if found then return _t; end if;   -- idempotent (duplicate callback)

  if _r.status = 'transcription_queued' then
    perform private.transition_recording(_recording_id, 'transcribing', 'transcription started (worker)', null);
  elsif _r.status <> 'transcribing' then
    raise exception 'recording is not ready for transcription' using errcode = '55000';
  end if;

  insert into public.encounter_transcripts
    (organization_id, encounter_id, patient_id, recording_id, provider, provider_job_id, revision, status)
  values (_r.organization_id, _r.encounter_id, _r.patient_id, _recording_id, _r.provider, _provider_job_id, 1, 'accepted')
  returning id into _t;
  for _seg in select * from jsonb_array_elements(_segments) loop
    _i := _i + 1;
    insert into public.transcript_segments (transcript_id, seq, speaker_label, start_ms, end_ms, text, confidence)
    values (_t, _i, left(coalesce(_seg->>'speaker', ''), 60),
            nullif(_seg->>'startMs','')::integer, nullif(_seg->>'endMs','')::integer,
            coalesce(_seg->>'text',''), nullif(_seg->>'confidence','')::numeric);
  end loop;
  update public.encounter_recordings set provider_job_id = _provider_job_id where id = _recording_id;
  perform private.transition_recording(_recording_id, 'transcript_ready', 'transcript received (worker)', null);

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_r.organization_id, _r.patient_id, null, 'transcription.batch_received', 'encounter_transcript', _t::text,
    'Transcript received', jsonb_build_object('segments', _i, 'provider', _r.provider, 'actor', 'transcription-worker'));
  return _t;
end; $$;

-- Mark a recording failed from the worker path (provider job failed).
create or replace function public.worker_mark_recording_failed(_recording_id uuid, _reason text)
returns void language plpgsql security definer set search_path = ''
as $$
declare _r public.encounter_recordings%rowtype;
begin
  select * into _r from public.encounter_recordings where id = _recording_id;
  if not found then raise exception 'recording not found' using errcode = 'P0002'; end if;
  update public.encounter_recordings set failure_reason = left(coalesce(_reason,'unspecified'),500) where id = _recording_id;
  perform private.transition_recording(_recording_id, 'failed', left(coalesce(_reason,'provider failure'),200), null);
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_r.organization_id, _r.patient_id, null, 'recording.failed', 'encounter_recording', _recording_id::text,
    'Recording processing failed', jsonb_build_object('actor', 'transcription-worker'));
end; $$;

-- --------------------------------------------- durable deletion (workers)
-- Claim due jobs with SKIP LOCKED so concurrent workers never double-claim.
-- Legal hold and dead-lettered jobs are never claimed.
create or replace function public.worker_claim_due_deletion_jobs(_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _rows jsonb;
begin
  with due as (
    select j.id from public.recording_deletion_jobs j
    join public.encounter_recordings r on r.id = j.recording_id
    where j.status in ('pending','failed')
      and j.dead_lettered_at is null
      and j.attempts < 5
      and j.next_attempt_at <= now()
      and r.legal_hold = false
    order by j.next_attempt_at
    limit greatest(1, least(50, coalesce(_limit, 10)))
    for update of j skip locked
  ), claimed as (
    update public.recording_deletion_jobs j
       set status = 'in_progress'
      from due where j.id = due.id
    returning j.id, j.recording_id, j.target, j.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'jobId', c.id, 'recordingId', c.recording_id, 'target', c.target, 'attempts', c.attempts,
           'provider', r.provider, 'storageObjectKey', r.storage_object_key)), '[]'::jsonb)
    into _rows
    from claimed c join public.encounter_recordings r on r.id = c.recording_id;
  return _rows;
end; $$;

create or replace function public.worker_confirm_deletion_job(_job_id uuid, _confirmation text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _j public.recording_deletion_jobs%rowtype; _r public.encounter_recordings%rowtype; _remaining integer;
begin
  select * into _j from public.recording_deletion_jobs where id = _job_id;
  if not found then raise exception 'deletion job not found' using errcode = 'P0002'; end if;
  select * into _r from public.encounter_recordings where id = _j.recording_id;
  if _r.legal_hold then raise exception 'recording is under legal hold' using errcode = '55000'; end if;
  if _confirmation is null or btrim(_confirmation) = '' then
    raise exception 'a deletion confirmation is required' using errcode = '22023'; end if;
  update public.recording_deletion_jobs
     set status = 'confirmed', attempts = attempts + 1, confirmation_ref = _confirmation where id = _job_id;
  select count(*) into _remaining from public.recording_deletion_jobs
    where recording_id = _j.recording_id and status <> 'confirmed';
  if _remaining = 0 then
    update public.encounter_recordings
       set audio_deleted_at = now(), deletion_proof = _confirmation
     where id = _j.recording_id;
    perform private.transition_recording(_j.recording_id, 'deleted', 'all deletion targets confirmed (worker)', null);
    insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
      resource_type, resource_id, safe_message, metadata)
    values (_r.organization_id, _r.patient_id, null, 'recording.deleted', 'encounter_recording', _r.id::text,
      'Recording audio deleted', jsonb_build_object('provider', _r.provider, 'actor', 'deletion-worker'));
    return jsonb_build_object('recordingStatus', 'deleted', 'remaining', 0);
  end if;
  return jsonb_build_object('recordingStatus', _r.status, 'remaining', _remaining);
end; $$;

-- Failure with exponential backoff; the 5th failure dead-letters the job for
-- administrator review (it is never claimed again until an admin resets it).
create or replace function public.worker_fail_deletion_job(_job_id uuid, _error text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _j public.recording_deletion_jobs%rowtype; _attempts integer; _dead boolean := false;
begin
  select * into _j from public.recording_deletion_jobs where id = _job_id;
  if not found then raise exception 'deletion job not found' using errcode = 'P0002'; end if;
  _attempts := _j.attempts + 1;
  if _attempts >= 5 then _dead := true; end if;
  update public.recording_deletion_jobs
     set status = 'failed',
         attempts = _attempts,
         last_error = left(coalesce(_error,'unspecified'),500),
         next_attempt_at = now() + make_interval(mins => least(60, (2 ^ least(_attempts, 6))::integer)),
         dead_lettered_at = case when _dead then now() else dead_lettered_at end
   where id = _job_id;
  return jsonb_build_object('attempts', _attempts, 'deadLettered', _dead);
end; $$;

-- ------------------------------------ admin: reset a dead-lettered job (user)
-- Administrator review surface: a HUMAN (clinical actor) resets a dead-lettered
-- job after fixing the underlying cause; the worker then retries it.
create or replace function public.retry_dead_letter_deletion_job(_job_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _j public.recording_deletion_jobs%rowtype; _r public.encounter_recordings%rowtype;
begin
  select * into _j from public.recording_deletion_jobs where id = _job_id;
  if not found then raise exception 'deletion job not found' using errcode = 'P0002'; end if;
  select * into _r from public.encounter_recordings where id = _j.recording_id;
  _uid := private.require_clinical_actor(_r.organization_id, _r.patient_id);
  if _j.dead_lettered_at is null then
    raise exception 'job is not dead-lettered' using errcode = '55000'; end if;
  update public.recording_deletion_jobs
     set dead_lettered_at = null, attempts = 0, status = 'pending', next_attempt_at = now(), last_error = null
   where id = _job_id;
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_r.organization_id, _r.patient_id, _uid, 'recording.deletion_retry', 'encounter_recording', _r.id::text,
    'Dead-lettered deletion job reset for retry', jsonb_build_object('target', _j.target));
end; $$;

-- ------------------------------------------------------------------ grants
revoke all on function public.worker_record_callback_event(text, text, text, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.worker_mark_callback_event(uuid, text, text) from public, anon, authenticated;
revoke all on function public.worker_ingest_transcript_batch(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.worker_mark_recording_failed(uuid, text) from public, anon, authenticated;
revoke all on function public.worker_claim_due_deletion_jobs(integer) from public, anon, authenticated;
revoke all on function public.worker_confirm_deletion_job(uuid, text) from public, anon, authenticated;
revoke all on function public.worker_fail_deletion_job(uuid, text) from public, anon, authenticated;
grant execute on function public.worker_record_callback_event(text, text, text, uuid, text, boolean) to service_role;
grant execute on function public.worker_mark_callback_event(uuid, text, text) to service_role;
grant execute on function public.worker_ingest_transcript_batch(uuid, text, jsonb) to service_role;
grant execute on function public.worker_mark_recording_failed(uuid, text) to service_role;
grant execute on function public.worker_claim_due_deletion_jobs(integer) to service_role;
grant execute on function public.worker_confirm_deletion_job(uuid, text) to service_role;
grant execute on function public.worker_fail_deletion_job(uuid, text) to service_role;

revoke all on function public.retry_dead_letter_deletion_job(uuid) from public, anon;
grant execute on function public.retry_dead_letter_deletion_job(uuid) to authenticated;

commit;
