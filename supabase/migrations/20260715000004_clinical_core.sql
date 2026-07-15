-- ============================================================
-- 0004 Clinical core (patient-scoped records)
-- Every table is patient-scoped and guarded by a single
-- private.can_access_patient(patient_id) policy for ALL commands.
-- Applied + verified against project urcjiehlxoehievobezf.
-- ============================================================

create table public.health_goals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  title text not null, description text, category text,
  status text not null default 'active' check (status in ('active','achieved','paused','abandoned')),
  target_date date, priority int,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.conditions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  name text not null, icd10 text, category text,
  status text not null default 'active' check (status in ('active','resolved','inactive','suspected')),
  onset_date date, resolved_date date, notes text,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.symptoms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  name text not null, body_system text, notes text,
  status text not null default 'active' check (status in ('active','resolved','monitoring')),
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.symptom_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  symptom_id uuid references public.symptoms(id) on delete set null,
  severity numeric, unit text, value_text text,
  observed_at timestamptz not null default now(), ingested_at timestamptz not null default now(),
  data_quality text default 'reported', confidence numeric, provenance text,
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed','accepted','flagged','rejected')),
  reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
  source text not null default 'patient_reported', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index symptom_obs_patient_idx on public.symptom_observations (patient_id, observed_at desc);
create table public.allergies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  allergen text not null, reaction text,
  severity text check (severity in ('mild','moderate','severe','life_threatening')),
  status text not null default 'active' check (status in ('active','inactive','resolved')),
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.medications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  name text not null, rxnorm text, dose text, route text, frequency text, prescriber text,
  status text not null default 'active' check (status in ('active','discontinued','completed')),
  start_date date, end_date date,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.medication_exposures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  medication_id uuid references public.medications(id) on delete set null,
  taken_at timestamptz not null default now(), dose text, adherence text,
  observed_at timestamptz not null default now(), ingested_at timestamptz not null default now(),
  data_quality text default 'reported', confidence numeric, provenance text,
  source text not null default 'patient_reported', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index med_exp_patient_idx on public.medication_exposures (patient_id, taken_at desc);
create table public.procedures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  name text not null, cpt text, performed_on date, performer text, notes text,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.family_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  relation text not null, condition text not null, age_of_onset int, notes text,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.lifestyle_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  domain text not null, value_numeric numeric, value_text text, unit text,
  observed_at timestamptz not null default now(), ingested_at timestamptz not null default now(),
  data_quality text default 'reported', confidence numeric, provenance text,
  source text not null default 'patient_reported', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index lifestyle_obs_patient_idx on public.lifestyle_observations (patient_id, observed_at desc);
create table public.environmental_exposures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  exposure_type text not null, description text, value_numeric numeric, unit text,
  observed_at timestamptz not null default now(), ingested_at timestamptz not null default now(),
  data_quality text default 'reported', confidence numeric, provenance text,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.encounters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  practitioner_user_id uuid references auth.users(id) on delete set null,
  encounter_type text, status text not null default 'planned' check (status in ('planned','in_progress','completed','cancelled')),
  scheduled_at timestamptz, started_at timestamptz, ended_at timestamptz, reason text, summary text,
  signed_at timestamptz, signed_by uuid references auth.users(id),
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index encounters_patient_idx on public.encounters (patient_id, scheduled_at desc);
create table public.clinical_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  encounter_id uuid references public.encounters(id) on delete set null,
  author_user_id uuid references auth.users(id) on delete set null,
  note_type text, body text, is_signed boolean not null default false,
  signed_at timestamptz, signed_by uuid references auth.users(id),
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index clinical_notes_patient_idx on public.clinical_notes (patient_id, created_at desc);
create table public.patient_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  body text not null, pinned boolean not null default false,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);

do $$ declare t text;
begin
  foreach t in array array['health_goals','conditions','symptoms','symptom_observations','allergies',
    'medications','medication_exposures','procedures','family_history','lifestyle_observations',
    'environmental_exposures','encounters','clinical_notes','patient_notes']
  loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t, t);
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_access on public.%I for all using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));', t, t);
  end loop;
end $$;
