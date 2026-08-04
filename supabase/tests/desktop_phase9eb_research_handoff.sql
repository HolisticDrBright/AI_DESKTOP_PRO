-- Phase 9E-B acceptance: preview_research_handoff RPC.
-- Rolled back at the end. Zero residue.

begin;

create temp table _r(n text, ok boolean) on commit drop;
create or replace function _c(_n text, _ok boolean) returns void language sql as $fn$
  insert into _r values (_n, _ok);
$fn$;
create or replace function _raises(_sql text, _state text) returns boolean
language plpgsql as $fn$
begin execute _sql; return false; exception when others then return sqlstate=_state; end;
$fn$;

-- Two users, two orgs. User A is a knowledge editor in org 1; user B is a
-- knowledge editor in org 2. User C is a non-editor member of org 1.
insert into auth.users(id,email) values
  ('9eb00000-0000-4000-8000-000000000001','prh-a@x'),
  ('9eb00000-0000-4000-8000-000000000002','prh-b@x'),
  ('9eb00000-0000-4000-8000-000000000003','prh-c@x');
insert into public.organizations(id,name,slug) values
  ('9eb00000-0000-4000-8000-000000000101','A','p9eb-a'),
  ('9eb00000-0000-4000-8000-000000000102','B','p9eb-b');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('9eb00000-0000-4000-8000-000000000101','9eb00000-0000-4000-8000-000000000001','owner','active'),
  ('9eb00000-0000-4000-8000-000000000102','9eb00000-0000-4000-8000-000000000002','owner','active'),
  ('9eb00000-0000-4000-8000-000000000101','9eb00000-0000-4000-8000-000000000003','member','active');

-- Two tiny valid item arrays (three each). knowledge editor is required.
select set_config('_test.clinical_items',
  '[{"entityType":"product_label_research","externalKey":"PRH-0001","displayName":"P1","payload":{"product_research_id":"PRH-0001"},"sourceRaw":{}},'
  ||'{"entityType":"product_label_research","externalKey":"PRH-0002","displayName":"P2","payload":{"product_research_id":"PRH-0002"},"sourceRaw":{}},'
  ||'{"entityType":"product_label_research","externalKey":"PRH-0003","displayName":"P3","payload":{"product_research_id":"PRH-0003"},"sourceRaw":{}}]',
  true);
select set_config('_test.evidence_items',
  '[{"entityType":"product_label_evidence","externalKey":"EV-1","displayName":"E1","payload":{"url":"https://ex/1","sha256":null},"sourceRaw":{}},'
  ||'{"entityType":"product_label_evidence","externalKey":"EV-2","displayName":"E2","payload":{"url":"https://ex/2","sha256":null},"sourceRaw":{}},'
  ||'{"entityType":"product_label_evidence","externalKey":"EV-3","displayName":"E3","payload":{"url":"https://ex/3","sha256":null},"sourceRaw":{}}]',
  true);
select set_config('_test.commercial_items',
  '[{"entityType":"product_label_commercial_link","externalKey":"PRH-0001","displayName":"C1","payload":{"product_research_id":"PRH-0001","affiliate_url":"https://ex/a1"},"sourceRaw":{}},'
  ||'{"entityType":"product_label_commercial_link","externalKey":"PRH-0002","displayName":"C2","payload":{"product_research_id":"PRH-0002","affiliate_url":"https://ex/a2"},"sourceRaw":{}},'
  ||'{"entityType":"product_label_commercial_link","externalKey":"PRH-0003","displayName":"C3","payload":{"product_research_id":"PRH-0003","affiliate_url":"https://ex/a3"},"sourceRaw":{}}]',
  true);

-- 1. Anonymous refused.
select set_config('request.jwt.claims', null, true);
select _c('P9EB.SQL.1 anonymous refused', _raises(
  format($q$ select public.preview_research_handoff(
    '9eb00000-0000-4000-8000-000000000101'::uuid, true, %L,
    'c','c.jsonl',100,%L::jsonb,
    'e','e.jsonl',100,%L::jsonb,
    'x','x.jsonl',100,%L::jsonb) $q$,
    repeat('a',64), current_setting('_test.clinical_items'),
    current_setting('_test.evidence_items'), current_setting('_test.commercial_items')),
  '28000'));

-- 2. Non-editor member refused (require_knowledge_editor should refuse
-- 'member' role).
select set_config('request.jwt.claims',
  '{"sub":"9eb00000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select _c('P9EB.SQL.2 non-editor member refused', _raises(
  format($q$ select public.preview_research_handoff(
    '9eb00000-0000-4000-8000-000000000101'::uuid, true, %L,
    'c','c.jsonl',100,%L::jsonb,
    'e','e.jsonl',100,%L::jsonb,
    'x','x.jsonl',100,%L::jsonb) $q$,
    repeat('a',64), current_setting('_test.clinical_items'),
    current_setting('_test.evidence_items'), current_setting('_test.commercial_items')),
  '42501'));

-- 3. Cross-tenant: editor from org 2 previewing into org 1 refused.
select set_config('request.jwt.claims',
  '{"sub":"9eb00000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select _c('P9EB.SQL.3 cross-tenant editor refused', _raises(
  format($q$ select public.preview_research_handoff(
    '9eb00000-0000-4000-8000-000000000101'::uuid, true, %L,
    'c','c.jsonl',100,%L::jsonb,
    'e','e.jsonl',100,%L::jsonb,
    'x','x.jsonl',100,%L::jsonb) $q$,
    repeat('a',64), current_setting('_test.clinical_items'),
    current_setting('_test.evidence_items'), current_setting('_test.commercial_items')),
  '42501'));

-- 4. Attestation false refused.
select set_config('request.jwt.claims',
  '{"sub":"9eb00000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select _c('P9EB.SQL.4 attestation-false refused', _raises(
  format($q$ select public.preview_research_handoff(
    '9eb00000-0000-4000-8000-000000000101'::uuid, false, %L,
    'c','c.jsonl',100,%L::jsonb,
    'e','e.jsonl',100,%L::jsonb,
    'x','x.jsonl',100,%L::jsonb) $q$,
    repeat('a',64), current_setting('_test.clinical_items'),
    current_setting('_test.evidence_items'), current_setting('_test.commercial_items')),
  '55000'));

-- 5. Bad manifest hash shape refused.
select _c('P9EB.SQL.5 bad manifest sha256 refused', _raises(
  format($q$ select public.preview_research_handoff(
    '9eb00000-0000-4000-8000-000000000101'::uuid, true, %L,
    'c','c.jsonl',100,%L::jsonb,
    'e','e.jsonl',100,%L::jsonb,
    'x','x.jsonl',100,%L::jsonb) $q$,
    'too-short', current_setting('_test.clinical_items'),
    current_setting('_test.evidence_items'), current_setting('_test.commercial_items')),
  '22023'));

-- 6. Happy path: three research_handoff-kind batches created atomically.
do $$ declare _res jsonb; _n int; begin
  _res := public.preview_research_handoff(
    '9eb00000-0000-4000-8000-000000000101'::uuid, true, repeat('a',64),
    'c','c.jsonl',100, current_setting('_test.clinical_items')::jsonb,
    'e','e.jsonl',100, current_setting('_test.evidence_items')::jsonb,
    'x','x.jsonl',100, current_setting('_test.commercial_items')::jsonb);
  perform set_config('_test.clinical_batch', _res->'clinical'->>'batchId', true);
  perform set_config('_test.evidence_batch', _res->'evidence'->>'batchId', true);
  perform set_config('_test.commercial_batch', _res->'commercial'->>'batchId', true);
  select count(*)::int into _n from public.clinical_knowledge_import_batches
   where source_kind='research_handoff'
     and id in ((_res->'clinical'->>'batchId')::uuid,
                (_res->'evidence'->>'batchId')::uuid,
                (_res->'commercial'->>'batchId')::uuid);
  perform _c('P9EB.SQL.6 three research_handoff batches created', _n = 3);
end $$;

-- 7. Commercial batch carries commercial_only=true; the other two are false.
select _c('P9EB.SQL.7 commercial_only shape correct',
  (select commercial_only from public.clinical_knowledge_import_batches
    where id = current_setting('_test.commercial_batch')::uuid) = true
  and (select commercial_only from public.clinical_knowledge_import_batches
    where id = current_setting('_test.clinical_batch')::uuid) = false
  and (select commercial_only from public.clinical_knowledge_import_batches
    where id = current_setting('_test.evidence_batch')::uuid) = false);

-- 8. All three batches have manifest_sha256 set to the caller-supplied value.
select _c('P9EB.SQL.8 manifest sha256 recorded on every batch',
  (select count(*) from public.clinical_knowledge_import_batches
     where id in (current_setting('_test.clinical_batch')::uuid,
                  current_setting('_test.evidence_batch')::uuid,
                  current_setting('_test.commercial_batch')::uuid)
       and manifest_sha256 = repeat('a',64)) = 3);

-- 9. Idempotent retry returns the SAME batch IDs.
do $$ declare _res jsonb; begin
  _res := public.preview_research_handoff(
    '9eb00000-0000-4000-8000-000000000101'::uuid, true, repeat('a',64),
    'c','c.jsonl',100, current_setting('_test.clinical_items')::jsonb,
    'e','e.jsonl',100, current_setting('_test.evidence_items')::jsonb,
    'x','x.jsonl',100, current_setting('_test.commercial_items')::jsonb);
  perform _c('P9EB.SQL.9 retry returns the same clinical batch id',
    _res->'clinical'->>'batchId' = current_setting('_test.clinical_batch'));
  perform _c('P9EB.SQL.10 retry returns the same evidence batch id',
    _res->'evidence'->>'batchId' = current_setting('_test.evidence_batch'));
  perform _c('P9EB.SQL.11 retry returns the same commercial batch id',
    _res->'commercial'->>'batchId' = current_setting('_test.commercial_batch'));
  perform _c('P9EB.SQL.12 retry idempotent flag set on all three',
    (_res->'clinical'->>'idempotent')::boolean = true
    and (_res->'evidence'->>'idempotent')::boolean = true
    and (_res->'commercial'->>'idempotent')::boolean = true);
end $$;

-- 13. Commercial batch is NOT committable through the clinical import path
-- (Phase 9C's commit_knowledge_import refuses commercial_only batches).
select _c('P9EB.SQL.13 commercial batch not committable', _raises(
  format($q$ select public.commit_knowledge_import(%L::uuid) $q$,
    current_setting('_test.commercial_batch')), '55000'));

-- 14. Atomicity — a malformed items array in the middle position rolls
-- back everything. Attempt with an empty evidence array.
select _c('P9EB.SQL.14 empty items array in middle position refused', _raises(
  format($q$ select public.preview_research_handoff(
    '9eb00000-0000-4000-8000-000000000101'::uuid, true, %L,
    'c','c.jsonl',100,%L::jsonb,
    'e','e.jsonl',100,'[]'::jsonb,
    'x','x.jsonl',100,%L::jsonb) $q$,
    repeat('b',64), current_setting('_test.clinical_items'),
    current_setting('_test.commercial_items')),
  '22023'));

-- 15. Atomicity proof: after the failed call above, NO batch with
-- manifest_sha256 = 'b'*64 exists (all three rolled back together).
select _c('P9EB.SQL.15 atomicity: no partial batches after middle-failure',
  (select count(*) from public.clinical_knowledge_import_batches
     where manifest_sha256 = repeat('b',64)) = 0);

-- 16. Provenance: research_handoff.previewed audit event exists for
-- successful call.
select _c('P9EB.SQL.16 audit event carries the three batch ids', (
  select exists (
    select 1 from public.audit_events
    where action = 'research_handoff.previewed'
      and metadata->>'manifestSha256' = repeat('a',64)
      and metadata->>'clinicalBatchId' = current_setting('_test.clinical_batch')
      and metadata->>'evidenceBatchId' = current_setting('_test.evidence_batch')
      and metadata->>'commercialBatchId' = current_setting('_test.commercial_batch'))));

-- 17. Grant-level: no PUBLIC / anon EXECUTE on the new RPC.
select _c('P9EB.SQL.17 no anon/PUBLIC EXECUTE on preview_research_handoff', (
  select count(*) = 0
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  join information_schema.routine_privileges g on g.routine_schema=n.nspname and g.routine_name=p.proname
  where n.nspname='public' and p.proname='preview_research_handoff'
    and g.grantee in ('PUBLIC','anon') and g.privilege_type='EXECUTE'));

-- 18. No product / label / reference / commercial / copilot side effect.
select _c('P9EB.SQL.18 no supplement_products activated', (
  select count(*) = 0 from public.supplement_products
   where updated_at > now() - interval '30 seconds' and status = 'active'));
select _c('P9EB.SQL.19 no product_label_versions verified', (
  select count(*) = 0 from public.product_label_versions
   where status = 'verified'
     and created_at > now() - interval '30 seconds'));
select _c('P9EB.SQL.20 no governed_knowledge_references approved', (
  select count(*) = 0 from public.governed_knowledge_references
   where reviewer_state = 'approved'
     and created_at > now() - interval '30 seconds'));

select count(*) filter(where ok) as passed,
       count(*) filter(where ok is false) as failed,
       count(*) as total,
       coalesce(string_agg(n,' | ') filter(where ok is not true), '(none)') as problems
from _r;

rollback;
