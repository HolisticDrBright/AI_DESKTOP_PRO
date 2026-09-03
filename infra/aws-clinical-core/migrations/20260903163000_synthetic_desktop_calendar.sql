-- AWS synthetic-only scheduling surface for Desktop verification.

create table clinical_core.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid references clinical_core.patient_records(id),
  practitioner_person_id uuid not null references clinical_core.persons(id),
  title text check (title is null or char_length(title) between 1 and 200),
  appointment_type text not null check (appointment_type in
    ('initial','follow-up','lab-review','supplement','telehealth','group','break')),
  location text check (location is null or char_length(location) between 1 and 200),
  telehealth_url text check (telehealth_url is null or char_length(telehealth_url) between 1 and 2048),
  status text not null default 'scheduled' check (status in
    ('scheduled','confirmed','arrived','in_encounter','completed','cancelled','no_show')),
  version integer not null default 1 check (version > 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  source text not null default 'desktop' check (source = 'desktop'),
  created_by_person_id uuid not null references clinical_core.persons(id),
  updated_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  check (ends_at > starts_at and ends_at - starts_at <= interval '8 hours'),
  foreign key (patient_record_id, organization_id)
    references clinical_core.patient_records(id, organization_id)
);

create index appointments_org_time_idx on clinical_core.appointments(organization_id, starts_at);
create index appointments_patient_time_idx on clinical_core.appointments(patient_record_id, starts_at desc)
  where patient_record_id is not null and deleted_at is null;
create index appointments_practitioner_time_idx on clinical_core.appointments(practitioner_person_id, starts_at)
  where deleted_at is null;

create table clinical_core.appointment_status_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  appointment_id uuid not null references clinical_core.appointments(id),
  from_status text not null,
  to_status text not null,
  kind text not null check (kind in ('transition','correction')),
  reason text check (reason is null or char_length(reason) between 1 and 1000),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 1 and 128),
  actor_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (appointment_id, idempotency_key)
);
create index appointment_status_events_appt_idx
  on clinical_core.appointment_status_events(appointment_id, created_at desc);

alter table clinical_core.appointments enable row level security;
alter table clinical_core.appointment_status_events enable row level security;
revoke all on clinical_core.appointments, clinical_core.appointment_status_events from public, clinical_core_api;
create trigger appointment_status_events_append_only before update or delete
  on clinical_core.appointment_status_events for each row
  execute function clinical_private.block_update_delete();

create or replace function clinical_private.has_schedule_role(_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from clinical_core.organization_memberships membership
    where membership.organization_id = _organization_id
      and membership.person_id = clinical_private.actor_person_id()
      and membership.status = 'active'
      and membership.role in ('owner','admin','practitioner','staff'))
$$;

create or replace function clinical_private.appointment_transition_allowed(_from text, _to text)
returns boolean language sql immutable security invoker set search_path = '' as $$
  select case _from
    when 'scheduled' then _to in ('confirmed','arrived','cancelled','no_show')
    when 'confirmed' then _to in ('arrived','cancelled','no_show')
    when 'arrived' then _to in ('in_encounter','completed','cancelled','no_show')
    when 'in_encounter' then _to in ('completed','cancelled')
    else false end
$$;

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed','consent.granted','consent.revoked',
  'lab_import.received','lab_import.duplicate','lab_import.accepted','lab_import.rejected',
  'clinical_record.received','clinical_record.duplicate','privacy_request.submitted',
  'appointment.booked','appointment.rescheduled','appointment.status_changed','appointment.corrected'));
alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check check (resource_type in (
  'connection','consent','lab_import','clinical_record','privacy_request','appointment'));

create or replace function clinical_core.get_desktop_calendar(
  _organization_id uuid, _from timestamptz, _to timestamptz
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _appointments jsonb; _practitioners jsonb; _patients jsonb;
begin
  perform clinical_private.assert_synthetic_context(_organization_id,'clinical_data','workforce');
  if not clinical_private.has_schedule_role(_organization_id) then
    raise exception using errcode='42501', message='schedule_role_required'; end if;
  if _from is null or _to is null or _to <= _from or _to - _from > interval '42 days' then
    raise exception using errcode='22023', message='calendar_range_invalid'; end if;
  select coalesce(jsonb_agg(row_data order by starts_at,id),'[]'::jsonb) into _appointments from (
    select appointment.starts_at, appointment.id, jsonb_build_object(
      'id',appointment.id,'patient_id',appointment.patient_record_id,
      'patient_name',patient.synthetic_record_key,
      'practitioner_user_id',appointment.practitioner_person_id,
      'practitioner_name',case when appointment.practitioner_person_id=clinical_private.actor_person_id() then 'You' else 'Practitioner' end,
      'title',appointment.title,'appointment_type',appointment.appointment_type,
      'location',appointment.location,'telehealth_url',appointment.telehealth_url,
      'status',appointment.status,'version',appointment.version,
      'starts_at',appointment.starts_at,'ends_at',appointment.ends_at) row_data
    from clinical_core.appointments appointment
    left join clinical_core.patient_records patient on patient.id=appointment.patient_record_id
      and patient.organization_id=_organization_id and patient.status='active'
    where appointment.organization_id=_organization_id and appointment.deleted_at is null
      and appointment.starts_at>=_from and appointment.starts_at<_to) visible;
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id',membership.person_id,
    'display_name',case when membership.person_id=clinical_private.actor_person_id() then 'You' else 'Practitioner' end,
    'credentials',null,'specialty',null) order by membership.created_at),'[]'::jsonb)
    into _practitioners from clinical_core.organization_memberships membership
    where membership.organization_id=_organization_id and membership.status='active'
      and membership.role in ('owner','admin','practitioner');
  select coalesce(jsonb_agg(jsonb_build_object('id',patient.id,'name',patient.synthetic_record_key)
    order by patient.synthetic_record_key),'[]'::jsonb) into _patients
    from clinical_core.patient_records patient where patient.organization_id=_organization_id
      and patient.status='active';
  return jsonb_build_object('appointments',_appointments,'practitioners',_practitioners,'patients',_patients);
end $$;

create or replace function clinical_core.book_appointment(
  _organization_id uuid,_practitioner_user_id uuid,_appointment_type text,
  _starts_at timestamptz,_ends_at timestamptz,_patient_id uuid default null,
  _location text default null,_telehealth_url text default null,_title text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _id uuid;
begin
  perform clinical_private.assert_synthetic_context(_organization_id,'clinical_data','workforce');
  if not clinical_private.has_schedule_role(_organization_id) then raise exception using errcode='42501',message='schedule_role_required'; end if;
  if _appointment_type not in ('initial','follow-up','lab-review','supplement','telehealth','group','break')
    or _starts_at is null or _ends_at is null or _ends_at<=_starts_at or _ends_at-_starts_at>interval '8 hours'
    or char_length(coalesce(_location,''))>200 or char_length(coalesce(_telehealth_url,''))>2048
    or char_length(coalesce(_title,''))>200 then raise exception using errcode='22023',message='appointment_invalid'; end if;
  if not exists(select 1 from clinical_core.organization_memberships membership
    where membership.organization_id=_organization_id and membership.person_id=_practitioner_user_id
      and membership.status='active' and membership.role in ('owner','admin','practitioner')) then
    raise exception using errcode='22023',message='practitioner_not_schedulable'; end if;
  if _patient_id is null and _appointment_type not in ('break','group') then raise exception using errcode='22023',message='patient_required'; end if;
  if _patient_id is not null and not exists(select 1 from clinical_core.patient_records patient
    where patient.id=_patient_id and patient.organization_id=_organization_id and patient.status='active') then
    raise exception using errcode='P0002',message='patient_not_found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:practitioner:'||_practitioner_user_id::text,0));
  if _patient_id is not null then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:patient:'||_patient_id::text,0)); end if;
  if exists(select 1 from clinical_core.appointments appointment where appointment.organization_id=_organization_id
    and appointment.practitioner_person_id=_practitioner_user_id and appointment.deleted_at is null
    and appointment.status not in ('cancelled','no_show')
    and tstzrange(appointment.starts_at,appointment.ends_at,'[)')&&tstzrange(_starts_at,_ends_at,'[)'))
    or (_patient_id is not null and exists(select 1 from clinical_core.appointments appointment
      where appointment.organization_id=_organization_id and appointment.patient_record_id=_patient_id
        and appointment.deleted_at is null and appointment.status not in ('cancelled','no_show')
        and tstzrange(appointment.starts_at,appointment.ends_at,'[)')&&tstzrange(_starts_at,_ends_at,'[)'))) then
    raise exception using errcode='22023',message='appointment_overlap'; end if;
  insert into clinical_core.appointments(organization_id,patient_record_id,practitioner_person_id,title,appointment_type,
    location,telehealth_url,starts_at,ends_at,created_by_person_id,updated_by_person_id)
  values(_organization_id,_patient_id,_practitioner_user_id,nullif(btrim(_title),''),_appointment_type,
    nullif(btrim(_location),''),nullif(btrim(_telehealth_url),''),_starts_at,_ends_at,
    clinical_private.actor_person_id(),clinical_private.actor_person_id()) returning id into _id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,safe_message,purpose,safe_metadata)
  values(_organization_id,clinical_private.actor_person_id(),'appointment.booked','appointment',_id,_patient_id,
    'Appointment booked','clinical_data',jsonb_build_object('appointment_type',_appointment_type,'telehealth',nullif(btrim(_telehealth_url),'') is not null));
  return jsonb_build_object('id',_id,'status','scheduled','starts_at',_starts_at,'ends_at',_ends_at);
end $$;

create or replace function clinical_core.transition_appointment(
  _appointment_id uuid,_to_status text,_expected_version integer,
  _idempotency_key text default null,_reason text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _appointment clinical_core.appointments%rowtype; _replay clinical_core.appointment_status_events%rowtype;
begin
  perform clinical_private.assert_synthetic_context(clinical_private.organization_id(),'clinical_data','workforce');
  if _to_status not in ('confirmed','arrived','in_encounter','completed','cancelled','no_show')
    or char_length(coalesce(_idempotency_key,''))>128 or char_length(coalesce(_reason,''))>1000 then
    raise exception using errcode='22023',message='transition_invalid'; end if;
  select * into _appointment from clinical_core.appointments where id=_appointment_id
    and organization_id=clinical_private.organization_id() and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='appointment_not_found'; end if;
  if not clinical_private.has_schedule_role(_appointment.organization_id) then raise exception using errcode='42501',message='schedule_role_required'; end if;
  if _idempotency_key is not null then
    select * into _replay from clinical_core.appointment_status_events where appointment_id=_appointment_id and idempotency_key=_idempotency_key;
    if found then return jsonb_build_object('ok',true,'id',_appointment.id,'status',_replay.to_status,
      'previous_status',_replay.from_status,'version',_appointment.version,'already_applied',true); end if;
  end if;
  if _expected_version is not null and _expected_version<>_appointment.version then raise exception using errcode='40001',message='appointment_version_conflict'; end if;
  if _appointment.status=_to_status then return jsonb_build_object('ok',true,'id',_appointment.id,'status',_appointment.status,
    'previous_status',_appointment.status,'version',_appointment.version,'already_applied',true); end if;
  if not clinical_private.appointment_transition_allowed(_appointment.status,_to_status) then raise exception using errcode='22023',message='appointment_transition_refused'; end if;
  update clinical_core.appointments set status=_to_status,version=version+1,
    updated_by_person_id=clinical_private.actor_person_id(),updated_at=clock_timestamp() where id=_appointment.id;
  insert into clinical_core.appointment_status_events(organization_id,appointment_id,from_status,to_status,kind,reason,idempotency_key,actor_person_id)
  values(_appointment.organization_id,_appointment.id,_appointment.status,_to_status,'transition',nullif(btrim(_reason),''),_idempotency_key,clinical_private.actor_person_id());
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,safe_message,purpose,safe_metadata)
  values(_appointment.organization_id,clinical_private.actor_person_id(),'appointment.status_changed','appointment',_appointment.id,_appointment.patient_record_id,
    'Appointment status changed','clinical_data',jsonb_build_object('previous_status',_appointment.status,'status',_to_status));
  return jsonb_build_object('ok',true,'id',_appointment.id,'status',_to_status,'previous_status',_appointment.status,
    'version',_appointment.version+1,'already_applied',false);
end $$;

create or replace function clinical_core.update_appointment_status(_appointment_id uuid,_status text)
returns jsonb language sql security invoker set search_path='' as $$
  select jsonb_build_object('id',result->>'id','status',result->>'status',
    'previous_status',result->>'previous_status','already_set',(result->>'already_applied')::boolean)
  from (select clinical_core.transition_appointment(_appointment_id,_status,null,null,null) result) transition
$$;

create or replace function clinical_core.reschedule_appointment(_appointment_id uuid,_starts_at timestamptz,_ends_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _appointment clinical_core.appointments%rowtype;
begin
  perform clinical_private.assert_synthetic_context(clinical_private.organization_id(),'clinical_data','workforce');
  if _starts_at is null or _ends_at is null or _ends_at<=_starts_at or _ends_at-_starts_at>interval '8 hours' then raise exception using errcode='22023',message='appointment_time_invalid'; end if;
  select * into _appointment from clinical_core.appointments where id=_appointment_id
    and organization_id=clinical_private.organization_id() and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='appointment_not_found'; end if;
  if not clinical_private.has_schedule_role(_appointment.organization_id) then raise exception using errcode='42501',message='schedule_role_required'; end if;
  if _appointment.status in ('completed','cancelled','no_show') then raise exception using errcode='22023',message='appointment_settled'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:practitioner:'||_appointment.practitioner_person_id::text,0));
  if _appointment.patient_record_id is not null then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:patient:'||_appointment.patient_record_id::text,0)); end if;
  if exists(select 1 from clinical_core.appointments other where other.organization_id=_appointment.organization_id
    and other.practitioner_person_id=_appointment.practitioner_person_id and other.id<>_appointment.id
    and other.deleted_at is null and other.status not in ('cancelled','no_show')
    and tstzrange(other.starts_at,other.ends_at,'[)')&&tstzrange(_starts_at,_ends_at,'[)'))
    or (_appointment.patient_record_id is not null and exists(select 1 from clinical_core.appointments other
      where other.organization_id=_appointment.organization_id and other.patient_record_id=_appointment.patient_record_id
        and other.id<>_appointment.id and other.deleted_at is null and other.status not in ('cancelled','no_show')
        and tstzrange(other.starts_at,other.ends_at,'[)')&&tstzrange(_starts_at,_ends_at,'[)'))) then
    raise exception using errcode='22023',message='appointment_overlap'; end if;
  update clinical_core.appointments set starts_at=_starts_at,ends_at=_ends_at,
    updated_by_person_id=clinical_private.actor_person_id(),updated_at=clock_timestamp() where id=_appointment.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,safe_message,purpose,safe_metadata)
  values(_appointment.organization_id,clinical_private.actor_person_id(),'appointment.rescheduled','appointment',_appointment.id,
    _appointment.patient_record_id,'Appointment rescheduled','clinical_data',jsonb_build_object('time_changed',true));
  return jsonb_build_object('id',_appointment.id,'status',_appointment.status,'starts_at',_starts_at,'ends_at',_ends_at);
end $$;

revoke all on function clinical_private.has_schedule_role(uuid),clinical_private.appointment_transition_allowed(text,text) from public;
grant execute on function clinical_private.has_schedule_role(uuid),clinical_private.appointment_transition_allowed(text,text) to clinical_core_api;
revoke all on function clinical_core.get_desktop_calendar(uuid,timestamptz,timestamptz),
  clinical_core.book_appointment(uuid,uuid,text,timestamptz,timestamptz,uuid,text,text,text),
  clinical_core.transition_appointment(uuid,text,integer,text,text),
  clinical_core.update_appointment_status(uuid,text),
  clinical_core.reschedule_appointment(uuid,timestamptz,timestamptz) from public;
grant execute on function clinical_core.get_desktop_calendar(uuid,timestamptz,timestamptz),
  clinical_core.book_appointment(uuid,uuid,text,timestamptz,timestamptz,uuid,text,text,text),
  clinical_core.transition_appointment(uuid,text,integer,text,text),
  clinical_core.update_appointment_status(uuid,text),
  clinical_core.reschedule_appointment(uuid,timestamptz,timestamptz) to clinical_core_api;
