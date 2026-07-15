-- ============================================================================
-- Practitioner-assignment access test (RLS keystone)
-- ============================================================================
-- Proves the private.can_access_patient() gate at the level the cross-tenant
-- test cannot: WITHIN one organization. A practitioner who is a full, active
-- member of the org but is NOT assigned to a patient must see none of that
-- patient's rows; an active assignment grants access; revoking the assignment
-- removes it; and a practitioner cannot self-assign (ppr writes are
-- admin-gated). Also verifies the org-admin and patient-self lanes.
--
-- Runs entirely inside a transaction that is ROLLED BACK — no persistent data.
-- Run via the Supabase SQL editor, `psql`, or the MCP execute_sql tool against
-- the AI Desktop Pro project. Every row of the output must have pass = true.
-- ============================================================================
begin;

-- Throwaway auth users: A = org owner/admin, B1 = assigned practitioner,
-- B2 = unassigned practitioner (same org), C1 = the patient's own user.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
 ('10000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner@assign.test',  now(), now()),
 ('10000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','p1@assign.test',     now(), now()),
 ('10000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','p2@assign.test',     now(), now()),
 ('10000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','patient@assign.test',now(), now());

-- Seed as service role (RLS bypass): one org (A becomes owner via bootstrap
-- trigger), two practitioner memberships, one patient linked to C1, one active
-- assignment (B1 only), one clinical row.
insert into public.organizations (id, name, slug, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','Assignment Test Org','assignment-test-org','10000000-0000-0000-0000-0000000000aa');
insert into public.organization_memberships (organization_id, user_id, role, status, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000b1','practitioner','active','10000000-0000-0000-0000-0000000000aa'),
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000b2','practitioner','active','10000000-0000-0000-0000-0000000000aa');
insert into public.patient_profiles (id, organization_id, user_id, first_name, last_name, created_by) values
 ('10000000-0000-0000-0000-0000000000e1','10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000c1','Keystone','Patient','10000000-0000-0000-0000-0000000000aa');
insert into public.practitioner_patient_relationships (organization_id, practitioner_user_id, patient_id, relationship_type, status, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000b1','10000000-0000-0000-0000-0000000000e1','primary','active','10000000-0000-0000-0000-0000000000aa');
insert into public.clinical_hypotheses (organization_id, patient_id, title, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1','Keystone test hypothesis','10000000-0000-0000-0000-0000000000aa');

create temp table _t (label text, val int, expected int) on commit drop;
grant all on _t to authenticated;

-- ---------------------------------------------------------------------------
-- B2: active practitioner in the SAME org, NO assignment — the keystone case.
-- Org-level rows stay visible (memberships work); patient-scoped rows do not.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
insert into _t values
 ('B2 unassigned: org visible (is a member)',   (select count(*) from public.organizations where id='10000000-0000-0000-0000-0000000000d1'), 1),
 ('B2 unassigned: patient hidden',              (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B2 unassigned: hypothesis hidden',           (select count(*) from public.clinical_hypotheses where patient_id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B2 unassigned: assignment rows hidden',      (select count(*) from public.practitioner_patient_relationships where patient_id='10000000-0000-0000-0000-0000000000e1'), 0);
-- B2 cannot write clinical rows for the unassigned patient.
do $$ begin
  insert into public.clinical_hypotheses (organization_id, patient_id, title, created_by)
   values ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1','B2 illicit hypothesis','10000000-0000-0000-0000-0000000000b2');
  insert into _t values ('B2 unassigned: clinical write blocked', 1, 0);
exception when others then
  insert into _t values ('B2 unassigned: clinical write blocked', 0, 0);
end $$;
-- B2 cannot self-assign (relationship writes are admin-gated).
do $$ begin
  insert into public.practitioner_patient_relationships (organization_id, practitioner_user_id, patient_id, created_by)
   values ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000b2','10000000-0000-0000-0000-0000000000e1','10000000-0000-0000-0000-0000000000b2');
  insert into _t values ('B2 unassigned: self-assign blocked', 1, 0);
exception when others then
  insert into _t values ('B2 unassigned: self-assign blocked', 0, 0);
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- B1: actively assigned practitioner — full access to this patient.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
insert into _t values
 ('B1 assigned: patient visible',    (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 1),
 ('B1 assigned: hypothesis visible', (select count(*) from public.clinical_hypotheses where title='Keystone test hypothesis'), 1);
do $$ begin
  insert into public.clinical_hypotheses (organization_id, patient_id, title, created_by)
   values ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1','B1 authored hypothesis','10000000-0000-0000-0000-0000000000b1');
  insert into _t values ('B1 assigned: clinical write allowed', 1, 1);
exception when others then
  insert into _t values ('B1 assigned: clinical write allowed', 0, 1);
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- A: org owner/admin — admin lane sees the patient without an assignment.
-- C1: the patient's own user — self lane reads their own profile.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
insert into _t values
 ('Admin: patient visible without assignment',    (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 1),
 ('Admin: hypothesis visible without assignment', (select count(*) from public.clinical_hypotheses where title='Keystone test hypothesis'), 1);
reset role;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
insert into _t values
 ('Patient self: own profile visible', (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 1);
reset role;

-- ---------------------------------------------------------------------------
-- Revocation: deactivate B1's assignment — access must disappear, including
-- rows B1 authored while assigned.
-- ---------------------------------------------------------------------------
update public.practitioner_patient_relationships
 set status = 'inactive'
 where practitioner_user_id = '10000000-0000-0000-0000-0000000000b1'
   and patient_id           = '10000000-0000-0000-0000-0000000000e1';

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
insert into _t values
 ('B1 revoked: patient hidden',            (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B1 revoked: hypotheses hidden',         (select count(*) from public.clinical_hypotheses where patient_id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B1 revoked: own authored row hidden',   (select count(*) from public.clinical_hypotheses where title='B1 authored hypothesis'), 0);
reset role;

select label, val, expected, (val = expected) as pass from _t order by label;

rollback;

-- ============================================================================
-- KNOWN GAP (confirmed by live probe 2026-07-15, not asserted above):
-- clinical tables use FOR ALL USING/WITH CHECK can_access_patient(), and the
-- patient-self lane satisfies that check — so a patient's own login can INSERT
-- and UPDATE clinical rows (e.g. clinical_hypotheses) about themselves.
-- patient_profiles already does this correctly (write check requires
-- practitioner/admin). Fix planned with the server-layer slice: split the bulk
-- FOR ALL policies into SELECT (can_access_patient) + write policies gated by
-- role, with a per-table classification of patient-writable tables (journals,
-- symptoms, device data) vs practitioner-only (reasoning, protocols, billing).
-- Add assertions here when that migration lands.
-- ============================================================================
