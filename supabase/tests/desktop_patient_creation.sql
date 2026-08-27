begin;

create temporary table _patient_creation_checks (
  check_name text primary key,
  passed boolean not null
);

insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('61000000-0000-4000-8000-000000000001', 'patient-create-owner@test.invalid', '', now(), now(), now()),
  ('61000000-0000-4000-8000-000000000002', 'patient-create-practitioner@test.invalid', '', now(), now(), now()),
  ('61000000-0000-4000-8000-000000000003', 'patient-create-staff@test.invalid', '', now(), now(), now()),
  ('61000000-0000-4000-8000-000000000004', 'patient-create-outsider@test.invalid', '', now(), now(), now());

insert into public.organizations (id, name, slug)
values
  ('61000000-0000-4000-8000-000000000010', 'Patient Create A', 'patient-create-a'),
  ('61000000-0000-4000-8000-000000000020', 'Patient Create B', 'patient-create-b');

insert into public.organization_memberships (organization_id, user_id, role, status)
values
  ('61000000-0000-4000-8000-000000000010', '61000000-0000-4000-8000-000000000001', 'owner', 'active'),
  ('61000000-0000-4000-8000-000000000010', '61000000-0000-4000-8000-000000000002', 'practitioner', 'active'),
  ('61000000-0000-4000-8000-000000000010', '61000000-0000-4000-8000-000000000003', 'staff', 'active'),
  ('61000000-0000-4000-8000-000000000020', '61000000-0000-4000-8000-000000000004', 'owner', 'active');

set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000001', true);

select public.create_patient_profile(
  '61000000-0000-4000-8000-000000000010',
  '  Synthetic ',
  ' Owner ',
  date '1985-06-15',
  'female',
  ' SYN-OWNER-1 ',
  'SYNTHETIC@EXAMPLE.INVALID',
  '555-0100'
);

reset role;

insert into _patient_creation_checks values
  ('owner created one normalized patient', (
    select count(*) = 1
      and min(first_name) = 'Synthetic'
      and min(last_name) = 'Owner'
      and min(email) = 'synthetic@example.invalid'
    from public.patient_profiles
    where organization_id = '61000000-0000-4000-8000-000000000010'
      and mrn = 'SYN-OWNER-1'
  )),
  ('creation wrote a PHI-safe audit event', (
    select count(*) = 1
      and bool_and(safe_message = 'Patient profile created')
      and bool_and(metadata = '{"source":"manual"}'::jsonb)
    from public.audit_events
    where action = 'patient.created'
      and actor_user_id = '61000000-0000-4000-8000-000000000001'
  ));

set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000002', true);
select public.create_patient_profile(
  '61000000-0000-4000-8000-000000000010',
  'Synthetic', 'Practitioner', null, 'unknown', 'SYN-PRAC-1', null, null
);
reset role;

insert into _patient_creation_checks values
  ('practitioner is assigned to the patient they create', (
    select count(*) = 1
    from public.practitioner_patient_relationships r
    join public.patient_profiles p on p.id = r.patient_id
    where p.mrn = 'SYN-PRAC-1'
      and r.practitioner_user_id = '61000000-0000-4000-8000-000000000002'
      and r.relationship_type = 'primary'
      and r.status = 'active'
  ));

do $$
declare refused boolean := false;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000003', true);
  begin
    perform public.create_patient_profile(
      '61000000-0000-4000-8000-000000000010', 'Synthetic', 'Staff', null, 'unknown', null, null, null
    );
  exception when sqlstate '42501' then refused := true;
  end;
  perform set_config('role', 'postgres', true);
  insert into _patient_creation_checks values ('staff creation refused', refused);
end $$;

do $$
declare refused boolean := false;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000004', true);
  begin
    perform public.create_patient_profile(
      '61000000-0000-4000-8000-000000000010', 'Synthetic', 'Cross Tenant', null, 'unknown', null, null, null
    );
  exception when sqlstate '42501' then refused := true;
  end;
  perform set_config('role', 'postgres', true);
  insert into _patient_creation_checks values ('cross-tenant creation refused', refused);
end $$;

do $$
declare refused boolean := false;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.create_patient_profile(
      '61000000-0000-4000-8000-000000000010', 'Synthetic', 'Anonymous', null, 'unknown', null, null, null
    );
  exception when insufficient_privilege or sqlstate '28000' then refused := true;
  end;
  perform set_config('role', 'postgres', true);
  insert into _patient_creation_checks values ('anonymous creation refused', refused);
end $$;

do $$
declare
  invalid_name boolean := false;
  invalid_sex boolean := false;
  future_dob boolean := false;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000001', true);
  begin
    perform public.create_patient_profile('61000000-0000-4000-8000-000000000010', '', 'Name', null, 'unknown', null, null, null);
  exception when sqlstate '22023' then invalid_name := true;
  end;
  begin
    perform public.create_patient_profile('61000000-0000-4000-8000-000000000010', 'Bad', 'Sex', null, 'invented', null, null, null);
  exception when sqlstate '22023' then invalid_sex := true;
  end;
  begin
    perform public.create_patient_profile('61000000-0000-4000-8000-000000000010', 'Future', 'DOB', current_date + 1, 'unknown', null, null, null);
  exception when sqlstate '22023' then future_dob := true;
  end;
  perform set_config('role', 'postgres', true);
  insert into _patient_creation_checks values
    ('empty name refused', invalid_name),
    ('invalid sex refused', invalid_sex),
    ('future date of birth refused', future_dob);
end $$;

insert into _patient_creation_checks values
  ('public has no execute', not has_function_privilege(
    'public', 'public.create_patient_profile(uuid,text,text,date,text,text,text,text)', 'execute'
  )),
  ('anon has no execute', not has_function_privilege(
    'anon', 'public.create_patient_profile(uuid,text,text,date,text,text,text,text)', 'execute'
  )),
  ('authenticated has execute', has_function_privilege(
    'authenticated', 'public.create_patient_profile(uuid,text,text,date,text,text,text,text)', 'execute'
  ));

select check_name, passed from _patient_creation_checks order by check_name;

do $$
declare failed text;
begin
  select string_agg(check_name, ', ' order by check_name) into failed
  from _patient_creation_checks where not passed;
  if failed is not null then
    raise exception 'desktop patient creation checks failed: %', failed;
  end if;
end $$;

rollback;
