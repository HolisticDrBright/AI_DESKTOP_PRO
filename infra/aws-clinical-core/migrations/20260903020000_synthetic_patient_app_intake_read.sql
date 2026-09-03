-- Practitioner read model for consent-governed V2 records in synthetic staging.
-- This creates no records, accepts no direct identifiers, and cannot enable PHI.

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
  _lab_imports jsonb;
  _consent text;
  _wearables_consent text;
begin
  perform clinical_private.assert_synthetic_context(_organization_id, 'clinical_data', 'workforce');
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  if not exists (select 1 from clinical_core.patient_records p
    where p.id = _patient_id and p.organization_id = _organization_id
      and p.status = 'active' and p.data_classification = 'synthetic_only'
      and p.contains_phi = false) then
    raise exception using errcode = '42501', message = 'patient_access_refused';
  end if;

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
      'labImports', '[]'::jsonb, 'generatedAt', clock_timestamp());
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
    order by latest.payload->>'date' desc limit 30) current;

  select coalesce(jsonb_agg(jsonb_build_object(
    'eventId', e.id, 'panelName', e.panel_name, 'markerName', e.marker_name,
    'value', e.value_numeric, 'unit', e.unit, 'sourceStatus', e.source_status,
    'collectedAt', e.collected_at, 'state', e.state, 'receivedAt', e.received_at)
    order by e.collected_at desc, e.marker_name), '[]'::jsonb) into _lab_imports
  from clinical_core.lab_import_events e
  where e.connection_id = _connection.id;

  return jsonb_build_object(
    'patientId', _patient_id, 'connectionState', _connection.state,
    'sharingStatus', _consent, 'wearablesSharingStatus', _wearables_consent,
    'wellnessProfile', _profile, 'lifestyleProfile', _lifestyle,
    'contraindications', _contraindications, 'clinicalIntake', _intake,
    'questionnaireResponses', _responses, 'wearableDailyRecords', _wearables,
    'labImports', _lab_imports, 'generatedAt', clock_timestamp());
end
$$;

revoke all on function clinical_core.get_patient_app_intake(uuid,uuid) from public;
grant execute on function clinical_core.get_patient_app_intake(uuid,uuid) to clinical_core_api;
