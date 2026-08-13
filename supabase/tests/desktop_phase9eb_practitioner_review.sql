-- Acceptance: Phase 9E-B bounded practitioner review.
-- Rolled back at the end. Zero residue.
--
-- What this suite proves:
--   * the generic accept can no longer mark an item 'applied' while
--     applying nothing (the silent no-op the research entity types hit);
--   * a research-handoff verdict is a RECORDED CLAIM: status stays
--     'needs_review', nothing governed is written, and the audit trail
--     carries every recording;
--   * the bounded read is actually bounded, refuses malformed ids, and
--     returns commercial rows only under their own top-level key.

begin;

create temp table _r(n text, ok boolean) on commit drop;
create or replace function _c(_n text, _ok boolean) returns void language sql as $fn$
  insert into _r values (_n, _ok);
$fn$;
create or replace function _raises(_sql text, _state text) returns boolean
language plpgsql as $fn$
begin execute _sql; return false; exception when others then return sqlstate=_state; end;
$fn$;

-- One org, one knowledge editor, one plain member.
insert into auth.users(id,email) values
  ('9ec00000-0000-4000-8000-000000000001','prv-a@x'),
  ('9ec00000-0000-4000-8000-000000000002','prv-b@x');
insert into public.organizations(id,name,slug) values
  ('9ec00000-0000-4000-8000-000000000101','RevOrg','p9eb-review');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('9ec00000-0000-4000-8000-000000000101','9ec00000-0000-4000-8000-000000000001','owner','active'),
  ('9ec00000-0000-4000-8000-000000000101','9ec00000-0000-4000-8000-000000000002','member','active');

select set_config('request.jwt.claims',
  '{"sub":"9ec00000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- A research_handoff preview (clinical + evidence + commercial).
do $$ declare _res jsonb; begin
  _res := public.preview_research_handoff(
    '9ec00000-0000-4000-8000-000000000101'::uuid, true, repeat('c',64),
    'c','c.jsonl',100,
    '[{"entityType":"product_label_research","externalKey":"PRH-0001","displayName":"P1","payload":{"product_research_id":"PRH-0001","identity_confidence":"exact"},"sourceRaw":{}}]'::jsonb,
    'e','e.jsonl',100,
    '[{"entityType":"product_label_evidence","externalKey":"EV-00001","displayName":"E1","payload":{"product_research_id":"PRH-0001","url":"https://ex/1","sha256":null},"sourceRaw":{}}]'::jsonb,
    'x','x.jsonl',100,
    '[{"entityType":"product_label_commercial_link","externalKey":"PRH-0001","displayName":"C1","payload":{"product_research_id":"PRH-0001","affiliate_url":"https://ex/a1"},"sourceRaw":{}}]'::jsonb);
  perform set_config('_t.clinical_batch', _res->'clinical'->>'batchId', true);
end $$;

select set_config('_t.item', (
  select i.id::text from public.clinical_knowledge_import_items i
  where i.batch_id = current_setting('_t.clinical_batch')::uuid limit 1), true);

-- Also a NON-research batch item to prove the verdict RPC refuses it and
-- the generic accept guard fires for apply-path-less entity types.
do $$ declare _res jsonb; begin
  _res := public.preview_knowledge_import(
    '9ec00000-0000-4000-8000-000000000101'::uuid, 'product_spreadsheet', 'plain', 'v1',
    '[{"entityType":"catalog_product","externalKey":"cp-1","displayName":"CP1","payload":{"name":"CP1"},"sourceRaw":{}}]'::jsonb,
    true, 'p.xlsx', 100, null, '{}'::text[], null, false);
  perform set_config('_t.plain_batch', _res->>'batchId', true);
end $$;
select set_config('_t.plain_item', (
  select i.id::text from public.clinical_knowledge_import_items i
  where i.batch_id = current_setting('_t.plain_batch')::uuid limit 1), true);

-- 1. The silent no-op apply is closed: accepting a research item through
-- the GENERIC RPC refuses (no governed apply path for its entity type).
select _c('PRV.1 generic accept refuses apply-path-less entity types', _raises(
  format($q$ select public.review_clinical_knowledge_import_item(%L::uuid, 'accept', 'note') $q$,
    current_setting('_t.item')), '55000'));

select _c('PRV.2 refused accept left the item needs_review', (
  select status = 'needs_review' from public.clinical_knowledge_import_items
  where id = current_setting('_t.item')::uuid));

-- 2. The verdict RPC: non-editor refused.
select set_config('request.jwt.claims',
  '{"sub":"9ec00000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select _c('PRV.3 non-editor cannot record a verdict', _raises(
  format($q$ select public.record_research_handoff_item_review(%L::uuid, 'verified', 'a substantive note') $q$,
    current_setting('_t.item')), '42501'));

select set_config('request.jwt.claims',
  '{"sub":"9ec00000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- 3. Verdict vocabulary and note substance are enforced.
select _c('PRV.4 verdict vocabulary enforced', _raises(
  format($q$ select public.record_research_handoff_item_review(%L::uuid, 'approved', 'a substantive note') $q$,
    current_setting('_t.item')), '22023'));
select _c('PRV.5 short note refused', _raises(
  format($q$ select public.record_research_handoff_item_review(%L::uuid, 'verified', 'short') $q$,
    current_setting('_t.item')), '22023'));

-- 4. Non-research-handoff items cannot carry a research verdict.
select _c('PRV.6 verdict refused outside research_handoff batches', _raises(
  format($q$ select public.record_research_handoff_item_review(%L::uuid, 'verified', 'a substantive note') $q$,
    current_setting('_t.plain_item')), '55000'));

-- 5. A recorded verdict is a claim, not an apply.
do $$ declare _res jsonb; begin
  _res := public.record_research_handoff_item_review(
    current_setting('_t.item')::uuid, 'verified',
    'Identity exact; UPC validated against the official page; label facts match.');
  perform _c('PRV.7 verdict RPC returns the recorded claim',
    _res->>'verdict' = 'verified' and _res->>'status' = 'needs_review');
end $$;

select _c('PRV.8 status stays needs_review after a verdict', (
  select status = 'needs_review' and research_review_verdict = 'verified'
  from public.clinical_knowledge_import_items
  where id = current_setting('_t.item')::uuid));

select _c('PRV.9 no governed content was written by the verdict', (
  select (select count(*) from public.supplement_products
           where created_at > now() - interval '30 seconds') = 0
     and (select count(*) from public.product_label_versions
           where created_at > now() - interval '30 seconds') = 0
     and (select count(*) from public.governed_knowledge_references
           where created_at > now() - interval '30 seconds') = 0));

select _c('PRV.10 the verdict recording is audited', (
  select exists (
    select 1 from public.audit_events
    where action = 'research_handoff.item_reviewed'
      and resource_id = current_setting('_t.item')
      and metadata->>'verdict' = 'verified')));

-- 6. Re-recording is allowed and audited again (history preserved).
do $$ begin
  perform public.record_research_handoff_item_review(
    current_setting('_t.item')::uuid, 'blocked',
    'Reconsidered: the cited label image URL does not resolve as written.');
end $$;
select _c('PRV.11 re-recorded verdict lands and is separately audited', (
  select (select research_review_verdict from public.clinical_knowledge_import_items
           where id = current_setting('_t.item')::uuid) = 'blocked'
     and (select count(*) from public.audit_events
           where action = 'research_handoff.item_reviewed'
             and resource_id = current_setting('_t.item')) = 2));

-- 7. The bounded read: bound and shape enforced; commercial separate.
select _c('PRV.12 bounded read refuses more than 50 ids', _raises(
  $q$ select public.get_research_handoff_review(
    '9ec00000-0000-4000-8000-000000000101'::uuid,
    (select array_agg('PRH-' || lpad(g::text, 4, '0')) from generate_series(1, 51) g)) $q$,
  '22023'));
select _c('PRV.13 bounded read refuses malformed ids', _raises(
  $q$ select public.get_research_handoff_review(
    '9ec00000-0000-4000-8000-000000000101'::uuid, array['PRH-1; drop table x']) $q$,
  '22023'));

do $$ declare _res jsonb; begin
  _res := public.get_research_handoff_review(
    '9ec00000-0000-4000-8000-000000000101'::uuid, array['PRH-0001']);
  perform _c('PRV.14 read returns the record with its verdict',
    jsonb_array_length(_res->'records') = 1
    and _res->'records'->0->>'verdict' = 'blocked'
    and _res->'records'->0->>'status' = 'needs_review');
  perform _c('PRV.15 evidence rows ride under their own key',
    jsonb_array_length(_res->'evidence') = 1
    and _res->'evidence'->0->>'productResearchId' = 'PRH-0001');
  perform _c('PRV.16 commercial rows ride ONLY under the commercial key',
    jsonb_array_length(_res->'commercial') = 1
    and (_res->'records')::text not like '%affiliate_url%');
end $$;

-- 8. Grants: no PUBLIC/anon EXECUTE on either new RPC.
select _c('PRV.17 no anon/PUBLIC EXECUTE on the new RPCs', (
  select count(*) = 0
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  join information_schema.routine_privileges g
    on g.routine_schema=n.nspname and g.routine_name=p.proname
  where n.nspname='public'
    and p.proname in ('record_research_handoff_item_review','get_research_handoff_review')
    and g.grantee in ('PUBLIC','anon') and g.privilege_type='EXECUTE'));

select count(*) filter(where ok) as passed,
       count(*) filter(where ok is false) as failed,
       count(*) as total,
       coalesce(string_agg(n,' | ') filter(where ok is not true), '(none)') as problems
from _r;

rollback;
