-- Phase 8A fix: the low-stock watchdog could never fire because
-- inventory_stock rows were created with the default reorder_threshold (0)
-- and the product-level reorder_threshold never reached them. The product
-- threshold is the source of truth in this phase (no per-location threshold
-- management exists): stock rows now inherit it at creation and follow
-- product updates. Surfaced by the desktop_owned_billing.sql acceptance
-- suite ("crossing the reorder threshold opens ONE low-stock review task").

begin;

create or replace function private.billing_move_stock(
  _org uuid, _location uuid, _product uuid, _kind text,
  _on_hand_delta integer, _reserved_delta integer,
  _reason text, _condition text, _unit_cost bigint, _supplier uuid,
  _ref_type text, _ref_id uuid, _actor uuid
) returns void language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.inventory_stock
    (organization_id, location_id, product_id, on_hand, reserved, reorder_threshold)
  values (_org, _location, _product, 0, 0,
    coalesce((select reorder_threshold from public.products_services
              where id = _product), 0))
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
    -- The product threshold is the source of truth: existing stock rows
    -- follow it so the low-stock watchdog and workspace agree.
    if _reorder_threshold is not null then
      update public.inventory_stock
      set reorder_threshold = _p.reorder_threshold, updated_at = now()
      where product_id = _p.id;
    end if;
  end if;

  perform private.billing_audit(_organization_id, null, _uid,
    case when _id is null then 'billing.product_created' else 'billing.product_updated' end,
    'billing_product', _p.id::text, 'Catalog product ' ||
    case when _id is null then 'created' else 'updated' end,
    jsonb_build_object('kind', _p.kind));
  return jsonb_build_object('id', _p.id, 'version', _p.version);
end;
$$;

commit;
