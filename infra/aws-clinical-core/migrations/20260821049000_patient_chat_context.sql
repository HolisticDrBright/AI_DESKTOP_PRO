-- Synthetic-only Ask ALP context. Every domain is absent unless both a
-- verified consumer connection and its independent consent are present.

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
  select case _collection when 'protocols' then 'protocols_supplements'
    when 'daily_adherence' then 'symptoms_adherence' when 'symptom_logs' then 'symptoms_adherence'
    when 'hormone_entries' then 'reproductive_health' when 'reproductive_profiles' then 'reproductive_health'
    when 'meal_logs' then 'nutrition' when 'subjective_rollups' then 'symptoms_adherence'
    when 'weekly_checkins' then 'forms_checkins' when 'wellness_profiles' then 'forms_checkins'
    when 'lifestyle_profiles' then 'forms_checkins' when 'contraindications' then 'forms_checkins'
    when 'questionnaire_responses' then 'forms_checkins' when 'clinical_intakes' then 'forms_checkins'
    when 'wearable_daily_records' then 'wearables' else null end
$$;

create or replace function clinical_core.get_patient_chat_context()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _connection clinical_core.patient_connections%rowtype;
  _profile jsonb; _lifestyle jsonb; _contra jsonb; _reproductive jsonb; _wearable jsonb;
  _latest jsonb; _labs jsonb:='[]'::jsonb; _count integer; _avg_hrv numeric; _avg_rhr numeric; _avg_sleep numeric;
  _stage text; _day integer; _phase text;
begin
  perform clinical_private.assert_synthetic_context(clinical_private.organization_id(),'clinical_data','consumer');
  select * into _connection from clinical_core.patient_connections where
    organization_id=clinical_private.organization_id()
    and consumer_person_id=clinical_private.actor_person_id() and state in ('verified','paused')
    order by verified_at desc limit 1;
  if not found then raise exception using errcode='42501',message='verified_connection_required'; end if;

  select payload into _profile from clinical_core.consumer_clinical_record_versions where
    connection_id=_connection.id and collection='wellness_profiles' and not deleted order by received_at desc,id desc limit 1;
  select payload into _lifestyle from clinical_core.consumer_clinical_record_versions where
    connection_id=_connection.id and collection='lifestyle_profiles' and not deleted order by received_at desc,id desc limit 1;
  select payload into _contra from clinical_core.consumer_clinical_record_versions where
    connection_id=_connection.id and collection='contraindications' and not deleted order by received_at desc,id desc limit 1;
  if _profile is not null or _lifestyle is not null or _contra is not null then
    _profile:=jsonb_build_object('ageYears',null,'sex',null,
      'goals',case when jsonb_typeof(_profile->'goals')='array' then _profile->'goals' else '[]'::jsonb end,
      'contraindications',case when jsonb_typeof(_contra->'conditions')='array' then _contra->'conditions' else '[]'::jsonb end,
      'allergies',case when jsonb_typeof(_contra->'allergies')='array' then _contra->'allergies' else '[]'::jsonb end,
      'dietOfRecord',nullif(_lifestyle->>'dietType',''),'cookingSkill',nullif(_lifestyle->>'cookingSkill',''));
  end if;

  if exists(select 1 from clinical_core.current_consent where connection_id=_connection.id and scope='reproductive_health' and status='granted') then
    select payload into _reproductive from clinical_core.consumer_clinical_record_versions where
      connection_id=_connection.id and collection='reproductive_profiles' and not deleted order by received_at desc,id desc limit 1;
    _stage:=_reproductive->>'stage';
    if _stage in ('regular_cycle','hormonal_contraception','irregular_cycle','perimenopause','pregnant','postpartum','menopause')
      and _reproductive->'consent'->>'status'='granted' then
      _day:=case when (_reproductive->>'cycleDay')~'^[0-9]{1,2}$' then (_reproductive->>'cycleDay')::integer else null end;
      _phase:=case when _stage<>'regular_cycle' or _day not between 1 and 60 then 'unknown'
        when _day<=5 then 'menstrual' when _day<=12 then 'follicular' when _day<=15 then 'ovulatory' else 'luteal' end;
      _reproductive:=jsonb_build_object('mode',_stage,'day',_day,'phase',_phase,
        'confidence',case when _stage='regular_cycle' and _day is not null then 'estimated' else 'none' end,
        'consentVersion',coalesce(_reproductive->'consent'->>'artifactVersion','reproductive-health-consent/1'));
    else _reproductive:=null; end if;
  end if;

  if exists(select 1 from clinical_core.current_consent where connection_id=_connection.id and scope='wearables' and status='granted') then
    select payload into _latest from clinical_core.consumer_clinical_record_versions where
      connection_id=_connection.id and collection='wearable_daily_records' and not deleted
      order by (payload->>'date')::date desc,received_at desc limit 1;
    if _latest is not null then
      select count(*),avg(nullif(payload->>'hrv','')::numeric),avg(nullif(payload->>'restingHr','')::numeric),
        avg(nullif(payload->>'sleepDurationMinutes','')::numeric) into _count,_avg_hrv,_avg_rhr,_avg_sleep
      from (select payload from clinical_core.consumer_clinical_record_versions where connection_id=_connection.id
        and collection='wearable_daily_records' and not deleted and (payload->>'date')::date<(_latest->>'date')::date
        order by (payload->>'date')::date desc limit 14) baseline;
      _wearable:=jsonb_build_object('date',_latest->>'date','baselineDays',14,
        'hrvDeltaPercent',case when _count>=5 and _avg_hrv<>0 and nullif(_latest->>'hrv','') is not null then round(((nullif(_latest->>'hrv','')::numeric-_avg_hrv)/_avg_hrv)*100,2) end,
        'restingHeartRateDeltaPercent',case when _count>=5 and _avg_rhr<>0 and nullif(_latest->>'restingHr','') is not null then round(((nullif(_latest->>'restingHr','')::numeric-_avg_rhr)/_avg_rhr)*100,2) end,
        'sleepMinutes',nullif(_latest->>'sleepDurationMinutes','')::numeric,
        'sleepDeltaPercent',case when _count>=5 and _avg_sleep<>0 and nullif(_latest->>'sleepDurationMinutes','') is not null then round(((nullif(_latest->>'sleepDurationMinutes','')::numeric-_avg_sleep)/_avg_sleep)*100,2) end,
        'recoveryScore',nullif(_latest->>'readinessScore','')::numeric);
    end if;
  end if;

  if exists(select 1 from clinical_core.current_consent where connection_id=_connection.id and scope='lab_summaries' and status='granted') then
    select coalesce(jsonb_agg(jsonb_build_object('name',marker_name,'value',value_numeric,'unit',unit,
      'drawnAt',observed_at,'conventionalRange',case when reference_min is null and reference_max is null then null
      else jsonb_build_object('low',reference_min,'high',reference_max) end,'functionalRange',null,'sourceStatus',review_status)
      order by observed_at desc),'[]'::jsonb) into _labs from (select * from clinical_core.lab_observations
      where organization_id=_connection.organization_id and patient_record_id=_connection.patient_record_id
        and review_status='reviewed' order by observed_at desc limit 250) reviewed;
  end if;
  return jsonb_build_object('profile',_profile,'cycle',_reproductive,'wearables',_wearable,'labs',_labs,
    'protocol',null,'tcm',null,'conversationMemory',null,'promotedPatterns','[]'::jsonb);
end $$;
revoke all on function clinical_core.get_patient_chat_context() from public;
grant execute on function clinical_core.get_patient_chat_context() to clinical_core_api;
