-- ============================================================
-- 0007 Supplement Intelligence Network
-- Global product/ingredient knowledge (no PHI) + patient protocols/exposures.
-- Separates product-label facts, published evidence, general safety rules,
-- and patient-specific observations. Applied + verified (urcjiehlxoehievobezf).
-- ============================================================

create table public.supplement_brands (
  id uuid primary key default gen_random_uuid(), name text not null, website text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.supplement_products (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references public.supplement_brands(id) on delete set null,
  name text not null, form text, description text, image_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.supplement_product_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.supplement_products(id) on delete cascade,
  version_label text, serving_size text, servings_per_container int, label_image_url text,
  effective_from date, created_at timestamptz not null default now()
);
create table public.supplement_ingredients (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null, category text, form text, unit text, description text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.ingredient_aliases (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.supplement_ingredients(id) on delete cascade,
  alias text not null, source text, created_at timestamptz not null default now()
);
create table public.product_ingredient_amounts (
  id uuid primary key default gen_random_uuid(),
  product_version_id uuid not null references public.supplement_product_versions(id) on delete cascade,
  ingredient_id uuid not null references public.supplement_ingredients(id) on delete cascade,
  amount numeric, unit text, form text, created_at timestamptz not null default now()
);
create table public.ingredient_evidence (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.supplement_ingredients(id) on delete cascade,
  outcome text, evidence_type text, evidence_quality text, population text, dose text,
  publication_date date, review_date date, version text, deprecation_status text, citation text, summary text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.ingredient_interactions (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.supplement_ingredients(id) on delete cascade,
  interacts_with_type text not null check (interacts_with_type in ('medication','ingredient','condition')),
  interacts_with_ref text not null,
  severity text check (severity in ('minor','moderate','major')),
  mechanism text, notes text, version text, source text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.contraindications (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('ingredient','product','medication')),
  subject_ref text not null, condition text not null,
  severity text check (severity in ('absolute','relative','caution')), notes text, version text, source text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.nutrient_upper_limits (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid references public.supplement_ingredients(id) on delete cascade,
  nutrient text not null, sex text default 'any', age_min int, age_max int,
  upper_limit numeric, unit text, basis text, source text, created_at timestamptz not null default now()
);

create table public.supplement_protocols (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  name text not null, goal text,
  status text not null default 'active' check (status in ('draft','active','paused','completed')),
  approved_by uuid references auth.users(id), approved_at timestamptz,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.supplement_protocol_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  protocol_id uuid references public.supplement_protocols(id) on delete cascade,
  product_id uuid references public.supplement_products(id) on delete set null,
  ingredient_id uuid references public.supplement_ingredients(id) on delete set null,
  dose text, unit text, schedule text, timing text, purpose text,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.supplement_exposures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  protocol_item_id uuid references public.supplement_protocol_items(id) on delete set null,
  product_id uuid references public.supplement_products(id) on delete set null,
  taken_at timestamptz not null default now(), dose text, unit text,
  observed_at timestamptz not null default now(), ingested_at timestamptz not null default now(),
  data_quality text default 'reported', confidence numeric, provenance text,
  source text not null default 'patient_reported', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index supp_exp_patient_idx on public.supplement_exposures (patient_id, taken_at desc);
create table public.supplement_adherence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  protocol_id uuid references public.supplement_protocols(id) on delete set null,
  period_start date, period_end date, adherence_pct numeric,
  source text not null default 'derived',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);

do $$ declare t text;
begin
  foreach t in array array['supplement_brands','supplement_products','supplement_product_versions',
    'supplement_ingredients','ingredient_aliases','product_ingredient_amounts','ingredient_evidence',
    'ingredient_interactions','contraindications','nutrient_upper_limits']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_read on public.%I for select using (auth.uid() is not null);', t, t);
  end loop;
  foreach t in array array['supplement_protocols','supplement_protocol_items','supplement_exposures','supplement_adherence']
  loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t, t);
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_access on public.%I for all using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));', t, t);
  end loop;
end $$;
