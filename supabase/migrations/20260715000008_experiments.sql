-- ============================================================
-- 0008 N-of-1 experiment engine (patient-scoped)
-- Conclusions restricted to the cautious vocabulary from the spec.
-- Applied + verified against project urcjiehlxoehievobezf.
-- ============================================================

create table public.experiments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  goal text, hypothesis text,
  experiment_type text not null default 'before_after' check (experiment_type in ('before_after','withdrawal_rechallenge','alternating_treatment','randomized_crossover','custom')),
  primary_intervention text, primary_outcome text, secondary_outcomes jsonb not null default '[]'::jsonb,
  baseline_duration_days int, intervention_duration_days int, washout_duration_days int, control_duration_days int,
  target_change text, minimum_data_completeness numeric, stable_variables jsonb not null default '[]'::jsonb,
  confounders jsonb not null default '[]'::jsonb, stopping_rules text,
  status text not null default 'draft' check (status in ('draft','pending_approval','active','analyzing','completed','stopped')),
  approval_requirement boolean not null default true, approved_by uuid references auth.users(id), approved_at timestamptz,
  analysis_date date, started_at timestamptz, ended_at timestamptz,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index experiments_patient_idx on public.experiments (patient_id, status);
create table public.experiment_phases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  experiment_id uuid references public.experiments(id) on delete cascade,
  phase_type text check (phase_type in ('baseline','intervention','washout','control')),
  sequence int, starts_on date, ends_on date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.experiment_interventions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  experiment_id uuid references public.experiments(id) on delete cascade,
  name text not null, is_primary boolean not null default true, dose text, schedule text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.experiment_outcomes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  experiment_id uuid references public.experiments(id) on delete cascade,
  name text not null, is_primary boolean not null default false, metric text, unit text, expected_latency_days int,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.experiment_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  experiment_id uuid references public.experiments(id) on delete cascade,
  outcome_id uuid references public.experiment_outcomes(id) on delete set null,
  phase_id uuid references public.experiment_phases(id) on delete set null,
  value_numeric numeric, value_text text, unit text,
  observed_at timestamptz not null default now(), ingested_at timestamptz not null default now(),
  data_quality text default 'reported', confidence numeric, provenance text,
  source text not null default 'patient_reported', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index experiment_obs_idx on public.experiment_observations (experiment_id, observed_at desc);
create table public.experiment_confounders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  experiment_id uuid references public.experiments(id) on delete cascade,
  description text not null, occurred_at timestamptz, impact text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.experiment_adverse_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  experiment_id uuid references public.experiments(id) on delete cascade,
  description text not null, severity text, occurred_at timestamptz, action_taken text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.experiment_analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  experiment_id uuid references public.experiments(id) on delete cascade,
  baseline_value numeric, intervention_value numeric, absolute_change numeric, relative_change numeric,
  variability numeric, data_completeness numeric, adherence numeric, confounding_events int, adverse_events int,
  expected_latency_compatible boolean, computed_at timestamptz not null default now(), model text, prompt_version text,
  created_at timestamptz not null default now()
);
create table public.experiment_conclusions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  experiment_id uuid references public.experiments(id) on delete cascade,
  conclusion text not null check (conclusion in ('likely_beneficial','possibly_beneficial','no_measurable_effect','possibly_harmful','inconclusive')),
  rationale text, review_status text not null default 'unreviewed',
  reviewed_by uuid references auth.users(id), reviewed_at timestamptz, created_at timestamptz not null default now()
);

do $$ declare t text;
begin
  foreach t in array array['experiments','experiment_phases','experiment_interventions','experiment_outcomes',
    'experiment_observations','experiment_confounders','experiment_adverse_events','experiment_analyses','experiment_conclusions']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_access on public.%I for all using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));', t, t);
  end loop;
  foreach t in array array['experiments','experiment_phases','experiment_interventions','experiment_outcomes',
    'experiment_observations','experiment_confounders','experiment_adverse_events']
  loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;
