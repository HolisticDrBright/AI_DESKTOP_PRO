-- Desktop-owned scheduling acceptance suite.
-- Run against the clinical project in a rolled-back transaction.

begin;

create temp table _v (
  name text primary key,
  passed boolean not null,
  detail text
) on commit drop;
grant all on _v to authenticated;

insert into auth.users (id, email) values
  ('11111111-0000-4000-8000-000000000041', 'owner.schedule@verify.local'),
  ('11111111-0000-4000-8000-000000000042', 'practitioner.schedule@verify.local'),
  ('11111111-0000-4000-8000-000000000043', 'staff.schedule@verify.local'),
  ('11111111-0000-4000-8000-000000000044', 'member.schedule@verify.local'),
  ('11111111-0000-4000-8000-000000000045', 'outsider.schedule@verify.local');

insert into public.organizations (id, name, slug) values
  ('22222222-0000-4000-8000-000000000041', 'Scheduling A', 'scheduling-a-verify'),
  ('22222222-0000-4000-8000-000000000042', 'Scheduling B', 'scheduling-b-verify');

insert into public.organization_memberships (
  organization_id, user_id, role, status
) values
  ('22222222-0000-4000-8000-000000000041', '11111111-0000-4000-8000-000000000041', 'owner', 'active'),
  ('22222222-0000-4000-8000-000000000041', '11111111-0000-4000-8000-000000000042', 'practitioner', 'active'),
  ('22222222-0000-4000-8000-000000000041', '11111111-0000-4000-8000-000000000043', 'staff', 'active'),
  ('22222222-0000-4000-8000-000000000041', '11111111-0000-4000-8000-000000000044', 'member', 'active'),
  ('22222222-0000-4000-8000-000000000042', '11111111-0000-4000-8000-000000000045', 'owner', 'active');

insert into public.practitioner_profiles (
  organization_id, user_id, display_name, credentials
) values
  ('22222222-0000-4000-8000-000000000041', '11111111-0000-4000-8000-000000000041', 'Owner Clinician', 'MD'),
  ('22222222-0000-4000-8000-000000000041', '11111111-0000-4000-8000-000000000042', 'Assigned Clinician', 'ND'),
  ('22222222-0000-4000-8000-000000000042', '11111111-0000-4000-8000-000000000045', 'Outside Clinician', 'DO');

insert into public.patient_profiles (
  id, organization_id, first_name, last_name, status
) values
  ('33333333-0000-4000-8000-000000000041', '22222222-0000-4000-8000-000000000041', 'Assigned', 'Patient', 'active'),
  ('33333333-0000-4000-8000-000000000042', '22222222-0000-4000-8000-000000000041', 'Front Desk', 'Patient', 'active'),
  ('33333333-0000-4000-8000-000000000043', '22222222-0000-4000-8000-000000000042', 'Outside', 'Patient', 'active');

insert into public.practitioner_patient_relationships (
  organization_id, practitioner_user_id, patient_id, status
) values (
  '22222222-0000-4000-8000-000000000041',
  '11111111-0000-4000-8000-000000000042',
  '33333333-0000-4000-8000-000000000041',
  'active'
);

insert into public.appointments (
  id, organization_id, patient_id, practitioner_user_id, appointment_type,
  status, starts_at, ends_at, location
) values
  (
    '44444444-0000-4000-8000-000000000041',
    '22222222-0000-4000-8000-000000000041',
    '33333333-0000-4000-8000-000000000041',
    '11111111-0000-4000-8000-000000000042',
    'follow-up', 'confirmed',
    '2026-09-07 16:00+00', '2026-09-07 16:45+00', 'Room 1'
  ),
  (
    '44444444-0000-4000-8000-000000000042',
    '22222222-0000-4000-8000-000000000041',
    '33333333-0000-4000-8000-000000000042',
    '11111111-0000-4000-8000-000000000041',
    'initial', 'scheduled',
    '2026-09-08 17:00+00', '2026-09-08 18:00+00', 'Room 2'
  ),
  (
    '44444444-0000-4000-8000-000000000043',
    '22222222-0000-4000-8000-000000000041',
    null,
    '11111111-0000-4000-8000-000000000042',
    'break', 'scheduled',
    '2026-09-09 19:00+00', '2026-09-09 19:30+00', 'Admin'
  ),
  (
    '44444444-0000-4000-8000-000000000044',
    '22222222-0000-4000-8000-000000000042',
    '33333333-0000-4000-8000-000000000043',
    '11111111-0000-4000-8000-000000000045',
    'follow-up', 'scheduled',
    '2026-09-07 16:00+00', '2026-09-07 16:45+00', 'Outside'
  );

-- Anonymous callers cannot read the calendar.
select set_config('request.jwt.claims', '{}', true);
do $$
begin
  perform public.get_desktop_calendar(
    '22222222-0000-4000-8000-000000000041',
    '2026-09-07 00:00+00',
    '2026-09-14 00:00+00'
  );
  insert into _v values ('anonymous calendar denied', false, 'no error');
exception when others then
  insert into _v values ('anonymous calendar denied', sqlstate = '28000', sqlstate);
end $$;

-- An active user in another organization cannot substitute the org id.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-4000-8000-000000000045","role":"authenticated"}',
  true
);
do $$
begin
  perform public.get_desktop_calendar(
    '22222222-0000-4000-8000-000000000041',
    '2026-09-07 00:00+00',
    '2026-09-14 00:00+00'
  );
  insert into _v values ('cross-org calendar denied', false, 'no error');
exception when others then
  insert into _v values ('cross-org calendar denied', sqlstate = '42501', sqlstate);
end $$;

-- Assigned practitioners see their patient and org blocks, not another chart.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-4000-8000-000000000042","role":"authenticated"}',
  true
);
do $$
declare
  r jsonb;
begin
  r := public.get_desktop_calendar(
    '22222222-0000-4000-8000-000000000041',
    '2026-09-07 00:00+00',
    '2026-09-14 00:00+00'
  );
  insert into _v values (
    'practitioner calendar is patient-scoped',
    jsonb_array_length(r->'appointments') = 2
      and jsonb_path_exists(r, '$.appointments[*] ? (@.patient_name == "Assigned Patient")')
      and not jsonb_path_exists(r, '$.appointments[*] ? (@.patient_name == "Front Desk Patient")'),
    'appointments=' || jsonb_array_length(r->'appointments')
  );
  insert into _v values (
    'practitioner patient picker is assigned-only',
    jsonb_array_length(r->'patients') = 1
      and r->'patients'->0->>'name' = 'Assigned Patient',
    'patients=' || jsonb_array_length(r->'patients')
  );
end $$;

-- Front desk receives operational fields for the whole org, not chart data.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-4000-8000-000000000043","role":"authenticated"}',
  true
);
do $$
declare
  r jsonb;
  first_keys text[];
begin
  r := public.get_desktop_calendar(
    '22222222-0000-4000-8000-000000000041',
    '2026-09-07 00:00+00',
    '2026-09-14 00:00+00'
  );
  select array_agg(k order by k)
    into first_keys
  from jsonb_object_keys(r->'appointments'->0) k;
  insert into _v values (
    'staff sees the org schedule',
    jsonb_array_length(r->'appointments') = 3
      and jsonb_array_length(r->'patients') = 2,
    'appointments=' || jsonb_array_length(r->'appointments')
      || ', patients=' || jsonb_array_length(r->'patients')
  );
  insert into _v values (
    'calendar appointment contract is limited',
    first_keys = array[
      'appointment_type','ends_at','id','location','patient_id','patient_name',
      'practitioner_name','practitioner_user_id','starts_at','status',
      'telehealth_url','title'
    ]::text[],
    array_to_string(first_keys, ',')
  );
end $$;

-- Generic members see org blocks but cannot schedule patients.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-4000-8000-000000000044","role":"authenticated"}',
  true
);
do $$
declare r jsonb;
begin
  r := public.get_desktop_calendar(
    '22222222-0000-4000-8000-000000000041',
    '2026-09-07 00:00+00',
    '2026-09-14 00:00+00'
  );
  insert into _v values (
    'member sees blocks without patient picker',
    jsonb_array_length(r->'appointments') = 1
      and jsonb_array_length(r->'patients') = 0
      and r->'appointments'->0->>'patient_id' is null,
    r::text
  );
end $$;

-- Range bounds prevent accidental unbounded exports.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-4000-8000-000000000041","role":"authenticated"}',
  true
);
do $$
begin
  perform public.get_desktop_calendar(
    '22222222-0000-4000-8000-000000000041',
    '2026-09-07 00:00+00',
    '2026-11-07 00:00+00'
  );
  insert into _v values ('wide calendar range denied', false, 'no error');
exception when others then
  insert into _v values ('wide calendar range denied', sqlstate = '22023', sqlstate);
end $$;

-- Staff can run front-desk actions without clinical chart write privileges.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-4000-8000-000000000043","role":"authenticated"}',
  true
);
do $$
declare
  r jsonb;
  appt_id uuid;
begin
  r := public.book_appointment(
    '22222222-0000-4000-8000-000000000041',
    '11111111-0000-4000-8000-000000000042',
    'lab-review',
    '2026-09-10 20:00+00',
    '2026-09-10 20:30+00',
    '33333333-0000-4000-8000-000000000042',
    'Room 3'
  );
  appt_id := (r->>'id')::uuid;
  perform set_config('test.desktop_schedule_appt', appt_id::text, true);
  insert into _v values (
    'staff books patient appointment',
    r->>'status' = 'scheduled' and appt_id is not null,
    r::text
  );

  r := public.reschedule_appointment(
    appt_id,
    '2026-09-10 21:00+00',
    '2026-09-10 21:30+00'
  );
  insert into _v values (
    'staff reschedules appointment',
    (r->>'starts_at')::timestamptz = '2026-09-10 21:00+00'::timestamptz,
    r::text
  );

  r := public.update_appointment_status(appt_id, 'no_show');
  insert into _v values (
    'staff records no-show',
    r->>'status' = 'no_show' and not (r->>'already_set')::boolean,
    r::text
  );

  r := public.update_appointment_status(appt_id, 'no_show');
  insert into _v values (
    'repeated no-show is idempotent',
    (r->>'already_set')::boolean,
    r::text
  );
end $$;

-- A staff account is allowed to manage but cannot be selected as clinician.
do $$
begin
  perform public.book_appointment(
    '22222222-0000-4000-8000-000000000041',
    '11111111-0000-4000-8000-000000000043',
    'break',
    '2026-09-11 20:00+00',
    '2026-09-11 20:30+00'
  );
  insert into _v values ('staff cannot be clinician target', false, 'no error');
exception when others then
  insert into _v values ('staff cannot be clinician target', sqlstate = '22023', sqlstate);
end $$;

-- Double-booking is still rejected after the lock is acquired.
do $$
begin
  perform public.book_appointment(
    '22222222-0000-4000-8000-000000000041',
    '11111111-0000-4000-8000-000000000042',
    'follow-up',
    '2026-09-07 16:15+00',
    '2026-09-07 16:30+00',
    '33333333-0000-4000-8000-000000000041'
  );
  insert into _v values ('overlap rejected after scheduling lock', false, 'no error');
exception when others then
  insert into _v values ('overlap rejected after scheduling lock', sqlstate = '22023', sqlstate);
end $$;

-- Assigned practitioners still cannot schedule an unassigned patient.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-4000-8000-000000000042","role":"authenticated"}',
  true
);
do $$
begin
  perform public.book_appointment(
    '22222222-0000-4000-8000-000000000041',
    '11111111-0000-4000-8000-000000000042',
    'follow-up',
    '2026-09-12 16:00+00',
    '2026-09-12 16:30+00',
    '33333333-0000-4000-8000-000000000042'
  );
  insert into _v values ('practitioner cannot book unassigned patient', false, 'no error');
exception when others then
  insert into _v values ('practitioner cannot book unassigned patient', sqlstate = '42501', sqlstate);
end $$;

-- Generic members cannot mutate even org-level blocks.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-4000-8000-000000000044","role":"authenticated"}',
  true
);
do $$
begin
  perform public.book_appointment(
    '22222222-0000-4000-8000-000000000041',
    '11111111-0000-4000-8000-000000000042',
    'break',
    '2026-09-12 18:00+00',
    '2026-09-12 18:30+00'
  );
  insert into _v values ('member cannot manage schedule', false, 'no error');
exception when others then
  insert into _v values ('member cannot manage schedule', sqlstate = '42501', sqlstate);
end $$;

-- Another organization cannot mutate an appointment by guessed id.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-4000-8000-000000000045","role":"authenticated"}',
  true
);
do $$
begin
  perform public.update_appointment_status(
    current_setting('test.desktop_schedule_appt', true)::uuid,
    'cancelled'
  );
  insert into _v values ('cross-org appointment mutation denied', false, 'no error');
exception when others then
  insert into _v values ('cross-org appointment mutation denied', sqlstate = '42501', sqlstate);
end $$;

reset role;

-- Audit is atomic, idempotent repeats do not create duplicate status rows, and
-- safe messages do not contain patient names.
insert into _v
select
  'front-desk actions are audited once',
  count(*) filter (where action = 'appointment.book') = 1
    and count(*) filter (where action = 'appointment.reschedule') = 1
    and count(*) filter (where action = 'appointment.status') = 1
    and bool_and(safe_message not ilike '%Front Desk%'),
  'rows=' || count(*)
from public.audit_events
where resource_id = current_setting('test.desktop_schedule_appt', true);

-- The raw appointment table is not a browser-facing Data API surface.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-4000-8000-000000000043","role":"authenticated"}',
  true
);
do $$
begin
  perform count(*) from public.appointments;
  insert into _v values ('direct appointment table denied', false, 'no error');
exception when others then
  insert into _v values ('direct appointment table denied', sqlstate = '42501', sqlstate);
end $$;
reset role;

insert into _v values (
  'anon cannot execute calendar RPC',
  not has_function_privilege(
    'anon',
    'public.get_desktop_calendar(uuid,timestamptz,timestamptz)',
    'execute'
  ),
  'no grant'
);
insert into _v values (
  'anon cannot execute booking RPC',
  not has_function_privilege(
    'anon',
    'public.book_appointment(uuid,uuid,text,timestamptz,timestamptz,uuid,text,text,text)',
    'execute'
  ),
  'no grant'
);

select name, passed, detail from _v order by name;

rollback;
