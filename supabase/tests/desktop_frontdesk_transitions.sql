-- Front-desk appointment transition acceptance tests.
-- Rolled back: the project is unchanged after the final statement.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000401','fd-admin@verify.local'),
  ('11111111-0000-0000-0000-000000000402','fd-practitioner@verify.local'),
  ('11111111-0000-0000-0000-000000000403','fd-outsider@verify.local'),
  ('11111111-0000-0000-0000-000000000404','fd-staff@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000401','FrontDesk Org','frontdesk-0040'),
  ('bbbbbbbb-0000-0000-0000-000000000402','FrontDesk Other','frontdesk-other-0040');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000401','11111111-0000-0000-0000-000000000401','admin','active'),
  ('bbbbbbbb-0000-0000-0000-000000000401','11111111-0000-0000-0000-000000000402','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000401','11111111-0000-0000-0000-000000000404','staff','active'),
  ('bbbbbbbb-0000-0000-0000-000000000402','11111111-0000-0000-0000-000000000403','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000401','bbbbbbbb-0000-0000-0000-000000000401','FrontDesk','Patient'),
  ('cccccccc-0000-0000-0000-000000000402','bbbbbbbb-0000-0000-0000-000000000402','Other','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000401','11111111-0000-0000-0000-000000000402','cccccccc-0000-0000-0000-000000000401','active'),
  ('bbbbbbbb-0000-0000-0000-000000000402','11111111-0000-0000-0000-000000000403','cccccccc-0000-0000-0000-000000000402','active');

-- Fresh appointments for each scenario.
insert into public.appointments
  (id,organization_id,patient_id,practitioner_user_id,appointment_type,status,starts_at,ends_at)
values
  ('dddddddd-0000-0000-0000-000000000401','bbbbbbbb-0000-0000-0000-000000000401',
   'cccccccc-0000-0000-0000-000000000401','11111111-0000-0000-0000-000000000402',
   'follow-up','scheduled', now() + interval '2 hours', now() + interval '2 hours 45 minutes'),
  ('dddddddd-0000-0000-0000-000000000402','bbbbbbbb-0000-0000-0000-000000000401',
   'cccccccc-0000-0000-0000-000000000401','11111111-0000-0000-0000-000000000402',
   'follow-up','scheduled', now() + interval '4 hours', now() + interval '4 hours 45 minutes'),
  ('dddddddd-0000-0000-0000-000000000403','bbbbbbbb-0000-0000-0000-000000000401',
   'cccccccc-0000-0000-0000-000000000401','11111111-0000-0000-0000-000000000402',
   'follow-up','scheduled', now() + interval '6 hours', now() + interval '6 hours 45 minutes'),
  ('dddddddd-0000-0000-0000-000000000404','bbbbbbbb-0000-0000-0000-000000000401',
   'cccccccc-0000-0000-0000-000000000401','11111111-0000-0000-0000-000000000402',
   'follow-up','scheduled', now() + interval '8 hours', now() + interval '8 hours 45 minutes'),
  ('dddddddd-0000-0000-0000-000000000405','bbbbbbbb-0000-0000-0000-000000000402',
   'cccccccc-0000-0000-0000-000000000402','11111111-0000-0000-0000-000000000403',
   'follow-up','scheduled', now() + interval '3 hours', now() + interval '3 hours 45 minutes');

-- ------------------------------------------------------------- contract
insert into _v
select 'authenticated can execute the transition RPCs',
  has_function_privilege('authenticated','public.transition_appointment(uuid,text,integer,text,text)','execute')
  and has_function_privilege('authenticated','public.correct_appointment_status(uuid,text,text,integer)','execute'), null;
insert into _v
select 'anon cannot execute the transition RPCs',
  not has_function_privilege('anon','public.transition_appointment(uuid,text,integer,text,text)','execute')
  and not has_function_privilege('anon','public.correct_appointment_status(uuid,text,text,integer)','execute'), null;
insert into _v
select 'transition RPCs pin an empty search_path',
  (select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('transition_appointment','correct_appointment_status')), null;
insert into _v
select 'status ledger has RLS and no direct authenticated writes',
  (select relrowsecurity from pg_class where oid='public.appointment_status_events'::regclass)
  and not has_table_privilege('authenticated','public.appointment_status_events','insert')
  and not has_table_privilege('authenticated','public.appointment_status_events','update')
  and not has_table_privilege('authenticated','public.appointment_status_events','delete'), null;
insert into _v
select 'in_encounter is an allowed appointment status',
  (select pg_get_constraintdef(oid) like '%in_encounter%'
   from pg_constraint where conname='appointments_status_check'), null;

select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000402","role":"authenticated"}', true);

-- ------------------------------------------------------------- happy path
do $$
declare _r jsonb; _v1 integer;
begin
  select version into _v1 from public.appointments
  where id='dddddddd-0000-0000-0000-000000000401';

  _r := public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000401','arrived',_v1,'idem-arrive-1',null);
  insert into _v values('scheduled → arrived succeeds and bumps the version',
    (_r->>'status')='arrived' and (_r->>'previous_status')='scheduled'
      and (_r->>'version')::int = _v1 + 1
      and (_r->>'already_applied')::boolean = false,
    _r #>> '{}');

  insert into _v values('the transition is recorded in the ledger with its actor',
    exists (select 1 from public.appointment_status_events
            where appointment_id='dddddddd-0000-0000-0000-000000000401'
              and from_status='scheduled' and to_status='arrived'
              and kind='transition'
              and actor_user_id='11111111-0000-0000-0000-000000000402'), null);

  insert into _v values('the transition writes a PHI-safe audit event',
    exists (select 1 from public.audit_events
            where resource_type='appointment'
              and resource_id='dddddddd-0000-0000-0000-000000000401'
              and action='appointment.arrived'
              and safe_message not ilike '%FrontDesk%'
              and safe_message not ilike '%Patient%'), null);

  -- Idempotent replay: same key, no second transition.
  _r := public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000401','arrived',null,'idem-arrive-1',null);
  insert into _v values('replaying the idempotency key does not transition twice',
    (_r->>'already_applied')::boolean = true
      and (select count(*) from public.appointment_status_events
           where appointment_id='dddddddd-0000-0000-0000-000000000401') = 1,
    _r #>> '{}');

  -- arrived → in_encounter → completed
  _r := public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000401','in_encounter',null,'idem-room-1',null);
  insert into _v values('arrived → in_encounter is allowed',
    (_r->>'status')='in_encounter', _r #>> '{}');
  _r := public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000401','completed',null,'idem-done-1',null);
  insert into _v values('in_encounter → completed is allowed',
    (_r->>'status')='completed', _r #>> '{}');
end $$;

-- ------------------------------------------------------------- invalid
do $$
begin
  -- completed is terminal
  perform public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000401','arrived',null,null,null);
  insert into _v values('a settled appointment refuses a normal transition',false,'no error');
exception when others then
  insert into _v values('a settled appointment refuses a normal transition',
    sqlstate='22023', sqlstate);
end $$;

do $$
begin
  -- scheduled → in_encounter skips arrival: not allowed
  perform public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000402','in_encounter',null,null,null);
  insert into _v values('scheduled → in_encounter is refused as an invalid transition',
    false,'no error');
exception when others then
  insert into _v values('scheduled → in_encounter is refused as an invalid transition',
    sqlstate='22023', sqlstate);
end $$;

do $$
begin
  perform public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000402','teleported',null,null,null);
  insert into _v values('an unknown target status is refused',false,'no error');
exception when others then
  insert into _v values('an unknown target status is refused', sqlstate='22023', sqlstate);
end $$;

-- ------------------------------------------------------------- concurrency
do $$
declare _cur integer;
begin
  select version into _cur from public.appointments
  where id='dddddddd-0000-0000-0000-000000000402';
  perform public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000402','arrived',_cur - 1,null,null);
  insert into _v values('a stale version is refused with a conflict',false,'no error');
exception when others then
  insert into _v values('a stale version is refused with a conflict',
    sqlstate='40001', sqlstate);
end $$;

-- ------------------------------------------------------------- cross-tenant
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000403","role":"authenticated"}', true);
do $$
begin
  perform public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000402','arrived',null,null,null);
  insert into _v values('a cross-tenant appointment id is refused',false,'no error');
exception when others then
  insert into _v values('a cross-tenant appointment id is refused',
    sqlstate='42501', sqlstate);
end $$;

-- Forged organization substitution is structurally impossible: the RPC takes
-- no organization argument and gates on the ROW's organization. Assert that.
insert into _v
select 'the transition RPC accepts no organization argument to forge',
  (select not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='transition_appointment'
      and pg_get_function_identity_arguments(p.oid) ilike '%organization%')), null;

-- ------------------------------------------------------------- correction authz
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000402","role":"authenticated"}', true);
do $$
begin
  perform public.correct_appointment_status(
    'dddddddd-0000-0000-0000-000000000401','arrived','mistaken completion',null);
  insert into _v values('a practitioner cannot correct a settled appointment',false,'no error');
exception when others then
  insert into _v values('a practitioner cannot correct a settled appointment',
    sqlstate='42501', sqlstate);
end $$;

select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000401","role":"authenticated"}', true);
do $$
begin
  perform public.correct_appointment_status(
    'dddddddd-0000-0000-0000-000000000401','arrived',null,null);
  insert into _v values('a correction without a reason is refused',false,'no error');
exception when others then
  insert into _v values('a correction without a reason is refused',
    sqlstate='22023', sqlstate);
end $$;

do $$
declare _r jsonb;
begin
  _r := public.correct_appointment_status(
    'dddddddd-0000-0000-0000-000000000401','arrived','completed in error at the desk',null);
  insert into _v values('an admin correction moves a settled appointment back',
    (_r->>'status')='arrived', _r #>> '{}');
  insert into _v values('the correction is ledgered as kind=correction with its reason',
    exists (select 1 from public.appointment_status_events
            where appointment_id='dddddddd-0000-0000-0000-000000000401'
              and kind='correction' and reason='completed in error at the desk'), null);
  insert into _v values('the correction is audited distinctly',
    exists (select 1 from public.audit_events
            where resource_id='dddddddd-0000-0000-0000-000000000401'
              and action='appointment.correction'), null);
end $$;

do $$
begin
  -- Corrections apply to settled appointments only.
  perform public.correct_appointment_status(
    'dddddddd-0000-0000-0000-000000000403','completed','wrong tool',null);
  insert into _v values('corrections refuse non-settled appointments',false,'no error');
exception when others then
  insert into _v values('corrections refuse non-settled appointments',
    sqlstate='22023', sqlstate);
end $$;

-- ------------------------------------------- start_encounter links the machine
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000402","role":"authenticated"}', true);
do $$
declare _enc uuid; _status text; _events int;
begin
  _enc := public.start_encounter(
    'bbbbbbbb-0000-0000-0000-000000000401',
    'cccccccc-0000-0000-0000-000000000401',
    'follow-up',
    'dddddddd-0000-0000-0000-000000000403');

  select status into _status from public.appointments
  where id='dddddddd-0000-0000-0000-000000000403';
  insert into _v values('starting an encounter moves the appointment to in_encounter',
    _status='in_encounter', _status);

  insert into _v values('the encounter-driven transition is ledgered',
    exists (select 1 from public.appointment_status_events
            where appointment_id='dddddddd-0000-0000-0000-000000000403'
              and to_status='in_encounter'), null);

  insert into _v values('the encounter still records its participant row',
    exists (select 1 from public.encounter_participants
            where encounter_id=_enc
              and user_id='11111111-0000-0000-0000-000000000402'), null);

  -- Idempotent: starting again returns the same encounter, no second transition.
  select count(*) into _events from public.appointment_status_events
  where appointment_id='dddddddd-0000-0000-0000-000000000403';
  perform public.start_encounter(
    'bbbbbbbb-0000-0000-0000-000000000401',
    'cccccccc-0000-0000-0000-000000000401',
    'follow-up',
    'dddddddd-0000-0000-0000-000000000403');
  insert into _v values('re-starting the encounter does not transition again',
    (select count(*) from public.appointment_status_events
     where appointment_id='dddddddd-0000-0000-0000-000000000403') = _events, null);
end $$;

-- ------------------------------------------------------------- no-show path
do $$
declare _r jsonb;
begin
  _r := public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000404','no_show',null,'idem-noshow-1',null);
  insert into _v values('scheduled → no_show is allowed and terminal',
    (_r->>'status')='no_show', _r #>> '{}');
end $$;
do $$
begin
  perform public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000404','arrived',null,null,null);
  insert into _v values('no_show is terminal for normal transitions',false,'no error');
exception when others then
  insert into _v values('no_show is terminal for normal transitions',
    sqlstate='22023', sqlstate);
end $$;

-- ------------------------------------------------------------- anonymous
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$
begin
  perform public.transition_appointment(
    'dddddddd-0000-0000-0000-000000000402','arrived',null,null,null);
  insert into _v values('anonymous transition is refused',false,'no error');
exception when others then
  insert into _v values('anonymous transition is refused', sqlstate='28000', sqlstate);
end $$;

select name, passed, detail from _v order by name;
rollback;
