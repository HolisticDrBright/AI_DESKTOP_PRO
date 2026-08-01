-- Remove the synthetic demo product from the clinical catalog.
--
-- WHAT WAS WRONG. A Phase-2 seed row, `St. John's Wort Extract (Demo)`
-- (description: "Synthetic demo product for interaction fixtures"), was sitting
-- in `supplement_products` on the clinical project. `search_protocol_catalog`
-- filters on neither status nor provenance, so with an empty query it returned
-- that row — and, since it was the only product in the table, it was the ONLY
-- thing a practitioner saw when they opened the protocol product picker.
--
-- It was therefore selectable, and selecting it would have attached a synthetic
-- product to a real patient's protocol. St John's Wort is not an innocuous
-- choice of fixture either: it is a CYP3A4 inducer with serotonergic activity
-- and one of the most interaction-prone botanicals in common use, so a
-- synthetic row bearing that name is exactly the row you least want a
-- practitioner to pick by accident.
--
-- WHAT THE GUARD FOUND. The first attempt at this migration refused to run.
-- Reconnaissance had checked three of the seven tables with a foreign key to
-- `supplement_products` and found nothing; the guard checked all seven and
-- found a `supplement_protocol_items` row attaching this product to a patient.
-- That row is itself declared synthetic — `source = 'seed'`, purpose "Demo
-- fixture — interaction caution with sertraline" — and belongs to the same
-- Phase-2 seed family. Writing the guard was worth more than the delete.
--
-- SO THE DELETE IS NARROW AND STILL GUARDED. It removes the product and
-- dependent rows that DECLARE THEMSELVES SEED DATA, and refuses outright if any
-- dependent row does not. Real clinical history is never destroyed to make a
-- cleanup succeed; if something real has come to depend on this row, the right
-- outcome is a human looking at it, not a cascade.

begin;

do $do$
declare
  _id constant uuid := 'a0000000-0000-4000-8000-000000000083';
  _non_seed integer;
  _refs integer;
  _items integer;
  _deleted integer;
begin
  if not exists (select 1 from public.supplement_products where id = _id) then
    raise notice 'demo catalog product already absent; nothing to do';
    return;
  end if;

  -- Dependants that do NOT declare themselves seed data. Any one of these is a
  -- reason to stop.
  select
      (select count(*) from public.supplement_product_versions where product_id = _id)
    + (select count(*) from public.supplement_protocol_items
       where product_id = _id and coalesce(source, '') <> 'seed')
    + (select count(*) from public.supplement_exposures where product_id = _id)
    + (select count(*) from public.protocol_items where catalog_product_id = _id)
    + (select count(*) from public.products_services where catalog_product_id = _id)
    + (select count(*) from public.invoice_line_items where catalog_product_id = _id)
    + (select count(*) from public.catalog_product_notes where product_id = _id)
  into _non_seed;

  if _non_seed > 0 then
    raise exception
      'the demo catalog product has % dependent row(s) that are not marked as '
      'seed data. Refusing to delete: cascading that away could destroy a real '
      'record. Investigate the references before removing the product.',
      _non_seed
      using errcode = '55000';
  end if;

  delete from public.supplement_protocol_items
  where product_id = _id and source = 'seed';
  get diagnostics _items = row_count;

  -- Re-check across every foreign key before the final delete, so a reference
  -- created between the check above and here cannot slip through.
  select
      (select count(*) from public.supplement_product_versions where product_id = _id)
    + (select count(*) from public.supplement_protocol_items where product_id = _id)
    + (select count(*) from public.supplement_exposures where product_id = _id)
    + (select count(*) from public.protocol_items where catalog_product_id = _id)
    + (select count(*) from public.products_services where catalog_product_id = _id)
    + (select count(*) from public.invoice_line_items where catalog_product_id = _id)
    + (select count(*) from public.catalog_product_notes where product_id = _id)
  into _refs;

  if _refs > 0 then
    raise exception 'the demo catalog product still has % dependent row(s)', _refs
      using errcode = '55000';
  end if;

  delete from public.supplement_products where id = _id;
  get diagnostics _deleted = row_count;
  raise notice
    'removed % demo catalog product row(s) and % seed protocol item(s)',
    _deleted, _items;
end
$do$;

-- No runtime constraint is added to keep demo rows out.
--
-- A CHECK on the name would be a heuristic in a clinical table — it would
-- refuse a legitimate product whose name happened to contain "sample" or
-- "test", and it would miss synthetic data that simply did not say so. The
-- guarantee is enforced where it can be stated exactly instead: the acceptance
-- suite `supabase/tests/desktop_no_demo_catalog_content.sql` asserts that no
-- clinical catalog table carries demo-marked content and that the protocol
-- picker returns none, and it fails loudly if anyone re-seeds.

commit;
