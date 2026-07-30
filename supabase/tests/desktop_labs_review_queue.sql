-- Rolled-back acceptance suite for the Desktop-owned labs/review-queue boundary.
-- Run after migrations through 20260728220601. Every returned row must pass.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
grant all on _v to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000091','desktop-labs-owner@verify.local'),
  ('11111111-0000-0000-0000-000000000092','desktop-labs-practitioner@verify.local'),
  ('11111111-0000-0000-0000-000000000093','desktop-labs-outsider@verify.local');

insert into public.organizations(id,name,slug,status) values
  ('bbbbbbbb-0000-0000-0000-000000000091','Desktop Labs A','desktop-labs-a','active'),
  ('bbbbbbbb-0000-0000-0000-000000000092','Desktop Labs B','desktop-labs-b','active');

insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000091','11111111-0000-0000-0000-000000000091','owner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000091','11111111-0000-0000-0000-000000000092','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000092','11111111-0000-0000-0000-000000000093','owner','active');

insert into public.patient_profiles(id,organization_id,first_name,last_name,status) values
  ('cccccccc-0000-0000-0000-000000000091','bbbbbbbb-0000-0000-0000-000000000091','Visible','Patient','active'),
  ('cccccccc-0000-0000-0000-000000000092','bbbbbbbb-0000-0000-0000-000000000092','Other','Tenant','active');

insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000091','11111111-0000-0000-0000-000000000092',
   'cccccccc-0000-0000-0000-000000000091','active');

insert into public.biomarker_definitions(id,canonical_name,biological_system) values
  ('dddddddd-0000-0000-0000-000000000091','Desktop Verify TSH','Thyroid');

insert into public.lab_documents
  (id,organization_id,patient_id,file_name,storage_path,lab_company,panel_name,lab_date) values
  ('eeeeeeee-0000-0000-0000-000000000091','bbbbbbbb-0000-0000-0000-000000000091',
   'cccccccc-0000-0000-0000-000000000091','visible-panel.pdf','verify/visible-panel.pdf',
   'Verify Lab','Thyroid panel','2026-07-20'),
  ('eeeeeeee-0000-0000-0000-000000000092','bbbbbbbb-0000-0000-0000-000000000092',
   'cccccccc-0000-0000-0000-000000000092','other-panel.pdf','verify/other-panel.pdf',
   'Other Lab','Other panel','2026-07-20');

insert into public.biomarker_observations
  (id,organization_id,patient_id,biomarker_definition_id,lab_document_id,
   value_numeric,unit,status,original_reference_interval,confidence,provenance) values
  ('ffffffff-0000-0000-0000-000000000091','bbbbbbbb-0000-0000-0000-000000000091',
   'cccccccc-0000-0000-0000-000000000091','dddddddd-0000-0000-0000-000000000091',
   'eeeeeeee-0000-0000-0000-000000000091',2.1,'mIU/L','normal','0.45-4.50',0.96,'Page 2'),
  ('ffffffff-0000-0000-0000-000000000092','bbbbbbbb-0000-0000-0000-000000000092',
   'cccccccc-0000-0000-0000-000000000092','dddddddd-0000-0000-0000-000000000091',
   'eeeeeeee-0000-0000-0000-000000000092',9.9,'mIU/L','high','0.45-4.50',0.99,'Page 1');

insert into public.review_queue_items
  (id,organization_id,patient_id,item_type,title,priority,status,assignee_user_id) values
  ('99999999-0000-0000-0000-000000000091','bbbbbbbb-0000-0000-0000-000000000091',
   'cccccccc-0000-0000-0000-000000000091','abnormal_result','Review visible result','high','open',
   '11111111-0000-0000-0000-000000000092'),
  ('99999999-0000-0000-0000-000000000092','bbbbbbbb-0000-0000-0000-000000000091',
   null,'assessment','Organization QA review','low','open',null),
  ('99999999-0000-0000-0000-000000000093','bbbbbbbb-0000-0000-0000-000000000091',
   'cccccccc-0000-0000-0000-000000000091','assessment','Dismissed review','low','dismissed',null),
  ('99999999-0000-0000-0000-000000000094','bbbbbbbb-0000-0000-0000-000000000092',
   'cccccccc-0000-0000-0000-000000000092','abnormal_result','Other tenant result','high','open',null);

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000092","role":"authenticated"}',
  true
);
set local role authenticated;

insert into _v
select 'assigned practitioner sees patient and org-level queue rows',
  (select count(*) = 2 from public.list_review_queue('bbbbbbbb-0000-0000-0000-000000000091'))
  and exists (
    select 1
    from public.list_review_queue('bbbbbbbb-0000-0000-0000-000000000091')
    where id = '99999999-0000-0000-0000-000000000091'
      and patient_name = 'Visible Patient'
      and assignee_name = 'You'
  ),
  '';

insert into _v
select 'dismissed queue rows are excluded',
  not exists (
    select 1
    from public.list_review_queue('bbbbbbbb-0000-0000-0000-000000000091')
    where id = '99999999-0000-0000-0000-000000000093'
  ),
  '';

insert into _v
select 'lab read preserves source interval, definition, and document identity',
  exists (
    select 1
    from public.list_patient_lab_observations(
      'bbbbbbbb-0000-0000-0000-000000000091',
      'cccccccc-0000-0000-0000-000000000091'
    )
    where id = 'ffffffff-0000-0000-0000-000000000091'
      and canonical_name = 'Desktop Verify TSH'
      and original_reference_interval = '0.45-4.50'
      and document_file_name = 'visible-panel.pdf'
  ),
  '';

insert into _v
select 'selected-org and patient filters cannot expose another tenant lab',
  not exists (
    select 1
    from public.list_patient_lab_observations(
      'bbbbbbbb-0000-0000-0000-000000000092',
      'cccccccc-0000-0000-0000-000000000092'
    )
  ),
  '';

do $$
begin
  perform public.list_review_queue('bbbbbbbb-0000-0000-0000-000000000092');
  insert into _v values ('revoked or substituted organization is forbidden', false, 'no error');
exception
  when insufficient_privilege then
    insert into _v values ('revoked or substituted organization is forbidden', true, '');
  when others then
    insert into _v values (
      'revoked or substituted organization is forbidden',
      false,
      sqlstate
    );
end;
$$;

insert into _v
select 'direct lab-document table read is RLS-scoped',
  (select count(*) = 1 from public.lab_documents)
  and not exists (
    select 1 from public.lab_documents
    where id = 'eeeeeeee-0000-0000-0000-000000000092'
  ),
  '';

insert into _v
select 'review mutation remains atomic and caller-authorized',
  (public.review_biomarker(
    'ffffffff-0000-0000-0000-000000000091',
    'accepted',
    'verified'
  )->>'review_status') = 'accepted',
  '';

insert into _v
select 'queue resolution remains atomic and idempotent',
  (public.resolve_review_queue_item(
    '99999999-0000-0000-0000-000000000091',
    'resolved during verification'
  )->>'status') = 'resolved'
  and (public.resolve_review_queue_item(
    '99999999-0000-0000-0000-000000000091',
    null
  )->>'already_resolved')::boolean,
  '';

insert into _v
select 'review-task creation stays on the audited RPC',
  (public.create_review_task(
    'cccccccc-0000-0000-0000-000000000091',
    'Follow-up review',
    'abnormal_result',
    'medium',
    'ffffffff-0000-0000-0000-000000000091'
  )->>'status') = 'open',
  '';

reset role;

insert into _v
select 'anonymous role has no table or RPC access',
  not has_table_privilege('anon','public.biomarker_definitions','select')
  and not has_table_privilege('anon','public.biomarker_observations','select')
  and not has_table_privilege('anon','public.lab_documents','select')
  and not has_table_privilege('anon','public.review_queue_items','select')
  and not has_function_privilege('anon','public.list_review_queue(uuid)','execute')
  and not has_function_privilege(
    'anon',
    'public.list_patient_lab_observations(uuid,uuid)',
    'execute'
  )
  and not has_function_privilege('anon','public.review_biomarker(uuid,text,text)','execute')
  and not has_function_privilege('anon','public.resolve_review_queue_item(uuid,text)','execute')
  and not has_function_privilege(
    'anon',
    'public.create_review_task(uuid,text,text,text,uuid)',
    'execute'
  ),
  '';

insert into _v
select 'authenticated role has the explicit minimum table surface',
  has_table_privilege('authenticated','public.biomarker_definitions','select')
  and has_table_privilege('authenticated','public.biomarker_observations','select')
  and not has_table_privilege('authenticated','public.biomarker_observations','insert')
  and not has_table_privilege('authenticated','public.biomarker_observations','update')
  and has_table_privilege('authenticated','public.review_queue_items','select')
  and not has_table_privilege('authenticated','public.review_queue_items','insert')
  and not has_table_privilege('authenticated','public.review_queue_items','update')
  and has_table_privilege('authenticated','public.lab_documents','select')
  and has_table_privilege('authenticated','public.lab_documents','insert')
  and has_table_privilege('authenticated','public.lab_documents','update')
  and not has_table_privilege('authenticated','public.lab_documents','delete'),
  '';

insert into _v
select 'both read functions remain SECURITY INVOKER',
  not p1.prosecdef and not p2.prosecdef,
  ''
from pg_proc p1
join pg_namespace n1 on n1.oid = p1.pronamespace and n1.nspname = 'public'
join pg_proc p2 on p2.proname = 'list_patient_lab_observations'
join pg_namespace n2 on n2.oid = p2.pronamespace and n2.nspname = 'public'
where p1.proname = 'list_review_queue';

select * from _v order by name;
rollback;
