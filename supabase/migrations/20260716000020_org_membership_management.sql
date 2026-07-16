-- 0020 — Organization membership management (Phase 1).
--
-- Admin-gated membership operations as SECURITY DEFINER RPCs, so the tenant
-- rules live inside the database (not only in the API layer) and every
-- mutation writes its audit row in the same transaction:
--
--   list_org_members(org)                — roster incl. email (auth.users join)
--   add_org_member(org, email, role)     — attach an EXISTING auth user, status 'invited'
--   set_org_member_role(membership, role)— role change with owner/lockout guards
--   remove_org_member(membership)        — removal with owner/lockout/self guards
--   activate_my_memberships()            — caller's own 'invited' → 'active'
--
-- Rules enforced HERE (not in TypeScript):
--   * caller must be an active admin/owner of the target org (is_org_admin)
--   * 'owner' role is grantable/revocable only by an owner
--   * the last active owner can never be demoted or removed
--   * admins cannot remove themselves (lockout guard)
--   * auth-user creation is NOT done here — inviting a brand-new email goes
--     through the auth admin API in the backend; this function only links
--     users that already exist in auth.users.
--
-- Errcodes follow the established contract: 28000 unauthenticated,
-- 42501 forbidden, P0002 not found, 22023 invalid argument.

begin;

-- ------------------------------------------------------------- list_org_members
create or replace function public.list_org_members(_organization_id uuid)
returns table (
  membership_id uuid,
  user_id       uuid,
  email         text,
  display_name  text,
  role          text,
  status        text,
  joined_at     timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  -- Roster (incl. emails) is admin-surface data; plain members see only
  -- their own membership row via RLS and have no use for this RPC.
  if not private.is_org_admin(_organization_id) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;

  return query
  select
    m.id,
    m.user_id,
    u.email::text,
    p.display_name,
    m.role,
    m.status,
    m.created_at
  from public.organization_memberships m
  join auth.users u on u.id = m.user_id
  left join public.practitioner_profiles p
    on p.organization_id = m.organization_id
   and p.user_id = m.user_id
   and p.deleted_at is null
  where m.organization_id = _organization_id
  order by m.created_at asc;
end;
$$;

-- --------------------------------------------------------------- add_org_member
create or replace function public.add_org_member(
  _organization_id uuid,
  _email text,
  _role text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid        uuid := auth.uid();
  _target     uuid;
  _membership uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_admin(_organization_id) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;

  if _email is null or btrim(_email) = '' or length(_email) > 320
     or position('@' in _email) = 0 then
    raise exception 'invalid email' using errcode = '22023';
  end if;
  if _role is null or _role not in ('owner','admin','practitioner','staff','member') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  if _role = 'owner' and not private.has_org_role(_organization_id, 'owner') then
    raise exception 'only an owner can grant the owner role' using errcode = '42501';
  end if;

  select u.id into _target
  from auth.users u
  where lower(u.email) = lower(btrim(_email))
  limit 1;
  if _target is null then
    -- Distinct signal for the backend: create the auth user via the auth
    -- admin API first, then call this function again.
    raise exception 'no_such_user' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _organization_id and m.user_id = _target
  ) then
    raise exception 'already_a_member' using errcode = '22023';
  end if;

  insert into public.organization_memberships
    (organization_id, user_id, role, status, created_by)
  values
    (_organization_id, _target, _role, 'invited', _uid)
  returning id into _membership;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _organization_id, null, _uid, 'member.invited',
    'organization_membership', _membership::text,
    'Member invited',
    jsonb_build_object('role', _role, 'target_user_id', _target::text)
  );

  return _membership;
end;
$$;

-- --------------------------------------------------------- set_org_member_role
create or replace function public.set_org_member_role(
  _membership_id uuid,
  _role text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _m   public.organization_memberships%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _m from public.organization_memberships where id = _membership_id;
  if not found then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;
  if not private.is_org_admin(_m.organization_id) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;

  if _role is null or _role not in ('owner','admin','practitioner','staff','member') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  if _role = _m.role then
    return; -- idempotent no-op, nothing to audit
  end if;

  -- Owner transitions require an owner on BOTH sides (grant and revoke).
  if (_role = 'owner' or _m.role = 'owner')
     and not private.has_org_role(_m.organization_id, 'owner') then
    raise exception 'only an owner can change owner roles' using errcode = '42501';
  end if;
  -- Never demote the last active owner — that would orphan the organization.
  if _m.role = 'owner' and _m.status = 'active' and not exists (
    select 1 from public.organization_memberships o
    where o.organization_id = _m.organization_id
      and o.role = 'owner' and o.status = 'active' and o.id <> _m.id
  ) then
    raise exception 'cannot demote the last owner' using errcode = '22023';
  end if;

  update public.organization_memberships
     set role = _role
   where id = _m.id;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _m.organization_id, null, _uid, 'member.role_changed',
    'organization_membership', _m.id::text,
    'Member role changed',
    jsonb_build_object('from', _m.role, 'to', _role, 'target_user_id', _m.user_id::text)
  );
end;
$$;

-- ------------------------------------------------------------ remove_org_member
create or replace function public.remove_org_member(_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _m   public.organization_memberships%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _m from public.organization_memberships where id = _membership_id;
  if not found then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;
  if not private.is_org_admin(_m.organization_id) then
    raise exception 'organization admin required' using errcode = '42501';
  end if;

  if _m.user_id = _uid then
    raise exception 'cannot remove yourself' using errcode = '22023';
  end if;
  if _m.role = 'owner' and not private.has_org_role(_m.organization_id, 'owner') then
    raise exception 'only an owner can remove an owner' using errcode = '42501';
  end if;
  if _m.role = 'owner' and _m.status = 'active' and not exists (
    select 1 from public.organization_memberships o
    where o.organization_id = _m.organization_id
      and o.role = 'owner' and o.status = 'active' and o.id <> _m.id
  ) then
    raise exception 'cannot remove the last owner' using errcode = '22023';
  end if;

  delete from public.organization_memberships where id = _m.id;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _m.organization_id, null, _uid, 'member.removed',
    'organization_membership', _m.id::text,
    'Member removed',
    jsonb_build_object('role', _m.role, 'target_user_id', _m.user_id::text)
  );
end;
$$;

-- ----------------------------------------------------- activate_my_memberships
-- Called after sign-in: the invited practitioner claims their own pending
-- memberships. Own rows only; idempotent; one audit row per activation.
create or replace function public.activate_my_memberships()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid   uuid := auth.uid();
  _row   record;
  _count integer := 0;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  for _row in
    update public.organization_memberships
       set status = 'active'
     where user_id = _uid and status = 'invited'
    returning id, organization_id
  loop
    _count := _count + 1;
    insert into public.audit_events (
      organization_id, patient_id, actor_user_id, action,
      resource_type, resource_id, safe_message, metadata
    ) values (
      _row.organization_id, null, _uid, 'member.joined',
      'organization_membership', _row.id::text,
      'Invitation accepted',
      '{}'::jsonb
    );
  end loop;

  return _count;
end;
$$;

-- ------------------------------------------------------------------ grants
revoke all on function public.list_org_members(uuid)              from public, anon;
revoke all on function public.add_org_member(uuid, text, text)    from public, anon;
revoke all on function public.set_org_member_role(uuid, text)     from public, anon;
revoke all on function public.remove_org_member(uuid)             from public, anon;
revoke all on function public.activate_my_memberships()           from public, anon;

grant execute on function public.list_org_members(uuid)           to authenticated;
grant execute on function public.add_org_member(uuid, text, text) to authenticated;
grant execute on function public.set_org_member_role(uuid, text)  to authenticated;
grant execute on function public.remove_org_member(uuid)          to authenticated;
grant execute on function public.activate_my_memberships()        to authenticated;

commit;
