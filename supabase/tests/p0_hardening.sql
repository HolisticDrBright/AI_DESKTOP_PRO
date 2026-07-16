-- ============================================================
-- Test: 0018 P0 hardening (idempotent review + tenant-safe capped audit)
--
-- Rolled-back, against the real project. Proves:
--   - review_biomarker: same decision twice → already_set, exactly ONE audit
--     row; a DIFFERENT decision still audits (legitimate change of mind)
--   - record_audit_event: a dual-org member CANNOT reference org B's patient
--     in org A's audit (42501); same-org reference works; outsiders blocked
--   - metadata/message caps: oversized metadata, non-object metadata, too many
--     keys, overlong safe_message, malformed action → 22023 (nothing inserted)
-- Every row must show passed = true.
-- ============================================================

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
grant all on _v to authenticated;

insert into auth.users(id,email) values
  ('11111111-1111-1111-1111-111111111119','dualorg18@verify.local'),
  ('22222222-2222-2222-2222-222222222229','outsider18@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000018','Verify Org A 18','verify-a-0018'),
  ('bbbbbbbb-0000-0000-0000-000000000019','Verify Org B 18','verify-b-0018');
-- The attacker scenario: one user active in BOTH organizations.
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000018','11111111-1111-1111-1111-111111111119','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000019','11111111-1111-1111-1111-111111111119','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000019','bbbbbbbb-0000-0000-0000-000000000019','OrgB','Patient');
insert into public.practitioner_patient_relationships(organization_id,practitioner_user_id,patient_id,status)
  values ('bbbbbbbb-0000-0000-0000-000000000019','11111111-1111-1111-1111-111111111119','cccccccc-0000-0000-0000-000000000019','active');
insert into public.biomarker_definitions(id,canonical_name) values
  ('dddddddd-0000-0000-0000-000000000018','P0 Marker') on conflict do nothing;
insert into public.biomarker_observations(id,organization_id,patient_id,biomarker_definition_id,value_numeric,unit,review_status,observed_at)
  values ('eeeeeeee-0000-0000-0000-000000000018','bbbbbbbb-0000-0000-0000-000000000019','cccccccc-0000-0000-0000-000000000019',
          'dddddddd-0000-0000-0000-000000000018', 5.5, 'mg/L', 'unreviewed', now());

select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111119","role":"authenticated"}', true);

-- A) idempotent review ---------------------------------------------------------
do $$
declare r jsonb; r2 jsonb; r3 jsonb;
begin
  r := public.review_biomarker('eeeeeeee-0000-0000-0000-000000000018','accepted');
  insert into _v values('first review applies', r->>'review_status'='accepted' and (r->>'already_set')::boolean = false, r::text);
  r2 := public.review_biomarker('eeeeeeee-0000-0000-0000-000000000018','accepted');
  insert into _v values('same decision again is idempotent', (r2->>'already_set')::boolean and (r2->'audit_event_id') = 'null'::jsonb, r2::text);
  r3 := public.review_biomarker('eeeeeeee-0000-0000-0000-000000000018','flagged');
  insert into _v values('changed decision still applies + audits', r3->>'review_status'='flagged' and (r3->>'already_set')::boolean = false, r3::text);
exception when others then
  insert into _v values('idempotent review chain', false, sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'exactly two review audit rows (accepted, flagged) — no duplicate',
       count(*)=2
         and count(*) filter (where metadata->>'decision'='accepted')=1
         and count(*) filter (where metadata->>'decision'='flagged')=1,
       'count='||count(*)
from public.audit_events
where resource_id='eeeeeeee-0000-0000-0000-000000000018' and action='biomarker.review';

-- B) cross-org audit reference blocked ------------------------------------------
do $$
begin
  -- Dual-org member: patient belongs to org B, event claims org A.
  perform public.record_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000018', 'note.view', 'note', 'n-1',
    'Viewed', 'cccccccc-0000-0000-0000-000000000019', '{}'::jsonb);
  insert into _v values('cross-org patient reference blocked', false, 'no error');
exception when others then
  insert into _v values('cross-org patient reference blocked', sqlstate='42501', sqlstate);
end $$;

do $$
declare _id uuid;
begin
  _id := public.record_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000019', 'note.view', 'note', 'n-1',
    'Viewed', 'cccccccc-0000-0000-0000-000000000019', '{"ref":"n-1"}'::jsonb);
  insert into _v values('same-org patient reference allowed', _id is not null, _id::text);
exception when others then
  insert into _v values('same-org patient reference allowed', false, sqlstate||' '||sqlerrm);
end $$;

-- C) caps: free-form clinical content cannot enter the audit trail ---------------
do $$
begin
  perform public.record_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000019', 'note.view', null, null,
    repeat('patient note text ', 20), null, '{}'::jsonb);
  insert into _v values('overlong safe_message rejected', false, 'no error');
exception when others then
  insert into _v values('overlong safe_message rejected', sqlstate='22023', sqlstate);
end $$;

do $$
begin
  perform public.record_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000019', 'note.view', null, null, null, null,
    jsonb_build_object('transcript', repeat('the patient said ', 200)));
  insert into _v values('oversized metadata rejected', false, 'no error');
exception when others then
  insert into _v values('oversized metadata rejected', sqlstate='22023', sqlstate);
end $$;

do $$
begin
  perform public.record_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000019', 'note.view', null, null, null, null,
    '["a","b"]'::jsonb);
  insert into _v values('non-object metadata rejected', false, 'no error');
exception when others then
  insert into _v values('non-object metadata rejected', sqlstate='22023', sqlstate);
end $$;

do $$
declare _m jsonb := '{}'::jsonb; i int;
begin
  for i in 1..20 loop _m := _m || jsonb_build_object('k'||i, i); end loop;
  perform public.record_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000019', 'note.view', null, null, null, null, _m);
  insert into _v values('too many metadata keys rejected', false, 'no error');
exception when others then
  insert into _v values('too many metadata keys rejected', sqlstate='22023', sqlstate);
end $$;

do $$
begin
  perform public.record_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000019', 'Diagnosis: hypertension!!', null, null, null, null, '{}'::jsonb);
  insert into _v values('malformed action rejected', false, 'no error');
exception when others then
  insert into _v values('malformed action rejected', sqlstate='22023', sqlstate);
end $$;

-- D) outsider blocked -------------------------------------------------------------
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222229","role":"authenticated"}', true);
do $$
begin
  perform public.record_audit_event(
    'bbbbbbbb-0000-0000-0000-000000000019', 'note.view', null, null, null, null, '{}'::jsonb);
  insert into _v values('non-member cannot write audit', false, 'no error');
exception when others then
  insert into _v values('non-member cannot write audit', sqlstate='42501', sqlstate);
end $$;

select name, passed, detail from _v order by name;
rollback;
