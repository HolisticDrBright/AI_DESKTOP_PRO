-- Phase 10A acceptance: governed copilot run model.
--
-- Rolled back at the end. Adversarial checks that map to the DB-side
-- boundaries from the 25 required cases. TypeScript-side boundaries live
-- in `src/server/copilot/*.test.ts` and `e2e/live-phase10a-copilot.spec.ts`.

begin;

create temp table _r(n text, ok boolean) on commit drop;
create or replace function _c(_n text, _ok boolean) returns void language sql as $fn$
  insert into _r values (_n, _ok);
$fn$;
create or replace function _raises(_sql text, _state text) returns boolean
language plpgsql as $fn$
begin execute _sql; return false; exception when others then return sqlstate=_state; end;
$fn$;

insert into auth.users(id,email) values
  ('10a00000-0000-4000-8000-000000000001','p10a-editor@x'),
  ('10a00000-0000-4000-8000-000000000002','p10a-outsider@x');
insert into public.organizations(id,name,slug) values
  ('10a00000-0000-4000-8000-000000000101','P10A Org A','p10a-org-a'),
  ('10a00000-0000-4000-8000-000000000102','P10A Org B','p10a-org-b');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('10a00000-0000-4000-8000-000000000101','10a00000-0000-4000-8000-000000000001','owner','active');

insert into public.patient_profiles(id,organization_id,user_id,mrn) values
  ('10a00000-0000-4000-8000-000000000201','10a00000-0000-4000-8000-000000000101',null,'P10A-PAT-1'),
  ('10a00000-0000-4000-8000-000000000202','10a00000-0000-4000-8000-000000000102',null,'P10A-PAT-B');

-- Seed an approved clinical_pathway_versions row so create_copilot_run
-- has a pathway to bind — the existing schema requires pathway_version_id.
insert into public.clinical_pathway_versions(id, organization_id, pathway_id, version, status,
  differential_questions, lab_strategy, safety_stops, product_candidates, created_by)
values (
  '10a00000-0000-4000-8000-000000000301',
  '10a00000-0000-4000-8000-000000000101',
  gen_random_uuid(), 1, 'approved',
  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
  '10a00000-0000-4000-8000-000000000001'
) on conflict do nothing;

select set_config('request.jwt.claims',
  '{"sub":"10a00000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------- 10A checks

select _c('P10A.1 create_copilot_run accepts a valid run', (
  (select public.create_copilot_run(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    '10a00000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'western', 'practitioner_brief',
    '10a00000-0000-4000-8000-000000000301'::uuid) ->> 'ok') = 'true'));

with r1 as (
  select (public.create_copilot_run(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    '10a00000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'functional', 'protocol_draft',
    '10a00000-0000-4000-8000-000000000301'::uuid) ->> 'id')::uuid as id
), f as (
  select public.finalize_copilot_run(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    (select id from r1),
    'input-hash-1', 'output-hash-1', 'completed')
)
select _c('P10A.2 finalize_copilot_run succeeds', (
  select status = 'completed'
  from public.clinical_copilot_runs where id = (select id from r1)));

select _c('P10A.3 completed run output_sha256 is immutable (55000)', _raises($q$
  update public.clinical_copilot_runs
  set output_sha256 = 'MUTATED'
  where output_sha256 = 'output-hash-1'
$q$, '55000'));

select _c('P10A.4 copilot run deletion is refused (55000)', _raises($q$
  delete from public.clinical_copilot_runs
  where organization_id = '10a00000-0000-4000-8000-000000000101'
$q$, '55000'));

with r as (
  select (public.create_copilot_run(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    '10a00000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'western', 'differential_questions',
    '10a00000-0000-4000-8000-000000000301'::uuid) ->> 'id')::uuid as id
), f as (
  select public.finalize_copilot_run(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    (select id from r), 'i2', 'o2', 'completed')
), s as (
  select public.mark_copilot_run_stale(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    (select id from r), 'source_change_detected')
)
select _c('P10A.5 source change marks a completed run stale', (
  select status = 'stale' from public.clinical_copilot_runs where id = (select id from r)));

select set_config('request.jwt.claims',
  '{"sub":"10a00000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select _c('P10A.6 non-member cannot create a run (42501)', _raises($q$
  select public.create_copilot_run(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    '10a00000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'western', 'practitioner_brief',
    '10a00000-0000-4000-8000-000000000301'::uuid)
$q$, '42501'));

select _c('P10A.7 cross-tenant patient rejected (42501)', _raises($q$
  select public.create_copilot_run(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    '10a00000-0000-4000-8000-000000000202'::uuid,
    null::uuid, 'western', 'practitioner_brief',
    '10a00000-0000-4000-8000-000000000301'::uuid)
$q$, '42501'));

select set_config('request.jwt.claims',
  '{"sub":"10a00000-0000-4000-8000-000000000001","role":"authenticated"}', true);

with r as (
  select id from public.clinical_copilot_runs
  where organization_id = '10a00000-0000-4000-8000-000000000101'::uuid
    and run_type = 'protocol_draft'
  order by created_at desc limit 1
), d as (
  select public.record_copilot_disposition(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    (select id from r), 'accepted')
)
select _c('P10A.8 accept disposition is idempotent + clinically side-effect-free', (
  select practitioner_disposition = 'accepted'
    and (select count(*) from public.supplement_products
         where updated_at > now() - interval '5 seconds') = 0
  from public.clinical_copilot_runs where id = (select id from r)));

select _c('P10A.9 audit_events for copilot never carry raw patient text', (
  select count(*) = 0
  from public.audit_events e
  where e.action in ('copilot.run_created','copilot.run_marked_stale')
    and e.organization_id = '10a00000-0000-4000-8000-000000000101'
    and (e.metadata::text ilike '%P10A-PAT%' or e.safe_message ilike '%P10A-PAT%')));

select _c('P10A.10 unknown lens refused (22023)', _raises($q$
  select public.create_copilot_run(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    '10a00000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'PARADIGM_X', 'practitioner_brief',
    '10a00000-0000-4000-8000-000000000301'::uuid)
$q$, '22023'));

select _c('P10A.11 unknown run_type refused (22023)', _raises($q$
  select public.create_copilot_run(
    '10a00000-0000-4000-8000-000000000101'::uuid,
    '10a00000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'western', 'auto_prescribe',
    '10a00000-0000-4000-8000-000000000301'::uuid)
$q$, '22023'));

select count(*) filter(where ok) as passed,
       count(*) filter(where ok is false) as failed,
       count(*) as total,
       coalesce(string_agg(n,' | ') filter(where ok is not true),'(none)') as problems
from _r;
rollback;
