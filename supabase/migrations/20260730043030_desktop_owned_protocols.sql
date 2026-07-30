-- desktop_owned_protocols
--
-- Phase 2 slice 2: versioned patient protocols + organization-owned protocol
-- templates, Desktop-owned and immutable once approved.
--
-- WHY NEW TABLES. `supplement_protocols` (migration 0007) is a flat,
-- single-version supplement list with no phases, no version history, no
-- template lineage, and no immutability. Clinical instructions that a
-- practitioner approves must never be silently overwritten, so this slice owns
-- its own model rather than bending that one:
--
--   protocols                 the per-patient container (identity + lifecycle)
--   protocol_versions         APPEND-ONLY versions; approved/active are frozen
--   protocol_phases           named phases with absolute dates OR relative day
--                             offsets (never both invented)
--   protocol_items            products/diet/lifestyle/monitoring/follow-up
--                             entries, each carrying its own exact catalog
--                             reference + verification status
--   protocol_templates        org-owned reusable templates (versioned, same
--                             immutability rules, archivable)
--
-- IMMUTABILITY RULES (enforced by trigger + RPC, not convention):
--   * A version in status 'approved' or 'active' cannot have its clinical
--     content changed, and its phases/items cannot be inserted, updated, or
--     deleted. Corrections create a NEW draft version.
--   * Version numbers are contiguous per protocol and never reused.
--   * Superseding never deletes: prior versions stay readable forever.
--
-- SAFETY RULES encoded here:
--   * Activation is an explicit, separately-permissioned RPC. No protocol
--     becomes active as a side effect of approval, editing, or template use.
--   * Nothing in this slice sends a patient message, places an order, charges
--     anyone, modifies medications, or writes into a note. There is
--     deliberately no column or code path that could.
--   * Products record exact identity (product id, manufacturer, label
--     version) plus `verification_status`. Absent verified structured data the
--     value stays 'unverified' and the UI must say "Interaction review not
--     completed" — this slice never asserts interaction-free.
--   * `affiliate_url` is commercial metadata only, documented as carrying no
--     clinical meaning whatsoever.

begin;

-- ------------------------------------------------------------- containers
create table if not exists public.protocols (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  title text not null,
  -- Lifecycle of the PROTOCOL (its versions carry their own status):
  --   draft      no approved version yet
  --   active     an approved version is in effect
  --   paused     active version temporarily suspended
  --   completed  course finished
  --   discontinued  stopped deliberately
  status text not null default 'draft'
    check (status in ('draft','active','paused','completed','discontinued')),
  current_version_id uuid,
  active_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz
);
create index if not exists protocols_patient_idx
  on public.protocols (patient_id, created_at desc);
create index if not exists protocols_org_idx on public.protocols (organization_id);

create table if not exists public.protocol_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'draft'
    check (status in ('draft','approved','archived')),
  -- Templates are versioned the same way protocols are: the rows below point
  -- at a template version, and approving freezes it.
  current_version_id uuid,
  approved_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  archived_at timestamptz,
  deleted_at timestamptz
);
create index if not exists protocol_templates_org_idx
  on public.protocol_templates (organization_id, status);

comment on table public.protocol_templates is
  'Organization-owned reusable protocol templates. Archiving a template never affects protocols already created from it — lineage is recorded on the protocol version, not borrowed from the template.';

-- ------------------------------------------------------------- versions
create table if not exists public.protocol_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Exactly one of protocol_id / template_id is set: the same version model
  -- serves patient protocols and org templates, with one immutability rule.
  protocol_id uuid references public.protocols(id) on delete cascade,
  template_id uuid references public.protocol_templates(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete cascade,
  version integer not null,
  status text not null default 'draft'
    check (status in ('draft','approved','active','superseded','discontinued')),
  title text not null,
  summary text,
  -- Free-text clinical sections. Separate columns (not one blob) so each is
  -- independently reviewable and diffable across versions.
  diet_instructions text,
  lifestyle_instructions text,
  monitoring_plan text,
  followup_plan text,
  -- Provenance: which template version this draft was copied from, if any.
  source_template_id uuid references public.protocol_templates(id) on delete set null,
  source_template_version integer,
  supersedes_version_id uuid references public.protocol_versions(id) on delete set null,
  -- Review + activation are distinct, separately-stamped events.
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  activated_by uuid references auth.users(id),
  activated_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  constraint protocol_versions_owner_check check (
    (protocol_id is not null and template_id is null and patient_id is not null)
    or (template_id is not null and protocol_id is null and patient_id is null)
  )
);
create unique index if not exists protocol_versions_protocol_no_idx
  on public.protocol_versions (protocol_id, version) where protocol_id is not null;
create unique index if not exists protocol_versions_template_no_idx
  on public.protocol_versions (template_id, version) where template_id is not null;
create index if not exists protocol_versions_protocol_idx
  on public.protocol_versions (protocol_id, version desc);
create index if not exists protocol_versions_template_idx
  on public.protocol_versions (template_id, version desc);
create index if not exists protocol_versions_org_idx
  on public.protocol_versions (organization_id);
create index if not exists protocol_versions_patient_idx
  on public.protocol_versions (patient_id);
create index if not exists protocol_versions_source_template_idx
  on public.protocol_versions (source_template_id);
create index if not exists protocol_versions_supersedes_idx
  on public.protocol_versions (supersedes_version_id);
create index if not exists protocol_versions_approved_by_idx
  on public.protocol_versions (approved_by);
create index if not exists protocol_versions_activated_by_idx
  on public.protocol_versions (activated_by);

comment on table public.protocol_versions is
  'Append-only protocol/template versions. A version in approved or active status is frozen: content, phases, and items cannot change (enforced by trigger). Corrections create a new draft that supersedes it; prior clinical instructions are never overwritten.';

-- ------------------------------------------------------------- phases
create table if not exists public.protocol_phases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_id uuid not null references public.protocol_versions(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  -- Timing is EITHER absolute dates OR relative day offsets. Nothing is
  -- inferred: a phase with neither is simply untimed and displays as such.
  starts_on date,
  ends_on date,
  relative_start_day integer,
  relative_duration_days integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint protocol_phases_timing_check check (
    (starts_on is null and ends_on is null)
    or (relative_start_day is null and relative_duration_days is null)
  ),
  constraint protocol_phases_date_order_check check (
    starts_on is null or ends_on is null or ends_on >= starts_on
  )
);
create index if not exists protocol_phases_version_idx
  on public.protocol_phases (version_id, position);
create index if not exists protocol_phases_org_idx
  on public.protocol_phases (organization_id);

-- ------------------------------------------------------------- items
create table if not exists public.protocol_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_id uuid not null references public.protocol_versions(id) on delete cascade,
  phase_id uuid references public.protocol_phases(id) on delete cascade,
  kind text not null check (kind in ('product','diet','lifestyle','monitoring','followup')),
  position integer not null default 0,
  -- Human-facing content for every kind.
  label text not null,
  instructions text,
  -- PRODUCT identity (kind='product'). Exact references, no guessing.
  catalog_product_id uuid references public.supplement_products(id) on delete set null,
  catalog_product_version_id uuid references public.supplement_product_versions(id) on delete set null,
  manufacturer text,
  label_version text,
  dosage_text text,
  timing_text text,
  route text,
  -- Verification of the product's structured data. 'unverified' is the default
  -- and the honest state: the UI must show "Interaction review not completed"
  -- and require practitioner review rather than implying safety.
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','label_verified','structured_verified')),
  interaction_review_state text not null default 'not_completed'
    check (interaction_review_state in ('not_completed','reviewed_by_practitioner')),
  interaction_reviewed_by uuid references auth.users(id),
  interaction_reviewed_at timestamptz,
  -- COMMERCIAL METADATA ONLY.
  affiliate_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists protocol_items_version_idx
  on public.protocol_items (version_id, kind, position);
create index if not exists protocol_items_phase_idx
  on public.protocol_items (phase_id);
create index if not exists protocol_items_org_idx
  on public.protocol_items (organization_id);
create index if not exists protocol_items_catalog_product_idx
  on public.protocol_items (catalog_product_id);
create index if not exists protocol_items_catalog_version_idx
  on public.protocol_items (catalog_product_version_id);
create index if not exists protocol_items_interaction_reviewer_idx
  on public.protocol_items (interaction_reviewed_by);

comment on column public.protocol_items.affiliate_url is
  'COMMERCIAL METADATA ONLY. Carries no clinical meaning: it never establishes eligibility, evidence, dosage, or safety, and must never be used to rank or justify a recommendation.';
comment on column public.protocol_items.verification_status is
  'Whether this product entry is backed by verified structured data. Default unverified. The application must never present an unverified item as interaction-checked; it shows "Interaction review not completed" and requires practitioner review.';

alter table public.protocols drop constraint if exists protocols_current_version_fk;
alter table public.protocols add constraint protocols_current_version_fk
  foreign key (current_version_id) references public.protocol_versions(id) on delete set null;
alter table public.protocols drop constraint if exists protocols_active_version_fk;
alter table public.protocols add constraint protocols_active_version_fk
  foreign key (active_version_id) references public.protocol_versions(id) on delete set null;
alter table public.protocol_templates drop constraint if exists protocol_templates_current_version_fk;
alter table public.protocol_templates add constraint protocol_templates_current_version_fk
  foreign key (current_version_id) references public.protocol_versions(id) on delete set null;
alter table public.protocol_templates drop constraint if exists protocol_templates_approved_version_fk;
alter table public.protocol_templates add constraint protocol_templates_approved_version_fk
  foreign key (approved_version_id) references public.protocol_versions(id) on delete set null;
create index if not exists protocols_current_version_idx on public.protocols (current_version_id);
create index if not exists protocols_active_version_idx on public.protocols (active_version_id);
create index if not exists protocol_templates_current_version_idx
  on public.protocol_templates (current_version_id);
create index if not exists protocol_templates_approved_version_idx
  on public.protocol_templates (approved_version_id);
create index if not exists protocols_created_by_idx on public.protocols (created_by);
create index if not exists protocols_updated_by_idx on public.protocols (updated_by);
create index if not exists protocol_templates_created_by_idx on public.protocol_templates (created_by);
create index if not exists protocol_templates_updated_by_idx on public.protocol_templates (updated_by);
create index if not exists protocol_versions_created_by_idx on public.protocol_versions (created_by);
create index if not exists protocol_versions_updated_by_idx on public.protocol_versions (updated_by);

-- ------------------------------------------------- immutability enforcement
-- A frozen version (approved/active) rejects content edits and child-row
-- changes at the TABLE level, so no future RPC, migration, or direct write can
-- quietly rewrite approved clinical instructions.
create or replace function private.protocol_version_is_frozen(_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.protocol_versions v
    where v.id = _version_id and v.status in ('approved','active')
  );
$$;
revoke all on function private.protocol_version_is_frozen(uuid) from public;
grant execute on function private.protocol_version_is_frozen(uuid) to authenticated, service_role;

create or replace function private.guard_frozen_protocol_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _vid uuid;
begin
  _vid := coalesce(new.version_id, old.version_id);
  if private.protocol_version_is_frozen(_vid) then
    raise exception
      'this protocol version is approved/active and cannot be edited; create a new draft version'
      using errcode = '22023';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function private.guard_frozen_protocol_version() from public;

drop trigger if exists protocol_phases_guard_frozen on public.protocol_phases;
create trigger protocol_phases_guard_frozen
  before insert or update or delete on public.protocol_phases
  for each row execute function private.guard_frozen_protocol_version();

drop trigger if exists protocol_items_guard_frozen on public.protocol_items;
create trigger protocol_items_guard_frozen
  before insert or update or delete on public.protocol_items
  for each row execute function private.guard_frozen_protocol_version();

-- Frozen versions: only the lifecycle columns may move (approved → active →
-- superseded/discontinued). Clinical content is immutable.
create or replace function private.guard_frozen_version_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('approved','active') then
    if new.title is distinct from old.title
       or new.summary is distinct from old.summary
       or new.diet_instructions is distinct from old.diet_instructions
       or new.lifestyle_instructions is distinct from old.lifestyle_instructions
       or new.monitoring_plan is distinct from old.monitoring_plan
       or new.followup_plan is distinct from old.followup_plan
       or new.version is distinct from old.version
       or new.protocol_id is distinct from old.protocol_id
       or new.template_id is distinct from old.template_id then
      raise exception
        'approved/active protocol versions are immutable; create a new draft version'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.guard_frozen_version_content() from public;

drop trigger if exists protocol_versions_guard_content on public.protocol_versions;
create trigger protocol_versions_guard_content
  before update on public.protocol_versions
  for each row execute function private.guard_frozen_version_content();

drop trigger if exists protocols_set_updated_at on public.protocols;
create trigger protocols_set_updated_at
  before update on public.protocols
  for each row execute function public.set_updated_at();
drop trigger if exists protocol_templates_set_updated_at on public.protocol_templates;
create trigger protocol_templates_set_updated_at
  before update on public.protocol_templates
  for each row execute function public.set_updated_at();
drop trigger if exists protocol_versions_set_updated_at on public.protocol_versions;
create trigger protocol_versions_set_updated_at
  before update on public.protocol_versions
  for each row execute function public.set_updated_at();
drop trigger if exists protocol_phases_set_updated_at on public.protocol_phases;
create trigger protocol_phases_set_updated_at
  before update on public.protocol_phases
  for each row execute function public.set_updated_at();
drop trigger if exists protocol_items_set_updated_at on public.protocol_items;
create trigger protocol_items_set_updated_at
  before update on public.protocol_items
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------- RLS
alter table public.protocols          enable row level security;
alter table public.protocol_templates enable row level security;
alter table public.protocol_versions  enable row level security;
alter table public.protocol_phases    enable row level security;
alter table public.protocol_items     enable row level security;

drop policy if exists protocols_select on public.protocols;
create policy protocols_select on public.protocols
  for select using (private.can_access_patient(patient_id));
drop policy if exists protocol_templates_select on public.protocol_templates;
create policy protocol_templates_select on public.protocol_templates
  for select using (private.is_org_member(organization_id));
drop policy if exists protocol_versions_select on public.protocol_versions;
create policy protocol_versions_select on public.protocol_versions
  for select using (
    (patient_id is not null and private.can_access_patient(patient_id))
    or (template_id is not null and private.is_org_member(organization_id))
  );
drop policy if exists protocol_phases_select on public.protocol_phases;
create policy protocol_phases_select on public.protocol_phases
  for select using (
    exists (select 1 from public.protocol_versions v
            where v.id = version_id
              and ((v.patient_id is not null and private.can_access_patient(v.patient_id))
                   or (v.template_id is not null and private.is_org_member(v.organization_id))))
  );
drop policy if exists protocol_items_select on public.protocol_items;
create policy protocol_items_select on public.protocol_items
  for select using (
    exists (select 1 from public.protocol_versions v
            where v.id = version_id
              and ((v.patient_id is not null and private.can_access_patient(v.patient_id))
                   or (v.template_id is not null and private.is_org_member(v.organization_id))))
  );

-- All writes flow through the RPCs in the companion migration.
revoke all privileges on table
  public.protocols, public.protocol_templates, public.protocol_versions,
  public.protocol_phases, public.protocol_items
from public, anon, authenticated;

commit;
