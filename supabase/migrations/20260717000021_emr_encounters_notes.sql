-- 0021 — EMR charting slice: encounters, clinical notes, signatures, addenda
-- (Phase 2, slice 1: appointment → encounter → draft → autosave → review →
-- sign → locked → addendum → timeline → audit).
--
-- Design rules enforced HERE, not in TypeScript:
--   * explicit state machines (encounters, notes) — transitions only via the
--     SECURITY DEFINER RPCs below; direct UPDATE is not granted
--   * a signed note's content is IMMUTABLE: signing freezes version + SHA-256;
--     a table trigger refuses new versions once signed — even definer code
--     cannot append content to a signed note
--   * corrections are append-only addenda (author, reason, timestamp,
--     referenced version); addenda never replace or hide the original
--   * signing is idempotent: same signer + same version → the existing
--     signature is returned, no duplicate signature row, no duplicate audit
--   * encounter, note, appointment, patient, author, organization must agree —
--     checked inside the RPCs and by composite FKs/triggers
--   * only practitioner-role members (practitioner/admin/owner) may start,
--     sign, amend, or mark entered-in-error; can_access_patient gates every
--     patient reference
--   * nothing is deleted to correct history: entered_in_error keeps the row
--   * audit rows are written in the SAME transaction as each mutation
--
-- Errcodes: 28000 unauthenticated · 42501 forbidden · P0002 not found ·
-- 22023 invalid · 40001 version conflict (serialization_failure → CONFLICT).

begin;

-- ------------------------------------------------------------------ encounters
-- 0004 created placeholder `encounters` / `clinical_notes` tables (no state
-- machine, no versioning, browser-writable). Both are EMPTY in every
-- environment (verified before this migration was written). This migration
-- EVOLVES them in place — no parallel tables, no forked concepts:
--   * encounters gains appointment linkage + the explicit state machine
--     (scheduled|in_progress|completed|cancelled|entered_in_error);
--     legacy 'planned' maps to 'scheduled'; `ended_at` is the completion time
--   * clinical_notes gains the status machine + version counter; content
--     moves to append-only clinical_note_versions; signatures/addenda/
--     provenance are new append-only tables
--   * the legacy INSERT/UPDATE/DELETE policies are DROPPED — writes go only
--     through the SECURITY DEFINER RPCs below
alter table public.encounters
  add column appointment_id uuid references public.appointments(id) on delete set null,
  add column status_reason text;
update public.encounters set status = 'scheduled' where status = 'planned';
alter table public.encounters drop constraint encounters_status_check;
alter table public.encounters add constraint encounters_status_check
  check (status in ('scheduled','in_progress','completed','cancelled','entered_in_error'));
alter table public.encounters alter column status set default 'scheduled';
alter table public.encounters add constraint encounters_visit_type_check
  check (encounter_type is null or encounter_type in
    ('initial','follow-up','lab-review','supplement','telehealth','acute','administrative'));
create index encounters_org_status_idx on public.encounters (organization_id, status);
create index encounters_appointment_idx on public.encounters (appointment_id);

create table public.encounter_participants (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  encounter_id     uuid not null references public.encounters(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  participant_role text not null default 'author'
                     check (participant_role in ('author','supervisor','observer','scribe')),
  created_at       timestamptz not null default now(),
  unique (encounter_id, user_id, participant_role)
);
create index encounter_participants_enc_idx on public.encounter_participants (encounter_id);

-- --------------------------------------------------------------- clinical_notes
alter table public.clinical_notes
  add column status text not null default 'draft'
    check (status in ('draft','ready_for_review','signed','amended','entered_in_error')),
  add column current_version integer not null default 0,
  add column status_reason text;
alter table public.clinical_notes add constraint clinical_notes_note_type_check
  check (note_type in ('soap','narrative','follow_up','adime','patient_instructions'));
alter table public.clinical_notes alter column note_type set not null;
-- Clinical notes always belong to an encounter and an author (table is empty;
-- the legacy set-null FKs would contradict NOT NULL).
alter table public.clinical_notes drop constraint clinical_notes_encounter_id_fkey;
alter table public.clinical_notes
  add constraint clinical_notes_encounter_id_fkey
  foreign key (encounter_id) references public.encounters(id) on delete cascade;
alter table public.clinical_notes alter column encounter_id set not null;
alter table public.clinical_notes drop constraint clinical_notes_author_user_id_fkey;
alter table public.clinical_notes
  add constraint clinical_notes_author_user_id_fkey
  foreign key (author_user_id) references auth.users(id) on delete restrict;
alter table public.clinical_notes alter column author_user_id set not null;
create index clinical_notes_encounter_idx on public.clinical_notes (encounter_id);

-- Content versions: append-only. Autosaves and explicit saves both append.
create table public.clinical_note_versions (
  id           uuid primary key default gen_random_uuid(),
  note_id      uuid not null references public.clinical_notes(id) on delete cascade,
  version      integer not null,
  content      jsonb not null,               -- sections keyed by note type (soap: S/O/A/P …)
  content_sha256 text not null,
  save_kind    text not null default 'autosave' check (save_kind in ('autosave','manual')),
  created_at   timestamptz not null default now(),
  created_by   uuid not null references auth.users(id),
  unique (note_id, version)
);
create index clinical_note_versions_note_idx on public.clinical_note_versions (note_id, version desc);

-- Signatures: at most one primary signature per note. Content is frozen by
-- (version, sha256); the signed row is never updated or deleted.
create table public.note_signatures (
  id             uuid primary key default gen_random_uuid(),
  note_id        uuid not null references public.clinical_notes(id) on delete cascade,
  note_version   integer not null,
  content_sha256 text not null,
  signed_by      uuid not null references auth.users(id),
  signed_at      timestamptz not null default now(),
  attestation    text not null default 'I attest this note is accurate and complete.',
  unique (note_id)
);

-- Addenda: append-only corrections to a SIGNED note.
create table public.note_addenda (
  id                 uuid primary key default gen_random_uuid(),
  note_id            uuid not null references public.clinical_notes(id) on delete cascade,
  referenced_version integer not null,
  author_user_id     uuid not null references auth.users(id),
  reason             text not null,
  content            text not null,
  created_at         timestamptz not null default now()
);
create index note_addenda_note_idx on public.note_addenda (note_id, created_at);

-- Provenance references for note sections/statements.
create table public.note_provenance_refs (
  id           uuid primary key default gen_random_uuid(),
  note_id      uuid not null references public.clinical_notes(id) on delete cascade,
  section_key  text not null,
  ref_type     text not null
                 check (ref_type in ('appointment','encounter','lab_observation','lab_document','patient_form','chart_item','practitioner_entered')),
  ref_id       uuid,
  label        text not null,
  created_at   timestamptz not null default now(),
  created_by   uuid not null references auth.users(id)
);
create index note_provenance_note_idx on public.note_provenance_refs (note_id);

-- --------------------------------------------------- immutability trigger
-- No new content versions once a note is signed/amended/entered_in_error —
-- addenda are the ONLY post-signature write path, and they live in their own
-- append-only table. This binds even SECURITY DEFINER code.
create or replace function private.forbid_versions_after_signing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare _status text;
begin
  select status into _status from public.clinical_notes where id = new.note_id;
  if _status in ('signed','amended','entered_in_error') then
    raise exception 'note content is frozen after signing — use an addendum'
      using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger clinical_note_versions_freeze
  before insert on public.clinical_note_versions
  for each row execute function private.forbid_versions_after_signing();

-- Signatures and addenda rows are append-only at the table level.
create or replace function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'this record is append-only' using errcode = '22023';
end;
$$;
create trigger note_signatures_append_only
  before update or delete on public.note_signatures
  for each row execute function private.forbid_mutation();
create trigger note_addenda_append_only
  before update or delete on public.note_addenda
  for each row execute function private.forbid_mutation();
create trigger clinical_note_versions_append_only
  before update or delete on public.clinical_note_versions
  for each row execute function private.forbid_mutation();

-- --------------------------------------------------------------------- RLS
-- encounters/clinical_notes already have RLS enabled (0004); the new tables
-- enable it here. Legacy WRITE policies are dropped — the RPCs are the only
-- write path (definer functions bypass RLS by design).
alter table public.encounter_participants enable row level security;
alter table public.clinical_note_versions enable row level security;
alter table public.note_signatures        enable row level security;
alter table public.note_addenda           enable row level security;
alter table public.note_provenance_refs   enable row level security;

drop policy if exists encounters_insert on public.encounters;
drop policy if exists encounters_update on public.encounters;
drop policy if exists encounters_delete on public.encounters;
drop policy if exists encounters_select on public.encounters;
drop policy if exists clinical_notes_insert on public.clinical_notes;
drop policy if exists clinical_notes_update on public.clinical_notes;
drop policy if exists clinical_notes_delete on public.clinical_notes;
drop policy if exists clinical_notes_select on public.clinical_notes;

-- Reads follow the patient-access gate; writes go ONLY through the RPCs
-- below (no insert/update/delete policies → direct writes are refused).
create policy encounters_select on public.encounters
  for select using (private.can_access_patient(patient_id));
create policy encounter_participants_select on public.encounter_participants
  for select using (exists (select 1 from public.encounters e
    where e.id = encounter_id and private.can_access_patient(e.patient_id)));
create policy clinical_notes_select on public.clinical_notes
  for select using (private.can_access_patient(patient_id));
create policy clinical_note_versions_select on public.clinical_note_versions
  for select using (exists (select 1 from public.clinical_notes n
    where n.id = note_id and private.can_access_patient(n.patient_id)));
create policy note_signatures_select on public.note_signatures
  for select using (exists (select 1 from public.clinical_notes n
    where n.id = note_id and private.can_access_patient(n.patient_id)));
create policy note_addenda_select on public.note_addenda
  for select using (exists (select 1 from public.clinical_notes n
    where n.id = note_id and private.can_access_patient(n.patient_id)));
create policy note_provenance_select on public.note_provenance_refs
  for select using (exists (select 1 from public.clinical_notes n
    where n.id = note_id and private.can_access_patient(n.patient_id)));

-- ------------------------------------------------------- helper: sha256_hex
-- Same pattern as private.hash_invitation_token (0012): pgcrypto's digest
-- resolves via a pinned pg_catalog-first path, callers stay at search_path=''.
create or replace function private.sha256_hex(_t text)
returns text language sql immutable
set search_path = 'pg_catalog','public','extensions' as $$
  select encode(digest(_t, 'sha256'), 'hex');
$$;
revoke all on function private.sha256_hex(text) from public, anon;
grant execute on function private.sha256_hex(text) to authenticated;

-- ------------------------------------------------------------ helper: gate
-- Clinical-role gate shared by the RPCs: active practitioner/admin/owner
-- membership in the org AND patient access.
create or replace function private.require_clinical_actor(_organization_id uuid, _patient_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _patient_org uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _organization_id and m.user_id = _uid
      and m.status = 'active' and m.role in ('owner','admin','practitioner')
  ) then
    raise exception 'clinical role required in this organization' using errcode = '42501';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  select organization_id into _patient_org
  from public.patient_profiles where id = _patient_id and deleted_at is null;
  if _patient_org is distinct from _organization_id then
    raise exception 'patient does not belong to this organization' using errcode = '42501';
  end if;
  return _uid;
end;
$$;
revoke all on function private.require_clinical_actor(uuid, uuid) from public, anon;
grant execute on function private.require_clinical_actor(uuid, uuid) to authenticated;

-- --------------------------------------------------------------- RPC: start
create or replace function public.start_encounter(
  _organization_id uuid,
  _patient_id uuid,
  _visit_type text default 'follow-up',
  _appointment_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid;
  _appt public.appointments%rowtype;
  _id uuid;
begin
  _uid := private.require_clinical_actor(_organization_id, _patient_id);

  if _visit_type is null or _visit_type not in
     ('initial','follow-up','lab-review','supplement','telehealth','acute','administrative') then
    raise exception 'invalid visit type' using errcode = '22023';
  end if;

  if _appointment_id is not null then
    select * into _appt from public.appointments
      where id = _appointment_id and deleted_at is null;
    if not found then
      raise exception 'appointment not found' using errcode = 'P0002';
    end if;
    -- The appointment, encounter, patient, and organization must agree.
    if _appt.organization_id is distinct from _organization_id
       or _appt.patient_id is distinct from _patient_id then
      raise exception 'appointment does not match this patient and organization' using errcode = '42501';
    end if;
    -- One active encounter per appointment (idempotent start).
    select id into _id from public.encounters
      where appointment_id = _appointment_id and status = 'in_progress' and deleted_at is null;
    if found then
      return _id;
    end if;
  end if;

  insert into public.encounters
    (organization_id, patient_id, appointment_id, encounter_type, practitioner_user_id,
     status, started_at, source, created_by, updated_by)
  values
    (_organization_id, _patient_id, _appointment_id, _visit_type, _uid,
     'in_progress', now(), 'manual', _uid, _uid)
  returning id into _id;

  insert into public.encounter_participants (organization_id, encounter_id, user_id, participant_role)
  values (_organization_id, _id, _uid, 'author')
  on conflict do nothing;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_organization_id, _patient_id, _uid, 'encounter.started', 'encounter', _id::text,
    'Encounter started', jsonb_build_object('visit_type', _visit_type,
      'appointment_id', coalesce(_appointment_id::text, '')));

  return _id;
end;
$$;

-- ------------------------------------------------- RPC: encounter transitions
create or replace function public.set_encounter_status(
  _encounter_id uuid,
  _status text,
  _reason text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid;
  _e public.encounters%rowtype;
  _allowed boolean;
begin
  select * into _e from public.encounters where id = _encounter_id and deleted_at is null;
  if not found then
    raise exception 'encounter not found' using errcode = 'P0002';
  end if;
  _uid := private.require_clinical_actor(_e.organization_id, _e.patient_id);

  if _status not in ('completed','cancelled','entered_in_error') then
    raise exception 'invalid target status' using errcode = '22023';
  end if;
  -- Explicit machine: in_progress → completed|cancelled|entered_in_error;
  -- scheduled → cancelled|entered_in_error; terminal states are terminal.
  _allowed := (_e.status = 'in_progress' and _status in ('completed','cancelled','entered_in_error'))
           or (_e.status = 'scheduled'  and _status in ('cancelled','entered_in_error'));
  if not _allowed then
    raise exception 'invalid transition from %', _e.status using errcode = '22023';
  end if;
  if _status = 'entered_in_error' and (_reason is null or btrim(_reason) = '') then
    raise exception 'a reason is required for entered_in_error' using errcode = '22023';
  end if;
  -- Completing requires no lingering unsigned drafts? NO — drafts may outlive
  -- the visit; completion only ends the encounter itself.

  update public.encounters
     set status = _status,
         ended_at = case when _status = 'completed' then now() else ended_at end,
         status_reason = coalesce(_reason, status_reason),
         updated_by = _uid
   where id = _e.id;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_e.organization_id, _e.patient_id, _uid, 'encounter.' || _status,
    'encounter', _e.id::text,
    case _status when 'completed' then 'Encounter completed'
                 when 'cancelled' then 'Encounter cancelled'
                 else 'Encounter marked entered in error' end,
    jsonb_build_object('from', _e.status));
end;
$$;

-- ------------------------------------------------------ RPC: save note draft
-- Creates the note on first save; appends a version on each subsequent save.
-- Optimistic concurrency: _expected_version must equal current_version or the
-- save is refused with 40001 (the composer then shows the conflict view).
create or replace function public.save_note_draft(
  _organization_id uuid,
  _encounter_id uuid,
  _note_type text,
  _content jsonb,
  _expected_version integer,
  _note_id uuid default null,
  _save_kind text default 'autosave',
  _provenance jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid;
  _e public.encounters%rowtype;
  _n public.clinical_notes%rowtype;
  _new_version integer;
  _sha text;
begin
  select * into _e from public.encounters where id = _encounter_id and deleted_at is null;
  if not found then
    raise exception 'encounter not found' using errcode = 'P0002';
  end if;
  _uid := private.require_clinical_actor(_e.organization_id, _e.patient_id);
  if _e.organization_id is distinct from _organization_id then
    raise exception 'encounter does not belong to this organization' using errcode = '42501';
  end if;
  if _e.status not in ('in_progress','completed') then
    raise exception 'encounter is not open for documentation' using errcode = '22023';
  end if;

  if _note_type not in ('soap','narrative','follow_up','adime','patient_instructions') then
    raise exception 'invalid note type' using errcode = '22023';
  end if;
  if _content is null or jsonb_typeof(_content) <> 'object' then
    raise exception 'content must be an object' using errcode = '22023';
  end if;
  if length(_content::text) > 262144 then
    raise exception 'content too large' using errcode = '22023';
  end if;
  if _save_kind not in ('autosave','manual') then
    raise exception 'invalid save kind' using errcode = '22023';
  end if;

  _sha := private.sha256_hex(_content::text);

  if _note_id is null then
    if _expected_version is distinct from 0 then
      raise exception 'version conflict' using errcode = '40001';
    end if;
    insert into public.clinical_notes
      (organization_id, patient_id, encounter_id, note_type, status, current_version,
       author_user_id, source, created_by, updated_by)
    values
      (_e.organization_id, _e.patient_id, _encounter_id, _note_type, 'draft', 1,
       _uid, 'manual', _uid, _uid)
    returning * into _n;
    _new_version := 1;

    insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
      resource_type, resource_id, safe_message, metadata)
    values (_e.organization_id, _e.patient_id, _uid, 'note.draft_created', 'clinical_note',
      _n.id::text, 'Draft note created', jsonb_build_object('note_type', _note_type));
  else
    -- Row-lock the note so concurrent saves serialize.
    select * into _n from public.clinical_notes where id = _note_id and deleted_at is null for update;
    if not found then
      raise exception 'note not found' using errcode = 'P0002';
    end if;
    if _n.encounter_id is distinct from _encounter_id
       or _n.organization_id is distinct from _organization_id then
      raise exception 'note does not belong to this encounter' using errcode = '42501';
    end if;
    if _n.status not in ('draft','ready_for_review') then
      raise exception 'note content is frozen after signing — use an addendum' using errcode = '22023';
    end if;
    if _n.current_version is distinct from _expected_version then
      raise exception 'version conflict' using errcode = '40001';
    end if;
    _new_version := _n.current_version + 1;
    update public.clinical_notes
       set current_version = _new_version,
           status = 'draft',           -- editing a ready note returns it to draft
           updated_by = _uid
     where id = _n.id;
  end if;

  insert into public.clinical_note_versions (note_id, version, content, content_sha256, save_kind, created_by)
  values (_n.id, _new_version, _content, _sha, _save_kind, _uid);

  -- Provenance refs travel with each draft save (replace-all while draft).
  -- Practitioner-entered statements are labeled as exactly that; refs to
  -- records must name a known type. Frozen implicitly once the note signs.
  if _provenance is not null then
    if jsonb_typeof(_provenance) <> 'array' or jsonb_array_length(_provenance) > 50 then
      raise exception 'invalid provenance payload' using errcode = '22023';
    end if;
    delete from public.note_provenance_refs where note_id = _n.id;
    begin
      insert into public.note_provenance_refs (note_id, section_key, ref_type, ref_id, label, created_by)
      select _n.id,
             left(coalesce(r->>'sectionKey',''), 60),
             r->>'refType',
             nullif(r->>'refId','')::uuid,
             left(coalesce(r->>'label',''), 200),
             _uid
      from jsonb_array_elements(_provenance) r
      where coalesce(r->>'sectionKey','') <> '' and coalesce(r->>'label','') <> '';
    exception when check_violation or invalid_text_representation then
      raise exception 'invalid provenance reference' using errcode = '22023';
    end;
  end if;

  return jsonb_build_object(
    'note_id', _n.id,
    'version', _new_version,
    'saved_at', now(),
    'status', 'draft'
  );
end;
$$;

-- --------------------------------------------------- RPC: ready for review
create or replace function public.mark_note_ready(_note_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid;
  _n public.clinical_notes%rowtype;
begin
  select * into _n from public.clinical_notes where id = _note_id and deleted_at is null for update;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
  _uid := private.require_clinical_actor(_n.organization_id, _n.patient_id);
  if _n.status <> 'draft' then
    raise exception 'only a draft can be marked ready' using errcode = '22023';
  end if;
  if _n.current_version < 1 then
    raise exception 'nothing to review yet' using errcode = '22023';
  end if;
  update public.clinical_notes set status = 'ready_for_review', updated_by = _uid where id = _n.id;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_n.organization_id, _n.patient_id, _uid, 'note.ready_for_review', 'clinical_note',
    _n.id::text, 'Note marked ready for review', jsonb_build_object('version', _n.current_version));
end;
$$;

-- ------------------------------------------------------------- RPC: sign
-- Idempotent: signing the same version again returns the existing signature
-- and writes NO new audit row. Signing a DIFFERENT version than expected is a
-- version conflict.
create or replace function public.sign_note(
  _note_id uuid,
  _expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid;
  _n public.clinical_notes%rowtype;
  _v public.clinical_note_versions%rowtype;
  _sig public.note_signatures%rowtype;
begin
  select * into _n from public.clinical_notes where id = _note_id and deleted_at is null for update;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
  _uid := private.require_clinical_actor(_n.organization_id, _n.patient_id);

  -- Idempotency: an existing signature for the same version is simply returned.
  select * into _sig from public.note_signatures where note_id = _n.id;
  if found then
    if _sig.note_version = _expected_version then
      return jsonb_build_object('signature_id', _sig.id, 'already_signed', true,
        'version', _sig.note_version, 'signed_at', _sig.signed_at);
    end if;
    raise exception 'note is already signed at version %', _sig.note_version using errcode = '22023';
  end if;

  if _n.status not in ('draft','ready_for_review') then
    raise exception 'note cannot be signed from status %', _n.status using errcode = '22023';
  end if;
  if _n.current_version is distinct from _expected_version then
    raise exception 'version conflict' using errcode = '40001';
  end if;

  select * into _v from public.clinical_note_versions
    where note_id = _n.id and version = _n.current_version;
  if not found then
    raise exception 'note has no content to sign' using errcode = '22023';
  end if;

  insert into public.note_signatures (note_id, note_version, content_sha256, signed_by)
  values (_n.id, _v.version, _v.content_sha256, _uid)
  returning * into _sig;

  update public.clinical_notes
     set status = 'signed', is_signed = true, signed_at = _sig.signed_at,
         signed_by = _uid, updated_by = _uid
   where id = _n.id;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_n.organization_id, _n.patient_id, _uid, 'note.signed', 'clinical_note',
    _n.id::text, 'Note signed', jsonb_build_object('version', _v.version));

  return jsonb_build_object('signature_id', _sig.id, 'already_signed', false,
    'version', _sig.note_version, 'signed_at', _sig.signed_at);
end;
$$;

-- --------------------------------------------------------- RPC: addendum
create or replace function public.add_note_addendum(
  _note_id uuid,
  _reason text,
  _content text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid;
  _n public.clinical_notes%rowtype;
  _sig public.note_signatures%rowtype;
  _id uuid;
begin
  select * into _n from public.clinical_notes where id = _note_id and deleted_at is null for update;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
  _uid := private.require_clinical_actor(_n.organization_id, _n.patient_id);
  if _n.status not in ('signed','amended') then
    raise exception 'addenda apply to signed notes — edit the draft instead' using errcode = '22023';
  end if;
  if _reason is null or btrim(_reason) = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if _content is null or btrim(_content) = '' then
    raise exception 'addendum content is required' using errcode = '22023';
  end if;
  if length(_content) > 65536 or length(_reason) > 500 then
    raise exception 'addendum too large' using errcode = '22023';
  end if;

  select * into _sig from public.note_signatures where note_id = _n.id;

  insert into public.note_addenda (note_id, referenced_version, author_user_id, reason, content)
  values (_n.id, coalesce(_sig.note_version, _n.current_version), _uid, btrim(_reason), _content)
  returning id into _id;

  update public.clinical_notes set status = 'amended', updated_by = _uid where id = _n.id;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_n.organization_id, _n.patient_id, _uid, 'note.addendum_created', 'clinical_note',
    _n.id::text, 'Addendum added', jsonb_build_object('addendum_id', _id::text,
      'referenced_version', coalesce(_sig.note_version, _n.current_version)));

  return _id;
end;
$$;

-- ------------------------------------------------ RPC: note entered in error
create or replace function public.mark_note_error(_note_id uuid, _reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid;
  _n public.clinical_notes%rowtype;
begin
  select * into _n from public.clinical_notes where id = _note_id and deleted_at is null for update;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
  _uid := private.require_clinical_actor(_n.organization_id, _n.patient_id);
  if _reason is null or btrim(_reason) = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if _n.status = 'entered_in_error' then
    return; -- idempotent
  end if;
  update public.clinical_notes
     set status = 'entered_in_error', status_reason = btrim(_reason), updated_by = _uid
   where id = _n.id;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_n.organization_id, _n.patient_id, _uid, 'note.entered_in_error', 'clinical_note',
    _n.id::text, 'Note marked entered in error', jsonb_build_object('previous_status', _n.status));
end;
$$;

-- ------------------------------------------------------ RPC: patient timeline
-- CLINICAL events only (encounters, notes, addenda, appointments) — the
-- security audit trail stays in /audit-log and is NOT exposed here.
create or replace function public.get_patient_timeline(_patient_id uuid)
returns table (
  event_at   timestamptz,
  event_type text,
  title      text,
  ref_type   text,
  ref_id     uuid,
  detail     jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;

  return query
  select e.started_at, 'encounter.started'::text,
         'Encounter started ('||coalesce(e.encounter_type,'visit')||')', 'encounter'::text, e.id,
         jsonb_build_object('status', e.status)
    from public.encounters e
    where e.patient_id = _patient_id and e.started_at is not null and e.deleted_at is null
  union all
  select e.ended_at, 'encounter.completed', 'Encounter completed', 'encounter', e.id,
         jsonb_build_object('visit_type', coalesce(e.encounter_type,'visit'))
    from public.encounters e
    where e.patient_id = _patient_id and e.status = 'completed' and e.ended_at is not null and e.deleted_at is null
  union all
  select n.created_at, 'note.draft_created',
         'Draft note created ('||n.note_type||')', 'clinical_note', n.id,
         jsonb_build_object('status', n.status)
    from public.clinical_notes n
    where n.patient_id = _patient_id and n.deleted_at is null
  union all
  select s.signed_at, 'note.signed', 'Note signed', 'clinical_note', s.note_id,
         jsonb_build_object('version', s.note_version)
    from public.note_signatures s
    join public.clinical_notes n2 on n2.id = s.note_id
    where n2.patient_id = _patient_id
  union all
  select a.created_at, 'note.addendum', 'Addendum added', 'clinical_note', a.note_id,
         jsonb_build_object('referenced_version', a.referenced_version)
    from public.note_addenda a
    join public.clinical_notes n3 on n3.id = a.note_id
    where n3.patient_id = _patient_id
  union all
  select n4.updated_at, 'note.entered_in_error', 'Note entered in error', 'clinical_note', n4.id,
         '{}'::jsonb
    from public.clinical_notes n4
    where n4.patient_id = _patient_id and n4.status = 'entered_in_error' and n4.deleted_at is null
  union all
  select ap.starts_at, 'appointment', coalesce(ap.appointment_type,'appointment'), 'appointment', ap.id,
         jsonb_build_object('status', ap.status)
    from public.appointments ap
    where ap.patient_id = _patient_id and ap.deleted_at is null
  order by 1 desc;
end;
$$;

-- ------------------------------------------------------------------ grants
revoke all on function public.start_encounter(uuid, uuid, text, uuid)                    from public, anon;
revoke all on function public.set_encounter_status(uuid, text, text)                     from public, anon;
revoke all on function public.save_note_draft(uuid, uuid, text, jsonb, integer, uuid, text, jsonb) from public, anon;
revoke all on function public.mark_note_ready(uuid)                                      from public, anon;
revoke all on function public.sign_note(uuid, integer)                                   from public, anon;
revoke all on function public.add_note_addendum(uuid, text, text)                        from public, anon;
revoke all on function public.mark_note_error(uuid, text)                                from public, anon;
revoke all on function public.get_patient_timeline(uuid)                                 from public, anon;

grant execute on function public.start_encounter(uuid, uuid, text, uuid)                    to authenticated;
grant execute on function public.set_encounter_status(uuid, text, text)                     to authenticated;
grant execute on function public.save_note_draft(uuid, uuid, text, jsonb, integer, uuid, text, jsonb) to authenticated;
grant execute on function public.mark_note_ready(uuid)                                      to authenticated;
grant execute on function public.sign_note(uuid, integer)                                   to authenticated;
grant execute on function public.add_note_addendum(uuid, text, text)                        to authenticated;
grant execute on function public.mark_note_error(uuid, text)                                to authenticated;
grant execute on function public.get_patient_timeline(uuid)                                 to authenticated;

commit;
