-- Billing, checkout, catalog & inventory acceptance tests (Phase 8A).
-- Rolled back: the project is unchanged after the final statement.
--
-- Covers: anonymous/staff-role/cross-tenant refusal · exact grants (22
-- authenticated RPCs, 2 service_role-only processor RPCs) · definer posture
-- with pinned search_path · RLS + no direct writes · catalog validation,
-- optimistic versions, cross-org reference refusal · archived products
-- refused on new invoices · inventory receive/adjust/return with an
-- append-only ledger · oversell → 40001, never a silent negative ·
-- low-stock watchdog opens ONE review task · checkout: appointment auto-
-- line, server-computed tax (never client-supplied), discounts require a
-- reason · one live invoice per appointment · finalize reserves tracked
-- stock · finalized invoices and their lines are immutable (trigger-level) ·
-- draft-only editing · manual payments: balance-capped, idempotency replay
-- → 40001, full settlement commits the sale EXACTLY once · refunds never
-- restock; return_inventory_stock is the explicit restock path · patient
-- credit grant/apply with balance enforcement · void releases reservations,
-- paid invoices cannot void · card payments: pending row, single in-flight,
-- processor ref attach-once · webhook: durable dedup, amount/currency
-- agreement, out-of-order recorded, exactly-once settlement · workspace &
-- patient-ledger projections add up · payments/refunds/credit entries/
-- events append-only · audit trail written · no clinical side effects ·
-- zero residue.
--
-- Last full run against urcjiehlxoehievobezf: 96/96 green.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v text) on commit drop;
create temp table _base(k text primary key, v bigint) on commit drop;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000001001','bl-practitioner@verify.local'),
  ('11111111-0000-0000-0000-000000001002','bl-staff@verify.local'),
  ('11111111-0000-0000-0000-000000001003','bl-outsider@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000001001','Billing Org','billing-0100'),
  ('bbbbbbbb-0000-0000-0000-000000001002','Billing Other','billing-other-0100');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000001001','11111111-0000-0000-0000-000000001001','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000001001','11111111-0000-0000-0000-000000001002','staff','active'),
  ('bbbbbbbb-0000-0000-0000-000000001002','11111111-0000-0000-0000-000000001003','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000001001','bbbbbbbb-0000-0000-0000-000000001001','Billing','Patient'),
  ('cccccccc-0000-0000-0000-000000001002','bbbbbbbb-0000-0000-0000-000000001002','Foreign','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000001001','11111111-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001','active'),
  ('bbbbbbbb-0000-0000-0000-000000001001','11111111-0000-0000-0000-000000001002','cccccccc-0000-0000-0000-000000001001','active'),
  ('bbbbbbbb-0000-0000-0000-000000001002','11111111-0000-0000-0000-000000001003','cccccccc-0000-0000-0000-000000001002','active');
insert into public.appointments(id,organization_id,patient_id,title,appointment_type,status,starts_at,ends_at,version) values
  ('dddddddd-0000-0000-0000-000000001001','bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001','Follow-up visit','follow-up','scheduled',now()+interval '1 day',now()+interval '1 day 30 minutes',1);
-- A product owned by the OTHER org, for cross-tenant line refusal.
insert into public.products_services(id,organization_id,name,kind,amount_minor,currency) values
  ('dddddddd-0000-0000-0000-000000001099','bbbbbbbb-0000-0000-0000-000000001002','Foreign Service','service',1000,'USD');

insert into _base
select 'notes', count(*) from public.clinical_notes
union all select 'messages', count(*) from public.messages
union all select 'protocols', count(*) from public.protocols
union all select 'appointments', count(*) from public.appointments
union all select 'enrollments', count(*) from public.program_enrollments
union all select 'conversations', count(*) from public.conversations;

-- ------------------------------------------------------- static posture
insert into _v
select 'anon cannot execute any billing RPC',
  not bool_or(has_function_privilege('anon', p.oid, 'execute')), null
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('upsert_billing_location','upsert_supplier','upsert_tax_rate',
     'upsert_billing_product','archive_billing_product','list_billing_catalog',
     'receive_inventory_stock','adjust_inventory_stock','return_inventory_stock',
     'get_inventory_history','create_invoice_draft','save_invoice_draft',
     'finalize_invoice','void_invoice','record_manual_payment',
     'grant_patient_credit','apply_patient_credit','refund_payment',
     'start_card_payment','get_billing_invoice','get_patient_billing',
     'get_billing_workspace','attach_payment_processor_ref','record_billing_webhook');
insert into _v
select 'processor-boundary billing RPCs are service_role only',
  not bool_or(has_function_privilege('authenticated', p.oid, 'execute'))
  and bool_and(has_function_privilege('service_role', p.oid, 'execute')), null
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('attach_payment_processor_ref','record_billing_webhook');
insert into _v
select 'all billing RPCs are definer with a pinned empty search_path',
  count(*) >= 24 and bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)), null
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('upsert_billing_location','upsert_supplier','upsert_tax_rate',
     'upsert_billing_product','archive_billing_product','list_billing_catalog',
     'receive_inventory_stock','adjust_inventory_stock','return_inventory_stock',
     'get_inventory_history','create_invoice_draft','save_invoice_draft',
     'finalize_invoice','void_invoice','record_manual_payment',
     'grant_patient_credit','apply_patient_credit','refund_payment',
     'start_card_payment','get_billing_invoice','get_patient_billing',
     'get_billing_workspace','attach_payment_processor_ref','record_billing_webhook');
insert into _v
select 'billing tables have RLS and no direct authenticated writes',
  bool_and(c.relrowsecurity)
  and not bool_or(has_table_privilege('authenticated', c.oid, 'insert'))
  and not bool_or(has_table_privilege('authenticated', c.oid, 'update'))
  and not bool_or(has_table_privilege('authenticated', c.oid, 'delete')), null
  from pg_class c where c.oid in (
    'public.suppliers'::regclass,'public.locations'::regclass,
    'public.tax_rates'::regclass,'public.product_commercial_links'::regclass,
    'public.inventory_stock'::regclass,'public.inventory_ledger'::regclass,
    'public.invoices'::regclass,'public.invoice_line_items'::regclass,
    'public.invoice_events'::regclass,'public.payments'::regclass,
    'public.payment_events'::regclass,'public.refunds'::regclass,
    'public.patient_credit_entries'::regclass,'public.billing_webhook_events'::regclass,
    'public.products_services'::regclass);
insert into _v
select 'billing guard trigger functions are not client-executable',
  not bool_or(has_function_privilege('anon', p.oid, 'execute'))
  and not bool_or(has_function_privilege('authenticated', p.oid, 'execute')), null
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname in
    ('inventory_ledger_immutable','invoices_protect_finalized',
     'invoice_lines_protect_finalized','invoice_events_immutable','payments_protect');

-- ------------------------------------------------ identity & role gates
select set_config('request.jwt.claims', '', true);
do $$ begin
  perform public.get_billing_workspace('bbbbbbbb-0000-0000-0000-000000001001');
  insert into _v values('anonymous workspace read is refused', false, 'no error');
exception when others then
  insert into _v values('anonymous workspace read is refused', sqlstate='28000', sqlstate);
end $$;
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000001003","role":"authenticated"}', true);
do $$ begin
  perform public.get_billing_workspace('bbbbbbbb-0000-0000-0000-000000001001');
  insert into _v values('cross-tenant workspace read is refused', false, 'no error');
exception when others then
  insert into _v values('cross-tenant workspace read is refused', sqlstate='42501', sqlstate);
end $$;
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000001002","role":"authenticated"}', true);
do $$ begin
  perform public.upsert_billing_product(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001',
    _name => 'Staff Product', _kind => 'product', _amount_minor => 100);
  insert into _v values('staff (non-financial role) cannot write the catalog', false, 'no error');
exception when others then
  insert into _v values('staff (non-financial role) cannot write the catalog', sqlstate='42501', sqlstate);
end $$;
do $$
declare _w jsonb;
begin
  _w := public.get_billing_workspace('bbbbbbbb-0000-0000-0000-000000001001');
  insert into _v values('staff CAN read the billing workspace',
    _w ? 'summary' and _w ? 'aging' and _w ? 'reconciliation', null);
end $$;

-- -------------------------------------------------- catalog & validation
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000001001","role":"authenticated"}', true);
do $$
declare _r jsonb;
begin
  _r := public.upsert_billing_location(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001', _name => 'Main Clinic');
  insert into _ids values('loc', _r->>'id');
  _r := public.upsert_supplier(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001', _name => 'NutriSupply');
  insert into _ids values('sup', _r->>'id');
  _r := public.upsert_tax_rate(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001',
    _name => 'Sales Tax', _rate_bps => 800);
  insert into _ids values('tax', _r->>'id');
  insert into _v values('location, supplier, and tax rate are created', true, null);
end $$;
do $$ begin
  perform public.upsert_tax_rate(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001', _name => 'Broken');
  insert into _v values('a tax rate without a bps rate is refused', false, 'no error');
exception when others then
  insert into _v values('a tax rate without a bps rate is refused', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.upsert_billing_product(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001',
    _name => 'Mystery', _kind => 'mystery', _amount_minor => 100);
  insert into _v values('an unknown product kind is refused', false, 'no error');
exception when others then
  insert into _v values('an unknown product kind is refused', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.upsert_billing_product(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001',
    _name => 'Negative', _kind => 'product', _amount_minor => -5);
  insert into _v values('a negative retail price is refused', false, 'no error');
exception when others then
  insert into _v values('a negative retail price is refused', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.upsert_billing_product(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001',
    _name => 'Follow-Up', _kind => 'service', _amount_minor => 15000,
    _tax_rate_id => (select v from _ids where k='tax')::uuid);
  insert into _ids values('svc', _r->>'id');
  _r := public.upsert_billing_product(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001',
    _name => 'Omega-3 Fish Oil', _kind => 'supplement', _amount_minor => 2500,
    _sku => 'OM3-90', _cost_minor => 1200,
    _supplier_id => (select v from _ids where k='sup')::uuid,
    _track_inventory => true, _reorder_threshold => 2);
  insert into _ids values('omega', _r->>'id');
  insert into _v values('service and tracked product join the catalog',
    (_r->>'version')::int = 1, null);
end $$;
do $$ begin
  perform public.upsert_billing_product(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001',
    _id => (select v from _ids where k='omega')::uuid,
    _expected_version => 99, _name => 'Renamed');
  insert into _v values('a stale product version is a typed conflict', false, 'no error');
exception when others then
  insert into _v values('a stale product version is a typed conflict', sqlstate='40001', sqlstate);
end $$;
do $$ begin
  perform public.upsert_billing_product(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001',
    _name => 'Wrong Supplier', _kind => 'product', _amount_minor => 100,
    _supplier_id => gen_random_uuid());
  insert into _v values('a foreign/unknown supplier reference is refused', false, 'no error');
exception when others then
  insert into _v values('a foreign/unknown supplier reference is refused', sqlstate='42501', sqlstate);
end $$;
do $$
declare _r jsonb; _c jsonb;
begin
  _r := public.upsert_billing_product(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001',
    _name => 'Legacy Cream', _kind => 'product', _amount_minor => 900);
  insert into _ids values('legacy', _r->>'id');
  perform public.archive_billing_product(
    'bbbbbbbb-0000-0000-0000-000000001001', (_r->>'id')::uuid, 1);
  _c := public.list_billing_catalog(_organization_id => 'bbbbbbbb-0000-0000-0000-000000001001');
  insert into _v values('archiving hides a product from the default catalog but keeps history',
    (select archived_at is not null from public.products_services where id=(_r->>'id')::uuid)
    and not exists (select 1 from jsonb_array_elements(_c->'products') p
                    where p->>'id' = _r->>'id'), null);
  _c := public.list_billing_catalog(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001', _include_archived => true);
  insert into _v values('the archived product is still listable on request',
    exists (select 1 from jsonb_array_elements(_c->'products') p
            where p->>'id' = _r->>'id'), null);
end $$;
do $$
declare _c jsonb;
begin
  _c := public.list_billing_catalog(
    _organization_id => 'bbbbbbbb-0000-0000-0000-000000001001', _query => 'OM3-90');
  insert into _v values('catalog search finds a product by SKU with stock and tax fields',
    jsonb_array_length(_c->'products') = 1
    and (_c->'products'->0->>'trackInventory')::boolean
    and (_c->'products'->0->>'reorderThreshold')::int = 2
    and jsonb_array_length(_c->'taxRates') = 1
    and jsonb_array_length(_c->'locations') = 1
    and jsonb_array_length(_c->'suppliers') = 1, null);
end $$;

-- ------------------------------------------------------------ inventory
do $$ begin
  perform public.receive_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, 0);
  insert into _v values('receiving zero or negative stock is refused', false, 'no error');
exception when others then
  insert into _v values('receiving zero or negative stock is refused', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.receive_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='svc')::uuid, 5);
  insert into _v values('receiving stock for a non-tracked service is refused', false, 'no error');
exception when others then
  insert into _v values('receiving stock for a non-tracked service is refused', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.receive_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001', gen_random_uuid(),
    (select v from _ids where k='omega')::uuid, 5);
  insert into _v values('receiving into an unknown location is refused', false, 'no error');
exception when others then
  insert into _v values('receiving into an unknown location is refused', sqlstate='P0002', sqlstate);
end $$;
do $$
begin
  perform public.receive_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, 10, 1200,
    (select v from _ids where k='sup')::uuid, 'PO-100');
  insert into _v values('a stock receipt lands in on_hand and the ledger',
    (select on_hand = 10 and reserved = 0 and reorder_threshold = 2 from public.inventory_stock
     where product_id = (select v from _ids where k='omega')::uuid)
    and (select count(*) = 1 from public.inventory_ledger
         where product_id = (select v from _ids where k='omega')::uuid
           and kind = 'receipt' and on_hand_delta = 10 and unit_cost_minor = 1200), null);
end $$;
do $$ begin
  perform public.adjust_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, -2, 'damaged', null);
  insert into _v values('an inventory adjustment without a reason is refused', false, 'no error');
exception when others then
  insert into _v values('an inventory adjustment without a reason is refused', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.adjust_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, 2, 'damaged', 'oops');
  insert into _v values('damaged/expired adjustments can only remove stock', false, 'no error');
exception when others then
  insert into _v values('damaged/expired adjustments can only remove stock', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.adjust_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, -2, 'damaged', 'dropped case');
  insert into _v values('a damaged write-off reduces on_hand with a ledgered reason',
    (select on_hand = 8 from public.inventory_stock
     where product_id = (select v from _ids where k='omega')::uuid), null);
end $$;
do $$ begin
  perform public.adjust_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, -100, 'adjustment', 'typo');
  insert into _v values('an adjustment below zero stock is a typed conflict, never negative', false, 'no error');
exception when others then
  insert into _v values('an adjustment below zero stock is a typed conflict, never negative',
    sqlstate='40001' and (select on_hand = 8 from public.inventory_stock
      where product_id = (select v from _ids where k='omega')::uuid), sqlstate);
end $$;
do $$
begin
  update public.inventory_ledger set reason = 'edited'
  where product_id = (select v from _ids where k='omega')::uuid and kind = 'receipt';
  insert into _v values('the inventory ledger is append-only (trigger-level)', false, 'no error');
exception when others then
  insert into _v values('the inventory ledger is append-only (trigger-level)', sqlstate='42501', sqlstate);
end $$;

-- --------------------------------------------------- checkout: invoice A
do $$
declare _r jsonb;
begin
  _r := public.create_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001',
    'dddddddd-0000-0000-0000-000000001001',(select v from _ids where k='loc')::uuid);
  insert into _ids values('invA', _r->>'id'), ('invA_v', _r->>'version');
  insert into _v values('an appointment checkout draft auto-adds the matching booked service',
    _r->>'status' = 'draft'
    and jsonb_array_length(_r->'lines') = 1
    and _r->'lines'->0->>'name' = 'Follow-Up'
    and (_r->'lines'->0->>'taxRateBps')::int = 800
    and (_r->>'subtotalMinor')::bigint = 15000
    and (_r->>'taxMinor')::bigint = 1200
    and (_r->>'totalMinor')::bigint = 16200
    and (_r->>'patientName') = 'Billing Patient', null);
end $$;
do $$ begin
  perform public.create_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001',
    'dddddddd-0000-0000-0000-000000001001');
  insert into _v values('one live invoice per appointment is enforced', false, 'no error');
exception when others then
  insert into _v values('one live invoice per appointment is enforced', sqlstate='40001', sqlstate);
end $$;
do $$ begin
  perform public.create_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001002');
  insert into _v values('a draft for an inaccessible patient is refused', false, 'no error');
exception when others then
  insert into _v values('a draft for an inaccessible patient is refused', sqlstate='42501', sqlstate);
end $$;
do $$ begin
  perform public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid, 99,
    null, jsonb_build_array(jsonb_build_object('productId', (select v from _ids where k='svc'))));
  insert into _v values('a stale invoice version is a typed conflict', false, 'no error');
exception when others then
  insert into _v values('a stale invoice version is a typed conflict', sqlstate='40001', sqlstate);
end $$;
do $$ begin
  perform public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int,
    null, jsonb_build_array(jsonb_build_object('productId','dddddddd-0000-0000-0000-000000001099')));
  insert into _v values('a line referencing another org''s product is refused', false, 'no error');
exception when others then
  insert into _v values('a line referencing another org''s product is refused', sqlstate='42501', sqlstate);
end $$;
do $$ begin
  perform public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int,
    null, jsonb_build_array(jsonb_build_object('productId',(select v from _ids where k='legacy'))));
  insert into _v values('an archived product cannot join a new invoice', false, 'no error');
exception when others then
  insert into _v values('an archived product cannot join a new invoice', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int,
    null, jsonb_build_array(jsonb_build_object(
      'productId',(select v from _ids where k='omega'),'quantity',1,'discountMinor',100)));
  insert into _v values('a discount without a reason is refused', false, 'no error');
exception when others then
  insert into _v values('a discount without a reason is refused', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int,
    null, jsonb_build_array(jsonb_build_object(
      'productId',(select v from _ids where k='omega'),'quantity',1,
      'discountMinor',999999,'discountReason','too big')));
  insert into _v values('a discount larger than the line is refused', false, 'no error');
exception when others then
  insert into _v values('a discount larger than the line is refused', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int,
    (select v from _ids where k='loc')::uuid,
    jsonb_build_array(
      jsonb_build_object('productId',(select v from _ids where k='svc'),'quantity',1,
        'taxMinor', 0),
      jsonb_build_object('productId',(select v from _ids where k='omega'),'quantity',2,
        'discountMinor',500,'discountReason','loyalty')));
  update _ids set v = _r->>'version' where k='invA_v';
  insert into _v values('tax is computed ONLY from configured rates — a client tax claim is ignored',
    (_r->>'subtotalMinor')::bigint = 20000
    and (_r->>'discountMinor')::bigint = 500
    and (_r->>'taxMinor')::bigint = 1200
    and (_r->>'totalMinor')::bigint = 20700
    and (select count(*) from jsonb_array_elements(_r->'lines') l
         where (l->>'taxMinor')::bigint <> 0) = 1, null);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.finalize_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int);
  update _ids set v = _r->>'version' where k='invA_v';
  insert into _v values('finalize opens the invoice, assigns INV-00001, and reserves tracked stock',
    _r->>'status' = 'open' and _r->>'number' = 'INV-00001'
    and (select reserved = 2 and on_hand = 8 from public.inventory_stock
         where product_id = (select v from _ids where k='omega')::uuid)
    and (select inventory_reserved_at is not null from public.invoices
         where id = (select v from _ids where k='invA')::uuid), null);
end $$;
do $$ begin
  perform public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int,
    null, '[]'::jsonb);
  insert into _v values('an open invoice can no longer be edited', false, 'no error');
exception when others then
  insert into _v values('an open invoice can no longer be edited', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  update public.invoices set subtotal_minor = 1
  where id = (select v from _ids where k='invA')::uuid;
  insert into _v values('a finalized invoice''s money is immutable (trigger-level)', false, 'no error');
exception when others then
  insert into _v values('a finalized invoice''s money is immutable (trigger-level)', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  insert into public.invoice_line_items
    (organization_id, patient_id, invoice_id, quantity, unit_amount_minor, amount_minor, currency)
  values ('bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid, 1, 1, 1, 'USD');
  insert into _v values('lines of a finalized invoice are immutable (trigger-level)', false, 'no error');
exception when others then
  insert into _v values('lines of a finalized invoice are immutable (trigger-level)', sqlstate='42501', sqlstate);
end $$;

-- ------------------------------------------------------ manual payments
do $$ begin
  perform public.record_manual_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int, 10000, 'card');
  insert into _v values('manual payments accept only manual methods', false, 'no error');
exception when others then
  insert into _v values('manual payments accept only manual methods', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.record_manual_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int, 999999, 'cash');
  insert into _v values('a payment above the outstanding balance is refused', false, 'no error');
exception when others then
  insert into _v values('a payment above the outstanding balance is refused', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.record_manual_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int, 10000, 'cash', 'drawer 1', 'pay-a-1');
  update _ids set v = _r->>'version' where k='invA_v';
  insert into _v values('a partial cash payment moves the invoice to partially_paid',
    _r->>'status' = 'partially_paid' and (_r->>'paidMinor')::bigint = 10000
    and (_r->>'balanceMinor')::bigint = 10700, null);
end $$;
do $$ begin
  perform public.record_manual_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int, 10700, 'cash', null, 'pay-a-1');
  insert into _v values('an idempotency-key replay is a typed conflict, not a double charge', false, 'no error');
exception when others then
  insert into _v values('an idempotency-key replay is a typed conflict, not a double charge',
    sqlstate='40001'
    and (select count(*) = 1 from public.payments
         where invoice_id = (select v from _ids where k='invA')::uuid), sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.record_manual_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int, 10700, 'cash', null, 'pay-a-2');
  update _ids set v = _r->>'version' where k='invA_v';
  insert into _ids values('payA1',
    (select id::text from public.payments
     where invoice_id = (select v from _ids where k='invA')::uuid
       and idempotency_key = 'pay-a-1'));
  insert into _v values('full settlement marks the invoice paid and commits the sale EXACTLY once',
    _r->>'status' = 'paid'
    and (select on_hand = 6 and reserved = 0 from public.inventory_stock
         where product_id = (select v from _ids where k='omega')::uuid)
    and (select inventory_committed_at is not null from public.invoices
         where id = (select v from _ids where k='invA')::uuid)
    and (select count(*) = 1 from public.inventory_ledger
         where product_id = (select v from _ids where k='omega')::uuid and kind = 'sale'), null);
end $$;
do $$ begin
  perform public.record_manual_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int, 100, 'cash');
  insert into _v values('a paid invoice accepts no further payments', false, 'no error');
exception when others then
  insert into _v values('a paid invoice accepts no further payments', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  update public.payments set amount_minor = 1
  where id = (select v from _ids where k='payA1')::uuid;
  insert into _v values('a payment''s financial identity is immutable (trigger-level)', false, 'no error');
exception when others then
  insert into _v values('a payment''s financial identity is immutable (trigger-level)', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  delete from public.payments where id = (select v from _ids where k='payA1')::uuid;
  insert into _v values('payments are never deleted (trigger-level)', false, 'no error');
exception when others then
  insert into _v values('payments are never deleted (trigger-level)', sqlstate='42501', sqlstate);
end $$;

-- ------------------------------------------------- refunds & returns
do $$ begin
  perform public.refund_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='payA1')::uuid, 5000, null);
  insert into _v values('a refund without a reason is refused', false, 'no error');
exception when others then
  insert into _v values('a refund without a reason is refused', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.refund_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='payA1')::uuid, 5000, 'patient returned product');
  update _ids set v = _r->>'version' where k='invA_v';
  insert into _v values('a refund NEVER restocks automatically',
    _r->>'status' = 'partially_refunded' and (_r->>'refundedMinor')::bigint = 5000
    and (select on_hand = 6 from public.inventory_stock
         where product_id = (select v from _ids where k='omega')::uuid), null);
end $$;
do $$ begin
  perform public.refund_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='payA1')::uuid, 999999, 'too much');
  insert into _v values('refunds cannot exceed the original payment', false, 'no error');
exception when others then
  insert into _v values('refunds cannot exceed the original payment', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  update public.refunds set amount_minor = 1
  where payment_id = (select v from _ids where k='payA1')::uuid;
  insert into _v values('refunds are append-only (trigger-level)', false, 'no error');
exception when others then
  insert into _v values('refunds are append-only (trigger-level)', sqlstate='42501', sqlstate);
end $$;
do $$ begin
  perform public.return_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, 1, 'pristine', 'wrong condition');
  insert into _v values('a return requires an explicit resalable/damaged condition', false, 'no error');
exception when others then
  insert into _v values('a return requires an explicit resalable/damaged condition', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  perform public.return_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, 1, 'resalable', 'unopened return',
    (select v from _ids where k='invA')::uuid);
  insert into _v values('an explicit RESALABLE return restocks with reason + condition ledgered',
    (select on_hand = 7 from public.inventory_stock
     where product_id = (select v from _ids where k='omega')::uuid)
    and (select count(*) = 1 from public.inventory_ledger
         where product_id = (select v from _ids where k='omega')::uuid
           and kind = 'return' and condition = 'resalable'), null);
end $$;
do $$
begin
  perform public.return_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, 1, 'damaged', 'opened, unusable',
    (select v from _ids where k='invA')::uuid);
  insert into _v values('a DAMAGED return is recorded without adding sellable stock',
    (select on_hand = 7 from public.inventory_stock
     where product_id = (select v from _ids where k='omega')::uuid)
    and (select count(*) = 1 from public.inventory_ledger
         where product_id = (select v from _ids where k='omega')::uuid
           and kind = 'return' and condition = 'damaged'), null);
end $$;

-- ------------------------------------------- credit + card/webhook: B
do $$
declare _r jsonb;
begin
  _r := public.create_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001');
  insert into _ids values('invB', _r->>'id'), ('invB_v', _r->>'version');
end $$;
do $$ begin
  perform public.finalize_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invB')::uuid,
    (select v from _ids where k='invB_v')::int);
  insert into _v values('an empty invoice cannot be finalized', false, 'no error');
exception when others then
  insert into _v values('an empty invoice cannot be finalized', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invB')::uuid,
    (select v from _ids where k='invB_v')::int,
    null, jsonb_build_array(jsonb_build_object(
      'productId',(select v from _ids where k='svc'),'quantity',1)));
  update _ids set v = _r->>'version' where k='invB_v';
  _r := public.finalize_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invB')::uuid,
    (select v from _ids where k='invB_v')::int);
  update _ids set v = _r->>'version' where k='invB_v';
  insert into _v values('invoice numbering is sequential per organization',
    _r->>'number' = 'INV-00002' and (_r->>'totalMinor')::bigint = 16200, null);
end $$;
do $$ begin
  perform public.grant_patient_credit(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001', 5000, null);
  insert into _v values('granting credit requires a reason', false, 'no error');
exception when others then
  insert into _v values('granting credit requires a reason', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.grant_patient_credit(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001002', 5000, 'goodwill');
  insert into _v values('credit cannot be granted to an inaccessible patient', false, 'no error');
exception when others then
  insert into _v values('credit cannot be granted to an inaccessible patient', sqlstate='42501', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.grant_patient_credit(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001', 5000, 'service recovery');
  insert into _v values('granted credit shows in the patient balance',
    (_r->>'balanceMinor')::bigint = 5000, null);
  _r := public.apply_patient_credit(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invB')::uuid,
    (select v from _ids where k='invB_v')::int, 5000);
  update _ids set v = _r->>'version' where k='invB_v';
  insert into _v values('applied credit reduces the balance and part-settles the invoice',
    _r->>'status' = 'partially_paid'
    and (_r->>'creditAppliedMinor')::bigint = 5000
    and (_r->>'balanceMinor')::bigint = 11200, null);
end $$;
do $$ begin
  perform public.apply_patient_credit(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invB')::uuid,
    (select v from _ids where k='invB_v')::int, 1);
  insert into _v values('credit beyond the patient''s balance is refused', false, 'no error');
exception when others then
  insert into _v values('credit beyond the patient''s balance is refused', sqlstate='22023', sqlstate);
end $$;
do $$
begin
  update public.patient_credit_entries set amount_minor = 1
  where patient_id = 'cccccccc-0000-0000-0000-000000001001';
  insert into _v values('credit entries are append-only (trigger-level)', false, 'no error');
exception when others then
  insert into _v values('credit entries are append-only (trigger-level)', sqlstate='42501', sqlstate);
end $$;
do $$ begin
  perform public.start_card_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invB')::uuid,
    (select v from _ids where k='invB_v')::int, '');
  insert into _v values('a card payment without an idempotency key is refused', false, 'no error');
exception when others then
  insert into _v values('a card payment without an idempotency key is refused', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.start_card_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invB')::uuid,
    (select v from _ids where k='invB_v')::int, 'idem-b-1');
  insert into _ids values('payB', _r->>'paymentId');
  insert into _v values('starting a card payment creates a PENDING test-mode row for the balance',
    (_r->>'amountMinor')::bigint = 11200
    and (select status = 'pending' and method = 'card_test' and environment = 'test'
           and processor = 'stripe_test'
         from public.payments where id = (_r->>'paymentId')::uuid), null);
end $$;
do $$ begin
  perform public.start_card_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invB')::uuid,
    (select v from _ids where k='invB_v')::int, 'idem-b-2');
  insert into _v values('a second in-flight card payment is refused', false, 'no error');
exception when others then
  insert into _v values('a second in-flight card payment is refused', sqlstate='40001', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.attach_payment_processor_ref((select v from _ids where k='payB')::uuid, 'pi_test_b');
  insert into _v values('the processor boundary attaches the intent reference',
    (_r->>'ok')::boolean, null);
end $$;
do $$ begin
  perform public.attach_payment_processor_ref((select v from _ids where k='payB')::uuid, 'pi_other');
  insert into _v values('a different processor reference cannot replace the attached one', false, 'no error');
exception when others then
  insert into _v values('a different processor reference cannot replace the attached one', sqlstate='40001', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.record_billing_webhook('evt-b-1','payment_intent.succeeded','pi_test_b',11200,'USD');
  insert into _v values('a succeeded webhook settles the invoice exactly once',
    _r->>'outcome' = 'processed'
    and (select status = 'succeeded' and paid_at is not null
         from public.payments where id = (select v from _ids where k='payB')::uuid)
    and (select status = 'paid' and inventory_committed_at is not null
         from public.invoices where id = (select v from _ids where k='invB')::uuid), null);
  _r := public.record_billing_webhook('evt-b-1','payment_intent.succeeded','pi_test_b',11200,'USD');
  insert into _v values('a replayed webhook event id is answered as duplicate and never re-applied',
    _r->>'outcome' = 'duplicate', null);
  _r := public.record_billing_webhook('evt-b-2','payment_intent.succeeded','pi_test_b',99,'USD');
  insert into _v values('an amount-mismatched webhook is REFUSED and recorded',
    _r->>'outcome' = 'refused'
    and (select outcome = 'refused' and detail_safe = 'amount mismatch'
         from public.billing_webhook_events where event_id = 'evt-b-2'), null);
  _r := public.record_billing_webhook('evt-b-3','payment_intent.payment_failed','pi_test_b',11200,'USD');
  insert into _v values('an out-of-order failure after success is recorded, not applied',
    _r->>'outcome' = 'out_of_order'
    and (select status = 'succeeded' from public.payments
         where id = (select v from _ids where k='payB')::uuid), null);
  _r := public.record_billing_webhook('evt-b-4','charge.refunded','pi_test_b',11200,'USD');
  insert into _v values('a processor refund webhook records the refund and settles the ledger',
    _r->>'outcome' = 'processed'
    and (select count(*) = 1 from public.refunds
         where payment_id = (select v from _ids where k='payB')::uuid)
    and (select status = 'refunded' from public.invoices
         where id = (select v from _ids where k='invB')::uuid), null);
  _r := public.record_billing_webhook('evt-b-5','totally.unknown','pi_test_b',null,null);
  insert into _v values('an unknown webhook event type is recorded as ignored',
    _r->>'outcome' = 'ignored', null);
  _r := public.record_billing_webhook('evt-b-6','payment_intent.succeeded','pi_nobody',null,null);
  insert into _v values('a webhook with no matching payment is recorded as ignored',
    _r->>'outcome' = 'ignored', null);
end $$;
do $$ begin
  perform public.refund_payment(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='payB')::uuid, 100, 'card refund attempt');
  insert into _v values('card refunds go only through the processor workflow', false, 'no error');
exception when others then
  insert into _v values('card refunds go only through the processor workflow', sqlstate='22023', sqlstate);
end $$;

-- ------------------------------------------------------- void: invoice C
do $$
declare _r jsonb;
begin
  _r := public.create_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001',
    null, (select v from _ids where k='loc')::uuid);
  insert into _ids values('invC', _r->>'id'), ('invC_v', _r->>'version');
  _r := public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001', (_r->>'id')::uuid, (_r->>'version')::int,
    (select v from _ids where k='loc')::uuid,
    jsonb_build_array(jsonb_build_object(
      'productId',(select v from _ids where k='omega'),'quantity',1)));
  update _ids set v = _r->>'version' where k='invC_v';
  _r := public.finalize_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invC')::uuid,
    (select v from _ids where k='invC_v')::int);
  update _ids set v = _r->>'version' where k='invC_v';
  insert into _v values('a second finalize takes the next number and reserves again',
    _r->>'number' = 'INV-00003'
    and (select reserved = 1 from public.inventory_stock
         where product_id = (select v from _ids where k='omega')::uuid), null);
end $$;
do $$ begin
  perform public.void_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invC')::uuid,
    (select v from _ids where k='invC_v')::int, '  ');
  insert into _v values('voiding requires a reason', false, 'no error');
exception when others then
  insert into _v values('voiding requires a reason', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.void_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invC')::uuid,
    (select v from _ids where k='invC_v')::int, 'entered in error');
  insert into _v values('voiding an unpaid invoice releases its reservations',
    _r->>'status' = 'void'
    and (select reserved = 0 and on_hand = 7 from public.inventory_stock
         where product_id = (select v from _ids where k='omega')::uuid)
    and (select count(*) = 1 from public.inventory_ledger
         where product_id = (select v from _ids where k='omega')::uuid and kind = 'release'), null);
end $$;
do $$ begin
  perform public.void_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invA')::uuid,
    (select v from _ids where k='invA_v')::int, 'attempt on paid');
  insert into _v values('a paid invoice cannot be voided — refunds are the paid path', false, 'no error');
exception when others then
  insert into _v values('a paid invoice cannot be voided — refunds are the paid path', sqlstate='42501', sqlstate);
end $$;

-- --------------------------------------- oversell + location guard rails
do $$
declare _r jsonb;
begin
  _r := public.create_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001',
    null, (select v from _ids where k='loc')::uuid);
  insert into _ids values('invD', _r->>'id');
  _r := public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001', (_r->>'id')::uuid, (_r->>'version')::int,
    (select v from _ids where k='loc')::uuid,
    jsonb_build_array(jsonb_build_object(
      'productId',(select v from _ids where k='omega'),'quantity',999)));
  insert into _ids values('invD_v', _r->>'version');
end $$;
do $$ begin
  perform public.finalize_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invD')::uuid,
    (select v from _ids where k='invD_v')::int);
  insert into _v values('overselling at finalize is a typed conflict and reserves nothing', false, 'no error');
exception when others then
  insert into _v values('overselling at finalize is a typed conflict and reserves nothing',
    sqlstate='40001'
    and (select reserved = 0 from public.inventory_stock
         where product_id = (select v from _ids where k='omega')::uuid)
    and (select status = 'draft' from public.invoices
         where id = (select v from _ids where k='invD')::uuid), sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.create_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001');
  insert into _ids values('invE', _r->>'id');
  _r := public.save_invoice_draft(
    'bbbbbbbb-0000-0000-0000-000000001001', (_r->>'id')::uuid, (_r->>'version')::int,
    null,
    jsonb_build_array(jsonb_build_object(
      'productId',(select v from _ids where k='omega'),'quantity',1)));
  insert into _ids values('invE_v', _r->>'version');
end $$;
do $$ begin
  perform public.finalize_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='invE')::uuid,
    (select v from _ids where k='invE_v')::int);
  insert into _v values('selling tracked inventory requires a location', false, 'no error');
exception when others then
  insert into _v values('selling tracked inventory requires a location', sqlstate='22023', sqlstate);
end $$;

-- ------------------------------------------------- low-stock watchdog
do $$
begin
  perform public.adjust_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, -5, 'adjustment', 'cycle count correction');
  insert into _v values('crossing the reorder threshold opens ONE low-stock review task',
    (select on_hand = 2 from public.inventory_stock
     where product_id = (select v from _ids where k='omega')::uuid)
    and (select count(*) = 1 from public.review_queue_items
         where organization_id = 'bbbbbbbb-0000-0000-0000-000000001001'
           and item_type = 'inventory_low_stock'
           and ref_id = (select v from _ids where k='omega')::uuid
           and status = 'open'), null);
  perform public.adjust_inventory_stock(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='loc')::uuid,
    (select v from _ids where k='omega')::uuid, -1, 'adjustment', 'second correction');
  insert into _v values('a second threshold crossing does not duplicate the open task',
    (select count(*) = 1 from public.review_queue_items
     where organization_id = 'bbbbbbbb-0000-0000-0000-000000001001'
       and item_type = 'inventory_low_stock'
       and ref_id = (select v from _ids where k='omega')::uuid), null);
end $$;

-- ------------------------------------------------------- projections
do $$
declare _h jsonb;
begin
  _h := public.get_inventory_history(
    'bbbbbbbb-0000-0000-0000-000000001001',
    (select v from _ids where k='omega')::uuid);
  insert into _v values('the inventory history projects the full movement ledger',
    jsonb_array_length(_h) = 11, jsonb_array_length(_h)::text);
end $$;
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000001002","role":"authenticated"}', true);
do $$
declare _j jsonb;
begin
  _j := public.get_billing_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001', (select v from _ids where k='invA')::uuid);
  insert into _v values('staff can read the full invoice projection',
    _j->>'number' = 'INV-00001'
    and jsonb_array_length(_j->'lines') = 2
    and jsonb_array_length(_j->'payments') = 2
    and jsonb_array_length(_j->'payments'->1->'refunds')
        + jsonb_array_length(_j->'payments'->0->'refunds') = 1
    and jsonb_array_length(_j->'history') >= 3, null);
end $$;
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000001003","role":"authenticated"}', true);
do $$ begin
  perform public.get_billing_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001', (select v from _ids where k='invA')::uuid);
  insert into _v values('a cross-tenant invoice read is refused', false, 'no error');
exception when others then
  insert into _v values('a cross-tenant invoice read is refused', sqlstate='42501', sqlstate);
end $$;
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000001001","role":"authenticated"}', true);
do $$ begin
  perform public.get_billing_invoice(
    'bbbbbbbb-0000-0000-0000-000000001001', gen_random_uuid());
  insert into _v values('an unknown invoice read is not found', false, 'no error');
exception when others then
  insert into _v values('an unknown invoice read is not found', sqlstate='P0002', sqlstate);
end $$;
do $$
declare _p jsonb;
begin
  _p := public.get_patient_billing(
    'bbbbbbbb-0000-0000-0000-000000001001','cccccccc-0000-0000-0000-000000001001');
  insert into _v values('the patient ledger lists every invoice and the credit balance',
    jsonb_array_length(_p->'invoices') = 5
    and (_p->>'creditBalanceMinor')::bigint = 0, null);
end $$;
do $$
declare _w jsonb;
begin
  _w := public.get_billing_workspace('bbbbbbbb-0000-0000-0000-000000001001');
  insert into _v values('the workspace summary adds up (invoiced/collected/refunded/outstanding)',
    (_w->'summary'->>'invoicedMinor')::bigint = 36900
    and (_w->'summary'->>'collectedMinor')::bigint = 36900
    and (_w->'summary'->>'refundedMinor')::bigint = 16200
    and (_w->'summary'->>'outstandingMinor')::bigint = 0
    and (_w->'summary'->>'discountMinor')::bigint = 500
    and (_w->'summary'->>'taxMinor')::bigint = 2400,
    _w->'summary' #>> '{}');
  insert into _v values('the workspace lists invoices, aging, product sales, and reconciliation',
    jsonb_array_length(_w->'invoices') = 5
    and (_w->'aging'->>'current')::bigint = 0
    and jsonb_array_length(_w->'productSales') >= 1
    and (_w->'reconciliation'->>'pendingCardPayments')::int = 0
    and jsonb_array_length(_w->'reconciliation'->'webhookEvents') = 5, null);
  insert into _v values('the workspace inventory panel reports valuation and low stock',
    (_w->'inventory'->>'valuationMinor')::bigint = 1200
    and jsonb_array_length(_w->'inventory'->'lowStock') = 1, null);
end $$;

-- ------------------------------------------------ history immutability
do $$
begin
  update public.invoice_events set detail_safe = 'edited'
  where invoice_id = (select v from _ids where k='invA')::uuid;
  insert into _v values('invoice history is append-only (trigger-level)', false, 'no error');
exception when others then
  insert into _v values('invoice history is append-only (trigger-level)', sqlstate='42501', sqlstate);
end $$;
insert into _v
select 'every billing action left an audit trail',
  count(*) >= 12, count(*)::text
  from public.audit_events
  where organization_id = 'bbbbbbbb-0000-0000-0000-000000001001'
    and action like 'billing.%';
insert into _v
select 'the billing flow created no note, message, protocol, appointment, enrollment, or conversation',
  (select v from _base where k='notes') = (select count(*) from public.clinical_notes)
  and (select v from _base where k='messages') = (select count(*) from public.messages)
  and (select v from _base where k='protocols') = (select count(*) from public.protocols)
  and (select v from _base where k='appointments') = (select count(*) from public.appointments)
  and (select v from _base where k='enrollments') = (select count(*) from public.program_enrollments)
  and (select v from _base where k='conversations') = (select count(*) from public.conversations), null;

select name, passed, detail from _v order by name;
rollback;

-- Zero-residue check (runs OUTSIDE the rolled-back transaction above).
select 'zero rollback residue' as check, count(*) = 0 as clean from (
  select id from public.organizations
    where id in ('bbbbbbbb-0000-0000-0000-000000001001','bbbbbbbb-0000-0000-0000-000000001002')
  union all
  select id from public.invoices
    where organization_id in ('bbbbbbbb-0000-0000-0000-000000001001','bbbbbbbb-0000-0000-0000-000000001002')
  union all
  select id from public.billing_webhook_events where event_id like 'evt-b-%'
  union all
  select id from public.review_queue_items where item_type = 'inventory_low_stock'
) residue;
