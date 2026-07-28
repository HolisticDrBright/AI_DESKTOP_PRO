-- Rolled-back acceptance suite for the Desktop-owned generic audit boundary.
-- Run after migrations 20260728222649 and 20260728222813.
-- Every returned row must pass.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
grant all on _v to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000101','audit-owner@verify.local'),
  ('11111111-0000-0000-0000-000000000102','audit-practitioner@verify.local'),
  ('11111111-0000-0000-0000-000000000103','audit-outsider@verify.local');

insert into public.organizations(id,name,slug,status) values
  ('bbbbbbbb-0000-0000-0000-000000000101','Audit A','audit-a','active'),
  ('bbbbbbbb-0000-0000-0000-000000000102','Audit B','audit-b','active');

insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000101','11111111-0000-0000-0000-000000000101','owner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000101','11111111-0000-0000-0000-000000000102','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000102','11111111-0000-0000-0000-000000000103','owner','active');

insert into public.patient_profiles(id,organization_id,first_name,last_name,status) values
  ('cccccccc-0000-0000-0000-000000000101','bbbbbbbb-0000-0000-0000-000000000101','Audit','Visible','active'),
  ('cccccccc-0000-0000-0000-000000000102','bbbbbbbb-0000-0000-0000-000000000102','Audit','Other','active');

insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000101','11111111-0000-0000-0000-000000000102',
   'cccccccc-0000-0000-0000-000000000101','active');

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000102","role":"authenticated"}',
  true
);
set local role authenticated;

do $$
declare _id uuid;
begin
  _id := public.record_registered_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000101',
    'marker.view',
    'marker-101',
    'cccccccc-0000-0000-0000-000000000101',
    '{}'::jsonb
  );
  insert into _v values ('registered event returns an id', _id is not null, coalesce(_id::text,''));
end;
$$;

insert into _v
select 'stored action, resource, and wording come from registry',
  count(*) = 1
  and bool_and(row->>'action' = 'marker.view')
  and bool_and(row->>'resource_type' = 'biomarker_observation')
  and bool_and(row->>'safe_message' = 'Marker viewed')
  and bool_and(row->>'actor_user_id' = '11111111-0000-0000-0000-000000000102'),
  'count=' || count(*)
from jsonb_array_elements(
  public.list_audit_events('bbbbbbbb-0000-0000-0000-000000000101', 200)
) row
where row->>'resource_id' = 'marker-101';

do $$
begin
  perform public.record_registered_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000101',
    'invented.clinical_claim',
    'claim-1',
    null,
    '{}'::jsonb
  );
  insert into _v values ('unregistered event is rejected', false, 'no error');
exception when others then
  insert into _v values ('unregistered event is rejected', sqlstate = '22023', sqlstate);
end;
$$;

do $$
begin
  perform public.record_registered_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000101',
    'marker.view',
    null,
    null,
    '{}'::jsonb
  );
  insert into _v values ('required identifiers are enforced', false, 'no error');
exception when others then
  insert into _v values ('required identifiers are enforced', sqlstate = '22023', sqlstate);
end;
$$;

do $$
begin
  perform public.record_registered_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000101',
    'report.exported',
    'report-1',
    null,
    '{"format":"pdf","report_type":"labs"}'::jsonb
  );
  insert into _v values ('registered scalar metadata is accepted', true, '');
exception when others then
  insert into _v values ('registered scalar metadata is accepted', false, sqlstate);
end;
$$;

do $$
begin
  perform public.record_registered_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000101',
    'report.exported',
    'report-2',
    null,
    '{"clinical_note":"free text"}'::jsonb
  );
  insert into _v values ('unregistered metadata key is rejected', false, 'no error');
exception when others then
  insert into _v values ('unregistered metadata key is rejected', sqlstate = '22023', sqlstate);
end;
$$;

do $$
begin
  perform public.record_registered_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000101',
    'report.exported',
    'report-3',
    null,
    '{"format":{"value":"pdf"}}'::jsonb
  );
  insert into _v values ('nested metadata is rejected', false, 'no error');
exception when others then
  insert into _v values ('nested metadata is rejected', sqlstate = '22023', sqlstate);
end;
$$;

do $$
begin
  perform public.record_registered_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000101',
    'marker.view',
    'marker-other',
    'cccccccc-0000-0000-0000-000000000102',
    '{}'::jsonb
  );
  insert into _v values ('cross-tenant patient reference is rejected', false, 'no error');
exception when others then
  insert into _v values ('cross-tenant patient reference is rejected', sqlstate = '42501', sqlstate);
end;
$$;

insert into _v
select 'practitioner list contains only own events',
  jsonb_array_length(
    public.list_audit_events('bbbbbbbb-0000-0000-0000-000000000101', 200)
  ) = 2,
  '';

reset role;

insert into public.audit_events (
  organization_id, actor_user_id, action, resource_type, resource_id, safe_message
) values (
  'bbbbbbbb-0000-0000-0000-000000000101',
  '11111111-0000-0000-0000-000000000101',
  'owner.fixture',
  'verification',
  'owner-event',
  'Owner event'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000101","role":"authenticated"}',
  true
);
set local role authenticated;

insert into _v
select 'organization owner list includes all organization events',
  jsonb_array_length(
    public.list_audit_events('bbbbbbbb-0000-0000-0000-000000000101', 200)
  ) = 3,
  '';

reset role;

insert into _v
select 'anonymous role cannot execute audit functions',
  not has_function_privilege(
    'anon',
    'public.record_registered_audit_event(uuid,text,text,uuid,jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.list_audit_events(uuid,int)',
    'execute'
  ),
  '';

insert into _v
select 'authenticated role cannot read registry or write audit table directly',
  not has_table_privilege('authenticated','private.audit_event_registry','select')
  and not has_table_privilege('authenticated','public.audit_events','insert')
  and not has_table_privilege('authenticated','public.audit_events','update')
  and not has_table_privilege('authenticated','public.audit_events','delete'),
  '';

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000103","role":"authenticated"}',
  true
);
set local role authenticated;

do $$
begin
  perform public.record_registered_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000101',
    'audit.exported',
    null,
    null,
    '{"format":"csv","row_count":3}'::jsonb
  );
  insert into _v values ('non-member cannot write audit event', false, 'no error');
exception when others then
  insert into _v values ('non-member cannot write audit event', sqlstate = '42501', sqlstate);
end;
$$;

select * from _v order by name;
rollback;
