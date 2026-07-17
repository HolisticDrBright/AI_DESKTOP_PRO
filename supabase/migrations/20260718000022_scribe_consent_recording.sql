-- 0022 — Consent-gated encounter recording + AI scribe (Milestone 1, HARDENED).
--
-- Legal consent and technical capture authorization are DISTINCT concerns and
-- are modeled separately:
--   * consent_documents / encounter_consents  — the legal artifact + grants
--   * capture_sessions / capture_authorizations — technical, revocation-aware
--
-- Enforced in the database (SECURITY DEFINER RPCs; direct writes revoked):
--   * three independent consent scopes; every participant must grant the scope
--   * ACTIVE revocation: withdrawing consent revokes every live authorization
--     and the capture session immediately, and pauses the recording — not just
--     future tokens. Chunk upload / heartbeat re-validates consent every call.
--   * a late participant join PAUSES capture until they are identified and
--     grant the required scopes.
--   * consent capacity + representative authority for minors / LAR / unable.
--   * capture authorizations are opaque random tokens stored only as hashes,
--     bound to org+patient+encounter+recording+action+object+content-type+
--     max-size+nonce+expiry, single-use, non-reusable against another object.
--   * a complete recording state machine with validated, forward-only
--     transitions (authorized→…→deleted / failed / quarantined).
--   * accepted raw ASR is immutable; provider revisions are new revisions;
--     practitioner corrections are a separate versioned overlay; provenance
--     records the exact transcript revision used.
--   * scribe generation never overwrites practitioner work — it creates a new
--     labeled proposed draft, records model/provider/template/source-revision/
--     validation, and is idempotent per (transcript, revision, template).
--   * deletion is a durable job workflow (local + provider tracked separately,
--     legal hold, retries); content is 'deleted' only when all targets confirm,
--     leaving only permitted hashes/timestamps/proof.
--   * provider enablement is explicit + disabled by default (a BAA flag is not
--     proof of compliance).
--   * clinical audit (audit_events) vs high-volume access (security_access_log)
--     are separate; neither carries transcript text, audio refs, note content,
--     or provider payloads.
--
-- Errcodes: 28000 unauthenticated · 42501 forbidden · P0002 not found ·
-- 22023 invalid · 55000 precondition · 40003 invalid state transition.

begin;

-- 'transcript' provenance type (real transcripts now exist).
alter table public.note_provenance_refs drop constraint if exists note_provenance_refs_ref_type_check;
alter table public.note_provenance_refs add constraint note_provenance_refs_ref_type_check
  check (ref_type in ('appointment','encounter','lab_observation','lab_document',
                      'patient_form','chart_item','practitioner_entered','transcript'));

-- ==================================================================== req 8
-- Provider enablement — DISABLED by default. A BAA env flag is NOT proof; a
-- real deployment must record the region, encryption + retention config, and
-- an operational-readiness reference before a real provider can be used.
create table public.provider_enablements (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid references public.organizations(id) on delete cascade,  -- null = platform default
  provider          text not null check (provider in ('aws_healthscribe')),
  enabled           boolean not null default false,
  region            text,
  encryption_config jsonb not null default '{}'::jsonb,
  retention_config  jsonb not null default '{}'::jsonb,
  readiness_ref     text,           -- operational readiness record (external)
  baa_reference     text,           -- pointer to the executed BAA (NOT proof by itself)
  enabled_by        uuid references auth.users(id),
  enabled_at        timestamptz,
  updated_at        timestamptz not null default now(),
  unique (organization_id, provider)
);

-- ==================================================================== req 7
create table public.org_retention_policies (
  organization_id             uuid primary key references public.organizations(id) on delete cascade,
  audio_max_hours             integer not null default 24 check (audio_max_hours > 0 and audio_max_hours <= 24),
  transcript_correction_hours integer not null default 168 check (transcript_correction_hours >= 0),
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references auth.users(id)
);

-- ==================================================================== req 2
-- Immutable, versioned consent ARTIFACT — the exact content presented, not
-- only its hash. Superseding creates a new version; rows are never edited.
create table public.consent_documents (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid references public.organizations(id) on delete cascade,  -- null = shared template
  scope               text not null check (scope in ('recording','transcription','ai_drafting')),
  version             integer not null,
  locale              text not null default 'en',
  jurisdiction        text,
  title               text not null,
  body                text not null,                 -- exact immutable content presented
  presentation_format text not null default 'text/markdown'
                        check (presentation_format in ('text/plain','text/markdown','text/html')),
  content_sha256      text not null,                 -- integrity proof, NOT a replacement
  effective_date      date not null default current_date,
  superseded_at       timestamptz,
  superseded_by       uuid references public.consent_documents(id),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id),
  unique (organization_id, scope, version, locale)
);

-- ==================================================================== req 1
create table public.encounter_recording_participants (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  encounter_id     uuid not null references public.encounters(id) on delete cascade,
  patient_id       uuid not null references public.patient_profiles(id) on delete cascade,
  participant_kind text not null check (participant_kind in ('patient','caregiver','practitioner','other')),
  user_id          uuid references auth.users(id),
  display_name     text not null,
  relationship     text,
  -- capacity: does this participant consent for themselves, or does a
  -- representative act on their behalf (minor / LAR / unable to consent)?
  can_self_consent boolean not null default true,
  joined_at        timestamptz not null default now(),
  left_at          timestamptz,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id)
);
create index erp_encounter_idx on public.encounter_recording_participants (encounter_id);

create table public.encounter_consents (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  encounter_id             uuid not null references public.encounters(id) on delete cascade,
  patient_id               uuid not null references public.patient_profiles(id) on delete cascade,
  participant_id           uuid not null references public.encounter_recording_participants(id) on delete cascade,
  scope                    text not null check (scope in ('recording','transcription','ai_drafting')),
  consent_document_id      uuid not null references public.consent_documents(id),
  jurisdiction             text,
  method                   text not null check (method in ('verbal_attested','written','electronic_signature')),
  signer_acknowledgment    text not null,            -- what the signer affirmed
  acknowledged_at          timestamptz not null default now(),
  -- representative authority when the participant cannot self-consent
  representative_name         text,
  representative_relationship text,
  representative_basis        text check (representative_basis in
                                ('minor_guardian','legal_authorized_representative','surrogate_unable_to_consent')),
  representative_authority    text,
  status                   text not null default 'granted' check (status in ('granted','withdrawn')),
  granted_at               timestamptz not null default now(),
  granted_by               uuid not null references auth.users(id),
  withdrawn_at             timestamptz,
  withdrawn_by             uuid references auth.users(id),
  withdrawal_reason        text
);
create unique index encounter_consents_active_idx
  on public.encounter_consents (participant_id, scope) where status = 'granted';
create index encounter_consents_encounter_idx on public.encounter_consents (encounter_id, scope);

-- ============================================================ req 4 (recordings)
create table public.encounter_recordings (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  encounter_id           uuid not null references public.encounters(id) on delete cascade,
  patient_id             uuid not null references public.patient_profiles(id) on delete cascade,
  provider               text not null check (provider in ('fixture','aws_healthscribe')),
  provider_job_id        text,
  status                 text not null default 'authorized' check (status in
                           ('authorized','capturing','paused','uploading','uploaded','transcription_queued',
                            'transcribing','transcript_ready','review_pending','finalized',
                            'deletion_pending','deleted','failed','quarantined')),
  storage_object_key     text,
  content_type           text,
  max_bytes              bigint,
  audio_sha256           text,
  audio_bytes            bigint,
  duration_ms            integer,
  region                 text,
  encryption_state       text not null default 'unknown'
                           check (encryption_state in ('unknown','fixture_local','sse_kms','provider_managed')),
  validation_result      jsonb,
  legal_hold             boolean not null default false,
  deletion_deadline      timestamptz not null,
  audio_deleted_at       timestamptz,
  deletion_proof         text,
  failure_reason         text,
  created_at             timestamptz not null default now(),
  created_by             uuid references auth.users(id),
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users(id)
);
create index recordings_encounter_idx on public.encounter_recordings (encounter_id);
create index recordings_deletion_idx on public.encounter_recordings (deletion_deadline)
  where status not in ('deleted');
create trigger encounter_recordings_set_updated_at
  before update on public.encounter_recordings for each row execute function public.set_updated_at();

create table public.recording_state_transitions (
  id           uuid primary key default gen_random_uuid(),
  recording_id uuid not null references public.encounter_recordings(id) on delete cascade,
  from_status  text,
  to_status    text not null,
  reason       text,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id)
);
create index rst_recording_idx on public.recording_state_transitions (recording_id, created_at);

-- ==================================================================== req 1,3
-- Revocation-aware capture session (heartbeat) + opaque bound authorizations.
create table public.capture_sessions (
  id             uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  encounter_id   uuid not null references public.encounters(id) on delete cascade,
  patient_id     uuid not null references public.patient_profiles(id) on delete cascade,
  recording_id   uuid not null references public.encounter_recordings(id) on delete cascade,
  scope          text not null default 'recording' check (scope = 'recording'),
  status         text not null default 'active' check (status in ('active','paused','revoked','closed')),
  pause_reason   text check (pause_reason in ('participant_joined','consent_withdrawn')),
  last_heartbeat_at timestamptz not null default now(),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  opened_by      uuid references auth.users(id),
  unique (recording_id)
);

create table public.capture_authorizations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  encounter_id       uuid not null references public.encounters(id) on delete cascade,
  patient_id         uuid not null references public.patient_profiles(id) on delete cascade,
  recording_id       uuid not null references public.encounter_recordings(id) on delete cascade,
  session_id         uuid references public.capture_sessions(id) on delete cascade,
  permitted_action   text not null check (permitted_action in ('chunk_upload','complete_upload')),
  storage_object_key text not null,
  content_type       text not null,
  max_bytes          bigint not null,
  nonce              text not null,
  token_sha256       text not null unique,
  issued_at          timestamptz not null default now(),
  expires_at         timestamptz not null,
  issued_by          uuid not null references auth.users(id),
  consumed_at        timestamptz,
  revoked_at         timestamptz
);
create index capauth_recording_idx on public.capture_authorizations (recording_id);

-- ============================================================ req 5 (transcripts)
create table public.encounter_transcripts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  encounter_id    uuid not null references public.encounters(id) on delete cascade,
  patient_id      uuid not null references public.patient_profiles(id) on delete cascade,
  recording_id    uuid not null references public.encounter_recordings(id) on delete cascade,
  provider        text not null,
  provider_job_id text,
  -- revision increments whenever provider revisions or corrections change the
  -- effective text; provenance records the exact revision used for a draft.
  revision        integer not null default 1,
  status          text not null default 'accepted' check (status in ('accepted','corrected','finalized')),
  created_at      timestamptz not null default now(),
  finalized_at    timestamptz,
  finalized_by    uuid references auth.users(id),
  unique (recording_id)
);

-- Accepted raw ASR segments — immutable.
create table public.transcript_segments (
  id           uuid primary key default gen_random_uuid(),
  transcript_id uuid not null references public.encounter_transcripts(id) on delete cascade,
  seq          integer not null,
  speaker_label text,
  start_ms     integer,
  end_ms       integer,
  text         text not null,
  confidence   numeric,
  created_at   timestamptz not null default now(),
  unique (transcript_id, seq)
);
create index transcript_segments_idx on public.transcript_segments (transcript_id, seq);

-- Provider revisions: NEW revisions, never mutations of the accepted segment.
create table public.transcript_segment_revisions (
  id           uuid primary key default gen_random_uuid(),
  segment_id   uuid not null references public.transcript_segments(id) on delete cascade,
  revision     integer not null,
  text         text not null,
  confidence   numeric,
  provider_job_id text,
  created_at   timestamptz not null default now(),
  unique (segment_id, revision)
);

-- Practitioner correction overlay: separate, versioned, references source rev.
create table public.transcript_corrections (
  id            uuid primary key default gen_random_uuid(),
  transcript_id uuid not null references public.encounter_transcripts(id) on delete cascade,
  segment_id    uuid not null references public.transcript_segments(id) on delete cascade,
  version       integer not null,
  source_revision integer not null default 0,   -- provider revision this correction was based on
  corrected_text text not null,
  reason        text,
  created_at    timestamptz not null default now(),
  created_by    uuid not null references auth.users(id),
  unique (segment_id, version)
);
create index transcript_corrections_idx on public.transcript_corrections (transcript_id);

-- ============================================================ req 6 (scribe)
create table public.scribe_generations (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  encounter_id         uuid not null references public.encounters(id) on delete cascade,
  patient_id           uuid not null references public.patient_profiles(id) on delete cascade,
  transcript_id        uuid not null references public.encounter_transcripts(id) on delete cascade,
  source_transcript_revision integer not null,
  note_id              uuid references public.clinical_notes(id) on delete set null,
  model                text not null,
  provider             text not null,
  prompt_template_version text not null,
  validation_result    jsonb,
  status               text not null default 'proposed' check (status in ('proposed','superseded')),
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users(id),
  unique (transcript_id, source_transcript_revision, prompt_template_version)
);

-- ============================================================ req 7 (deletion)
create table public.recording_deletion_jobs (
  id              uuid primary key default gen_random_uuid(),
  recording_id    uuid not null references public.encounter_recordings(id) on delete cascade,
  target          text not null check (target in ('local','provider')),
  status          text not null default 'pending' check (status in ('pending','in_progress','confirmed','failed')),
  attempts        integer not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  confirmation_ref text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (recording_id, target)
);
create trigger recording_deletion_jobs_set_updated_at
  before update on public.recording_deletion_jobs for each row execute function public.set_updated_at();

-- ==================================================================== req 10
-- High-volume access events — separate from the clinical audit trail. Carries
-- identifiers only; never transcript text, note content, or provider payloads.
create table public.security_access_log (
  id            uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id    uuid references public.patient_profiles(id) on delete set null,
  actor_user_id uuid references auth.users(id),
  action        text not null,
  resource_type text,
  resource_id   text,
  occurred_at   timestamptz not null default now()
);
create index security_access_log_idx on public.security_access_log (organization_id, occurred_at desc);

-- ---------------------------------------------------------- append-only locks
create trigger consent_documents_immutable
  before update or delete on public.consent_documents for each row execute function private.forbid_mutation();
create trigger transcript_segments_append_only
  before update or delete on public.transcript_segments for each row execute function private.forbid_mutation();
create trigger transcript_segment_revisions_append_only
  before update or delete on public.transcript_segment_revisions for each row execute function private.forbid_mutation();
create trigger transcript_corrections_append_only
  before update or delete on public.transcript_corrections for each row execute function private.forbid_mutation();
create trigger encounter_consents_no_delete
  before delete on public.encounter_consents for each row execute function private.forbid_mutation();
create trigger recording_state_transitions_append_only
  before update or delete on public.recording_state_transitions for each row execute function private.forbid_mutation();
create trigger security_access_log_append_only
  before update or delete on public.security_access_log for each row execute function private.forbid_mutation();

-- --------------------------------------------------------------------- RLS
alter table public.provider_enablements               enable row level security;
alter table public.org_retention_policies             enable row level security;
alter table public.consent_documents                  enable row level security;
alter table public.encounter_recording_participants   enable row level security;
alter table public.encounter_consents                 enable row level security;
alter table public.encounter_recordings               enable row level security;
alter table public.recording_state_transitions        enable row level security;
alter table public.capture_sessions                   enable row level security;
alter table public.capture_authorizations             enable row level security;
alter table public.encounter_transcripts              enable row level security;
alter table public.transcript_segments                enable row level security;
alter table public.transcript_segment_revisions       enable row level security;
alter table public.transcript_corrections             enable row level security;
alter table public.scribe_generations                 enable row level security;
alter table public.recording_deletion_jobs            enable row level security;
alter table public.security_access_log                enable row level security;

create policy provider_enablements_select on public.provider_enablements
  for select using (organization_id is null or private.is_org_member(organization_id));
create policy retention_select on public.org_retention_policies
  for select using (private.is_org_member(organization_id));
create policy consent_docs_select on public.consent_documents
  for select using (organization_id is null or private.is_org_member(organization_id));
create policy erp_select on public.encounter_recording_participants
  for select using (private.can_access_patient(patient_id));
create policy consents_select on public.encounter_consents
  for select using (private.can_access_patient(patient_id));
create policy recordings_select on public.encounter_recordings
  for select using (private.can_access_patient(patient_id));
create policy rst_select on public.recording_state_transitions
  for select using (exists (select 1 from public.encounter_recordings r
    where r.id = recording_id and private.can_access_patient(r.patient_id)));
create policy sessions_select on public.capture_sessions
  for select using (private.can_access_patient(patient_id));
-- Authorization token hashes: no plaintext column exists; identifiers only.
create policy capauth_select on public.capture_authorizations
  for select using (private.can_access_patient(patient_id));
create policy transcripts_select on public.encounter_transcripts
  for select using (private.can_access_patient(patient_id));
create policy segments_select on public.transcript_segments
  for select using (exists (select 1 from public.encounter_transcripts t
    where t.id = transcript_id and private.can_access_patient(t.patient_id)));
create policy segment_revisions_select on public.transcript_segment_revisions
  for select using (exists (select 1 from public.transcript_segments s
    join public.encounter_transcripts t on t.id = s.transcript_id
    where s.id = segment_id and private.can_access_patient(t.patient_id)));
create policy corrections_select on public.transcript_corrections
  for select using (exists (select 1 from public.encounter_transcripts t
    where t.id = transcript_id and private.can_access_patient(t.patient_id)));
create policy scribe_gen_select on public.scribe_generations
  for select using (private.can_access_patient(patient_id));
create policy deletion_jobs_select on public.recording_deletion_jobs
  for select using (exists (select 1 from public.encounter_recordings r
    where r.id = recording_id and private.can_access_patient(r.patient_id)));
create policy security_access_select on public.security_access_log
  for select using (private.is_org_member(organization_id));

-- ------------------------------------------- helper: all-participant consent
-- Every ACTIVE (not-left) participant must have a current granted consent for
-- the scope, and there must be at least one participant.
create or replace function private.all_participants_consented(_encounter_id uuid, _scope text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.encounter_recording_participants p
                 where p.encounter_id = _encounter_id and p.left_at is null)
     and not exists (
       select 1 from public.encounter_recording_participants p
       where p.encounter_id = _encounter_id and p.left_at is null
         and not exists (
           select 1 from public.encounter_consents c
           where c.participant_id = p.id and c.scope = _scope and c.status = 'granted'));
$$;
revoke all on function private.all_participants_consented(uuid, text) from public, anon;
grant execute on function private.all_participants_consented(uuid, text) to authenticated;

-- ------------------------------------------- helper: recording transition map
create or replace function private.recording_transition_ok(_from text, _to text)
returns boolean language sql immutable set search_path = ''
as $$
  -- deletion_pending is reachable from every non-terminal state: the retention
  -- deadline is a hard maximum, and deletion is always a forward transition.
  select (_from, _to) in (
    ('authorized','capturing'),('authorized','failed'),('authorized','quarantined'),('authorized','deletion_pending'),
    ('capturing','paused'),('capturing','uploading'),('capturing','failed'),('capturing','quarantined'),('capturing','deletion_pending'),
    ('paused','capturing'),('paused','uploading'),('paused','failed'),('paused','quarantined'),('paused','deletion_pending'),
    ('uploading','uploaded'),('uploading','failed'),('uploading','quarantined'),('uploading','deletion_pending'),
    ('uploaded','transcription_queued'),('uploaded','quarantined'),('uploaded','failed'),('uploaded','deletion_pending'),
    ('transcription_queued','transcribing'),('transcription_queued','failed'),('transcription_queued','deletion_pending'),
    ('transcribing','transcript_ready'),('transcribing','failed'),('transcribing','deletion_pending'),
    ('transcript_ready','review_pending'),('transcript_ready','failed'),('transcript_ready','deletion_pending'),
    ('review_pending','finalized'),('review_pending','failed'),('review_pending','deletion_pending'),
    ('finalized','deletion_pending'),
    ('deletion_pending','deleted'),('deletion_pending','failed'),
    ('failed','deletion_pending'),('failed','quarantined'),
    ('quarantined','deletion_pending'));
$$;
revoke all on function private.recording_transition_ok(text, text) from public, anon;
grant execute on function private.recording_transition_ok(text, text) to authenticated;

-- ------------------------------------------- helper: apply a recording transition
-- Validates the transition, updates status, logs it. Rejects invalid/backward.
create or replace function private.transition_recording(_recording_id uuid, _to text, _reason text, _uid uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _from text;
begin
  select status into _from from public.encounter_recordings where id = _recording_id for update;
  if _from is null then raise exception 'recording not found' using errcode = 'P0002'; end if;
  if _from = _to then return; end if;
  if not private.recording_transition_ok(_from, _to) then
    raise exception 'invalid recording transition % -> %', _from, _to using errcode = '40003';
  end if;
  update public.encounter_recordings set status = _to, updated_by = _uid where id = _recording_id;
  insert into public.recording_state_transitions (recording_id, from_status, to_status, reason, created_by)
  values (_recording_id, _from, _to, _reason, _uid);
end;
$$;
revoke all on function private.transition_recording(uuid, text, text, uuid) from public, anon;
grant execute on function private.transition_recording(uuid, text, text, uuid) to authenticated;

-- ================================================================ RPCs: consent
create or replace function public.add_recording_participant(
  _encounter_id uuid, _participant_kind text, _display_name text,
  _relationship text default null, _user_id uuid default null, _can_self_consent boolean default true
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _e public.encounters%rowtype; _id uuid; _rec record;
begin
  select * into _e from public.encounters where id = _encounter_id and deleted_at is null;
  if not found then raise exception 'encounter not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_e.organization_id, _e.patient_id);
  if _participant_kind not in ('patient','caregiver','practitioner','other') then
    raise exception 'invalid participant kind' using errcode = '22023'; end if;
  if _display_name is null or btrim(_display_name) = '' then
    raise exception 'a display name is required' using errcode = '22023'; end if;
  insert into public.encounter_recording_participants
    (organization_id, encounter_id, patient_id, participant_kind, user_id, display_name, relationship, can_self_consent, created_by)
  values (_e.organization_id, _encounter_id, _e.patient_id, _participant_kind, _user_id,
          left(btrim(_display_name), 200), _relationship, coalesce(_can_self_consent, true), _uid)
  returning id into _id;

  -- req 1 (late join): if capture is live, PAUSE it until the new participant
  -- is identified and grants the required scopes.
  update public.capture_sessions s
     set status = 'paused', pause_reason = 'participant_joined'
   where s.encounter_id = _encounter_id and s.status = 'active';
  for _rec in select r.id from public.encounter_recordings r
              where r.encounter_id = _encounter_id and r.status = 'capturing' loop
    perform private.transition_recording(_rec.id, 'paused', 'participant joined', _uid);
  end loop;
  return _id;
end; $$;

create or replace function public.record_consent(
  _participant_id uuid, _scope text, _consent_document_id uuid, _method text, _signer_acknowledgment text,
  _jurisdiction text default null, _representative_name text default null,
  _representative_relationship text default null, _representative_basis text default null,
  _representative_authority text default null
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _p public.encounter_recording_participants%rowtype; _e public.encounters%rowtype; _id uuid;
begin
  select * into _p from public.encounter_recording_participants where id = _participant_id;
  if not found then raise exception 'participant not found' using errcode = 'P0002'; end if;
  select * into _e from public.encounters where id = _p.encounter_id;
  _uid := private.require_clinical_actor(_e.organization_id, _e.patient_id);
  if _scope not in ('recording','transcription','ai_drafting') then
    raise exception 'invalid scope' using errcode = '22023'; end if;
  if _method not in ('verbal_attested','written','electronic_signature') then
    raise exception 'invalid consent method' using errcode = '22023'; end if;
  if _signer_acknowledgment is null or btrim(_signer_acknowledgment) = '' then
    raise exception 'a signer acknowledgment is required' using errcode = '22023'; end if;
  -- Representative authority is mandatory when the participant cannot self-consent.
  if not _p.can_self_consent and (_representative_basis is null or _representative_authority is null) then
    raise exception 'representative basis and authority are required for a participant who cannot self-consent'
      using errcode = '22023'; end if;
  if _representative_basis is not null and _representative_basis not in
     ('minor_guardian','legal_authorized_representative','surrogate_unable_to_consent') then
    raise exception 'invalid representative basis' using errcode = '22023'; end if;
  if not exists (select 1 from public.consent_documents d
                 where d.id = _consent_document_id and d.scope = _scope and d.is_active
                   and (d.organization_id is null or d.organization_id = _e.organization_id)) then
    raise exception 'active consent document not found for this scope' using errcode = '22023'; end if;
  select id into _id from public.encounter_consents
    where participant_id = _participant_id and scope = _scope and status = 'granted';
  if found then return _id; end if;
  insert into public.encounter_consents
    (organization_id, encounter_id, patient_id, participant_id, scope, consent_document_id, jurisdiction,
     method, signer_acknowledgment, representative_name, representative_relationship, representative_basis,
     representative_authority, status, granted_by)
  values (_e.organization_id, _p.encounter_id, _e.patient_id, _participant_id, _scope, _consent_document_id, _jurisdiction,
          _method, _signer_acknowledgment, _representative_name, _representative_relationship, _representative_basis,
          _representative_authority, 'granted', _uid)
  returning id into _id;
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_e.organization_id, _e.patient_id, _uid, 'consent.granted', 'encounter_consent', _id::text,
    'Consent recorded', jsonb_build_object('scope', _scope, 'method', _method,
      'representative', (_representative_basis is not null)));
  return _id;
end; $$;

-- req 1 ACTIVE revocation: revoke live authorizations + session, pause capture.
create or replace function public.withdraw_consent(_consent_id uuid, _reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _c public.encounter_consents%rowtype; _rec record;
begin
  select * into _c from public.encounter_consents where id = _consent_id;
  if not found then raise exception 'consent not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_c.organization_id, _c.patient_id);
  if _c.status = 'withdrawn' then return; end if;
  update public.encounter_consents
     set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = _uid, withdrawal_reason = _reason
   where id = _c.id;
  if _c.scope = 'recording' then
    -- revoke every live authorization for this encounter immediately
    update public.capture_authorizations a set revoked_at = now()
      from public.encounter_recordings r
     where a.recording_id = r.id and r.encounter_id = _c.encounter_id
       and a.consumed_at is null and a.revoked_at is null;
    -- revoke live sessions and pause any active/capturing recording
    update public.capture_sessions set status = 'revoked', pause_reason = 'consent_withdrawn', closed_at = now()
     where encounter_id = _c.encounter_id and status in ('active','paused');
    for _rec in select r.id from public.encounter_recordings r
                where r.encounter_id = _c.encounter_id and r.status = 'capturing' loop
      perform private.transition_recording(_rec.id, 'paused', 'consent withdrawn', _uid);
    end loop;
  end if;
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_c.organization_id, _c.patient_id, _uid, 'consent.withdrawn', 'encounter_consent', _c.id::text,
    'Consent withdrawn', jsonb_build_object('scope', _c.scope));
end; $$;

-- ================================================ RPCs: capture session + tokens
-- Begin a recording: validate ALL-participant recording consent + provider
-- enablement, create the recording (server owns all identifiers + object key),
-- open a session, and issue the first chunk-upload authorization. Returns the
-- RAW token exactly once.
create or replace function public.begin_recording(
  _encounter_id uuid, _provider text, _content_type text, _max_bytes bigint, _ttl_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _e public.encounters%rowtype; _rid uuid; _sid uuid; _token text; _nonce text;
        _objkey text; _exp timestamptz; _policy_hours integer; _enc_state text; _region text;
begin
  select * into _e from public.encounters where id = _encounter_id and deleted_at is null;
  if not found then raise exception 'encounter not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_e.organization_id, _e.patient_id);
  if _e.status <> 'in_progress' then raise exception 'encounter is not in progress' using errcode = '55000'; end if;
  if _provider not in ('fixture','aws_healthscribe') then
    raise exception 'invalid provider' using errcode = '22023'; end if;
  if _content_type is null or _content_type not in
     ('audio/webm','audio/ogg','audio/wav','audio/mp4','audio/mpeg') then
    raise exception 'unsupported audio content type' using errcode = '22023'; end if;
  if _max_bytes is null or _max_bytes <= 0 or _max_bytes > 2147483648 then
    raise exception 'invalid max size' using errcode = '22023'; end if;
  if not private.all_participants_consented(_encounter_id, 'recording') then
    raise exception 'recording consent has not been granted by all participants' using errcode = '55000'; end if;
  if exists (select 1 from public.encounter_recordings r
             where r.encounter_id = _encounter_id
               and r.status in ('authorized','capturing','paused','uploading')) then
    raise exception 'a recording is already in progress for this encounter' using errcode = '55000'; end if;

  -- req 8: a real provider must be explicitly enabled (BAA flag is not proof).
  -- Disabled by default: with no qualifying enablement row this raises a clean
  -- precondition error rather than silently falling back to fixture.
  if _provider = 'aws_healthscribe' then
    select coalesce(pe.region, 'unknown')
      into _region
      from public.provider_enablements pe
     where pe.provider = 'aws_healthscribe' and pe.enabled = true
       and (pe.organization_id = _e.organization_id or pe.organization_id is null)
       and pe.region is not null and pe.readiness_ref is not null
       and pe.encryption_config <> '{}'::jsonb and pe.retention_config <> '{}'::jsonb
     order by pe.organization_id nulls last limit 1;
    if not found then
      raise exception 'provider aws_healthscribe is not enabled for this organization' using errcode = '55000'; end if;
    _enc_state := 'provider_managed';
  else
    _enc_state := 'fixture_local'; _region := 'local';
  end if;

  select coalesce(audio_max_hours, 24) into _policy_hours
    from public.org_retention_policies where organization_id = _e.organization_id;
  if _policy_hours is null then _policy_hours := 24; end if;

  _nonce := replace(gen_random_uuid()::text, '-', '');
  insert into public.encounter_recordings
    (organization_id, encounter_id, patient_id, provider, status, content_type, max_bytes, region,
     encryption_state, deletion_deadline, created_by)
  values (_e.organization_id, _encounter_id, _e.patient_id, _provider, 'authorized', _content_type, _max_bytes, _region,
          _enc_state, now() + make_interval(hours => _policy_hours), _uid)
  returning id into _rid;
  _objkey := 'rec/' || _rid::text || '/' || _nonce;
  update public.encounter_recordings set storage_object_key = _objkey where id = _rid;

  insert into public.capture_sessions (organization_id, encounter_id, patient_id, recording_id, status, opened_by)
  values (_e.organization_id, _encounter_id, _e.patient_id, _rid, 'active', _uid)
  returning id into _sid;

  _token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  _exp := now() + make_interval(secs => greatest(30, least(600, coalesce(_ttl_seconds,120))));
  insert into public.capture_authorizations
    (organization_id, encounter_id, patient_id, recording_id, session_id, permitted_action,
     storage_object_key, content_type, max_bytes, nonce, token_sha256, expires_at, issued_by)
  values (_e.organization_id, _encounter_id, _e.patient_id, _rid, _sid, 'chunk_upload',
          _objkey, _content_type, _max_bytes, _nonce, private.sha256_hex(_token), _exp, _uid);

  perform private.transition_recording(_rid, 'capturing', 'begin_recording', _uid);

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_e.organization_id, _e.patient_id, _uid, 'recording.started', 'encounter_recording', _rid::text,
    'Recording started', jsonb_build_object('provider', _provider));
  return jsonb_build_object('recording_id', _rid, 'session_id', _sid, 'token', _token,
    'storage_object_key', _objkey, 'expires_at', _exp, 'content_type', _content_type, 'max_bytes', _max_bytes);
end; $$;

-- Heartbeat: re-validate consent + session on every beat. If consent is gone,
-- revoke the session and pause the recording (active revocation). A healthy
-- ACTIVE beat also rotates the chunk authorization, so token expiries stay
-- short without a long recording ever outrunning its token.
create or replace function public.heartbeat_capture(_session_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _s public.capture_sessions%rowtype; _r public.encounter_recordings%rowtype;
        _token text; _exp timestamptz;
begin
  select * into _s from public.capture_sessions where id = _session_id;
  if not found then raise exception 'session not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_s.organization_id, _s.patient_id);
  if _s.status = 'revoked' then raise exception 'capture session revoked' using errcode = '55000'; end if;
  update public.capture_sessions set last_heartbeat_at = now() where id = _s.id;
  -- A paused session just reports paused: an un-consented late joiner is the
  -- EXPECTED state during a participant_joined pause. No token is issued.
  if _s.status <> 'active' then
    return jsonb_build_object('status', _s.status, 'ok', false);
  end if;
  -- Active beats re-validate consent; loss triggers active revocation.
  if not private.all_participants_consented(_s.encounter_id, 'recording') then
    update public.capture_sessions set status = 'revoked', pause_reason = 'consent_withdrawn', closed_at = now() where id = _s.id;
    update public.capture_authorizations set revoked_at = now() where recording_id = _s.recording_id and consumed_at is null and revoked_at is null;
    if exists (select 1 from public.encounter_recordings where id = _s.recording_id and status = 'capturing') then
      perform private.transition_recording(_s.recording_id, 'paused', 'consent no longer valid', _uid);
    end if;
    raise exception 'recording consent is no longer valid' using errcode = '55000';
  end if;
  select * into _r from public.encounter_recordings where id = _s.recording_id;
  _token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  _exp := now() + interval '120 seconds';
  insert into public.capture_authorizations
    (organization_id, encounter_id, patient_id, recording_id, session_id, permitted_action,
     storage_object_key, content_type, max_bytes, nonce, token_sha256, expires_at, issued_by)
  values (_s.organization_id, _s.encounter_id, _s.patient_id, _s.recording_id, _s.id, 'chunk_upload',
          _r.storage_object_key, _r.content_type, _r.max_bytes,
          replace(gen_random_uuid()::text, '-', ''), private.sha256_hex(_token), _exp, _uid);
  return jsonb_build_object('status', _s.status, 'ok', true, 'token', _token, 'expires_at', _exp);
end; $$;

-- Resume after a pause (late join or transient): re-validate all-participant
-- consent, reopen the session, return capture to 'capturing'.
create or replace function public.resume_capture(_session_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _s public.capture_sessions%rowtype;
begin
  select * into _s from public.capture_sessions where id = _session_id;
  if not found then raise exception 'session not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_s.organization_id, _s.patient_id);
  if _s.status = 'revoked' then raise exception 'a revoked session cannot resume' using errcode = '55000'; end if;
  if not private.all_participants_consented(_s.encounter_id, 'recording') then
    raise exception 'all participants must consent before resuming' using errcode = '55000'; end if;
  update public.capture_sessions set status = 'active', pause_reason = null where id = _s.id;
  perform private.transition_recording(_s.recording_id, 'capturing', 'resume', _uid);
end; $$;

-- Per-chunk authorization (req 1 + 3): every chunk re-validates the bound
-- token, the revocation-aware session (must be ACTIVE — a paused capture
-- refuses chunks server-side), and all-participant consent. Short token
-- expiry alone is never relied on.
create or replace function public.authorize_chunk(_recording_id uuid, _capture_token text, _chunk_bytes bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _r public.encounter_recordings%rowtype; _a public.capture_authorizations%rowtype;
        _s public.capture_sessions%rowtype;
begin
  select * into _r from public.encounter_recordings where id = _recording_id;
  if not found then raise exception 'recording not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_r.organization_id, _r.patient_id);
  select * into _a from public.capture_authorizations
    where token_sha256 = private.sha256_hex(coalesce(_capture_token,'')) and recording_id = _recording_id;
  if not found then raise exception 'no valid capture authorization' using errcode = '55000'; end if;
  if _a.permitted_action <> 'chunk_upload' then
    raise exception 'authorization does not permit chunk upload' using errcode = '55000'; end if;
  if _a.revoked_at is not null then raise exception 'capture authorization revoked' using errcode = '55000'; end if;
  if _a.expires_at <= now() then raise exception 'capture authorization expired' using errcode = '55000'; end if;
  if _chunk_bytes is null or _chunk_bytes <= 0 or _chunk_bytes > _a.max_bytes then
    raise exception 'chunk exceeds the authorized size' using errcode = '55000'; end if;
  select * into _s from public.capture_sessions where id = _a.session_id;
  if not found or _s.status <> 'active' then
    raise exception 'capture session is not active' using errcode = '55000'; end if;
  if not private.all_participants_consented(_r.encounter_id, 'recording') then
    raise exception 'recording consent is no longer valid' using errcode = '55000'; end if;
  update public.capture_sessions set last_heartbeat_at = now() where id = _s.id;
  return jsonb_build_object('storage_object_key', _a.storage_object_key,
    'content_type', _a.content_type, 'max_bytes', _a.max_bytes);
end; $$;

-- Single-use completion authorization: a distinct permitted action from chunk
-- upload, so a chunk token can never complete an upload (and vice versa).
create or replace function public.issue_completion_authorization(_session_id uuid, _ttl_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _s public.capture_sessions%rowtype; _r public.encounter_recordings%rowtype;
        _token text; _exp timestamptz;
begin
  select * into _s from public.capture_sessions where id = _session_id;
  if not found then raise exception 'session not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_s.organization_id, _s.patient_id);
  if _s.status = 'revoked' then raise exception 'capture session revoked' using errcode = '55000'; end if;
  if not private.all_participants_consented(_s.encounter_id, 'recording') then
    raise exception 'recording consent is no longer valid' using errcode = '55000'; end if;
  select * into _r from public.encounter_recordings where id = _s.recording_id;
  if _r.status not in ('capturing','paused') then
    raise exception 'recording is not ready for upload completion' using errcode = '55000'; end if;
  _token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  _exp := now() + make_interval(secs => greatest(30, least(600, coalesce(_ttl_seconds,120))));
  insert into public.capture_authorizations
    (organization_id, encounter_id, patient_id, recording_id, session_id, permitted_action,
     storage_object_key, content_type, max_bytes, nonce, token_sha256, expires_at, issued_by)
  values (_s.organization_id, _s.encounter_id, _s.patient_id, _s.recording_id, _s.id, 'complete_upload',
          _r.storage_object_key, _r.content_type, _r.max_bytes,
          replace(gen_random_uuid()::text, '-', ''), private.sha256_hex(_token), _exp, _uid);
  return jsonb_build_object('token', _token, 'expires_at', _exp);
end; $$;

-- Idempotent upload completion. Validates the bound token (object, content
-- type, size, expiry, not consumed/revoked) and the declared content, then
-- moves to 'uploaded'. Invalid content quarantines instead of processing.
create or replace function public.complete_upload(
  _recording_id uuid, _capture_token text, _storage_object_key text,
  _audio_sha256 text, _audio_bytes bigint, _content_type text, _duration_ms integer
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _r public.encounter_recordings%rowtype; _a public.capture_authorizations%rowtype;
begin
  select * into _r from public.encounter_recordings where id = _recording_id;
  if not found then raise exception 'recording not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_r.organization_id, _r.patient_id);
  -- Idempotent: a second callback for an already-uploaded object is a no-op.
  if _r.status in ('uploaded','transcription_queued','transcribing','transcript_ready','review_pending','finalized') then
    return jsonb_build_object('recording_id', _r.id, 'status', _r.status, 'idempotent', true);
  end if;
  select * into _a from public.capture_authorizations
    where token_sha256 = private.sha256_hex(coalesce(_capture_token,'')) and recording_id = _recording_id;
  if not found then raise exception 'no valid capture authorization' using errcode = '55000'; end if;
  if _a.permitted_action <> 'complete_upload' then
    raise exception 'authorization does not permit upload completion' using errcode = '55000'; end if;
  if _a.consumed_at is not null then
    raise exception 'capture authorization already used' using errcode = '55000'; end if;
  if _a.revoked_at is not null then raise exception 'capture authorization revoked' using errcode = '55000'; end if;
  if _a.expires_at <= now() then raise exception 'capture authorization expired' using errcode = '55000'; end if;
  -- req 3: bound to THIS object; reuse against another object is refused.
  if _a.storage_object_key <> coalesce(_storage_object_key,'') or _a.storage_object_key <> coalesce(_r.storage_object_key,'') then
    raise exception 'authorization does not match this storage object' using errcode = '55000'; end if;
  if not private.all_participants_consented(_r.encounter_id, 'recording') then
    raise exception 'recording consent is no longer valid' using errcode = '55000'; end if;

  -- Validate declared content BEFORE processing; quarantine on mismatch.
  if _content_type is distinct from _a.content_type
     or _audio_bytes is null or _audio_bytes <= 0 or _audio_bytes > _a.max_bytes
     or _duration_ms is null or _duration_ms <= 0
     or _audio_sha256 is null or length(_audio_sha256) <> 64 then
    update public.encounter_recordings
       set validation_result = jsonb_build_object('ok', false, 'reason', 'content validation failed'), updated_by = _uid
     where id = _recording_id;
    perform private.transition_recording(_recording_id, 'quarantined', 'content validation failed', _uid);
    update public.capture_authorizations set consumed_at = now() where id = _a.id;
    return jsonb_build_object('recording_id', _r.id, 'status', 'quarantined', 'idempotent', false);
  end if;

  update public.encounter_recordings
     set audio_sha256 = _audio_sha256, audio_bytes = _audio_bytes, duration_ms = _duration_ms,
         validation_result = jsonb_build_object('ok', true), updated_by = _uid
   where id = _recording_id;
  update public.capture_authorizations set consumed_at = now() where id = _a.id;
  update public.capture_sessions set status = 'closed', closed_at = now() where recording_id = _recording_id and status in ('active','paused');
  perform private.transition_recording(_recording_id, 'uploading', 'upload received', _uid);
  perform private.transition_recording(_recording_id, 'uploaded', 'upload complete', _uid);
  return jsonb_build_object('recording_id', _r.id, 'status', 'uploaded', 'idempotent', false);
end; $$;

-- ================================================ RPCs: transcription
create or replace function public.queue_transcription(_recording_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _r public.encounter_recordings%rowtype;
begin
  select * into _r from public.encounter_recordings where id = _recording_id;
  if not found then raise exception 'recording not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_r.organization_id, _r.patient_id);
  perform private.transition_recording(_recording_id, 'transcription_queued', 'queued', _uid);
end; $$;

-- Ingest an ACCEPTED (final) transcript batch. Provisional/interim text is
-- never persisted here (req 5). Requires transcription consent. Idempotent per
-- recording. Drives transcription_queued → transcribing → transcript_ready.
create or replace function public.ingest_transcript_batch(
  _recording_id uuid, _provider_job_id text, _segments jsonb
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _r public.encounter_recordings%rowtype; _t uuid; _seg jsonb; _i integer := 0;
begin
  select * into _r from public.encounter_recordings where id = _recording_id;
  if not found then raise exception 'recording not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_r.organization_id, _r.patient_id);
  if not private.all_participants_consented(_r.encounter_id, 'transcription') then
    raise exception 'transcription consent has not been granted by all participants' using errcode = '55000'; end if;
  if jsonb_typeof(_segments) <> 'array' or jsonb_array_length(_segments) = 0 then
    raise exception 'segments must be a non-empty array' using errcode = '22023'; end if;

  select id into _t from public.encounter_transcripts where recording_id = _recording_id;
  if found then return _t; end if;   -- idempotent

  if _r.status = 'transcription_queued' then
    perform private.transition_recording(_recording_id, 'transcribing', 'transcription started', _uid);
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
  update public.encounter_recordings set provider_job_id = _provider_job_id, updated_by = _uid where id = _recording_id;
  perform private.transition_recording(_recording_id, 'transcript_ready', 'transcript received', _uid);

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_r.organization_id, _r.patient_id, _uid, 'transcription.batch_received', 'encounter_transcript', _t::text,
    'Transcript received', jsonb_build_object('segments', _i, 'provider', _r.provider));
  return _t;
end; $$;

-- Provider revision of a segment → a NEW revision (never a mutation). Bumps the
-- transcript revision so provenance can identify the exact text used.
create or replace function public.add_segment_revision(_segment_id uuid, _text text, _confidence numeric, _provider_job_id text)
returns integer language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _t public.encounter_transcripts%rowtype; _seg public.transcript_segments%rowtype; _rev integer;
begin
  select * into _seg from public.transcript_segments where id = _segment_id;
  if not found then raise exception 'segment not found' using errcode = 'P0002'; end if;
  select * into _t from public.encounter_transcripts where id = _seg.transcript_id;
  _uid := private.require_clinical_actor(_t.organization_id, _t.patient_id);
  if _t.status = 'finalized' then raise exception 'transcript is finalized' using errcode = '22023'; end if;
  select coalesce(max(revision),0)+1 into _rev from public.transcript_segment_revisions where segment_id = _segment_id;
  insert into public.transcript_segment_revisions (segment_id, revision, text, confidence, provider_job_id)
  values (_segment_id, _rev, _text, _confidence, _provider_job_id);
  update public.encounter_transcripts set revision = revision + 1 where id = _t.id;
  return _rev;
end; $$;

-- Practitioner correction overlay (versioned, separate from provider revisions).
create or replace function public.correct_transcript_segment(_segment_id uuid, _corrected_text text, _reason text default null)
returns integer language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _t public.encounter_transcripts%rowtype; _seg public.transcript_segments%rowtype; _v integer; _srev integer;
begin
  select * into _seg from public.transcript_segments where id = _segment_id;
  if not found then raise exception 'segment not found' using errcode = 'P0002'; end if;
  select * into _t from public.encounter_transcripts where id = _seg.transcript_id;
  _uid := private.require_clinical_actor(_t.organization_id, _t.patient_id);
  if _t.status = 'finalized' then raise exception 'transcript is finalized' using errcode = '22023'; end if;
  if _corrected_text is null or btrim(_corrected_text) = '' then
    raise exception 'corrected text is required' using errcode = '22023'; end if;
  select coalesce(max(version),0)+1 into _v from public.transcript_corrections where segment_id = _segment_id;
  select coalesce(max(revision),0) into _srev from public.transcript_segment_revisions where segment_id = _segment_id;
  insert into public.transcript_corrections (transcript_id, segment_id, version, source_revision, corrected_text, reason, created_by)
  values (_t.id, _segment_id, _v, _srev, _corrected_text, _reason, _uid);
  update public.encounter_transcripts set status = 'corrected', revision = revision + 1 where id = _t.id and status <> 'finalized';
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_t.organization_id, _t.patient_id, _uid, 'transcription.corrected', 'encounter_transcript', _t.id::text,
    'Transcript corrected', jsonb_build_object('version', _v));
  return _v;
end; $$;

create or replace function public.set_transcript_review(_transcript_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _t public.encounter_transcripts%rowtype;
begin
  select * into _t from public.encounter_transcripts where id = _transcript_id;
  if not found then raise exception 'transcript not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_t.organization_id, _t.patient_id);
  perform private.transition_recording(_t.recording_id, 'review_pending', 'transcript review', _uid);
end; $$;

create or replace function public.finalize_transcript(_transcript_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _t public.encounter_transcripts%rowtype;
begin
  select * into _t from public.encounter_transcripts where id = _transcript_id;
  if not found then raise exception 'transcript not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_t.organization_id, _t.patient_id);
  if _t.status = 'finalized' then return; end if;
  update public.encounter_transcripts set status = 'finalized', finalized_at = now(), finalized_by = _uid where id = _t.id;
  perform private.transition_recording(_t.recording_id, 'finalized', 'transcript finalized', _uid);
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_t.organization_id, _t.patient_id, _uid, 'transcription.finalized', 'encounter_transcript', _t.id::text,
    'Transcript finalized', '{}'::jsonb);
end; $$;

-- ================================================ RPCs: scribe generation (req 6)
-- Never overwrites practitioner work: always a NEW proposed draft note. Records
-- generation provenance and is idempotent per (transcript, revision, template).
create or replace function public.generate_scribe_draft(
  _transcript_id uuid, _note_type text, _model text, _provider text, _prompt_template_version text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _t public.encounter_transcripts%rowtype; _effective text; _content jsonb; _res jsonb;
        _existing uuid; _existing_note uuid; _nid uuid; _valid jsonb;
begin
  select * into _t from public.encounter_transcripts where id = _transcript_id;
  if not found then raise exception 'transcript not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_t.organization_id, _t.patient_id);
  if not private.all_participants_consented(_t.encounter_id, 'ai_drafting') then
    raise exception 'AI drafting consent has not been granted by all participants' using errcode = '55000'; end if;
  if _note_type not in ('soap','narrative','follow_up','adime','patient_instructions') then
    raise exception 'invalid note type' using errcode = '22023'; end if;

  -- Idempotent per (transcript, source revision, template): return prior draft.
  select id, note_id into _existing, _existing_note from public.scribe_generations
    where transcript_id = _transcript_id and source_transcript_revision = _t.revision
      and prompt_template_version = _prompt_template_version;
  if found then
    return jsonb_build_object('note_id', _existing_note, 'generation_id', _existing, 'idempotent', true);
  end if;

  -- Effective text = latest practitioner correction, else latest provider
  -- revision, else the accepted original.
  select string_agg(coalesce(
           (select tc.corrected_text from public.transcript_corrections tc where tc.segment_id = s.id order by tc.version desc limit 1),
           (select tr.text from public.transcript_segment_revisions tr where tr.segment_id = s.id order by tr.revision desc limit 1),
           s.text), E'\n' order by s.seq)
    into _effective from public.transcript_segments s where s.transcript_id = _transcript_id;

  if _note_type = 'soap' then
    _content := jsonb_build_object(
      'S', 'AI scribe draft (unreviewed, proposed). Verify against the source transcript before signing.' || E'\n\n' || coalesce(_effective,''),
      'O','', 'A','', 'P','');
  else
    _content := jsonb_build_object('text',
      'AI scribe draft (unreviewed, proposed). Verify against the source transcript before signing.' || E'\n\n' || coalesce(_effective,''));
  end if;

  _valid := jsonb_build_object('structured', true, 'sections_present', (_note_type='soap'));

  -- ALWAYS a NEW note (save_note_draft with _note_id null creates a fresh
  -- draft) — an existing manually-edited draft is never touched.
  _res := public.save_note_draft(_t.organization_id, _t.encounter_id, _note_type, _content, 0, null, 'manual',
    jsonb_build_array(jsonb_build_object('sectionKey', case when _note_type='soap' then 'S' else 'text' end,
      'refType','transcript','refId', _transcript_id::text,
      'label','Encounter transcript r'||_t.revision||' (AI scribe source)')));
  _nid := (_res->>'note_id')::uuid;

  insert into public.scribe_generations
    (organization_id, encounter_id, patient_id, transcript_id, source_transcript_revision, note_id,
     model, provider, prompt_template_version, validation_result, status, created_by)
  values (_t.organization_id, _t.encounter_id, _t.patient_id, _transcript_id, _t.revision, _nid,
          _model, _provider, _prompt_template_version, _valid, 'proposed', _uid)
  returning id into _existing;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_t.organization_id, _t.patient_id, _uid, 'scribe.draft_generated', 'clinical_note', _nid::text,
    'Scribe draft generated', jsonb_build_object('transcript_revision', _t.revision, 'model', _model, 'provider', _provider));
  return jsonb_build_object('note_id', _nid, 'generation_id', _existing, 'idempotent', false);
end; $$;

-- ================================================ RPCs: durable deletion (req 7)
create or replace function public.request_recording_deletion(_recording_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _r public.encounter_recordings%rowtype;
begin
  select * into _r from public.encounter_recordings where id = _recording_id;
  if not found then raise exception 'recording not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_r.organization_id, _r.patient_id);
  if _r.legal_hold then raise exception 'recording is under legal hold' using errcode = '55000'; end if;
  perform private.transition_recording(_recording_id, 'deletion_pending', 'deletion requested', _uid);
  insert into public.recording_deletion_jobs (recording_id, target) values (_recording_id, 'local')
    on conflict (recording_id, target) do nothing;
  if _r.provider <> 'fixture' then
    insert into public.recording_deletion_jobs (recording_id, target) values (_recording_id, 'provider')
      on conflict (recording_id, target) do nothing;
  end if;
end; $$;

create or replace function public.set_legal_hold(_recording_id uuid, _on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _r public.encounter_recordings%rowtype;
begin
  select * into _r from public.encounter_recordings where id = _recording_id;
  if not found then raise exception 'recording not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_r.organization_id, _r.patient_id);
  update public.encounter_recordings set legal_hold = coalesce(_on,false), updated_by = _uid where id = _recording_id;
end; $$;

create or replace function public.fail_deletion_job(_job_id uuid, _error text)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _j public.recording_deletion_jobs%rowtype; _r public.encounter_recordings%rowtype;
begin
  select * into _j from public.recording_deletion_jobs where id = _job_id;
  if not found then raise exception 'deletion job not found' using errcode = 'P0002'; end if;
  select * into _r from public.encounter_recordings where id = _j.recording_id;
  _uid := private.require_clinical_actor(_r.organization_id, _r.patient_id);
  update public.recording_deletion_jobs
     set status = 'failed', attempts = attempts + 1, last_error = left(coalesce(_error,'unspecified'),500),
         next_attempt_at = now() + interval '15 minutes'
   where id = _job_id;
end; $$;

-- Confirm one target's deletion. Content is 'deleted' ONLY when every required
-- job is confirmed; then only permitted hashes/timestamps/proof remain.
create or replace function public.confirm_deletion_job(_job_id uuid, _confirmation text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _j public.recording_deletion_jobs%rowtype; _r public.encounter_recordings%rowtype; _remaining integer;
begin
  select * into _j from public.recording_deletion_jobs where id = _job_id;
  if not found then raise exception 'deletion job not found' using errcode = 'P0002'; end if;
  select * into _r from public.encounter_recordings where id = _j.recording_id;
  _uid := private.require_clinical_actor(_r.organization_id, _r.patient_id);
  if _r.legal_hold then raise exception 'recording is under legal hold' using errcode = '55000'; end if;
  if _confirmation is null or btrim(_confirmation) = '' then
    raise exception 'a deletion confirmation is required' using errcode = '22023'; end if;
  update public.recording_deletion_jobs
     set status = 'confirmed', attempts = attempts + 1, confirmation_ref = _confirmation where id = _job_id;
  select count(*) into _remaining from public.recording_deletion_jobs
    where recording_id = _j.recording_id and status <> 'confirmed';
  if _remaining = 0 then
    update public.encounter_recordings
       set audio_deleted_at = now(),
           deletion_proof = _confirmation, updated_by = _uid
     where id = _j.recording_id;
    perform private.transition_recording(_j.recording_id, 'deleted', 'all deletion targets confirmed', _uid);
    insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
      resource_type, resource_id, safe_message, metadata)
    values (_r.organization_id, _r.patient_id, _uid, 'recording.deleted', 'encounter_recording', _r.id::text,
      'Recording audio deleted', jsonb_build_object('provider', _r.provider));
    return jsonb_build_object('recording_status', 'deleted', 'remaining', 0);
  end if;
  return jsonb_build_object('recording_status', _r.status, 'remaining', _remaining);
end; $$;

create or replace function public.mark_recording_failed(_recording_id uuid, _reason text)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _r public.encounter_recordings%rowtype;
begin
  select * into _r from public.encounter_recordings where id = _recording_id;
  if not found then raise exception 'recording not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_r.organization_id, _r.patient_id);
  update public.encounter_recordings set failure_reason = left(coalesce(_reason,'unspecified'),500), updated_by = _uid where id = _recording_id;
  perform private.transition_recording(_recording_id, 'failed', _reason, _uid);
  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_r.organization_id, _r.patient_id, _uid, 'recording.failed', 'encounter_recording', _recording_id::text,
    'Recording processing failed', '{}'::jsonb);
end; $$;

-- req 10: access/export events go to the SECURITY access log, not audit_events.
create or replace function public.log_transcript_access(_transcript_id uuid, _kind text)
returns void language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _t public.encounter_transcripts%rowtype;
begin
  select * into _t from public.encounter_transcripts where id = _transcript_id;
  if not found then raise exception 'transcript not found' using errcode = 'P0002'; end if;
  _uid := private.require_clinical_actor(_t.organization_id, _t.patient_id);
  if _kind not in ('accessed','exported') then raise exception 'invalid access kind' using errcode = '22023'; end if;
  insert into public.security_access_log (organization_id, patient_id, actor_user_id, action, resource_type, resource_id)
  values (_t.organization_id, _t.patient_id, _uid, 'transcript.' || _kind, 'encounter_transcript', _t.id::text);
end; $$;

-- ------------------------------------------------------------------ grants
revoke all on function public.add_recording_participant(uuid, text, text, text, uuid, boolean) from public, anon;
revoke all on function public.record_consent(uuid, text, uuid, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.withdraw_consent(uuid, text) from public, anon;
revoke all on function public.begin_recording(uuid, text, text, bigint, integer) from public, anon;
revoke all on function public.heartbeat_capture(uuid) from public, anon;
revoke all on function public.resume_capture(uuid) from public, anon;
revoke all on function public.authorize_chunk(uuid, text, bigint) from public, anon;
revoke all on function public.issue_completion_authorization(uuid, integer) from public, anon;
revoke all on function public.complete_upload(uuid, text, text, text, bigint, text, integer) from public, anon;
revoke all on function public.queue_transcription(uuid) from public, anon;
revoke all on function public.ingest_transcript_batch(uuid, text, jsonb) from public, anon;
revoke all on function public.add_segment_revision(uuid, text, numeric, text) from public, anon;
revoke all on function public.correct_transcript_segment(uuid, text, text) from public, anon;
revoke all on function public.set_transcript_review(uuid) from public, anon;
revoke all on function public.finalize_transcript(uuid) from public, anon;
revoke all on function public.generate_scribe_draft(uuid, text, text, text, text) from public, anon;
revoke all on function public.request_recording_deletion(uuid) from public, anon;
revoke all on function public.set_legal_hold(uuid, boolean) from public, anon;
revoke all on function public.fail_deletion_job(uuid, text) from public, anon;
revoke all on function public.confirm_deletion_job(uuid, text) from public, anon;
revoke all on function public.mark_recording_failed(uuid, text) from public, anon;
revoke all on function public.log_transcript_access(uuid, text) from public, anon;

grant execute on function public.add_recording_participant(uuid, text, text, text, uuid, boolean) to authenticated;
grant execute on function public.record_consent(uuid, text, uuid, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.withdraw_consent(uuid, text) to authenticated;
grant execute on function public.begin_recording(uuid, text, text, bigint, integer) to authenticated;
grant execute on function public.heartbeat_capture(uuid) to authenticated;
grant execute on function public.resume_capture(uuid) to authenticated;
grant execute on function public.authorize_chunk(uuid, text, bigint) to authenticated;
grant execute on function public.issue_completion_authorization(uuid, integer) to authenticated;
grant execute on function public.complete_upload(uuid, text, text, text, bigint, text, integer) to authenticated;
grant execute on function public.queue_transcription(uuid) to authenticated;
grant execute on function public.ingest_transcript_batch(uuid, text, jsonb) to authenticated;
grant execute on function public.add_segment_revision(uuid, text, numeric, text) to authenticated;
grant execute on function public.correct_transcript_segment(uuid, text, text) to authenticated;
grant execute on function public.set_transcript_review(uuid) to authenticated;
grant execute on function public.finalize_transcript(uuid) to authenticated;
grant execute on function public.generate_scribe_draft(uuid, text, text, text, text) to authenticated;
grant execute on function public.request_recording_deletion(uuid) to authenticated;
grant execute on function public.set_legal_hold(uuid, boolean) to authenticated;
grant execute on function public.fail_deletion_job(uuid, text) to authenticated;
grant execute on function public.confirm_deletion_job(uuid, text) to authenticated;
grant execute on function public.mark_recording_failed(uuid, text) to authenticated;
grant execute on function public.log_transcript_access(uuid, text) to authenticated;

commit;
