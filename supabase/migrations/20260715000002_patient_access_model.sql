-- ============================================================================
-- 0002 · Patient-access model
-- ============================================================================
-- practitioner_profiles, patient_profiles, practitioner_patient_relationships,
-- invitations + the private.can_access_patient() gate + org-scoped RLS.
--
-- Patient model = a record owned by an organization that OPTIONALLY links to an
-- auth user (patient_profiles.user_id) when the patient uses the mobile app —
-- this unifies the legacy "clinic patient record" and "mobile patient user"
-- worlds. Every patient table carries the provenance/audit columns required by
-- the platform spec (source, source_record_id, created_by, updated_by,
-- deleted_at).
--
-- Applied + verified: Supabase security advisor = 0 findings, and the
-- cross-tenant isolation test in supabase/tests/cross_tenant_isolation.sql
-- passes (a user in Org B cannot see Org A's organization, patient, or
-- memberships).
-- ============================================================================

-- ---------------------------------------------------------- practitioner_profiles
create table public.practitioner_profiles (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  display_name     text,
  credentials      text,
  specialty        text,
  npi              text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id),
  deleted_at       timestamptz,
  unique (organization_id, user_id)
);
create index practitioner_profiles_org_idx  on public.practitioner_profiles (organization_id);
create index practitioner_profiles_user_idx on public.practitioner_profiles (user_id);
create trigger practitioner_profiles_set_updated_at
  before update on public.practitioner_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- patient_profiles
create table public.patient_profiles (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid references auth.users(id) on delete set null,
  mrn              text,
  first_name       text not null,
  last_name        text not null,
  date_of_birth    date,
  sex              text check (sex in ('male','female','other','unknown')),
  email            text,
  phone            text,
  status           text not null default 'active' check (status in ('active','inactive','archived')),
  source           text not null default 'manual',
  source_record_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id),
  updated_by       uuid references auth.users(id),
  deleted_at       timestamptz,
  unique (organization_id, mrn)
);
create index patient_profiles_org_idx  on public.patient_profiles (organization_id);
create index patient_profiles_user_idx on public.patient_profiles (user_id);
create trigger patient_profiles_set_updated_at
  before update on public.patient_profiles
  for each row execute function public.set_updated_at();

-- ------------------------------------------- practitioner_patient_relationships
create table public.practitioner_patient_relationships (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  practitioner_user_id  uuid not null references auth.users(id) on delete cascade,
  patient_id            uuid not null references public.patient_profiles(id) on delete cascade,
  relationship_type     text not null default 'care_team'
                          check (relationship_type in ('primary','consulting','care_team')),
  status                text not null default 'active' check (status in ('active','inactive')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references auth.users(id),
  deleted_at            timestamptz,
  unique (organization_id, practitioner_user_id, patient_id)
);
create index ppr_patient_idx      on public.practitioner_patient_relationships (patient_id);
create index ppr_practitioner_idx on public.practitioner_patient_relationships (practitioner_user_id);
create trigger ppr_set_updated_at
  before update on public.practitioner_patient_relationships
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------- invitations
create table public.invitations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  email            text not null,
  role             text not null default 'member'
                     check (role in ('owner','admin','practitioner','staff','member')),
  token            text not null unique default encode(gen_random_bytes(24), 'hex'),
  status           text not null default 'pending'
                     check (status in ('pending','accepted','revoked','expired')),
  invited_by       uuid references auth.users(id),
  expires_at       timestamptz not null default (now() + interval '14 days'),
  accepted_by      uuid references auth.users(id),
  accepted_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index invitations_org_idx   on public.invitations (organization_id);
create index invitations_email_idx on public.invitations (lower(email));
create trigger invitations_set_updated_at
  before update on public.invitations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------- patient access helper (private)
-- True if the caller is the patient, an org admin/owner, or an actively-assigned
-- practitioner. SECURITY DEFINER (bypasses RLS to avoid recursion), private schema
-- (not RPC-exposed).
create or replace function private.can_access_patient(_patient_id uuid)
returns boolean language sql stable security definer set search_path = 'pg_catalog','public' as $$
  select exists (
    select 1 from public.patient_profiles p
    where p.id = _patient_id
      and (
        p.user_id = auth.uid()
        or private.is_org_admin(p.organization_id)
        or exists (
          select 1 from public.practitioner_patient_relationships r
          where r.patient_id = p.id
            and r.practitioner_user_id = auth.uid()
            and r.status = 'active'
        )
      )
  );
$$;
revoke all on function private.can_access_patient(uuid) from public;
grant execute on function private.can_access_patient(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------------ RLS
alter table public.practitioner_profiles              enable row level security;
alter table public.patient_profiles                   enable row level security;
alter table public.practitioner_patient_relationships enable row level security;
alter table public.invitations                        enable row level security;

create policy prof_select on public.practitioner_profiles
  for select using (private.is_org_member(organization_id));
create policy prof_insert on public.practitioner_profiles
  for insert with check (private.is_org_admin(organization_id));
create policy prof_update on public.practitioner_profiles
  for update using (user_id = auth.uid() or private.is_org_admin(organization_id))
  with check (private.is_org_member(organization_id));
create policy prof_delete on public.practitioner_profiles
  for delete using (private.is_org_admin(organization_id));

create policy patient_select on public.patient_profiles
  for select using (private.can_access_patient(id));
create policy patient_insert on public.patient_profiles
  for insert with check (
    private.is_org_admin(organization_id) or private.has_org_role(organization_id, 'practitioner')
  );
create policy patient_update on public.patient_profiles
  for update using (private.can_access_patient(id))
  with check (
    private.is_org_admin(organization_id) or private.has_org_role(organization_id, 'practitioner')
  );
create policy patient_delete on public.patient_profiles
  for delete using (private.is_org_admin(organization_id));

create policy ppr_select on public.practitioner_patient_relationships
  for select using (private.is_org_admin(organization_id) or practitioner_user_id = auth.uid());
create policy ppr_insert on public.practitioner_patient_relationships
  for insert with check (private.is_org_admin(organization_id));
create policy ppr_update on public.practitioner_patient_relationships
  for update using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));
create policy ppr_delete on public.practitioner_patient_relationships
  for delete using (private.is_org_admin(organization_id));

create policy invitations_all on public.invitations
  for all using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));
