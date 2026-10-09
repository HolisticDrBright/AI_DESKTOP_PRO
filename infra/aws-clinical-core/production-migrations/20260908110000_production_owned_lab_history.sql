-- Source-only extension. No grants of consent or PHI activation are seeded.
alter table clinical_private.consumer_storage_consent_releases drop constraint consumer_storage_consent_releases_scope_check;
alter table clinical_private.consumer_storage_consent_releases add constraint consumer_storage_consent_releases_scope_check
  check(scope in ('forms_checkins','symptoms_adherence','nutrition','protocols_supplements','wearables','reproductive_health','ai_context','lab_history'));
alter table clinical_core.owned_consumer_record_versions drop constraint owned_consumer_record_versions_collection_check;
alter table clinical_core.owned_consumer_record_versions add constraint owned_consumer_record_versions_collection_check check(collection in (
  'protocols','daily_adherence','symptom_logs','hormone_entries','meal_logs','subjective_rollups','weekly_checkins',
  'wellness_profiles','lifestyle_profiles','contraindications','questionnaire_responses','clinical_intakes',
  'wearable_daily_records','reproductive_profiles','adverse_event_reports','lab_observations'));

-- Legacy clinic collections remain unchanged. Only the personal table accepts
-- lab_observations, and only its dedicated lab_history consent authorizes reads.
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
    when 'wearable_daily_records' then 'wearables' when 'lab_observations' then 'lab_history' else null end
$$;

create or replace function clinical_core.get_owned_storage_consent_state(_scope text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _release jsonb; _current jsonb; _history jsonb;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management'
    or _scope is null or _scope not in ('forms_checkins','symptoms_adherence','nutrition','protocols_supplements','wearables','reproductive_health','ai_context','lab_history') then
    raise exception using errcode='22023',message='consent_request_invalid';
  end if;
  select jsonb_build_object('version',version,'content',content,'contentSha256',content_sha256,'approvedAt',approved_at)
    into _release from clinical_private.consumer_storage_consent_releases
    where scope=_scope and retired_at is null and approved_at<=clock_timestamp()
    order by approved_at desc,version desc limit 1;
  select jsonb_build_object('revision',revision,'status',status,'releaseVersion',release_version,'recordedAt',recorded_at)
    into _current from clinical_core.consumer_storage_consents where owner_id=_actor and scope=_scope
    order by revision desc limit 1;
  select coalesce(jsonb_agg(to_jsonb(c) order by c.revision desc),'[]'::jsonb) into _history
    from (select revision,status,release_version as "releaseVersion",recorded_at as "recordedAt"
      from clinical_core.consumer_storage_consents where owner_id=_actor and scope=_scope order by revision desc limit 100) c;
  return jsonb_build_object('scope',_scope,'release',_release,'current',_current,'history',_history,
    'historyLimit',100,'activeRevision',clinical_private.owned_consumer_consent(_actor,_scope));
end $$;
