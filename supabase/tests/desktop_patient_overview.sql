-- Desktop-owned patient overview acceptance tests.
-- Rolled back: the project is unchanged after the final statement.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000301','overview-pract@verify.local'),
  ('11111111-0000-0000-0000-000000000302','overview-outsider@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000301','Overview Org','overview-0030'),
  ('bbbbbbbb-0000-0000-0000-000000000302','Overview Other','overview-other-0030');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000301','11111111-0000-0000-0000-000000000301','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000302','11111111-0000-0000-0000-000000000302','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name,email) values
  ('cccccccc-0000-0000-0000-000000000301','bbbbbbbb-0000-0000-0000-000000000301','Overview','Patient','p@verify.local');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000301','11111111-0000-0000-0000-000000000301','cccccccc-0000-0000-0000-000000000301','active');

-- Clinical content: allergies (12 → bound at 10), one medication, one condition,
-- one appointment, one signed encounter+note, two lab observations, one open task.
insert into public.allergies (organization_id,patient_id,allergen,severity,status)
select 'bbbbbbbb-0000-0000-0000-000000000301','cccccccc-0000-0000-0000-000000000301',
       'Allergen ' || g, 'mild', 'active'
from generate_series(1,12) g;
insert into public.medications (organization_id,patient_id,name,dose,status) values
  ('bbbbbbbb-0000-0000-0000-000000000301','cccccccc-0000-0000-0000-000000000301','Metformin','500 mg','active');
insert into public.conditions (organization_id,patient_id,name,status) values
  ('bbbbbbbb-0000-0000-0000-000000000301','cccccccc-0000-0000-0000-000000000301','Hypothyroidism','active');
insert into public.appointments (organization_id,patient_id,appointment_type,status,starts_at,ends_at) values
  ('bbbbbbbb-0000-0000-0000-000000000301','cccccccc-0000-0000-0000-000000000301','follow-up','confirmed',
   now() - interval '10 days', now() - interval '10 days' + interval '45 minutes');
insert into public.encounters (id,organization_id,patient_id,encounter_type,status,started_at,signed_at) values
  ('dddddddd-0000-0000-0000-000000000301','bbbbbbbb-0000-0000-0000-000000000301',
   'cccccccc-0000-0000-0000-000000000301','follow-up','completed',
   now() - interval '10 days', now() - interval '9 days');
insert into public.biomarker_observations
  (organization_id,patient_id,value_numeric,unit,status,review_status,observed_at) values
  ('bbbbbbbb-0000-0000-0000-000000000301','cccccccc-0000-0000-0000-000000000301', 5.7,'%','high','unreviewed', now() - interval '2 days'),
  ('bbbbbbbb-0000-0000-0000-000000000301','cccccccc-0000-0000-0000-000000000301', 98,'mg/dL','normal','accepted', now() - interval '20 days');
insert into public.review_queue_items (organization_id,patient_id,item_type,title,priority,status) values
  ('bbbbbbbb-0000-0000-0000-000000000301','cccccccc-0000-0000-0000-000000000301',
   'abnormal_result','Review HbA1c','high','open');

-- Grants and shape.
insert into _v
select 'authenticated can execute get_patient_overview',
  has_function_privilege('authenticated','public.get_patient_overview(uuid,uuid)','execute'),
  null;
insert into _v
select 'anon cannot execute get_patient_overview',
  not has_function_privilege('anon','public.get_patient_overview(uuid,uuid)','execute'),
  null;
insert into _v
select 'overview function pins an empty search_path',
  exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='get_patient_overview'
      and p.prosecdef and 'search_path=""' = any(p.proconfig)
  ),
  (select array_to_string(p.proconfig,';') from pg_proc p
   join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='get_patient_overview');

-- Authorized read.
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000301","role":"authenticated"}', true);

do $$
declare _o jsonb;
begin
  _o := public.get_patient_overview(
    'bbbbbbbb-0000-0000-0000-000000000301',
    'cccccccc-0000-0000-0000-000000000301');

  insert into _v values('demographics carry name and presence flags only',
    (_o->'demographics'->>'fullName') = 'Overview Patient'
      and (_o->'demographics'->>'hasEmail')::boolean = true
      and (_o->'demographics'->>'hasPhone')::boolean = false
      and (_o->'demographics') ? 'hasEmail'
      and not ((_o->'demographics') ? 'email'),
    _o->'demographics' #>> '{}');

  insert into _v values('allergy list is bounded at 10',
    jsonb_array_length(_o->'allergies') = 10,
    jsonb_array_length(_o->'allergies')::text);

  insert into _v values('medications and conditions are present',
    jsonb_array_length(_o->'medications') = 1
      and jsonb_array_length(_o->'conditions') = 1,
    null);

  insert into _v values('care team includes the caller',
    exists (select 1 from jsonb_array_elements(_o->'careTeam') ct
            where (ct->>'isCaller')::boolean),
    _o->'careTeam' #>> '{}');

  insert into _v values('labs summary counts are correct',
    (_o->'labs'->>'markerCount')::int = 2
      and (_o->'labs'->>'awaitingReview')::int = 1
      and (_o->'labs'->>'abnormal')::int = 1
      and jsonb_array_length(_o->'labs'->'recent') = 2,
    _o->'labs' #>> '{}');

  insert into _v values('open tasks are listed',
    jsonb_array_length(_o->'openTasks') = 1,
    null);

  insert into _v values('ungoverned metrics are structurally absent',
    (_o->'carePlan') = 'null'::jsonb
      and jsonb_array_length(_o->'wearableSources') = 0
      and not (_o ? 'healthScore'),
    null);

  insert into _v values('missing-information names real gaps only',
    not (_o->'missingInformation' @> '["No medication list recorded"]'::jsonb)
      and (_o->'missingInformation' @> '["Date of birth not recorded"]'::jsonb),
    _o->'missingInformation' #>> '{}');

  insert into _v values('change brief is anchored to the signed encounter',
    (_o->'changesSinceLastVisit'->>'anchorEncounterAt') is not null,
    _o->'changesSinceLastVisit'->>'anchorEncounterAt');

  insert into _v values('change brief items carry dated source links',
    (select bool_and(
        (i->'source'->>'id') is not null
        and (i->'source'->>'kind') is not null
        and (i->'source'->>'at') is not null)
     from jsonb_array_elements(_o->'changesSinceLastVisit'->'items') i)
    and jsonb_array_length(_o->'changesSinceLastVisit'->'items') >= 2,
    _o->'changesSinceLastVisit'->'items' #>> '{}');

  insert into _v values('change brief excludes pre-anchor records',
    not exists (
      select 1 from jsonb_array_elements(_o->'changesSinceLastVisit'->'items') i
      where i->>'kind' = 'lab' and (i->'source'->>'at')::timestamptz < now() - interval '9 days'),
    null);
end $$;

-- Unknown patient in the caller's org.
do $$
begin
  perform public.get_patient_overview(
    'bbbbbbbb-0000-0000-0000-000000000301',
    'cccccccc-0000-0000-0000-000000000999');
  insert into _v values('unknown patient is refused',false,'no error');
exception when others then
  insert into _v values('unknown patient is refused',
    sqlstate in ('P0002','42501'), sqlstate);
end $$;

-- Cross-tenant: outsider practitioner cannot read this patient.
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000302","role":"authenticated"}', true);
do $$
begin
  perform public.get_patient_overview(
    'bbbbbbbb-0000-0000-0000-000000000301',
    'cccccccc-0000-0000-0000-000000000301');
  insert into _v values('cross-tenant overview read is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant overview read is refused',
    sqlstate = '42501', sqlstate);
end $$;

-- Member of the org but NO patient relationship: patient access must gate.
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000301','11111111-0000-0000-0000-000000000302','practitioner','active');
do $$
begin
  perform public.get_patient_overview(
    'bbbbbbbb-0000-0000-0000-000000000301',
    'cccccccc-0000-0000-0000-000000000301');
  insert into _v values('member without patient access is refused',false,'no error');
exception when others then
  insert into _v values('member without patient access is refused',
    sqlstate = '42501', sqlstate);
end $$;

-- Anonymous.
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$
begin
  perform public.get_patient_overview(
    'bbbbbbbb-0000-0000-0000-000000000301',
    'cccccccc-0000-0000-0000-000000000301');
  insert into _v values('anonymous overview read is refused',false,'no error');
exception when others then
  insert into _v values('anonymous overview read is refused',
    sqlstate = '28000', sqlstate);
end $$;

select name, passed, detail from _v order by name;
rollback;
