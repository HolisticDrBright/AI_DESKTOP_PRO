-- desktop_frontdesk_transitions
--
-- Phase 2 slice 1: the front-desk appointment status workflow, enforced in the
-- database. EXTENDS the existing scheduling slice (book_appointment /
-- reschedule_appointment / update_appointment_status stay; the legacy status
-- RPC is recreated as a thin delegate of the new machine so existing callers
-- keep one behavior).
--
-- What this adds:
--   * 'in_encounter' joins the appointment status vocabulary.
--   * appointments.version — optimistic concurrency for status mutations.
--   * appointment_status_events — append-only transition history carrying the
--     idempotency key, actor, reason, and from→to pair. The audit_events row
--     remains the org-wide audit; this table is the per-appointment ledger
--     that makes retries idempotent and history reviewable.
--   * transition_appointment(...) — THE state machine:
--         scheduled  → confirmed | arrived | cancelled | no_show
--         confirmed  → arrived | cancelled | no_show
--         arrived    → in_encounter | completed | cancelled | no_show
--         in_encounter → completed | cancelled
--         completed / cancelled / no_show → (terminal; correction only)
--     Typed errors: 28000 unauthenticated · 42501 forbidden/cross-tenant ·
--     P0002 missing · 22023 invalid transition/input · 40001 version conflict.
--     An idempotency-key replay returns the stored outcome without mutating.
--   * correct_appointment_status(...) — the ONLY path out of a terminal
--     state. Requires org owner/admin and a reason; audited as
--     'appointment.correction'.
--   * start_encounter(...) extended: when the new encounter is linked to an
--     appointment in scheduled/confirmed/arrived, the appointment atomically
--     becomes 'in_encounter' with a status event + version bump — beginning
--     the visit IS a front-desk transition.
--
-- Never touched here: balances, insurance, consent, patient demographics —
-- this machine reads and writes appointment state only. Rescheduling remains
-- its own RPC and is NOT a status transition.

begin;

-- ------------------------------------------------------------- vocabulary
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status = any (array[
    'scheduled'::text, 'confirmed'::text, 'arrived'::text, 'in_encounter'::text,
    'completed'::text, 'cancelled'::text, 'no_show'::text
  ]));

alter table public.appointments
  add column if not exists version integer not null default 1;

comment on column public.appointments.version is
  'Optimistic-concurrency version for status mutations. Bumped by every status transition/correction; callers pass the version they rendered and get a 40001 conflict if the row moved.';

-- --------------------------------------------------- transition ledger
create table if not exists public.appointment_status_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  kind text not null default 'transition' check (kind in ('transition','correction')),
  reason text,
  idempotency_key text,
  actor_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists appt_status_events_appt_idx
  on public.appointment_status_events (appointment_id, created_at desc);
create unique index if not exists appt_status_events_idem_idx
  on public.appointment_status_events (appointment_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists appt_status_events_org_idx
  on public.appointment_status_events (organization_id);
create index if not exists appt_status_events_actor_idx
  on public.appointment_status_events (actor_user_id);

comment on table public.appointment_status_events is
  'Append-only per-appointment transition ledger. The unique (appointment_id, idempotency_key) index is what makes repeat clicks and network retries safe: a replayed key returns the stored outcome instead of double-transitioning.';

alter table public.appointment_status_events enable row level security;
drop policy if exists appt_status_events_select on public.appointment_status_events;
create policy appt_status_events_select on public.appointment_status_events
  for select using (
    private.is_org_member(organization_id)
    and private.can_manage_appointment(
      organization_id,
      (select a.patient_id from public.appointments a where a.id = appointment_id))
  );
-- Writes only via the RPCs below.
revoke all privileges on table public.appointment_status_events from public, anon, authenticated;

-- --------------------------------------------------- the state machine
create or replace function private.appointment_transition_allowed(
  _from text,
  _to text
) returns boolean
language sql
immutable
set search_path = ''
as $$
  select case _from
    when 'scheduled'    then _to in ('confirmed','arrived','cancelled','no_show')
    when 'confirmed'    then _to in ('arrived','cancelled','no_show')
    when 'arrived'      then _to in ('in_encounter','completed','cancelled','no_show')
    when 'in_encounter' then _to in ('completed','cancelled')
    else false
  end;
$$;
revoke all on function private.appointment_transition_allowed(text, text) from public;
grant execute on function private.appointment_transition_allowed(text, text) to authenticated, service_role;

create or replace function public.transition_appointment(
  _appointment_id uuid,
  _to_status text,
  _expected_version integer,
  _idempotency_key text default null,
  _reason text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _appt public.appointments%rowtype;
  _replay public.appointment_status_events%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if _to_status not in ('confirmed','arrived','in_encounter','completed','cancelled','no_show') then
    raise exception 'invalid target status' using errcode = '22023';
  end if;
  if _idempotency_key is not null and length(_idempotency_key) > 128 then
    raise exception 'idempotency key too long' using errcode = '22023';
  end if;
  if _reason is not null and length(_reason) > 1000 then
    raise exception 'reason too long' using errcode = '22023';
  end if;

  select * into _appt
  from public.appointments
  where id = _appointment_id and deleted_at is null
  for update;
  if not found then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  -- Tenant + role gate: membership is checked against the ROW's org — a
  -- caller cannot substitute a foreign organization id because none is taken.
  if not private.can_manage_appointment(_appt.organization_id, _appt.patient_id) then
    raise exception 'not authorized to manage this appointment' using errcode = '42501';
  end if;

  -- Idempotent replay: the same key on the same appointment returns the
  -- stored outcome without touching the row (safe for repeat clicks/retries).
  if _idempotency_key is not null then
    select * into _replay
    from public.appointment_status_events
    where appointment_id = _appointment_id and idempotency_key = _idempotency_key;
    if found then
      return jsonb_build_object(
        'ok', true, 'id', _appt.id, 'status', _appt.status,
        'previous_status', _replay.from_status, 'version', _appt.version,
        'already_applied', true);
    end if;
  end if;

  if _expected_version is not null and _expected_version <> _appt.version then
    raise exception 'appointment changed since it was loaded (version conflict)'
      using errcode = '40001';
  end if;

  if _appt.status = _to_status then
    return jsonb_build_object(
      'ok', true, 'id', _appt.id, 'status', _appt.status,
      'previous_status', _appt.status, 'version', _appt.version,
      'already_applied', true);
  end if;

  if _appt.status in ('completed','cancelled','no_show') then
    raise exception 'appointment is settled; use the correction workflow'
      using errcode = '22023';
  end if;
  if not private.appointment_transition_allowed(_appt.status, _to_status) then
    raise exception 'invalid transition from % to %', _appt.status, _to_status
      using errcode = '22023';
  end if;

  update public.appointments
  set status = _to_status,
      version = version + 1,
      updated_by = _uid,
      updated_at = now()
  where id = _appt.id;

  insert into public.appointment_status_events
    (organization_id, appointment_id, from_status, to_status, kind, reason,
     idempotency_key, actor_user_id)
  values
    (_appt.organization_id, _appt.id, _appt.status, _to_status, 'transition',
     nullif(trim(coalesce(_reason,'')), ''), _idempotency_key, _uid);

  -- Org audit: front-desk state is operationally meaningful; message is
  -- status-only (no patient content).
  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_appt.organization_id, _appt.patient_id, _uid, 'appointment.' || _to_status,
     'appointment', _appt.id::text,
     'Appointment ' || replace(_to_status, '_', ' '),
     jsonb_build_object('previous_status', _appt.status, 'status', _to_status,
                        'hadReason', _reason is not null));

  return jsonb_build_object(
    'ok', true, 'id', _appt.id, 'status', _to_status,
    'previous_status', _appt.status, 'version', _appt.version + 1,
    'already_applied', false);
end;
$$;

comment on function public.transition_appointment(uuid, text, integer, text, text) is
  'Front-desk appointment state machine: enforced transitions, optimistic version check (40001 on conflict), idempotency-key replay, appended status event + audit atomically. Terminal states exit only via correct_appointment_status.';

revoke all on function public.transition_appointment(uuid, text, integer, text, text) from public, anon;
grant execute on function public.transition_appointment(uuid, text, integer, text, text) to authenticated, service_role;

-- --------------------------------------------------- terminal correction
create or replace function public.correct_appointment_status(
  _appointment_id uuid,
  _to_status text,
  _reason text,
  _expected_version integer
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _appt public.appointments%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if _to_status not in ('scheduled','confirmed','arrived','in_encounter','completed','cancelled','no_show') then
    raise exception 'invalid target status' using errcode = '22023';
  end if;
  if _reason is null or trim(_reason) = '' then
    raise exception 'a correction reason is required' using errcode = '22023';
  end if;
  if length(_reason) > 1000 then
    raise exception 'reason too long' using errcode = '22023';
  end if;

  select * into _appt
  from public.appointments
  where id = _appointment_id and deleted_at is null
  for update;
  if not found then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  -- Corrections are an elevated action: org owner/admin only.
  if not private.is_org_admin(_appt.organization_id) then
    raise exception 'appointment corrections require an organization admin'
      using errcode = '42501';
  end if;
  if _expected_version is not null and _expected_version <> _appt.version then
    raise exception 'appointment changed since it was loaded (version conflict)'
      using errcode = '40001';
  end if;
  if _appt.status not in ('completed','cancelled','no_show') then
    raise exception 'corrections apply to settled appointments only; use transition_appointment'
      using errcode = '22023';
  end if;
  if _appt.status = _to_status then
    raise exception 'appointment already has that status' using errcode = '22023';
  end if;

  update public.appointments
  set status = _to_status,
      version = version + 1,
      updated_by = _uid,
      updated_at = now()
  where id = _appt.id;

  insert into public.appointment_status_events
    (organization_id, appointment_id, from_status, to_status, kind, reason, actor_user_id)
  values
    (_appt.organization_id, _appt.id, _appt.status, _to_status, 'correction',
     trim(_reason), _uid);

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_appt.organization_id, _appt.patient_id, _uid, 'appointment.correction',
     'appointment', _appt.id::text,
     'Appointment status corrected by an administrator',
     jsonb_build_object('previous_status', _appt.status, 'status', _to_status));

  return jsonb_build_object(
    'ok', true, 'id', _appt.id, 'status', _to_status,
    'previous_status', _appt.status, 'version', _appt.version + 1);
end;
$$;

comment on function public.correct_appointment_status(uuid, text, text, integer) is
  'The explicit, authorized correction workflow: org admins may move a SETTLED appointment (completed/cancelled/no_show) to another state with a mandatory reason. Audited as appointment.correction; the only path out of a terminal status.';

revoke all on function public.correct_appointment_status(uuid, text, text, integer) from public, anon;
grant execute on function public.correct_appointment_status(uuid, text, text, integer) to authenticated, service_role;

-- --------------------------------------------------- legacy delegate
-- Existing callers of update_appointment_status get the SAME machine (no
-- version/idempotency args → no version gate, no replay), so there is exactly
-- one transition authority.
create or replace function public.update_appointment_status(
  _appointment_id uuid,
  _status text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _result jsonb;
begin
  _result := public.transition_appointment(_appointment_id, _status, null, null, null);
  return jsonb_build_object(
    'id', _result->>'id',
    'status', _result->>'status',
    'previous_status', _result->>'previous_status',
    'already_set', (_result->>'already_applied')::boolean
  );
end;
$$;

revoke all on function public.update_appointment_status(uuid, text) from public, anon;
grant execute on function public.update_appointment_status(uuid, text) to authenticated, service_role;

-- --------------------------------------------------- start_encounter joins the machine
-- Body copied VERBATIM from 20260729005221 (require_clinical_actor gate,
-- advisory xact lock, encounter_participants row, source column, audit keys)
-- with ONE addition at the end: a linked appointment in
-- scheduled/confirmed/arrived atomically becomes 'in_encounter' with a status
-- event, version bump, and audit row. Beginning the visit IS the front-desk
-- "in room" transition, so it must not be a second, drift-prone code path.
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
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(_appointment_id::text, 0)
    );

    select * into _appt
      from public.appointments
      where id = _appointment_id and deleted_at is null;
    if not found then
      raise exception 'appointment not found' using errcode = 'P0002';
    end if;
    if _appt.organization_id is distinct from _organization_id
       or _appt.patient_id is distinct from _patient_id then
      raise exception 'appointment does not match this patient and organization'
        using errcode = '42501';
    end if;

    select id into _id
      from public.encounters
      where appointment_id = _appointment_id
        and status = 'in_progress'
        and deleted_at is null;
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

  insert into public.encounter_participants
    (organization_id, encounter_id, user_id, participant_role)
  values (_organization_id, _id, _uid, 'author')
  on conflict do nothing;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_organization_id, _patient_id, _uid, 'encounter.started', 'encounter',
     _id::text, 'Encounter started',
     jsonb_build_object(
       'visit_type', _visit_type,
       'appointment_id', coalesce(_appointment_id::text, '')
     ));

  -- ADDED IN PHASE 2: the linked appointment enters the encounter state.
  if _appointment_id is not null
     and _appt.status in ('scheduled','confirmed','arrived') then
    update public.appointments
    set status = 'in_encounter',
        version = version + 1,
        updated_by = _uid,
        updated_at = now()
    where id = _appointment_id;

    insert into public.appointment_status_events
      (organization_id, appointment_id, from_status, to_status, kind, actor_user_id)
    values
      (_appt.organization_id, _appointment_id, _appt.status, 'in_encounter',
       'transition', _uid);

    insert into public.audit_events
      (organization_id, patient_id, actor_user_id, action, resource_type,
       resource_id, safe_message, metadata)
    values
      (_appt.organization_id, _appt.patient_id, _uid, 'appointment.in_encounter',
       'appointment', _appointment_id::text, 'Appointment in encounter',
       jsonb_build_object('previous_status', _appt.status,
                          'status', 'in_encounter',
                          'encounter_id', _id::text));
  end if;

  return _id;
end;
$$;

revoke all on function public.start_encounter(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.start_encounter(uuid, uuid, text, uuid) to authenticated, service_role;

commit;
