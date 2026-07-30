-- desktop_frontdesk_calendar_version
--
-- get_desktop_calendar gains ONE field: each appointment now carries its
-- `version`, so the calendar drawer can pass an optimistic-concurrency token
-- to transition_appointment and get a 40001 conflict instead of clobbering a
-- change another user made since the week was rendered.
--
-- The body is reproduced byte-for-byte from 20260728233756 (extracted
-- programmatically, not retyped) with only the added projection line, so the
-- role-scoped visibility rules, range guards, and patient-picker bounds are
-- provably unchanged.

begin;

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
        'ends_at', a.ends_at,
        'version', a.version
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

revoke all on function public.get_desktop_calendar(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_desktop_calendar(uuid, timestamptz, timestamptz) to authenticated, service_role;

commit;
