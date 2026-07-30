-- Desktop-owned encounter and signed-note boundary.
-- Applied migration version: 20260729005221.
--
-- Existing mutation RPCs from 0021 remain the source of truth for encounter
-- and note state machines. This migration adds narrow, bounded read DTOs for
-- the Desktop app and closes the concurrent appointment-start race.

begin;

-- Defense in depth for the "start or resume" contract. Direct writes are not
-- granted, but this also prevents duplicate active encounters under concurrent
-- RPC calls or privileged maintenance work.
create unique index if not exists encounters_one_active_per_appointment_idx
  on public.encounters (appointment_id)
  where appointment_id is not null
    and status = 'in_progress'
    and deleted_at is null;

-- Serialize starts for a linked appointment before checking for an existing
-- active encounter. This preserves the original idempotent response instead
-- of leaking a unique-violation race to the caller.
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

  return _id;
end;
$$;

create or replace function public.get_desktop_encounter(_encounter_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _e public.encounters%rowtype;
  _notes jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _e
    from public.encounters
    where id = _encounter_id and deleted_at is null;
  if not found then
    raise exception 'encounter not found' using errcode = 'P0002';
  end if;
  if not private.can_access_patient(_e.patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'note_id', n.id,
        'encounter_id', n.encounter_id,
        'patient_id', n.patient_id,
        'note_type', n.note_type,
        'status', n.status,
        'current_version', n.current_version,
        'author_user_id', n.author_user_id,
        'status_reason', n.status_reason,
        'created_at', n.created_at,
        'updated_at', n.updated_at
      )
      order by n.updated_at desc, n.id
    ),
    '[]'::jsonb
  )
  into _notes
  from public.clinical_notes n
  where n.encounter_id = _e.id and n.deleted_at is null;

  return jsonb_build_object(
    'encounter', jsonb_build_object(
      'encounter_id', _e.id,
      'organization_id', _e.organization_id,
      'patient_id', _e.patient_id,
      'appointment_id', _e.appointment_id,
      'visit_type', _e.encounter_type,
      'status', _e.status,
      'started_at', _e.started_at,
      'ended_at', _e.ended_at,
      'status_reason', _e.status_reason,
      'created_at', _e.created_at
    ),
    'notes', _notes
  );
end;
$$;

create or replace function public.list_desktop_patient_encounters(
  _patient_id uuid,
  _limit integer default 100
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  if _limit is null or _limit < 1 or _limit > 200 then
    raise exception 'encounter limit must be between 1 and 200'
      using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'encounter_id', e.id,
        'organization_id', e.organization_id,
        'patient_id', e.patient_id,
        'appointment_id', e.appointment_id,
        'visit_type', e.encounter_type,
        'status', e.status,
        'started_at', e.started_at,
        'ended_at', e.ended_at,
        'status_reason', e.status_reason,
        'created_at', e.created_at
      )
      order by coalesce(e.started_at, e.created_at) desc, e.id
    ),
    '[]'::jsonb
  )
  into _rows
  from (
    select *
    from public.encounters
    where patient_id = _patient_id and deleted_at is null
    order by coalesce(started_at, created_at) desc, id
    limit _limit
  ) e;

  return _rows;
end;
$$;

create or replace function public.get_desktop_note(_note_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _n public.clinical_notes%rowtype;
  _v public.clinical_note_versions%rowtype;
  _signature jsonb;
  _addenda jsonb;
  _provenance jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _n
    from public.clinical_notes
    where id = _note_id and deleted_at is null;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
  if not private.can_access_patient(_n.patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;

  select * into _v
    from public.clinical_note_versions
    where note_id = _n.id and version = _n.current_version;

  select jsonb_build_object(
    'signature_id', s.id,
    'version', s.note_version,
    'signed_by', s.signed_by,
    'signed_at', s.signed_at,
    'attestation', s.attestation
  )
  into _signature
  from public.note_signatures s
  where s.note_id = _n.id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'addendum_id', a.id,
        'referenced_version', a.referenced_version,
        'author_user_id', a.author_user_id,
        'reason', a.reason,
        'content', a.content,
        'created_at', a.created_at
      )
      order by a.created_at, a.id
    ),
    '[]'::jsonb
  )
  into _addenda
  from public.note_addenda a
  where a.note_id = _n.id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'section_key', p.section_key,
        'ref_type', p.ref_type,
        'ref_id', p.ref_id,
        'label', p.label
      )
      order by p.created_at, p.id
    ),
    '[]'::jsonb
  )
  into _provenance
  from public.note_provenance_refs p
  where p.note_id = _n.id;

  return jsonb_build_object(
    'note', jsonb_build_object(
      'note_id', _n.id,
      'encounter_id', _n.encounter_id,
      'patient_id', _n.patient_id,
      'note_type', _n.note_type,
      'status', _n.status,
      'current_version', _n.current_version,
      'author_user_id', _n.author_user_id,
      'status_reason', _n.status_reason,
      'created_at', _n.created_at,
      'updated_at', _n.updated_at
    ),
    'content', coalesce(_v.content, '{}'::jsonb),
    'content_version', coalesce(_v.version, 0),
    'last_saved_at', _v.created_at,
    'signature', _signature,
    'addenda', _addenda,
    'provenance', _provenance
  );
end;
$$;

create or replace function public.get_desktop_patient_timeline(
  _patient_id uuid,
  _limit integer default 200
) returns table (
  event_at timestamptz,
  event_type text,
  title text,
  ref_type text,
  ref_id uuid,
  detail jsonb
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
  if _limit is null or _limit < 1 or _limit > 500 then
    raise exception 'timeline limit must be between 1 and 500'
      using errcode = '22023';
  end if;

  return query
  select events.event_at, events.event_type, events.title,
         events.ref_type, events.ref_id, events.detail
  from (
    select e.started_at as event_at, 'encounter.started'::text as event_type,
           'Encounter started (' || coalesce(e.encounter_type, 'visit') || ')' as title,
           'encounter'::text as ref_type, e.id as ref_id,
           jsonb_build_object('status', e.status) as detail
      from public.encounters e
      where e.patient_id = _patient_id
        and e.started_at is not null
        and e.deleted_at is null
    union all
    select e.ended_at, 'encounter.completed', 'Encounter completed',
           'encounter', e.id,
           jsonb_build_object('visit_type', coalesce(e.encounter_type, 'visit'))
      from public.encounters e
      where e.patient_id = _patient_id
        and e.status = 'completed'
        and e.ended_at is not null
        and e.deleted_at is null
    union all
    select n.created_at, 'note.draft_created',
           'Draft note created (' || n.note_type || ')',
           'clinical_note', n.id, jsonb_build_object('status', n.status)
      from public.clinical_notes n
      where n.patient_id = _patient_id and n.deleted_at is null
    union all
    select s.signed_at, 'note.signed', 'Note signed',
           'clinical_note', s.note_id,
           jsonb_build_object('version', s.note_version)
      from public.note_signatures s
      join public.clinical_notes n on n.id = s.note_id
      where n.patient_id = _patient_id and n.deleted_at is null
    union all
    select a.created_at, 'note.addendum', 'Addendum added',
           'clinical_note', a.note_id,
           jsonb_build_object('referenced_version', a.referenced_version)
      from public.note_addenda a
      join public.clinical_notes n on n.id = a.note_id
      where n.patient_id = _patient_id and n.deleted_at is null
    union all
    select n.updated_at, 'note.entered_in_error', 'Note entered in error',
           'clinical_note', n.id, '{}'::jsonb
      from public.clinical_notes n
      where n.patient_id = _patient_id
        and n.status = 'entered_in_error'
        and n.deleted_at is null
    union all
    select ap.starts_at, 'appointment',
           coalesce(ap.appointment_type, 'appointment'),
           'appointment', ap.id, jsonb_build_object('status', ap.status)
      from public.appointments ap
      where ap.patient_id = _patient_id and ap.deleted_at is null
  ) events
  order by events.event_at desc, events.ref_id
  limit _limit;
end;
$$;

revoke all on function public.get_desktop_encounter(uuid) from public, anon;
revoke all on function public.list_desktop_patient_encounters(uuid, integer) from public, anon;
revoke all on function public.get_desktop_note(uuid) from public, anon;
revoke all on function public.get_desktop_patient_timeline(uuid, integer) from public, anon;

grant execute on function public.get_desktop_encounter(uuid) to authenticated;
grant execute on function public.list_desktop_patient_encounters(uuid, integer) to authenticated;
grant execute on function public.get_desktop_note(uuid) to authenticated;
grant execute on function public.get_desktop_patient_timeline(uuid, integer) to authenticated;

commit;
