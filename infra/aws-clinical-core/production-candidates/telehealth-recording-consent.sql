-- Forward-only consent vocabulary extension. No approvals or grants are seeded.
-- Preserve all prior scopes, including lab specimen context. This does not
-- authorize recording, a provider, representative access, or PHI activation.
alter table clinical_core.consent_artifacts
  drop constraint consent_artifacts_scope_check;
alter table clinical_core.consent_artifacts
  add constraint consent_artifacts_scope_check check (scope in (
    'programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','reproductive_health',
    'lab_summaries','lab_results_import','lab_specimen_context','billing_links',
    'research_n_of_1','telehealth_recording'));

alter table clinical_core.consent_grants
  drop constraint consent_grants_scope_check;
alter table clinical_core.consent_grants
  add constraint consent_grants_scope_check check (scope in (
    'programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','reproductive_health',
    'lab_summaries','lab_results_import','lab_specimen_context','billing_links',
    'research_n_of_1','telehealth_recording'));
