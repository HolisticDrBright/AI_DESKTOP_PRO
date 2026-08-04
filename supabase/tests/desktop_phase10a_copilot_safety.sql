-- Phase 10A acceptance: governed copilot run model.
-- Rolled back at the end, zero residue.
-- Every assertion uses PL/pgSQL DO blocks (with BEGIN/EXCEPTION captures) or
-- direct _raises(...) — no unreferenced CTE is trusted to execute its side
-- effect. All 45 assertions pass on staging under the current shape.
-- 1-18: baseline governance (auth, tenant isolation, lifecycle, PHI-clean audit).
-- 19-25: identity-and-input-snapshot are IMMUTABLE FROM CREATION, not only
-- after completion.
-- 26-31: the two new SECURITY DEFINER read RPCs actually run RLS-scoped
-- queries and honestly return empty on empty staging.
-- 32-44: the three practitioner-action RPCs write to draft surfaces only
-- (unsigned note version, draft protocol version, open review task) with
-- no signing / activation / ordering / messaging side effects.
-- 45: grant-level defense-in-depth — every copilot RPC's EXECUTE grant set
-- is exactly {postgres, authenticated, service_role}; anon + PUBLIC are
-- revoked. Function bodies still refuse anonymous (28000), but the grant
-- shape must not depend on that.

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
  ('10a10000-0000-4000-8000-000000000203','10a10000-0000-4000-8000-000000000101','P10A-R-3','P','3'),
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
  -- Baseline: skip input-hash validation (NULL) — the input-hash lock is
  -- exercised end-to-end in P10A.SQL.22–25 below with the 14-arg create.
  perform public.finalize_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    _id, null, repeat('c',64), 'completed');
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
    _id, null, repeat('e',64), 'completed');
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

-- ---------------------------------------------------------------------------
-- 19-24: Identity and input snapshot are IMMUTABLE FROM CREATION.
-- ---------------------------------------------------------------------------
-- Under the previous guard, patient_id/lens/provider/rule_set_version and
-- input_sha256 were only immutable AFTER completion. That is a provenance
-- hole: the run row could be rewritten between create and finalize. The
-- tightened guard blocks every one of those swaps on a `created` run and
-- finalize writes only the output side.

-- Create a fresh `created` run for the swap attempts. Use the 14-arg overload
-- so the input hash is written at CREATE time (Phase 10A end-state).
do $$ declare _id uuid;
begin
  _id := (public.create_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'western', 'practitioner_brief',
    '10a10000-0000-4000-8000-000000000301'::uuid,
    'v1','v1','v1','disabled', null, null,
    repeat('a',64)) ->> 'id')::uuid;

  -- 19: patient_id locked from creation — attempted swap to a same-tenant patient.
  begin
    update public.clinical_copilot_runs
       set patient_id = '10a10000-0000-4000-8000-000000000203' where id = _id;
    perform _c('P10A.SQL.19 patient_id locked from creation', false);
  exception when others then
    perform _c('P10A.SQL.19 patient_id locked from creation', SQLSTATE = '22023');
  end;

  -- 20: lens locked from creation — attempted swap between two accepted lenses.
  begin
    update public.clinical_copilot_runs set lens = 'biohacking' where id = _id;
    perform _c('P10A.SQL.20 lens locked from creation', false);
  exception when others then
    perform _c('P10A.SQL.20 lens locked from creation', SQLSTATE = '22023');
  end;

  -- 21: provider identity locked from creation.
  begin
    update public.clinical_copilot_runs set provider = 'live' where id = _id;
    perform _c('P10A.SQL.21 provider locked from creation', false);
  exception when others then
    perform _c('P10A.SQL.21 provider locked from creation', SQLSTATE = '22023');
  end;

  -- 22: input_sha256 locked from creation — this is what a caller would try
  -- to overwrite between create and finalize to hide input drift.
  begin
    update public.clinical_copilot_runs set input_sha256 = repeat('9',64) where id = _id;
    perform _c('P10A.SQL.22 input_sha256 locked from creation', false);
  exception when others then
    perform _c('P10A.SQL.22 input_sha256 locked from creation', SQLSTATE = '22023');
  end;

  -- 23: rule_set_version locked from creation.
  begin
    update public.clinical_copilot_runs set rule_set_version = 'v2' where id = _id;
    perform _c('P10A.SQL.23 rule_set_version locked from creation', false);
  exception when others then
    perform _c('P10A.SQL.23 rule_set_version locked from creation', SQLSTATE = '22023');
  end;

  -- 24: Finalize succeeds and touches ONLY output-side fields. The input hash
  -- written at create time survives finalization untouched.
  perform public.finalize_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    _id, repeat('a',64), repeat('b',64), 'completed');
  perform _c('P10A.SQL.24 finalize writes output only',
    (select input_sha256 = repeat('a',64)
        and output_sha256 = repeat('b',64)
        and safety_status = 'clear'
       from public.clinical_copilot_runs where id = _id));
end $$;

-- Independent sub-assertion: finalize with a mismatching input hash is refused
-- (55000). Uses a second, fresh run so it does not interact with #24.
do $$ declare _id2 uuid;
begin
  _id2 := (public.create_copilot_run(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid,
    null::uuid, 'functional', 'practitioner_brief',
    '10a10000-0000-4000-8000-000000000301'::uuid,
    'v1','v1','v1','fixture', null, null,
    repeat('c',64)) ->> 'id')::uuid;
  begin
    perform public.finalize_copilot_run(
      '10a10000-0000-4000-8000-000000000101'::uuid,
      _id2, repeat('e',64), repeat('f',64), 'completed');
    perform _c('P10A.SQL.25 finalize refuses mismatched input hash', false);
  exception when others then
    perform _c('P10A.SQL.25 finalize refuses mismatched input hash', SQLSTATE = '55000');
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 26-31: The two new read RPCs actually query RLS-scoped clinical/governed
-- tables and honestly return empty on empty staging.
-- ---------------------------------------------------------------------------

-- 26. build_copilot_input_snapshot refuses anonymous (28000).
select set_config('request.jwt.claims', null, true);
select _c('P10A.SQL.26 build_copilot_input_snapshot refuses anonymous', _raises($q$
  select public.build_copilot_input_snapshot(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid)
$q$, '28000'));

-- 27. build_copilot_input_snapshot refuses a cross-tenant patient (42501).
select set_config('request.jwt.claims',
  '{"sub":"10a10000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select _c('P10A.SQL.27 build_copilot_input_snapshot refuses cross-tenant patient', _raises($q$
  select public.build_copilot_input_snapshot(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000202'::uuid)
$q$, '42501'));

-- 28. build_copilot_input_snapshot returns an honest snapshot for the
--     authorized caller: demographics are populated from the row (sex column),
--     and every clinical patient array is empty (no rows in staging).
do $$ declare v jsonb;
begin
  v := public.build_copilot_input_snapshot(
    '10a10000-0000-4000-8000-000000000101'::uuid,
    '10a10000-0000-4000-8000-000000000201'::uuid);
  perform _c('P10A.SQL.28 build_copilot_input_snapshot returns honest empty on empty staging',
    (v -> 'snapshot' -> 'medications') = '[]'::jsonb
    and (v -> 'snapshot' -> 'allergies') = '[]'::jsonb
    and (v -> 'snapshot' -> 'labs') = '[]'::jsonb
    and (v -> 'snapshot' -> 'currentProtocols') = '[]'::jsonb
    and (v -> 'records') = '[]'::jsonb);
end $$;

-- 29. fetch_copilot_governed_retrieval refuses anonymous (28000).
select set_config('request.jwt.claims', null, true);
select _c('P10A.SQL.29 fetch_copilot_governed_retrieval refuses anonymous', _raises($q$
  select public.fetch_copilot_governed_retrieval('10a10000-0000-4000-8000-000000000101'::uuid)
$q$, '28000'));

-- 30. fetch_copilot_governed_retrieval refuses a forged-org non-member (42501).
select set_config('request.jwt.claims',
  '{"sub":"10a10000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select _c('P10A.SQL.30 fetch_copilot_governed_retrieval refuses forged-org non-member', _raises($q$
  select public.fetch_copilot_governed_retrieval('10a10000-0000-4000-8000-000000000101'::uuid)
$q$, '42501'));

-- 31. fetch_copilot_governed_retrieval returns empty arrays on empty staging
--     for the authorized caller (0 approved refs / verified labels / templates).
select set_config('request.jwt.claims',
  '{"sub":"10a10000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$ declare v jsonb;
begin
  v := public.fetch_copilot_governed_retrieval('10a10000-0000-4000-8000-000000000101'::uuid);
  perform _c('P10A.SQL.31 fetch_copilot_governed_retrieval returns honest empty on empty staging',
    (v -> 'approvedKnowledgeReferenceIds') = '[]'::jsonb
    and (v -> 'verifiedLabelIds') = '[]'::jsonb
    and (v -> 'approvedProtocolTemplateIds') = '[]'::jsonb
    and (v -> 'approvedDietTemplateIds') = '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- 32-44: Practitioner actions write to DRAFT surfaces only.
-- ---------------------------------------------------------------------------
-- Uses a separate org/patient/notes/protocol/encounter fixture so counts
-- don't collide with #1-31. Every RPC records the run's disposition as
-- 'accepted' and NEVER signs a note, activates a protocol, orders a lab,
-- prescribes, bills, or sends a message.

insert into auth.users(id,email) values
  ('12a10000-0000-4000-8000-000000000001','pa-a@x'),
  ('12a10000-0000-4000-8000-000000000002','pa-b@x');
insert into public.organizations(id,name,slug) values
  ('12a10000-0000-4000-8000-000000000101','A','p10a-pa-a'),
  ('12a10000-0000-4000-8000-000000000102','B','p10a-pa-b');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('12a10000-0000-4000-8000-000000000101','12a10000-0000-4000-8000-000000000001','owner','active');
insert into public.patient_profiles(id,organization_id,mrn,first_name,last_name) values
  ('12a10000-0000-4000-8000-000000000201','12a10000-0000-4000-8000-000000000101','PA-1','P','1'),
  ('12a10000-0000-4000-8000-000000000202','12a10000-0000-4000-8000-000000000102','PA-2','P','2');
insert into public.clinical_pathways(id,organization_id,code,name,domain_code,description,created_by) values
  ('12a10000-0000-4000-8000-000000000401','12a10000-0000-4000-8000-000000000101','p10a-pa','P','g','f',
   '12a10000-0000-4000-8000-000000000001');
insert into public.clinical_pathway_versions
  (id,organization_id,pathway_id,version,status,content,source_refs,content_sha256,
   created_by,approved_at,approved_by) values
  ('12a10000-0000-4000-8000-000000000301','12a10000-0000-4000-8000-000000000101',
   '12a10000-0000-4000-8000-000000000401',1,'approved','{}'::jsonb,'[]'::jsonb,repeat('a',64),
   '12a10000-0000-4000-8000-000000000001',now(),'12a10000-0000-4000-8000-000000000001');
insert into public.encounters(id,organization_id,patient_id,status,source) values
  ('12a10000-0000-4000-8000-000000000701','12a10000-0000-4000-8000-000000000101',
   '12a10000-0000-4000-8000-000000000201','in_progress','manual');
insert into public.protocols(id,organization_id,patient_id,title,status,created_by,updated_by) values
  ('12a10000-0000-4000-8000-000000000501','12a10000-0000-4000-8000-000000000101',
   '12a10000-0000-4000-8000-000000000201','P','draft',
   '12a10000-0000-4000-8000-000000000001','12a10000-0000-4000-8000-000000000001');
insert into public.clinical_notes
  (id,organization_id,patient_id,encounter_id,author_user_id,note_type,body,is_signed,status,source,
   created_by,updated_by,current_version) values
  ('12a10000-0000-4000-8000-000000000601','12a10000-0000-4000-8000-000000000101',
   '12a10000-0000-4000-8000-000000000201','12a10000-0000-4000-8000-000000000701',
   '12a10000-0000-4000-8000-000000000001','soap','draft body',false,'draft','manual',
   '12a10000-0000-4000-8000-000000000001','12a10000-0000-4000-8000-000000000001',1),
  ('12a10000-0000-4000-8000-000000000602','12a10000-0000-4000-8000-000000000101',
   '12a10000-0000-4000-8000-000000000201','12a10000-0000-4000-8000-000000000701',
   '12a10000-0000-4000-8000-000000000001','soap','signed body',true,'signed','manual',
   '12a10000-0000-4000-8000-000000000001','12a10000-0000-4000-8000-000000000001',1);

select set_config('request.jwt.claims',
  '{"sub":"12a10000-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $$ declare _rid uuid;
begin
  _rid := (public.create_copilot_run(
    '12a10000-0000-4000-8000-000000000101'::uuid,
    '12a10000-0000-4000-8000-000000000201'::uuid,
    null::uuid,'western','practitioner_brief',
    '12a10000-0000-4000-8000-000000000301'::uuid,
    'v1','v1','v1','fixture',null,null,repeat('a',64)) ->> 'id')::uuid;
  perform public.finalize_copilot_run(
    '12a10000-0000-4000-8000-000000000101'::uuid,
    _rid, repeat('a',64), repeat('b',64), 'completed');
  perform set_config('_test.run_id', _rid::text, true);
end $$;

-- 32-33: apply_to_note appends a new UNSIGNED draft version and never
-- flips the parent note's is_signed / status.
do $$ declare _rid uuid := current_setting('_test.run_id')::uuid; _res jsonb; _cnt int;
begin
  _res := public.apply_copilot_run_to_note(
    '12a10000-0000-4000-8000-000000000101'::uuid, _rid,
    '12a10000-0000-4000-8000-000000000601'::uuid,
    '{"summary":"draft"}'::jsonb, repeat('a',64));
  _cnt := (select count(*) from public.clinical_note_versions
            where note_id='12a10000-0000-4000-8000-000000000601'
              and save_kind='copilot_append');
  perform _c('P10A.SQL.32 apply_to_note appends a new UNSIGNED draft version',
    _res->>'ok'='true' and _cnt >= 1);
  perform _c('P10A.SQL.33 apply_to_note never overwrites is_signed',
    (select is_signed=false and status='draft'
       from public.clinical_notes where id='12a10000-0000-4000-8000-000000000601'));
end $$;

-- 34: apply_to_note refuses a signed note (55000).
select _c('P10A.SQL.34 apply_to_note refuses signed note', _raises(
  format($q$ select public.apply_copilot_run_to_note(
    '12a10000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    '12a10000-0000-4000-8000-000000000602'::uuid,
    '{}'::jsonb, repeat('a',64)) $q$, current_setting('_test.run_id')), '55000'));

-- 35: apply_to_protocol_draft creates a DRAFT version — never approved / active.
do $$ declare _rid uuid := current_setting('_test.run_id')::uuid; _res jsonb;
begin
  _res := public.apply_copilot_run_to_protocol_draft(
    '12a10000-0000-4000-8000-000000000101'::uuid, _rid,
    '12a10000-0000-4000-8000-000000000501'::uuid, 'Copilot draft', 'Summary');
  perform _c('P10A.SQL.35 apply_to_protocol_draft creates DRAFT version',
    _res->>'status'='draft'
    and exists(select 1 from public.protocol_versions
                where id=(_res->>'newVersionId')::uuid and status='draft'));
end $$;

-- 36: create_copilot_review_task lands as OPEN, medium priority, category=copilot_review.
do $$ declare _rid uuid := current_setting('_test.run_id')::uuid; _res jsonb;
begin
  _res := public.create_copilot_review_task(
    '12a10000-0000-4000-8000-000000000101'::uuid, _rid,
    'Review this run', 'detail');
  perform _c('P10A.SQL.36 create_copilot_review_task lands as open/medium/copilot_review',
    _res->>'status'='open'
    and exists(select 1 from public.tasks
                where id=(_res->>'taskId')::uuid
                  and status='open' and priority='medium' and category='copilot_review'));
end $$;

-- 37-39: All three refuse an anonymous caller (28000).
select set_config('request.jwt.claims', null, true);
select _c('P10A.SQL.37 apply_to_note refuses anonymous', _raises(
  format($q$ select public.apply_copilot_run_to_note(
    '12a10000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    '12a10000-0000-4000-8000-000000000601'::uuid,
    '{}'::jsonb, repeat('a',64)) $q$, current_setting('_test.run_id')), '28000'));
select _c('P10A.SQL.38 apply_to_protocol_draft refuses anonymous', _raises(
  format($q$ select public.apply_copilot_run_to_protocol_draft(
    '12a10000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    '12a10000-0000-4000-8000-000000000501'::uuid, 't', 's') $q$,
    current_setting('_test.run_id')), '28000'));
select _c('P10A.SQL.39 create_copilot_review_task refuses anonymous', _raises(
  format($q$ select public.create_copilot_review_task(
    '12a10000-0000-4000-8000-000000000101'::uuid, %L::uuid, 't', 'd') $q$,
    current_setting('_test.run_id')), '28000'));

-- 40: forged-org non-member refused for apply_to_note (42501).
select set_config('request.jwt.claims',
  '{"sub":"12a10000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select _c('P10A.SQL.40 apply_to_note refuses non-member', _raises(
  format($q$ select public.apply_copilot_run_to_note(
    '12a10000-0000-4000-8000-000000000101'::uuid, %L::uuid,
    '12a10000-0000-4000-8000-000000000601'::uuid,
    '{}'::jsonb, repeat('a',64)) $q$, current_setting('_test.run_id')), '42501'));

-- 41-43: NO signing, activation, or supplement-product side effects.
select set_config('request.jwt.claims',
  '{"sub":"12a10000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select _c('P10A.SQL.41 no signing side effect', (
  select count(*)=0 from public.clinical_notes
   where organization_id = '12a10000-0000-4000-8000-000000000101'
     and signed_at is not null
     and signed_at > now() - interval '30 seconds'));
select _c('P10A.SQL.42 no activation side effect', (
  select count(*)=0 from public.protocol_versions
   where organization_id = '12a10000-0000-4000-8000-000000000101'
     and activated_at is not null
     and activated_at > now() - interval '30 seconds'));
select _c('P10A.SQL.43 no supplement_products change', (
  select count(*)=0 from public.supplement_products
   where updated_at > now() - interval '30 seconds'));

-- 44: Disposition on the source run flips to 'accepted' after any of the
-- three practitioner-action RPCs.
select _c('P10A.SQL.44 disposition=accepted on the source run', (
  select practitioner_disposition = 'accepted'
    from public.clinical_copilot_runs
   where id = current_setting('_test.run_id')::uuid));

-- ---------------------------------------------------------------------------
-- 45: Grant-level defense-in-depth. Every copilot RPC's EXECUTE grants are
-- exactly {postgres, authenticated, service_role} — anon and PUBLIC are
-- revoked. This is asserted independently of the function bodies (which
-- also refuse anonymous callers with SQLSTATE 28000).
-- ---------------------------------------------------------------------------
select _c('P10A.SQL.45 no copilot RPC grants anon or PUBLIC EXECUTE', (
  select count(*) = 0
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join information_schema.routine_privileges g
    on g.routine_schema = n.nspname and g.routine_name = p.proname
  where n.nspname = 'public'
    and p.proname in (
      'create_copilot_run','finalize_copilot_run','mark_copilot_run_stale',
      'record_copilot_disposition','get_copilot_runs_for_patient',
      'build_copilot_input_snapshot','fetch_copilot_governed_retrieval',
      'apply_copilot_run_to_note','apply_copilot_run_to_protocol_draft',
      'create_copilot_review_task')
    and g.grantee in ('PUBLIC','anon')
    and g.privilege_type = 'EXECUTE'));

select count(*) filter(where ok) as passed,
       count(*) filter(where ok is false) as failed,
       count(*) as total,
       coalesce(string_agg(n,' | ') filter(where ok is not true),'(none)') as problems
from _r;

rollback;
