-- Acceptance: clinical production serves no demo catalog content.
--
-- Rolled back at the end; the project is unchanged after the final statement.
--
-- WHY THIS SUITE EXISTS. A Phase-2 seed row, `St. John's Wort Extract (Demo)`,
-- lived in `supplement_products` on the clinical project. Because
-- `search_protocol_catalog` filters on neither status nor provenance, and
-- because it was the only row in the table, it was the ONLY product a
-- practitioner saw when they opened the protocol product picker — selectable,
-- and attachable to a real patient's protocol.
--
-- It was removed by migration `20260801170952`. This suite is what stops it, or
-- anything like it, coming back unnoticed. A migration fixes today; a test
-- fixes every day after.
--
-- WHAT IS DELIBERATELY *NOT* CLAIMED HERE. This suite proves the CATALOG is
-- free of demo content. It does not claim the clinical project is free of
-- synthetic data generally: two organizations named "(Demo)", patient profiles
-- named "Avery Demo" and "Jordan Sample", and two `@brightlongevity.test` seed
-- users are still present from the same Phase-2 seed. Removing organizations,
-- patients and users is destructive and outward-facing, so it is reported for a
-- human decision rather than done quietly here. Asserting their absence would
-- make this suite fail on a fact nobody has decided about yet, which is worse
-- than stating the limit plainly.

begin;

create temp table _r(n text, ok boolean) on commit drop;

create or replace function _c(_n text, _ok boolean) returns void language sql as $fn$
  insert into _r(n, ok) values (_n, _ok);
$fn$;

/**
 * Markers that declare a row synthetic.
 *
 * Matched against name AND description, because the row that started this was
 * marked in both ("… (Demo)" / "Synthetic demo product for interaction
 * fixtures") and a future one might be marked in only one.
 *
 * This is a TEST-side heuristic on purpose. The same pattern as a CHECK
 * constraint would refuse a legitimately-named product in production; as an
 * assertion it costs nothing and a false positive is a human reading one line.
 */
create or replace function _demo_marked(_text text) returns boolean
language sql immutable as $fn$
  select coalesce(_text, '') ~* '\m(demo|sample|fixture|synthetic|placeholder|lorem|dummy)\M';
$fn$;

-- ------------------------------------------------------------ fixtures

insert into auth.users(id, email) values
  ('fb000000-0000-4000-8000-000000000001', 'demo-scan@verify.local');
insert into public.organizations(id, name, slug) values
  ('fb000000-0000-4000-8000-000000000101', 'Scan Org', 'p9b-demo-scan');
insert into public.organization_memberships(organization_id, user_id, role, status)
values ('fb000000-0000-4000-8000-000000000101',
        'fb000000-0000-4000-8000-000000000001', 'owner', 'active');

select set_config('request.jwt.claims',
  '{"sub":"fb000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ============================================ the catalog tables themselves

select _c('1. no supplement product is demo-marked', (
  select count(*) = 0 from public.supplement_products
  where _demo_marked(name) or _demo_marked(description)));

select _c('2. the specific removed demo product is gone', (
  select count(*) = 0 from public.supplement_products
  where id = 'a0000000-0000-4000-8000-000000000083'));

select _c('3. no legacy supplement protocol item is demo-marked', (
  select count(*) = 0 from public.supplement_protocol_items
  where _demo_marked(purpose) or coalesce(source, '') = 'seed'));

select _c('4. no supplement brand is demo-marked', (
  select count(*) = 0 from public.supplement_brands where _demo_marked(name)));

select _c('5. no product label version is demo-marked', (
  select count(*) = 0 from public.product_label_versions
  where _demo_marked(product_name) or _demo_marked(brand)
     or _demo_marked(product_code)));

select _c('6. no supplement ingredient is demo-marked', (
  select count(*) = 0 from public.supplement_ingredients
  where _demo_marked(canonical_name) or _demo_marked(description)));

-- ================================================ what the RPCs actually serve
--
-- Asserted through the RPCs rather than only against the tables: a filter that
-- silently stopped working would leave the tables clean and the picker dirty,
-- which is the direction that reaches a practitioner.

select _c('7. the protocol product picker returns nothing for an empty query', (
  select jsonb_array_length(
    public.search_protocol_catalog('fb000000-0000-4000-8000-000000000101', null, 50)
    ->'products') = 0));

select _c('8. the picker returns nothing demo-marked for any marker term', (
  select bool_and(jsonb_array_length(
    public.search_protocol_catalog('fb000000-0000-4000-8000-000000000101', term, 50)
    ->'products') = 0)
  from unnest(array['demo','sample','fixture','synthetic','wort','test']) term));

select _c('9. the governed product catalog RPC returns no products', (
  select (public.get_product_catalog('fb000000-0000-4000-8000-000000000101')
          ->'clinical'->'counts'->>'total')::int = 0));

select _c('10. the governed catalog serves no demo-marked text at all', (
  select not _demo_marked(
    public.get_product_catalog('fb000000-0000-4000-8000-000000000101')
    ->'clinical'->>'products')));

-- ================================== nothing invented to fill the empty catalog

-- The honest-empty rule, stated as a check: an empty catalog must come back
-- EMPTY. A single placeholder row here would be indistinguishable from a real
-- product at a glance, which is exactly how the removed row caused harm.
select _c('11. an empty catalog yields an empty product list, not a placeholder', (
  select jsonb_array_length(
    public.get_product_catalog('fb000000-0000-4000-8000-000000000101')
    ->'clinical'->'products') = 0));

select _c('12. the empty catalog explains itself rather than looking broken', (
  select length(coalesce(
    public.get_product_catalog('fb000000-0000-4000-8000-000000000101')
    ->>'emptyStateMessage', '')) > 40));

-- ---------------------------------------------------------------- results

select count(*) filter (where ok) as passed,
       count(*) filter (where ok is false) as failed,
       count(*) filter (where ok is null) as never_evaluated,
       count(*) as total,
       coalesce(string_agg(n, ' | ') filter (where ok is not true), '(none)')
         as problems
from _r;

rollback;
