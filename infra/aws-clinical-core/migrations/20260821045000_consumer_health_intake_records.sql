-- Consent-governed V2 health profile and intake records.
-- These immutable versions remain separate from the practitioner-authored chart.
-- A clinician must review patient-supplied content before using it clinically.

alter table clinical_core.consumer_clinical_record_versions
  drop constraint consumer_clinical_record_versions_collection_check;
alter table clinical_core.consumer_clinical_record_versions
  add constraint consumer_clinical_record_versions_collection_check check (collection in (
    'protocols','daily_adherence','symptom_logs','hormone_entries',
    'meal_logs','subjective_rollups','weekly_checkins',
    'wellness_profiles','lifestyle_profiles','contraindications',
    'questionnaire_responses','clinical_intakes'));

create or replace function clinical_private.consumer_collection_scope(_collection text)
returns text language sql immutable set search_path = '' as $$
  select case _collection
    when 'protocols' then 'protocols_supplements'
    when 'daily_adherence' then 'symptoms_adherence'
    when 'symptom_logs' then 'symptoms_adherence'
    when 'hormone_entries' then 'forms_checkins'
    when 'meal_logs' then 'nutrition'
    when 'subjective_rollups' then 'symptoms_adherence'
    when 'weekly_checkins' then 'forms_checkins'
    when 'wellness_profiles' then 'forms_checkins'
    when 'lifestyle_profiles' then 'forms_checkins'
    when 'contraindications' then 'forms_checkins'
    when 'questionnaire_responses' then 'forms_checkins'
    when 'clinical_intakes' then 'forms_checkins'
    else null end
$$;
