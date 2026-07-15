-- ============================================================================
-- 0001 · Tenancy & identity foundation
-- ============================================================================
-- Organization-first model for the AI Longevity Pro clinical intelligence
-- platform. This is the first migration of the *dedicated* Supabase project
-- (project ref: urcjiehlxoehievobezf, "AI Desktop Pro") that isolates clinical
-- PHI from the legacy shared database. Every tenant/patient table added by
-- later migrations carries organization_id and is guarded by the private
-- authorization helpers defined here.
--
-- Applied + verified against the live project (Supabase security advisor: 0
-- findings). Authorization helpers live in a non-exposed `private` schema so
-- they are usable inside RLS policies but are NOT callable as PostgREST RPC
-- endpoints (advisor lints 0028/0029). SECURITY DEFINER + pinned search_path
-- (lint 0011).
-- ============================================================================

create extension if not exists pgcrypto;
create schema if not exists private;
grant usage on schema private to authenticated, service_role;

-- Shared updated_at trigger.
create or replace function public.set_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- organizations
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  status      text not null default 'active' check (status in ('active','suspended','archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  deleted_at  timestamptz
);
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------ organization_memberships
create table public.organization_memberships (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             text not null default 'member'
                     check (role in ('owner','admin','practitioner','staff','member')),
  status           text not null default 'active'
                     check (status in ('active','invited','suspended')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id),
  unique (organization_id, user_id)
);
create index organization_memberships_user_idx on public.organization_memberships (user_id);
create index organization_memberships_org_idx  on public.organization_memberships (organization_id);
create trigger organization_memberships_set_updated_at
  before update on public.organization_memberships
  for each row execute function public.set_updated_at();

-- ------------------------------------------------- private authorization helpers
-- SECURITY DEFINER so they bypass RLS on organization_memberships (avoids policy
-- recursion). In the `private` schema + execute granted only to authenticated /
-- service_role, so they are not exposed as RPC.
create or replace function private.is_org_member(_org_id uuid)
returns boolean language sql stable security definer set search_path = 'pg_catalog','public' as $$
  select exists (select 1 from public.organization_memberships m
    where m.organization_id = _org_id and m.user_id = auth.uid() and m.status = 'active');
$$;
create or replace function private.has_org_role(_org_id uuid, _role text)
returns boolean language sql stable security definer set search_path = 'pg_catalog','public' as $$
  select exists (select 1 from public.organization_memberships m
    where m.organization_id = _org_id and m.user_id = auth.uid() and m.status = 'active' and m.role = _role);
$$;
create or replace function private.is_org_admin(_org_id uuid)
returns boolean language sql stable security definer set search_path = 'pg_catalog','public' as $$
  select exists (select 1 from public.organization_memberships m
    where m.organization_id = _org_id and m.user_id = auth.uid() and m.status = 'active' and m.role in ('owner','admin'));
$$;

-- Atomically make an org's creator its owner member.
create or replace function private.bootstrap_org_owner()
returns trigger language plpgsql security definer set search_path = 'pg_catalog','public' as $$
begin
  insert into public.organization_memberships (organization_id, user_id, role, status, created_by)
  values (new.id, new.created_by, 'owner', 'active', new.created_by);
  return new;
end;
$$;

revoke all on function private.is_org_member(uuid)      from public;
revoke all on function private.has_org_role(uuid, text) from public;
revoke all on function private.is_org_admin(uuid)       from public;
revoke all on function private.bootstrap_org_owner()    from public;
grant execute on function private.is_org_member(uuid)      to authenticated, service_role;
grant execute on function private.has_org_role(uuid, text) to authenticated, service_role;
grant execute on function private.is_org_admin(uuid)       to authenticated, service_role;

create trigger organizations_bootstrap_owner
  after insert on public.organizations
  for each row when (new.created_by is not null)
  execute function private.bootstrap_org_owner();

-- ---------------------------------------------------------------------- RLS
alter table public.organizations            enable row level security;
alter table public.organization_memberships enable row level security;

-- organizations: members read; admins update; any authenticated user creates
-- (the bootstrap trigger then makes them owner).
create policy organizations_select on public.organizations
  for select using (private.is_org_member(id));
create policy organizations_insert on public.organizations
  for insert to authenticated with check (created_by = auth.uid());
create policy organizations_update on public.organizations
  for update using (private.is_org_admin(id)) with check (private.is_org_admin(id));

-- memberships: a user sees their own rows; org admins see/manage all rows in
-- their org. Owner bootstrap is handled by the SECURITY DEFINER trigger, so no
-- self-insert path is exposed.
create policy memberships_select on public.organization_memberships
  for select using (user_id = auth.uid() or private.is_org_admin(organization_id));
create policy memberships_insert on public.organization_memberships
  for insert with check (private.is_org_admin(organization_id));
create policy memberships_update on public.organization_memberships
  for update using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));
create policy memberships_delete on public.organization_memberships
  for delete using (private.is_org_admin(organization_id));
