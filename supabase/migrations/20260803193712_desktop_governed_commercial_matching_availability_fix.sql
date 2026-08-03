-- Availability-status alignment for the governed commercial-matching RPC.
--
-- The original migration set availability_status = 'active' on attach and
-- 'revoked' on revoke, but the underlying constraint on
-- product_label_commercial_links.availability_status is:
--   check (availability_status in ('available','out_of_stock','discontinued','unknown'))
--
-- Neither 'active' nor 'revoked' is a legal value, so the first call to
-- attach_commercial_link_to_verified_product would trip the check and
-- rollback. This migration replaces both functions to use legal values —
-- 'available' at attach, 'discontinued' at revoke — leaving the revoked_at
-- + revoked_reason columns as the source of truth for "this link was
-- revoked, here's why". No table shape changes.

create or replace function public.attach_commercial_link_to_verified_product(
  _organization_id uuid,
  _label_version_id uuid,
  _incoming_sku text,
  _incoming_upc text,
  _incoming_manufacturer text,
  _incoming_product_name text,
  _affiliate_url text,
  _discount_code text,
  _disclosure text,
  _match_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _uid uuid;
  _lv public.product_label_versions%rowtype;
  _prod public.supplement_products%rowtype;
  _match_axis text;
  _link_id uuid;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  select * into _lv from public.product_label_versions
    where id = _label_version_id
      and organization_id = _organization_id
    for update;
  if not found then
    raise exception 'label version not found in this organization'
      using errcode = 'P0002';
  end if;
  if _lv.verified_at is null then
    raise exception 'attaching commercial data requires a verified label'
      using errcode = '55000';
  end if;
  if coalesce(btrim(_match_reason), '') = '' then
    raise exception 'a match decision requires a reason'
      using errcode = '22023';
  end if;
  if coalesce(btrim(_affiliate_url), '') = '' then
    raise exception 'an affiliate url is required'
      using errcode = '22023';
  end if;
  select p.* into _prod from public.supplement_products p
  where p.sku = _lv.product_code
  limit 1;
  if _prod.id is null then
    raise exception 'no clinical product identity found for this verified label'
      using errcode = 'P0002';
  end if;
  _match_axis := null;
  if coalesce(btrim(_incoming_sku), '') <> ''
     and coalesce(btrim(_prod.sku), '') <> ''
     and btrim(_incoming_sku) = btrim(_prod.sku) then
    _match_axis := 'sku';
  elsif coalesce(btrim(_incoming_upc), '') <> ''
        and coalesce(btrim(_prod.upc), '') <> ''
        and btrim(_incoming_upc) = btrim(_prod.upc) then
    _match_axis := 'upc';
  elsif coalesce(btrim(_incoming_manufacturer), '') <> ''
        and coalesce(btrim(_prod.manufacturer_identifier), '') <> ''
        and btrim(_incoming_manufacturer) = btrim(_prod.manufacturer_identifier)
        and coalesce(btrim(_incoming_product_name), '') <> ''
        and coalesce(btrim(_lv.product_name), '') <> ''
        and btrim(_incoming_product_name) = btrim(_lv.product_name) then
    _match_axis := 'manufacturer+name';
  end if;
  if _match_axis is null then
    raise exception 'commercial candidate does not exactly match the verified product on SKU, UPC, or manufacturer identifier + name'
      using errcode = '22023';
  end if;
  insert into public.product_label_commercial_links
    (organization_id, label_version_id, kind, url, supplier_name,
     commission_disclosure, availability_status, last_verified_at,
     recorded_by)
  values
    (_organization_id, _label_version_id, 'affiliate',
     btrim(_affiliate_url),
     nullif(btrim(_incoming_manufacturer), ''),
     nullif(btrim(_disclosure), ''),
     'available', now(), _uid)
  returning id into _link_id;
  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'catalog.commercial_link_attached',
     'product_label_commercial_link', _link_id::text,
     'Commercial link attached to a verified clinical product',
     jsonb_build_object(
       'match_axis', _match_axis,
       'label_version_id', _label_version_id,
       'has_discount_code', coalesce(btrim(_discount_code), '') <> '',
       'reason', btrim(_match_reason)));
  return jsonb_build_object(
    'ok', true,
    'linkId', _link_id,
    'labelVersionId', _label_version_id,
    'matchAxis', _match_axis);
end;
$function$;

create or replace function public.revoke_commercial_link(
  _organization_id uuid,
  _link_id uuid,
  _reason text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _uid uuid;
  _link public.product_label_commercial_links%rowtype;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'revoking a commercial link requires a reason'
      using errcode = '22023';
  end if;
  select * into _link from public.product_label_commercial_links
    where id = _link_id and organization_id = _organization_id
    for update;
  if not found then
    raise exception 'commercial link not found'
      using errcode = 'P0002';
  end if;
  if _link.revoked_at is not null then
    raise exception 'this commercial link has already been revoked'
      using errcode = '55000';
  end if;
  update public.product_label_commercial_links
  set revoked_at = now(),
      revoked_reason = btrim(_reason),
      availability_status = 'discontinued'
  where id = _link_id;
  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'catalog.commercial_link_revoked',
     'product_label_commercial_link', _link_id::text,
     'Commercial link revoked with a stated reason',
     jsonb_build_object('reason', btrim(_reason)));
  return jsonb_build_object('ok', true, 'linkId', _link_id);
end;
$function$;
