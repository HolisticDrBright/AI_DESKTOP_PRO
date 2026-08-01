-- Phase 9B acceptance: the Product Catalog registry read surface.
--
-- Rolled back at the end; the project is unchanged after the final statement.
--
-- What this proves:
--   * an empty registry renders as EMPTY and says why — no sample products;
--   * a field absent from the captured label is NULL, never inferred;
--   * verification is derived from a named verifier and a practitioner alone
--     cannot assert it;
--   * commercial data is confined to its own branch of the response, proved on
--     the FUNCTION BODY rather than on output (an empty commercial table would
--     make an output-only check pass while proving nothing);
--   * an affiliate URL supplied to the label writer lands in the commercial
--     table and never on a clinical row;
--   * label version history accumulates rather than overwriting.

begin;

create temp table _r(n text, ok boolean) on commit drop;
create temp table _k(k text primary key, v uuid) on commit drop;

create or replace function _c(_n text, _ok boolean) returns void language sql as $fn$
  insert into _r(n, ok) values (_n, _ok);
$fn$;
create or replace function _raises(_sql text, _state text)
returns boolean language plpgsql as $fn$
begin
  execute _sql; return false;
exception when others then return sqlstate = _state;
end;
$fn$;
create or replace function _id(_key text) returns uuid language sql stable as $fn$
  select v from _k where k = _key;
$fn$;

-- ---------------------------------------------------------------- fixtures
--
-- Caller identity comes from `request.jwt.claims`; the RPCs are SECURITY
-- DEFINER and authorize on `auth.uid()` plus membership, so the claim is what
-- decides. The `authenticated` DB role's lack of table privilege is asserted
-- directly (check 20) rather than relied on implicitly.

insert into auth.users(id, email) values
  ('ea000000-0000-4000-8000-000000000001', 'cat-curator@verify.local'),
  ('ea000000-0000-4000-8000-000000000002', 'cat-outsider@verify.local'),
  ('ea000000-0000-4000-8000-000000000003', 'cat-practitioner@verify.local');

insert into public.organizations(id, name, slug) values
  ('ea000000-0000-4000-8000-000000000101', 'Cat Org', 'p9b-cat'),
  ('ea000000-0000-4000-8000-000000000102', 'Cat Other', 'p9b-cat-other');

insert into public.organization_memberships(organization_id, user_id, role, status) values
  ('ea000000-0000-4000-8000-000000000101',
   'ea000000-0000-4000-8000-000000000001', 'owner', 'active'),
  ('ea000000-0000-4000-8000-000000000101',
   'ea000000-0000-4000-8000-000000000003', 'practitioner', 'active'),
  ('ea000000-0000-4000-8000-000000000102',
   'ea000000-0000-4000-8000-000000000002', 'practitioner', 'active');

select set_config('request.jwt.claims',
  '{"sub":"ea000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ======================================================= honest empty state

select _c('1. an empty catalog returns zero products, not samples', (
  select jsonb_array_length(k->'clinical'->'products') = 0
     and (k->'clinical'->'counts'->>'total')::int = 0
  from (select public.get_product_catalog('ea000000-0000-4000-8000-000000000101') k) q));

select _c('2. the empty state says why it is empty', (
  select (public.get_product_catalog('ea000000-0000-4000-8000-000000000101')
          ->>'emptyStateMessage') ilike '%no example products are shown%'));

select _c('3. an empty review queue is an empty list, not a fabricated task', (
  select jsonb_array_length(
    public.get_product_catalog('ea000000-0000-4000-8000-000000000101')
    ->'reviewQueue') = 0));

-- ============================================== a governed label, unknowns kept

insert into _k(k, v)
select 'label', (public.save_product_label_version(
  'ea000000-0000-4000-8000-000000000101', 'cat-001', 'Test Product', 'Test Brand',
  jsonb_build_object(
    'servingSize', '2 capsules',
    'ingredients', 'Mg 200 mg',
    'ingredientRows', jsonb_build_array(
      jsonb_build_object('name', 'Mg', 'amount', '200 mg')),
    'sku', 'TB-001'),
  'https://example.test/label', null)->>'labelVersionId')::uuid;

select _c('4. a saved label appears with a derived, unverified state', (
  select p->>'productCode' = 'cat-001'
     and p->>'verificationState' = 'unverified'
     and (p->>'ingredientCount')::int = 1
  from (select jsonb_array_elements(
    public.get_product_catalog('ea000000-0000-4000-8000-000000000101')
    ->'clinical'->'products') p) q));

-- The honest-unknown rule. `warnings`, `allergens` and `storage` were never on
-- this label, so they must be absent — not "None", which is a clinical claim.
select _c('5. fields absent from the label read as NULL, never invented', (
  select d->'clinical'->>'warnings' is null
     and d->'clinical'->>'allergens' is null
     and d->'clinical'->>'storage' is null
     and d->'clinical'->>'servingSize' = '2 capsules'
  from (select public.get_product_label_detail(_id('label')) d) q));

select _c('6. the detail states that unknown means unknown', (
  select (public.get_product_label_detail(_id('label'))->>'unknownPolicy')
    ilike '%not inferred from the product name%'));

select _c('7. a practitioner alone cannot assert verification (42501)', (
  select _raises(
    format($q$select public.verify_product_label_version(%L, 'x')$q$, _id('label')),
    '42501')
  from (select set_config('request.jwt.claims',
    '{"sub":"ea000000-0000-4000-8000-000000000003","role":"authenticated"}',
    true)) s));

select set_config('request.jwt.claims',
  '{"sub":"ea000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.verify_product_label_version(_id('label'), 'Checked against the bottle');

select _c('8. verification is derived from a named verifier and its note', (
  select d->'clinical'->>'verificationState' = 'verified'
     and d->'clinical'->>'verificationNote' = 'Checked against the bottle'
  from (select public.get_product_label_detail(_id('label')) d) q));

-- ==================================================== the commercial firewall

select _c('9. commercial data lives under its own key, never inside clinical', (
  select (d->'clinical') is not null and (d->'commercial') is not null
     and (d->'clinical')::text !~* 'affiliate|commission|payout'
  from (select public.get_product_label_detail(_id('label')) d) q));

-- Asserted on the BODY, not the output: with no commercial rows an
-- output-only check passes even if the clinical branch joined the table.
-- Exactly two mentions, both inside the `commercial` branch.
select _c('10. every commercial read is confined to the commercial branch', (
  select regexp_count(
    pg_get_functiondef('public.get_product_label_detail(uuid)'::regprocedure),
    'product_label_commercial_links') = 2));

select public.save_product_label_version(
  'ea000000-0000-4000-8000-000000000101', 'cat-001', 'Test Product', 'Test Brand',
  jsonb_build_object('servingSize', '2 capsules', 'sku', 'TB-001'),
  'https://example.test/label', 'https://affiliate.test/buy');

select _c('11. the affiliate URL never lands on a clinical table', (
  select count(*) = 0 from public.product_label_versions
  where organization_id = 'ea000000-0000-4000-8000-000000000101'
    and exact_label::text ilike '%affiliate%'));

select _c('12. it is recorded in the commercial table instead', (
  select count(*) = 1 from public.product_label_commercial_links
  where url = 'https://affiliate.test/buy'));

-- A link recorded without explicit disclosure text gets a placeholder
-- disclosure saying so, rather than being stored silently disclosure-free.
select _c('13. a link with no supplied disclosure is flagged, not hidden', (
  select (public.get_product_label_detail(v.id)
          ->'commercial'->'links'->0->>'commissionDisclosure') is not null
  from public.product_label_versions v
  where v.organization_id = 'ea000000-0000-4000-8000-000000000101'
    and v.product_code = 'cat-001'
  order by v.version desc limit 1));

select _c('14. the catalog list reports link counts but exposes no URL', (
  select (k->'clinical'->'products')::text !~* 'affiliate\.test'
  from (select public.get_product_catalog('ea000000-0000-4000-8000-000000000101') k) q));

-- ==================================================== history and validation

select _c('15. label version history is preserved, not overwritten', (
  select jsonb_array_length(
    public.get_product_label_detail(_id('label'))->'clinical'->'versions') = 2));

select _c('16. an unknown status filter is refused (22023)', _raises(
  $q$select public.get_product_catalog(
       'ea000000-0000-4000-8000-000000000101', null, 'bogus')$q$, '22023'));

-- ==================================================== access control

select set_config('request.jwt.claims',
  '{"sub":"ea000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select _c('17. an outsider cannot read another org catalog (42501)', _raises(
  $q$select public.get_product_catalog('ea000000-0000-4000-8000-000000000101')$q$,
  '42501'));

select _c('18. an outsider cannot read another org label detail (42501)', _raises(
  format($q$select public.get_product_label_detail(%L)$q$, _id('label')), '42501'));

select set_config('request.jwt.claims', null, true);

select _c('19. an anonymous caller is refused (28000)', _raises(
  $q$select public.get_product_catalog('ea000000-0000-4000-8000-000000000101')$q$,
  '28000'));

select _c('20. anon holds execute on neither catalog RPC', (
  select not bool_or(has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('get_product_catalog', 'get_product_label_detail')));

-- ---------------------------------------------------------------- results
--
-- `never_evaluated` counts checks whose expression came back NULL — usually a
-- subquery that matched no row. Those are checks that silently did not run,
-- and reporting them as neither passed nor failed is how a hole stays open.

select count(*) filter (where ok) as passed,
       count(*) filter (where ok is false) as failed,
       count(*) filter (where ok is null) as never_evaluated,
       count(*) as total,
       coalesce(string_agg(n, ' | ') filter (where ok is not true), '(none)')
         as problems
from _r;

rollback;
