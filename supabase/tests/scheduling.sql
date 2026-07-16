-- ============================================================
-- Test: 0017 scheduling (appointments RPCs + visibility)
--
-- Proves, in a rolled-back transaction against the real project:
--   - book_appointment: patient booking + audit; practitioner AND patient
--     double-booking rejected (22023); patient-required types enforced;
--     break (patient-NULL) bookable by practitioner role
--   - update_appointment_status: scheduled → arrived → completed transitions,
--     idempotent terminal repeat, settled rejection, audit per change
--   - reschedule_appointment: moves times (self-overlap excluded) + audit
--   - authorization: unassigned practitioner 42501, unauthenticated 28000
--   - RLS SELECT: unassigned member cannot see the patient's appointment but
--     CAN see the org-level break (patient-NULL branch)
--   - grants: anon has no EXECUTE
-- Run via MCP execute_sql (or psql). Every row must show passed = true.
-- ============================================================

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
grant all on _v to authenticated;

insert into auth.users(id,email) values
  ('11111111-1111-1111-1111-111111111117','practitioner17@verify.local'),
  ('22222222-2222-2222-2222-222222222227','colleague17@verify.local');
insert into public.organizations(id,name,slug,created_by)
  values ('bbbbbbbb-0000-0000-0000-000000000017','Verify Clinic 17','verify-clinic-0017', null);
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000017','11111111-1111-1111-1111-111111111117','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000017','22222222-2222-2222-2222-222222222227','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name)
  values ('cccccccc-0000-0000-0000-000000000017','bbbbbbbb-0000-0000-0000-000000000017','Sched','Patient');
insert into public.practitioner_patient_relationships(organization_id,practitioner_user_id,patient_id,status)
  values ('bbbbbbbb-0000-0000-0000-000000000017','11111111-1111-1111-1111-111111111117','cccccccc-0000-0000-0000-000000000017','active');

select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111117","role":"authenticated"}', true);

-- A) book ----------------------------------------------------------------------
do $$
declare r jsonb; appt_id uuid;
begin
  r := public.book_appointment(
    'bbbbbbbb-0000-0000-0000-000000000017',
    '11111111-1111-1111-1111-111111111117',
    'follow-up',
    timestamptz '2026-08-03 15:00+00', timestamptz '2026-08-03 15:45+00',
    'cccccccc-0000-0000-0000-000000000017', 'Room 2');
  appt_id := (r->>'id')::uuid;
  insert into _v values('book returns scheduled', r->>'status'='scheduled' and appt_id is not null, r::text);
  perform set_config('test.appt_id', appt_id::text, true);
exception when others then
  insert into _v values('book returns scheduled', false, sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.book_appointment(
    'bbbbbbbb-0000-0000-0000-000000000017',
    '11111111-1111-1111-1111-111111111117',
    'initial',
    timestamptz '2026-08-03 15:30+00', timestamptz '2026-08-03 16:15+00',
    'cccccccc-0000-0000-0000-000000000017');
  insert into _v values('practitioner double-booking rejected', false, 'no error');
exception when others then
  insert into _v values('practitioner double-booking rejected', sqlstate='22023', sqlstate);
end $$;

-- Same patient, different practitioner, overlapping → still rejected.
insert into public.practitioner_patient_relationships(organization_id,practitioner_user_id,patient_id,status)
  values ('bbbbbbbb-0000-0000-0000-000000000017','22222222-2222-2222-2222-222222222227','cccccccc-0000-0000-0000-000000000017','active');
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222227","role":"authenticated"}', true);
do $$
begin
  perform public.book_appointment(
    'bbbbbbbb-0000-0000-0000-000000000017',
    '22222222-2222-2222-2222-222222222227',
    'initial',
    timestamptz '2026-08-03 15:15+00', timestamptz '2026-08-03 15:30+00',
    'cccccccc-0000-0000-0000-000000000017');
  insert into _v values('patient double-booking rejected', false, 'no error');
exception when others then
  insert into _v values('patient double-booking rejected', sqlstate='22023', sqlstate);
end $$;
delete from public.practitioner_patient_relationships
  where practitioner_user_id='22222222-2222-2222-2222-222222222227';
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111117","role":"authenticated"}', true);

do $$
begin
  perform public.book_appointment(
    'bbbbbbbb-0000-0000-0000-000000000017',
    '11111111-1111-1111-1111-111111111117',
    'initial',
    timestamptz '2026-08-04 09:00+00', timestamptz '2026-08-04 09:30+00');
  insert into _v values('patient-required type without patient rejected', false, 'no error');
exception when others then
  insert into _v values('patient-required type without patient rejected', sqlstate='22023', sqlstate);
end $$;

do $$
declare r jsonb;
begin
  r := public.book_appointment(
    'bbbbbbbb-0000-0000-0000-000000000017',
    '11111111-1111-1111-1111-111111111117',
    'break',
    timestamptz '2026-08-03 12:00+00', timestamptz '2026-08-03 12:30+00');
  insert into _v values('break (patient-NULL) bookable', r->>'status'='scheduled', r::text);
exception when others then
  insert into _v values('break (patient-NULL) bookable', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'book audit rows exist (counts only)',
       count(*)=2 and bool_and(safe_message not like '%Sched%'),
       'count='||count(*)
from public.audit_events
where organization_id='bbbbbbbb-0000-0000-0000-000000000017' and action='appointment.book';

-- B) status transitions ----------------------------------------------------------
do $$
declare r jsonb; appt_id uuid := current_setting('test.appt_id', true)::uuid;
begin
  r := public.update_appointment_status(appt_id, 'arrived');
  insert into _v values('scheduled → arrived', r->>'status'='arrived' and r->>'previous_status'='scheduled', r::text);
  r := public.update_appointment_status(appt_id, 'completed');
  insert into _v values('arrived → completed', r->>'status'='completed', r::text);
  r := public.update_appointment_status(appt_id, 'completed');
  insert into _v values('terminal repeat is idempotent', (r->>'already_set')::boolean, r::text);
exception when others then
  insert into _v values('status transition chain', false, sqlstate||' '||sqlerrm);
end $$;

do $$
declare appt_id uuid := current_setting('test.appt_id', true)::uuid;
begin
  perform public.update_appointment_status(appt_id, 'cancelled');
  insert into _v values('settled → other status rejected', false, 'no error');
exception when others then
  insert into _v values('settled → other status rejected', sqlstate='22023', sqlstate);
end $$;

insert into _v
select 'status audit rows appended',
       count(*)=2,
       'count='||count(*)
from public.audit_events
where organization_id='bbbbbbbb-0000-0000-0000-000000000017' and action='appointment.status';

-- C) reschedule -------------------------------------------------------------------
do $$
declare r jsonb; new_id uuid;
begin
  r := public.book_appointment(
    'bbbbbbbb-0000-0000-0000-000000000017',
    '11111111-1111-1111-1111-111111111117',
    'lab-review',
    timestamptz '2026-08-05 10:00+00', timestamptz '2026-08-05 10:30+00',
    'cccccccc-0000-0000-0000-000000000017');
  new_id := (r->>'id')::uuid;
  r := public.reschedule_appointment(new_id,
    timestamptz '2026-08-05 10:15+00', timestamptz '2026-08-05 10:45+00');
  insert into _v values('reschedule (self-overlap excluded) works',
    r->>'starts_at' is not null, r::text);
exception when others then
  insert into _v values('reschedule (self-overlap excluded) works', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'reschedule audited',
       count(*)=1,
       'count='||count(*)
from public.audit_events
where organization_id='bbbbbbbb-0000-0000-0000-000000000017' and action='appointment.reschedule';

-- D) authorization ------------------------------------------------------------------
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222227","role":"authenticated"}', true);
do $$
begin
  perform public.book_appointment(
    'bbbbbbbb-0000-0000-0000-000000000017',
    '22222222-2222-2222-2222-222222222227',
    'initial',
    timestamptz '2026-08-06 09:00+00', timestamptz '2026-08-06 09:30+00',
    'cccccccc-0000-0000-0000-000000000017');
  insert into _v values('unassigned practitioner cannot book for patient', false, 'no error');
exception when others then
  insert into _v values('unassigned practitioner cannot book for patient', sqlstate='42501', sqlstate);
end $$;

select set_config('request.jwt.claims','{}', true);
do $$
begin
  perform public.book_appointment(
    'bbbbbbbb-0000-0000-0000-000000000017',
    '11111111-1111-1111-1111-111111111117',
    'break',
    timestamptz '2026-08-06 12:00+00', timestamptz '2026-08-06 12:30+00');
  insert into _v values('unauthenticated cannot book', false, 'no error');
exception when others then
  insert into _v values('unauthenticated cannot book', sqlstate='28000', sqlstate);
end $$;

-- E) RLS visibility (role-switched) ---------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222227","role":"authenticated"}', true);
insert into _v
select 'unassigned member: break visible, patient rows hidden',
       count(*) filter (where patient_id is null) = 1
         and count(*) filter (where patient_id is not null) = 0,
       'visible='||count(*)
from public.appointments
where organization_id='bbbbbbbb-0000-0000-0000-000000000017';

select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111117","role":"authenticated"}', true);
insert into _v
select 'assigned practitioner sees patient rows + break',
       count(*) filter (where patient_id is not null) = 2
         and count(*) filter (where patient_id is null) = 1,
       'visible='||count(*)
from public.appointments
where organization_id='bbbbbbbb-0000-0000-0000-000000000017';
reset role;

-- F) grants ----------------------------------------------------------------------------
insert into _v values('anon may NOT execute book',
  not has_function_privilege('anon','public.book_appointment(uuid,uuid,text,timestamptz,timestamptz,uuid,text,text,text)','execute'), 'no-grant');
insert into _v values('anon may NOT execute status',
  not has_function_privilege('anon','public.update_appointment_status(uuid,text)','execute'), 'no-grant');
insert into _v values('anon may NOT execute reschedule',
  not has_function_privilege('anon','public.reschedule_appointment(uuid,timestamptz,timestamptz)','execute'), 'no-grant');

select name, passed, detail from _v order by name;
rollback;
