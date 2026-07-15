-- ============================================================
-- 0009 Operations, programs, assessments
-- RLS categories: patient-scoped (can_access_patient); org+optional-patient
-- (is_org_member AND (patient_id is null OR can_access_patient)); org
-- templates (member read, admin/practitioner write); user-scoped notifications.
-- Applied + verified against project urcjiehlxoehievobezf.
-- ============================================================

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete cascade,
  practitioner_user_id uuid references auth.users(id) on delete set null,
  title text, appointment_type text, location text, telehealth_url text,
  status text not null default 'scheduled' check (status in ('scheduled','confirmed','completed','cancelled','no_show')),
  starts_at timestamptz, ends_at timestamptz,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index appointments_patient_idx on public.appointments (patient_id, starts_at desc);
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  title text not null, detail text,
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  status text not null default 'open' check (status in ('open','in_progress','done','snoozed','cancelled')),
  due_at timestamptz, category text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index tasks_org_idx on public.tasks (organization_id, status);
create table public.task_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  assignee_user_id uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  subject text, status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  sender_user_id uuid references auth.users(id) on delete set null,
  body text, is_from_patient boolean not null default false, read_at timestamptz,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text, body text, category text, read_at timestamptz, action_url text,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create table public.files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  file_name text not null, mime_type text, size_bytes bigint, storage_path text not null, category text,
  source text not null default 'upload', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, color text, created_at timestamptz not null default now(),
  unique (organization_id, name)
);
create table public.patient_tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  created_at timestamptz not null default now(), created_by uuid references auth.users(id),
  unique (patient_id, tag_id)
);
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null, kind text, status text not null default 'disconnected',
  config jsonb not null default '{}'::jsonb, last_sync_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create table public.integration_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid references public.integrations(id) on delete cascade,
  status text not null default 'queued', started_at timestamptz, completed_at timestamptz,
  error_code text, safe_error_message text, created_at timestamptz not null default now()
);
create table public.programs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, description text, status text not null default 'draft' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.program_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  program_id uuid not null references public.programs(id) on delete cascade,
  version int not null default 1, definition jsonb not null default '{}'::jsonb, published_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.program_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, definition jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.program_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  program_version_id uuid references public.program_versions(id) on delete cascade,
  step_type text, title text, config jsonb not null default '{}'::jsonb, relative_day int, sequence int,
  created_at timestamptz not null default now()
);
create table public.program_conditions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  program_step_id uuid references public.program_steps(id) on delete cascade,
  expression jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.program_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  program_step_id uuid references public.program_steps(id) on delete cascade,
  title text, config jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.educational_content (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null, body text, media_url text, category text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, body text not null, channel text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.program_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  program_id uuid references public.programs(id) on delete set null,
  program_version_id uuid references public.program_versions(id) on delete set null,
  status text not null default 'active' check (status in ('active','completed','paused','cancelled')),
  enrolled_at timestamptz not null default now(), completed_at timestamptz,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.assessment_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, description text, category text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.assessment_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_id uuid not null references public.assessment_templates(id) on delete cascade,
  version int not null default 1, published_at timestamptz, created_at timestamptz not null default now()
);
create table public.assessment_sections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_id uuid references public.assessment_versions(id) on delete cascade,
  title text, sequence int, created_at timestamptz not null default now()
);
create table public.assessment_questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  section_id uuid references public.assessment_sections(id) on delete cascade,
  prompt text not null, question_type text, options jsonb, required boolean not null default false,
  calculation jsonb, sequence int, created_at timestamptz not null default now()
);
create table public.assessment_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_id uuid references public.assessment_versions(id) on delete cascade,
  rule_type text, expression jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.assessment_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  version_id uuid references public.assessment_versions(id) on delete set null,
  status text not null default 'assigned' check (status in ('assigned','in_progress','completed','reviewed')),
  due_at timestamptz, assigned_by uuid references auth.users(id),
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.assessment_responses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  assignment_id uuid references public.assessment_assignments(id) on delete cascade,
  question_id uuid references public.assessment_questions(id) on delete set null,
  answer jsonb, answered_at timestamptz not null default now(),
  source text not null default 'patient_reported', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.assessment_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  assignment_id uuid references public.assessment_assignments(id) on delete cascade,
  score_name text, score_value numeric, interpretation text, computed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

do $$ declare t text;
begin
  foreach t in array array['program_enrollments','assessment_assignments','assessment_responses','assessment_scores','patient_tags']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_access on public.%I for all using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));', t, t);
  end loop;
  foreach t in array array['appointments','tasks','conversations','messages','files']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($f$create policy %I_access on public.%I for all using (private.is_org_member(organization_id) and (patient_id is null or private.can_access_patient(patient_id))) with check (private.is_org_member(organization_id) and (patient_id is null or private.can_access_patient(patient_id)));$f$, t, t);
  end loop;
  foreach t in array array['task_assignments','integration_sync_jobs']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_member on public.%I for all using (private.is_org_member(organization_id)) with check (private.is_org_member(organization_id));', t, t);
  end loop;
  foreach t in array array['tags','integrations','programs','program_versions','program_templates','program_steps',
    'program_conditions','program_tasks','educational_content','message_templates','assessment_templates',
    'assessment_versions','assessment_sections','assessment_questions','assessment_rules']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_read on public.%I for select using (private.is_org_member(organization_id));', t, t);
    execute format($f$create policy %I_write on public.%I for all using (private.is_org_admin(organization_id) or private.has_org_role(organization_id,'practitioner')) with check (private.is_org_admin(organization_id) or private.has_org_role(organization_id,'practitioner'));$f$, t, t);
  end loop;
  foreach t in array array['appointments','tasks','conversations','files','programs','educational_content',
    'message_templates','program_enrollments','assessment_templates','assessment_assignments','assessment_responses','integrations']
  loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;

alter table public.notifications enable row level security;
create policy notifications_own on public.notifications for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
