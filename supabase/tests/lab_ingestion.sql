-- ============================================================
-- Test: 0016 lab ingestion (storage RLS + ingest/fail RPCs)
--
-- Proves, in a rolled-back transaction against the real project:
--   - practitioners can INSERT lab_documents under RLS; outsiders cannot
--   - storage.objects policies allow only well-formed {org}/{patient}/... paths
--     for users with write access to that patient
--   - ingest_lab_extraction inserts observations with original_* VERBATIM,
--     status only from source flags, definitions matched by name, one
--     low-confidence review-queue item, doc → extracted, one PHI-safe audit row
--   - re-ingest blocked (22023), unauthorized (42501), unauthenticated (28000)
--   - mark_lab_document_failed normalizes reasons + audits; anon has no EXECUTE
-- Run via MCP execute_sql (or psql). Every row must show passed = true.
-- ============================================================

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
grant all on _v to authenticated;

-- Fixtures (as postgres) ------------------------------------------------------
insert into auth.users(id,email) values
  ('11111111-1111-1111-1111-111111111116','practitioner16@verify.local'),
  ('22222222-2222-2222-2222-222222222226','outsider16@verify.local');
insert into public.organizations(id,name,slug,created_by)
  values ('bbbbbbbb-0000-0000-0000-000000000016','Verify Clinic 16','verify-clinic-0016', null);
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000016','11111111-1111-1111-1111-111111111116','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000016','22222222-2222-2222-2222-222222222226','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name)
  values ('cccccccc-0000-0000-0000-000000000016','bbbbbbbb-0000-0000-0000-000000000016','Ingest','Patient');
insert into public.practitioner_patient_relationships(organization_id,practitioner_user_id,patient_id,status)
  values ('bbbbbbbb-0000-0000-0000-000000000016','11111111-1111-1111-1111-111111111116','cccccccc-0000-0000-0000-000000000016','active');
insert into public.biomarker_definitions(id,canonical_name,default_unit) values
  ('dddddddd-0000-0000-0000-000000000001','hs-CRP','mg/L'),
  ('dddddddd-0000-0000-0000-000000000002','Ferritin','ng/mL')
on conflict do nothing;

-- A) lab_documents INSERT under RLS ------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111116","role":"authenticated"}', true);

do $$
begin
  insert into public.lab_documents(id,organization_id,patient_id,file_name,file_type,storage_path,uploaded_by,created_by)
  values ('aaaa0000-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000016','cccccccc-0000-0000-0000-000000000016',
          'panel.pdf','application/pdf',
          'bbbbbbbb-0000-0000-0000-000000000016/cccccccc-0000-0000-0000-000000000016/aaaa0000-0000-0000-0000-000000000001.pdf',
          '11111111-1111-1111-1111-111111111116','11111111-1111-1111-1111-111111111116');
  insert into _v values('practitioner can insert lab_documents (RLS)', true, 'ok');
exception when others then
  insert into _v values('practitioner can insert lab_documents (RLS)', false, sqlstate||' '||sqlerrm);
end $$;

-- Storage: well-formed path for an accessible patient is writable
do $$
begin
  insert into storage.objects(bucket_id,name)
  values ('lab-documents','bbbbbbbb-0000-0000-0000-000000000016/cccccccc-0000-0000-0000-000000000016/aaaa0000-0000-0000-0000-000000000001.pdf');
  insert into _v values('storage insert allowed on own patient path', true, 'ok');
exception when others then
  insert into _v values('storage insert allowed on own patient path', false, sqlstate||' '||sqlerrm);
end $$;

-- Storage: malformed (non-uuid) path is rejected, never cast-errored
do $$
begin
  insert into storage.objects(bucket_id,name) values ('lab-documents','not-a-uuid/whatever/file.pdf');
  insert into _v values('storage insert blocked on malformed path', false, 'no error');
exception when others then
  insert into _v values('storage insert blocked on malformed path', sqlstate='42501', sqlstate||' '||sqlerrm);
end $$;

-- Outsider (org member, NO patient relationship)
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222226","role":"authenticated"}', true);

do $$
begin
  insert into public.lab_documents(id,organization_id,patient_id,file_name,storage_path)
  values ('aaaa0000-0000-0000-0000-00000000000f','bbbbbbbb-0000-0000-0000-000000000016','cccccccc-0000-0000-0000-000000000016','x.pdf','p');
  insert into _v values('unassigned practitioner cannot insert lab_documents', false, 'no error');
exception when others then
  insert into _v values('unassigned practitioner cannot insert lab_documents', sqlstate='42501', sqlstate);
end $$;

do $$
begin
  insert into storage.objects(bucket_id,name)
  values ('lab-documents','bbbbbbbb-0000-0000-0000-000000000016/cccccccc-0000-0000-0000-000000000016/other.pdf');
  insert into _v values('storage insert blocked for unassigned practitioner', false, 'no error');
exception when others then
  insert into _v values('storage insert blocked for unassigned practitioner', sqlstate='42501', sqlstate);
end $$;

reset role;

-- B) ingest_lab_extraction happy path ----------------------------------------
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111116","role":"authenticated"}', true);

do $$
declare r jsonb;
begin
  r := public.ingest_lab_extraction(
    'aaaa0000-0000-0000-0000-000000000001',
    jsonb_build_array(
      jsonb_build_object('name','hs-CRP','valueNumeric',2.8,'unit','mg/L','referenceInterval','< 1.0 mg/L','flag','H','page',2,'confidence',0.97),
      jsonb_build_object('name','Ferritin','valueNumeric',96,'unit','ng/mL','referenceInterval','30-400 ng/mL','page',3,'confidence',0.55),
      jsonb_build_object('name','Mystery Analyte','valueNumeric',4.2,'unit','au','confidence',0.62),
      jsonb_build_object('name','COVID-19 Ab','valueText','Positive','confidence',0.9),
      jsonb_build_object('name','','valueNumeric',1)
    ),
    'Verify Labs Inc', 'Comprehensive panel', date '2026-07-01');
  insert into _v values('ingest returns extracted summary',
    r->>'status'='extracted' and (r->>'inserted')::int=4 and (r->>'matched')::int=2
      and (r->>'low_confidence')::int=2 and (r->>'queue_item_id') is not null,
    r::text);
exception when others then
  insert into _v values('ingest returns extracted summary', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'observations inserted with verbatim originals',
       count(*)=4
         and bool_and(review_status='unreviewed')
         and bool_and(provenance='pdf_extraction')
         and count(*) filter (where original_name='hs-CRP' and original_reference_interval='< 1.0 mg/L'
                                and status='high' and source_page=2 and confidence=0.97
                                and biomarker_definition_id='dddddddd-0000-0000-0000-000000000001')=1
         and count(*) filter (where original_name='Ferritin' and status is null
                                and biomarker_definition_id='dddddddd-0000-0000-0000-000000000002')=1
         and count(*) filter (where original_name='Mystery Analyte' and biomarker_definition_id is null)=1
         and count(*) filter (where original_name='COVID-19 Ab' and value_numeric is null and value_text='Positive')=1,
       'count='||count(*)
from public.biomarker_observations
where lab_document_id='aaaa0000-0000-0000-0000-000000000001';

insert into _v
select 'document marked extracted with panel metadata',
       processing_status='extracted' and lab_company='Verify Labs Inc'
         and panel_name='Comprehensive panel' and lab_date=date '2026-07-01'
         and updated_by='11111111-1111-1111-1111-111111111116',
       processing_status
from public.lab_documents where id='aaaa0000-0000-0000-0000-000000000001';

insert into _v
select 'one low-confidence review-queue item, PHI-safe title',
       count(*)=1
         and bool_and(item_type='lab_extraction' and status='open' and priority='medium')
         and bool_and(title='Verify 2 low-confidence markers from uploaded panel'),
       'count='||count(*)
from public.review_queue_items
where ref_id='aaaa0000-0000-0000-0000-000000000001';

insert into _v
select 'exactly one ingest audit row, counts only',
       count(*)=1
         and bool_and(actor_user_id='11111111-1111-1111-1111-111111111116')
         and bool_and((metadata->>'marker_count')::int=4)
         and bool_and((metadata->>'low_confidence_count')::int=2)
         and bool_and((metadata->>'matched_definitions')::int=2)
         and bool_and(safe_message not like '%hs-CRP%' and safe_message not like '%Ferritin%'),
       'count='||count(*)
from public.audit_events
where resource_id='aaaa0000-0000-0000-0000-000000000001' and action='lab_document.ingest';

-- C) guard rails ---------------------------------------------------------------
do $$
begin
  perform public.ingest_lab_extraction('aaaa0000-0000-0000-0000-000000000001',
    jsonb_build_array(jsonb_build_object('name','x','valueNumeric',1)));
  insert into _v values('re-ingest of extracted doc blocked', false, 'no error');
exception when others then
  insert into _v values('re-ingest of extracted doc blocked', sqlstate='22023', sqlstate);
end $$;

do $$
begin
  perform public.mark_lab_document_failed('aaaa0000-0000-0000-0000-000000000001','extraction_error');
  insert into _v values('cannot fail an extracted doc', false, 'no error');
exception when others then
  insert into _v values('cannot fail an extracted doc', sqlstate='22023', sqlstate);
end $$;

-- second document: failure path
insert into public.lab_documents(id,organization_id,patient_id,file_name,storage_path,uploaded_by)
values ('aaaa0000-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000016','cccccccc-0000-0000-0000-000000000016',
        'panel2.pdf','bbbbbbbb-0000-0000-0000-000000000016/cccccccc-0000-0000-0000-000000000016/aaaa0000-0000-0000-0000-000000000002.pdf',
        '11111111-1111-1111-1111-111111111116');

do $$
declare r jsonb;
begin
  r := public.mark_lab_document_failed('aaaa0000-0000-0000-0000-000000000002','totally custom reason');
  insert into _v values('fail path normalizes unknown reason',
    r->>'status'='failed' and r->>'reason'='extraction_error', r::text);
exception when others then
  insert into _v values('fail path normalizes unknown reason', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'failed doc audited',
       count(*)=1 and bool_and(metadata->>'reason'='extraction_error'),
       'count='||count(*)
from public.audit_events
where resource_id='aaaa0000-0000-0000-0000-000000000002' and action='lab_document.failed';

-- third document: outsider cannot ingest
insert into public.lab_documents(id,organization_id,patient_id,file_name,storage_path,uploaded_by)
values ('aaaa0000-0000-0000-0000-000000000003','bbbbbbbb-0000-0000-0000-000000000016','cccccccc-0000-0000-0000-000000000016',
        'panel3.pdf','bbbbbbbb-0000-0000-0000-000000000016/cccccccc-0000-0000-0000-000000000016/aaaa0000-0000-0000-0000-000000000003.pdf',
        '11111111-1111-1111-1111-111111111116');

select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222226","role":"authenticated"}', true);
do $$
begin
  perform public.ingest_lab_extraction('aaaa0000-0000-0000-0000-000000000003',
    jsonb_build_array(jsonb_build_object('name','x','valueNumeric',1)));
  insert into _v values('unassigned practitioner cannot ingest', false, 'no error');
exception when others then
  insert into _v values('unassigned practitioner cannot ingest', sqlstate='42501', sqlstate);
end $$;

select set_config('request.jwt.claims','{}', true);
do $$
begin
  perform public.ingest_lab_extraction('aaaa0000-0000-0000-0000-000000000003',
    jsonb_build_array(jsonb_build_object('name','x','valueNumeric',1)));
  insert into _v values('unauthenticated cannot ingest', false, 'no error');
exception when others then
  insert into _v values('unauthenticated cannot ingest', sqlstate='28000', sqlstate);
end $$;

-- D) grants ---------------------------------------------------------------------
insert into _v values('anon may NOT execute ingest',
  not has_function_privilege('anon','public.ingest_lab_extraction(uuid,jsonb,text,text,date)','execute'), 'no-grant');
insert into _v values('anon may NOT execute fail',
  not has_function_privilege('anon','public.mark_lab_document_failed(uuid,text)','execute'), 'no-grant');
insert into _v values('authenticated may execute ingest',
  has_function_privilege('authenticated','public.ingest_lab_extraction(uuid,jsonb,text,text,date)','execute'), 'grant');

select name, passed, detail from _v order by name;
rollback;
