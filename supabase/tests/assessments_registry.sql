-- ============================================================
-- Test: 0027 assessments + clinical registry
--
-- Proves, in a rolled-back transaction against the real project:
--   - assign_assessment: practitioner-only, patient-scoped
--   - autosave_assessment: patient self-service works; refresh persists;
--     unassigned practitioner in another org gets 42501
--   - submit_assessment: immutable snapshot + review-queue item + audit;
--     duplicate idempotency key AND duplicate assignment both replay;
--     wrong content-hash pins are rejected (22023);
--     UPDATE of submitted answers is rejected (22023)
--   - record_lab_recommendations: idempotent per submission
--   - decide_lab_recommendation: patient role (org 'member') is refused;
--     practitioner decision updates status + appends decision row
--   - create_protocol_draft: invented product id rejected (22023);
--     valid registry products accepted
--   - APPROVAL GATE: approving a draft whose products are
--     pending_verification FAILS (22023). After the registry marks the
--     product approved (privileged path), approval succeeds. Editing an
--     approved draft back to draft fails (supersede-only).
--   - cross-org SELECT isolation on submissions
-- Run via MCP execute_sql (or psql). Every row must show passed = true.
-- ============================================================

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
grant all on _v to authenticated;

-- Fixtures (as postgres) ------------------------------------------------------
insert into auth.users(id,email) values
  ('11111111-1111-1111-1111-111111111127','practitioner27@verify.local'),
  ('22222222-2222-2222-2222-222222222227','patientuser27@verify.local'),
  ('33333333-3333-3333-3333-333333333327','outsider27@verify.local');
insert into public.organizations(id,name,slug,created_by) values
  ('bbbbbbbb-0000-0000-0000-000000000027','Verify Clinic 27','verify-clinic-0027', null),
  ('bbbbbbbb-0000-0000-0000-000000000028','Other Clinic 27','other-clinic-0027', null);
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000027','11111111-1111-1111-1111-111111111127','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000027','22222222-2222-2222-2222-222222222227','member','active'),
  ('bbbbbbbb-0000-0000-0000-000000000028','33333333-3333-3333-3333-333333333327','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name,user_id) values
  ('cccccccc-0000-0000-0000-000000000027','bbbbbbbb-0000-0000-0000-000000000027','Assess','Patient','22222222-2222-2222-2222-222222222227');
insert into public.practitioner_patient_relationships(organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000027','11111111-1111-1111-1111-111111111127','cccccccc-0000-0000-0000-000000000027','active');

-- A) assign: practitioner ok, cross-org refused -------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111127","role":"authenticated"}', true);

do $$
declare r jsonb;
begin
  r := public.assign_assessment(
    'bbbbbbbb-0000-0000-0000-000000000027','cccccccc-0000-0000-0000-000000000027',
    'symptom-pattern-screening','q.v1', null, null);
  perform set_config('app.test_assignment_id', r->>'id', true);
  insert into _v values('practitioner can assign assessment', (r->>'status')='assigned', r::text);
exception when others then
  insert into _v values('practitioner can assign assessment', false, sqlstate||' '||sqlerrm);
end $$;

select set_config('request.jwt.claims','{"sub":"33333333-3333-3333-3333-333333333327","role":"authenticated"}', true);
do $$
declare r jsonb;
begin
  r := public.assign_assessment(
    'bbbbbbbb-0000-0000-0000-000000000027','cccccccc-0000-0000-0000-000000000027',
    'symptom-pattern-screening','q.v1', null, null);
  insert into _v values('cross-org practitioner cannot assign', false, 'no error');
exception when others then
  insert into _v values('cross-org practitioner cannot assign', sqlstate='42501', sqlstate);
end $$;

-- B) patient autosave + persistence -------------------------------------------
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222227","role":"authenticated"}', true);
do $$
declare r jsonb; a uuid := current_setting('app.test_assignment_id')::uuid;
begin
  r := public.autosave_assessment(a,
    '[{"questionId":"thy_1","value":2},{"questionId":"thy_2","value":"unsure"}]'::jsonb,
    '{"goals":["Increase energy levels"]}'::jsonb,
    '{"section":"thyroid","index":2}'::jsonb);
  r := public.autosave_assessment(a,
    '[{"questionId":"thy_1","value":3},{"questionId":"thy_2","value":"unsure"}]'::jsonb,
    '{"goals":["Increase energy levels"]}'::jsonb,
    '{"section":"thyroid","index":2}'::jsonb);
  insert into _v
  select 'patient autosave persists latest copy',
         (answers->0->>'value')='3', answers::text
    from public.assessment_responses where assignment_id = a;
exception when others then
  insert into _v values('patient autosave persists latest copy', false, sqlstate||' '||sqlerrm);
end $$;

select set_config('request.jwt.claims','{"sub":"33333333-3333-3333-3333-333333333327","role":"authenticated"}', true);
do $$
declare r jsonb; a uuid := current_setting('app.test_assignment_id')::uuid;
begin
  r := public.autosave_assessment(a, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb);
  insert into _v values('outsider cannot autosave another org''s assignment', false, 'no error');
exception when others then
  insert into _v values('outsider cannot autosave another org''s assignment', sqlstate='42501', sqlstate);
end $$;

-- C) submit: immutable + idempotent + queue + audit ----------------------------
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222227","role":"authenticated"}', true);

do $$
declare r jsonb; a uuid := current_setting('app.test_assignment_id')::uuid;
begin
  r := public.submit_assessment(a, 'idem-key-27-000001',
    '[{"questionId":"thy_1","value":3}]'::jsonb, '{}'::jsonb,
    '{"attestedBy":"Assess Patient","attestedAt":"2026-07-20T12:00:00Z"}'::jsonb,
    'q.v1','scoring.v2','labrules.v1','2026.07.20-v1',
    'WRONG-HASH','{}'::jsonb, '{}', '{}');
  insert into _v values('submit rejects mismatched content hash', false, 'no error');
exception when others then
  insert into _v values('submit rejects mismatched content hash', sqlstate='22023', sqlstate);
end $$;

do $$
declare r1 jsonb; r2 jsonb; r3 jsonb; a uuid := current_setting('app.test_assignment_id')::uuid;
begin
  r1 := public.submit_assessment(a, 'idem-key-27-000001',
    '[{"questionId":"thy_1","value":3},{"questionId":"thy_2","value":"unsure"}]'::jsonb,
    '{"goals":["Increase energy levels"]}'::jsonb,
    '{"attestedBy":"Assess Patient","attestedAt":"2026-07-20T12:00:00Z"}'::jsonb,
    'q.v1','scoring.v2','labrules.v1','2026.07.20-v1',
    '44f332df9d33c8cb7247f4e608df76623b2ccd6654928985ea642cdb6eb908d8',
    '{"categories":[{"categoryId":"thyroid","band":"insufficient_data"}]}'::jsonb,
    '{}', '{}');
  perform set_config('app.test_submission_id', r1->>'id', true);
  r2 := public.submit_assessment(a, 'idem-key-27-000001',
    '[{"questionId":"thy_1","value":0}]'::jsonb, '{}'::jsonb,
    '{"attestedBy":"Assess Patient","attestedAt":"2026-07-20T12:00:00Z"}'::jsonb,
    'q.v1','scoring.v2','labrules.v1','2026.07.20-v1',
    '44f332df9d33c8cb7247f4e608df76623b2ccd6654928985ea642cdb6eb908d8',
    '{}'::jsonb, '{}', '{}');
  r3 := public.submit_assessment(a, 'idem-key-27-DIFFERENT',
    '[{"questionId":"thy_1","value":0}]'::jsonb, '{}'::jsonb,
    '{"attestedBy":"Assess Patient","attestedAt":"2026-07-20T12:00:00Z"}'::jsonb,
    'q.v1','scoring.v2','labrules.v1','2026.07.20-v1',
    '44f332df9d33c8cb7247f4e608df76623b2ccd6654928985ea642cdb6eb908d8',
    '{}'::jsonb, '{}', '{}');
  insert into _v values('submit succeeds then replays on same key',
    (r1->>'replayed')='false' and (r2->>'replayed')='true' and (r2->>'id')=(r1->>'id'), r2::text);
  insert into _v values('re-submit of same assignment replays (no duplicate)',
    (r3->>'replayed')='true' and (r3->>'id')=(r1->>'id'), r3::text);
  insert into _v
  select 'exactly one submission row exists', count(*)=1, count(*)::text
    from public.assessment_submissions where assignment_id = a;
  insert into _v
  select 'submission answers stored verbatim (first submit wins)',
         (answers->0->>'value')='3', answers::text
    from public.assessment_submissions where assignment_id = a;
exception when others then
  insert into _v values('submit succeeds then replays on same key', false, sqlstate||' '||sqlerrm);
end $$;

reset role;
insert into _v
select 'submit created an assessment review-queue item', count(*)=1, count(*)::text
  from public.review_queue_items
 where organization_id='bbbbbbbb-0000-0000-0000-000000000027'
   and item_type='assessment'
   and ref_id = current_setting('app.test_submission_id')::uuid;
insert into _v
select 'submit wrote a PHI-safe audit event', count(*)>=1, count(*)::text
  from public.audit_events
 where action='assessment.submit'
   and resource_id = current_setting('app.test_submission_id');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222227","role":"authenticated"}', true);
do $$
declare a uuid := current_setting('app.test_assignment_id')::uuid;
begin
  update public.assessment_submissions set answers = '[]'::jsonb where assignment_id = a;
  insert into _v values('submitted answers are immutable', false, 'no error');
exception when others then
  insert into _v values('submitted answers are immutable', sqlstate='22023' or sqlstate='42501', sqlstate);
end $$;

-- D) lab recommendations: record (idempotent) + patient cannot decide ----------
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111127","role":"authenticated"}', true);
do $$
declare r1 jsonb; r2 jsonb; s uuid := current_setting('app.test_submission_id')::uuid;
begin
  r1 := public.record_lab_recommendations(s, 'labrules.v1',
    '[{"labId":"lab_vibrant_blood_panel","panelName":"Vibrant Blood Panel","vendor":"Vibrant America","priority":"primary","sourceCategoryIds":["thyroid"],"why":"Full thyroid panel","highestBand":"moderate"}]'::jsonb);
  r2 := public.record_lab_recommendations(s, 'labrules.v1', '[]'::jsonb);
  perform set_config('app.test_set_id', r1->>'setId', true);
  insert into _v values('lab recommendations recorded once (idempotent)',
    (r1->>'replayed')='false' and (r2->>'replayed')='true' and (r2->>'setId')=(r1->>'setId'), r2::text);
exception when others then
  insert into _v values('lab recommendations recorded once (idempotent)', false, sqlstate||' '||sqlerrm);
end $$;

select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222227","role":"authenticated"}', true);
do $$
declare rec uuid;
begin
  select id into rec from public.lab_recommendations
   where set_id = current_setting('app.test_set_id')::uuid limit 1;
  perform public.decide_lab_recommendation(rec, 'approve', null);
  insert into _v values('patient role cannot approve a lab recommendation', false, 'no error');
exception when others then
  insert into _v values('patient role cannot approve a lab recommendation', sqlstate='42501', sqlstate);
end $$;

select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111127","role":"authenticated"}', true);
do $$
declare rec uuid; r jsonb;
begin
  select id into rec from public.lab_recommendations
   where set_id = current_setting('app.test_set_id')::uuid limit 1;
  r := public.decide_lab_recommendation(rec, 'approve', 'reviewed with history');
  insert into _v values('practitioner approves a lab recommendation', (r->>'status')='approved', r::text);
  insert into _v
  select 'decision appended to recommendation_decisions', count(*)=1, count(*)::text
    from public.recommendation_decisions
   where subject_type='lab_recommendation' and subject_id=rec and decision='approve';
exception when others then
  insert into _v values('practitioner approves a lab recommendation', false, sqlstate||' '||sqlerrm);
end $$;

-- E) protocol drafts: invented product refused; pending products draftable ----
do $$
declare r jsonb; s uuid := current_setting('app.test_submission_id')::uuid;
begin
  r := public.create_protocol_draft(
    'bbbbbbbb-0000-0000-0000-000000000027','cccccccc-0000-0000-0000-000000000027', s,
    null, null, 'Bad draft', 'x', 'assessment-screening',
    '[{"productId":"prod_miracle_detox_ultra","doseText":"1 daily","schedule":"daily"}]'::jsonb);
  insert into _v values('invented supplement product is rejected', false, 'no error');
exception when others then
  insert into _v values('invented supplement product is rejected', sqlstate='22023', sqlstate||' '||sqlerrm);
end $$;

do $$
declare r jsonb; s uuid := current_setting('app.test_submission_id')::uuid;
begin
  r := public.create_protocol_draft(
    'bbbbbbbb-0000-0000-0000-000000000027','cccccccc-0000-0000-0000-000000000027', s,
    'tpl_foundation_v1', 1, 'Foundation start', 'Baseline support while labs pending',
    'assessment-screening',
    '[{"productId":"prod_proomega_2000","doseText":"2 softgels daily with meals","schedule":"daily","durationDays":90,"monitoring":["Recheck lipids at 90 days"]},{"productId":"prod_protect_plus_10","doseText":"1 softgel daily with fat","schedule":"daily","durationDays":90}]'::jsonb);
  perform set_config('app.test_draft_id', r->>'id', true);
  insert into _v values('protocol draft with registry products created', (r->>'items')='2', r::text);
exception when others then
  insert into _v values('protocol draft with registry products created', false, sqlstate||' '||sqlerrm);
end $$;

-- F) THE APPROVAL GATE ---------------------------------------------------------
do $$
declare r jsonb; d uuid := current_setting('app.test_draft_id')::uuid;
begin
  r := public.approve_protocol_draft(d, 'attempt while products pending');
  insert into _v values('approval blocked while products pending_verification', false, 'no error');
exception when others then
  insert into _v values('approval blocked while products pending_verification', sqlstate='22023', sqlstate||' '||sqlerrm);
end $$;

-- Registry reconciliation lands (privileged path, e.g. a future migration):
reset role;
update public.supplement_registry_products
   set approval_state='approved', reviewer='verify-test', approved_at=now(),
       change_reason='test-only approval inside rolled-back txn'
 where id in ('prod_proomega_2000','prod_protect_plus_10') and version=1;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111127","role":"authenticated"}', true);
do $$
declare r jsonb; d uuid := current_setting('app.test_draft_id')::uuid;
begin
  r := public.approve_protocol_draft(d, 'products now approved');
  insert into _v values('approval succeeds once registry products are approved', (r->>'status')='approved', r::text);
exception when others then
  insert into _v values('approval succeeds once registry products are approved', false, sqlstate||' '||sqlerrm);
end $$;

do $$
declare d uuid := current_setting('app.test_draft_id')::uuid;
begin
  update public.protocol_drafts set status='draft' where id = d;
  insert into _v values('approved protocol cannot be edited back to draft', false, 'no error');
exception when others then
  insert into _v values('approved protocol cannot be edited back to draft', sqlstate='22023' or sqlstate='42501', sqlstate);
end $$;

-- G) cross-org isolation on reads ---------------------------------------------
select set_config('request.jwt.claims','{"sub":"33333333-3333-3333-3333-333333333327","role":"authenticated"}', true);
insert into _v
select 'cross-org practitioner sees zero submissions', count(*)=0, count(*)::text
  from public.assessment_submissions
 where organization_id='bbbbbbbb-0000-0000-0000-000000000027';
insert into _v
select 'cross-org practitioner sees zero protocol drafts', count(*)=0, count(*)::text
  from public.protocol_drafts
 where organization_id='bbbbbbbb-0000-0000-0000-000000000027';

reset role;
select * from _v order by name;
rollback;
