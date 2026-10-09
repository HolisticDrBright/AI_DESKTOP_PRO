-- Private owner copies only. No clinic collection, consent release or approval
-- is created. Existing owner lock, consent, revision, hold and audit guards apply.
alter table clinical_core.owned_consumer_record_versions drop constraint owned_consumer_record_versions_collection_check;
alter table clinical_core.owned_consumer_record_versions add constraint owned_consumer_record_versions_collection_check check(collection in (
  'protocols','daily_adherence','symptom_logs','hormone_entries','meal_logs','subjective_rollups','weekly_checkins',
  'wellness_profiles','lifestyle_profiles','contraindications','questionnaire_responses','clinical_intakes',
  'wearable_daily_records','reproductive_profiles','adverse_event_reports','lab_observations','diet_preferences'));

create or replace function clinical_private.consumer_collection_scope(_collection text)
returns text language sql immutable set search_path='' as $$
  select case _collection when 'protocols' then 'protocols_supplements'
    when 'daily_adherence' then 'symptoms_adherence' when 'symptom_logs' then 'symptoms_adherence'
    when 'adverse_event_reports' then 'symptoms_adherence'
    when 'hormone_entries' then 'reproductive_health' when 'reproductive_profiles' then 'reproductive_health'
    when 'meal_logs' then 'nutrition' when 'diet_preferences' then 'nutrition'
    when 'subjective_rollups' then 'symptoms_adherence'
    when 'weekly_checkins' then 'forms_checkins' when 'wellness_profiles' then 'forms_checkins'
    when 'lifestyle_profiles' then 'forms_checkins' when 'contraindications' then 'forms_checkins'
    when 'questionnaire_responses' then 'forms_checkins' when 'clinical_intakes' then 'forms_checkins'
    when 'wearable_daily_records' then 'wearables' when 'lab_observations' then 'lab_history' else null end
$$;

create function clinical_private.validate_owned_diet_preferences()
returns trigger language plpgsql set search_path='' as $$
declare p jsonb:=new.payload; stamp timestamptz;
begin
  if new.collection<>'diet_preferences' then return new; end if;
  if new.record_id<>'88465545-91d2-4a55-8ff1-f0e85fc255ba'::uuid then
    raise exception using errcode='22023',message='owned_diet_preferences_invalid';
  end if;
  if new.deleted then return new; end if;
  if jsonb_typeof(p) is distinct from 'object'
    or not p ?& array['id','version','activeDiets','allergies','notes','updatedAt','sourceStatus']
    or p-array['id','version','activeDiets','allergies','notes','updatedAt','sourceStatus']<>'{}'::jsonb
    or p->>'id' is distinct from new.record_id::text
    or p->>'version' is distinct from 'personal-diet-preferences/1'
    or p->>'sourceStatus' is distinct from 'patient_reported_not_prescribed'
    or jsonb_typeof(p->'activeDiets') is distinct from 'array'
    or jsonb_typeof(p->'allergies') is distinct from 'string'
    or jsonb_typeof(p->'notes') is distinct from 'string'
    or jsonb_typeof(p->'updatedAt') is distinct from 'string'
    or char_length(p->>'allergies')>2000 or char_length(p->>'notes')>2000 then
    raise exception using errcode='22023',message='owned_diet_preferences_invalid';
  end if;
  if jsonb_array_length(p->'activeDiets')>4
    or exists(select 1 from jsonb_array_elements(p->'activeDiets') x(value)
      where jsonb_typeof(value)<>'string' or value#>>'{}' not in ('AIP','LOW_FODMAP','KETO','LOW_HISTAMINE'))
    or (select count(*)<>count(distinct value) from jsonb_array_elements(p->'activeDiets') x(value)) then
    raise exception using errcode='22023',message='owned_diet_preferences_invalid';
  end if;
  begin
    if p->>'updatedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then raise exception 'invalid_date'; end if;
    stamp:=(p->>'updatedAt')::timestamptz;
    if not isfinite(stamp) or stamp>clock_timestamp() then raise exception 'invalid_date'; end if;
  exception when others then
    raise exception using errcode='22023',message='owned_diet_preferences_invalid';
  end;
  return new;
end $$;
revoke all on function clinical_private.validate_owned_diet_preferences() from public,clinical_core_api;
create trigger validate_owned_diet_preferences before insert on clinical_core.owned_consumer_record_versions
  for each row execute function clinical_private.validate_owned_diet_preferences();
