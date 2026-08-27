-- Bounded, read-only production patient overview. No rows are seeded.

create or replace function clinical_core.get_patient_overview(_organization_id uuid,_patient_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _patient clinical_core.patient_records%rowtype; _actor uuid; _care_team jsonb;
  _appointments jsonb; _encounters jsonb; _labs jsonb; _tasks jsonb; _missing jsonb;
  _anchor timestamptz; _changes jsonb;
begin
  _actor:=clinical_private.require_clinical_patient(_organization_id,_patient_id);
  select * into _patient from clinical_core.patient_records where id=_patient_id
    and organization_id=_organization_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='patient_not_found'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('userId',membership.person_id,
    'displayName',case when membership.person_id=_actor then 'You' else 'Practitioner' end,
    'role',membership.role,'relationship','care_team','isCaller',membership.person_id=_actor)
    order by (membership.person_id=_actor) desc,membership.created_at),'[]'::jsonb) into _care_team
    from (select * from clinical_core.organization_memberships where organization_id=_organization_id
      and status='active' and role in ('owner','admin','practitioner') order by created_at limit 10) membership;

  select coalesce(jsonb_agg(jsonb_build_object('id',appointment.id,'startsAt',appointment.starts_at,
    'endsAt',appointment.ends_at,'status',appointment.status,'appointmentType',appointment.appointment_type)
    order by appointment.starts_at desc),'[]'::jsonb) into _appointments
    from (select * from clinical_core.appointments where organization_id=_organization_id
      and patient_record_id=_patient_id and deleted_at is null order by starts_at desc limit 5) appointment;

  select coalesce(jsonb_agg(jsonb_build_object('id',encounter.id,
    'occurredAt',coalesce(encounter.started_at,encounter.created_at),'encounterType',encounter.visit_type,
    'noteStatus',coalesce(note.status,'none'),'signedAt',note.signed_at)
    order by coalesce(encounter.started_at,encounter.created_at) desc),'[]'::jsonb) into _encounters
    from (select * from clinical_core.encounters where organization_id=_organization_id
      and patient_record_id=_patient_id and deleted_at is null
      order by coalesce(started_at,created_at) desc limit 5) encounter
    left join lateral (select status,signed_at from clinical_core.clinical_notes
      where encounter_id=encounter.id and deleted_at is null order by created_at desc limit 1) note on true;

  select jsonb_build_object(
    'latestCollectedAt',(select max(observed_at) from clinical_core.lab_observations
      where organization_id=_organization_id and patient_record_id=_patient_id),
    'markerCount',(select count(*) from clinical_core.lab_observations
      where organization_id=_organization_id and patient_record_id=_patient_id),
    'awaitingReview',(select count(*) from clinical_core.lab_observations
      where organization_id=_organization_id and patient_record_id=_patient_id and review_status='unreviewed'),
    'abnormal',(select count(*) from clinical_core.lab_observations where organization_id=_organization_id
      and patient_record_id=_patient_id and ((reference_min is not null and value_numeric<reference_min)
        or (reference_max is not null and value_numeric>reference_max))),
    'recent',coalesce((select jsonb_agg(jsonb_build_object('id',observation.id,
      'markerName',observation.marker_name,'valueDisplay',observation.value_numeric::text||
        coalesce(' '||observation.unit,''),'status',case
          when observation.reference_min is not null and observation.value_numeric<observation.reference_min then 'low'
          when observation.reference_max is not null and observation.value_numeric>observation.reference_max then 'high'
          else 'unknown' end,'collectedAt',observation.observed_at,'reviewState',observation.review_status)
      order by observation.observed_at desc) from (select * from clinical_core.lab_observations
        where organization_id=_organization_id and patient_record_id=_patient_id
        order by observed_at desc,created_at desc limit 5) observation),'[]'::jsonb)) into _labs;

  select coalesce(jsonb_agg(jsonb_build_object('id',task.id,'title',task.title,
    'priority',task.priority,'itemType',task.item_type,'createdAt',task.created_at)
    order by case task.priority when 'high' then 0 when 'medium' then 1 else 2 end,task.created_at desc),
    '[]'::jsonb) into _tasks from (select * from clinical_core.review_queue_items
      where organization_id=_organization_id and patient_record_id=_patient_id and status='open'
        and deleted_at is null order by created_at desc limit 5) task;

  select jsonb_agg(gap) into _missing from (values
    ('No allergy list recorded'),('No medication list recorded'),('No problem list recorded')) required(gap);
  if not exists(select 1 from clinical_core.lab_observations where organization_id=_organization_id
    and patient_record_id=_patient_id) then _missing:=_missing||jsonb_build_array('No lab results on file'); end if;
  if _patient.date_of_birth is null then _missing:=_missing||jsonb_build_array('Date of birth not recorded'); end if;

  select max(coalesce(encounter.started_at,encounter.created_at)) into _anchor
    from clinical_core.encounters encounter join clinical_core.clinical_notes note
      on note.encounter_id=encounter.id and note.signed_at is not null
    where encounter.organization_id=_organization_id and encounter.patient_record_id=_patient_id
      and encounter.deleted_at is null and note.deleted_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('label',change.label,'kind',change.kind,
    'source',change.source) order by change.changed_at desc),'[]'::jsonb) into _changes from (
    select 'New lab result: '||observation.marker_name label,'lab'::text kind,observation.observed_at changed_at,
      jsonb_build_object('kind','lab_observation','id',observation.id,'at',observation.observed_at) source
      from clinical_core.lab_observations observation where observation.organization_id=_organization_id
        and observation.patient_record_id=_patient_id and (_anchor is null or observation.observed_at>_anchor)
    union all select 'Note '||note.status||': '||note.note_type,'note',note.updated_at,
      jsonb_build_object('kind','note','id',note.id,'at',note.updated_at)
      from clinical_core.clinical_notes note where note.organization_id=_organization_id
        and note.patient_record_id=_patient_id and note.deleted_at is null
        and (_anchor is null or note.updated_at>_anchor)
    union all select 'Appointment '||appointment.status||': '||appointment.appointment_type,
      'appointment',appointment.updated_at,jsonb_build_object('kind','appointment','id',appointment.id,
        'at',appointment.updated_at) from clinical_core.appointments appointment
      where appointment.organization_id=_organization_id and appointment.patient_record_id=_patient_id
        and appointment.deleted_at is null and (_anchor is null or appointment.updated_at>_anchor)
    union all select 'Review task opened','task',task.created_at,
      jsonb_build_object('kind','review_queue_item','id',task.id,'at',task.created_at)
      from clinical_core.review_queue_items task where task.organization_id=_organization_id
        and task.patient_record_id=_patient_id and task.deleted_at is null
        and (_anchor is null or task.created_at>_anchor)
    order by changed_at desc limit 10) change;

  return jsonb_build_object('patientId',_patient.id,'demographics',jsonb_build_object(
    'fullName',btrim(_patient.first_name||' '||_patient.last_name),'dateOfBirth',_patient.date_of_birth,
    'sex',_patient.sex,'hasEmail',_patient.email is not null,'hasPhone',_patient.phone is not null),
    'careTeam',_care_team,'allergies','[]'::jsonb,'medications','[]'::jsonb,'conditions','[]'::jsonb,
    'recentAppointments',_appointments,'recentEncounters',_encounters,'labs',_labs,'openTasks',_tasks,
    'carePlan',null,'wearableSources','[]'::jsonb,'missingInformation',coalesce(_missing,'[]'::jsonb),
    'changesSinceLastVisit',jsonb_build_object('anchorEncounterAt',_anchor,'items',_changes),
    'generatedAt',clock_timestamp());
end $$;

revoke all on function clinical_core.get_patient_overview(uuid,uuid) from public;
grant execute on function clinical_core.get_patient_overview(uuid,uuid) to clinical_core_api;
