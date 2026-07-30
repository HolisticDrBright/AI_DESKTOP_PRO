-- desktop_owned_patient_overview
--
-- Phase 1 vertical slice, read side: ONE bounded, authenticated aggregate for
-- the patient overview — demographics, care team, allergies, medications,
-- conditions, recent appointments/encounters/notes, latest labs + review
-- state, open review tasks, missing-information indicators, and the
-- "what changed since the last visit" brief anchored to the previous signed
-- encounter.
--
-- Contract (matches every prior desktop-owned function):
--   * SECURITY DEFINER + search_path pinned to '' — every reference schema-
--     qualified; definer rights only to keep RLS recursion out of the gate
--     helpers, with access enforced EXPLICITLY below.
--   * auth.uid() required; active org membership required;
--     private.can_access_patient(_patient_id) required.
--   * Every list bounded (limit 5–10). The DTO has no field an invented value
--     could fill: absent = the UI's "Not enough verified data".
--   * Contact details are reduced to presence booleans — the overview never
--     carries email/phone values.
--   * Read-only: no writes, so no audit row (access_events remain the
--     read-audit layer; nothing here bypasses it).
--   * anon/public execution revoked.

begin;

create or replace function public.get_patient_overview(
  _organization_id uuid,
  _patient_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _demographics jsonb;
  _care_team jsonb;
  _allergies jsonb;
  _medications jsonb;
  _conditions jsonb;
  _appointments jsonb;
  _encounters jsonb;
  _labs jsonb;
  _tasks jsonb;
  _missing jsonb;
  _anchor timestamptz;
  _changes jsonb;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not an active member of this organization' using errcode = '42501';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;

  -- Demographics: identity + presence flags only.
  select jsonb_build_object(
    'fullName', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
    'dateOfBirth', p.date_of_birth,
    'sex', p.sex,
    'hasEmail', (p.email is not null and p.email <> ''),
    'hasPhone', (p.phone is not null and p.phone <> '')
  )
  into _demographics
  from public.patient_profiles p
  where p.id = _patient_id
    and p.organization_id = _organization_id
    and p.deleted_at is null;

  if _demographics is null then
    raise exception 'patient not found in this organization' using errcode = 'P0002';
  end if;

  -- Care team: active practitioner relationships (bounded 10).
  select coalesce(jsonb_agg(row_json), '[]'::jsonb) into _care_team from (
    select jsonb_build_object(
      'userId', r.practitioner_user_id,
      'displayName', coalesce(nullif(trim(coalesce(pr.display_name,'')), ''), 'Practitioner'),
      'role', coalesce(pr.credentials, pr.specialty, 'Practitioner'),
      'relationship', coalesce(r.relationship_type, 'care_team'),
      'isCaller', (r.practitioner_user_id = _uid)
    ) as row_json
    from public.practitioner_patient_relationships r
    left join public.practitioner_profiles pr
      on pr.user_id = r.practitioner_user_id
     and pr.organization_id = _organization_id
    where r.patient_id = _patient_id
      and r.organization_id = _organization_id
      and r.status = 'active'
      and r.deleted_at is null
    order by (r.practitioner_user_id = _uid) desc, r.created_at
    limit 10
  ) rows;

  -- Allergies (active first, bounded 10).
  select coalesce(jsonb_agg(row_json), '[]'::jsonb) into _allergies from (
    select jsonb_build_object(
      'id', a.id, 'allergen', a.allergen, 'reaction', a.reaction,
      'severity', a.severity, 'status', a.status, 'recordedAt', a.created_at
    ) as row_json
    from public.allergies a
    where a.patient_id = _patient_id
      and a.organization_id = _organization_id
      and a.deleted_at is null
    order by (a.status = 'active') desc,
             case a.severity
               when 'life_threatening' then 0 when 'severe' then 1
               when 'moderate' then 2 else 3 end,
             a.created_at desc
    limit 10
  ) rows;

  -- Medications (active first, bounded 10).
  select coalesce(jsonb_agg(row_json), '[]'::jsonb) into _medications from (
    select jsonb_build_object(
      'id', m.id, 'name', m.name, 'dose', m.dose, 'route', m.route,
      'frequency', m.frequency, 'status', m.status, 'startDate', m.start_date
    ) as row_json
    from public.medications m
    where m.patient_id = _patient_id
      and m.organization_id = _organization_id
      and m.deleted_at is null
    order by (m.status = 'active') desc, m.created_at desc
    limit 10
  ) rows;

  -- Conditions / problem list (active + suspected first, bounded 10).
  select coalesce(jsonb_agg(row_json), '[]'::jsonb) into _conditions from (
    select jsonb_build_object(
      'id', c.id, 'name', c.name, 'icd10', c.icd10,
      'status', c.status, 'onsetDate', c.onset_date
    ) as row_json
    from public.conditions c
    where c.patient_id = _patient_id
      and c.organization_id = _organization_id
      and c.deleted_at is null
    order by (c.status in ('active','suspected')) desc, c.created_at desc
    limit 10
  ) rows;

  -- Recent + upcoming appointments (bounded 5).
  select coalesce(jsonb_agg(row_json), '[]'::jsonb) into _appointments from (
    select jsonb_build_object(
      'id', ap.id, 'startsAt', ap.starts_at, 'endsAt', ap.ends_at,
      'status', ap.status, 'appointmentType', coalesce(ap.appointment_type, 'visit')
    ) as row_json
    from public.appointments ap
    where ap.patient_id = _patient_id
      and ap.organization_id = _organization_id
      and ap.deleted_at is null
      and ap.starts_at is not null
    order by ap.starts_at desc
    limit 5
  ) rows;

  -- Recent encounters with their primary note's lifecycle (bounded 5).
  select coalesce(jsonb_agg(row_json), '[]'::jsonb) into _encounters from (
    select jsonb_build_object(
      'id', e.id,
      'occurredAt', coalesce(e.started_at, e.scheduled_at, e.created_at),
      'encounterType', coalesce(e.encounter_type, 'visit'),
      'noteStatus', coalesce(n.status, 'none'),
      'signedAt', n.signed_at
    ) as row_json
    from public.encounters e
    left join lateral (
      select cn.status, cn.signed_at
      from public.clinical_notes cn
      where cn.encounter_id = e.id and cn.deleted_at is null
      order by cn.created_at desc
      limit 1
    ) n on true
    where e.patient_id = _patient_id
      and e.organization_id = _organization_id
      and e.deleted_at is null
    order by coalesce(e.started_at, e.scheduled_at, e.created_at) desc
    limit 5
  ) rows;

  -- Latest labs: summary counts + the 5 most recent observations.
  select jsonb_build_object(
    'latestCollectedAt', (
      select max(o.observed_at) from public.biomarker_observations o
      where o.patient_id = _patient_id and o.organization_id = _organization_id
        and o.deleted_at is null),
    'markerCount', (
      select count(*) from public.biomarker_observations o
      where o.patient_id = _patient_id and o.organization_id = _organization_id
        and o.deleted_at is null),
    'awaitingReview', (
      select count(*) from public.biomarker_observations o
      where o.patient_id = _patient_id and o.organization_id = _organization_id
        and o.deleted_at is null and o.review_status = 'unreviewed'),
    'abnormal', (
      select count(*) from public.biomarker_observations o
      where o.patient_id = _patient_id and o.organization_id = _organization_id
        and o.deleted_at is null and o.status is not null
        and o.status not in ('normal','optimal')),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', obs.id, 'markerName', obs.marker_name,
        'valueDisplay', obs.value_display, 'status', obs.status,
        'collectedAt', obs.observed_at, 'reviewState', obs.review_status))
      from (
        select o.id,
               coalesce(d.canonical_name, 'Marker') as marker_name,
               coalesce(o.value_numeric::text, o.value_text, '—')
                 || coalesce(' ' || o.unit, '') as value_display,
               coalesce(o.status, 'unknown') as status,
               o.observed_at, o.review_status
        from public.biomarker_observations o
        left join public.biomarker_definitions d on d.id = o.biomarker_definition_id
        where o.patient_id = _patient_id and o.organization_id = _organization_id
          and o.deleted_at is null
        order by o.observed_at desc nulls last, o.ingested_at desc
        limit 5
      ) obs), '[]'::jsonb)
  ) into _labs;

  -- Open review-queue items for this patient (bounded 5).
  select coalesce(jsonb_agg(row_json), '[]'::jsonb) into _tasks from (
    select jsonb_build_object(
      'id', q.id, 'title', q.title, 'priority', q.priority,
      'itemType', q.item_type, 'createdAt', q.created_at
    ) as row_json
    from public.review_queue_items q
    where q.patient_id = _patient_id
      and q.organization_id = _organization_id
      and q.status = 'open'
      and q.deleted_at is null
    order by case q.priority when 'high' then 0 when 'medium' then 1 else 2 end,
             q.created_at desc
    limit 5
  ) rows;

  -- Missing-information indicators: named gaps, never guessed values.
  select coalesce(jsonb_agg(gap), '[]'::jsonb) into _missing from (
    select 'No allergy list recorded' as gap
    where not exists (
      select 1 from public.allergies a
      where a.patient_id = _patient_id and a.organization_id = _organization_id
        and a.deleted_at is null)
    union all
    select 'No medication list recorded'
    where not exists (
      select 1 from public.medications m
      where m.patient_id = _patient_id and m.organization_id = _organization_id
        and m.deleted_at is null)
    union all
    select 'No problem list recorded'
    where not exists (
      select 1 from public.conditions c
      where c.patient_id = _patient_id and c.organization_id = _organization_id
        and c.deleted_at is null)
    union all
    select 'No lab results on file'
    where not exists (
      select 1 from public.biomarker_observations o
      where o.patient_id = _patient_id and o.organization_id = _organization_id
        and o.deleted_at is null)
    union all
    select 'Date of birth not recorded'
    where exists (
      select 1 from public.patient_profiles p
      where p.id = _patient_id and p.organization_id = _organization_id
        and p.deleted_at is null and p.date_of_birth is null)
  ) gaps;

  -- "What changed since the last visit": anchored to the most recent SIGNED
  -- encounter before now; every item carries its source record + timestamp.
  select max(coalesce(e.started_at, e.scheduled_at, e.created_at)) into _anchor
  from public.encounters e
  where e.patient_id = _patient_id
    and e.organization_id = _organization_id
    and e.deleted_at is null
    and e.signed_at is not null;

  select coalesce(jsonb_agg(
           jsonb_build_object('label', bounded.label, 'kind', bounded.kind, 'source', bounded.src)
           order by bounded.occurred_at desc), '[]'::jsonb)
  into _changes
  from (
    select ranked.label, ranked.kind, ranked.occurred_at, ranked.src
    from (
    (select
       'New lab result: ' || coalesce(d.canonical_name, 'marker')
         || ' (' || coalesce(o.value_numeric::text, o.value_text, '—')
         || coalesce(' ' || o.unit, '') || ')' as label,
       'lab'::text as kind, o.observed_at as at,
       jsonb_build_object('kind','lab_observation','id',o.id,'at',o.observed_at) as src
     from public.biomarker_observations o
     left join public.biomarker_definitions d on d.id = o.biomarker_definition_id
     where o.patient_id = _patient_id and o.organization_id = _organization_id
       and o.deleted_at is null
       and (_anchor is null or o.observed_at > _anchor)
     order by o.observed_at desc limit 5)
    union all
    (select 'Note ' || cn.status || coalesce(': ' || nullif(cn.note_type,''), '') as label,
       'note', coalesce(cn.signed_at, cn.updated_at),
       jsonb_build_object('kind','note','id',cn.id,'at',coalesce(cn.signed_at, cn.updated_at))
     from public.clinical_notes cn
     where cn.patient_id = _patient_id and cn.organization_id = _organization_id
       and cn.deleted_at is null
       and (_anchor is null or coalesce(cn.signed_at, cn.updated_at) > _anchor)
     order by coalesce(cn.signed_at, cn.updated_at) desc limit 5)
    union all
    (select 'Appointment ' || ap.status || coalesce(': ' || nullif(ap.appointment_type,''), ''),
       'appointment', greatest(ap.updated_at, ap.created_at),
       jsonb_build_object('kind','appointment','id',ap.id,'at',greatest(ap.updated_at, ap.created_at))
     from public.appointments ap
     where ap.patient_id = _patient_id and ap.organization_id = _organization_id
       and ap.deleted_at is null
       and (_anchor is null or greatest(ap.updated_at, ap.created_at) > _anchor)
     order by greatest(ap.updated_at, ap.created_at) desc limit 5)
    union all
    (select 'Medication ' || m.status || ': ' || m.name,
       'medication', greatest(m.updated_at, m.created_at),
       jsonb_build_object('kind','medication','id',m.id,'at',greatest(m.updated_at, m.created_at))
     from public.medications m
     where m.patient_id = _patient_id and m.organization_id = _organization_id
       and m.deleted_at is null
       and (_anchor is null or greatest(m.updated_at, m.created_at) > _anchor)
     order by greatest(m.updated_at, m.created_at) desc limit 5)
    union all
    (select 'Review task opened: ' || q.title,
       'task', q.created_at,
       jsonb_build_object('kind','queue_item','id',q.id,'at',q.created_at)
     from public.review_queue_items q
     where q.patient_id = _patient_id and q.organization_id = _organization_id
       and q.deleted_at is null
       and (_anchor is null or q.created_at > _anchor)
     order by q.created_at desc limit 5)
    ) ranked(label, kind, occurred_at, src)
    order by ranked.occurred_at desc
    limit 15
  ) bounded;

  return jsonb_build_object(
    'patientId', _patient_id,
    'demographics', _demographics,
    'careTeam', _care_team,
    'allergies', _allergies,
    'medications', _medications,
    'conditions', _conditions,
    'recentAppointments', _appointments,
    'recentEncounters', _encounters,
    'labs', _labs,
    'openTasks', _tasks,
    'carePlan', null,
    'wearableSources', '[]'::jsonb,
    'missingInformation', _missing,
    'changesSinceLastVisit', jsonb_build_object(
      'anchorEncounterAt', _anchor,
      'items', _changes
    ),
    'generatedAt', now()
  );
end;
$$;

comment on function public.get_patient_overview(uuid, uuid) is
  'Bounded patient-overview aggregate for the clinical desktop. Verified data only: absent fields mean "Not enough verified data" in the UI — the DTO has no place for an invented value. carePlan and wearableSources are structurally empty until those domains have governed live sources.';

revoke all on function public.get_patient_overview(uuid, uuid) from public, anon;
grant execute on function public.get_patient_overview(uuid, uuid) to authenticated, service_role;

commit;
