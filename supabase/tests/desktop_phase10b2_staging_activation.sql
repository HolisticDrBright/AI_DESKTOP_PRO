-- Phase 10B.2 acceptance: controlled live-provider staging activation.
-- Rolled back at the end, zero residue.
--
-- 38 assertions covering: explicit synthetic attestation (and the refusal
-- to infer it), activation scope, the structural unavailability of
-- production and real-patient use, the kill switch, atomic budget
-- reservation and the call cap, honest legal posture, append-only history,
-- cross-tenant refusal, and the absence of any column that could hold a
-- prompt, a response, or a patient identifier.

begin;
create temp table _r(n text, ok boolean) on commit drop;
create or replace function _c(_n text, _ok boolean) returns void language sql as $fn$ insert into _r values(_n,_ok); $fn$;
create or replace function _raises(_sql text, _state text) returns boolean language plpgsql as $fn$
begin execute _sql; return false; exception when others then return sqlstate=_state; end; $fn$;

insert into auth.users(id,email) values
  ('30b20000-0000-4000-8000-000000000001','b2-owner@x'),
  ('30b20000-0000-4000-8000-000000000002','b2-other@x'),
  ('30b20000-0000-4000-8000-000000000003','b2-practitioner@x'),
  ('30b20000-0000-4000-8000-000000000099','b2-admin@x');
insert into public.organizations(id,name,slug) values
  ('30b20000-0000-4000-8000-000000000101','A','p10b2-a'),
  ('30b20000-0000-4000-8000-000000000102','B','p10b2-b');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('30b20000-0000-4000-8000-000000000101','30b20000-0000-4000-8000-000000000001','owner','active'),
  ('30b20000-0000-4000-8000-000000000101','30b20000-0000-4000-8000-000000000003','practitioner','active'),
  ('30b20000-0000-4000-8000-000000000101','30b20000-0000-4000-8000-000000000099','admin','active'),
  ('30b20000-0000-4000-8000-000000000102','30b20000-0000-4000-8000-000000000002','owner','active');
insert into public.platform_admins(user_id, approval_reference)
  values ('30b20000-0000-4000-8000-000000000099','B2-ADMIN-REF');
-- Note the names and MRNs deliberately: "Synthetic Subject" with MRN
-- "B2-SYN" is NOT eligible by virtue of looking synthetic, and
-- "Unattested Subject" with MRN "B2-REAL" is not ineligible by virtue of
-- looking real. Only the attestation row decides. B2.7 proves it.
insert into public.patient_profiles(id,organization_id,mrn,first_name,last_name) values
  ('30b20000-0000-4000-8000-000000000201','30b20000-0000-4000-8000-000000000101','B2-SYN','Synthetic','Subject'),
  ('30b20000-0000-4000-8000-000000000202','30b20000-0000-4000-8000-000000000101','B2-REAL','Unattested','Subject'),
  ('30b20000-0000-4000-8000-000000000203','30b20000-0000-4000-8000-000000000102','B2-XT','Cross','Tenant');

-- ============ synthetic eligibility ============
select set_config('request.jwt.claims', null, true);
select _c('B2.1 anon attest refused', _raises($q$ select public.attest_synthetic_subject(
  '30b20000-0000-4000-8000-000000000101'::uuid,'patient','30b20000-0000-4000-8000-000000000201'::uuid,'SYN-REF-1') $q$,'28000'));

select set_config('request.jwt.claims','{"sub":"30b20000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select _c('B2.2 practitioner attest refused (owner/admin only)', _raises($q$ select public.attest_synthetic_subject(
  '30b20000-0000-4000-8000-000000000101'::uuid,'patient','30b20000-0000-4000-8000-000000000201'::uuid,'SYN-REF-1') $q$,'42501'));

select set_config('request.jwt.claims','{"sub":"30b20000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select _c('B2.3 placeholder attestation reference refused', _raises($q$ select public.attest_synthetic_subject(
  '30b20000-0000-4000-8000-000000000101'::uuid,'patient','30b20000-0000-4000-8000-000000000201'::uuid,'TBD') $q$,'23514'));
select _c('B2.4 cross-tenant subject cannot be attested', _raises($q$ select public.attest_synthetic_subject(
  '30b20000-0000-4000-8000-000000000101'::uuid,'patient','30b20000-0000-4000-8000-000000000203'::uuid,'SYN-REF-XT') $q$,'42501'));
select _c('B2.5 owner attests a real subject in-org',
  (public.attest_synthetic_subject('30b20000-0000-4000-8000-000000000101'::uuid,'patient',
    '30b20000-0000-4000-8000-000000000201'::uuid,'SYN-REF-1')->>'eligibility') = 'synthetic_only');
select _c('B2.6 attested subject is eligible',
  public.is_synthetic_eligible('30b20000-0000-4000-8000-000000000101'::uuid,'patient','30b20000-0000-4000-8000-000000000201'::uuid));
select _c('B2.7 UNATTESTED subject is NOT eligible — no inference from name/MRN',
  public.is_synthetic_eligible('30b20000-0000-4000-8000-000000000101'::uuid,'patient','30b20000-0000-4000-8000-000000000202'::uuid) = false);
select _c('B2.8 double attestation refused (one live marker)', _raises($q$ select public.attest_synthetic_subject(
  '30b20000-0000-4000-8000-000000000101'::uuid,'patient','30b20000-0000-4000-8000-000000000201'::uuid,'SYN-REF-2') $q$,'23505'));

-- ============ provider + activation scope ============
select set_config('request.jwt.claims','{"sub":"30b20000-0000-4000-8000-000000000099","role":"authenticated"}',true);
do $$ declare _id uuid; begin
  _id := (public.register_copilot_provider('openai','openai_hipaa','["gpt-5.6-sol"]'::jsonb,
    'B2-APPROVAL','zero','platform_governed',null,'kms://key/b2','BAA-B2',null,null)->>'id')::uuid;
  perform set_config('_t.pid', _id::text, true);
end $$;

select set_config('request.jwt.claims','{"sub":"30b20000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select public.set_copilot_activation_state('30b20000-0000-4000-8000-000000000101'::uuid,
  current_setting('_t.pid')::uuid,'readiness_review','start');
select public.set_copilot_activation_state('30b20000-0000-4000-8000-000000000101'::uuid,
  current_setting('_t.pid')::uuid,'approved_for_synthetic','synthetic ok');

select _c('B2.9 production environment REFUSED', _raises(format($q$ select public.set_copilot_activation_scope(
  '30b20000-0000-4000-8000-000000000101'::uuid, %L::uuid,'production','synthetic_staging_verification','gpt-5.6-sol',null,'try') $q$,
  current_setting('_t.pid')),'22023'));
select _c('B2.10 patient_data approved_use REFUSED', _raises(format($q$ select public.set_copilot_activation_scope(
  '30b20000-0000-4000-8000-000000000101'::uuid, %L::uuid,'staging','patient_data','gpt-5.6-sol',null,'try') $q$,
  current_setting('_t.pid')),'22023'));
select _c('B2.11 model off the registry allowlist REFUSED', _raises(format($q$ select public.set_copilot_activation_scope(
  '30b20000-0000-4000-8000-000000000101'::uuid, %L::uuid,'staging','synthetic_staging_verification','gpt-4o',null,'try') $q$,
  current_setting('_t.pid')),'22023'));
select _c('B2.12 scope without a reason REFUSED', _raises(format($q$ select public.set_copilot_activation_scope(
  '30b20000-0000-4000-8000-000000000101'::uuid, %L::uuid,'staging','synthetic_staging_verification','gpt-5.6-sol',null,null) $q$,
  current_setting('_t.pid')),'22023'));
select _c('B2.13 valid staging scope accepted',
  (public.set_copilot_activation_scope('30b20000-0000-4000-8000-000000000101'::uuid,
    current_setting('_t.pid')::uuid,'staging','synthetic_staging_verification','gpt-5.6-sol',
    now()+interval '1 day','staging verification window')->>'approved_use') = 'synthetic_staging_verification');
select _c('B2.14 direct UPDATE to production refused by CHECK', _raises($q$
  update public.clinical_copilot_org_activations set environment='production' where 1=1 $q$,'23514'));
select _c('B2.15 direct UPDATE to patient_data refused by CHECK', _raises($q$
  update public.clinical_copilot_org_activations set approved_use='patient_data' where 1=1 $q$,'23514'));

-- ============ budget + gate ============
select public.set_copilot_call_budget('30b20000-0000-4000-8000-000000000101'::uuid,
  current_setting('_t.pid')::uuid,'phase10b2', 2, 1000, 100);

select _c('B2.16 gate ALLOWS with every condition met',
  (public.evaluate_copilot_staging_gate('30b20000-0000-4000-8000-000000000101'::uuid,
    current_setting('_t.pid')::uuid,'30b20000-0000-4000-8000-000000000201'::uuid,'gpt-5.6-sol','phase10b2')->>'allowed')::boolean);
select _c('B2.17 gate REFUSES an unattested subject',
  (public.evaluate_copilot_staging_gate('30b20000-0000-4000-8000-000000000101'::uuid,
    current_setting('_t.pid')::uuid,'30b20000-0000-4000-8000-000000000202'::uuid,'gpt-5.6-sol','phase10b2')->>'refusal') = 'subject_attested_synthetic');
select _c('B2.18 gate REFUSES a model outside scope',
  (public.evaluate_copilot_staging_gate('30b20000-0000-4000-8000-000000000101'::uuid,
    current_setting('_t.pid')::uuid,'30b20000-0000-4000-8000-000000000201'::uuid,'gpt-4o','phase10b2')->>'refusal') = 'model_matches_scope');

-- kill switch
select public.set_copilot_kill_switch('30b20000-0000-4000-8000-000000000101'::uuid,
  current_setting('_t.pid')::uuid, true, 'incident drill');
select _c('B2.19 kill switch flips the gate to refused',
  (public.evaluate_copilot_staging_gate('30b20000-0000-4000-8000-000000000101'::uuid,
    current_setting('_t.pid')::uuid,'30b20000-0000-4000-8000-000000000201'::uuid,'gpt-5.6-sol','phase10b2')->>'refusal') = 'kill_switch_clear');
select _c('B2.20 reservation refused while the kill switch is engaged', _raises(format($q$
  select public.reserve_copilot_external_call('30b20000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    'phase10b2', null, 'gpt-5.6-sol','v1','copilot_output_v1', 100, 100, 5) $q$,
  current_setting('_t.pid')),'55000'));
select public.set_copilot_kill_switch('30b20000-0000-4000-8000-000000000101'::uuid,
  current_setting('_t.pid')::uuid, false, 'drill complete');

-- reserve/settle + cap
do $$ declare _res jsonb; begin
  _res := public.reserve_copilot_external_call('30b20000-0000-4000-8000-000000000101'::uuid,
    current_setting('_t.pid')::uuid,'phase10b2',null,'gpt-5.6-sol','v1','copilot_output_v1',100,100,5);
  perform set_config('_t.res1', _res->>'reservation_id', true);
  perform _c('B2.21 reservation issued', _res->>'reservation_id' is not null);
end $$;
select _c('B2.22 settle records safe telemetry',
  (public.settle_copilot_external_call('30b20000-0000-4000-8000-000000000101'::uuid,
    current_setting('_t.res1')::uuid,'resp_abc123',120,80,900,'completed',4)->>'settled')::boolean);
select _c('B2.23 double settle refused (no double-counting)', _raises(format($q$
  select public.settle_copilot_external_call('30b20000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    'resp_abc123',120,80,900,'completed',4) $q$, current_setting('_t.res1')),'22023'));
do $$ declare _res jsonb; begin
  _res := public.reserve_copilot_external_call('30b20000-0000-4000-8000-000000000101'::uuid,
    current_setting('_t.pid')::uuid,'phase10b2',null,'gpt-5.6-sol','v1','copilot_output_v1',10,10,1);
  perform _c('B2.24 second reservation consumes the last slot', _res->>'reservation_id' is not null);
end $$;
select _c('B2.25 third reservation REFUSED — call cap enforced', _raises(format($q$
  select public.reserve_copilot_external_call('30b20000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    'phase10b2', null,'gpt-5.6-sol','v1','copilot_output_v1',10,10,1) $q$,
  current_setting('_t.pid')),'55000'));
select _c('B2.26 budget CHECK forbids overshoot even by direct update', _raises($q$
  update public.clinical_copilot_call_budget set used_calls = max_calls + 1 where 1=1 $q$,'23514'));

-- ============ posture ============
select _c('B2.27 posture defaults to unknown, not verified',
  coalesce((select baa_status from public.clinical_copilot_provider_posture
    where provider_registry_id = current_setting('_t.pid')::uuid),'unknown') = 'unknown');
select _c('B2.28 non-admin cannot record posture', _raises(format($q$
  select public.record_copilot_provider_posture(%L::uuid,'verified',now(),'verified',now(),
    'org-x','proj-y','https://api.openai.com/v1/responses','gpt-5.6-sol','REVIEW-1') $q$,
  current_setting('_t.pid')),'42501'));
select set_config('request.jwt.claims','{"sub":"30b20000-0000-4000-8000-000000000099","role":"authenticated"}',true);
select _c('B2.29 verified posture without a reviewer reference refused', _raises(format($q$
  select public.record_copilot_provider_posture(%L::uuid,'verified',now(),'unknown',null,
    null,null,null,null,'TBD') $q$, current_setting('_t.pid')),'22023'));
select _c('B2.30 a secret pasted into the OpenAI org field is refused', _raises(format($q$
  select public.record_copilot_provider_posture(%L::uuid,'unknown',null,'unknown',null,
    'sk-abcdefghijklmnop',null,null,null,null) $q$, current_setting('_t.pid')),'23514'));

-- ============ history + cross-tenant ============
select _c('B2.31 activation history is append-only', _raises($q$
  update public.clinical_copilot_activation_history set reason='rewrite' where 1=1 $q$,'22023'));
select _c('B2.32 activation history recorded the kill-switch drill', (
  select count(*) >= 2 from public.clinical_copilot_activation_history
   where organization_id='30b20000-0000-4000-8000-000000000101'
     and change_kind in ('kill_switch_engaged','kill_switch_released')));

select set_config('request.jwt.claims','{"sub":"30b20000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select _c('B2.33 cross-tenant gate evaluation refused', _raises(format($q$
  select public.evaluate_copilot_staging_gate('30b20000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    '30b20000-0000-4000-8000-000000000201'::uuid,'gpt-5.6-sol','phase10b2') $q$,
  current_setting('_t.pid')),'42501'));
select _c('B2.34 cross-tenant governance view refused', _raises($q$
  select public.get_copilot_governance_view('30b20000-0000-4000-8000-000000000101'::uuid) $q$,'42501'));
select _c('B2.35 cross-tenant kill switch refused', _raises(format($q$
  select public.set_copilot_kill_switch('30b20000-0000-4000-8000-000000000101'::uuid, %L::uuid, true,'hostile') $q$,
  current_setting('_t.pid')),'42501'));

-- ============ telemetry has no PHI/prompt columns at all ============
select _c('B2.36 external-call ledger has no prompt/response/patient column', (
  select count(*) = 0 from information_schema.columns
   where table_schema='public' and table_name='clinical_copilot_external_calls'
     and column_name ~* 'prompt|response_body|content|patient|summary|text'));
select _c('B2.37 no anon/PUBLIC EXECUTE on any 10B.2 RPC', (
  select count(*) = 0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   join information_schema.routine_privileges g on g.routine_schema=n.nspname and g.routine_name=p.proname
   where n.nspname='public' and p.proname in (
     'attest_synthetic_subject','revoke_synthetic_attestation','is_synthetic_eligible',
     'set_copilot_activation_scope','set_copilot_kill_switch','record_copilot_provider_posture',
     'set_copilot_call_budget','reserve_copilot_external_call','settle_copilot_external_call',
     'evaluate_copilot_staging_gate','get_copilot_governance_view')
     and g.grantee in ('PUBLIC','anon') and g.privilege_type='EXECUTE'));
-- The trigger function is included deliberately. It inherited the default
-- PUBLIC EXECUTE grant when it was created, which PostgREST exposes to
-- anon; the advisor caught it and 20260805220031 revoked it. B2.37 above
-- did not cover it because it only listed the RPCs, which is exactly the
-- gap that let it through.
select _c('B2.39 the append-only TRIGGER function is not callable by anyone', (
  select count(*) = 0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   join information_schema.routine_privileges g on g.routine_schema=n.nspname and g.routine_name=p.proname
   where n.nspname='public' and p.proname = 'copilot_activation_history_append_only'
     and g.grantee in ('PUBLIC','anon','authenticated') and g.privilege_type='EXECUTE'));

-- The proconfig ELEMENT is compared, not the array's ::text rendering.
-- The rendering escapes the quotes (`{"search_path=\"\""}`), so a regex
-- against it silently matches nothing and the assertion passes for the
-- wrong reason — which is what happened on the first draft of this test.
select _c('B2.40 every 10B.2 function pins an empty search_path', (
  select count(*) = 0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in (
     'attest_synthetic_subject','revoke_synthetic_attestation','is_synthetic_eligible',
     'set_copilot_activation_scope','set_copilot_kill_switch','record_copilot_provider_posture',
     'set_copilot_call_budget','reserve_copilot_external_call','settle_copilot_external_call',
     'evaluate_copilot_staging_gate','get_copilot_governance_view',
     'copilot_activation_history_append_only')
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg = 'search_path=""')));

select _c('B2.41 every 10B.2 table has RLS enabled', (
  select count(*) = 0 from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname in (
     'clinical_synthetic_eligibility','clinical_copilot_activation_history',
     'clinical_copilot_provider_posture','clinical_copilot_call_budget',
     'clinical_copilot_external_calls')
     and c.relrowsecurity = false));

select _c('B2.42 every 10B.2 table has at least one policy (RLS on with none = locked but silent)', (
  select count(*) = 0 from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname in (
     'clinical_synthetic_eligibility','clinical_copilot_activation_history',
     'clinical_copilot_provider_posture','clinical_copilot_call_budget',
     'clinical_copilot_external_calls')
     and not exists (select 1 from pg_policies pol
                     where pol.schemaname='public' and pol.tablename=c.relname)));

select _c('B2.38 no commercial table is reachable from any 10B.2 function body', (
  select count(*) = 0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in (
     'evaluate_copilot_staging_gate','get_copilot_governance_view','reserve_copilot_external_call',
     'settle_copilot_external_call','is_synthetic_eligible')
     and p.prosrc ~* 'affiliate|commercial|commission|price|supplement_products'));

select count(*) filter(where ok) as passed, count(*) filter(where ok is false) as failed,
       count(*) as total,
       coalesce(string_agg(n,' | ') filter(where ok is not true),'(none)') as problems from _r;
rollback;
