-- Lens hardening: initplan-stable reference policies + foreign-key access
-- paths for tenant checks, supersede reads, feedback writes, and
-- retention/deletion workflows.
-- Applied migration version: 20260730001742.
--
-- Advisor-driven follow-up to desktop_owned_lens. Semantics are unchanged:
-- the reference policies still deny anonymous callers and admit any signed-in
-- user, and no new data is exposed. Wrapping `auth.uid()` in a scalar
-- subquery lets Postgres evaluate it once per statement instead of per row
-- (advisor `auth_rls_initplan`).

begin;

-- ------------------------------------------------- reference read policies
-- Non-PHI, org-independent reference data (paradigms, versioned domains,
-- governed knowledge registry). Same predicate, evaluated once per query.
drop policy if exists paradigms_select on public.clinical_paradigms;
create policy paradigms_select on public.clinical_paradigms
  for select using ((select auth.uid()) is not null);

drop policy if exists domains_select on public.clinical_domains;
create policy domains_select on public.clinical_domains
  for select using ((select auth.uid()) is not null);

drop policy if exists knowledge_select on public.clinical_knowledge_sources;
create policy knowledge_select on public.clinical_knowledge_sources
  for select using ((select auth.uid()) is not null);

-- ------------------------------------------------- foreign-key access paths
-- lens_evaluations: tenant checks, the supersede chain read by
-- get_desktop_lens_evaluation (`superseded_by is null`), and org/patient
-- retention cascades. The existing lens_eval_patient_stale_idx is partial
-- (`where stale = false`), so it does not serve full patient cascades.
create index if not exists lens_evaluations_organization_idx
  on public.lens_evaluations (organization_id);
create index if not exists lens_evaluations_patient_idx
  on public.lens_evaluations (patient_id);
create index if not exists lens_evaluations_paradigm_idx
  on public.lens_evaluations (paradigm_code);
create index if not exists lens_evaluations_created_by_idx
  on public.lens_evaluations (created_by);
create index if not exists lens_evaluations_superseded_by_idx
  on public.lens_evaluations (superseded_by)
  where superseded_by is not null;

-- differential_questions: encounter reads are already covered by
-- diffq_encounter_idx; these cover tenancy and retention.
create index if not exists differential_questions_organization_idx
  on public.differential_questions (organization_id);
create index if not exists differential_questions_patient_idx
  on public.differential_questions (patient_id);
create index if not exists differential_questions_paradigm_idx
  on public.differential_questions (paradigm_code);
create index if not exists differential_questions_updated_by_idx
  on public.differential_questions (updated_by)
  where updated_by is not null;

-- question_answers: (question_id, version) is already unique-indexed and
-- serves list_desktop_question_answers; these cover tenancy and retention.
create index if not exists question_answers_organization_idx
  on public.question_answers (organization_id);
create index if not exists question_answers_patient_idx
  on public.question_answers (patient_id);
create index if not exists question_answers_encounter_idx
  on public.question_answers (encounter_id);
create index if not exists question_answers_answered_by_idx
  on public.question_answers (answered_by);

-- question_feedback: written by dismiss_question and
-- submit_question_feedback; the question_id path also serves cascades.
create index if not exists question_feedback_question_idx
  on public.question_feedback (question_id);
create index if not exists question_feedback_created_by_idx
  on public.question_feedback (created_by);

-- Append-only lifecycle/review actor paths.
create index if not exists question_status_transitions_created_by_idx
  on public.question_status_transitions (created_by)
  where created_by is not null;
create index if not exists lens_safety_blocks_reviewed_by_idx
  on public.lens_safety_blocks (reviewed_by)
  where reviewed_by is not null;

commit;
