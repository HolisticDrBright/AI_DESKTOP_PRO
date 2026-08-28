-- Reproductive-health context is separately consented. It must never be
-- inferred from generic symptom, intake, or wearable consent.

alter table clinical_core.consent_artifacts
  drop constraint consent_artifacts_scope_check;
alter table clinical_core.consent_artifacts
  add constraint consent_artifacts_scope_check check (scope in (
    'programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','reproductive_health',
    'lab_summaries','lab_results_import','billing_links','research_n_of_1'));

alter table clinical_core.consent_grants
  drop constraint consent_grants_scope_check;
alter table clinical_core.consent_grants
  add constraint consent_grants_scope_check check (scope in (
    'programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','reproductive_health',
    'lab_summaries','lab_results_import','billing_links','research_n_of_1'));
