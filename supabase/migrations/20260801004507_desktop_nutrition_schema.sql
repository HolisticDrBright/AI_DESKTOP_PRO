-- Phase 9A: nutrition, versioned diet templates & patient plans — SCHEMA.
--
-- REUSES rather than duplicates: `nutrition_targets` and `food_logs` (0011,
-- both verified empty) are EXTENDED in place instead of gaining parallel
-- tables, and the template lifecycle follows the same draft → in_review →
-- approved → published → superseded shape as protocols and programs.
--
-- Nothing here creates a protocol, supplement, product, program, order,
-- charge, message, or clinical note. `allergies`, `medications` and
-- `medication_exposures` are READ as safety inputs and never written.
--
-- Two immutability rules carry the clinical weight:
--   1. a PUBLISHED template version is frozen — its content cannot be edited,
--      only superseded, so a plan built from it keeps meaning;
--   2. an APPROVED or ACTIVE plan version is frozen — revision creates a NEW
--      draft version and the historical plan is never rewritten.
--
-- A patient plan is a DETACHED SNAPSHOT. It records which template version it
-- came from for provenance, but changing that template later never alters the
-- patient's plan.

begin;

-- ------------------------------------------------------------- helpers
--
-- Nutrition authoring is clinical work. `private.can_author_nutrition` is the
-- clinical-role gate; coaches, billing-only staff, and front desk cannot
-- author, approve, or activate a plan.

create or replace function private.can_author_nutrition(_org uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _org and m.user_id = auth.uid()
      and m.status = 'active' and m.role in ('owner', 'admin', 'practitioner')
  );
$$;

/** Approving or activating a plan is narrower still: never a coach. */
create or replace function private.can_approve_nutrition(_org uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _org and m.user_id = auth.uid()
      and m.status = 'active' and m.role in ('owner', 'admin', 'practitioner')
  );
$$;

-- ------------------------------------------------- organization templates

create table public.nutrition_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  slug text,
  -- the recognised dietary pattern this template expresses
  pattern text not null default 'custom' check (pattern in (
    'low_fodmap', 'aip', 'gaps_style', 'ketogenic', 'mediterranean',
    'low_carbohydrate', 'elimination_reintroduction', 'anti_inflammatory', 'custom'
  )),
  summary text,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),
  current_version_id uuid,
  -- starter templates shipped with the product are marked so a practitioner
  -- can tell authored-here from seeded-by-us at a glance
  is_starter boolean not null default false,
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  unique (organization_id, name)
);

create index nutrition_templates_org_idx on public.nutrition_templates (organization_id, status);
create index nutrition_templates_created_by_idx on public.nutrition_templates (created_by);
create index nutrition_templates_updated_by_idx on public.nutrition_templates (updated_by);

create table public.nutrition_template_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_id uuid not null references public.nutrition_templates(id) on delete cascade,
  version_number integer not null,
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'published', 'superseded', 'archived')),

  -- What this template is for, and the limits of that claim.
  purpose text,
  intended_use text,
  -- EVERY starter template ships with this true. A template is educational
  -- scaffolding; it is not individualized medical advice until a practitioner
  -- personalizes and approves a patient plan from it.
  requires_practitioner_review boolean not null default true,
  caution_populations text[] not null default '{}',
  prerequisites text[] not null default '{}',
  missing_information_required text[] not null default '{}',
  patient_education text,
  -- Distinguishing education from advice is a stated field, not an implication.
  education_vs_advice_note text,

  -- Evidence posture. `evidence_grade` may be set ONLY when a governed
  -- reference exists; there is a trigger below that enforces it.
  evidence_grade text check (evidence_grade in ('governed_reference', 'practitioner_experience', 'none')),
  evidence_summary text,

  -- Review metadata
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  published_at timestamptz,
  superseded_by_version_id uuid references public.nutrition_template_versions(id),

  source_note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (template_id, version_number)
);

create index nutrition_template_versions_tpl_idx
  on public.nutrition_template_versions (template_id, version_number desc);
create index nutrition_template_versions_org_idx
  on public.nutrition_template_versions (organization_id, status);
create index nutrition_template_versions_created_by_idx
  on public.nutrition_template_versions (created_by);
create index nutrition_template_versions_reviewed_by_idx
  on public.nutrition_template_versions (reviewed_by);
create index nutrition_template_versions_superseded_idx
  on public.nutrition_template_versions (superseded_by_version_id);

-- ------------------------------------------------------- patient plans

create table public.nutrition_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  title text not null,
  current_version_id uuid,
  -- lifecycle of the PLAN as a whole; individual versions carry their own
  status text not null default 'draft' check (status in (
    'draft', 'in_review', 'approved', 'active', 'paused',
    'completed', 'discontinued'
  )),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);

create index nutrition_plans_org_patient_idx
  on public.nutrition_plans (organization_id, patient_id);
create index nutrition_plans_status_idx on public.nutrition_plans (organization_id, status);
create index nutrition_plans_created_by_idx on public.nutrition_plans (created_by);
create index nutrition_plans_updated_by_idx on public.nutrition_plans (updated_by);
-- At most ONE active plan per patient: two live diets is a clinical hazard.
create unique index nutrition_plans_one_active_idx
  on public.nutrition_plans (organization_id, patient_id)
  where status = 'active';

create table public.nutrition_plan_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid not null references public.nutrition_plans(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  version_number integer not null,
  status text not null default 'draft' check (status in (
    'draft', 'in_review', 'approved', 'active', 'paused',
    'completed', 'discontinued', 'superseded'
  )),

  -- PROVENANCE ONLY. The plan is a detached snapshot: editing the source
  -- template later never changes this plan.
  source_template_id uuid references public.nutrition_templates(id),
  source_template_version_id uuid references public.nutrition_template_versions(id),
  source_template_name_snapshot text,
  source_template_version_snapshot integer,
  detached_at timestamptz not null default now(),

  goals text[] not null default '{}',
  practitioner_rationale text,
  patient_instructions text,
  meal_timing_guidance text,
  fasting_instructions text,

  -- Daily energy target with an EXPLICIT unit; there is no implied kcal.
  energy_target_value numeric,
  energy_target_unit text check (energy_target_unit in ('kcal', 'kJ')),

  -- Macros as amounts AND optional percentages. Percentages are optional
  -- because a plan may specify grams without committing to a split.
  protein_g numeric check (protein_g is null or protein_g >= 0),
  carbohydrate_g numeric check (carbohydrate_g is null or carbohydrate_g >= 0),
  fat_g numeric check (fat_g is null or fat_g >= 0),
  fiber_g numeric check (fiber_g is null or fiber_g >= 0),
  protein_pct numeric check (protein_pct is null or (protein_pct >= 0 and protein_pct <= 100)),
  carbohydrate_pct numeric check (carbohydrate_pct is null or (carbohydrate_pct >= 0 and carbohydrate_pct <= 100)),
  fat_pct numeric check (fat_pct is null or (fat_pct >= 0 and fat_pct <= 100)),

  -- lifecycle stamps
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  activated_at timestamptz,
  activated_by uuid references auth.users(id),
  paused_at timestamptz,
  completed_at timestamptz,
  discontinued_at timestamptz,
  discontinued_reason text,
  superseded_by_version_id uuid references public.nutrition_plan_versions(id),

  -- optimistic concurrency + autosave
  version integer not null default 1,
  autosaved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  unique (plan_id, version_number)
);

create index nutrition_plan_versions_plan_idx
  on public.nutrition_plan_versions (plan_id, version_number desc);
create index nutrition_plan_versions_org_patient_idx
  on public.nutrition_plan_versions (organization_id, patient_id);
create index nutrition_plan_versions_patient_idx on public.nutrition_plan_versions (patient_id);
create index nutrition_plan_versions_status_idx
  on public.nutrition_plan_versions (organization_id, status);
create index nutrition_plan_versions_src_tpl_idx
  on public.nutrition_plan_versions (source_template_id);
create index nutrition_plan_versions_src_tplver_idx
  on public.nutrition_plan_versions (source_template_version_id);
create index nutrition_plan_versions_approved_by_idx on public.nutrition_plan_versions (approved_by);
create index nutrition_plan_versions_activated_by_idx on public.nutrition_plan_versions (activated_by);
create index nutrition_plan_versions_created_by_idx on public.nutrition_plan_versions (created_by);
create index nutrition_plan_versions_updated_by_idx on public.nutrition_plan_versions (updated_by);
create index nutrition_plan_versions_superseded_idx
  on public.nutrition_plan_versions (superseded_by_version_id);

-- ------------------------------------- version content (template OR plan)
--
-- Content rows hang off EITHER a template version or a plan version. A check
-- constraint enforces exactly one owner, so a row can never be ambiguous and
-- copying a template into a plan is a genuine snapshot rather than a pointer.

create table public.nutrition_phases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_version_id uuid references public.nutrition_template_versions(id) on delete cascade,
  plan_version_id uuid references public.nutrition_plan_versions(id) on delete cascade,
  phase_number integer not null,
  name text not null,
  description text,
  -- Timing is EITHER relative (day offsets) or absolute (dates), never a
  -- silent mix that the UI would have to guess at.
  timing_mode text not null default 'relative'
    check (timing_mode in ('relative', 'absolute')),
  relative_start_day integer,
  relative_duration_days integer check (relative_duration_days is null or relative_duration_days > 0),
  absolute_start_date date,
  absolute_end_date date,
  reintroduction_guidance text,
  created_at timestamptz not null default now(),
  check ((template_version_id is null) <> (plan_version_id is null)),
  check (
    (timing_mode = 'relative' and absolute_start_date is null and absolute_end_date is null)
    or (timing_mode = 'absolute' and relative_start_day is null and relative_duration_days is null)
  )
);

create index nutrition_phases_tpl_idx on public.nutrition_phases (template_version_id, phase_number);
create index nutrition_phases_plan_idx on public.nutrition_phases (plan_version_id, phase_number);
create index nutrition_phases_org_idx on public.nutrition_phases (organization_id);

/** Food guidance: emphasize / include / limit / avoid / conditional. */
create table public.nutrition_food_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_version_id uuid references public.nutrition_template_versions(id) on delete cascade,
  plan_version_id uuid references public.nutrition_plan_versions(id) on delete cascade,
  phase_id uuid references public.nutrition_phases(id) on delete cascade,
  disposition text not null check (disposition in (
    'emphasize', 'include', 'limit', 'avoid', 'conditional'
  )),
  -- a category OR a specific food; both are legitimate guidance
  scope text not null default 'category' check (scope in ('category', 'specific_food')),
  label text not null,
  -- canonical identity WHERE AVAILABLE. Null is normal and honest; it does
  -- not mean the food is unrecognised, only that nothing canonical was linked.
  canonical_source text check (canonical_source in ('passio', 'internal')),
  canonical_id text,
  portion_guidance text,
  frequency_guidance text,
  preparation_guidance text,
  substitutions text[] not null default '{}',
  -- `conditional` guidance must say what it is conditional ON
  condition_note text,
  rationale text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  check ((template_version_id is null) <> (plan_version_id is null)),
  check (disposition <> 'conditional' or condition_note is not null)
);

create index nutrition_food_rules_tpl_idx
  on public.nutrition_food_rules (template_version_id, disposition, sort_order);
create index nutrition_food_rules_plan_idx
  on public.nutrition_food_rules (plan_version_id, disposition, sort_order);
create index nutrition_food_rules_phase_idx on public.nutrition_food_rules (phase_id);
create index nutrition_food_rules_org_idx on public.nutrition_food_rules (organization_id);

create table public.nutrition_meal_days (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_version_id uuid references public.nutrition_template_versions(id) on delete cascade,
  plan_version_id uuid references public.nutrition_plan_versions(id) on delete cascade,
  phase_id uuid references public.nutrition_phases(id) on delete cascade,
  day_number integer not null check (day_number > 0),
  label text,
  notes text,
  created_at timestamptz not null default now(),
  check ((template_version_id is null) <> (plan_version_id is null))
);

create index nutrition_meal_days_tpl_idx on public.nutrition_meal_days (template_version_id, day_number);
create index nutrition_meal_days_plan_idx on public.nutrition_meal_days (plan_version_id, day_number);
create index nutrition_meal_days_phase_idx on public.nutrition_meal_days (phase_id);
create index nutrition_meal_days_org_idx on public.nutrition_meal_days (organization_id);

create table public.nutrition_meals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  meal_day_id uuid not null references public.nutrition_meal_days(id) on delete cascade,
  meal_type text not null default 'meal' check (meal_type in (
    'breakfast', 'lunch', 'dinner', 'snack', 'meal', 'beverage'
  )),
  name text,
  time_of_day text,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index nutrition_meals_day_idx on public.nutrition_meals (meal_day_id, sort_order);
create index nutrition_meals_org_idx on public.nutrition_meals (organization_id);

create table public.nutrition_meal_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  meal_id uuid not null references public.nutrition_meals(id) on delete cascade,
  label text not null,
  quantity numeric check (quantity is null or quantity >= 0),
  -- Units are EXPLICIT. There is no implied gram.
  unit text,
  canonical_source text check (canonical_source in ('passio', 'internal')),
  canonical_id text,
  -- Nutrient values carried from a provider are labelled as provider data,
  -- never presented as the practice's own measurement.
  nutrient_source text check (nutrient_source in ('passio', 'practitioner_entered', 'unknown')),
  energy_value numeric,
  energy_unit text check (energy_unit in ('kcal', 'kJ')),
  protein_g numeric,
  carbohydrate_g numeric,
  fat_g numeric,
  fiber_g numeric,
  preparation_note text,
  substitutions text[] not null default '{}',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index nutrition_meal_items_meal_idx on public.nutrition_meal_items (meal_id, sort_order);
create index nutrition_meal_items_org_idx on public.nutrition_meal_items (organization_id);

create table public.nutrition_recipes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_version_id uuid references public.nutrition_template_versions(id) on delete cascade,
  plan_version_id uuid references public.nutrition_plan_versions(id) on delete cascade,
  name text not null,
  servings integer check (servings is null or servings > 0),
  ingredients text[] not null default '{}',
  method text,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  check ((template_version_id is null) <> (plan_version_id is null))
);

create index nutrition_recipes_tpl_idx on public.nutrition_recipes (template_version_id, sort_order);
create index nutrition_recipes_plan_idx on public.nutrition_recipes (plan_version_id, sort_order);
create index nutrition_recipes_org_idx on public.nutrition_recipes (organization_id);

create table public.nutrition_grocery_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_version_id uuid references public.nutrition_template_versions(id) on delete cascade,
  plan_version_id uuid references public.nutrition_plan_versions(id) on delete cascade,
  category text not null default 'other',
  label text not null,
  quantity_note text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  check ((template_version_id is null) <> (plan_version_id is null))
);

create index nutrition_grocery_tpl_idx on public.nutrition_grocery_items (template_version_id, category);
create index nutrition_grocery_plan_idx on public.nutrition_grocery_items (plan_version_id, category);
create index nutrition_grocery_org_idx on public.nutrition_grocery_items (organization_id);

-- ------------------------------------------------- patient constraints
--
-- What the patient can and cannot eat, and what shapes the plan practically.

create table public.nutrition_constraints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_version_id uuid not null references public.nutrition_plan_versions(id) on delete cascade,
  kind text not null check (kind in (
    'allergy', 'intolerance', 'preference', 'cultural', 'religious',
    'budget', 'cooking_ability', 'food_access', 'equipment', 'other'
  )),
  label text not null,
  detail text,
  severity text check (severity in ('mild', 'moderate', 'severe', 'life_threatening')),
  -- where this came from: a chart allergy, or told to us in the room
  source text not null default 'practitioner_entered' check (source in (
    'chart_allergy', 'chart_medication', 'patient_reported', 'practitioner_entered'
  )),
  source_record_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index nutrition_constraints_plan_idx on public.nutrition_constraints (plan_version_id, kind);
create index nutrition_constraints_org_idx on public.nutrition_constraints (organization_id);
create index nutrition_constraints_created_by_idx on public.nutrition_constraints (created_by);

-- ---------------------------------------------------- safety review gates
--
-- These are REVIEW GATES, not diagnoses. A flag says "a human must look at
-- this before approval", never "the patient has X".

create table public.nutrition_safety_flags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_version_id uuid not null references public.nutrition_plan_versions(id) on delete cascade,
  kind text not null check (kind in (
    'recorded_allergy', 'medication_food_interaction', 'pregnancy_or_lactation',
    'pediatric', 'kidney_impairment', 'liver_impairment',
    'diabetes_or_glucose_lowering', 'disordered_eating_risk',
    'underweight_or_unintended_loss', 'deficiency_risk',
    'conflicting_chart_information', 'missing_demographics',
    'missing_safety_information', 'extreme_or_inconsistent_targets'
  )),
  severity text not null default 'review' check (severity in ('review', 'blocking')),
  detail text not null,
  -- what raised it, so a practitioner can check the source
  evidence_ref text,
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'overridden', 'resolved')),
  -- an override is a documented clinical decision: identity, reason, time
  override_reason text,
  overridden_by uuid references auth.users(id),
  overridden_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check (status <> 'overridden'
         or (override_reason is not null and overridden_by is not null and overridden_at is not null))
);

create index nutrition_safety_flags_plan_idx
  on public.nutrition_safety_flags (plan_version_id, status);
create index nutrition_safety_flags_org_idx on public.nutrition_safety_flags (organization_id);
create index nutrition_safety_flags_overridden_by_idx
  on public.nutrition_safety_flags (overridden_by);

-- ------------------------------------------------------------ provenance

create table public.nutrition_provenance (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_version_id uuid references public.nutrition_template_versions(id) on delete cascade,
  plan_version_id uuid references public.nutrition_plan_versions(id) on delete cascade,
  kind text not null check (kind in (
    'governed_reference', 'chart_record', 'template_version', 'provider_lookup',
    'practitioner_statement', 'copilot_draft'
  )),
  label text not null,
  reference_id text,
  detail text,
  recorded_at timestamptz not null default now(),
  check ((template_version_id is null) <> (plan_version_id is null))
);

create index nutrition_provenance_tpl_idx on public.nutrition_provenance (template_version_id);
create index nutrition_provenance_plan_idx on public.nutrition_provenance (plan_version_id);
create index nutrition_provenance_org_idx on public.nutrition_provenance (organization_id);

-- ------------------------------------------------------------ amendments
--
-- A versioned practitioner amendment to an APPROVED plan: the plan itself
-- stays frozen, and the amendment is an append-only addition beside it.

create table public.nutrition_amendments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_version_id uuid not null references public.nutrition_plan_versions(id) on delete cascade,
  amendment_number integer not null,
  body text not null,
  reason text not null,
  authored_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (plan_version_id, amendment_number)
);

create index nutrition_amendments_plan_idx
  on public.nutrition_amendments (plan_version_id, amendment_number);
create index nutrition_amendments_org_idx on public.nutrition_amendments (organization_id);
create index nutrition_amendments_author_idx on public.nutrition_amendments (authored_by);

-- --------------------------------------------------- adherence & outcomes

create table public.nutrition_checkins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  plan_version_id uuid references public.nutrition_plan_versions(id) on delete set null,
  observed_on date not null,
  -- adherence to the written meal plan, and to the dietary pattern overall
  meal_plan_adherence_pct numeric check (meal_plan_adherence_pct is null
    or (meal_plan_adherence_pct >= 0 and meal_plan_adherence_pct <= 100)),
  diet_adherence_pct numeric check (diet_adherence_pct is null
    or (diet_adherence_pct >= 0 and diet_adherence_pct <= 100)),
  hunger_rating integer check (hunger_rating is null or (hunger_rating between 0 and 10)),
  satiety_rating integer check (satiety_rating is null or (satiety_rating between 0 and 10)),
  energy_rating integer check (energy_rating is null or (energy_rating between 0 and 10)),
  digestive_tolerance integer check (digestive_tolerance is null or (digestive_tolerance between 0 and 10)),
  symptoms text[] not null default '{}',
  patient_note text,
  -- optional measures ALREADY in the chart; nutrition never invents them
  weight_value numeric,
  weight_unit text check (weight_unit in ('kg', 'lb')),
  body_composition_note text,
  -- Adherence is NEVER inferred: a row must say where it came from.
  source text not null check (source in (
    'patient_reported', 'practitioner_recorded', 'imported_device', 'imported_app'
  )),
  source_record_id text,
  review_state text not null default 'unreviewed'
    check (review_state in ('unreviewed', 'reviewed', 'needs_followup')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (patient_id, observed_on, source)
);

create index nutrition_checkins_patient_idx
  on public.nutrition_checkins (organization_id, patient_id, observed_on desc);
create index nutrition_checkins_plan_idx on public.nutrition_checkins (plan_version_id);
create index nutrition_checkins_review_idx
  on public.nutrition_checkins (organization_id, review_state);
create index nutrition_checkins_reviewed_by_idx on public.nutrition_checkins (reviewed_by);
create index nutrition_checkins_created_by_idx on public.nutrition_checkins (created_by);

-- ------------------------------------------------------ append-only history

create table public.nutrition_plan_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid not null references public.nutrition_plans(id) on delete cascade,
  plan_version_id uuid references public.nutrition_plan_versions(id) on delete cascade,
  kind text not null,
  from_status text,
  to_status text,
  detail text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index nutrition_plan_events_plan_idx
  on public.nutrition_plan_events (plan_id, created_at desc);
create index nutrition_plan_events_version_idx on public.nutrition_plan_events (plan_version_id);
create index nutrition_plan_events_org_idx on public.nutrition_plan_events (organization_id);
create index nutrition_plan_events_actor_idx on public.nutrition_plan_events (actor_user_id);

create table public.nutrition_template_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_id uuid not null references public.nutrition_templates(id) on delete cascade,
  template_version_id uuid references public.nutrition_template_versions(id) on delete cascade,
  kind text not null,
  from_status text,
  to_status text,
  detail text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index nutrition_template_events_tpl_idx
  on public.nutrition_template_events (template_id, created_at desc);
create index nutrition_template_events_version_idx
  on public.nutrition_template_events (template_version_id);
create index nutrition_template_events_org_idx on public.nutrition_template_events (organization_id);
create index nutrition_template_events_actor_idx on public.nutrition_template_events (actor_user_id);

-- ------------------------------------------- provider lookup provenance
--
-- Every Passio response is recorded with its ORIGINAL payload hash, so a
-- normalized record can always be traced back to what the provider actually
-- said and when. No PHI is stored here.

create table public.nutrition_provider_lookups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'passio' check (provider = 'passio'),
  capability text not null check (capability in (
    'food_search', 'food_detail', 'barcode', 'nutrition_facts_scan',
    'image_recognition', 'recipe_calculation'
  )),
  -- the query is a FOOD TERM or barcode, never a patient identifier
  query_text text,
  provider_reference text,
  -- sha256 of the raw provider response: provenance without storing the body
  response_hash text not null,
  response_received_at timestamptz not null default now(),
  -- the provider's own data timestamp when it supplies one
  provider_data_timestamp timestamptz,
  normalized_label text,
  http_status integer,
  outcome text not null default 'ok' check (outcome in (
    'ok', 'not_found', 'rate_limited', 'timeout', 'refused', 'error'
  )),
  -- an image recognition result is NEVER confirmed until a human reviews it
  review_state text not null default 'not_required'
    check (review_state in ('not_required', 'awaiting_review', 'confirmed', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index nutrition_provider_lookups_org_idx
  on public.nutrition_provider_lookups (organization_id, created_at desc);
create index nutrition_provider_lookups_hash_idx
  on public.nutrition_provider_lookups (response_hash);
create index nutrition_provider_lookups_review_idx
  on public.nutrition_provider_lookups (organization_id, review_state);
create index nutrition_provider_lookups_reviewed_by_idx
  on public.nutrition_provider_lookups (reviewed_by);
create index nutrition_provider_lookups_created_by_idx
  on public.nutrition_provider_lookups (created_by);

-- ------------------------------------- EXTEND the 0011 skeleton in place

alter table public.nutrition_targets
  add column if not exists plan_version_id uuid references public.nutrition_plan_versions(id) on delete cascade,
  add column if not exists template_version_id uuid references public.nutrition_template_versions(id) on delete cascade,
  add column if not exists label text,
  add column if not exists minimum_value numeric,
  add column if not exists maximum_value numeric,
  add column if not exists rationale text;

create index if not exists nutrition_targets_plan_version_idx
  on public.nutrition_targets (plan_version_id);
create index if not exists nutrition_targets_template_version_idx
  on public.nutrition_targets (template_version_id);
create index if not exists nutrition_targets_patient_idx
  on public.nutrition_targets (patient_id);
create index if not exists nutrition_targets_org_idx
  on public.nutrition_targets (organization_id);
create index if not exists nutrition_targets_created_by_idx
  on public.nutrition_targets (created_by);
create index if not exists nutrition_targets_updated_by_idx
  on public.nutrition_targets (updated_by);

alter table public.food_logs
  add column if not exists plan_version_id uuid references public.nutrition_plan_versions(id) on delete set null,
  add column if not exists provider_lookup_id uuid references public.nutrition_provider_lookups(id),
  add column if not exists review_state text not null default 'not_required'
    check (review_state in ('not_required', 'awaiting_review', 'confirmed', 'rejected'));

create index if not exists food_logs_plan_version_idx on public.food_logs (plan_version_id);
create index if not exists food_logs_provider_lookup_idx on public.food_logs (provider_lookup_id);
create index if not exists food_logs_patient_idx on public.food_logs (organization_id, patient_id, observed_at desc);
create index if not exists food_logs_created_by_idx on public.food_logs (created_by);
create index if not exists food_logs_updated_by_idx on public.food_logs (updated_by);

-- ---------------------------------------------------------- immutability

create or replace function private.nutrition_append_only()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'append-only: % rows cannot be modified or deleted', tg_table_name
    using errcode = '42501';
end;
$$;

create trigger nutrition_plan_events_append_only
  before update or delete on public.nutrition_plan_events
  for each row execute function private.nutrition_append_only();
create trigger nutrition_template_events_append_only
  before update or delete on public.nutrition_template_events
  for each row execute function private.nutrition_append_only();
create trigger nutrition_amendments_append_only
  before update or delete on public.nutrition_amendments
  for each row execute function private.nutrition_append_only();
create trigger nutrition_provenance_append_only
  before update or delete on public.nutrition_provenance
  for each row execute function private.nutrition_append_only();
create trigger nutrition_provider_lookups_append_only
  before delete on public.nutrition_provider_lookups
  for each row execute function private.nutrition_append_only();

/**
 * A PUBLISHED template version is frozen. Only its status may move onward
 * (to superseded or archived), so a plan built from it keeps its meaning.
 */
create or replace function private.nutrition_template_version_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.status in ('published', 'superseded', 'archived') then
    if new.purpose is distinct from old.purpose
       or new.intended_use is distinct from old.intended_use
       or new.patient_education is distinct from old.patient_education
       or new.evidence_grade is distinct from old.evidence_grade
       or new.evidence_summary is distinct from old.evidence_summary
       or new.version_number is distinct from old.version_number
       or new.requires_practitioner_review is distinct from old.requires_practitioner_review then
      raise exception 'a published template version is immutable' using errcode = '42501';
    end if;
    if new.status = 'draft' or new.status = 'in_review' then
      raise exception 'a published template version cannot return to draft'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger nutrition_template_versions_protect
  before update on public.nutrition_template_versions
  for each row execute function private.nutrition_template_version_protect();

/**
 * An APPROVED or ACTIVE plan version is frozen. Lifecycle stamps may still be
 * set (activate, pause, complete, discontinue, supersede) but the clinical
 * content cannot change — revision creates a NEW draft version instead.
 */
create or replace function private.nutrition_plan_version_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.status in ('approved', 'active', 'paused', 'completed', 'discontinued', 'superseded') then
    if new.goals is distinct from old.goals
       or new.practitioner_rationale is distinct from old.practitioner_rationale
       or new.patient_instructions is distinct from old.patient_instructions
       or new.meal_timing_guidance is distinct from old.meal_timing_guidance
       or new.fasting_instructions is distinct from old.fasting_instructions
       or new.energy_target_value is distinct from old.energy_target_value
       or new.energy_target_unit is distinct from old.energy_target_unit
       or new.protein_g is distinct from old.protein_g
       or new.carbohydrate_g is distinct from old.carbohydrate_g
       or new.fat_g is distinct from old.fat_g
       or new.version_number is distinct from old.version_number
       or new.source_template_version_id is distinct from old.source_template_version_id then
      raise exception 'an approved or active plan version is immutable; revise into a new draft'
        using errcode = '42501';
    end if;
    if new.status in ('draft', 'in_review') then
      raise exception 'an approved plan version cannot return to draft' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger nutrition_plan_versions_protect
  before update on public.nutrition_plan_versions
  for each row execute function private.nutrition_plan_version_protect();

/**
 * Content rows belonging to a FROZEN owner cannot change either — otherwise a
 * plan could be edited underneath its own immutability guarantee.
 */
create or replace function private.nutrition_content_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare _frozen boolean := false; _pv uuid; _tv uuid;
begin
  _pv := coalesce(new.plan_version_id, old.plan_version_id);
  _tv := coalesce(new.template_version_id, old.template_version_id);

  if _pv is not null then
    select status in ('approved','active','paused','completed','discontinued','superseded')
      into _frozen from public.nutrition_plan_versions where id = _pv;
  elsif _tv is not null then
    select status in ('published','superseded','archived')
      into _frozen from public.nutrition_template_versions where id = _tv;
  end if;

  if coalesce(_frozen, false) then
    raise exception 'the content of a frozen version cannot be changed'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger nutrition_phases_content_protect
  before update or delete on public.nutrition_phases
  for each row execute function private.nutrition_content_protect();
create trigger nutrition_food_rules_content_protect
  before update or delete on public.nutrition_food_rules
  for each row execute function private.nutrition_content_protect();
create trigger nutrition_meal_days_content_protect
  before update or delete on public.nutrition_meal_days
  for each row execute function private.nutrition_content_protect();
create trigger nutrition_recipes_content_protect
  before update or delete on public.nutrition_recipes
  for each row execute function private.nutrition_content_protect();
create trigger nutrition_grocery_content_protect
  before update or delete on public.nutrition_grocery_items
  for each row execute function private.nutrition_content_protect();

/**
 * Meals and meal items own no version column of their own — they reach their
 * version through a meal day. Without this they would be the one editable
 * seam in a frozen plan, so they get the same rule by traversal.
 */
create or replace function private.nutrition_meal_content_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare _day uuid; _frozen boolean;
begin
  if tg_table_name = 'nutrition_meals' then
    _day := coalesce(new.meal_day_id, old.meal_day_id);
  else
    select m.meal_day_id into _day from public.nutrition_meals m
      where m.id = coalesce(new.meal_id, old.meal_id);
  end if;

  select coalesce(
    (select pv.status in ('approved','active','paused','completed','discontinued','superseded')
       from public.nutrition_plan_versions pv where pv.id = d.plan_version_id),
    (select tv.status in ('published','superseded','archived')
       from public.nutrition_template_versions tv where tv.id = d.template_version_id)
  ) into _frozen
  from public.nutrition_meal_days d where d.id = _day;

  if coalesce(_frozen, false) then
    raise exception 'the content of a frozen version cannot be changed'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger nutrition_meals_content_protect
  before update or delete on public.nutrition_meals
  for each row execute function private.nutrition_meal_content_protect();
create trigger nutrition_meal_items_content_protect
  before update or delete on public.nutrition_meal_items
  for each row execute function private.nutrition_meal_content_protect();

/**
 * `evidence_grade = 'governed_reference'` may be claimed ONLY when a governed
 * reference row actually backs it. A template is not "evidence-based" because
 * someone typed that it was.
 */
create or replace function private.nutrition_evidence_guard()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.evidence_grade = 'governed_reference' then
    if not exists (
      select 1 from public.nutrition_provenance p
      where p.template_version_id = new.id and p.kind = 'governed_reference'
    ) then
      raise exception 'a governed-reference evidence grade needs an actual governed reference'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

create constraint trigger nutrition_template_evidence_guard
  after insert or update on public.nutrition_template_versions
  deferrable initially deferred
  for each row execute function private.nutrition_evidence_guard();

-- ------------------------------------------------------------------- RLS

alter table public.nutrition_templates enable row level security;
alter table public.nutrition_template_versions enable row level security;
alter table public.nutrition_plans enable row level security;
alter table public.nutrition_plan_versions enable row level security;
alter table public.nutrition_phases enable row level security;
alter table public.nutrition_food_rules enable row level security;
alter table public.nutrition_meal_days enable row level security;
alter table public.nutrition_meals enable row level security;
alter table public.nutrition_meal_items enable row level security;
alter table public.nutrition_recipes enable row level security;
alter table public.nutrition_grocery_items enable row level security;
alter table public.nutrition_constraints enable row level security;
alter table public.nutrition_safety_flags enable row level security;
alter table public.nutrition_provenance enable row level security;
alter table public.nutrition_amendments enable row level security;
alter table public.nutrition_checkins enable row level security;
alter table public.nutrition_plan_events enable row level security;
alter table public.nutrition_template_events enable row level security;
alter table public.nutrition_provider_lookups enable row level security;

-- Org-scoped, non-patient content: membership is enough to READ.
create policy nutrition_templates_select on public.nutrition_templates
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_template_versions_select on public.nutrition_template_versions
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_template_events_select on public.nutrition_template_events
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_provider_lookups_select on public.nutrition_provider_lookups
  for select to authenticated using (private.is_org_member(organization_id));

-- Patient-scoped content additionally requires patient access.
create policy nutrition_plans_select on public.nutrition_plans
  for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy nutrition_plan_versions_select on public.nutrition_plan_versions
  for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy nutrition_checkins_select on public.nutrition_checkins
  for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));

-- Content rows inherit their owner's visibility through the RPC layer; direct
-- reads are membership-scoped, and every write goes through a definer RPC.
create policy nutrition_phases_select on public.nutrition_phases
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_food_rules_select on public.nutrition_food_rules
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_meal_days_select on public.nutrition_meal_days
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_meals_select on public.nutrition_meals
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_meal_items_select on public.nutrition_meal_items
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_recipes_select on public.nutrition_recipes
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_grocery_items_select on public.nutrition_grocery_items
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_constraints_select on public.nutrition_constraints
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_safety_flags_select on public.nutrition_safety_flags
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_provenance_select on public.nutrition_provenance
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_amendments_select on public.nutrition_amendments
  for select to authenticated using (private.is_org_member(organization_id));
create policy nutrition_plan_events_select on public.nutrition_plan_events
  for select to authenticated using (private.is_org_member(organization_id));

-- Every write goes through a SECURITY DEFINER RPC.
revoke insert, update, delete on
  public.nutrition_templates, public.nutrition_template_versions,
  public.nutrition_plans, public.nutrition_plan_versions,
  public.nutrition_phases, public.nutrition_food_rules,
  public.nutrition_meal_days, public.nutrition_meals, public.nutrition_meal_items,
  public.nutrition_recipes, public.nutrition_grocery_items,
  public.nutrition_constraints, public.nutrition_safety_flags,
  public.nutrition_provenance, public.nutrition_amendments,
  public.nutrition_checkins, public.nutrition_plan_events,
  public.nutrition_template_events, public.nutrition_provider_lookups,
  public.nutrition_targets, public.food_logs
from anon, authenticated;

revoke all on function private.nutrition_append_only() from public, anon, authenticated;
revoke all on function private.nutrition_template_version_protect() from public, anon, authenticated;
revoke all on function private.nutrition_plan_version_protect() from public, anon, authenticated;
revoke all on function private.nutrition_content_protect() from public, anon, authenticated;
revoke all on function private.nutrition_meal_content_protect() from public, anon, authenticated;
revoke all on function private.nutrition_evidence_guard() from public, anon, authenticated;
revoke all on function private.can_author_nutrition(uuid) from public, anon;
revoke all on function private.can_approve_nutrition(uuid) from public, anon;

commit;
