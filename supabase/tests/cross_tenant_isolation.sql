-- ============================================================================
-- Cross-tenant isolation test (RLS)
-- ============================================================================
-- Proves that a user in one organization cannot read another organization's
-- rows through Row Level Security. Runs entirely inside a transaction that is
-- ROLLED BACK, so it creates no persistent data (including the throwaway
-- auth.users rows).
--
-- Run via the Supabase SQL editor, `psql`, or the MCP execute_sql tool against
-- the AI Desktop Pro project. Every row of the output must have pass = true.
--
-- This is the "attempt unauthorized cross-tenant access" test the platform
-- spec requires. Extend it with a new labelled row for each patient/tenant
-- table added in future migrations.
-- ============================================================================
begin;

-- Two throwaway auth users
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
 ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@test.local', now(), now()),
 ('00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@test.local', now(), now());

-- Seed as service_role (RLS bypass): two orgs (owner memberships auto-created by
-- the bootstrap trigger) + a patient in Org A.
insert into public.organizations (id, name, slug, created_by) values
 ('00000000-0000-0000-0000-0000000000a1','Org A','org-a-test','00000000-0000-0000-0000-00000000000a'),
 ('00000000-0000-0000-0000-0000000000b1','Org B','org-b-test','00000000-0000-0000-0000-00000000000b');
insert into public.patient_profiles (id, organization_id, first_name, last_name, created_by)
 values ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a1','Alex','A','00000000-0000-0000-0000-00000000000a');

create temp table _t (label text, val int, expected int) on commit drop;
grant all on _t to authenticated;

-- Simulate User B (member of Org B only) — cross-tenant reads must return 0.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
insert into _t values
 ('B sees Org A (cross-tenant)',     (select count(*) from public.organizations   where id='00000000-0000-0000-0000-0000000000a1'), 0),
 ('B sees Org B (own)',              (select count(*) from public.organizations   where id='00000000-0000-0000-0000-0000000000b1'), 1),
 ('B sees Patient A (cross-tenant)', (select count(*) from public.patient_profiles where id='00000000-0000-0000-0000-0000000000a2'), 0),
 ('B visible memberships (own only)',(select count(*) from public.organization_memberships), 1);
reset role;

-- Simulate User A (owner of Org A) — own rows must be visible.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
insert into _t values
 ('A sees Org A (own)',     (select count(*) from public.organizations   where id='00000000-0000-0000-0000-0000000000a1'), 1),
 ('A sees Patient A (own)', (select count(*) from public.patient_profiles where id='00000000-0000-0000-0000-0000000000a2'), 1);
reset role;

select label, val, expected, (val = expected) as pass from _t order by label;

rollback;
