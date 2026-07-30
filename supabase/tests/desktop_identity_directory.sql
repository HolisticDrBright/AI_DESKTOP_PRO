-- Rolled-back acceptance suite for the Desktop-owned auth/org/patient boundary.
-- Run after migration 20260728210837. Every returned row must pass.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
grant all on _v to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000081','desktop-owner@verify.local'),
  ('11111111-0000-0000-0000-000000000082','desktop-practitioner@verify.local'),
  ('11111111-0000-0000-0000-000000000083','desktop-outsider@verify.local');

insert into public.organizations(id,name,slug,status) values
  ('bbbbbbbb-0000-0000-0000-000000000081','Desktop Verify A','desktop-verify-a','active'),
  ('bbbbbbbb-0000-0000-0000-000000000082','Desktop Verify B','desktop-verify-b','active'),
  ('bbbbbbbb-0000-0000-0000-000000000083','Desktop Suspended','desktop-suspended','suspended');

insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000081','11111111-0000-0000-0000-000000000081','owner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000081','11111111-0000-0000-0000-000000000082','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000082','11111111-0000-0000-0000-000000000082','practitioner','invited'),
  ('bbbbbbbb-0000-0000-0000-000000000083','11111111-0000-0000-0000-000000000082','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000082','11111111-0000-0000-0000-000000000083','owner','active');

insert into public.patient_profiles(id,organization_id,mrn,first_name,last_name,status) values
  ('cccccccc-0000-0000-0000-000000000081','bbbbbbbb-0000-0000-0000-000000000081','DV-1','Visible','Patient','active'),
  ('cccccccc-0000-0000-0000-000000000082','bbbbbbbb-0000-0000-0000-000000000082','DV-2','Other','Patient','active');

insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000081','11111111-0000-0000-0000-000000000082',
   'cccccccc-0000-0000-0000-000000000081','active');

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000082","role":"authenticated"}',
  true
);
set local role authenticated;

insert into _v
select 'organization list returns only active caller memberships',
  (select count(*) = 1 from public.list_my_organizations())
  and exists (
    select 1 from public.list_my_organizations()
    where organization_id = 'bbbbbbbb-0000-0000-0000-000000000081'
      and role = 'practitioner'
  ),
  '';

insert into _v
select 'invited memberships and suspended organizations are excluded',
  not exists (
    select 1 from public.list_my_organizations()
    where organization_id in (
      'bbbbbbbb-0000-0000-0000-000000000082',
      'bbbbbbbb-0000-0000-0000-000000000083'
    )
  ),
  '';

insert into _v
select 'patient RLS exposes only assigned records',
  (select count(*) = 1 from public.patient_profiles)
  and exists (
    select 1 from public.patient_profiles
    where id = 'cccccccc-0000-0000-0000-000000000081'
  ),
  '';

reset role;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000083","role":"authenticated"}',
  true
);
set local role authenticated;

insert into _v
select 'another tenant cannot read the first tenant organization or patient',
  not exists (
    select 1 from public.list_my_organizations()
    where organization_id = 'bbbbbbbb-0000-0000-0000-000000000081'
  )
  and not exists (
    select 1 from public.patient_profiles
    where id = 'cccccccc-0000-0000-0000-000000000081'
  ),
  '';

reset role;

insert into _v
select 'anonymous role cannot execute the organization function',
  not has_function_privilege('anon','public.list_my_organizations()','execute'),
  '';

insert into _v
select 'authenticated role has explicit Data API read grants',
  has_table_privilege('authenticated','public.organizations','select')
  and has_table_privilege('authenticated','public.organization_memberships','select')
  and has_table_privilege('authenticated','public.patient_profiles','select'),
  '';

select * from _v order by name;
rollback;
