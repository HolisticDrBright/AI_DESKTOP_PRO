-- ============================================================
-- Test: 0014 resolve_review_queue_item (Tasks live-slice write path)
--
-- Proves the RPC resolves a queue item + appends exactly one PHI-safe audit
-- row atomically, under a *simulated authenticated practitioner*, entirely in
-- a rolled-back transaction. Run via MCP execute_sql against project
-- urcjiehlxoehievobezf (or psql). Every row must show passed = true.
--
-- Covered: allowed resolve (patient-scoped + org-level), idempotent re-resolve
-- (no duplicate audit), unassigned-practitioner denial (42501),
-- unauthenticated denial (28000), row stamping, grants (anon revoked).
-- ============================================================

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;

insert into auth.users(id,email) values
  ('11111111-1111-1111-1111-111111111111','practitioner@verify.local'),
  ('22222222-2222-2222-2222-222222222222','outsider@verify.local');
insert into public.organizations(id,name,slug,created_by)
  values ('bbbbbbbb-0000-0000-0000-000000000002','Verify Clinic 14','verify-clinic-0014', null);
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name)
  values ('cccccccc-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','Queue','Patient');
insert into public.practitioner_patient_relationships(organization_id,practitioner_user_id,patient_id,status)
  values ('bbbbbbbb-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000002','active');
insert into public.review_queue_items(id,organization_id,patient_id,item_type,title,priority,status,created_by)
  values ('eeeeeeee-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000002','abnormal_result','Follow up abnormal marker','high','open','11111111-1111-1111-1111-111111111111'),
         ('eeeeeeee-0000-0000-0000-000000000003','bbbbbbbb-0000-0000-0000-000000000002',null,'assessment','Org-level item','medium','open','11111111-1111-1111-1111-111111111111');

do $$
declare r jsonb; r2 jsonb;
begin
  perform set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

  r := public.resolve_review_queue_item('eeeeeeee-0000-0000-0000-000000000002','done in visit');
  insert into _v values('resolve returns resolved', r->>'status'='resolved' and r->>'previous_status'='open', r::text);
  insert into _v values('resolve stamps audit id', (r->>'audit_event_id') is not null, r->>'audit_event_id');

  r2 := public.resolve_review_queue_item('eeeeeeee-0000-0000-0000-000000000002');
  insert into _v values('second resolve is idempotent', (r2->>'already_resolved')::boolean, r2::text);

  r := public.resolve_review_queue_item('eeeeeeee-0000-0000-0000-000000000003');
  insert into _v values('org-level item resolvable by practitioner', r->>'status'='resolved', r::text);

  perform set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  begin
    perform public.resolve_review_queue_item('eeeeeeee-0000-0000-0000-000000000002');
    insert into _v values('unassigned practitioner blocked on patient item', false, 'no error');
  exception when others then
    insert into _v values('unassigned practitioner blocked on patient item', sqlstate='42501', sqlstate);
  end;

  perform set_config('request.jwt.claims','{}', true);
  begin
    perform public.resolve_review_queue_item('eeeeeeee-0000-0000-0000-000000000002');
    insert into _v values('unauthenticated blocked', false, 'no error');
  exception when others then
    insert into _v values('unauthenticated blocked', sqlstate='28000', sqlstate);
  end;
end $$;

insert into _v
select 'row status resolved + updated_by stamped',
       status='resolved' and updated_by='11111111-1111-1111-1111-111111111111',
       status || ' by ' || coalesce(updated_by::text,'null')
from public.review_queue_items where id='eeeeeeee-0000-0000-0000-000000000002';

insert into _v
select 'exactly one audit row, PHI-safe, correct action',
       count(*)=1
         and bool_and(action='review_task.resolve')
         and bool_and(actor_user_id='11111111-1111-1111-1111-111111111111')
         and bool_and(metadata->>'previous_status'='open')
         and bool_and((metadata->>'note_present')::boolean)
         and bool_and(safe_message not like '%abnormal marker%'),
       'count='||count(*)
from public.audit_events
where resource_id='eeeeeeee-0000-0000-0000-000000000002' and action='review_task.resolve';

insert into _v values('anon may NOT execute',
  not has_function_privilege('anon','public.resolve_review_queue_item(uuid,text)','execute'), 'no-grant');
insert into _v values('authenticated may execute',
  has_function_privilege('authenticated','public.resolve_review_queue_item(uuid,text)','execute'), 'grant');

select name, passed, detail from _v order by name;
rollback;
