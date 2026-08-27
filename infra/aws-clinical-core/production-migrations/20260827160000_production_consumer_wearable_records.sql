-- Patient-supplied wearable records for the PHI-disabled production candidate.
-- Records remain separate from practitioner-authored chart data and create a
-- clinician review task. This migration creates no rows and enables no route.

create unique index review_queue_patient_app_wearable_version_uniq
  on clinical_core.review_queue_items(reference_id)
  where item_type = 'assessment'
    and title = 'Patient app wearable update'
    and reference_id is not null;

create or replace function clinical_private.queue_patient_app_wearable_review()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.collection = 'wearable_daily_records' and not new.deleted then
    insert into clinical_core.review_queue_items(
      organization_id, patient_record_id, item_type, reference_id, title,
      priority, created_by_person_id, updated_by_person_id
    ) values (
      new.organization_id, new.patient_record_id, 'assessment', new.id,
      'Patient app wearable update', 'medium',
      new.consumer_person_id, new.consumer_person_id
    ) on conflict (reference_id) where item_type = 'assessment'
      and title = 'Patient app wearable update' and reference_id is not null
      do nothing;
  end if;
  return new;
end
$$;

create trigger consumer_wearable_review_task
  after insert on clinical_core.consumer_clinical_record_versions
  for each row execute function clinical_private.queue_patient_app_wearable_review();

create or replace function clinical_core.get_patient_app_intake(
  _organization_id uuid, _patient_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _profile jsonb;
  _lifestyle jsonb;
  _contraindications jsonb;
  _intake jsonb;
  _responses jsonb;
  _wearables jsonb;
  _consent text;
  _wearables_consent text;
begin
  perform clinical_private.require_clinical_patient(_organization_id, _patient_id);
  select * into _connection from clinical_core.patient_connections c
    where c.organization_id = _organization_id and c.patient_record_id = _patient_id
      and c.state in ('verified','paused','revoked')
    order by c.updated_at desc, c.id desc limit 1;
  if not found then
    return jsonb_build_object(
      'patientId', _patient_id, 'connectionState', 'not_connected',
      'sharingStatus', 'not_granted', 'wearablesSharingStatus', 'not_granted',
      'wellnessProfile', null, 'lifestyleProfile', null,
      'contraindications', null, 'clinicalIntake', null,
      'questionnaireResponses', '[]'::jsonb, 'wearableDailyRecords', '[]'::jsonb,
      'generatedAt', clock_timestamp());
  end if;

  select coalesce((select status from clinical_core.current_consent
    where connection_id = _connection.id and scope = 'forms_checkins'), 'not_granted')
    into _consent;
  select coalesce((select status from clinical_core.current_consent
    where connection_id = _connection.id and scope = 'wearables'), 'not_granted')
    into _wearables_consent;

  select jsonb_build_object('payload', r.payload, 'receivedAt', r.received_at,
    'resourceVersion', r.resource_version, 'recordId', r.id)
    into _profile from clinical_core.consumer_clinical_record_versions r
    where r.connection_id = _connection.id and r.collection = 'wellness_profiles'
      and not r.deleted order by r.received_at desc, r.id desc limit 1;
  select jsonb_build_object('payload', r.payload, 'receivedAt', r.received_at,
    'resourceVersion', r.resource_version, 'recordId', r.id)
    into _lifestyle from clinical_core.consumer_clinical_record_versions r
    where r.connection_id = _connection.id and r.collection = 'lifestyle_profiles'
      and not r.deleted order by r.received_at desc, r.id desc limit 1;
  select jsonb_build_object('payload', r.payload, 'receivedAt', r.received_at,
    'resourceVersion', r.resource_version, 'recordId', r.id)
    into _contraindications from clinical_core.consumer_clinical_record_versions r
    where r.connection_id = _connection.id and r.collection = 'contraindications'
      and not r.deleted order by r.received_at desc, r.id desc limit 1;
  select jsonb_build_object('payload', r.payload, 'receivedAt', r.received_at,
    'resourceVersion', r.resource_version, 'recordId', r.id)
    into _intake from clinical_core.consumer_clinical_record_versions r
    where r.connection_id = _connection.id and r.collection = 'clinical_intakes'
      and not r.deleted order by r.received_at desc, r.id desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'payload', current.payload, 'receivedAt', current.received_at,
    'resourceVersion', current.resource_version, 'recordId', current.id)
    order by current.record_key), '[]'::jsonb) into _responses
  from (select distinct on (r.record_key) r.*
    from clinical_core.consumer_clinical_record_versions r
    where r.connection_id = _connection.id and r.collection = 'questionnaire_responses'
    order by r.record_key, r.received_at desc, r.id desc) current
  where not current.deleted;

  select coalesce(jsonb_agg(jsonb_build_object(
    'payload', current.payload, 'receivedAt', current.received_at,
    'resourceVersion', current.resource_version, 'recordId', current.id)
    order by current.payload->>'date' desc), '[]'::jsonb) into _wearables
  from (select latest.* from (select distinct on (r.record_key) r.*
      from clinical_core.consumer_clinical_record_versions r
      where r.connection_id = _connection.id and r.collection = 'wearable_daily_records'
      order by r.record_key, r.received_at desc, r.id desc) latest
    where not latest.deleted
    order by latest.payload->>'date' desc
    limit 30) current;

  return jsonb_build_object(
    'patientId', _patient_id, 'connectionState', _connection.state,
    'sharingStatus', _consent, 'wearablesSharingStatus', _wearables_consent,
    'wellnessProfile', _profile, 'lifestyleProfile', _lifestyle,
    'contraindications', _contraindications, 'clinicalIntake', _intake,
    'questionnaireResponses', _responses, 'wearableDailyRecords', _wearables,
    'generatedAt', clock_timestamp());
end
$$;

revoke all on function clinical_private.queue_patient_app_wearable_review() from public;
revoke all on function clinical_core.get_patient_app_intake(uuid,uuid) from public;
grant execute on function clinical_core.get_patient_app_intake(uuid,uuid) to clinical_core_api;
