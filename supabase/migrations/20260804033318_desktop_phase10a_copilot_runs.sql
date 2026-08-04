-- Phase 10A: copilot run sub-tables + immutability trigger.
--
-- The main `clinical_copilot_runs` table already existed from an earlier
-- phase; this migration was a no-op on that table (create if not exists)
-- and successfully created the three sub-tables plus the initial trigger.
--
-- The Phase 10A columns on the main table + revised RPCs + updated trigger
-- land in the follow-up migration `20260804034620_desktop_phase10a_copilot_runs_extend`
-- so the two migrations together give the full Phase 10A shape.

create table if not exists public.clinical_copilot_run_inputs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.clinical_copilot_runs(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  input_kind text not null check (input_kind in
    ('demographics','goals','symptoms','encounter','medication','allergy',
     'diagnosis','lab_result','wearable_observation','current_protocol',
     'adherence','nutrition_plan','transcript_revision','differential_answer',
     'knowledge_reference','product_label','protocol_template','diet_template')),
  source_ref_type text not null,
  source_ref_id uuid not null,
  source_version text,
  effective_from date,
  effective_to date,
  completeness text not null default 'complete' check (completeness in
    ('complete','partial','missing')),
  has_conflict boolean not null default false,
  review_state text,
  recorded_at timestamptz not null default clock_timestamp()
);

create index if not exists clinical_copilot_run_inputs_run_idx
  on public.clinical_copilot_run_inputs(run_id);

alter table public.clinical_copilot_run_inputs enable row level security;
create policy clinical_copilot_run_inputs_read_org
  on public.clinical_copilot_run_inputs for select
  using (organization_id in (
    select organization_id from public.organization_memberships
    where user_id = (select auth.uid()) and status = 'active'
  ));

create table if not exists public.clinical_copilot_run_outputs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.clinical_copilot_runs(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  output_kind text not null check (output_kind in
    ('longitudinal_brief','differential_questions','lab_suggestions',
     'protocol_draft','practitioner_brief','safety_summary','missing_information')),
  content jsonb not null,
  content_sha256 text not null,
  safety_pinned boolean not null default false,
  citations_count integer not null default 0,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists clinical_copilot_run_outputs_run_idx
  on public.clinical_copilot_run_outputs(run_id);

alter table public.clinical_copilot_run_outputs enable row level security;
create policy clinical_copilot_run_outputs_read_org
  on public.clinical_copilot_run_outputs for select
  using (organization_id in (
    select organization_id from public.organization_memberships
    where user_id = (select auth.uid()) and status = 'active'
  ));

create table if not exists public.clinical_copilot_run_citations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.clinical_copilot_runs(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  citation_type text not null check (citation_type in
    ('knowledge_reference','product_label','protocol_template','diet_template')),
  citation_ref_id uuid not null,
  citation_version text,
  recorded_at timestamptz not null default clock_timestamp()
);

create index if not exists clinical_copilot_run_citations_run_idx
  on public.clinical_copilot_run_citations(run_id);

alter table public.clinical_copilot_run_citations enable row level security;
create policy clinical_copilot_run_citations_read_org
  on public.clinical_copilot_run_citations for select
  using (organization_id in (
    select organization_id from public.organization_memberships
    where user_id = (select auth.uid()) and status = 'active'
  ));
