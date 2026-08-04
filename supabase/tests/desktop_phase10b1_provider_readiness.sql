-- Phase 10B.1 acceptance: governed copilot provider readiness.
-- Rolled back at the end, zero residue.
-- 22 assertions covering: registry, state machine, extended dispositions,
-- grant-level defense-in-depth, and secret-shape rejection.

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
  ('20b10000-0000-4000-8000-000000000001','p10b1-a@x'),
  ('20b10000-0000-4000-8000-000000000002','p10b1-b@x'),
  ('20b10000-0000-4000-8000-000000000099','p10b1-admin@x');
insert into public.organizations(id,name,slug) values
  ('20b10000-0000-4000-8000-000000000101','A','p10b1-a'),
  ('20b10000-0000-4000-8000-000000000102','B','p10b1-b');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('20b10000-0000-4000-8000-000000000101','20b10000-0000-4000-8000-000000000001','owner','active'),
  ('20b10000-0000-4000-8000-000000000101','20b10000-0000-4000-8000-000000000099','admin','active'),
  ('20b10000-0000-4000-8000-000000000102','20b10000-0000-4000-8000-000000000002','owner','active');
insert into public.platform_admins(user_id, approval_reference)
  values ('20b10000-0000-4000-8000-000000000099','TEST-ADMIN-REF');

-- Registry + State machine
select set_config('request.jwt.claims', null, true);
select _c('P10B1.SQL.1 anon register refused', _raises($q$
  select public.register_copilot_provider(
    'openai','openai_hipaa','["gpt-4o"]'::jsonb,'ref','zero','platform_governed')
$q$, '28000'));

select set_config('request.jwt.claims',
  '{"sub":"20b10000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select _c('P10B1.SQL.2 non-admin register refused', _raises($q$
  select public.register_copilot_provider(
    'openai','openai_hipaa','["gpt-4o"]'::jsonb,'ref','zero','platform_governed')
$q$, '42501'));

select set_config('request.jwt.claims',
  '{"sub":"20b10000-0000-4000-8000-000000000099","role":"authenticated"}', true);
select _c('P10B1.SQL.3 secret-shaped provider_secret_ref refused', _raises($q$
  select public.register_copilot_provider(
    'openai','openai_hipaa','["gpt-4o"]'::jsonb,'REF','zero','platform_governed',null,'sk-abc12345')
$q$, '22023'));
select _c('P10B1.SQL.4 bearer-shaped provider_secret_ref refused', _raises($q$
  select public.register_copilot_provider(
    'openai','openai_hipaa','["gpt-4o"]'::jsonb,'REF','zero','platform_governed',null,'Bearer abc')
$q$, '22023'));

do $$ declare _id uuid; begin
  _id := (public.register_copilot_provider(
    'openai','openai_hipaa','["gpt-4o"]'::jsonb,'REF-1','zero','platform_governed',
    null,'kms://key/foo','BAA-1',null,null) ->> 'id')::uuid;
  perform set_config('_test.provider_id', _id::text, true);
  perform _c('P10B1.SQL.5 admin registers provider', _id is not null);
end $$;

select set_config('request.jwt.claims',
  '{"sub":"20b10000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select _c('P10B1.SQL.6 owner illegal-skip transition refused', _raises(
  format($q$ select public.set_copilot_activation_state(
    '20b10000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    'approved_for_synthetic', 'skip attempt') $q$,
    current_setting('_test.provider_id')), '22023'));

do $$ declare _rid uuid; begin
  _rid := (public.set_copilot_activation_state(
    '20b10000-0000-4000-8000-000000000101'::uuid,
    current_setting('_test.provider_id')::uuid,
    'readiness_review', 'starting review') ->> 'id')::uuid;
  perform _c('P10B1.SQL.7 disabled->readiness_review',
    _rid is not null and (select state='readiness_review' from public.clinical_copilot_org_activations where id=_rid));
end $$;

do $$ declare _rid uuid; begin
  _rid := (public.set_copilot_activation_state(
    '20b10000-0000-4000-8000-000000000101'::uuid,
    current_setting('_test.provider_id')::uuid,
    'approved_for_synthetic', 'approved for synthetic testing') ->> 'id')::uuid;
  perform _c('P10B1.SQL.8 readiness->approved_for_synthetic', _rid is not null);
end $$;

select _c('P10B1.SQL.9 approved_for_phi refused without all four refs', _raises(
  format($q$ select public.set_copilot_activation_state(
    '20b10000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    'approved_for_phi', 'activate', 'legal','privacy','clinical', null) $q$,
    current_setting('_test.provider_id')), '22023'));

do $$ declare _rid uuid; begin
  _rid := (public.set_copilot_activation_state(
    '20b10000-0000-4000-8000-000000000101'::uuid,
    current_setting('_test.provider_id')::uuid,
    'approved_for_phi', 'activating for PHI',
    'legal-ref-1','privacy-ref-1','clinical-ref-1','infra-ref-1','modified') ->> 'id')::uuid;
  perform _c('P10B1.SQL.10 approved_for_phi with all four refs + BAA succeeds',
    _rid is not null and (select state='approved_for_phi' from public.clinical_copilot_org_activations where id=_rid));
end $$;

-- Revoke provider — cascades
select set_config('request.jwt.claims',
  '{"sub":"20b10000-0000-4000-8000-000000000099","role":"authenticated"}', true);
do $$ declare _res jsonb; _state text; begin
  _res := public.revoke_copilot_provider(current_setting('_test.provider_id')::uuid, 'incident-42');
  select state into _state from public.clinical_copilot_org_activations
    where provider_registry_id = current_setting('_test.provider_id')::uuid;
  perform _c('P10B1.SQL.11 revoke cascades activation to revoked',
    _res->>'revocation_state'='revoked' and _state='revoked');
end $$;

select set_config('request.jwt.claims',
  '{"sub":"20b10000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select _c('P10B1.SQL.12 revoked provider refuses new transitions', _raises(
  format($q$ select public.set_copilot_activation_state(
    '20b10000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    'readiness_review', 'retry') $q$, current_setting('_test.provider_id')), '55000'));

-- Cross-tenant refused
select set_config('request.jwt.claims',
  '{"sub":"20b10000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select _c('P10B1.SQL.13 cross-tenant activation read refused', _raises(
  format($q$ select public.get_copilot_activation(
    '20b10000-0000-4000-8000-000000000101'::uuid, %L::uuid) $q$,
    current_setting('_test.provider_id')), '42501'));

-- Extended dispositions: seed a completed run first (borrow Phase 10A create path)
select set_config('request.jwt.claims',
  '{"sub":"20b10000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into public.patient_profiles(id,organization_id,mrn,first_name,last_name) values
  ('20b10000-0000-4000-8000-000000000201','20b10000-0000-4000-8000-000000000101','P10B1-1','P','1');
insert into public.clinical_pathways(id,organization_id,code,name,domain_code,description,created_by) values
  ('20b10000-0000-4000-8000-000000000401','20b10000-0000-4000-8000-000000000101','p10b1','P','g','f',
   '20b10000-0000-4000-8000-000000000001');
insert into public.clinical_pathway_versions(
  id,organization_id,pathway_id,version,status,content,source_refs,content_sha256,
  created_by,approved_at,approved_by) values
  ('20b10000-0000-4000-8000-000000000301','20b10000-0000-4000-8000-000000000101',
   '20b10000-0000-4000-8000-000000000401',1,'approved','{}'::jsonb,'[]'::jsonb,repeat('a',64),
   '20b10000-0000-4000-8000-000000000001',now(),'20b10000-0000-4000-8000-000000000001');

do $$ declare _rid uuid; begin
  _rid := (public.create_copilot_run(
    '20b10000-0000-4000-8000-000000000101'::uuid,
    '20b10000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'western', 'practitioner_brief',
    '20b10000-0000-4000-8000-000000000301'::uuid,
    'v1','v1','v1','fixture', null, null,
    repeat('a',64)) ->> 'id')::uuid;
  perform public.finalize_copilot_run(
    '20b10000-0000-4000-8000-000000000101'::uuid,
    _rid, repeat('a',64), repeat('b',64), 'completed');
  perform set_config('_test.run_id', _rid::text, true);
end $$;

-- flagged_unsafe without note refused
select _c('P10B1.SQL.14 flagged_unsafe without note refused', _raises(
  format($q$ select public.record_copilot_disposition_extended(
    '20b10000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    'flagged_unsafe', null) $q$, current_setting('_test.run_id')), '22023'));

do $$ declare _res jsonb; _disp text; begin
  _res := public.record_copilot_disposition_extended(
    '20b10000-0000-4000-8000-000000000101'::uuid,
    current_setting('_test.run_id')::uuid,
    'flagged_unsafe', 'appears clinically incorrect');
  select practitioner_disposition into _disp from public.clinical_copilot_runs
    where id = current_setting('_test.run_id')::uuid;
  perform _c('P10B1.SQL.15 flagged_unsafe with note succeeds',
    _res->>'disposition'='flagged_unsafe' and _disp='flagged_unsafe');
end $$;

select _c('P10B1.SQL.16 regeneration_requested without note refused', _raises(
  format($q$ select public.record_copilot_disposition_extended(
    '20b10000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    'regeneration_requested', null) $q$, current_setting('_test.run_id')), '22023'));

select _c('P10B1.SQL.17 unknown disposition refused', _raises(
  format($q$ select public.record_copilot_disposition_extended(
    '20b10000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    'auto_sign', null) $q$, current_setting('_test.run_id')), '22023'));

-- Grant-level defense-in-depth
select _c('P10B1.SQL.18 no anon/PUBLIC EXECUTE on new B1 RPCs', (
  select count(*) = 0
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  join information_schema.routine_privileges g on g.routine_schema=n.nspname and g.routine_name=p.proname
  where n.nspname='public'
    and p.proname in (
      'register_copilot_provider','revoke_copilot_provider',
      'set_copilot_activation_state','get_copilot_activation',
      'is_platform_admin','record_copilot_disposition_extended')
    and g.grantee in ('PUBLIC','anon') and g.privilege_type='EXECUTE'));

-- PHI-clean audit metadata for activation events
select _c('P10B1.SQL.19 activation audit metadata PHI-clean', (
  select count(*) = 0
  from public.audit_events
  where action = 'copilot.activation_state_changed'
    and metadata::text ilike '%patient%'));

-- Registry direct writes refused for anon + authenticated (grant-level).
-- Must switch role because the default session role bypasses table grants.
create or replace function _catch_as_authenticated(_sql text) returns text
language plpgsql security invoker as $fn$
declare _res text;
begin
  execute 'set local role authenticated';
  begin execute _sql; _res := 'OK';
  exception when others then _res := sqlstate; end;
  execute 'set local role postgres';
  return _res;
end;$fn$;
select _c('P10B1.SQL.20 registry direct insert refused for authenticated', (
  select _catch_as_authenticated($q$
    insert into public.clinical_copilot_provider_registry
      (provider_name,provider_kind,approval_reference,retention_mode,key_ownership)
      values ('rogue','openai_hipaa','X','zero','platform_governed')
  $q$) = '42501'));

-- No supplement_products / commercial side effects from any B1 RPC
select _c('P10B1.SQL.21 no supplement_products side effect', (
  select count(*) = 0 from public.supplement_products
   where updated_at > now() - interval '30 seconds' and status='active'));

-- Disposition-recorded audit contains no PHI-shaped identifiers
select _c('P10B1.SQL.22 disposition audit PHI-clean', (
  select count(*) = 0 from public.audit_events
   where action = 'copilot.disposition_recorded'
     and metadata::text ~ 'clinically incorrect|patient|MRN'));

select count(*) filter(where ok) as passed,
       count(*) filter(where ok is false) as failed,
       count(*) as total,
       coalesce(string_agg(n,' | ') filter(where ok is not true),'(none)') as problems
from _r;

rollback;
