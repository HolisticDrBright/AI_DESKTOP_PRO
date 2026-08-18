-- Governed patient creation for the practitioner Desktop.
-- The caller's JWT is authoritative; organization membership and role are
-- checked in the database. The function returns only the newly-created
-- directory row and writes a PHI-safe audit event.

create or replace function public.create_patient_profile(
  _organization_id uuid,
  _first_name text,
  _last_name text,
  _date_of_birth date default null,
  _sex text default 'unknown',
  _mrn text default null,
  _email text default null,
  _phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _role text;
  _patient public.patient_profiles%rowtype;
  _first text := btrim(coalesce(_first_name, ''));
  _last text := btrim(coalesce(_last_name, ''));
  _normalized_sex text := lower(btrim(coalesce(_sex, 'unknown')));
  _normalized_mrn text := nullif(btrim(_mrn), '');
  _normalized_email text := nullif(lower(btrim(_email)), '');
  _normalized_phone text := nullif(btrim(_phone), '');
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select m.role into _role
  from public.organization_memberships m
  where m.organization_id = _organization_id
    and m.user_id = _uid
    and m.status = 'active';

  if _role is null or _role not in ('owner', 'admin', 'practitioner') then
    raise exception 'clinical role required in this organization' using errcode = '42501';
  end if;

  if _first = '' or length(_first) > 100 or _last = '' or length(_last) > 100 then
    raise exception 'valid first and last names are required' using errcode = '22023';
  end if;
  if _normalized_sex not in ('male', 'female', 'other', 'unknown') then
    raise exception 'invalid recorded sex' using errcode = '22023';
  end if;
  if _date_of_birth is not null
     and (_date_of_birth > current_date or _date_of_birth < date '1900-01-01') then
    raise exception 'invalid date of birth' using errcode = '22023';
  end if;
  if length(coalesce(_normalized_mrn, '')) > 64
     or length(coalesce(_normalized_email, '')) > 320
     or length(coalesce(_normalized_phone, '')) > 40 then
    raise exception 'patient field exceeds its maximum length' using errcode = '22023';
  end if;

  insert into public.patient_profiles (
    organization_id,
    mrn,
    first_name,
    last_name,
    date_of_birth,
    sex,
    email,
    phone,
    status,
    source,
    created_by,
    updated_by
  ) values (
    _organization_id,
    _normalized_mrn,
    _first,
    _last,
    _date_of_birth,
    _normalized_sex,
    _normalized_email,
    _normalized_phone,
    'active',
    'manual',
    _uid,
    _uid
  ) returning * into _patient;

  -- A practitioner must be able to read the patient they just created.
  -- Owners/admins retain organization-wide access through the existing gate.
  if _role = 'practitioner' then
    insert into public.practitioner_patient_relationships (
      organization_id,
      practitioner_user_id,
      patient_id,
      relationship_type,
      status,
      created_by
    ) values (
      _organization_id,
      _uid,
      _patient.id,
      'primary',
      'active',
      _uid
    );
  end if;

  insert into public.audit_events (
    organization_id,
    patient_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    safe_message,
    metadata
  ) values (
    _organization_id,
    _patient.id,
    _uid,
    'patient.created',
    'patient_profile',
    _patient.id::text,
    'Patient profile created',
    jsonb_build_object('source', 'manual')
  );

  return jsonb_build_object(
    'id', _patient.id,
    'organization_id', _patient.organization_id,
    'mrn', _patient.mrn,
    'first_name', _patient.first_name,
    'last_name', _patient.last_name,
    'date_of_birth', _patient.date_of_birth,
    'sex', _patient.sex,
    'status', _patient.status
  );
end;
$$;

revoke all on function public.create_patient_profile(uuid, text, text, date, text, text, text, text)
  from public, anon;
grant execute on function public.create_patient_profile(uuid, text, text, date, text, text, text, text)
  to authenticated;
