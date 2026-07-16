-- 0017_scheduling
-- Live scheduling on the existing appointments table: vocabulary + sanity
-- checks, org-level visibility for patient-NULL rows (breaks / group blocks —
-- same gap 0015 fixed for the review queue), calendar-range indexes, and the
-- three SECURITY DEFINER write RPCs (book / status / reschedule) with
-- double-booking rejection and append-only audit. Writes stay RPC-only.

-- 1) Vocabulary + sanity ------------------------------------------------------
-- The calendar has an in-progress state; the original check lacked it.
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status = any (array[
    'scheduled'::text, 'confirmed'::text, 'arrived'::text,
    'completed'::text, 'cancelled'::text, 'no_show'::text
  ]));

-- Desktop vocabulary verbatim (hyphens intentional) — no mapping layer to drift.
alter table public.appointments drop constraint if exists appointments_type_check;
alter table public.appointments add constraint appointments_type_check
  check (appointment_type is null or appointment_type = any (array[
    'initial'::text, 'follow-up'::text, 'lab-review'::text, 'supplement'::text,
    'telehealth'::text, 'group'::text, 'break'::text
  ]));

alter table public.appointments drop constraint if exists appointments_time_check;
alter table public.appointments add constraint appointments_time_check
  check (starts_at is null or ends_at is null or ends_at > starts_at);

-- 2) Org-level visibility ------------------------------------------------------
-- Patient rows: patient access. Patient-NULL rows (breaks, org blocks): any
-- active org member — can_access_patient(NULL) is false, so without this
-- branch nobody could see them.
drop policy if exists appointments_select on public.appointments;
create policy appointments_select on public.appointments
  for select to authenticated
  using (
    deleted_at is null
    and (
      (patient_id is not null and private.can_access_patient(patient_id))
      or (patient_id is null and private.is_org_member(organization_id))
    )
  );

-- 3) Calendar-range indexes ----------------------------------------------------
create index if not exists appointments_org_starts_idx
  on public.appointments (organization_id, starts_at);
create index if not exists appointments_practitioner_starts_idx
  on public.appointments (practitioner_user_id, starts_at);

-- 4) book_appointment -----------------------------------------------------------
-- Atomic: validate → double-booking checks → insert → audit. Status starts
-- 'scheduled'. Patient-NULL bookings (break / group) require a practitioner or
-- admin role; patient bookings require write access to that patient.
create or replace function public.book_appointment(
  _organization_id uuid,
  _practitioner_user_id uuid,
  _appointment_type text,
  _starts_at timestamptz,
  _ends_at timestamptz,
  _patient_id uuid default null,
  _location text default null,
  _telehealth_url text default null,
  _title text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not an organization member' using errcode = '42501';
  end if;

  if _appointment_type is null or _appointment_type not in
     ('initial','follow-up','lab-review','supplement','telehealth','group','break') then
    raise exception 'invalid appointment type' using errcode = '22023';
  end if;
  if _starts_at is null or _ends_at is null or _ends_at <= _starts_at then
    raise exception 'invalid time range' using errcode = '22023';
  end if;
  if _ends_at - _starts_at > interval '8 hours' then
    raise exception 'appointment exceeds 8 hours' using errcode = '22023';
  end if;

  -- The practitioner column must reference an ACTIVE member of this org.
  if _practitioner_user_id is null or not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = _practitioner_user_id
      and m.status = 'active'
  ) then
    raise exception 'practitioner is not an active member of this organization'
      using errcode = '22023';
  end if;

  if _patient_id is not null then
    if not exists (
      select 1 from public.patient_profiles p
      where p.id = _patient_id
        and p.organization_id = _organization_id
        and p.deleted_at is null
    ) then
      raise exception 'patient not found in this organization' using errcode = 'P0002';
    end if;
    if not private.can_write_patient_data(_patient_id) then
      raise exception 'not authorized to book for this patient' using errcode = '42501';
    end if;
  else
    if _appointment_type not in ('break','group') then
      raise exception 'a patient is required for this appointment type' using errcode = '22023';
    end if;
    if not (private.is_org_admin(_organization_id)
         or private.has_org_role(_organization_id, 'practitioner')) then
      raise exception 'practitioner or admin role required' using errcode = '42501';
    end if;
  end if;

  -- Double-booking: the practitioner cannot have two live overlapping slots.
  if exists (
    select 1 from public.appointments a
    where a.practitioner_user_id = _practitioner_user_id
      and a.deleted_at is null
      and a.status not in ('cancelled','no_show')
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(_starts_at, _ends_at)
  ) then
    raise exception 'practitioner already has an appointment in this time range'
      using errcode = '22023';
  end if;
  -- Neither can the patient.
  if _patient_id is not null and exists (
    select 1 from public.appointments a
    where a.patient_id = _patient_id
      and a.deleted_at is null
      and a.status not in ('cancelled','no_show')
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(_starts_at, _ends_at)
  ) then
    raise exception 'patient already has an appointment in this time range'
      using errcode = '22023';
  end if;

  insert into public.appointments (
    organization_id, patient_id, practitioner_user_id, title, appointment_type,
    location, telehealth_url, status, starts_at, ends_at, source,
    created_by, updated_by
  ) values (
    _organization_id, _patient_id, _practitioner_user_id, _title, _appointment_type,
    _location, _telehealth_url, 'scheduled', _starts_at, _ends_at, 'desktop',
    _uid, _uid
  )
  returning id into _id;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _organization_id, _patient_id, _uid, 'appointment.book',
    'appointment', _id::text,
    'Appointment booked (' || _appointment_type || ')',
    jsonb_build_object(
      'appointment_type', _appointment_type,
      'starts_at', _starts_at,
      'ends_at', _ends_at,
      'practitioner_user_id', _practitioner_user_id,
      'location_present', _location is not null,
      'telehealth', _telehealth_url is not null
    )
  );

  return jsonb_build_object(
    'id', _id, 'status', 'scheduled',
    'starts_at', _starts_at, 'ends_at', _ends_at
  );
end;
$$;

-- 5) update_appointment_status ---------------------------------------------------
-- Transitions: scheduled|confirmed → confirmed|arrived|completed|cancelled|no_show;
-- arrived → completed|cancelled. Terminal states are idempotent on repeat,
-- otherwise rejected.
create or replace function public.update_appointment_status(
  _appointment_id uuid,
  _status text
)
returns jsonb
language plpgsql
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
  if _status not in ('confirmed','arrived','completed','cancelled','no_show') then
    raise exception 'invalid status' using errcode = '22023';
  end if;

  select * into _appt
  from public.appointments
  where id = _appointment_id and deleted_at is null;
  if not found then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;

  if _appt.patient_id is not null then
    if not private.can_write_patient_data(_appt.patient_id) then
      raise exception 'not authorized for this patient''s appointments' using errcode = '42501';
    end if;
  else
    if not (private.is_org_admin(_appt.organization_id)
         or private.has_org_role(_appt.organization_id, 'practitioner')) then
      raise exception 'practitioner or admin role required' using errcode = '42501';
    end if;
  end if;

  if _appt.status = _status then
    return jsonb_build_object('id', _appt.id, 'status', _appt.status,
      'previous_status', _appt.status, 'already_set', true);
  end if;
  if _appt.status in ('completed','cancelled','no_show') then
    raise exception 'appointment is already settled' using errcode = '22023';
  end if;
  if _appt.status = 'arrived' and _status not in ('completed','cancelled') then
    raise exception 'invalid transition from arrived' using errcode = '22023';
  end if;

  update public.appointments
  set status = _status, updated_by = _uid, updated_at = now()
  where id = _appt.id;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _appt.organization_id, _appt.patient_id, _uid, 'appointment.status',
    'appointment', _appt.id::text,
    'Appointment ' || _status,
    jsonb_build_object('previous_status', _appt.status, 'status', _status)
  );

  return jsonb_build_object('id', _appt.id, 'status', _status,
    'previous_status', _appt.status, 'already_set', false);
end;
$$;

-- 6) reschedule_appointment -------------------------------------------------------
create or replace function public.reschedule_appointment(
  _appointment_id uuid,
  _starts_at timestamptz,
  _ends_at timestamptz
)
returns jsonb
language plpgsql
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
  if _starts_at is null or _ends_at is null or _ends_at <= _starts_at
     or _ends_at - _starts_at > interval '8 hours' then
    raise exception 'invalid time range' using errcode = '22023';
  end if;

  select * into _appt
  from public.appointments
  where id = _appointment_id and deleted_at is null;
  if not found then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  if _appt.status in ('completed','cancelled','no_show') then
    raise exception 'appointment is already settled' using errcode = '22023';
  end if;

  if _appt.patient_id is not null then
    if not private.can_write_patient_data(_appt.patient_id) then
      raise exception 'not authorized for this patient''s appointments' using errcode = '42501';
    end if;
  else
    if not (private.is_org_admin(_appt.organization_id)
         or private.has_org_role(_appt.organization_id, 'practitioner')) then
      raise exception 'practitioner or admin role required' using errcode = '42501';
    end if;
  end if;

  if exists (
    select 1 from public.appointments a
    where a.practitioner_user_id = _appt.practitioner_user_id
      and a.id <> _appt.id
      and a.deleted_at is null
      and a.status not in ('cancelled','no_show')
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(_starts_at, _ends_at)
  ) then
    raise exception 'practitioner already has an appointment in this time range'
      using errcode = '22023';
  end if;
  if _appt.patient_id is not null and exists (
    select 1 from public.appointments a
    where a.patient_id = _appt.patient_id
      and a.id <> _appt.id
      and a.deleted_at is null
      and a.status not in ('cancelled','no_show')
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(_starts_at, _ends_at)
  ) then
    raise exception 'patient already has an appointment in this time range'
      using errcode = '22023';
  end if;

  update public.appointments
  set starts_at = _starts_at, ends_at = _ends_at, updated_by = _uid, updated_at = now()
  where id = _appt.id;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _appt.organization_id, _appt.patient_id, _uid, 'appointment.reschedule',
    'appointment', _appt.id::text,
    'Appointment rescheduled',
    jsonb_build_object(
      'previous_starts_at', _appt.starts_at, 'starts_at', _starts_at,
      'previous_ends_at', _appt.ends_at, 'ends_at', _ends_at
    )
  );

  return jsonb_build_object('id', _appt.id, 'status', _appt.status,
    'starts_at', _starts_at, 'ends_at', _ends_at);
end;
$$;

-- 7) Execution grants -------------------------------------------------------------
revoke all on function public.book_appointment(uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text) from public, anon;
revoke all on function public.update_appointment_status(uuid, text) from public, anon;
revoke all on function public.reschedule_appointment(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.book_appointment(uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text) to authenticated;
grant execute on function public.update_appointment_status(uuid, text) to authenticated;
grant execute on function public.reschedule_appointment(uuid, timestamptz, timestamptz) to authenticated;
