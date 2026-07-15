-- ============================================================================
-- Practitioner-assignment access test (RLS keystone) — extended
-- ============================================================================
-- Proves the intra-org authorization model end to end, spanning one table
-- from every domain (clinical core, labs, supplements, reasoning, billing):
--
--   1. A same-org practitioner with NO assignment sees nothing patient-scoped
--      and cannot write or self-assign.
--   2. An actively-assigned practitioner reads and writes.
--   3. Revoking the assignment (status='inactive') removes access, including
--      rows the practitioner authored.
--   4. A patient linked via patient_profiles.user_id reads ONLY their own
--      record — nothing cross-patient — and CANNOT write clinical rows
--      (write-role gate, migration 0012; this was a confirmed gap, now closed
--      and asserted).
--   5. Staff scoping (defined expectation): staff see org-level rows; they see
--      patient-scoped rows ONLY when actively assigned (care-team lane); they
--      can never write clinical data and cannot create patients.
--   6. Soft-deleted rows (deleted_at is not null) vanish from SELECT
--      (migration 0012).
--
-- Runs entirely inside a transaction that is ROLLED BACK — no persistent
-- data. Run via the Supabase SQL editor, `psql`, or the MCP execute_sql tool.
-- Every row of the output must have pass = true.
-- ============================================================================
begin;

-- Throwaway auth users: A = owner/admin, B1 = assigned practitioner,
-- B2 = unassigned practitioner, S1 = staff, C1/C2 = patient logins.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
 ('10000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner@assign.test',   now(), now()),
 ('10000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','p1@assign.test',      now(), now()),
 ('10000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','p2@assign.test',      now(), now()),
 ('10000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','staff@assign.test',   now(), now()),
 ('10000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','patient1@assign.test',now(), now()),
 ('10000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','patient2@assign.test',now(), now());

-- Org + memberships (A becomes owner via the bootstrap trigger).
insert into public.organizations (id, name, slug, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','Assignment Test Org','assignment-test-org','10000000-0000-0000-0000-0000000000aa');
insert into public.organization_memberships (organization_id, user_id, role, status, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000b1','practitioner','active','10000000-0000-0000-0000-0000000000aa'),
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000b2','practitioner','active','10000000-0000-0000-0000-0000000000aa'),
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000f1','staff','active','10000000-0000-0000-0000-0000000000aa');

-- Two patients: X (linked to C1) and Y (linked to C2, for cross-patient checks).
insert into public.patient_profiles (id, organization_id, user_id, first_name, last_name, created_by) values
 ('10000000-0000-0000-0000-0000000000e1','10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000c1','Keystone','Patient','10000000-0000-0000-0000-0000000000aa'),
 ('10000000-0000-0000-0000-0000000000e2','10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000c2','Second','Patient','10000000-0000-0000-0000-0000000000aa');

-- B1 is actively assigned to X only.
insert into public.practitioner_patient_relationships (organization_id, practitioner_user_id, patient_id, relationship_type, status, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000b1','10000000-0000-0000-0000-0000000000e1','primary','active','10000000-0000-0000-0000-0000000000aa');

-- One synthetic row per domain for patient X, plus one reasoning row for Y.
insert into public.clinical_hypotheses (organization_id, patient_id, title, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1','Keystone test hypothesis','10000000-0000-0000-0000-0000000000aa'),
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e2','Second patient hypothesis','10000000-0000-0000-0000-0000000000aa');
insert into public.clinical_notes (organization_id, patient_id, body, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1','Synthetic seed note','10000000-0000-0000-0000-0000000000aa');
insert into public.biomarker_observations (organization_id, patient_id, value_numeric, unit, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1', 2.8, 'mg/L','10000000-0000-0000-0000-0000000000aa');
insert into public.supplement_protocols (organization_id, patient_id, name, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1','Keystone protocol','10000000-0000-0000-0000-0000000000aa');
insert into public.invoices (organization_id, patient_id, amount_minor, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1', 5000,'10000000-0000-0000-0000-0000000000aa');

create temp table _t (label text, val int, expected int) on commit drop;
grant all on _t to authenticated;

-- ---------------------------------------------------------------------------
-- 1) B2: active practitioner, same org, NO assignment — the keystone case.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
insert into _t values
 ('B2 unassigned: org visible (is a member)',      (select count(*) from public.organizations where id='10000000-0000-0000-0000-0000000000d1'), 1),
 ('B2 unassigned: patient hidden',                 (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B2 unassigned: reasoning row hidden',           (select count(*) from public.clinical_hypotheses where patient_id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B2 unassigned: clinical note hidden',           (select count(*) from public.clinical_notes where patient_id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B2 unassigned: lab observation hidden',         (select count(*) from public.biomarker_observations where patient_id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B2 unassigned: supplement protocol hidden',     (select count(*) from public.supplement_protocols where patient_id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B2 unassigned: invoice hidden',                 (select count(*) from public.invoices where patient_id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B2 unassigned: assignment rows hidden',         (select count(*) from public.practitioner_patient_relationships where patient_id='10000000-0000-0000-0000-0000000000e1'), 0);
do $$ begin
  insert into public.clinical_hypotheses (organization_id, patient_id, title, created_by)
   values ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1','B2 illicit hypothesis','10000000-0000-0000-0000-0000000000b2');
  insert into _t values ('B2 unassigned: clinical write blocked', 1, 0);
exception when others then
  insert into _t values ('B2 unassigned: clinical write blocked', 0, 0);
end $$;
do $$ begin
  insert into public.practitioner_patient_relationships (organization_id, practitioner_user_id, patient_id, created_by)
   values ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000b2','10000000-0000-0000-0000-0000000000e1','10000000-0000-0000-0000-0000000000b2');
  insert into _t values ('B2 unassigned: self-assign blocked', 1, 0);
exception when others then
  insert into _t values ('B2 unassigned: self-assign blocked', 0, 0);
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 2) S1: staff, unassigned — org yes, patient-scoped no, cannot create patients.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
insert into _t values
 ('Staff unassigned: org visible (is a member)', (select count(*) from public.organizations where id='10000000-0000-0000-0000-0000000000d1'), 1),
 ('Staff unassigned: patient hidden',            (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('Staff unassigned: lab observation hidden',    (select count(*) from public.biomarker_observations where patient_id='10000000-0000-0000-0000-0000000000e1'), 0);
do $$ begin
  insert into public.patient_profiles (organization_id, first_name, last_name, created_by)
   values ('10000000-0000-0000-0000-0000000000d1','Staff','Created','10000000-0000-0000-0000-0000000000f1');
  insert into _t values ('Staff: cannot create patients', 1, 0);
exception when others then
  insert into _t values ('Staff: cannot create patients', 0, 0);
end $$;
reset role;

-- Assign S1 to X (as service role): staff gain the care-team READ lane only.
insert into public.practitioner_patient_relationships (organization_id, practitioner_user_id, patient_id, relationship_type, status, created_by) values
 ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000f1','10000000-0000-0000-0000-0000000000e1','care_team','active','10000000-0000-0000-0000-0000000000aa');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
insert into _t values
 ('Staff assigned: patient visible (read lane)',  (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 1),
 ('Staff assigned: lab observation visible',      (select count(*) from public.biomarker_observations where patient_id='10000000-0000-0000-0000-0000000000e1'), 1);
do $$ begin
  insert into public.clinical_hypotheses (organization_id, patient_id, title, created_by)
   values ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1','Staff illicit hypothesis','10000000-0000-0000-0000-0000000000f1');
  insert into _t values ('Staff assigned: clinical write still blocked', 1, 0);
exception when others then
  insert into _t values ('Staff assigned: clinical write still blocked', 0, 0);
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 3) B1: actively assigned practitioner — reads every domain, writes allowed.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
insert into _t values
 ('B1 assigned: patient visible',              (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 1),
 ('B1 assigned: reasoning row visible',        (select count(*) from public.clinical_hypotheses where title='Keystone test hypothesis'), 1),
 ('B1 assigned: clinical note visible',        (select count(*) from public.clinical_notes where patient_id='10000000-0000-0000-0000-0000000000e1'), 1),
 ('B1 assigned: lab observation visible',      (select count(*) from public.biomarker_observations where patient_id='10000000-0000-0000-0000-0000000000e1'), 1),
 ('B1 assigned: supplement protocol visible',  (select count(*) from public.supplement_protocols where patient_id='10000000-0000-0000-0000-0000000000e1'), 1),
 ('B1 assigned: invoice visible',              (select count(*) from public.invoices where patient_id='10000000-0000-0000-0000-0000000000e1'), 1);
do $$ begin
  insert into public.clinical_hypotheses (organization_id, patient_id, title, created_by)
   values ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1','B1 authored hypothesis','10000000-0000-0000-0000-0000000000b1');
  insert into _t values ('B1 assigned: clinical write allowed', 1, 1);
exception when others then
  insert into _t values ('B1 assigned: clinical write allowed', 0, 1);
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 4) C1: the patient's own login — self read lane only, no cross-patient,
--    no clinical writes (write-role gate, migration 0012).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
insert into _t values
 ('Patient self: own profile visible',            (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 1),
 ('Patient self: other patient hidden',           (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e2'), 0),
 ('Patient self: own reasoning row readable',     (select count(*) from public.clinical_hypotheses where title='Keystone test hypothesis'), 1),
 ('Patient self: other patient reasoning hidden', (select count(*) from public.clinical_hypotheses where patient_id='10000000-0000-0000-0000-0000000000e2'), 0);
do $$ begin
  insert into public.clinical_hypotheses (organization_id, patient_id, title, created_by)
   values ('10000000-0000-0000-0000-0000000000d1','10000000-0000-0000-0000-0000000000e1','Patient authored hypothesis','10000000-0000-0000-0000-0000000000c1');
  insert into _t values ('Patient self: clinical INSERT blocked (0012)', 1, 0);
exception when others then
  insert into _t values ('Patient self: clinical INSERT blocked (0012)', 0, 0);
end $$;
do $$
declare n int;
begin
  update public.clinical_hypotheses set title = 'Patient modified'
   where patient_id = '10000000-0000-0000-0000-0000000000e1';
  get diagnostics n = row_count;
  insert into _t values ('Patient self: clinical UPDATE blocked (0012)', n, 0);
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 5) A: org owner/admin — admin lane, no assignment needed.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
insert into _t values
 ('Admin: patient visible without assignment',       (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 1),
 ('Admin: reasoning row visible without assignment', (select count(*) from public.clinical_hypotheses where title='Keystone test hypothesis'), 1);
reset role;

-- ---------------------------------------------------------------------------
-- 6) Soft delete (migration 0012): deleted rows vanish from SELECT.
-- ---------------------------------------------------------------------------
update public.biomarker_observations
 set deleted_at = now()
 where patient_id = '10000000-0000-0000-0000-0000000000e1';

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
insert into _t values
 ('Soft delete: lab observation hidden from SELECT', (select count(*) from public.biomarker_observations where patient_id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('Soft delete: patient itself still visible',       (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 1);
reset role;

-- ---------------------------------------------------------------------------
-- 7) Revocation: deactivate B1's assignment — access disappears, including
--    rows B1 authored while assigned.
-- ---------------------------------------------------------------------------
update public.practitioner_patient_relationships
 set status = 'inactive'
 where practitioner_user_id = '10000000-0000-0000-0000-0000000000b1'
   and patient_id           = '10000000-0000-0000-0000-0000000000e1';

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
insert into _t values
 ('B1 revoked: patient hidden',          (select count(*) from public.patient_profiles where id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B1 revoked: reasoning rows hidden',   (select count(*) from public.clinical_hypotheses where patient_id='10000000-0000-0000-0000-0000000000e1'), 0),
 ('B1 revoked: own authored row hidden', (select count(*) from public.clinical_hypotheses where title='B1 authored hypothesis'), 0);
reset role;

select label, val, expected, (val = expected) as pass from _t order by label;

rollback;
