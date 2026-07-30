-- desktop_owned_programs
--
-- STATUS: PREPARED, NOT YET APPLIED. The remote ledger ends at
-- 20260730052613 (verified this session); apply this file via the MCP
-- apply_migration flow, rename it to the recorded version, and run the
-- acceptance suite BEFORE building the RPC layer on top of it.
--
-- Makes the 0009 program skeleton real. EXTENDS the existing tables
-- (programs, program_versions, program_templates, program_enrollments)
-- rather than duplicating them, and adds the missing structure:
--
--   program_modules / program_lessons / program_blocks   ordered curriculum
--   program_offers                                        commercial terms only
--   program_progress                                      real per-enrollment progress
--   program_version_events                                append-only publication history
--   program_enrollment_events                             append-only enrollment history
--
-- Version lifecycle (per program_versions.status):
--   draft -> in_review -> approved -> published -> superseded
-- draft and in_review are editable; approval FREEZES content (trigger +
-- RPC); publishing exposes it and supersedes the previously published
-- version WITHOUT touching enrollments pinned to it. Corrections revise
-- into a new draft; nothing frozen is ever overwritten.
--
-- Enrollment lifecycle (per program_enrollments.status):
--   invited -> active -> paused|completed|cancelled|expired ; paused -> active
-- completed / cancelled / expired are terminal.
--
-- The legacy program_steps / program_conditions / program_tasks tables are
-- left untouched (no production callers); the jsonb `definition` columns
-- stay for compatibility and are not read by the new layer.

begin;

-- ------------------------------------------------------------ programs
alter table public.programs
  add column if not exists archived_at timestamptz,
  add column if not exists current_version_id uuid,
  add column if not exists published_version_id uuid;

-- ------------------------------------------------------ program_versions
alter table public.program_versions
  alter column program_id drop not null,
  add column if not exists template_id uuid references public.program_templates(id) on delete cascade,
  add column if not exists status text not null default 'draft',
  add column if not exists title text not null default '',
  add column if not exists summary text,
  add column if not exists audience text,
  add column if not exists disclaimer text,
  add column if not exists source_template_id uuid references public.program_templates(id) on delete set null,
  add column if not exists source_template_version integer,
  add column if not exists supersedes_version_id uuid references public.program_versions(id) on delete set null,
  add column if not exists review_note text,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references auth.users(id),
  add column if not exists published_by uuid references auth.users(id),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

alter table public.program_versions
  drop constraint if exists program_versions_status_check;
alter table public.program_versions
  add constraint program_versions_status_check
  check (status in ('draft','in_review','approved','published','superseded'));
-- A version belongs to a program XOR a template.
alter table public.program_versions
  drop constraint if exists program_versions_owner_check;
alter table public.program_versions
  add constraint program_versions_owner_check
  check ((program_id is not null)::int + (template_id is not null)::int = 1);

alter table public.programs
  drop constraint if exists programs_current_version_fkey,
  drop constraint if exists programs_published_version_fkey;
alter table public.programs
  add constraint programs_current_version_fkey
    foreign key (current_version_id) references public.program_versions(id) on delete set null,
  add constraint programs_published_version_fkey
    foreign key (published_version_id) references public.program_versions(id) on delete set null;

-- ------------------------------------------------------ program_templates
alter table public.program_templates
  add column if not exists description text,
  add column if not exists status text not null default 'draft',
  add column if not exists archived_at timestamptz,
  add column if not exists current_version_id uuid references public.program_versions(id) on delete set null,
  add column if not exists approved_version_id uuid references public.program_versions(id) on delete set null,
  add column if not exists approved_version integer,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id),
  add column if not exists deleted_at timestamptz;
alter table public.program_templates
  drop constraint if exists program_templates_status_check;
alter table public.program_templates
  add constraint program_templates_status_check
  check (status in ('draft','approved','archived'));

-- ------------------------------------------------- curriculum structure
create table if not exists public.program_modules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_id uuid not null references public.program_versions(id) on delete cascade,
  name text not null,
  summary text,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists public.program_lessons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_id uuid not null references public.program_versions(id) on delete cascade,
  module_id uuid not null references public.program_modules(id) on delete cascade,
  title text not null,
  summary text,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists public.program_blocks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_id uuid not null references public.program_versions(id) on delete cascade,
  lesson_id uuid not null references public.program_lessons(id) on delete cascade,
  kind text not null check (kind in
    ('text','image','video_url','document_link','quiz','check_in','resource')),
  title text,
  -- Bounded, kind-specific content validated by save_program_draft:
  --   text: {body} · image: {url, alt} · video_url: {url} ·
  --   document_link/resource: {url, label} · quiz: {questions:[{prompt,
  --   options[], answerIndex?}]} · check_in: {prompt, responseType}
  content jsonb not null default '{}'::jsonb,
  -- Commercial metadata only — never clinical evidence.
  is_commercial boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists program_modules_version_idx on public.program_modules (version_id, position);
create index if not exists program_modules_org_idx on public.program_modules (organization_id);
create index if not exists program_lessons_version_idx on public.program_lessons (version_id, position);
create index if not exists program_lessons_module_idx on public.program_lessons (module_id, position);
create index if not exists program_lessons_org_idx on public.program_lessons (organization_id);
create index if not exists program_blocks_version_idx on public.program_blocks (version_id, position);
create index if not exists program_blocks_lesson_idx on public.program_blocks (lesson_id, position);
create index if not exists program_blocks_org_idx on public.program_blocks (organization_id);
create index if not exists program_versions_template_idx on public.program_versions (template_id);
create index if not exists program_versions_source_template_idx on public.program_versions (source_template_id);
create index if not exists program_versions_supersedes_idx on public.program_versions (supersedes_version_id);
create index if not exists program_versions_approved_by_idx on public.program_versions (approved_by);
create index if not exists program_versions_published_by_idx on public.program_versions (published_by);
create index if not exists program_versions_created_by_idx on public.program_versions (created_by);
create index if not exists program_versions_updated_by_idx on public.program_versions (updated_by);
create index if not exists programs_current_version_idx on public.programs (current_version_id);
create index if not exists programs_published_version_idx on public.programs (published_version_id);
create index if not exists program_templates_current_version_idx on public.program_templates (current_version_id);
create index if not exists program_templates_approved_version_idx on public.program_templates (approved_version_id);
create index if not exists program_templates_created_by_idx on public.program_templates (created_by);
create index if not exists program_templates_updated_by_idx on public.program_templates (updated_by);

-- ------------------------------------------------------- program_offers
create table if not exists public.program_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  program_id uuid not null references public.programs(id) on delete cascade,
  name text not null,
  -- COMMERCIAL TERMS ONLY. Stored, never charged: no payment is processed
  -- by this application. payment_mode 'stripe' is a stored intent whose
  -- processing is NOT CONFIGURED; enrollment through it is refused.
  price_cents integer not null default 0 check (price_cents >= 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  access_duration_days integer check (access_duration_days > 0),
  payment_mode text not null default 'free'
    check (payment_mode in ('free','manual_comp','stripe')),
  enrollment_open boolean not null default true,
  status text not null default 'active' check (status in ('active','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);
create index if not exists program_offers_program_idx on public.program_offers (program_id);
create index if not exists program_offers_org_idx on public.program_offers (organization_id);
create index if not exists program_offers_created_by_idx on public.program_offers (created_by);
create index if not exists program_offers_updated_by_idx on public.program_offers (updated_by);

-- --------------------------------------------------- program_enrollments
alter table public.program_enrollments
  add column if not exists offer_id uuid references public.program_offers(id) on delete set null,
  add column if not exists comp_reason text,
  add column if not exists authorized_by uuid references auth.users(id),
  add column if not exists invited_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists status_reason text;
alter table public.program_enrollments
  drop constraint if exists program_enrollments_status_check;
alter table public.program_enrollments
  add constraint program_enrollments_status_check
  check (status in ('invited','active','paused','completed','cancelled','expired'));
create index if not exists program_enrollments_program_idx
  on public.program_enrollments (program_id, status);
create index if not exists program_enrollments_version_idx
  on public.program_enrollments (program_version_id);
create index if not exists program_enrollments_offer_idx
  on public.program_enrollments (offer_id);
create index if not exists program_enrollments_authorized_by_idx
  on public.program_enrollments (authorized_by);

-- ------------------------------------------------------ program_progress
create table if not exists public.program_progress (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  enrollment_id uuid not null references public.program_enrollments(id) on delete cascade,
  lesson_id uuid references public.program_lessons(id) on delete set null,
  block_id uuid references public.program_blocks(id) on delete set null,
  kind text not null check (kind in ('lesson_completed','check_in','quiz_response','adherence')),
  -- Bounded scalar payload (check-in answer, quiz selections). PHI-safe
  -- audit rows never carry it; it lives only in this RLS-guarded table.
  payload jsonb not null default '{}'::jsonb,
  completed_at timestamptz not null default now(),
  needs_review boolean not null default false,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  recorded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists program_progress_enrollment_idx
  on public.program_progress (enrollment_id, completed_at desc);
create index if not exists program_progress_patient_idx
  on public.program_progress (patient_id, completed_at desc);
create index if not exists program_progress_org_idx on public.program_progress (organization_id);
create index if not exists program_progress_lesson_idx on public.program_progress (lesson_id);
create index if not exists program_progress_block_idx on public.program_progress (block_id);
create index if not exists program_progress_reviewed_by_idx on public.program_progress (reviewed_by);
create index if not exists program_progress_recorded_by_idx on public.program_progress (recorded_by);

-- ------------------------------------------------- append-only histories
create table if not exists public.program_version_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_id uuid not null references public.program_versions(id) on delete cascade,
  from_status text,
  to_status text not null,
  note text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.program_enrollment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  enrollment_id uuid not null references public.program_enrollments(id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists program_version_events_version_idx
  on public.program_version_events (version_id, created_at);
create index if not exists program_version_events_org_idx
  on public.program_version_events (organization_id);
create index if not exists program_version_events_actor_idx
  on public.program_version_events (actor_user_id);
create index if not exists program_enrollment_events_enrollment_idx
  on public.program_enrollment_events (enrollment_id, created_at);
create index if not exists program_enrollment_events_org_idx
  on public.program_enrollment_events (organization_id);
create index if not exists program_enrollment_events_actor_idx
  on public.program_enrollment_events (actor_user_id);

-- ------------------------------------------------------------ immutability
-- Frozen content: once a version leaves the editable states, its row may only
-- change status/publication fields via RPCs, and its content rows may not
-- change at all. Same trigger pattern as the protocol tables.
create or replace function private.program_version_is_frozen(_version_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.program_versions v
    where v.id = _version_id
      and v.status in ('approved','published','superseded')
  );
$$;
revoke all on function private.program_version_is_frozen(uuid) from public, anon;
grant execute on function private.program_version_is_frozen(uuid) to authenticated, service_role;

create or replace function private.guard_frozen_program_version()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'program versions are append-only history and cannot be deleted'
      using errcode = '22023';
  end if;
  if old.status in ('approved','published','superseded') then
    -- Only the sanctioned lifecycle fields may move on a frozen version.
    if new.title is distinct from old.title
       or new.summary is distinct from old.summary
       or new.audience is distinct from old.audience
       or new.disclaimer is distinct from old.disclaimer
       or new.version is distinct from old.version
       or new.program_id is distinct from old.program_id
       or new.template_id is distinct from old.template_id
       or new.organization_id is distinct from old.organization_id then
      raise exception 'this program version is frozen; revise it into a new draft version'
        using errcode = '22023';
    end if;
    if new.status is distinct from old.status
       and not (
         (old.status = 'approved' and new.status = 'published')
         or (old.status = 'published' and new.status = 'superseded')
       ) then
      raise exception 'invalid status change for a frozen program version'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists guard_frozen_program_version on public.program_versions;
create trigger guard_frozen_program_version
  before update or delete on public.program_versions
  for each row execute function private.guard_frozen_program_version();

create or replace function private.guard_frozen_program_content()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare _vid uuid;
begin
  _vid := coalesce(new.version_id, old.version_id);
  if private.program_version_is_frozen(_vid) then
    raise exception 'this program version is frozen; revise it into a new draft version'
      using errcode = '22023';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists guard_frozen_program_modules on public.program_modules;
create trigger guard_frozen_program_modules
  before insert or update or delete on public.program_modules
  for each row execute function private.guard_frozen_program_content();
drop trigger if exists guard_frozen_program_lessons on public.program_lessons;
create trigger guard_frozen_program_lessons
  before insert or update or delete on public.program_lessons
  for each row execute function private.guard_frozen_program_content();
drop trigger if exists guard_frozen_program_blocks on public.program_blocks;
create trigger guard_frozen_program_blocks
  before insert or update or delete on public.program_blocks
  for each row execute function private.guard_frozen_program_content();

-- Progress is append-only apart from the practitioner review fields.
create or replace function private.guard_program_progress()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'program progress is append-only and cannot be deleted'
      using errcode = '22023';
  end if;
  if new.enrollment_id is distinct from old.enrollment_id
     or new.patient_id is distinct from old.patient_id
     or new.organization_id is distinct from old.organization_id
     or new.lesson_id is distinct from old.lesson_id
     or new.block_id is distinct from old.block_id
     or new.kind is distinct from old.kind
     or new.payload is distinct from old.payload
     or new.completed_at is distinct from old.completed_at
     or new.recorded_by is distinct from old.recorded_by then
    raise exception 'recorded progress cannot be rewritten; only its review fields may change'
      using errcode = '22023';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_program_progress on public.program_progress;
create trigger guard_program_progress
  before update or delete on public.program_progress
  for each row execute function private.guard_program_progress();

-- Event tables: strictly append-only.
create or replace function private.forbid_event_mutation()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'history events are append-only' using errcode = '22023';
end;
$$;
drop trigger if exists forbid_program_version_event_mutation on public.program_version_events;
create trigger forbid_program_version_event_mutation
  before update or delete on public.program_version_events
  for each row execute function private.forbid_event_mutation();
drop trigger if exists forbid_program_enrollment_event_mutation on public.program_enrollment_events;
create trigger forbid_program_enrollment_event_mutation
  before update or delete on public.program_enrollment_events
  for each row execute function private.forbid_event_mutation();

-- ------------------------------------------------------------------ RLS
-- Org-member read; all writes go through SECURITY DEFINER RPCs.
alter table public.program_modules enable row level security;
alter table public.program_lessons enable row level security;
alter table public.program_blocks enable row level security;
alter table public.program_offers enable row level security;
alter table public.program_progress enable row level security;
alter table public.program_version_events enable row level security;
alter table public.program_enrollment_events enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'program_modules','program_lessons','program_blocks','program_offers',
    'program_version_events','program_enrollment_events'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using (private.is_org_member(organization_id))',
      t || '_select', t);
    execute format(
      'revoke insert, update, delete on table public.%I from authenticated', t);
  end loop;
end $$;

-- Progress carries patient data: patient-access gated, not just membership.
drop policy if exists program_progress_select on public.program_progress;
create policy program_progress_select on public.program_progress
  for select using (private.can_access_patient(patient_id));
revoke insert, update, delete on table public.program_progress from authenticated;

-- Existing program tables: ensure RLS is on with an org-member select policy
-- (idempotent — replaces any earlier bulk policy), and close direct writes so
-- the RPC layer is the only writer.
alter table public.programs enable row level security;
alter table public.program_versions enable row level security;
alter table public.program_templates enable row level security;
alter table public.program_enrollments enable row level security;
do $$
declare t text;
begin
  foreach t in array array['programs','program_versions','program_templates'] loop
    execute format('drop policy if exists %I on public.%I', t || '_access', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using (private.is_org_member(organization_id))',
      t || '_select', t);
  end loop;
end $$;
-- Enrollments carry a patient reference: patient-access gated.
drop policy if exists program_enrollments_access on public.program_enrollments;
drop policy if exists program_enrollments_select on public.program_enrollments;
drop policy if exists program_enrollments_insert on public.program_enrollments;
drop policy if exists program_enrollments_update on public.program_enrollments;
drop policy if exists program_enrollments_delete on public.program_enrollments;
create policy program_enrollments_select on public.program_enrollments
  for select using (private.can_access_patient(patient_id) and deleted_at is null);
revoke insert, update, delete on table public.programs from authenticated;
revoke insert, update, delete on table public.program_versions from authenticated;
revoke insert, update, delete on table public.program_templates from authenticated;
revoke insert, update, delete on table public.program_enrollments from authenticated;

comment on column public.program_offers.price_cents is
  'Commercial term storage only. This application never processes a payment; Stripe mode is stored intent and renders "Not configured".';
comment on column public.program_blocks.is_commercial is
  'Marks a block (e.g. an affiliate/resource link) as commercial metadata. Commercial content never serves as clinical evidence.';

commit;
