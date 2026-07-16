-- ============================================================
-- Test: 0013 app-facing RPC functions (the secure write path)
--
-- Proves review_biomarker / record_audit_event / list_audit_events /
-- create_review_task behave correctly under a *simulated authenticated
-- practitioner*, entirely inside a rolled-back transaction (no data persists).
--
-- Run via MCP execute_sql against project urcjiehlxoehievobezf, or with psql.
-- Every row of the final result set must show passed = true.
--
-- Authorization model exercised (migrations 0002 / 0012):
--   can_write_patient_data(p) = can_access_patient(p)
--                               AND (is_org_admin(org) OR has_org_role(org,'practitioner'))
--   can_access_patient(p)     = patient-self OR org-admin OR active practitioner relationship
-- So U1 (practitioner + active relationship) may write; U2 (member, no
-- relationship) may not.
--
-- NOTE on the Supabase security advisor: these four functions raise the
-- WARN "authenticated_security_definer_function_executable". That is expected
-- and accepted — they are the app's deliberate, authenticated write path to
-- the append-only audit_events table. Each authorizes the caller explicitly
-- with the same private.* helpers RLS uses, and stamps actor ids from
-- auth.uid() server-side. SECURITY INVOKER is not an option (the caller has no
-- INSERT on audit_events by design); revoking EXECUTE would remove the feature.
-- ============================================================

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;

-- ---- seed ----
insert into auth.users(id,email) values
  ('11111111-1111-1111-1111-111111111111','practitioner@verify.local'),
  ('22222222-2222-2222-2222-222222222222','outsider@verify.local');

insert into public.organizations(id,name,slug,created_by)
  values ('bbbbbbbb-0000-0000-0000-000000000001','Verify Clinic','verify-clinic-0013', null);

insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','practitioner','active');

insert into public.patient_profiles(id,organization_id,first_name,last_name)
  values ('cccccccc-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','Test','Patient');

insert into public.practitioner_patient_relationships(organization_id,practitioner_user_id,patient_id,status)
  values ('bbbbbbbb-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000001','active');

insert into public.biomarker_definitions(id,canonical_name)
  values ('dddddddd-0000-0000-0000-000000000001','Verify Marker');

insert into public.biomarker_observations
  (id,organization_id,patient_id,biomarker_definition_id,value_numeric,unit,status,
   original_value,original_unit,original_reference_interval,provenance,confidence,source,review_status)
  values
  ('eeeeeeee-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-000000000001',5.9,'mIU/L','high','5.9','mIU/L','0.4-4.0','lab_pdf_ocr',0.98,'lab','unreviewed');

do $$
declare r jsonb; taskr jsonb; aid uuid; cnt int;
begin
  perform set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  insert into _v values('auth.uid resolves from JWT claim', auth.uid()='11111111-1111-1111-1111-111111111111', auth.uid()::text);

  r := public.review_biomarker('eeeeeeee-0000-0000-0000-000000000001','accepted','looks ok');
  insert into _v values('review returns accepted', r->>'review_status'='accepted', r::text);
  insert into _v values('review previous_status unreviewed', r->>'previous_status'='unreviewed', r->>'previous_status');
  insert into _v values('review audit_event_id present', (r->>'audit_event_id') is not null, r->>'audit_event_id');

  taskr := public.create_review_task('cccccccc-0000-0000-0000-000000000001','Follow up abnormal marker','abnormal_result','high','eeeeeeee-0000-0000-0000-000000000001');
  insert into _v values('downstream task created open', taskr->>'status'='open', taskr::text);

  aid := public.record_audit_event('bbbbbbbb-0000-0000-0000-000000000001','marker.view','biomarker_observation','eeeeeeee-0000-0000-0000-000000000001','Viewed marker','cccccccc-0000-0000-0000-000000000001','{}'::jsonb);
  insert into _v values('record_audit_event returns id', aid is not null, aid::text);

  cnt := jsonb_array_length(public.list_audit_events('bbbbbbbb-0000-0000-0000-000000000001',50));
  insert into _v values('list_audit_events sees own 3 events', cnt=3, cnt::text);

  begin
    perform public.review_biomarker('eeeeeeee-0000-0000-0000-000000000001','bogus');
    insert into _v values('invalid decision rejected', false, 'no error raised');
  exception when others then
    insert into _v values('invalid decision rejected', sqlstate='22023', sqlstate);
  end;

  perform set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  begin
    perform public.review_biomarker('eeeeeeee-0000-0000-0000-000000000001','accepted');
    insert into _v values('unauthorized practitioner blocked', false, 'no error raised');
  exception when others then
    insert into _v values('unauthorized practitioner blocked', sqlstate='42501', sqlstate);
  end;

  perform set_config('request.jwt.claims','{}', true);
  begin
    perform public.review_biomarker('eeeeeeee-0000-0000-0000-000000000001','accepted');
    insert into _v values('unauthenticated blocked', false, 'no error raised');
  exception when others then
    insert into _v values('unauthenticated blocked', sqlstate='28000', sqlstate);
  end;
end $$;

insert into _v
select 'marker review columns set',
       review_status='accepted' and reviewed_by='11111111-1111-1111-1111-111111111111' and reviewed_at is not null,
       review_status||' by '||coalesce(reviewed_by::text,'null')
from public.biomarker_observations where id='eeeeeeee-0000-0000-0000-000000000001';

insert into _v
select 'lab values + provenance preserved',
       value_numeric=5.9 and unit='mIU/L' and original_reference_interval='0.4-4.0'
         and provenance='lab_pdf_ocr' and confidence=0.98 and source='lab',
       'val='||value_numeric||' ref='||original_reference_interval||' prov='||provenance
from public.biomarker_observations where id='eeeeeeee-0000-0000-0000-000000000001';

insert into _v
select 'review audit row is PHI-safe + server-stamped',
       count(*)=1 and bool_and(actor_user_id='11111111-1111-1111-1111-111111111111')
         and bool_and(metadata->>'decision'='accepted')
         and bool_and(metadata->>'previous_status'='unreviewed')
         and bool_and(not (metadata ? 'value_numeric'))
         and bool_and(safe_message not like '%5.9%'),
       'count='||count(*)
from public.audit_events where resource_id='eeeeeeee-0000-0000-0000-000000000001' and action='biomarker.review';

insert into _v
select 'review_queue_item created + linked to marker',
       count(*)=1 and bool_and(item_type='abnormal_result') and bool_and(priority='high')
         and bool_and(status='open') and bool_and(ref_id='eeeeeeee-0000-0000-0000-000000000001')
         and bool_and(created_by='11111111-1111-1111-1111-111111111111'),
       'count='||count(*)
from public.review_queue_items where patient_id='cccccccc-0000-0000-0000-000000000001';

insert into _v values('authenticated may execute review_biomarker',
  has_function_privilege('authenticated','public.review_biomarker(uuid,text,text)','execute'), 'grant');
insert into _v values('anon may NOT execute review_biomarker',
  not has_function_privilege('anon','public.review_biomarker(uuid,text,text)','execute'), 'no-grant');
insert into _v values('anon may NOT execute record_audit_event',
  not has_function_privilege('anon','public.record_audit_event(uuid,text,text,text,text,uuid,jsonb)','execute'), 'no-grant');
insert into _v values('anon may NOT execute create_review_task',
  not has_function_privilege('anon','public.create_review_task(uuid,text,text,text,uuid)','execute'), 'no-grant');
insert into _v values('anon may NOT execute list_audit_events',
  not has_function_privilege('anon','public.list_audit_events(uuid,int)','execute'), 'no-grant');

select name, passed, detail from _v order by name;
rollback;
