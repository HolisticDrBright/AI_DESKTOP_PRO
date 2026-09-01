-- Consent-filtered, bounded Ask ALP context assembled inside AWS.
-- The LLM never receives a database connection and this function performs no writes.

alter table clinical_core.consumer_clinical_record_versions
  drop constraint consumer_clinical_record_versions_collection_check;
alter table clinical_core.consumer_clinical_record_versions
  add constraint consumer_clinical_record_versions_collection_check check (collection in (
    'protocols','daily_adherence','symptom_logs','hormone_entries','meal_logs',
    'subjective_rollups','weekly_checkins','wellness_profiles','lifestyle_profiles',
    'contraindications','questionnaire_responses','clinical_intakes',
    'wearable_daily_records','reproductive_profiles'));

create or replace function clinical_private.consumer_collection_scope(_collection text)
returns text language sql immutable set search_path='' as $$
  select case _collection
    when 'protocols' then 'protocols_supplements'
    when 'daily_adherence' then 'symptoms_adherence'
    when 'symptom_logs' then 'symptoms_adherence'
    when 'hormone_entries' then 'reproductive_health'
    when 'reproductive_profiles' then 'reproductive_health'
    when 'meal_logs' then 'nutrition'
    when 'subjective_rollups' then 'symptoms_adherence'
    when 'weekly_checkins' then 'forms_checkins'
    when 'wellness_profiles' then 'forms_checkins'
    when 'lifestyle_profiles' then 'forms_checkins'
    when 'contraindications' then 'forms_checkins'
    when 'questionnaire_responses' then 'forms_checkins'
    when 'clinical_intakes' then 'forms_checkins'
    when 'wearable_daily_records' then 'wearables'
    else null end
$$;

create or replace function clinical_core.get_patient_chat_context()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _connection clinical_core.patient_connections%rowtype;
  _patient clinical_core.patient_records%rowtype; _profile jsonb; _lifestyle jsonb; _contra jsonb;
  _reproductive jsonb; _latest_wearable jsonb; _wearable jsonb:=null; _labs jsonb:='[]'::jsonb;
  _protocol jsonb:=null; _tcm jsonb:=null; _stage text; _cycle_day integer; _cycle_phase text:='unknown';
  _wearable_count integer; _avg_hrv numeric; _avg_rhr numeric; _avg_sleep numeric;
begin
  if clinical_private.claim('identity_pool')<>'consumer'
    or clinical_private.claim('purpose')<>'clinical_data' then
    raise exception using errcode='42501',message='consumer_clinical_context_required';
  end if;
  select * into _connection from clinical_core.patient_connections connection
    where connection.consumer_person_id=_actor and connection.state='verified';
  if not found then raise exception using errcode='P0002',message='verified_connection_required'; end if;
  select * into _patient from clinical_core.patient_records
    where id=_connection.patient_record_id and organization_id=_connection.organization_id
      and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='patient_not_found'; end if;

  select payload into _profile from clinical_core.consumer_clinical_record_versions
    where connection_id=_connection.id and collection='wellness_profiles' and not deleted
    order by received_at desc,id desc limit 1;
  select payload into _lifestyle from clinical_core.consumer_clinical_record_versions
    where connection_id=_connection.id and collection='lifestyle_profiles' and not deleted
    order by received_at desc,id desc limit 1;
  select payload into _contra from clinical_core.consumer_clinical_record_versions
    where connection_id=_connection.id and collection='contraindications' and not deleted
    order by received_at desc,id desc limit 1;

  if _profile is not null or _lifestyle is not null or _contra is not null then
    _profile:=jsonb_build_object(
      'ageYears',case when _patient.date_of_birth is null then null
        else date_part('year',age(current_date,_patient.date_of_birth))::integer end,
      'sex',nullif(_patient.sex,'unknown'),
      'goals',case when jsonb_typeof(_profile->'goals')='array' then _profile->'goals' else '[]'::jsonb end,
      'contraindications',case when jsonb_typeof(_contra->'conditions')='array' then _contra->'conditions' else '[]'::jsonb end,
      'allergies',case when jsonb_typeof(_contra->'allergies')='array' then _contra->'allergies' else '[]'::jsonb end,
      'dietOfRecord',nullif(_lifestyle->>'dietType',''),
      'cookingSkill',nullif(_lifestyle->>'cookingSkill',''));
  end if;

  if exists(select 1 from clinical_core.current_consent consent
    where consent.connection_id=_connection.id and consent.scope='reproductive_health'
      and consent.status='granted') then
    select payload into _reproductive from clinical_core.consumer_clinical_record_versions
      where connection_id=_connection.id and collection='reproductive_profiles' and not deleted
      order by received_at desc,id desc limit 1;
    _stage:=_reproductive->>'stage';
    if _stage in ('regular_cycle','hormonal_contraception','irregular_cycle','perimenopause',
      'pregnant','postpartum','menopause') and _reproductive->'consent'->>'status'='granted' then
      _cycle_day:=case when (_reproductive->>'cycleDay')~'^[0-9]{1,2}$'
        then (_reproductive->>'cycleDay')::integer else null end;
      if _stage='regular_cycle' and _cycle_day between 1 and 60 then
        _cycle_phase:=case when _cycle_day<=5 then 'menstrual' when _cycle_day<=12 then 'follicular'
          when _cycle_day<=15 then 'ovulatory' else 'luteal' end;
      end if;
      _reproductive:=jsonb_build_object('mode',_stage,'day',_cycle_day,'phase',_cycle_phase,
        'confidence',case when _stage='regular_cycle' and _cycle_day is not null then 'estimated' else 'none' end,
        'consentVersion',coalesce(_reproductive->'consent'->>'artifactVersion','reproductive-health-consent/1'));
    else _reproductive:=null; end if;
  else _reproductive:=null; end if;

  if exists(select 1 from clinical_core.current_consent consent
    where consent.connection_id=_connection.id and consent.scope='wearables' and consent.status='granted') then
    select payload into _latest_wearable from clinical_core.consumer_clinical_record_versions
      where connection_id=_connection.id and collection='wearable_daily_records' and not deleted
      order by (payload->>'date')::date desc,received_at desc limit 1;
    select count(*),
      avg(nullif(payload->>'hrv','')::numeric),
      avg(nullif(payload->>'restingHr','')::numeric),
      avg(nullif(payload->>'sleepDurationMinutes','')::numeric)
      into _wearable_count,_avg_hrv,_avg_rhr,_avg_sleep
    from (select payload from clinical_core.consumer_clinical_record_versions
      where connection_id=_connection.id and collection='wearable_daily_records' and not deleted
        and (payload->>'date')::date < (_latest_wearable->>'date')::date
      order by (payload->>'date')::date desc limit 14) baseline;
    if _latest_wearable is not null then
      _wearable:=jsonb_build_object('date',_latest_wearable->>'date','baselineDays',14,
        'hrvDeltaPercent',case when _wearable_count>=5 and _avg_hrv<>0 and nullif(_latest_wearable->>'hrv','') is not null
          then round(((nullif(_latest_wearable->>'hrv','')::numeric-_avg_hrv)/_avg_hrv)*100,2) else null end,
        'restingHeartRateDeltaPercent',case when _wearable_count>=5 and _avg_rhr<>0 and nullif(_latest_wearable->>'restingHr','') is not null
          then round(((nullif(_latest_wearable->>'restingHr','')::numeric-_avg_rhr)/_avg_rhr)*100,2) else null end,
        'sleepMinutes',nullif(_latest_wearable->>'sleepDurationMinutes','')::numeric,
        'sleepDeltaPercent',case when _wearable_count>=5 and _avg_sleep<>0 and nullif(_latest_wearable->>'sleepDurationMinutes','') is not null
          then round(((nullif(_latest_wearable->>'sleepDurationMinutes','')::numeric-_avg_sleep)/_avg_sleep)*100,2) else null end,
        'recoveryScore',nullif(_latest_wearable->>'readinessScore','')::numeric);
    end if;
  end if;

  if exists(select 1 from clinical_core.current_consent consent
    where consent.connection_id=_connection.id and consent.scope='lab_summaries' and consent.status='granted') then
    select coalesce(jsonb_agg(jsonb_build_object('name',observation.marker_name,
      'value',observation.value_numeric,'unit',observation.unit,'drawnAt',observation.observed_at,
      'conventionalRange',case when observation.reference_min is null and observation.reference_max is null
        then null else jsonb_build_object('low',observation.reference_min,'high',observation.reference_max) end,
      'functionalRange',null,'sourceStatus',observation.review_status)
      order by observation.observed_at desc,observation.created_at desc),'[]'::jsonb) into _labs
    from (select * from clinical_core.lab_observations where organization_id=_connection.organization_id
      and patient_record_id=_connection.patient_record_id and review_status in ('accepted','flagged')
      order by observed_at desc,created_at desc limit 250) observation;
  end if;

  if exists(select 1 from clinical_core.current_consent consent
    where consent.connection_id=_connection.id and consent.scope='protocols_supplements'
      and consent.status='granted') then
    select jsonb_build_object('name',version.title,'phase',null,
      'todayTasks','[]'::jsonb,'fastingWindow',null,
      'approvedItems',coalesce((select jsonb_agg(jsonb_build_object('id',item.id,
        'name',item.label,'instructions',coalesce(item.instructions,item.timing_text))
        order by item.position) from clinical_core.patient_protocol_items item
        where item.protocol_version_id=version.id),'[]'::jsonb))
      into _protocol from clinical_core.patient_protocols protocol
      join clinical_core.patient_protocol_versions version on version.id=protocol.active_version_id
      where protocol.organization_id=_connection.organization_id
        and protocol.patient_record_id=_connection.patient_record_id
        and protocol.status='active' and protocol.deleted_at is null;
  end if;

  return jsonb_build_object('profile',_profile,'cycle',_reproductive,'wearables',_wearable,
    'labs',_labs,'protocol',_protocol,'tcm',_tcm,'conversationMemory',null,
    'promotedPatterns','[]'::jsonb);
end $$;

revoke all on function clinical_core.get_patient_chat_context() from public;
grant execute on function clinical_core.get_patient_chat_context() to clinical_core_api;
