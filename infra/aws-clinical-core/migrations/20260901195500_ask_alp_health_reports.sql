-- Synthetic Ask ALP symptom/adverse-event intake. Still synthetic-only.
alter table clinical_core.consumer_clinical_record_versions
  drop constraint consumer_clinical_record_versions_collection_check;
alter table clinical_core.consumer_clinical_record_versions
  add constraint consumer_clinical_record_versions_collection_check check (collection in (
    'protocols','daily_adherence','symptom_logs','hormone_entries','meal_logs',
    'subjective_rollups','weekly_checkins','wellness_profiles','lifestyle_profiles',
    'contraindications','questionnaire_responses','clinical_intakes',
    'wearable_daily_records','reproductive_profiles','adverse_event_reports'));

create or replace function clinical_private.consumer_collection_scope(_collection text)
returns text language sql immutable set search_path='' as $$
  select case _collection when 'protocols' then 'protocols_supplements'
    when 'daily_adherence' then 'symptoms_adherence' when 'symptom_logs' then 'symptoms_adherence'
    when 'adverse_event_reports' then 'symptoms_adherence'
    when 'hormone_entries' then 'reproductive_health' when 'reproductive_profiles' then 'reproductive_health'
    when 'meal_logs' then 'nutrition' when 'subjective_rollups' then 'symptoms_adherence'
    when 'weekly_checkins' then 'forms_checkins' when 'wellness_profiles' then 'forms_checkins'
    when 'lifestyle_profiles' then 'forms_checkins' when 'contraindications' then 'forms_checkins'
    when 'questionnaire_responses' then 'forms_checkins' when 'clinical_intakes' then 'forms_checkins'
    when 'wearable_daily_records' then 'wearables' else null end
$$;

alter function clinical_core.get_patient_chat_context() rename to get_patient_chat_context_before_health_reports;

create or replace function clinical_core.get_patient_chat_context()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _base jsonb; _connection_id uuid; _reports jsonb:='[]'::jsonb;
begin
  _base:=clinical_core.get_patient_chat_context_before_health_reports();
  select connection.id into _connection_id from clinical_core.patient_connections connection
    where connection.organization_id=clinical_private.organization_id()
      and connection.consumer_person_id=clinical_private.actor_person_id()
      and connection.state in ('verified','paused')
    order by connection.verified_at desc limit 1;
  if _connection_id is not null and exists(
    select 1 from clinical_core.current_consent consent
    where consent.connection_id=_connection_id and consent.scope='symptoms_adherence' and consent.status='granted'
  ) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'eventType',report.payload->>'event_type','symptom',report.payload->>'symptom',
      'severity',(report.payload->>'severity')::integer,'onsetAt',report.payload->>'onset_at',
      'suspectedProductName',nullif(report.payload->>'suspected_product_name',''),
      'actionsTaken',coalesce(report.payload->'actions_taken','[]'::jsonb),
      'notes',nullif(report.payload->>'notes',''),
      'urgentSafetyAnswer',coalesce((report.payload->'safety_answers'->>'breathingDifficulty')::boolean,false)
        or coalesce((report.payload->'safety_answers'->>'faceOrThroatSwelling')::boolean,false)
        or coalesce((report.payload->'safety_answers'->>'chestPain')::boolean,false)
        or coalesce((report.payload->'safety_answers'->>'faintingOrSeizure')::boolean,false)
        or coalesce((report.payload->'safety_answers'->>'uncontrolledBleeding')::boolean,false)
        or coalesce((report.payload->'safety_answers'->>'immediateDanger')::boolean,false)
    ) order by report.received_at desc),'[]'::jsonb) into _reports
    from (select payload,received_at from clinical_core.consumer_clinical_record_versions
      where connection_id=_connection_id and collection='adverse_event_reports' and not deleted
      order by received_at desc,id desc limit 20) report;
  end if;
  return _base || jsonb_build_object(
    'careTeam',jsonb_build_object('label','your care team'),
    'recentReports',_reports,
    'governedOptions','[]'::jsonb
  );
end $$;
revoke all on function clinical_core.get_patient_chat_context() from public;
grant execute on function clinical_core.get_patient_chat_context() to clinical_core_api;
