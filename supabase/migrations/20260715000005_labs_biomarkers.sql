-- ============================================================
-- 0005 Labs & biomarkers
-- Global dictionary (no PHI) + org optimal ranges + patient lab data.
-- Original marker name / result / unit / reference interval are always
-- preserved on biomarker_observations (never overwritten), per spec.
-- Applied + verified against project urcjiehlxoehievobezf.
-- ============================================================

create table public.biomarker_definitions (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null, loinc text, default_unit text,
  biological_system text, specimen_type text, description text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.biomarker_aliases (
  id uuid primary key default gen_random_uuid(),
  biomarker_definition_id uuid not null references public.biomarker_definitions(id) on delete cascade,
  alias text not null, source text, created_at timestamptz not null default now()
);
create table public.reference_ranges (
  id uuid primary key default gen_random_uuid(),
  biomarker_definition_id uuid not null references public.biomarker_definitions(id) on delete cascade,
  sex text check (sex in ('male','female','any')) default 'any',
  age_min int, age_max int, range_low numeric, range_high numeric, unit text, source text,
  created_at timestamptz not null default now()
);
create table public.optimal_ranges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  biomarker_definition_id uuid not null references public.biomarker_definitions(id) on delete cascade,
  sex text check (sex in ('male','female','any')) default 'any',
  age_min int, age_max int, range_low numeric, range_high numeric, unit text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create trigger optimal_ranges_set_updated_at before update on public.optimal_ranges for each row execute function public.set_updated_at();

create table public.lab_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  file_name text not null, file_type text, file_size_bytes bigint, storage_path text not null,
  lab_company text, panel_name text, lab_date date, ordering_provider text,
  processing_status text not null default 'uploaded' check (processing_status in ('uploaded','processing','extracted','reviewed','failed')),
  uploaded_by uuid references auth.users(id),
  source text not null default 'upload', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.lab_panels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  lab_document_id uuid references public.lab_documents(id) on delete set null,
  name text, collected_at timestamptz, reported_at timestamptz,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.biomarker_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  biomarker_definition_id uuid references public.biomarker_definitions(id) on delete set null,
  lab_panel_id uuid references public.lab_panels(id) on delete set null,
  lab_document_id uuid references public.lab_documents(id) on delete set null,
  value_numeric numeric, value_text text, unit text,
  status text check (status in ('low','optimal','high','critical_low','critical_high','normal')),
  original_name text, original_value text, original_unit text, original_reference_interval text,
  source_page int,
  observed_at timestamptz not null default now(), ingested_at timestamptz not null default now(),
  data_quality text default 'measured', confidence numeric, provenance text,
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed','accepted','flagged','rejected')),
  reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
  source text not null default 'lab', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index biomarker_obs_patient_idx on public.biomarker_observations (patient_id, observed_at desc);
create index biomarker_obs_def_idx on public.biomarker_observations (biomarker_definition_id);
create table public.extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  lab_document_id uuid references public.lab_documents(id) on delete cascade,
  type text not null default 'lab_extraction',
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','needs_review')),
  progress numeric not null default 0, attempts int not null default 0, max_attempts int not null default 3,
  input_ref text, output_ref text, error_code text, safe_error_message text,
  started_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.extraction_fields (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  extraction_job_id uuid references public.extraction_jobs(id) on delete cascade,
  field_name text, raw_value text, normalized_value text, confidence numeric,
  bounding_box jsonb, page int, needs_review boolean not null default false,
  source text not null default 'extraction', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.extraction_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  extraction_field_id uuid references public.extraction_fields(id) on delete cascade,
  original_value text, corrected_value text, corrected_by uuid references auth.users(id), corrected_at timestamptz not null default now(),
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);

do $$ declare t text;
begin
  foreach t in array array['lab_documents','lab_panels','biomarker_observations','extraction_jobs','extraction_fields','extraction_corrections']
  loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t, t);
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_access on public.%I for all using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));', t, t);
  end loop;
  foreach t in array array['biomarker_definitions','biomarker_aliases','reference_ranges']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_read on public.%I for select using (auth.uid() is not null);', t, t);
  end loop;
end $$;

alter table public.optimal_ranges enable row level security;
create policy optimal_ranges_read on public.optimal_ranges for select using (private.is_org_member(organization_id));
create policy optimal_ranges_write on public.optimal_ranges for all
  using (private.is_org_admin(organization_id) or private.has_org_role(organization_id,'practitioner'))
  with check (private.is_org_admin(organization_id) or private.has_org_role(organization_id,'practitioner'));
