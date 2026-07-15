-- ============================================================
-- 0006 Clinical reasoning engine + Adaptive Health Twin
-- reasoning_strength is an INTERNAL evidence-weighting score (0-100),
-- never a medical probability. reasoning_snapshots are immutable/append-only
-- and store concise summaries + citations, never hidden chain-of-thought.
-- Applied + verified against project urcjiehlxoehievobezf.
-- ============================================================

create table public.clinical_facts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  fact_type text not null check (fact_type in ('measured','patient_reported','practitioner_confirmed','published_evidence','ai_inference','conflicting','missing')),
  statement text not null, category text, value_numeric numeric, value_text text, unit text,
  source_table text, source_record_id text,
  observed_at timestamptz, ingested_at timestamptz not null default now(),
  data_quality text, confidence numeric, provenance text,
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed','accepted','flagged','rejected')),
  reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
  source text not null default 'derived',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index clinical_facts_patient_idx on public.clinical_facts (patient_id);
create table public.clinical_hypotheses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  title text not null, description text, category text,
  status text not null default 'proposed' check (status in ('proposed','under_review','supported','weakened','unresolved','rejected','archived')),
  reasoning_strength int check (reasoning_strength between 0 and 100),
  supporting_evidence_count int not null default 0, contradicting_evidence_count int not null default 0,
  earliest_supporting_date timestamptz, last_updated_at timestamptz not null default now(),
  prior_strength int, strength_change int, change_explanation text,
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed','accepted','flagged','rejected')),
  reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
  source text not null default 'derived',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index clinical_hypotheses_patient_idx on public.clinical_hypotheses (patient_id, status);
comment on column public.clinical_hypotheses.reasoning_strength is 'Internal evidence-weighting score 0-100. NOT a medical probability. Never surface as a probability.';
create table public.evidence_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  hypothesis_id uuid references public.clinical_hypotheses(id) on delete cascade,
  fact_id uuid references public.clinical_facts(id) on delete set null,
  direction text not null check (direction in ('supporting','contradicting')),
  weight numeric, summary text, citation text, knowledge_ref text,
  source text not null default 'derived',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index evidence_items_hyp_idx on public.evidence_items (hypothesis_id);
create table public.contradictions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  description text not null, fact_a_id uuid references public.clinical_facts(id) on delete set null,
  fact_b_id uuid references public.clinical_facts(id) on delete set null, severity text,
  status text not null default 'open' check (status in ('open','resolved','accepted')),
  source text not null default 'derived',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.missing_data_recommendations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  hypothesis_id uuid references public.clinical_hypotheses(id) on delete set null,
  description text not null, data_type text, priority int,
  status text not null default 'open' check (status in ('open','ordered','resolved','dismissed')),
  source text not null default 'derived',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.clinical_relationships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  from_type text, from_id uuid, to_type text, to_id uuid, relationship text, weight numeric,
  source text not null default 'derived',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.reasoning_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  trigger text, input_record_ids jsonb not null default '[]'::jsonb,
  knowledge_version text, prompt_version text, model text,
  structured_output jsonb, validation_result jsonb, safety_results jsonb,
  previous_snapshot_id uuid references public.reasoning_snapshots(id) on delete set null,
  change_summary text,
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed','accepted','flagged','rejected')),
  reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
  source text not null default 'engine', created_at timestamptz not null default now()
);
create index reasoning_snapshots_patient_idx on public.reasoning_snapshots (patient_id, created_at desc);
comment on table public.reasoning_snapshots is 'Immutable, append-only. Stores concise reasoning summaries, citations and decision factors — NO hidden chain-of-thought.';
create table public.reasoning_snapshot_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  snapshot_id uuid references public.reasoning_snapshots(id) on delete cascade,
  item_type text, ref_id uuid, summary text, payload jsonb, created_at timestamptz not null default now()
);
create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  title text not null, detail text, category text, audience text check (audience in ('patient','practitioner')),
  status text not null default 'proposed' check (status in ('proposed','accepted','modified','rejected','deferred')),
  hypothesis_id uuid references public.clinical_hypotheses(id) on delete set null,
  review_status text not null default 'unreviewed', source text not null default 'derived',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.practitioner_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  practitioner_user_id uuid references auth.users(id) on delete set null,
  item_type text not null, item_id uuid,
  decision text not null check (decision in ('accept','modify','reject','comment','assign','defer','request_data','convert_to_task','approve_patient_visibility')),
  comment text, payload jsonb, created_at timestamptz not null default now()
);
create index prac_decisions_patient_idx on public.practitioner_decisions (patient_id, created_at desc);
create table public.risk_flags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  label text not null, detail text,
  severity text not null default 'monitor' check (severity in ('informational','monitor','practitioner_review_required','urgent_evaluation','emergency_instruction')),
  status text not null default 'active' check (status in ('active','resolved','dismissed')),
  source text not null default 'safety_engine',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index risk_flags_patient_idx on public.risk_flags (patient_id, status);

create table public.health_twin_systems (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  system text not null check (system in ('metabolic','cardiovascular','inflammatory_immune','hormonal','gastrointestinal','detoxification_exposure','mitochondrial_energy','cognitive_neurological','musculoskeletal','stress_autonomic','sleep_circadian','healthy_aging')),
  state text, trend text check (trend in ('improving','stable','worsening','unknown')),
  reasoning_strength int check (reasoning_strength between 0 and 100), data_quality text,
  supporting_fact_ids jsonb not null default '[]'::jsonb, contradicting_fact_ids jsonb not null default '[]'::jsonb,
  active_hypothesis_ids jsonb not null default '[]'::jsonb, active_intervention_ids jsonb not null default '[]'::jsonb,
  missing_data_ids jsonb not null default '[]'::jsonb, last_updated_at timestamptz not null default now(),
  practitioner_review_status text not null default 'unreviewed',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz,
  unique (patient_id, system)
);
create table public.health_twin_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  captured_at timestamptz not null default now(), systems jsonb not null default '{}'::jsonb,
  reasoning_snapshot_id uuid references public.reasoning_snapshots(id) on delete set null,
  created_at timestamptz not null default now()
);
create index health_twin_snapshots_patient_idx on public.health_twin_snapshots (patient_id, captured_at desc);

do $$ declare t text;
begin
  foreach t in array array['clinical_facts','clinical_hypotheses','evidence_items','contradictions',
    'missing_data_recommendations','clinical_relationships','reasoning_snapshots','reasoning_snapshot_items',
    'recommendations','practitioner_decisions','risk_flags','health_twin_systems','health_twin_snapshots']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_access on public.%I for all using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));', t, t);
  end loop;
  foreach t in array array['clinical_facts','clinical_hypotheses','evidence_items','contradictions',
    'missing_data_recommendations','clinical_relationships','recommendations','risk_flags','health_twin_systems']
  loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;
