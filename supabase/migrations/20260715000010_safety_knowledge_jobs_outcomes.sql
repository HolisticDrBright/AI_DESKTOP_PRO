-- ============================================================
-- 0010 Safety engine, knowledge, jobs, AI ledger, Quantum Mind,
--      wearables/nutrition bridge, outcomes & population, imports,
--      central review queue.
-- Applied + verified against project urcjiehlxoehievobezf.
-- ============================================================

create table public.safety_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  category text not null check (category in ('medication_interaction','supplement_interaction','allergy','pregnancy','lactation','kidney_function','liver_function','upcoming_procedure','abnormal_lab','dosage_limit','contraindicated_condition','urgent_symptom','emergency_symptom')),
  name text not null, expression jsonb not null default '{}'::jsonb,
  severity text not null check (severity in ('informational','monitor','practitioner_review_required','urgent_evaluation','emergency_instruction')),
  version text not null default 'v1', source text, is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by uuid references auth.users(id)
);
create table public.safety_evaluations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  safety_rule_id uuid references public.safety_rules(id) on delete set null,
  severity text not null, triggered boolean not null default false, detail text, rule_version text,
  evaluated_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create index safety_eval_patient_idx on public.safety_evaluations (patient_id, evaluated_at desc);
create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  domain text not null check (domain in ('clinical_knowledge','supplement_evidence','product_labels','practitioner_protocols','patient_education')),
  title text not null, source text, publication_date date, review_date date,
  evidence_type text, evidence_quality text, population text, dose text, outcome text,
  version text, deprecation_status text, body text, uri text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  type text not null, status text not null default 'queued' check (status in ('queued','running','succeeded','failed','needs_review','cancelled')),
  progress numeric not null default 0, attempts int not null default 0, max_attempts int not null default 3,
  idempotency_key text, input_ref text, output_ref text, error_code text, safe_error_message text,
  scheduled_at timestamptz, started_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, type, idempotency_key)
);
create index jobs_status_idx on public.jobs (status, scheduled_at);
create table public.ai_invocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  service text not null, model text, prompt_version text, knowledge_version text,
  input_record_refs jsonb not null default '[]'::jsonb, validation_status text,
  status text not null default 'succeeded', safe_error_message text, latency_ms int,
  created_at timestamptz not null default now()
);
create index ai_invocations_patient_idx on public.ai_invocations (patient_id, created_at desc);
create table public.quantum_mind_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  recommended_session text, routing_reason text check (routing_reason in ('goal','adherence_barrier','stress_pattern','sleep_concern','pain_behavior','motivation','user_preference')),
  status text not null default 'recommended' check (status in ('recommended','completed','skipped')),
  subjective_response text, adherence_effect text, outcome_relationship text, completed_at timestamptz,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.wearable_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  provider text not null, status text not null default 'active', external_user_id text,
  last_sync_at timestamptz, last_successful_sync_at timestamptz,
  source text not null default 'vital', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.wearable_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  metric text not null, value_numeric numeric, unit text,
  observed_at timestamptz not null default now(), ingested_at timestamptz not null default now(),
  data_quality text default 'measured', confidence numeric, provenance text,
  source text not null default 'wearable', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index wearable_obs_patient_idx on public.wearable_observations (patient_id, observed_at desc);
create table public.wearable_daily_summaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  summary_date date not null, metrics jsonb not null default '{}'::jsonb,
  source text not null default 'wearable', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz,
  unique (patient_id, summary_date)
);
create table public.food_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  logged_at timestamptz not null default now(), description text, meal_type text, photo_path text,
  observed_at timestamptz not null default now(), ingested_at timestamptz not null default now(),
  data_quality text default 'reported', confidence numeric, provenance text,
  source text not null default 'patient_reported', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.nutrition_targets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  nutrient text not null, target_value numeric, unit text, period text,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.outcome_measures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  name text not null, instrument text, description text, scale text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.outcome_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  outcome_measure_id uuid references public.outcome_measures(id) on delete set null,
  value_numeric numeric, value_text text, observed_at timestamptz not null default now(),
  ingested_at timestamptz not null default now(), data_quality text, confidence numeric, provenance text,
  source text not null default 'patient_reported', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index outcome_obs_patient_idx on public.outcome_observations (patient_id, observed_at desc);
create table public.outcome_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  program_id uuid references public.programs(id) on delete set null,
  captured_at timestamptz not null default now(), metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table public.research_cohorts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, description text, min_cell_size int not null default 11,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by uuid references auth.users(id)
);
create table public.cohort_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cohort_id uuid not null references public.research_cohorts(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  consent_verified boolean not null default false, created_at timestamptz not null default now(),
  unique (cohort_id, patient_id)
);
create table public.protocol_effectiveness (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cohort_id uuid references public.research_cohorts(id) on delete set null,
  intervention text, outcome text, effect_direction text, effect_magnitude numeric,
  data_completeness numeric, sample_size int, evidence_grade text, computed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_system text not null check (source_system in ('practice_better','biocanic','jane','csv','other')),
  status text not null default 'staged' check (status in ('staged','mapping','reviewing','committed','failed')),
  file_ref text, summary jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create table public.import_field_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  import_job_id uuid references public.import_jobs(id) on delete cascade,
  source_field text, target_table text, target_field text, transform text, created_at timestamptz not null default now()
);
create table public.import_review_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  import_job_id uuid references public.import_jobs(id) on delete cascade,
  raw jsonb, proposed jsonb, status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create table public.review_queue_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete cascade,
  item_type text not null check (item_type in ('lab_extraction','abnormal_result','reasoning_snapshot','hypothesis','recommendation','supplement_interaction','protocol','experiment','assessment','patient_message','safety_alert','refill_request','low_adherence','overdue_followup')),
  ref_id uuid, title text, priority text not null default 'medium' check (priority in ('low','medium','high')),
  status text not null default 'open' check (status in ('open','in_review','resolved','snoozed','dismissed')),
  assignee_user_id uuid references auth.users(id) on delete set null, due_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index review_queue_org_idx on public.review_queue_items (organization_id, status, priority);

do $$ declare t text;
begin
  foreach t in array array['safety_evaluations','quantum_mind_sessions','wearable_connections','wearable_observations',
    'wearable_daily_summaries','food_logs','nutrition_targets','outcome_observations','outcome_snapshots','cohort_memberships']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_access on public.%I for all using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));', t, t);
  end loop;
  foreach t in array array['review_queue_items','jobs','ai_invocations']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($f$create policy %I_access on public.%I for all using (organization_id is not null and private.is_org_member(organization_id) and (patient_id is null or private.can_access_patient(patient_id))) with check (organization_id is not null and private.is_org_member(organization_id) and (patient_id is null or private.can_access_patient(patient_id)));$f$, t, t);
  end loop;
  foreach t in array array['research_cohorts','protocol_effectiveness','import_jobs','import_field_mappings','import_review_items']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_admin on public.%I for all using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));', t, t);
  end loop;
  alter table public.safety_rules enable row level security;
  create policy safety_rules_read on public.safety_rules for select using (organization_id is null or private.is_org_member(organization_id));
  create policy safety_rules_write on public.safety_rules for all using (organization_id is not null and private.is_org_admin(organization_id)) with check (organization_id is not null and private.is_org_admin(organization_id));
  alter table public.outcome_measures enable row level security;
  create policy outcome_measures_read on public.outcome_measures for select using (organization_id is null or private.is_org_member(organization_id));
  create policy outcome_measures_write on public.outcome_measures for all using (organization_id is not null and private.is_org_admin(organization_id)) with check (organization_id is not null and private.is_org_admin(organization_id));
  alter table public.knowledge_sources enable row level security;
  create policy knowledge_sources_read on public.knowledge_sources for select using (auth.uid() is not null);
  foreach t in array array['safety_rules','knowledge_sources','jobs','quantum_mind_sessions','wearable_connections',
    'wearable_observations','wearable_daily_summaries','food_logs','nutrition_targets','outcome_measures',
    'outcome_observations','research_cohorts','import_jobs','review_queue_items']
  loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;
