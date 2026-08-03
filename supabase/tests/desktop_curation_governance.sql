-- Acceptance: Phase 9E-A governance — 5-outcome restricted review and
-- governed commercial matching.
--
-- Rolled back at the end.
--
-- 18 checks. Proves the two new RPCs enforce what the workspace claims:
-- role gating, required reasons, jurisdiction requirement on the clinician
-- outcome, no silent clearance of source-declared restrictions, exact-only
-- commercial matching, verified-only attach, append-only decisions,
-- append-via-supersede revocation, and commercial-clinical separation.

begin;

create temp table _r(n text, ok boolean) on commit drop;

create or replace function _c(_n text, _ok boolean) returns void language sql as $fn$
  insert into _r(n, ok) values (_n, _ok);
$fn$;

create or replace function _raises(_sql text, _state text)
returns boolean language plpgsql as $fn$
begin execute _sql; return false;
exception when others then return sqlstate = _state; end;
$fn$;

-- --------------------------------------------------------------- fixtures

insert into auth.users(id, email) values
  ('9e100000-0000-4000-8000-000000000001', 'p9e-editor@verify.local'),
  ('9e100000-0000-4000-8000-000000000002', 'p9e-outsider@verify.local');

insert into public.organizations(id, name, slug) values
  ('9e100000-0000-4000-8000-000000000101', 'Curation Org A', 'p9e-org-a');

insert into public.organization_memberships(organization_id, user_id, role, status)
values ('9e100000-0000-4000-8000-000000000101',
        '9e100000-0000-4000-8000-000000000001', 'owner', 'active');

insert into public.supplement_brands(id, name) values
  ('9e100000-0000-4000-8000-000000000201', 'Acme Nutraceuticals');

insert into public.supplement_products
  (id, brand_id, name, sku, upc, manufacturer_identifier, status, restricted_flags)
values
  ('9e100000-0000-4000-8000-000000000301',
   '9e100000-0000-4000-8000-000000000201',
   'Restricted Reference Product', 'RRP-1', '000000000001', 'MFG-RRP-1',
   'active', array['vaccine_related']),
  ('9e100000-0000-4000-8000-000000000302',
   '9e100000-0000-4000-8000-000000000201',
   'Commercial Reference Product', 'CRP-1', '000000000002', 'MFG-CRP-1',
   'active', array[]::text[]);

insert into public.product_label_versions
  (id, organization_id, product_code, version, product_name, brand,
   exact_label, label_sha256, source_url, status, created_by,
   verified_at, verified_by, verification_note)
values
  ('9e100000-0000-4000-8000-000000000401',
   '9e100000-0000-4000-8000-000000000101',
   'CRP-1', 1, 'Commercial Reference Product', 'Acme Nutraceuticals',
   jsonb_build_object('name','Commercial Reference Product'),
   repeat('a',64), 'https://verifysource.example',
   'verified', '9e100000-0000-4000-8000-000000000001',
   now(), '9e100000-0000-4000-8000-000000000001',
   'Verified from official label');

insert into public.product_label_versions
  (id, organization_id, product_code, version, product_name, brand,
   exact_label, label_sha256, source_url, status, created_by)
values
  ('9e100000-0000-4000-8000-000000000402',
   '9e100000-0000-4000-8000-000000000101',
   'CRP-1', 2, 'Commercial Reference Product', 'Acme Nutraceuticals',
   jsonb_build_object('name','Commercial Reference Product'),
   repeat('b',64), 'https://verifysource.example',
   'pending', '9e100000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims',
  '{"sub":"9e100000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- =================================================== 1-3 restricted-review gate

select _c('1. reason is required for a restricted-review decision', _raises($q$
  select public.record_restricted_review_outcome(
    '9e100000-0000-4000-8000-000000000101'::uuid,
    '9e100000-0000-4000-8000-000000000301'::uuid,
    'retain_restricted'::public.catalog_restricted_review_outcome, '')
$q$, '22023'));

select _c('2. clinician_reviewed_for_jurisdiction requires a jurisdiction', _raises($q$
  select public.record_restricted_review_outcome(
    '9e100000-0000-4000-8000-000000000101'::uuid,
    '9e100000-0000-4000-8000-000000000301'::uuid,
    'clinician_reviewed_for_jurisdiction'::public.catalog_restricted_review_outcome,
    'reviewed', null)
$q$, '22023'));

select set_config('request.jwt.claims',
  '{"sub":"9e100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select _c('3. a non-member cannot record a decision (42501)', _raises($q$
  select public.record_restricted_review_outcome(
    '9e100000-0000-4000-8000-000000000101'::uuid,
    '9e100000-0000-4000-8000-000000000301'::uuid,
    'retain_restricted'::public.catalog_restricted_review_outcome,
    'looked and left as-is')
$q$, '42501'));
select set_config('request.jwt.claims',
  '{"sub":"9e100000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ================================================= 4-7b each of the 5 outcomes

select public.record_restricted_review_outcome(
  '9e100000-0000-4000-8000-000000000101'::uuid,
  '9e100000-0000-4000-8000-000000000301'::uuid,
  'retain_restricted'::public.catalog_restricted_review_outcome,'looked at it');
select _c('4. retain_restricted landed', (
  select count(*) = 1 from public.catalog_restricted_review_decisions
  where product_id = '9e100000-0000-4000-8000-000000000301'
    and outcome = 'retain_restricted'));

select public.record_restricted_review_outcome(
  '9e100000-0000-4000-8000-000000000101'::uuid,
  '9e100000-0000-4000-8000-000000000301'::uuid,
  'request_evidence'::public.catalog_restricted_review_outcome,'need citation');
select _c('5. request_evidence landed', (
  select count(*) = 1 from public.catalog_restricted_review_decisions
  where product_id = '9e100000-0000-4000-8000-000000000301'
    and outcome = 'request_evidence'));

select public.record_restricted_review_outcome(
  '9e100000-0000-4000-8000-000000000101'::uuid,
  '9e100000-0000-4000-8000-000000000301'::uuid,
  'defer'::public.catalog_restricted_review_outcome,'not ready');
select _c('6. defer landed', (
  select count(*) = 1 from public.catalog_restricted_review_decisions
  where product_id = '9e100000-0000-4000-8000-000000000301'
    and outcome = 'defer'));

select public.record_restricted_review_outcome(
  '9e100000-0000-4000-8000-000000000101'::uuid,
  '9e100000-0000-4000-8000-000000000301'::uuid,
  'reject'::public.catalog_restricted_review_outcome,'no case');
select _c('7a. reject landed', (
  select count(*) = 1 from public.catalog_restricted_review_decisions
  where product_id = '9e100000-0000-4000-8000-000000000301'
    and outcome = 'reject'));

select public.record_restricted_review_outcome(
  '9e100000-0000-4000-8000-000000000101'::uuid,
  '9e100000-0000-4000-8000-000000000301'::uuid,
  'clinician_reviewed_for_jurisdiction'::public.catalog_restricted_review_outcome,
  'reviewed for CA', 'US-CA');
select _c('7b. clinician_reviewed_for_jurisdiction landed with jurisdiction preserved', (
  select jurisdiction = 'US-CA' from public.catalog_restricted_review_decisions
  where product_id = '9e100000-0000-4000-8000-000000000301'
    and outcome = 'clinician_reviewed_for_jurisdiction'));

-- =========================================== 8-9 restriction preservation + read

select _c('8. supplement_products.restricted_flags NOT cleared by ANY review outcome', (
  select 'vaccine_related' = any(restricted_flags)
    and restricted_cleared_at is null
    and restricted_cleared_by is null
  from public.supplement_products
  where id = '9e100000-0000-4000-8000-000000000301'));

select _c('9. get_restricted_review_history returns the latest outcome', (
  select (public.get_restricted_review_history(
    '9e100000-0000-4000-8000-000000000101'::uuid,
    '9e100000-0000-4000-8000-000000000301'::uuid) ->> 'currentOutcome')
    = 'clinician_reviewed_for_jurisdiction'));

-- ================================================ 10-11 append-only enforcement

select _c('10. cannot UPDATE a decision (trigger raises 42501)', _raises($q$
  update public.catalog_restricted_review_decisions set reason = 'x'
  where product_id = '9e100000-0000-4000-8000-000000000301' $q$, '42501'));

select _c('11. cannot DELETE a decision (trigger raises 42501)', _raises($q$
  delete from public.catalog_restricted_review_decisions
  where product_id = '9e100000-0000-4000-8000-000000000301' $q$, '42501'));

-- ==================================== 12-16 commercial matching — exact only

select _c('12. attach on UNVERIFIED label is refused (55000)', _raises($q$
  select public.attach_commercial_link_to_verified_product(
    '9e100000-0000-4000-8000-000000000101'::uuid,
    '9e100000-0000-4000-8000-000000000402'::uuid,
    'CRP-1','','','',
    'https://aff.example/crp-1', null, null, 'exact sku match')
$q$, '55000'));

select _c('13. attach with a NEAR-MISS SKU is refused (22023)', _raises($q$
  select public.attach_commercial_link_to_verified_product(
    '9e100000-0000-4000-8000-000000000101'::uuid,
    '9e100000-0000-4000-8000-000000000401'::uuid,
    'CRP-1-EU','','','',
    'https://aff.example/crp-1', null, null, 'trying soft match')
$q$, '22023'));

select _c('14. attach with EXACT SKU match succeeds (matchAxis=sku)', (
  select (public.attach_commercial_link_to_verified_product(
    '9e100000-0000-4000-8000-000000000101'::uuid,
    '9e100000-0000-4000-8000-000000000401'::uuid,
    'CRP-1','','','',
    'https://aff.example/crp-1','PROMO10','partner: acme',
    'exact sku match')) ->> 'matchAxis' = 'sku'));

select _c('15. the link is present in product_label_commercial_links only', (
  select count(*) = 1 from public.product_label_commercial_links
  where label_version_id = '9e100000-0000-4000-8000-000000000401'
    and kind = 'affiliate' and availability_status = 'available'
    and revoked_at is null));

select _c('16. supplement_products has no affiliate/discount leakage', (
  select
    (to_jsonb(p.*) ->> 'affiliate_url') is null
    and (to_jsonb(p.*) ->> 'discount_code') is null
  from public.supplement_products p
  where p.id = '9e100000-0000-4000-8000-000000000302'));

-- ================================ 17 revocation is an append-via-supersede

select public.revoke_commercial_link(
  '9e100000-0000-4000-8000-000000000101'::uuid,
  (select id from public.product_label_commercial_links
   where label_version_id = '9e100000-0000-4000-8000-000000000401'
     and supersedes_id is null
   order by recorded_at desc limit 1),
  'partner ended promotion');

select _c('17. revoke inserts a superseding row without touching the original', (
  select count(*) = 2
    and exists (
      select 1 from public.product_label_commercial_links
      where label_version_id = '9e100000-0000-4000-8000-000000000401'
        and supersedes_id is not null
        and revoked_at is not null
        and revoked_reason ilike '%promotion%'
        and availability_status = 'discontinued')
    and exists (
      select 1 from public.product_label_commercial_links
      where label_version_id = '9e100000-0000-4000-8000-000000000401'
        and supersedes_id is null
        and revoked_at is null
        and availability_status = 'available')
  from public.product_label_commercial_links
  where label_version_id = '9e100000-0000-4000-8000-000000000401'));

-- ================================ 18 commercial data isolation on function bodies
--
-- No clinical read/reason/safety/rank/protocol function reads any commercial
-- table body. Mirrors desktop_import_source_restriction.sql check 11.

select _c('18. no clinical function body references commercial link tables', (
  select count(*) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.proname in ('evaluate_protocol_safety', 'check_protocol_interactions',
      'review_protocol_item_interactions', 'search_protocol_catalog',
      'protocol_version_json', 'current_reference_status',
      'catalog_verification_status', 'get_patient_protocol')
    and p.prosrc ~ '(product_label_commercial_links|protocol_commercial_links|public\.product_commercial_links)'));

-- ---------------------------------------------------------------- results

select count(*) filter (where ok) as passed,
       count(*) filter (where ok is false) as failed,
       count(*) filter (where ok is null) as never_evaluated,
       count(*) as total,
       coalesce(string_agg(n, ' | ') filter (where ok is not true), '(none)')
         as problems
from _r;

rollback;
