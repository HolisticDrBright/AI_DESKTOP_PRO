-- Telehealth video + recording/AI-notes consent is its own scope. It is the
-- ONE combined consent a virtual visit requires (telehealth AND recording with
-- AI notes), separately approved as a versioned artifact per organization and
-- recorded through the same append-only grant/revoke lifecycle as every other
-- scope. It must never be inferred from `appointments` or `messaging` consent,
-- and a retired artifact or a revoked grant leaves no current authority.

alter table clinical_core.consent_artifacts
  drop constraint consent_artifacts_scope_check;
alter table clinical_core.consent_artifacts
  add constraint consent_artifacts_scope_check check (scope in (
    'programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','reproductive_health',
    'lab_summaries','lab_results_import','billing_links','research_n_of_1',
    'telehealth_recording'));

alter table clinical_core.consent_grants
  drop constraint consent_grants_scope_check;
alter table clinical_core.consent_grants
  add constraint consent_grants_scope_check check (scope in (
    'programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','reproductive_health',
    'lab_summaries','lab_results_import','billing_links','research_n_of_1',
    'telehealth_recording'));
