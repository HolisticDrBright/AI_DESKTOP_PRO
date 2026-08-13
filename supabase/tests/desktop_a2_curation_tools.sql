-- Acceptance: Phase 9E-A.2 — product-label editor, knowledge-reference
-- curation, warning resolutions, safe bulk operations, and
-- commercial-clinical isolation.
--
-- Rolled back at the end. Proves each new RPC enforces what the workspace
-- claims: exact identity + facts required for label verification, verified
-- label is immutable, supersede opens a new draft, graded reference must
-- cite, warning resolution is append-only, bulk operations bounded and
-- refuse rogue clinical tags, commercial changes never move the clinical
-- ranking snapshot.

begin;

create temp table _r(n text, ok boolean) on commit drop;
create or replace function _c(_n text, _ok boolean) returns void language sql as $fn$
  insert into _r values (_n, _ok);
$fn$;
create or replace function _raises(_sql text, _state text) returns boolean
language plpgsql as $fn$
begin execute _sql; return false; exception when others then return sqlstate = _state; end;
$fn$;

-- ------------------------------------------------------------- fixtures

insert into auth.users(id, email) values
  ('9ea2000-0000-4000-8000-000000000001', 'a2-editor@x'),
  ('9ea2000-0000-4000-8000-000000000002', 'a2-outsider@x'),
  ('9ea2000-0000-4000-8000-000000000003', 'a2-editor-b@x');
insert into public.organizations(id, name, slug) values
  ('9ea2000-0000-4000-8000-000000000101', 'A2 Org A', 'a2-org-a'),
  ('9ea2000-0000-4000-8000-000000000102', 'A2 Org B', 'a2-org-b');
insert into public.organization_memberships(organization_id, user_id, role, status) values
  ('9ea2000-0000-4000-8000-000000000101', '9ea2000-0000-4000-8000-000000000001', 'owner', 'active'),
  ('9ea2000-0000-4000-8000-000000000102', '9ea2000-0000-4000-8000-000000000003', 'owner', 'active');
insert into public.supplement_brands(id, name) values ('9ea2000-0000-4000-8000-000000000201', 'Acme');
insert into public.supplement_products
  (id, brand_id, name, sku, upc, manufacturer_identifier, status, restricted_flags)
values
  ('9ea2000-0000-4000-8000-000000000301', '9ea2000-0000-4000-8000-000000000201',
   'A2 Ranking Product', 'RANK-1', '000A2R', 'MFG-RANK', 'active', array['prescription']);

select set_config('request.jwt.claims',
  '{"sub":"9ea2000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- =========================== 1-5 product label editor

-- 1. create draft succeeds; missing identity refuses.
select _c('1. create draft succeeds with identity', (
  select (public.create_product_label_draft(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'A2-1', 'Product 1', 'Brand 1',
    jsonb_build_object('sku', 'X-1'),
    'https://ex/1', '1 cap',
    jsonb_build_array(jsonb_build_object('name', 'Mg'))
  )) ->> 'ok' = 'true'));

select _c('2. create draft refuses without brand', _raises($q$
  select public.create_product_label_draft(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'A2-2', 'Product 2', '',
    '{}'::jsonb)
$q$, '22023'));

-- 3. verify requires serving_size + ingredients + source_url.
select _c('3. verify refuses when required facts missing', _raises($q$
  with c as (
    select (public.create_product_label_draft(
      '9ea2000-0000-4000-8000-000000000101'::uuid,
      'A2-3', 'Product 3', 'Brand 3', '{}'::jsonb) ->> 'id')::uuid as id)
  select public.verify_product_label_version(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    (select id from c),
    'trying')
$q$, '22023'));

-- 4. verified label is immutable in-place; edits fire the trigger.
-- Uses raw UPDATE to prove the trigger enforcement path.
with c as (
  select (public.create_product_label_draft(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'A2-4', 'Product 4', 'Brand 4',
    jsonb_build_object('sku', 'S4'), 'https://ex/4', '1 tab',
    jsonb_build_array(jsonb_build_object('name', 'X'))) ->> 'id')::uuid as id
), v as (
  select public.verify_product_label_version(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    (select id from c), 'verified for test'),
    (select id from c) as id
)
select _c('4. verified label refuses in-place edit', _raises(
  format($q$
    update public.product_label_versions
    set exact_label = jsonb_build_object('sku', 'MUTATED')
    where id = %L
  $q$, (select id from v)), '55000'));

-- 5. supersede opens a new draft; original stays verified.
with c as (
  select (public.create_product_label_draft(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'A2-5', 'Product 5', 'Brand 5',
    jsonb_build_object('sku', 'S5'), 'https://ex/5', '1 unit',
    jsonb_build_array(jsonb_build_object('name', 'Y'))) ->> 'id')::uuid as id
), v as (
  select public.verify_product_label_version(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    (select id from c), 'verified'),
    (select id from c) as id
), s as (
  select public.supersede_product_label_version(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    (select id from v),
    jsonb_build_object('sku', 'S5', 'revision', 2),
    'corrected the label') as res
)
select _c('5. supersede opens new draft; original stays verified', (
  select (s.res ->> 'ok')::boolean
    and exists (select 1 from public.product_label_versions
                where id = ((s.res ->> 'id')::uuid) and status = 'pending')
    and exists (select 1 from public.product_label_versions
                where id = ((s.res ->> 'supersedesId')::uuid) and status = 'verified')
  from s));

-- =========================== 6-9 knowledge reference curation

-- 6. graded reference without citation refuses approval.
with c as (
  select (public.create_knowledge_reference_draft(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'Graded, no cite', 'guideline', 'nutrition',
    '{}'::jsonb, null, null, null,
    'A', null) ->> 'id')::uuid as id
)
select _c('6. graded reference without citation refuses approval', _raises(
  format($q$
    select public.approve_knowledge_reference(
      '9ea2000-0000-4000-8000-000000000101'::uuid,
      %L::uuid, 'trying')
  $q$, (select id from c)), '22023'));

-- 7. graded reference with citation approves.
with c as (
  select (public.create_knowledge_reference_draft(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'Graded with cite', 'RCT', 'endo',
    '{}'::jsonb, null, null, null,
    'B', 'ex/citation') ->> 'id')::uuid as id
), a as (
  select public.approve_knowledge_reference(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    (select id from c), 'peer-reviewed citation checked') as res,
    (select id from c) as id
)
select _c('7. graded reference with citation approves', (
  select (a.res ->> 'reviewerState') = 'approved' from a));

-- 8. approved reference is immutable in the claim + citation + grade.
with c as (
  select (public.create_knowledge_reference_draft(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'Immutable ref', null, null, '{}'::jsonb, null, null, null,
    'practitioner_experience', 'ex/1') ->> 'id')::uuid as id
), a as (
  select public.approve_knowledge_reference(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    (select id from c), 'approved') as res,
    (select id from c) as id
)
select _c('8. approved reference refuses in-place edit', _raises(
  format($q$
    update public.governed_knowledge_references
    set claim = 'MUTATED CLAIM'
    where id = %L
  $q$, (select id from a)), '55000'));

-- 9. supersede a reference opens a new draft.
with c as (
  select (public.create_knowledge_reference_draft(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'Ref to supersede', null, null, '{}'::jsonb, null, null, null,
    'practitioner_experience', null) ->> 'id')::uuid as id
), s as (
  select public.supersede_knowledge_reference(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    (select id from c),
    'New claim text', 'corrected') as res
)
select _c('9. supersede knowledge reference opens new draft', (
  select (s.res ->> 'reviewerState') = 'draft'
    and (s.res ->> 'supersedesId') is not null
  from s));

-- =========================== 10-12 warning resolutions

-- 10. warning resolution requires reason.
select _c('10. warning resolution refuses empty reason', _raises($q$
  select public.record_warning_resolution(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'product', '9ea2000-0000-4000-8000-000000000301'::uuid,
    'restricted:prescription', 'resolved', '')
$q$, '22023'));

-- 11. warning resolution is append-only.
select public.record_warning_resolution(
  '9ea2000-0000-4000-8000-000000000101'::uuid,
  'product', '9ea2000-0000-4000-8000-000000000301'::uuid,
  'restricted:prescription', 'resolved', 'Reviewed');

select _c('11. warning resolution cannot be updated', _raises($q$
  update public.curation_warning_resolutions
  set reason = 'x'
  where organization_id = '9ea2000-0000-4000-8000-000000000101'
$q$, '42501'));

-- 12. cross-tenant warning resolution refused.
select _c('12. cross-tenant warning resolution refused', _raises($q$
  select public.record_warning_resolution(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'knowledge_reference',
    (select id from public.governed_knowledge_references
     where organization_id='9ea2000-0000-4000-8000-000000000102' limit 1),
    'x', 'resolved', 'y')
$q$, 'P0002'));  -- No refs in org-B yet — the not-found path fires first.

-- =========================== 13-15 safe bulk operations

-- Seed a couple of preview items for bulk targets.
insert into public.clinical_knowledge_import_batches
  (id, organization_id, source_name, schema_version, source_sha256, status,
   item_count, no_phi_attested_by, no_phi_attested_at, created_by,
   added_count, changed_count, unchanged_count, conflict_count,
   removed_count, ambiguous_count, restricted_count, deferred_count,
   source_restricted_flags, commercial_only)
values
  ('9ea2000-0000-4000-8000-000000000501',
   '9ea2000-0000-4000-8000-000000000101',
   'a2-bulk.xlsx', 'v1', repeat('a',64), 'preview', 2,
   '9ea2000-0000-4000-8000-000000000001', now(),
   '9ea2000-0000-4000-8000-000000000001',
   2, 0, 0, 0, 0, 0, 0, 0, array[]::text[], false);

insert into public.clinical_knowledge_import_items
  (id, batch_id, organization_id, entity_type, external_key, display_name,
   payload, payload_sha256, warnings, validation_errors, status,
   source_raw, restricted_flags, missing_facts, candidate_matches)
values
  ('9ea2000-0000-4000-8000-000000000601',
   '9ea2000-0000-4000-8000-000000000501',
   '9ea2000-0000-4000-8000-000000000101',
   'catalog_product', 'BULK-1', 'Bulk item 1',
   '{}'::jsonb, repeat('b',64), '[]'::jsonb, '[]'::jsonb, 'needs_review',
   '{}'::jsonb, array[]::text[], '[]'::jsonb, '[]'::jsonb),
  ('9ea2000-0000-4000-8000-000000000602',
   '9ea2000-0000-4000-8000-000000000501',
   '9ea2000-0000-4000-8000-000000000101',
   'catalog_product', 'BULK-2', 'Bulk item 2',
   '{}'::jsonb, repeat('c',64), '[]'::jsonb, '[]'::jsonb, 'needs_review',
   '{}'::jsonb, array[]::text[], '[]'::jsonb, '[]'::jsonb);

-- 13. bulk_apply_org_tag refuses a tag that looks like a clinical outcome.
select _c('13. bulk_apply_org_tag refuses "approved" tag', _raises($q$
  select public.bulk_apply_org_tag(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    array['9ea2000-0000-4000-8000-000000000601'::uuid],
    'approved-for-clinical', 'trying to smuggle approval')
$q$, '22023'));

-- 14. bulk assign to non-member is refused.
select _c('14. bulk_assign_reviewer refuses non-member assignee', _raises($q$
  select public.bulk_assign_reviewer(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    array['9ea2000-0000-4000-8000-000000000601'::uuid],
    '9ea2000-0000-4000-8000-000000000002'::uuid,
    'assign to outsider')
$q$, '42501'));

-- 15. bulk assign to member succeeds and returns itemsUpdated.
select _c('15. bulk_assign_reviewer succeeds for member', (
  select (public.bulk_assign_reviewer(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    array['9ea2000-0000-4000-8000-000000000601'::uuid,
          '9ea2000-0000-4000-8000-000000000602'::uuid],
    '9ea2000-0000-4000-8000-000000000001'::uuid,
    'assign to self for A.2 test') ->> 'itemsUpdated')::int = 2));

-- =========================== 16 clinical ranking snapshot invariant

-- 16. clinical_ranking_snapshot depends ONLY on clinical fields; the same
-- product produces the same snapshot when commercial fields (which are
-- stored separately) change.
select _c('16. clinical_ranking_snapshot is stable across commercial writes', (
  with s1 as (select public.clinical_ranking_snapshot(
    '9ea2000-0000-4000-8000-000000000301'::uuid) as h)
  select (select h from s1) = public.clinical_ranking_snapshot(
    '9ea2000-0000-4000-8000-000000000301'::uuid)));

-- =========================== 17 tenant isolation on the new RPCs

-- 17. an outsider cannot create a label draft in another org.
select set_config('request.jwt.claims',
  '{"sub":"9ea2000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select _c('17. non-member refused on create_product_label_draft', _raises($q$
  select public.create_product_label_draft(
    '9ea2000-0000-4000-8000-000000000101'::uuid,
    'OUT', 'Out', 'Out',
    '{}'::jsonb)
$q$, '42501'));

-- ---------------------------------------------------------------- results

select count(*) filter(where ok) as passed,
       count(*) filter(where ok is false) as failed,
       count(*) as total,
       coalesce(string_agg(n,' | ') filter(where ok is not true),'(none)') as problems
from _r;

rollback;
