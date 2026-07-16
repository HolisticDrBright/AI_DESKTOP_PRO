-- ============================================================
-- Test: 0020 organization membership management
--
-- Rolled-back, against the real project. Proves:
--   - add_org_member: owner/admin can attach an EXISTING auth user as
--     'invited' (+audit); duplicates 22023; unknown email P0002; bad role
--     22023; non-admin 42501; 'owner' grantable only by an owner (42501)
--   - list_org_members: admin sees roster incl. email; non-admin and
--     outsider get 42501
--   - set_org_member_role: role change + audit; owner transitions need an
--     owner; last active owner cannot be demoted (22023)
--   - remove_org_member: removal + audit; self-removal blocked (22023);
--     admins cannot remove an owner (42501)
--   - activate_my_memberships: caller's own invited→active (+audit), second
--     call returns 0
-- Every row must show passed = true.
-- ============================================================

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
grant all on _v to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000021','owner20@verify.local'),
  ('11111111-0000-0000-0000-000000000022','admin20@verify.local'),
  ('11111111-0000-0000-0000-000000000023','pract20@verify.local'),
  ('11111111-0000-0000-0000-000000000024','outsider20@verify.local'),
  ('11111111-0000-0000-0000-000000000025','invitee-a20@verify.local'),
  ('11111111-0000-0000-0000-000000000026','invitee-b20@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000020','Verify Org 20','verify-0020');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000020','11111111-0000-0000-0000-000000000021','owner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000020','11111111-0000-0000-0000-000000000022','admin','active'),
  ('bbbbbbbb-0000-0000-0000-000000000020','11111111-0000-0000-0000-000000000023','practitioner','active');

-- ============================== as OWNER =====================================
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000021","role":"authenticated"}', true);

do $$
declare _mid uuid;
begin
  _mid := public.add_org_member('bbbbbbbb-0000-0000-0000-000000000020','Invitee-A20@verify.local','practitioner');
  insert into _v
  select 'owner invites existing user (case-insensitive email) as invited',
         exists (select 1 from public.organization_memberships
                 where id = _mid and user_id = '11111111-0000-0000-0000-000000000025'
                   and role = 'practitioner' and status = 'invited'),
         _mid::text;
exception when others then
  insert into _v values('owner invites existing user (case-insensitive email) as invited', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'invite wrote member.invited audit row',
       count(*) = 1,
       'count='||count(*)
from public.audit_events
where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
  and action = 'member.invited'
  and metadata->>'target_user_id' = '11111111-0000-0000-0000-000000000025';

do $$
begin
  perform public.add_org_member('bbbbbbbb-0000-0000-0000-000000000020','invitee-a20@verify.local','staff');
  insert into _v values('duplicate invite rejected', false, 'no error');
exception when others then
  insert into _v values('duplicate invite rejected', sqlstate='22023' and sqlerrm like '%already_a_member%', sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.add_org_member('bbbbbbbb-0000-0000-0000-000000000020','nobody20@verify.local','staff');
  insert into _v values('unknown email signals no_such_user', false, 'no error');
exception when others then
  insert into _v values('unknown email signals no_such_user', sqlstate='P0002' and sqlerrm like '%no_such_user%', sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.add_org_member('bbbbbbbb-0000-0000-0000-000000000020','invitee-b20@verify.local','superadmin');
  insert into _v values('invalid role rejected', false, 'no error');
exception when others then
  insert into _v values('invalid role rejected', sqlstate='22023', sqlstate);
end $$;

insert into _v
select 'owner sees roster with emails',
       count(*) = 4
         and count(*) filter (where email = 'invitee-a20@verify.local' and status = 'invited') = 1,
       'count='||count(*)
from public.list_org_members('bbbbbbbb-0000-0000-0000-000000000020');

-- ============================== as ADMIN =====================================
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000022","role":"authenticated"}', true);

do $$
begin
  perform public.add_org_member('bbbbbbbb-0000-0000-0000-000000000020','invitee-b20@verify.local','owner');
  insert into _v values('admin cannot grant owner role', false, 'no error');
exception when others then
  insert into _v values('admin cannot grant owner role', sqlstate='42501', sqlstate);
end $$;

do $$
declare _mid uuid;
begin
  _mid := public.add_org_member('bbbbbbbb-0000-0000-0000-000000000020','invitee-b20@verify.local','staff');
  insert into _v values('admin invites non-owner role', _mid is not null, _mid::text);
exception when others then
  insert into _v values('admin invites non-owner role', false, sqlstate||' '||sqlerrm);
end $$;

do $$
declare _owner_mid uuid;
begin
  select id into _owner_mid from public.organization_memberships
  where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
    and user_id = '11111111-0000-0000-0000-000000000021';
  perform public.set_org_member_role(_owner_mid, 'member');
  insert into _v values('admin cannot change an owner''s role', false, 'no error');
exception when others then
  insert into _v values('admin cannot change an owner''s role', sqlstate='42501', sqlstate);
end $$;

do $$
declare _self_mid uuid;
begin
  select id into _self_mid from public.organization_memberships
  where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
    and user_id = '11111111-0000-0000-0000-000000000022';
  perform public.remove_org_member(_self_mid);
  insert into _v values('self-removal blocked', false, 'no error');
exception when others then
  insert into _v values('self-removal blocked', sqlstate='22023', sqlstate);
end $$;

do $$
declare _owner_mid uuid;
begin
  select id into _owner_mid from public.organization_memberships
  where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
    and user_id = '11111111-0000-0000-0000-000000000021';
  perform public.remove_org_member(_owner_mid);
  insert into _v values('admin cannot remove an owner', false, 'no error');
exception when others then
  insert into _v values('admin cannot remove an owner', sqlstate='42501', sqlstate);
end $$;

-- ============================== as PRACTITIONER / OUTSIDER ===================
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000023","role":"authenticated"}', true);
do $$
begin
  perform public.add_org_member('bbbbbbbb-0000-0000-0000-000000000020','invitee-b20@verify.local','member');
  insert into _v values('non-admin member cannot invite', false, 'no error');
exception when others then
  insert into _v values('non-admin member cannot invite', sqlstate='42501', sqlstate);
end $$;

do $$
declare _n integer;
begin
  select count(*) into _n from public.list_org_members('bbbbbbbb-0000-0000-0000-000000000020');
  insert into _v values('non-admin member cannot list roster', false, 'rows='||_n);
exception when others then
  insert into _v values('non-admin member cannot list roster', sqlstate='42501', sqlstate);
end $$;

select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000024","role":"authenticated"}', true);
do $$
declare _n integer;
begin
  select count(*) into _n from public.list_org_members('bbbbbbbb-0000-0000-0000-000000000020');
  insert into _v values('outsider cannot list roster', false, 'rows='||_n);
exception when others then
  insert into _v values('outsider cannot list roster', sqlstate='42501', sqlstate);
end $$;

-- ============================== role change + lockout (as OWNER) =============
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000021","role":"authenticated"}', true);

do $$
declare _mid uuid;
begin
  select id into _mid from public.organization_memberships
  where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
    and user_id = '11111111-0000-0000-0000-000000000025';
  perform public.set_org_member_role(_mid, 'staff');
  insert into _v
  select 'owner changes member role',
         exists (select 1 from public.organization_memberships where id = _mid and role = 'staff'),
         _mid::text;
exception when others then
  insert into _v values('owner changes member role', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'role change wrote member.role_changed audit row',
       count(*) = 1
         and count(*) filter (where metadata->>'from' = 'practitioner' and metadata->>'to' = 'staff') = 1,
       'count='||count(*)
from public.audit_events
where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
  and action = 'member.role_changed';

do $$
declare _owner_mid uuid;
begin
  select id into _owner_mid from public.organization_memberships
  where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
    and user_id = '11111111-0000-0000-0000-000000000021';
  perform public.set_org_member_role(_owner_mid, 'admin');
  insert into _v values('last owner cannot be demoted', false, 'no error');
exception when others then
  insert into _v values('last owner cannot be demoted', sqlstate='22023', sqlstate);
end $$;

do $$
declare _mid uuid;
begin
  select id into _mid from public.organization_memberships
  where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
    and user_id = '11111111-0000-0000-0000-000000000026';
  perform public.remove_org_member(_mid);
  insert into _v
  select 'owner removes a member',
         not exists (select 1 from public.organization_memberships where id = _mid),
         _mid::text;
exception when others then
  insert into _v values('owner removes a member', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'removal wrote member.removed audit row',
       count(*) = 1,
       'count='||count(*)
from public.audit_events
where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
  and action = 'member.removed'
  and metadata->>'target_user_id' = '11111111-0000-0000-0000-000000000026';

-- ============================== invited member activates =====================
select set_config('request.jwt.claims','{"sub":"11111111-0000-0000-0000-000000000025","role":"authenticated"}', true);

do $$
declare _n integer; _n2 integer;
begin
  _n := public.activate_my_memberships();
  _n2 := public.activate_my_memberships();
  insert into _v
  select 'invited member activates own membership (idempotent)',
         _n = 1 and _n2 = 0
           and exists (select 1 from public.organization_memberships
                       where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
                         and user_id = '11111111-0000-0000-0000-000000000025'
                         and status = 'active'),
         'first='||_n||' second='||_n2;
exception when others then
  insert into _v values('invited member activates own membership (idempotent)', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'activation wrote member.joined audit row',
       count(*) = 1,
       'count='||count(*)
from public.audit_events
where organization_id = 'bbbbbbbb-0000-0000-0000-000000000020'
  and action = 'member.joined'
  and actor_user_id = '11111111-0000-0000-0000-000000000025';

select name, passed, detail from _v order by name;
rollback;
