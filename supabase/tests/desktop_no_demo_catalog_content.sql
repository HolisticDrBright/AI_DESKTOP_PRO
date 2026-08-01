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
-- THE RETAINED STAGING SEED, AND WHY IT IS NOT A FAILURE HERE.
--
-- `urcjiehlxoehievobezf` is formally designated a SYNTHETIC STAGING project and
-- must never become the production project. Two organizations named "(Demo)",
-- the patient profiles "Avery Demo" and "Jordan Sample", and two
-- `@brightlongevity.test` auth users are RETAINED BY DECISION as that project's
-- staging fixture. They are not a defect and this suite does not assert their
-- absence.
--
-- What the suite does assert is the boundary that actually matters: none of
-- that seed reaches the CLINICAL CATALOG. A synthetic patient in a staging
-- project is a test fixture; a synthetic product in the protocol picker is a
-- clinical recommendation nobody made, which is what checks 1-15 below exist to
-- prevent.
--
-- Production is a DIFFERENT, EMPTY Supabase project: schema migrations only,
-- with no seed import. See `docs/deployment-verification.md`.

begin;

create temp table _r(n text, ok boolean) on commit drop;

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

-- ==================================================== not merely invisible
--
-- The three axes are different claims, and only the third is conclusive. A row
-- can be absent from search and still be ATTACHABLE by id, which is how a
-- "hidden" record keeps reaching patients. Proved by trying it.

insert into public.patient_profiles(id, organization_id, first_name, last_name)
values ('fb000000-0000-4000-8000-000000000201',
        'fb000000-0000-4000-8000-000000000101', 'Scan', 'Patient');
insert into public.practitioner_patient_relationships
  (organization_id, practitioner_user_id, patient_id, status)
values ('fb000000-0000-4000-8000-000000000101',
        'fb000000-0000-4000-8000-000000000001',
        'fb000000-0000-4000-8000-000000000201', 'active');

select _c('13. the removed product cannot be ATTACHED to a draft by id (P0002)', (
  select _raises(format($q$select public.save_protocol_draft(%L, %L::jsonb)$q$,
    (public.create_protocol_draft('fb000000-0000-4000-8000-000000000101',
      'fb000000-0000-4000-8000-000000000201', 'Attach probe', null)->>'versionId')::uuid,
    jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
      'kind', 'product', 'label', 'Attach probe',
      'catalogProductId', 'a0000000-0000-4000-8000-000000000083')))::text),
    'P0002')));

select _c('14. no seed-derived legacy protocol item survives', (
  select count(*) = 0 from public.supplement_protocol_items where source = 'seed'));

-- The retained staging seed is INTACT. Asserted, not assumed: a later cleanup
-- that quietly deleted it would be a decision reversed without anyone saying so.
select _c('15. the retained staging seed is untouched', (
  select (select count(*) from public.organizations where name ilike '%(Demo)%') = 2
     and (select count(*) from auth.users
          where email like '%@brightlongevity.test') = 2));

-- ---------------------------------------------------------------- results

select count(*) filter (where ok) as passed,
       count(*) filter (where ok is false) as failed,
       count(*) filter (where ok is null) as never_evaluated,
       count(*) as total,
       coalesce(string_agg(n, ' | ') filter (where ok is not true), '(none)')
         as problems
from _r;

rollback;
