-- Desktop-owned scheduling boundary.
--
-- Calendar reads return only the scheduling fields required by the Desktop.
-- Patient names are available to front-desk staff without granting access to
-- clinical chart tables. Appointment mutations remain atomic and audited.

begin;

-- Scheduling is an operational permission, not a clinical-chart write
-- permission. Staff may manage appointments without gaining access to notes,
-- labs, protocols, or other patient-scoped clinical data.
create or replace function private.can_manage_schedule(_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner', 'admin', 'practitioner', 'staff')
  );
$$;

create or replace function private.can_manage_appointment(
  _organization_id uuid,
  _patient_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and (
        m.role in ('owner', 'admin', 'staff')
        or (
          m.role = 'practitioner'
          and (
            _patient_id is null
            or private.can_write_patient_data(_patient_id)
          )
        )
      )
  );
$$;

revoke all on function private.can_manage_schedule(uuid) from public, anon;
revoke all on function private.can_manage_appointment(uuid, uuid) from public, anon;
grant execute on function private.can_manage_schedule(uuid) to authenticated, service_role;
grant execute on function private.can_manage_appointment(uuid, uuid) to authenticated, service_role;

-- One bounded calendar snapshot: visible appointments, schedulable
-- practitioners, and the smallest patient picker needed for booking.
create or replace function public.get_desktop_calendar(
  _organization_id uuid,
  _from timestamptz,
  _to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _role text;
  _appointments jsonb;
  _practitioners jsonb;
  _patients jsonb;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select m.role into _role
  from public.organization_memberships m
  where m.organization_id = _organization_id
    and m.user_id = _uid
    and m.status = 'active';

  if _role is null then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if _from is null or _to is null or _to <= _from then
    raise exception 'invalid calendar range' using errcode = '22023';
  end if;
  if _to - _from > interval '42 days' then
    raise exception 'calendar range exceeds 42 days' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(row_data order by starts_at, id), '[]'::jsonb)
  into _appointments
  from (
    select
      a.starts_at,
      a.id,
      jsonb_build_object(
        'id', a.id,
        'patient_id', a.patient_id,
        'patient_name', nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''),
        'practitioner_user_id', a.practitioner_user_id,
        'practitioner_name', nullif(btrim(pp.display_name), ''),
        'title', a.title,
        'appointment_type', a.appointment_type,
        'location', a.location,
        'telehealth_url', a.telehealth_url,
        'status', a.status,
        'starts_at', a.starts_at,
        'ends_at', a.ends_at
      ) as row_data
    from public.appointments a
    left join public.patient_profiles p
      on p.id = a.patient_id
      and p.organization_id = a.organization_id
      and p.deleted_at is null
    left join public.practitioner_profiles pp
      on pp.organization_id = a.organization_id
      and pp.user_id = a.practitioner_user_id
      and pp.deleted_at is null
    where a.organization_id = _organization_id
      and a.deleted_at is null
      and a.starts_at >= _from
      and a.starts_at < _to
      and (
        a.patient_id is null
        or _role in ('owner', 'admin', 'staff')
        or private.can_access_patient(a.patient_id)
      )
  ) visible_appointments;

  select coalesce(jsonb_agg(row_data order by display_name, user_id), '[]'::jsonb)
  into _practitioners
  from (
    select
      m.user_id,
      coalesce(
        nullif(btrim(pp.display_name), ''),
        case when m.user_id = _uid then 'You' else 'Practitioner' end
      ) as display_name,
      jsonb_build_object(
        'user_id', m.user_id,
        'display_name', coalesce(
          nullif(btrim(pp.display_name), ''),
          case when m.user_id = _uid then 'You' else 'Practitioner' end
        ),
        'credentials', pp.credentials,
        'specialty', pp.specialty
      ) as row_data
    from public.organization_memberships m
    left join public.practitioner_profiles pp
      on pp.organization_id = m.organization_id
      and pp.user_id = m.user_id
      and pp.deleted_at is null
    where m.organization_id = _organization_id
      and m.status = 'active'
      and m.role in ('owner', 'admin', 'practitioner')
  ) schedulable_practitioners;

  if _role not in ('owner', 'admin', 'practitioner', 'staff') then
    _patients := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(row_data order by patient_name, id), '[]'::jsonb)
    into _patients
    from (
      select
        p.id,
        nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') as patient_name,
        jsonb_build_object(
          'id', p.id,
          'name', coalesce(
            nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''),
            'Unnamed patient'
          )
        ) as row_data
      from public.patient_profiles p
      where p.organization_id = _organization_id
        and p.deleted_at is null
        and p.status = 'active'
        and (
          _role in ('owner', 'admin', 'staff')
          or private.can_write_patient_data(p.id)
        )
    ) bookable_patients;
  end if;

  return jsonb_build_object(
    'appointments', _appointments,
    'practitioners', _practitioners,
    'patients', _patients
  );
end;
$$;

-- Atomic booking with scheduling-specific authorization and transaction-level
-- locks. All Desktop writes use these RPCs, so simultaneous requests for the
-- same practitioner or patient serialize before overlap checks.
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
  if not private.can_manage_schedule(_organization_id) then
    raise exception 'schedule-management role required' using errcode = '42501';
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
  if length(coalesce(_location, '')) > 200
     or length(coalesce(_title, '')) > 200
     or length(coalesce(_telehealth_url, '')) > 2048 then
    raise exception 'appointment text exceeds allowed length' using errcode = '22023';
  end if;

  if _practitioner_user_id is null or not exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = _practitioner_user_id
      and m.status = 'active'
      and m.role in ('owner', 'admin', 'practitioner')
  ) then
    raise exception 'practitioner is not schedulable in this organization'
      using errcode = '22023';
  end if;

  if _patient_id is not null then
    if not exists (
      select 1
      from public.patient_profiles p
      where p.id = _patient_id
        and p.organization_id = _organization_id
        and p.deleted_at is null
        and p.status = 'active'
    ) then
      raise exception 'patient not found in this organization' using errcode = 'P0002';
    end if;
  elsif _appointment_type not in ('break','group') then
    raise exception 'a patient is required for this appointment type' using errcode = '22023';
  end if;

  if not private.can_manage_appointment(_organization_id, _patient_id) then
    raise exception 'not authorized to manage this appointment' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('schedule:practitioner:' || _practitioner_user_id::text, 0)
  );
  if _patient_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('schedule:patient:' || _patient_id::text, 0)
    );
  end if;

  if exists (
    select 1
    from public.appointments a
    where a.practitioner_user_id = _practitioner_user_id
      and a.deleted_at is null
      and a.status not in ('cancelled','no_show')
      and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(_starts_at, _ends_at, '[)')
  ) then
    raise exception 'practitioner already has an appointment in this time range'
      using errcode = '22023';
  end if;
  if _patient_id is not null and exists (
    select 1
    from public.appointments a
    where a.patient_id = _patient_id
      and a.deleted_at is null
      and a.status not in ('cancelled','no_show')
      and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(_starts_at, _ends_at, '[)')
  ) then
    raise exception 'patient already has an appointment in this time range'
      using errcode = '22023';
  end if;

  insert into public.appointments (
    organization_id, patient_id, practitioner_user_id, title, appointment_type,
    location, telehealth_url, status, starts_at, ends_at, source,
    created_by, updated_by
  ) values (
    _organization_id, _patient_id, _practitioner_user_id,
    nullif(btrim(_title), ''), _appointment_type, nullif(btrim(_location), ''),
    nullif(btrim(_telehealth_url), ''), 'scheduled', _starts_at, _ends_at,
    'desktop', _uid, _uid
  )
  returning id into _id;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _organization_id, _patient_id, _uid, 'appointment.book',
    'appointment', _id::text, 'Appointment booked (' || _appointment_type || ')',
    jsonb_build_object(
      'appointment_type', _appointment_type,
      'starts_at', _starts_at,
      'ends_at', _ends_at,
      'practitioner_user_id', _practitioner_user_id,
      'location_present', nullif(btrim(_location), '') is not null,
      'telehealth', nullif(btrim(_telehealth_url), '') is not null
    )
  );

  return jsonb_build_object(
    'id', _id,
    'status', 'scheduled',
    'starts_at', _starts_at,
    'ends_at', _ends_at
  );
end;
$$;

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
  where id = _appointment_id and deleted_at is null
  for update;
  if not found then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  if not private.can_manage_appointment(_appt.organization_id, _appt.patient_id) then
    raise exception 'not authorized to manage this appointment' using errcode = '42501';
  end if;

  if _appt.status = _status then
    return jsonb_build_object(
      'id', _appt.id,
      'status', _appt.status,
      'previous_status', _appt.status,
      'already_set', true
    );
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
    'appointment', _appt.id::text, 'Appointment ' || replace(_status, '_', '-'),
    jsonb_build_object('previous_status', _appt.status, 'status', _status)
  );

  return jsonb_build_object(
    'id', _appt.id,
    'status', _status,
    'previous_status', _appt.status,
    'already_set', false
  );
end;
$$;

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
  where id = _appointment_id and deleted_at is null
  for update;
  if not found then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  if _appt.status in ('completed','cancelled','no_show') then
    raise exception 'appointment is already settled' using errcode = '22023';
  end if;
  if not private.can_manage_appointment(_appt.organization_id, _appt.patient_id) then
    raise exception 'not authorized to manage this appointment' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('schedule:practitioner:' || _appt.practitioner_user_id::text, 0)
  );
  if _appt.patient_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('schedule:patient:' || _appt.patient_id::text, 0)
    );
  end if;

  if exists (
    select 1
    from public.appointments a
    where a.practitioner_user_id = _appt.practitioner_user_id
      and a.id <> _appt.id
      and a.deleted_at is null
      and a.status not in ('cancelled','no_show')
      and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(_starts_at, _ends_at, '[)')
  ) then
    raise exception 'practitioner already has an appointment in this time range'
      using errcode = '22023';
  end if;
  if _appt.patient_id is not null and exists (
    select 1
    from public.appointments a
    where a.patient_id = _appt.patient_id
      and a.id <> _appt.id
      and a.deleted_at is null
      and a.status not in ('cancelled','no_show')
      and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(_starts_at, _ends_at, '[)')
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
    'appointment', _appt.id::text, 'Appointment rescheduled',
    jsonb_build_object(
      'previous_starts_at', _appt.starts_at,
      'starts_at', _starts_at,
      'previous_ends_at', _appt.ends_at,
      'ends_at', _ends_at
    )
  );

  return jsonb_build_object(
    'id', _appt.id,
    'status', _appt.status,
    'starts_at', _starts_at,
    'ends_at', _ends_at
  );
end;
$$;

-- The browser-facing role uses bounded functions, not the raw appointment
-- table. RLS remains enabled as defense in depth.
revoke all privileges on table public.appointments from public, anon, authenticated;

revoke all on function public.get_desktop_calendar(uuid, timestamptz, timestamptz)
  from public, anon;
revoke all on function public.book_appointment(
  uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text
) from public, anon;
revoke all on function public.update_appointment_status(uuid, text)
  from public, anon;
revoke all on function public.reschedule_appointment(uuid, timestamptz, timestamptz)
  from public, anon;

grant execute on function public.get_desktop_calendar(uuid, timestamptz, timestamptz)
  to authenticated;
grant execute on function public.book_appointment(
  uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text
) to authenticated;
grant execute on function public.update_appointment_status(uuid, text)
  to authenticated;
grant execute on function public.reschedule_appointment(uuid, timestamptz, timestamptz)
  to authenticated;

commit;
