-- Phase 8A: Desktop-owned billing, checkout, catalog & inventory — RPCs.
--
-- Every write crosses this boundary: auth.uid() identity, active org
-- membership, role-gated financial permission (owner/admin/practitioner via
-- private.can_manage_billing), tenant agreement on EVERY referenced row,
-- typed errors (28000 unauthenticated / 42501 forbidden / P0002 not found /
-- 22023 invalid / 40001 conflict incl. optimistic-version and oversell),
-- expected-version concurrency, and atomic payment+inventory+audit work.
--
-- Money rules: integer minor units; tax is computed ONLY from configured
-- tax_rates snapshots (never accepted from a client); the browser never
-- asserts totals, payment success, decrement, or refund completion.
--
-- Inventory accounting policy (documented in docs/clinical-runtime-migration.md):
--   draft            -> no inventory effect
--   finalize (open)  -> RESERVE tracked lines (reserved += qty), oversell -> 40001
--   full settlement  -> COMMIT sale exactly once (on_hand -= qty, reserved -= qty),
--                       guarded by invoices.inventory_committed_at
--   void unpaid      -> RELEASE reservations
--   refund           -> NO automatic restock; return_inventory_stock is the
--                       explicit, reason+condition-required restock operation
--   services / non-tracked items -> never touch stock

begin;

-- =============================================================== internals

create or replace function private.billing_reader(_org uuid)
returns uuid language plpgsql stable security definer set search_path = ''
as $$
declare _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_org) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  return _uid;
end;
$$;

create or replace function private.billing_writer(_org uuid)
returns uuid language plpgsql stable security definer set search_path = ''
as $$
declare _uid uuid := private.billing_reader(_org);
begin
  if not private.can_manage_billing(_org) then
    raise exception 'billing changes require an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  return _uid;
end;
$$;

create or replace function private.billing_audit(
  _org uuid, _patient uuid, _actor uuid, _action text,
  _resource_type text, _resource_id text, _message text, _metadata jsonb
) returns void language sql security definer set search_path = ''
as $$
  insert into public.audit_events (organization_id, patient_id, actor_user_id,
    action, resource_type, resource_id, safe_message, metadata)
  values (_org, _patient, _actor, _action, _resource_type, _resource_id,
    _message, coalesce(_metadata, '{}'::jsonb));
$$;

-- Low-stock watchdog: crossing the threshold opens ONE review task per
-- (location, product). It never purchases anything.
create or replace function private.billing_low_stock_check(
  _org uuid, _location uuid, _product uuid, _actor uuid
) returns void language plpgsql security definer set search_path = ''
as $$
declare _s public.inventory_stock%rowtype; _name text; _loc text;
begin
  select * into _s from public.inventory_stock
  where location_id = _location and product_id = _product;
  if not found then return; end if;
  if (_s.on_hand - _s.reserved) > _s.reorder_threshold then return; end if;
  -- One open watchdog item per product; it names the triggering location.
  if exists (select 1 from public.review_queue_items
      where organization_id = _org and item_type = 'inventory_low_stock'
        and ref_id = _product and status in ('open','in_review')) then
    return;
  end if;
  select name into _name from public.products_services where id = _product;
  select name into _loc from public.locations where id = _location;
  insert into public.review_queue_items (organization_id, item_type, priority,
    status, title, ref_id, created_by)
  values (_org, 'inventory_low_stock', 'medium', 'open',
    'Low stock: ' || coalesce(_name, 'product') || ' at '
      || coalesce(_loc, 'location') || ' ('
      || (_s.on_hand - _s.reserved)::text || ' available, threshold '
      || _s.reorder_threshold::text || ')',
    _product, _actor);
end;
$$;

-- Apply one inventory movement atomically: stock row + append-only ledger.
create or replace function private.billing_move_stock(
  _org uuid, _location uuid, _product uuid, _kind text,
  _on_hand_delta integer, _reserved_delta integer,
  _reason text, _condition text, _unit_cost bigint, _supplier uuid,
  _ref_type text, _ref_id uuid, _actor uuid
) returns void language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.inventory_stock (organization_id, location_id, product_id, on_hand, reserved)
  values (_org, _location, _product, 0, 0)
  on conflict (location_id, product_id) do nothing;

  update public.inventory_stock
  set on_hand = on_hand + _on_hand_delta,
      reserved = reserved + _reserved_delta,
      updated_at = now()
  where location_id = _location and product_id = _product;

  insert into public.inventory_ledger (organization_id, location_id, product_id,
    kind, on_hand_delta, reserved_delta, reason, condition, unit_cost_minor,
    supplier_id, ref_type, ref_id, actor_user_id)
  values (_org, _location, _product, _kind, _on_hand_delta, _reserved_delta,
    _reason, _condition, _unit_cost, _supplier, _ref_type, _ref_id, _actor);
exception
  when check_violation then
    raise exception 'insufficient stock for this movement' using errcode = '40001';
end;
$$;

-- Exactly-once sale commitment, guarded by invoices.inventory_committed_at.
create or replace function private.billing_commit_inventory(_invoice uuid, _actor uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _inv public.invoices%rowtype; _l record;
begin
  select * into _inv from public.invoices where id = _invoice for update;
  if _inv.inventory_committed_at is not null then return; end if;
  if _inv.inventory_reserved_at is null then
    update public.invoices set inventory_committed_at = now() where id = _invoice;
    return;
  end if;
  for _l in
    select li.product_service_id as product_id, li.quantity::integer as qty, li.location_id
    from public.invoice_line_items li
    join public.products_services p on p.id = li.product_service_id
    where li.invoice_id = _invoice and p.track_inventory
  loop
    perform private.billing_move_stock(_inv.organization_id,
      coalesce(_l.location_id, _inv.location_id), _l.product_id, 'sale',
      -_l.qty, -_l.qty, null, null, null, null, 'invoice', _invoice, _actor);
    perform private.billing_low_stock_check(_inv.organization_id,
      coalesce(_l.location_id, _inv.location_id), _l.product_id, _actor);
  end loop;
  update public.invoices set inventory_committed_at = now() where id = _invoice;
end;
$$;

-- Shared settlement: recompute paid state, transition status, commit
-- inventory exactly once when fully settled. Source: 'rpc' | 'webhook'.
create or replace function private.billing_settle_invoice(
  _invoice uuid, _actor uuid, _source text
) returns void language plpgsql security definer set search_path = ''
as $$
declare _inv public.invoices%rowtype; _paid bigint; _refunded bigint;
        _settled bigint; _from text; _to text;
begin
  select * into _inv from public.invoices where id = _invoice for update;
  select coalesce(sum(amount_minor), 0) into _paid
  from public.payments where invoice_id = _invoice and status = 'succeeded';
  select coalesce(sum(r.amount_minor), 0) into _refunded
  from public.refunds r join public.payments p on p.id = r.payment_id
  where p.invoice_id = _invoice and r.status = 'succeeded';

  _settled := _paid + _inv.credit_applied_minor;
  _from := _inv.status;
  if _inv.status in ('void', 'draft') then
    _to := _inv.status;
  elsif _refunded > 0 and _refunded >= _paid and _paid > 0 then
    _to := 'refunded';
  elsif _refunded > 0 then
    _to := 'partially_refunded';
  elsif _settled >= _inv.total_minor and _inv.total_minor > 0 then
    _to := 'paid';
  elsif _settled > 0 then
    _to := 'partially_paid';
  else
    _to := 'open';
  end if;

  update public.invoices
  set paid_minor = _paid, refunded_minor = _refunded, status = _to,
      version = version + 1, updated_at = now()
  where id = _invoice;

  if _from is distinct from _to then
    insert into public.invoice_events (organization_id, invoice_id, kind,
      from_status, to_status, detail_safe, actor_user_id)
    values (_inv.organization_id, _invoice, 'status', _from, _to, _source, _actor);
  end if;

  if _to = 'paid' then
    perform private.billing_commit_inventory(_invoice, _actor);
  end if;
end;
$$;

-- ============================================================ projections

create or replace function private.billing_invoice_json(_invoice uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', i.id, 'number', i.number, 'status', i.status, 'version', i.version,
    'currency', i.currency, 'patientId', i.patient_id,
    'patientName', nullif(btrim(concat_ws(' ', pp.first_name, pp.last_name)), ''),
    'appointmentId', i.appointment_id,
    'practitionerUserId', i.practitioner_user_id,
    'locationId', i.location_id,
    'locationName', loc.name,
    'subtotalMinor', i.subtotal_minor, 'discountMinor', i.discount_minor,
    'taxMinor', i.tax_minor, 'totalMinor', i.total_minor,
    'paidMinor', i.paid_minor, 'refundedMinor', i.refunded_minor,
    'creditAppliedMinor', i.credit_applied_minor,
    'balanceMinor', greatest(i.total_minor - i.paid_minor - i.credit_applied_minor, 0),
    'finalizedAt', i.finalized_at, 'voidedAt', i.voided_at,
    'voidReason', i.void_reason, 'createdAt', i.created_at,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'id', li.id, 'kind', li.kind, 'productId', li.product_service_id,
        'name', coalesce(li.name_snapshot, li.description),
        'sku', li.sku_snapshot, 'description', li.description_snapshot,
        'quantity', li.quantity, 'unitAmountMinor', li.unit_amount_minor,
        'amountMinor', li.amount_minor, 'discountMinor', li.discount_minor,
        'discountReason', li.discount_reason,
        'taxRateBps', li.tax_rate_bps, 'taxMinor', li.tax_minor,
        'verification', li.verification_snapshot) order by li.sort)
      from public.invoice_line_items li where li.invoice_id = i.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'amountMinor', p.amount_minor, 'currency', p.currency,
        'status', p.status, 'method', p.method, 'reference', p.reference,
        'environment', p.environment, 'processor', p.processor,
        'failureCode', p.failure_code_safe, 'paidAt', p.paid_at,
        'createdAt', p.created_at,
        'refunds', coalesce((select jsonb_agg(jsonb_build_object(
            'id', r.id, 'amountMinor', r.amount_minor, 'reason', r.reason,
            'status', r.status, 'method', r.method, 'createdAt', r.created_at)
            order by r.created_at)
          from public.refunds r where r.payment_id = p.id), '[]'::jsonb))
        order by p.created_at)
      from public.payments p where p.invoice_id = i.id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object(
        'kind', e.kind, 'from', e.from_status, 'to', e.to_status,
        'detail', e.detail_safe, 'at', e.created_at) order by e.created_at)
      from public.invoice_events e where e.invoice_id = i.id), '[]'::jsonb))
  from public.invoices i
  join public.patient_profiles pp on pp.id = i.patient_id
  left join public.locations loc on loc.id = i.location_id
  where i.id = _invoice;
$$;

create or replace function private.billing_credit_balance(_patient uuid)
returns bigint language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(case kind when 'grant' then amount_minor
                                when 'release' then amount_minor
                                else -amount_minor end), 0)
  from public.patient_credit_entries where patient_id = _patient;
$$;

-- =============================================== catalog & configuration

create or replace function public.upsert_billing_location(
  _organization_id uuid, _id uuid default null, _name text default null,
  _archive boolean default false
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id); _rid uuid;
begin
  if _id is null then
    if _name is null or btrim(_name) = '' then
      raise exception 'a location name is required' using errcode = '22023';
    end if;
    insert into public.locations (organization_id, name, created_by)
    values (_organization_id, btrim(_name), _uid) returning id into _rid;
  else
    select id into _rid from public.locations
    where id = _id and organization_id = _organization_id;
    if not found then
      raise exception 'location not found' using errcode = 'P0002';
    end if;
    update public.locations
    set name = coalesce(nullif(btrim(coalesce(_name, '')), ''), name),
        archived_at = case when _archive then now() else archived_at end,
        updated_at = now()
    where id = _rid;
  end if;
  return jsonb_build_object('id', _rid);
end;
$$;

create or replace function public.upsert_supplier(
  _organization_id uuid, _id uuid default null, _name text default null,
  _contact_email text default null, _phone text default null,
  _notes text default null, _archive boolean default false
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id); _rid uuid;
begin
  if _id is null then
    if _name is null or btrim(_name) = '' then
      raise exception 'a supplier name is required' using errcode = '22023';
    end if;
    insert into public.suppliers (organization_id, name, contact_email, phone, notes, created_by)
    values (_organization_id, btrim(_name), _contact_email, _phone, _notes, _uid)
    returning id into _rid;
  else
    select id into _rid from public.suppliers
    where id = _id and organization_id = _organization_id;
    if not found then
      raise exception 'supplier not found' using errcode = 'P0002';
    end if;
    update public.suppliers
    set name = coalesce(nullif(btrim(coalesce(_name, '')), ''), name),
        contact_email = coalesce(_contact_email, contact_email),
        phone = coalesce(_phone, phone),
        notes = coalesce(_notes, notes),
        archived_at = case when _archive then now() else archived_at end,
        version = version + 1, updated_at = now()
    where id = _rid;
  end if;
  return jsonb_build_object('id', _rid);
end;
$$;

create or replace function public.upsert_tax_rate(
  _organization_id uuid, _id uuid default null, _name text default null,
  _rate_bps integer default null, _active boolean default true
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id); _rid uuid;
begin
  if _id is null then
    if _name is null or btrim(_name) = '' or _rate_bps is null then
      raise exception 'tax rates need a name and a basis-point rate' using errcode = '22023';
    end if;
    insert into public.tax_rates (organization_id, name, rate_bps, active, created_by)
    values (_organization_id, btrim(_name), _rate_bps, coalesce(_active, true), _uid)
    returning id into _rid;
  else
    select id into _rid from public.tax_rates
    where id = _id and organization_id = _organization_id;
    if not found then
      raise exception 'tax rate not found' using errcode = 'P0002';
    end if;
    update public.tax_rates
    set name = coalesce(nullif(btrim(coalesce(_name, '')), ''), name),
        rate_bps = coalesce(_rate_bps, rate_bps),
        active = coalesce(_active, active), updated_at = now()
    where id = _rid;
  end if;
  return jsonb_build_object('id', _rid);
end;
$$;

create or replace function public.upsert_billing_product(
  _organization_id uuid,
  _id uuid default null,
  _expected_version integer default null,
  _name text default null,
  _kind text default null,
  _amount_minor bigint default null,
  _currency text default null,
  _sku text default null,
  _barcode text default null,
  _supplier_id uuid default null,
  _cost_minor bigint default null,
  _tax_rate_id uuid default null,
  _description text default null,
  _track_inventory boolean default null,
  _reorder_threshold integer default null,
  _catalog_product_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
        _p public.products_services%rowtype;
begin
  if _supplier_id is not null and not exists (select 1 from public.suppliers
      where id = _supplier_id and organization_id = _organization_id) then
    raise exception 'supplier belongs to a different organization' using errcode = '42501';
  end if;
  if _tax_rate_id is not null and not exists (select 1 from public.tax_rates
      where id = _tax_rate_id and organization_id = _organization_id) then
    raise exception 'tax rate belongs to a different organization' using errcode = '42501';
  end if;

  if _id is null then
    if _name is null or btrim(_name) = '' then
      raise exception 'a product name is required' using errcode = '22023';
    end if;
    if _kind is null or _kind not in
       ('service','visit','program','package','lab','product','supplement','adjustment','other') then
      raise exception 'unknown product kind' using errcode = '22023';
    end if;
    if _amount_minor is null or _amount_minor < 0 then
      raise exception 'a non-negative retail price is required' using errcode = '22023';
    end if;
    insert into public.products_services (organization_id, name, kind, amount_minor,
      currency, sku, barcode, supplier_id, cost_minor, tax_rate_id, description,
      track_inventory, reorder_threshold, catalog_product_id, created_by, updated_by)
    values (_organization_id, btrim(_name), _kind, _amount_minor,
      coalesce(upper(_currency), 'USD'), nullif(btrim(coalesce(_sku, '')), ''),
      _barcode, _supplier_id, coalesce(_cost_minor, 0), _tax_rate_id, _description,
      coalesce(_track_inventory, false), coalesce(_reorder_threshold, 0),
      _catalog_product_id, _uid, _uid)
    returning * into _p;
  else
    select * into _p from public.products_services
    where id = _id and organization_id = _organization_id for update;
    if not found then
      raise exception 'product not found' using errcode = 'P0002';
    end if;
    if _expected_version is null or _p.version <> _expected_version then
      raise exception 'the product changed since you loaded it' using errcode = '40001';
    end if;
    update public.products_services
    set name = coalesce(nullif(btrim(coalesce(_name, '')), ''), name),
        kind = coalesce(_kind, kind),
        amount_minor = coalesce(_amount_minor, amount_minor),
        currency = coalesce(upper(_currency), currency),
        sku = coalesce(nullif(btrim(coalesce(_sku, '')), ''), sku),
        barcode = coalesce(_barcode, barcode),
        supplier_id = coalesce(_supplier_id, supplier_id),
        cost_minor = coalesce(_cost_minor, cost_minor),
        tax_rate_id = coalesce(_tax_rate_id, tax_rate_id),
        description = coalesce(_description, description),
        track_inventory = coalesce(_track_inventory, track_inventory),
        reorder_threshold = coalesce(_reorder_threshold, reorder_threshold),
        catalog_product_id = coalesce(_catalog_product_id, catalog_product_id),
        version = version + 1, updated_at = now(), updated_by = _uid
    where id = _p.id
    returning * into _p;
  end if;

  perform private.billing_audit(_organization_id, null, _uid,
    case when _id is null then 'billing.product_created' else 'billing.product_updated' end,
    'billing_product', _p.id::text, 'Catalog product ' ||
    case when _id is null then 'created' else 'updated' end,
    jsonb_build_object('kind', _p.kind));
  return jsonb_build_object('id', _p.id, 'version', _p.version);
end;
$$;

create or replace function public.archive_billing_product(
  _organization_id uuid, _product_id uuid, _expected_version integer
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
        _p public.products_services%rowtype;
begin
  select * into _p from public.products_services
  where id = _product_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if _p.version <> _expected_version then
    raise exception 'the product changed since you loaded it' using errcode = '40001';
  end if;
  update public.products_services
  set archived_at = coalesce(archived_at, now()), is_active = false,
      version = version + 1, updated_at = now(), updated_by = _uid
  where id = _product_id;
  perform private.billing_audit(_organization_id, null, _uid,
    'billing.product_archived', 'billing_product', _product_id::text,
    'Catalog product archived (history preserved)', '{}'::jsonb);
  return jsonb_build_object('id', _product_id, 'version', _p.version + 1);
end;
$$;

create or replace function public.list_billing_catalog(
  _organization_id uuid,
  _query text default null,
  _kind text default null,
  _supplier_id uuid default null,
  _location_id uuid default null,
  _stock_filter text default null,   -- null | 'low' | 'out'
  _include_archived boolean default false,
  _limit integer default 100
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _uid uuid := private.billing_reader(_organization_id); _lim integer;
begin
  _lim := least(greatest(coalesce(_limit, 100), 1), 200);
  return jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(row_json order by row_json->>'name')
      from (
        select jsonb_build_object(
          'id', p.id, 'name', p.name, 'kind', p.kind,
          'amountMinor', p.amount_minor, 'currency', p.currency,
          'sku', p.sku, 'barcode', p.barcode,
          'supplierId', p.supplier_id, 'supplierName', s.name,
          'costMinor', p.cost_minor, 'taxRateId', p.tax_rate_id,
          'taxRateBps', tr.rate_bps, 'taxRateName', tr.name,
          'description', p.description,
          'trackInventory', p.track_inventory,
          'reorderThreshold', p.reorder_threshold,
          'catalogProductId', p.catalog_product_id,
          'verificationStatus', case when p.catalog_product_id is null then null
            else private.catalog_verification_status(p.catalog_product_id, null) end,
          'commercialLinks', coalesce((select jsonb_agg(jsonb_build_object(
              'kind', cl.kind, 'label', cl.label, 'url', cl.url,
              'disclosure', cl.disclosure))
            from public.product_commercial_links cl where cl.product_id = p.id), '[]'::jsonb),
          'archivedAt', p.archived_at, 'version', p.version,
          'stock', coalesce((select jsonb_agg(jsonb_build_object(
              'locationId', st.location_id, 'locationName', l.name,
              'onHand', st.on_hand, 'reserved', st.reserved,
              'available', st.on_hand - st.reserved,
              'reorderThreshold', st.reorder_threshold)
              order by l.name)
            from public.inventory_stock st
            join public.locations l on l.id = st.location_id
            where st.product_id = p.id
              and (_location_id is null or st.location_id = _location_id)), '[]'::jsonb)
        ) as row_json
        from public.products_services p
        left join public.suppliers s on s.id = p.supplier_id
        left join public.tax_rates tr on tr.id = p.tax_rate_id
        where p.organization_id = _organization_id
          and (_include_archived or p.archived_at is null)
          and (_kind is null or p.kind = _kind)
          and (_supplier_id is null or p.supplier_id = _supplier_id)
          and (_query is null or p.name ilike '%' || _query || '%'
               or p.sku ilike '%' || _query || '%'
               or p.barcode = _query)
          and (_stock_filter is null
            or (_stock_filter = 'out' and p.track_inventory and coalesce((
                select sum(st.on_hand - st.reserved) from public.inventory_stock st
                where st.product_id = p.id
                  and (_location_id is null or st.location_id = _location_id)), 0) <= 0)
            or (_stock_filter = 'low' and p.track_inventory and exists (
                select 1 from public.inventory_stock st
                where st.product_id = p.id
                  and (_location_id is null or st.location_id = _location_id)
                  and (st.on_hand - st.reserved) <= st.reorder_threshold)))
        limit _lim
      ) rows), '[]'::jsonb),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'contactEmail', s.contact_email,
        'phone', s.phone, 'notes', s.notes, 'archivedAt', s.archived_at)
        order by s.name)
      from public.suppliers s where s.organization_id = _organization_id), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'archivedAt', l.archived_at) order by l.name)
      from public.locations l where l.organization_id = _organization_id), '[]'::jsonb),
    'taxRates', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'rateBps', t.rate_bps, 'active', t.active)
        order by t.name)
      from public.tax_rates t where t.organization_id = _organization_id), '[]'::jsonb));
end;
$$;

-- ================================================== inventory operations

create or replace function public.receive_inventory_stock(
  _organization_id uuid, _location_id uuid, _product_id uuid,
  _quantity integer, _unit_cost_minor bigint default null,
  _supplier_id uuid default null, _reference text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
begin
  if _quantity is null or _quantity <= 0 then
    raise exception 'received quantity must be positive' using errcode = '22023';
  end if;
  if not exists (select 1 from public.locations
      where id = _location_id and organization_id = _organization_id) then
    raise exception 'location not found in this organization' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.products_services
      where id = _product_id and organization_id = _organization_id and track_inventory) then
    raise exception 'not an inventory-tracked product of this organization' using errcode = '22023';
  end if;
  if _supplier_id is not null and not exists (select 1 from public.suppliers
      where id = _supplier_id and organization_id = _organization_id) then
    raise exception 'supplier belongs to a different organization' using errcode = '42501';
  end if;
  perform private.billing_move_stock(_organization_id, _location_id, _product_id,
    'receipt', _quantity, 0, _reference, null, _unit_cost_minor, _supplier_id,
    'receipt', null, _uid);
  perform private.billing_audit(_organization_id, null, _uid,
    'billing.stock_received', 'inventory', _product_id::text,
    'Stock received', jsonb_build_object('quantity', _quantity));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.adjust_inventory_stock(
  _organization_id uuid, _location_id uuid, _product_id uuid,
  _delta integer, _kind text, _reason text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
begin
  if _reason is null or btrim(_reason) = '' then
    raise exception 'inventory adjustments require a reason' using errcode = '22023';
  end if;
  if _delta is null or _delta = 0 then
    raise exception 'an adjustment must change the quantity' using errcode = '22023';
  end if;
  if _kind not in ('adjustment','damaged','expired') then
    raise exception 'unknown adjustment kind' using errcode = '22023';
  end if;
  if _kind in ('damaged','expired') and _delta > 0 then
    raise exception 'damaged/expired stock can only be removed' using errcode = '22023';
  end if;
  if not exists (select 1 from public.locations
      where id = _location_id and organization_id = _organization_id) then
    raise exception 'location not found in this organization' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.products_services
      where id = _product_id and organization_id = _organization_id and track_inventory) then
    raise exception 'not an inventory-tracked product of this organization' using errcode = '22023';
  end if;
  perform private.billing_move_stock(_organization_id, _location_id, _product_id,
    _kind, _delta, 0, btrim(_reason), null, null, null, 'adjustment', null, _uid);
  perform private.billing_low_stock_check(_organization_id, _location_id, _product_id, _uid);
  perform private.billing_audit(_organization_id, null, _uid,
    'billing.stock_adjusted', 'inventory', _product_id::text,
    'Stock adjusted: ' || _kind, jsonb_build_object('delta', _delta));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.return_inventory_stock(
  _organization_id uuid, _location_id uuid, _product_id uuid,
  _quantity integer, _condition text, _reason text,
  _invoice_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
begin
  if _quantity is null or _quantity <= 0 then
    raise exception 'returned quantity must be positive' using errcode = '22023';
  end if;
  if _condition is null or _condition not in ('resalable','damaged') then
    raise exception 'a return needs an explicit condition (resalable or damaged)'
      using errcode = '22023';
  end if;
  if _reason is null or btrim(_reason) = '' then
    raise exception 'a return needs a reason' using errcode = '22023';
  end if;
  if _invoice_id is not null and not exists (select 1 from public.invoices
      where id = _invoice_id and organization_id = _organization_id) then
    raise exception 'invoice belongs to a different organization' using errcode = '42501';
  end if;
  if not exists (select 1 from public.locations
      where id = _location_id and organization_id = _organization_id) then
    raise exception 'location not found in this organization' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.products_services
      where id = _product_id and organization_id = _organization_id and track_inventory) then
    raise exception 'not an inventory-tracked product of this organization' using errcode = '22023';
  end if;
  -- Only a RESALABLE return restocks; a damaged return is recorded without
  -- touching sellable stock (movement kind 'return' with zero on-hand change
  -- is not representable, so damaged returns ledger as 'damaged' with no
  -- restock and the reason preserved).
  if _condition = 'resalable' then
    perform private.billing_move_stock(_organization_id, _location_id, _product_id,
      'return', _quantity, 0, btrim(_reason), _condition, null, null,
      'invoice', _invoice_id, _uid);
  else
    perform private.billing_move_stock(_organization_id, _location_id, _product_id,
      'return', _quantity, 0, btrim(_reason), _condition, null, null,
      'invoice', _invoice_id, _uid);
    perform private.billing_move_stock(_organization_id, _location_id, _product_id,
      'damaged', -_quantity, 0, 'damaged return: ' || btrim(_reason), _condition,
      null, null, 'invoice', _invoice_id, _uid);
  end if;
  perform private.billing_audit(_organization_id, null, _uid,
    'billing.stock_returned', 'inventory', _product_id::text,
    'Stock returned (' || _condition || ')', jsonb_build_object('quantity', _quantity));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.get_inventory_history(
  _organization_id uuid, _product_id uuid,
  _location_id uuid default null, _limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _uid uuid := private.billing_reader(_organization_id);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', il.id, 'kind', il.kind, 'onHandDelta', il.on_hand_delta,
      'reservedDelta', il.reserved_delta, 'reason', il.reason,
      'condition', il.condition, 'unitCostMinor', il.unit_cost_minor,
      'locationId', il.location_id, 'locationName', l.name,
      'refType', il.ref_type, 'refId', il.ref_id, 'at', il.created_at)
      order by il.created_at desc)
    from (select * from public.inventory_ledger il0
          where il0.organization_id = _organization_id
            and il0.product_id = _product_id
            and (_location_id is null or il0.location_id = _location_id)
          order by il0.created_at desc
          limit least(greatest(coalesce(_limit, 50), 1), 200)) il
    join public.locations l on l.id = il.location_id), '[]'::jsonb);
end;
$$;

-- ====================================================== checkout / invoice

create or replace function public.create_invoice_draft(
  _organization_id uuid, _patient_id uuid,
  _appointment_id uuid default null, _location_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
        _appt public.appointments%rowtype; _inv uuid; _svc public.products_services%rowtype;
begin
  if not private.can_access_patient(_patient_id) then
    raise exception 'no access to this patient' using errcode = '42501';
  end if;
  if not exists (select 1 from public.patient_profiles
      where id = _patient_id and organization_id = _organization_id) then
    raise exception 'patient belongs to a different organization' using errcode = '42501';
  end if;
  if _location_id is not null and not exists (select 1 from public.locations
      where id = _location_id and organization_id = _organization_id) then
    raise exception 'location belongs to a different organization' using errcode = '42501';
  end if;
  if _appointment_id is not null then
    select * into _appt from public.appointments
    where id = _appointment_id and organization_id = _organization_id;
    if not found then
      raise exception 'appointment not found in this organization' using errcode = 'P0002';
    end if;
    if _appt.patient_id <> _patient_id then
      raise exception 'appointment belongs to a different patient' using errcode = '42501';
    end if;
    -- One live (non-void) invoice per appointment.
    if exists (select 1 from public.invoices where appointment_id = _appointment_id
        and status <> 'void') then
      raise exception 'this appointment already has an invoice' using errcode = '40001';
    end if;
  end if;

  insert into public.invoices (organization_id, patient_id, appointment_id,
    practitioner_user_id, location_id, status, currency, created_by, updated_by)
  values (_organization_id, _patient_id, _appointment_id,
    coalesce(_appt.practitioner_user_id, _uid), _location_id, 'draft', 'USD', _uid, _uid)
  returning id into _inv;

  -- The booked service joins the draft automatically when the appointment
  -- type matches an active catalog service by name — a deterministic rule,
  -- never a protocol-driven cart addition.
  if _appointment_id is not null and _appt.appointment_type is not null then
    select * into _svc from public.products_services
    where organization_id = _organization_id and archived_at is null
      and kind in ('service','visit')
      and lower(name) = lower(_appt.appointment_type)
    limit 1;
    if found then
      insert into public.invoice_line_items (organization_id, patient_id, invoice_id,
        product_service_id, kind, name_snapshot, description_snapshot, quantity,
        unit_amount_minor, amount_minor, currency, tax_rate_bps, tax_minor, sort)
      values (_organization_id, _patient_id, _inv, _svc.id, 'service', _svc.name,
        _svc.description, 1, _svc.amount_minor, _svc.amount_minor, _svc.currency,
        coalesce((select rate_bps from public.tax_rates where id = _svc.tax_rate_id and active), 0),
        (_svc.amount_minor *
          coalesce((select rate_bps from public.tax_rates where id = _svc.tax_rate_id and active), 0)
          + 5000) / 10000, 0);
      update public.invoices i set
        subtotal_minor = _svc.amount_minor,
        tax_minor = (select coalesce(sum(li.tax_minor),0) from public.invoice_line_items li where li.invoice_id = _inv),
        total_minor = _svc.amount_minor +
          (select coalesce(sum(li.tax_minor),0) from public.invoice_line_items li where li.invoice_id = _inv)
      where i.id = _inv;
    end if;
  end if;

  insert into public.invoice_events (organization_id, invoice_id, kind, to_status,
    detail_safe, actor_user_id)
  values (_organization_id, _inv, 'created', 'draft', null, _uid);
  perform private.billing_audit(_organization_id, _patient_id, _uid,
    'billing.invoice_drafted', 'invoice', _inv::text, 'Invoice draft created',
    jsonb_build_object('appointmentId', _appointment_id));
  return private.billing_invoice_json(_inv);
end;
$$;

create or replace function public.save_invoice_draft(
  _organization_id uuid, _invoice_id uuid, _expected_version integer,
  _location_id uuid default null, _lines jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
        _inv public.invoices%rowtype; _line jsonb; _p public.products_services%rowtype;
        _qty integer; _unit bigint; _disc bigint; _disc_reason text;
        _rate integer; _gross bigint; _line_tax bigint;
        _subtotal bigint := 0; _discount bigint := 0; _tax bigint := 0;
        _sort integer := 0; _kind text;
begin
  select * into _inv from public.invoices
  where id = _invoice_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if _inv.status <> 'draft' then
    raise exception 'only a draft invoice can be edited' using errcode = '42501';
  end if;
  if _inv.version <> _expected_version then
    raise exception 'the invoice changed since you loaded it' using errcode = '40001';
  end if;
  if _location_id is not null and not exists (select 1 from public.locations
      where id = _location_id and organization_id = _organization_id) then
    raise exception 'location belongs to a different organization' using errcode = '42501';
  end if;
  if jsonb_typeof(_lines) <> 'array' or jsonb_array_length(_lines) > 100 then
    raise exception 'lines must be an array of at most 100 items' using errcode = '22023';
  end if;

  delete from public.invoice_line_items where invoice_id = _invoice_id;

  for _line in select * from jsonb_array_elements(_lines) loop
    select * into _p from public.products_services
    where id = (_line->>'productId')::uuid and organization_id = _organization_id;
    if not found then
      raise exception 'a line references a product outside this organization'
        using errcode = '42501';
    end if;
    if _p.archived_at is not null then
      raise exception 'an archived product cannot join a new invoice' using errcode = '22023';
    end if;
    _qty := coalesce((_line->>'quantity')::integer, 1);
    if _qty < 1 or _qty > 999 then
      raise exception 'line quantity must be between 1 and 999' using errcode = '22023';
    end if;
    -- Price: catalog by default; an explicit override is permitted for the
    -- financial roles already enforced by billing_writer.
    _unit := coalesce((_line->>'unitAmountMinor')::bigint, _p.amount_minor);
    if _unit < 0 then
      raise exception 'a line price cannot be negative' using errcode = '22023';
    end if;
    _gross := _unit * _qty;
    _disc := coalesce((_line->>'discountMinor')::bigint, 0);
    _disc_reason := nullif(btrim(coalesce(_line->>'discountReason', '')), '');
    if _disc < 0 or _disc > _gross then
      raise exception 'a discount cannot be negative or exceed the line amount'
        using errcode = '22023';
    end if;
    if _disc > 0 and _disc_reason is null then
      raise exception 'discounts require a reason' using errcode = '22023';
    end if;
    -- TAX IS NEVER CLIENT-SUPPLIED: the configured rate on the product is
    -- snapshotted at save time. Half-up rounding on the discounted base.
    _rate := coalesce((select rate_bps from public.tax_rates
      where id = _p.tax_rate_id and active), 0);
    _line_tax := ((_gross - _disc) * _rate + 5000) / 10000;
    _kind := case _p.kind when 'visit' then 'service'
      when 'other' then 'product' else _p.kind end;
    insert into public.invoice_line_items (organization_id, patient_id, invoice_id,
      product_service_id, kind, name_snapshot, sku_snapshot, description_snapshot,
      quantity, unit_amount_minor, amount_minor, currency, discount_minor,
      discount_reason, discount_authorized_by, tax_rate_bps, tax_minor,
      catalog_product_id, verification_snapshot, sort)
    values (_organization_id, _inv.patient_id, _invoice_id, _p.id, _kind, _p.name,
      _p.sku, _p.description, _qty, _unit, _gross, _inv.currency, _disc,
      _disc_reason, case when _disc > 0 then _uid end, _rate, _line_tax,
      _p.catalog_product_id,
      case when _p.catalog_product_id is null then null
        else private.catalog_verification_status(_p.catalog_product_id, null) end,
      _sort);
    _sort := _sort + 1;
    _subtotal := _subtotal + _gross;
    _discount := _discount + _disc;
    _tax := _tax + _line_tax;
  end loop;

  update public.invoices
  set subtotal_minor = _subtotal, discount_minor = _discount, tax_minor = _tax,
      total_minor = _subtotal - _discount + _tax,
      location_id = coalesce(_location_id, location_id),
      version = version + 1, updated_at = now(), updated_by = _uid
  where id = _invoice_id;
  return private.billing_invoice_json(_invoice_id);
end;
$$;

create or replace function public.finalize_invoice(
  _organization_id uuid, _invoice_id uuid, _expected_version integer
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
        _inv public.invoices%rowtype; _l record; _n integer;
        _available integer;
begin
  select * into _inv from public.invoices
  where id = _invoice_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if _inv.status <> 'draft' then
    raise exception 'only a draft invoice can be finalized' using errcode = '42501';
  end if;
  if _inv.version <> _expected_version then
    raise exception 'the invoice changed since you loaded it' using errcode = '40001';
  end if;
  if not exists (select 1 from public.invoice_line_items where invoice_id = _invoice_id) then
    raise exception 'an empty invoice cannot be finalized' using errcode = '22023';
  end if;

  -- Reserve tracked inventory under row locks; a concurrent checkout that
  -- would oversell gets a typed 40001 conflict, never a silent negative.
  for _l in
    select li.product_service_id as product_id, li.quantity::integer as qty
    from public.invoice_line_items li
    join public.products_services p on p.id = li.product_service_id
    where li.invoice_id = _invoice_id and p.track_inventory
  loop
    if _inv.location_id is null then
      raise exception 'a location is required to sell tracked inventory'
        using errcode = '22023';
    end if;
    select st.on_hand - st.reserved into _available
    from public.inventory_stock st
    where st.location_id = _inv.location_id and st.product_id = _l.product_id
    for update;
    if _available is null or _available < _l.qty then
      raise exception 'insufficient stock to finalize this sale' using errcode = '40001';
    end if;
    perform private.billing_move_stock(_organization_id, _inv.location_id,
      _l.product_id, 'reservation', 0, _l.qty, null, null, null, null,
      'invoice', _invoice_id, _uid);
  end loop;

  -- Per-organization sequential numbering under an advisory lock.
  perform pg_advisory_xact_lock(hashtext('invoice_number:' || _organization_id::text));
  select coalesce(max(number_int), 0) + 1 into _n
  from public.invoices where organization_id = _organization_id;

  update public.invoices
  set status = 'open', number_int = _n,
      number = 'INV-' || lpad(_n::text, 5, '0'),
      finalized_at = now(),
      inventory_reserved_at = case when exists (
        select 1 from public.invoice_line_items li
        join public.products_services p on p.id = li.product_service_id
        where li.invoice_id = _invoice_id and p.track_inventory)
        then now() end,
      version = version + 1, updated_at = now(), updated_by = _uid
  where id = _invoice_id;

  insert into public.invoice_events (organization_id, invoice_id, kind,
    from_status, to_status, actor_user_id)
  values (_organization_id, _invoice_id, 'status', 'draft', 'open', _uid);
  perform private.billing_audit(_organization_id, _inv.patient_id, _uid,
    'billing.invoice_finalized', 'invoice', _invoice_id::text,
    'Invoice finalized', jsonb_build_object('number', _n));
  return private.billing_invoice_json(_invoice_id);
end;
$$;

create or replace function public.void_invoice(
  _organization_id uuid, _invoice_id uuid, _expected_version integer, _reason text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
        _inv public.invoices%rowtype; _l record;
begin
  if _reason is null or btrim(_reason) = '' then
    raise exception 'voiding an invoice requires a reason' using errcode = '22023';
  end if;
  select * into _inv from public.invoices
  where id = _invoice_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if _inv.version <> _expected_version then
    raise exception 'the invoice changed since you loaded it' using errcode = '40001';
  end if;
  if _inv.status not in ('draft', 'open') or _inv.paid_minor > 0
     or _inv.credit_applied_minor > 0 then
    raise exception 'only an unpaid draft or open invoice can be voided; use refunds for paid invoices'
      using errcode = '42501';
  end if;

  -- Release reservations taken at finalize.
  if _inv.inventory_reserved_at is not null and _inv.inventory_committed_at is null then
    for _l in
      select li.product_service_id as product_id, li.quantity::integer as qty
      from public.invoice_line_items li
      join public.products_services p on p.id = li.product_service_id
      where li.invoice_id = _invoice_id and p.track_inventory
    loop
      perform private.billing_move_stock(_organization_id, _inv.location_id,
        _l.product_id, 'release', 0, -_l.qty, 'invoice voided', null, null, null,
        'invoice', _invoice_id, _uid);
    end loop;
  end if;

  update public.invoices
  set status = 'void', voided_at = now(), void_reason = btrim(_reason),
      version = version + 1, updated_at = now(), updated_by = _uid
  where id = _invoice_id;
  insert into public.invoice_events (organization_id, invoice_id, kind,
    from_status, to_status, detail_safe, actor_user_id)
  values (_organization_id, _invoice_id, 'status', _inv.status, 'void',
    btrim(_reason), _uid);
  perform private.billing_audit(_organization_id, _inv.patient_id, _uid,
    'billing.invoice_voided', 'invoice', _invoice_id::text, 'Invoice voided',
    jsonb_build_object('reason', btrim(_reason)));
  return private.billing_invoice_json(_invoice_id);
end;
$$;

-- ============================================================== payments

create or replace function public.record_manual_payment(
  _organization_id uuid, _invoice_id uuid, _expected_version integer,
  _amount_minor bigint, _method text, _reference text default null,
  _idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
        _inv public.invoices%rowtype; _pid uuid; _balance bigint;
begin
  if _method is null or _method not in ('cash','check','bank_transfer','external') then
    raise exception 'manual payments accept cash, check, bank_transfer, or external'
      using errcode = '22023';
  end if;
  if _amount_minor is null or _amount_minor <= 0 then
    raise exception 'a payment amount must be positive' using errcode = '22023';
  end if;
  select * into _inv from public.invoices
  where id = _invoice_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if _inv.status not in ('open','partially_paid') then
    raise exception 'payments apply only to open invoices' using errcode = '42501';
  end if;
  if _inv.version <> _expected_version then
    raise exception 'the invoice changed since you loaded it' using errcode = '40001';
  end if;
  _balance := _inv.total_minor - _inv.paid_minor - _inv.credit_applied_minor;
  if _amount_minor > _balance then
    raise exception 'a payment cannot exceed the outstanding balance' using errcode = '22023';
  end if;

  insert into public.payments (organization_id, patient_id, invoice_id,
    amount_minor, currency, status, method, reference, received_by,
    idempotency_key, processor)
  values (_organization_id, _inv.patient_id, _invoice_id, _amount_minor,
    _inv.currency, 'succeeded', _method, _reference, _uid,
    coalesce(_idempotency_key, gen_random_uuid()::text), 'manual')
  returning id into _pid;
  insert into public.payment_events (organization_id, payment_id, from_status,
    to_status, source, detail_safe)
  values (_organization_id, _pid, null, 'succeeded', 'rpc', _method);

  perform private.billing_settle_invoice(_invoice_id, _uid, 'rpc');
  perform private.billing_audit(_organization_id, _inv.patient_id, _uid,
    'billing.payment_recorded', 'payment', _pid::text,
    'Manual payment recorded', jsonb_build_object('method', _method));
  return private.billing_invoice_json(_invoice_id);
exception
  when unique_violation then
    raise exception 'this payment was already recorded' using errcode = '40001';
end;
$$;

create or replace function public.grant_patient_credit(
  _organization_id uuid, _patient_id uuid, _amount_minor bigint, _reason text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
begin
  if _amount_minor is null or _amount_minor <= 0 then
    raise exception 'a credit amount must be positive' using errcode = '22023';
  end if;
  if _reason is null or btrim(_reason) = '' then
    raise exception 'granting credit requires a reason' using errcode = '22023';
  end if;
  if not private.can_access_patient(_patient_id) or not exists (
      select 1 from public.patient_profiles
      where id = _patient_id and organization_id = _organization_id) then
    raise exception 'no access to this patient in this organization' using errcode = '42501';
  end if;
  insert into public.patient_credit_entries (organization_id, patient_id, kind,
    amount_minor, reason, actor_user_id)
  values (_organization_id, _patient_id, 'grant', _amount_minor, btrim(_reason), _uid);
  perform private.billing_audit(_organization_id, _patient_id, _uid,
    'billing.credit_granted', 'patient_credit', _patient_id::text,
    'Patient credit granted', '{}'::jsonb);
  return jsonb_build_object('balanceMinor', private.billing_credit_balance(_patient_id));
end;
$$;

create or replace function public.apply_patient_credit(
  _organization_id uuid, _invoice_id uuid, _expected_version integer,
  _amount_minor bigint
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
        _inv public.invoices%rowtype; _balance bigint; _credit bigint;
begin
  if _amount_minor is null or _amount_minor <= 0 then
    raise exception 'a credit application must be positive' using errcode = '22023';
  end if;
  select * into _inv from public.invoices
  where id = _invoice_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if _inv.status not in ('open','partially_paid') then
    raise exception 'credit applies only to open invoices' using errcode = '42501';
  end if;
  if _inv.version <> _expected_version then
    raise exception 'the invoice changed since you loaded it' using errcode = '40001';
  end if;
  _credit := private.billing_credit_balance(_inv.patient_id);
  _balance := _inv.total_minor - _inv.paid_minor - _inv.credit_applied_minor;
  if _amount_minor > _credit then
    raise exception 'not enough patient credit' using errcode = '22023';
  end if;
  if _amount_minor > _balance then
    raise exception 'credit cannot exceed the outstanding balance' using errcode = '22023';
  end if;
  insert into public.patient_credit_entries (organization_id, patient_id, kind,
    amount_minor, invoice_id, actor_user_id)
  values (_organization_id, _inv.patient_id, 'apply', _amount_minor, _invoice_id, _uid);
  update public.invoices
  set credit_applied_minor = credit_applied_minor + _amount_minor
  where id = _invoice_id;
  perform private.billing_settle_invoice(_invoice_id, _uid, 'rpc');
  perform private.billing_audit(_organization_id, _inv.patient_id, _uid,
    'billing.credit_applied', 'invoice', _invoice_id::text,
    'Patient credit applied to invoice', '{}'::jsonb);
  return private.billing_invoice_json(_invoice_id);
end;
$$;

create or replace function public.refund_payment(
  _organization_id uuid, _payment_id uuid, _amount_minor bigint,
  _reason text, _method text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
        _p public.payments%rowtype; _already bigint; _rid uuid;
begin
  if _reason is null or btrim(_reason) = '' then
    raise exception 'refunds require a reason' using errcode = '22023';
  end if;
  if _amount_minor is null or _amount_minor <= 0 then
    raise exception 'a refund amount must be positive' using errcode = '22023';
  end if;
  select * into _p from public.payments
  where id = _payment_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if _p.status <> 'succeeded' then
    raise exception 'only a succeeded payment can be refunded' using errcode = '42501';
  end if;
  if _p.method = 'card_test' then
    raise exception 'card refunds go through the payment processor workflow'
      using errcode = '22023';
  end if;
  select coalesce(sum(amount_minor), 0) into _already
  from public.refunds where payment_id = _payment_id and status = 'succeeded';
  if _already + _amount_minor > _p.amount_minor then
    raise exception 'refunds cannot exceed the original payment' using errcode = '22023';
  end if;

  insert into public.refunds (organization_id, patient_id, payment_id,
    amount_minor, currency, reason, status, method, authorized_by,
    idempotency_key)
  values (_organization_id, _p.patient_id, _payment_id, _amount_minor,
    _p.currency, btrim(_reason), 'succeeded', coalesce(_method, _p.method),
    _uid, gen_random_uuid()::text)
  returning id into _rid;
  insert into public.payment_events (organization_id, payment_id, from_status,
    to_status, source, detail_safe)
  values (_organization_id, _payment_id, 'succeeded', 'succeeded', 'rpc',
    'refund ' || _rid::text);

  if _p.invoice_id is not null then
    perform private.billing_settle_invoice(_p.invoice_id, _uid, 'rpc');
  end if;
  perform private.billing_audit(_organization_id, _p.patient_id, _uid,
    'billing.refund_recorded', 'refund', _rid::text, 'Refund recorded — no automatic restock',
    jsonb_build_object('paymentId', _payment_id));
  return case when _p.invoice_id is null
    then jsonb_build_object('id', _rid)
    else private.billing_invoice_json(_p.invoice_id) end;
end;
$$;

-- Card payments: the caller RPC creates the PENDING row; the server-only
-- processor boundary attaches the intent and the webhook settles it. The
-- browser NEVER asserts success.
create or replace function public.start_card_payment(
  _organization_id uuid, _invoice_id uuid, _expected_version integer,
  _idempotency_key text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := private.billing_writer(_organization_id);
        _inv public.invoices%rowtype; _pid uuid; _balance bigint;
begin
  if _idempotency_key is null or btrim(_idempotency_key) = '' then
    raise exception 'an idempotency key is required' using errcode = '22023';
  end if;
  select * into _inv from public.invoices
  where id = _invoice_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if _inv.status not in ('open','partially_paid') then
    raise exception 'payments apply only to open invoices' using errcode = '42501';
  end if;
  if _inv.version <> _expected_version then
    raise exception 'the invoice changed since you loaded it' using errcode = '40001';
  end if;
  _balance := _inv.total_minor - _inv.paid_minor - _inv.credit_applied_minor;
  if _balance <= 0 then
    raise exception 'this invoice has no outstanding balance' using errcode = '22023';
  end if;
  if exists (select 1 from public.payments
      where invoice_id = _invoice_id and status = 'pending' and method = 'card_test') then
    raise exception 'a card payment is already in progress for this invoice'
      using errcode = '40001';
  end if;

  insert into public.payments (organization_id, patient_id, invoice_id,
    amount_minor, currency, status, method, environment, received_by,
    idempotency_key, processor)
  values (_organization_id, _inv.patient_id, _invoice_id, _balance,
    _inv.currency, 'pending', 'card_test', 'test', _uid,
    btrim(_idempotency_key), 'stripe_test')
  returning id into _pid;
  insert into public.payment_events (organization_id, payment_id, from_status,
    to_status, source, detail_safe)
  values (_organization_id, _pid, null, 'pending', 'rpc', 'card_test started');
  perform private.billing_audit(_organization_id, _inv.patient_id, _uid,
    'billing.card_payment_started', 'payment', _pid::text,
    'Stripe TEST-MODE payment started', '{}'::jsonb);
  return jsonb_build_object('paymentId', _pid, 'amountMinor', _balance,
    'currency', _inv.currency);
exception
  when unique_violation then
    raise exception 'this payment was already started' using errcode = '40001';
end;
$$;

-- ================================================================= reads

create or replace function public.get_billing_invoice(
  _organization_id uuid, _invoice_id uuid
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _uid uuid := private.billing_reader(_organization_id); _j jsonb;
begin
  select private.billing_invoice_json(i.id) into _j
  from public.invoices i
  where i.id = _invoice_id and i.organization_id = _organization_id
    and private.can_access_patient(i.patient_id);
  if _j is null then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  return _j;
end;
$$;

create or replace function public.get_patient_billing(
  _organization_id uuid, _patient_id uuid
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _uid uuid := private.billing_reader(_organization_id);
begin
  if not private.can_access_patient(_patient_id) then
    raise exception 'no access to this patient' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'creditBalanceMinor', private.billing_credit_balance(_patient_id),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'number', i.number, 'status', i.status,
        'totalMinor', i.total_minor, 'paidMinor', i.paid_minor,
        'creditAppliedMinor', i.credit_applied_minor,
        'refundedMinor', i.refunded_minor,
        'balanceMinor', greatest(i.total_minor - i.paid_minor - i.credit_applied_minor, 0),
        'currency', i.currency, 'appointmentId', i.appointment_id,
        'createdAt', i.created_at, 'finalizedAt', i.finalized_at,
        'version', i.version)
        order by i.created_at desc)
      from public.invoices i
      where i.patient_id = _patient_id and i.organization_id = _organization_id), '[]'::jsonb));
end;
$$;

create or replace function public.get_billing_workspace(
  _organization_id uuid,
  _from timestamptz default now() - interval '30 days',
  _to timestamptz default now(),
  _status text default null,
  _practitioner_user_id uuid default null,
  _location_id uuid default null,
  _method text default null
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _uid uuid := private.billing_reader(_organization_id);
begin
  return jsonb_build_object(
    'summary', (select jsonb_build_object(
      'invoicedMinor', coalesce(sum(i.total_minor) filter (where i.status <> 'void'), 0),
      'collectedMinor', coalesce(sum(i.paid_minor + i.credit_applied_minor), 0),
      'outstandingMinor', coalesce(sum(greatest(i.total_minor - i.paid_minor - i.credit_applied_minor, 0))
        filter (where i.status in ('open','partially_paid')), 0),
      'refundedMinor', coalesce(sum(i.refunded_minor), 0),
      'discountMinor', coalesce(sum(i.discount_minor) filter (where i.status <> 'void'), 0),
      'taxMinor', coalesce(sum(i.tax_minor) filter (where i.status <> 'void'), 0))
      from public.invoices i
      where i.organization_id = _organization_id and i.finalized_at is not null
        and i.finalized_at between _from and _to
        and (_practitioner_user_id is null or i.practitioner_user_id = _practitioner_user_id)
        and (_location_id is null or i.location_id = _location_id)),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'number', i.number, 'status', i.status,
        'patientId', i.patient_id,
        'patientName', nullif(btrim(concat_ws(' ', pp.first_name, pp.last_name)), ''),
        'totalMinor', i.total_minor,
        'balanceMinor', greatest(i.total_minor - i.paid_minor - i.credit_applied_minor, 0),
        'currency', i.currency, 'locationId', i.location_id,
        'practitionerUserId', i.practitioner_user_id,
        'finalizedAt', i.finalized_at, 'createdAt', i.created_at,
        'version', i.version)
        order by i.created_at desc)
      from (select * from public.invoices i0
        where i0.organization_id = _organization_id
          and (_status is null or i0.status = _status)
          and (i0.finalized_at between _from and _to or (i0.status = 'draft'
               and i0.created_at between _from and _to))
          and (_practitioner_user_id is null or i0.practitioner_user_id = _practitioner_user_id)
          and (_location_id is null or i0.location_id = _location_id)
        order by i0.created_at desc limit 200) i
      join public.patient_profiles pp on pp.id = i.patient_id
      where private.can_access_patient(i.patient_id)), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'invoiceId', p.invoice_id, 'amountMinor', p.amount_minor,
        'currency', p.currency, 'status', p.status, 'method', p.method,
        'environment', p.environment, 'reference', p.reference,
        'createdAt', p.created_at)
        order by p.created_at desc)
      from (select * from public.payments p0
        where p0.organization_id = _organization_id
          and p0.created_at between _from and _to
          and (_method is null or p0.method = _method)
        order by p0.created_at desc limit 200) p
      where private.can_access_patient(p.patient_id)), '[]'::jsonb),
    'aging', (select jsonb_build_object(
      'current', coalesce(sum(bal) filter (where age_days <= 30), 0),
      'days31to60', coalesce(sum(bal) filter (where age_days between 31 and 60), 0),
      'days61to90', coalesce(sum(bal) filter (where age_days between 61 and 90), 0),
      'over90', coalesce(sum(bal) filter (where age_days > 90), 0))
      from (select greatest(i.total_minor - i.paid_minor - i.credit_applied_minor, 0) as bal,
        extract(day from now() - i.finalized_at)::integer as age_days
        from public.invoices i
        where i.organization_id = _organization_id
          and i.status in ('open','partially_paid')) a),
    'productSales', coalesce((select jsonb_agg(jsonb_build_object(
        'productId', s.product_service_id, 'name', s.name_snapshot,
        'kind', s.kind, 'quantity', s.qty, 'amountMinor', s.amt)
        order by s.amt desc)
      from (select li.product_service_id, li.name_snapshot, li.kind,
          sum(li.quantity)::integer as qty,
          sum(li.amount_minor - li.discount_minor) as amt
        from public.invoice_line_items li
        join public.invoices i on i.id = li.invoice_id
        where i.organization_id = _organization_id
          and i.finalized_at between _from and _to and i.status <> 'void'
        group by li.product_service_id, li.name_snapshot, li.kind
        order by amt desc limit 20) s), '[]'::jsonb),
    'inventory', jsonb_build_object(
      'valuationMinor', coalesce((select sum(st.on_hand::bigint * p.cost_minor)
        from public.inventory_stock st
        join public.products_services p on p.id = st.product_id
        where st.organization_id = _organization_id), 0),
      'lowStock', coalesce((select jsonb_agg(jsonb_build_object(
          'productId', st.product_id, 'name', p.name,
          'locationId', st.location_id, 'locationName', l.name,
          'onHand', st.on_hand, 'reserved', st.reserved,
          'available', st.on_hand - st.reserved,
          'reorderThreshold', st.reorder_threshold)
          order by (st.on_hand - st.reserved))
        from public.inventory_stock st
        join public.products_services p on p.id = st.product_id
        join public.locations l on l.id = st.location_id
        where st.organization_id = _organization_id
          and (st.on_hand - st.reserved) <= st.reorder_threshold), '[]'::jsonb)),
    'reconciliation', jsonb_build_object(
      'pendingCardPayments', (select count(*) from public.payments
        where organization_id = _organization_id and status = 'pending'
          and method = 'card_test'),
      'webhookEvents', coalesce((select jsonb_agg(jsonb_build_object(
          'eventId', w.event_id, 'type', w.event_type, 'outcome', w.outcome,
          'detail', w.detail_safe, 'receivedAt', w.received_at)
          order by w.received_at desc)
        from (select * from public.billing_webhook_events w0
          where w0.organization_id = _organization_id
          order by w0.received_at desc limit 25) w), '[]'::jsonb)));
end;
$$;

-- ============================================= processor (service_role)

-- Attach the processor's object reference to the pending payment.
create or replace function public.attach_payment_processor_ref(
  _payment_id uuid, _processor_ref text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _p public.payments%rowtype;
begin
  select * into _p from public.payments where id = _payment_id for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if _p.status <> 'pending' or _p.method <> 'card_test' then
    raise exception 'only a pending card payment can attach a processor reference'
      using errcode = '42501';
  end if;
  if _p.processor_ref is not null and _p.processor_ref <> _processor_ref then
    raise exception 'a different processor reference is already attached'
      using errcode = '40001';
  end if;
  update public.payments set processor_ref = _processor_ref where id = _payment_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- The durable webhook application: dedup, tenant/amount agreement,
-- out-of-order safety, exactly-once settlement. Refusals are RECORDED
-- rows, not silent drops.
create or replace function public.record_billing_webhook(
  _event_id text, _event_type text, _processor_ref text,
  _amount_minor bigint default null, _currency text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _p public.payments%rowtype; _outcome text; _detail text;
        _already bigint; _rid uuid;
begin
  if _event_id is null or btrim(_event_id) = '' then
    raise exception 'a processor event id is required' using errcode = '22023';
  end if;

  -- Durable dedup FIRST: a replayed event id is answered as duplicate and
  -- never re-applied.
  begin
    insert into public.billing_webhook_events (provider, event_id, event_type, outcome)
    values ('stripe_test', _event_id, coalesce(_event_type, 'unknown'), 'processed');
  exception when unique_violation then
    return jsonb_build_object('outcome', 'duplicate');
  end;

  select * into _p from public.payments
  where processor = 'stripe_test' and processor_ref = _processor_ref
  for update;
  if not found then
    _outcome := 'ignored'; _detail := 'no matching payment';
  elsif _amount_minor is not null and _amount_minor <> _p.amount_minor then
    _outcome := 'refused'; _detail := 'amount mismatch';
  elsif _currency is not null and upper(_currency) <> upper(_p.currency) then
    _outcome := 'refused'; _detail := 'currency mismatch';
  else
    case _event_type
      when 'payment_intent.succeeded' then
        if _p.status = 'pending' then
          update public.payments set status = 'succeeded', paid_at = now(),
            version = version + 1 where id = _p.id;
          _outcome := 'processed'; _detail := 'payment succeeded';
        elsif _p.status = 'succeeded' then
          _outcome := 'duplicate'; _detail := 'already succeeded';
        else
          _outcome := 'out_of_order'; _detail := 'terminal state ' || _p.status;
        end if;
      when 'payment_intent.payment_failed' then
        if _p.status = 'pending' then
          update public.payments set status = 'failed',
            failure_code_safe = 'card_declined', version = version + 1
            where id = _p.id;
          _outcome := 'processed'; _detail := 'payment failed';
        else
          _outcome := 'out_of_order'; _detail := 'terminal state ' || _p.status;
        end if;
      when 'payment_intent.canceled' then
        if _p.status = 'pending' then
          update public.payments set status = 'canceled', version = version + 1
            where id = _p.id;
          _outcome := 'processed'; _detail := 'payment canceled';
        else
          _outcome := 'out_of_order'; _detail := 'terminal state ' || _p.status;
        end if;
      when 'charge.refunded' then
        if _p.status = 'succeeded' then
          select coalesce(sum(amount_minor), 0) into _already
          from public.refunds where payment_id = _p.id and status = 'succeeded';
          if coalesce(_amount_minor, 0) <= 0
             or _already + _amount_minor > _p.amount_minor then
            _outcome := 'refused'; _detail := 'refund amount invalid';
          else
            insert into public.refunds (organization_id, patient_id, payment_id,
              amount_minor, currency, reason, status, method, environment,
              processor_ref, idempotency_key)
            values (_p.organization_id, _p.patient_id, _p.id, _amount_minor,
              _p.currency, 'processor refund', 'succeeded', 'card_test', 'test',
              _event_id, _event_id)
            returning id into _rid;
            _outcome := 'processed'; _detail := 'refund recorded';
          end if;
        else
          _outcome := 'out_of_order'; _detail := 'refund before success';
        end if;
      when 'charge.dispute.created' then
        if _p.status = 'succeeded' then
          update public.payments set status = 'disputed', version = version + 1
            where id = _p.id;
          _outcome := 'processed'; _detail := 'payment disputed';
        else
          _outcome := 'out_of_order'; _detail := 'dispute before success';
        end if;
      else
        _outcome := 'ignored'; _detail := 'unhandled event type';
    end case;
  end if;

  update public.billing_webhook_events
  set outcome = _outcome, detail_safe = _detail,
      organization_id = _p.organization_id, payment_id = _p.id,
      invoice_id = _p.invoice_id, amount_minor = _amount_minor,
      currency = _currency
  where provider = 'stripe_test' and event_id = _event_id;

  if _outcome = 'processed' and _p.id is not null and _p.invoice_id is not null then
    insert into public.payment_events (organization_id, payment_id, from_status,
      to_status, source, provider_event_id, detail_safe)
    select _p.organization_id, _p.id, _p.status, p2.status, 'webhook', _event_id, _detail
    from public.payments p2 where p2.id = _p.id;
    perform private.billing_settle_invoice(_p.invoice_id, null, 'webhook');
  end if;
  return jsonb_build_object('outcome', _outcome, 'detail', _detail);
end;
$$;

-- ================================================================ grants

do $$ declare fn text;
begin
  foreach fn in array array[
    'upsert_billing_location(uuid,uuid,text,boolean)',
    'upsert_supplier(uuid,uuid,text,text,text,text,boolean)',
    'upsert_tax_rate(uuid,uuid,text,integer,boolean)',
    'upsert_billing_product(uuid,uuid,integer,text,text,bigint,text,text,text,uuid,bigint,uuid,text,boolean,integer,uuid)',
    'archive_billing_product(uuid,uuid,integer)',
    'list_billing_catalog(uuid,text,text,uuid,uuid,text,boolean,integer)',
    'receive_inventory_stock(uuid,uuid,uuid,integer,bigint,uuid,text)',
    'adjust_inventory_stock(uuid,uuid,uuid,integer,text,text)',
    'return_inventory_stock(uuid,uuid,uuid,integer,text,text,uuid)',
    'get_inventory_history(uuid,uuid,uuid,integer)',
    'create_invoice_draft(uuid,uuid,uuid,uuid)',
    'save_invoice_draft(uuid,uuid,integer,uuid,jsonb)',
    'finalize_invoice(uuid,uuid,integer)',
    'void_invoice(uuid,uuid,integer,text)',
    'record_manual_payment(uuid,uuid,integer,bigint,text,text,text)',
    'grant_patient_credit(uuid,uuid,bigint,text)',
    'apply_patient_credit(uuid,uuid,integer,bigint)',
    'refund_payment(uuid,uuid,bigint,text,text)',
    'start_card_payment(uuid,uuid,integer,text)',
    'get_billing_invoice(uuid,uuid)',
    'get_patient_billing(uuid,uuid)',
    'get_billing_workspace(uuid,timestamptz,timestamptz,text,uuid,uuid,text)']
  loop
    execute format('revoke execute on function public.%s from public, anon;', fn);
    execute format('grant execute on function public.%s to authenticated;', fn);
  end loop;
  -- Processor boundary: service_role ONLY — never browser-reachable.
  foreach fn in array array[
    'attach_payment_processor_ref(uuid,text)',
    'record_billing_webhook(text,text,text,bigint,text)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated;', fn);
    execute format('grant execute on function public.%s to service_role;', fn);
  end loop;
end $$;

commit;
