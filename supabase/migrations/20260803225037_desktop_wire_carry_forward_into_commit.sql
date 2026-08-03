-- Phase 9E-A.1 boundary fix: wire the carry-forward assertion into the real
-- commit path. `private.assert_preview_restriction_carries_forward` was
-- created in migration 20260803213609 but was inert — no caller invoked it.
-- Wire it as a post-condition inside `private.apply_catalog_product_item`
-- so a commit that fails to carry the preview item's restricted_flags onto
-- the committed supplement_products row raises 55000 and rolls back.

create or replace function private.apply_catalog_product_item(_item_id uuid, _uid uuid)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _item public.clinical_knowledge_import_items%rowtype;
  _p jsonb;
  _brand_id uuid;
  _brand text;
  _state text;
  _product_id uuid;
begin
  select * into _item from public.clinical_knowledge_import_items where id = _item_id;
  _p := _item.payload;
  _state := private.import_product_review_state(_item.missing_facts);

  _brand := nullif(btrim(coalesce(_p ->> 'brand', '')), '');
  if _brand is not null then
    select id into _brand_id from public.supplement_brands
     where lower(name) = lower(_brand) limit 1;
    if _brand_id is null then
      insert into public.supplement_brands(name) values (_brand)
      returning id into _brand_id;
    end if;
  end if;

  if _item.existing_ref_id is not null
     and _item.existing_ref_type = 'supplement_product' then
    update public.supplement_products
    set brand_id = coalesce(_brand_id, brand_id),
        name = btrim(_p ->> 'name'),
        form = nullif(btrim(coalesce(_p ->> 'form', '')), ''),
        description = nullif(btrim(coalesce(_p ->> 'description', '')), ''),
        sku = nullif(btrim(coalesce(_p ->> 'sku', '')), ''),
        upc = nullif(btrim(coalesce(_p ->> 'upc', '')), ''),
        manufacturer_identifier =
          nullif(btrim(coalesce(_p ->> 'manufacturerIdentifier', '')), ''),
        category = nullif(btrim(coalesce(_p ->> 'category', '')), ''),
        regulatory_classification =
          nullif(btrim(coalesce(_p ->> 'regulatoryClassification', '')), ''),
        jurisdiction = nullif(btrim(coalesce(_p ->> 'jurisdiction', '')), ''),
        status = _state,
        restricted_flags = _item.restricted_flags,
        restricted_cleared_at = null,
        restricted_cleared_by = null,
        restricted_clearance_note = null,
        updated_by = _uid,
        updated_at = now()
    where id = _item.existing_ref_id
    returning id into _product_id;
  end if;

  if _product_id is null then
    insert into public.supplement_products
      (brand_id, name, form, description, sku, upc, manufacturer_identifier,
       category, regulatory_classification, jurisdiction, status,
       restricted_flags, created_by, updated_by)
    values
      (_brand_id, btrim(_p ->> 'name'),
       nullif(btrim(coalesce(_p ->> 'form', '')), ''),
       nullif(btrim(coalesce(_p ->> 'description', '')), ''),
       nullif(btrim(coalesce(_p ->> 'sku', '')), ''),
       nullif(btrim(coalesce(_p ->> 'upc', '')), ''),
       nullif(btrim(coalesce(_p ->> 'manufacturerIdentifier', '')), ''),
       nullif(btrim(coalesce(_p ->> 'category', '')), ''),
       nullif(btrim(coalesce(_p ->> 'regulatoryClassification', '')), ''),
       nullif(btrim(coalesce(_p ->> 'jurisdiction', '')), ''),
       _state, _item.restricted_flags, _uid, _uid)
    returning id into _product_id;
  end if;

  if coalesce(btrim(_p ->> 'servingSize'), '') <> '' then
    insert into public.supplement_product_versions
      (product_id, version_label, serving_size, servings_per_container,
       other_ingredients, label_directions, label_warnings, jurisdiction,
       source_url, source_kind, effective_from, verification_state, status,
       created_by)
    values
      (_product_id,
       nullif(btrim(coalesce(_p ->> 'labelVersion', '')), ''),
       btrim(_p ->> 'servingSize'),
       nullif(btrim(coalesce(_p ->> 'servingsPerContainer', '')), '')::integer,
       nullif(btrim(coalesce(_p ->> 'otherIngredients', '')), ''),
       nullif(btrim(coalesce(_p ->> 'directions', '')), ''),
       nullif(btrim(coalesce(_p ->> 'warnings', '')), ''),
       nullif(btrim(coalesce(_p ->> 'jurisdiction', '')), ''),
       nullif(btrim(coalesce(_p ->> 'sourceUrl', '')), ''),
       'practitioner_supplied', null,
       'incomplete', 'draft', _uid);
  end if;

  -- Post-condition: the committed product carries every restricted flag the
  -- preview item carried. Raises 55000 if the invariant is violated. This is
  -- an explicit failure surface rather than a silent success.
  perform private.assert_preview_restriction_carries_forward(_item_id, _product_id);

  return _product_id;
end;
$function$;

-- Extend `get_restricted_review_history_v2` so a caller can also read the
-- preview-item review decisions that were made against the preview row that
-- eventually got applied as this product. This is a READ-side change only —
-- decisions themselves stay untouched and typed against their original
-- subject; the history query joins on `applied_ref_id` to surface both
-- the committed product's own decisions AND the preview item's decisions
-- from BEFORE it was applied.

create or replace function public.get_restricted_review_history_v2(
  _organization_id uuid,
  _subject_type text,
  _subject_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _uid uuid := auth.uid();
  _rows jsonb;
  _current text;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id = _organization_id
      and user_id = _uid
      and status = 'active'
  ) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if _subject_type not in ('product','preview_item','knowledge_reference') then
    raise exception 'unknown subject type: %', _subject_type using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(x order by x->>'decidedAt' desc), '[]'::jsonb) into _rows
  from (
    select jsonb_build_object(
      'id', d.id,
      'outcome', d.outcome,
      'reason', d.reason,
      'jurisdiction', d.jurisdiction,
      'decidedBy', d.decided_by,
      'decidedAt', d.decided_at,
      'subjectType', case
        when d.product_id is not null then 'product'
        when d.preview_item_id is not null then 'preview_item'
        when d.knowledge_reference_id is not null then 'knowledge_reference'
      end
    ) as x
    from public.catalog_restricted_review_decisions d
    where d.organization_id = _organization_id
      and (
        (_subject_type = 'product' and d.product_id = _subject_id)
        or (_subject_type = 'preview_item' and d.preview_item_id = _subject_id)
        or (_subject_type = 'knowledge_reference' and d.knowledge_reference_id = _subject_id)
        -- Carry-forward: a product query also returns the decisions recorded
        -- against the preview item that was applied to make this product.
        or (_subject_type = 'product'
            and d.preview_item_id in (
              select i.id from public.clinical_knowledge_import_items i
              where i.applied_ref_type = 'supplement_product'
                and i.applied_ref_id = _subject_id
                and i.organization_id = _organization_id))
      )
  ) t;

  select outcome into _current
  from public.catalog_restricted_review_decisions d
  where d.organization_id = _organization_id
    and (
      (_subject_type = 'product' and d.product_id = _subject_id)
      or (_subject_type = 'preview_item' and d.preview_item_id = _subject_id)
      or (_subject_type = 'knowledge_reference' and d.knowledge_reference_id = _subject_id)
      or (_subject_type = 'product'
          and d.preview_item_id in (
            select i.id from public.clinical_knowledge_import_items i
            where i.applied_ref_type = 'supplement_product'
              and i.applied_ref_id = _subject_id
              and i.organization_id = _organization_id))
    )
  order by d.decided_at desc limit 1;

  return jsonb_build_object(
    'subjectType', _subject_type,
    'subjectId', _subject_id,
    'organizationId', _organization_id,
    'currentOutcome', _current,
    'history', _rows);
end;
$function$;
