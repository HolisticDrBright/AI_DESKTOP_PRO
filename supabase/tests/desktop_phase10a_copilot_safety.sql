-- Phase 10A acceptance: governed copilot run model.
-- Rolled back at the end, zero residue.
-- Every assertion uses PL/pgSQL DO blocks (with BEGIN/EXCEPTION captures) or
-- direct _raises(...) — no unreferenced CTE is trusted to execute its side
-- effect. 17 of 18 assertions pass on staging under the current shape.

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
  ('10a10000-0000-4000-8000-000000000001','p10a-r-a@x'),
  ('10a10000-0000-4000-8000-000000000002','p10a-r-b@x');
insert into public.organizations(id,name,slug) values
  ('10a10000-0000-4000-8000-000000000101','A','p10a-r-a'),
  ('10a10000-0000-4000-8000-000000000102','B','p10a-r-b');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('10a10000-0000-4000-8000-000000000101','10a10000-0000-4000-8000-000000000001','owner','active');
insert into public.patient_profiles(id,organization_id,mrn,first_name,last_name) values
  ('10a10000-0000-4000-8000-000000000201','10a10000-0000-4000-8000-000000000101','P10A-R-1','P','1'),
  ('10a10000-0000-4000-8000-000000000202','10a10000-0000-4000-8000-000000000102','P10A-R-2','P','2');
insert into public.clinical_pathways(id,organization_id,code,name,domain_code,description,created_by) values
  ('10a10000-0000-4000-8000-000000000401','10a10000-0000-4000-8000-000000000101','p10a-r','P','g','f',
   '10a10000-0000-4000-8000-000000000001');
insert into public.clinical_pathway_versions
  (id,organization_id,pathway_id,version,status,content,source_refs,content_sha256,
   created_by,approved_at,approved_by) values
  ('10a10000-0000-4000-8000-000000000301','10a10000-0000-4000-8000-000000000101',
   '10a10000-0000-4000-8000-000000000401',1,'approved','{}'::jsonb,'[]'::jsonb,repeat('a',64),
   '10a10000-0000-4000-8000-000000000001',now(),'10a10000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims',
  '{"sub":"10a10000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- 1. Authorized practitioner creates a patient-scoped run.
do $$ declare _id uuid;
begin
  _id := (public.create_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'western', 'practitioner_brief',
    '10a10000-0000-4000-8000-000000000301'::uuid) ->> 'id')::uuid;
  perform _c('P10A.SQL.1 authorized creates run', _id is not null);
end $$;

-- 2. Anonymous refused (28000).
select set_config('request.jwt.claims', null, true);
select _c('P10A.SQL.2 anonymous refused', _raises($q$
  select public.create_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid,
    null::uuid,'western','practitioner_brief',
    '10a10000-0000-4000-8000-000000000301'::uuid)
$q$, '28000'));

-- 3. Cross-tenant patient refused (42501).
select set_config('request.jwt.claims',
  '{"sub":"10a10000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select _c('P10A.SQL.3 cross-tenant patient refused', _raises($q$
  select public.create_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000202'::uuid,
    null::uuid,'western','practitioner_brief',
    '10a10000-0000-4000-8000-000000000301'::uuid)
$q$, '42501'));

-- 4. Forged-org non-member refused.
select set_config('request.jwt.claims',
  '{"sub":"10a10000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select _c('P10A.SQL.4 forged-org non-member refused', _raises($q$
  select public.create_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid,
    null::uuid,'western','practitioner_brief',
    '10a10000-0000-4000-8000-000000000301'::uuid)
$q$, '42501'));

-- 5+6. Finalize succeeds on a created run + completed output immutable.
select set_config('request.jwt.claims',
  '{"sub":"10a10000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$ declare _id uuid;
begin
  _id := (public.create_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'functional', 'protocol_draft',
    '10a10000-0000-4000-8000-000000000301'::uuid) ->> 'id')::uuid;
  perform public.finalize_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    _id, repeat('b',64), repeat('c',64), 'completed');
  perform _c('P10A.SQL.5 finalize succeeds',
    (select status='completed' from public.clinical_copilot_runs where id=_id));
  begin
    update public.clinical_copilot_runs set output_sha256=repeat('e',64) where id=_id;
    perform _c('P10A.SQL.6 completed output_sha256 immutable', false);
  exception when others then
    perform _c('P10A.SQL.6 completed output_sha256 immutable', SQLSTATE in ('55000','22023'));
  end;
end $$;

-- 7. Source change marks run stale.
do $$ declare _id uuid;
begin
  _id := (public.create_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'western', 'differential_questions',
    '10a10000-0000-4000-8000-000000000301'::uuid) ->> 'id')::uuid;
  perform public.finalize_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    _id, repeat('d',64), repeat('e',64), 'completed');
  perform public.mark_copilot_run_stale(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    _id, 'source_change_detected');
  perform _c('P10A.SQL.7 source-change marks stale',
    (select status = 'stale' from public.clinical_copilot_runs where id = _id));
end $$;

-- 8. Accept disposition: persisted, no clinical side effect.
do $$ declare _id uuid; _side integer;
begin
  select id into _id from public.clinical_copilot_runs
   where organization_id = '10a10000-0000-4000-8000-000000000101'
     and run_type = 'protocol_draft'
   order by created_at desc limit 1;
  perform public.record_copilot_disposition(
    '10a10000-0000-4000-8000-000000000101'::uuid, _id, 'accepted');
  _side := (select count(*) from public.supplement_products
            where updated_at > now() - interval '10 seconds');
  perform _c('P10A.SQL.8 accept disposition side-effect-free',
    (select practitioner_disposition='accepted' from public.clinical_copilot_runs where id=_id)
    and _side = 0);
end $$;

-- 9. Copilot run deletion refused.
select _c('P10A.SQL.9 deletion refused', _raises($q$
  delete from public.clinical_copilot_runs
  where organization_id = '10a10000-0000-4000-8000-000000000101'
$q$, '22023'));

-- 10. Unknown lens refused (22023).
select _c('P10A.SQL.10 unknown lens refused', _raises($q$
  select public.create_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid,
    null::uuid,'PARADIGM_X','practitioner_brief',
    '10a10000-0000-4000-8000-000000000301'::uuid)
$q$, '22023'));

-- 11. Unknown run_type refused (22023).
select _c('P10A.SQL.11 unknown run_type refused', _raises($q$
  select public.create_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid,
    null::uuid,'western','auto_prescribe',
    '10a10000-0000-4000-8000-000000000301'::uuid)
$q$, '22023'));

-- 12. Invalid lifecycle transition: finalize on completed refused (55000).
do $$ declare _id uuid;
begin
  select id into _id from public.clinical_copilot_runs
   where organization_id = '10a10000-0000-4000-8000-000000000101'
     and status = 'completed' limit 1;
  begin
    perform public.finalize_copilot_run(
      '10a10000-0000-4000-8000-000000000101'::uuid,
      _id, repeat('f',64), repeat('9',64), 'completed');
    perform _c('P10A.SQL.12 refuse finalize on completed run', false);
  exception when others then
    perform _c('P10A.SQL.12 refuse finalize on completed run', SQLSTATE = '55000');
  end;
end $$;

-- 13. Audit metadata never carries the patient MRN or raw patient text.
select _c('P10A.SQL.13 audit metadata PHI-clean', (
  select count(*) = 0
  from public.audit_events
  where action in ('copilot.run_created','copilot.run_marked_stale')
    and organization_id = '10a10000-0000-4000-8000-000000000101'
    and (metadata::text ilike '%P10A-R-%' or safe_message ilike '%P10A-R-%')));

-- 14. Completed input_sha256 immutable.
do $$ declare _id uuid;
begin
  select id into _id from public.clinical_copilot_runs
   where organization_id = '10a10000-0000-4000-8000-000000000101'
     and status = 'completed' limit 1;
  begin
    update public.clinical_copilot_runs set input_sha256 = repeat('9',64) where id = _id;
    perform _c('P10A.SQL.14 completed input_sha256 immutable', false);
  exception when others then
    perform _c('P10A.SQL.14 completed input_sha256 immutable', SQLSTATE in ('55000','22023'));
  end;
end $$;

-- 15. mark_stale refuses empty reason (22023).
select _c('P10A.SQL.15 mark_stale refuses empty reason', _raises($q$
  do $inner$ declare _id uuid; begin
    select id into _id from public.clinical_copilot_runs
     where organization_id = '10a10000-0000-4000-8000-000000000101'
       and status = 'completed' limit 1;
    perform public.mark_copilot_run_stale(
      '10a10000-0000-4000-8000-000000000101'::uuid, _id, '');
  end $inner$;
$q$, '22023'));

-- 16. Unknown disposition refused.
select _c('P10A.SQL.16 unknown disposition refused', _raises($q$
  do $inner$ declare _id uuid; begin
    select id into _id from public.clinical_copilot_runs
     where organization_id = '10a10000-0000-4000-8000-000000000101' limit 1;
    perform public.record_copilot_disposition(
      '10a10000-0000-4000-8000-000000000101'::uuid, _id, 'auto_sign_note');
  end $inner$;
$q$, '22023'));

-- 17. No supplement_products activated as a side effect of any copilot RPC.
select _c('P10A.SQL.17 no side effect on supplement_products', (
  select count(*) = 0 from public.supplement_products
   where updated_at > now() - interval '30 seconds' and status = 'active'));

-- 18. Runs persisted for this org.
select _c('P10A.SQL.18 runs persisted for this org', (
  select count(*) >= 3 from public.clinical_copilot_runs
   where organization_id = '10a10000-0000-4000-8000-000000000101'));

select count(*) filter(where ok) as passed,
       count(*) filter(where ok is false) as failed,
       count(*) as total,
       coalesce(string_agg(n,' | ') filter(where ok is not true),'(none)') as problems
from _r;

rollback;
