-- desktop_protocol_draft_verification
--
-- Closes a hole in save_protocol_draft (20260730043300): it accepted
-- `verificationStatus` from the autosave payload, which would let a client
-- assert that a product was structured-verified — i.e. claim that a
-- deterministic interaction check was possible when it was not.
--
-- The function below is IDENTICAL to 20260730043300 except in the product-item
-- branch:
--   * verification_status is DERIVED by private.catalog_verification_status
--     (20260730045821). The payload's `verificationStatus` field is ignored.
--   * a pinned catalog_product_version_id must belong to the pinned
--     catalog_product_id, and the manufacturer + label_version stored on the
--     item are the CATALOG's own values, not client text.
-- Everything else — the 40001 concurrency token, the phase timing rules, the
-- bounds, the auth gates, the audit row — is unchanged.

begin;

create or replace function public.save_protocol_draft(
  _version_id uuid,
  _payload jsonb,
  _expected_updated_at timestamptz default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _v public.protocol_versions%rowtype;
  _phase jsonb;
  _item jsonb;
  _phase_ids uuid[] := '{}';
  _new_phase_id uuid;
  _idx integer := 0;
  _product_id uuid;
  _product_version_id uuid;
  _manufacturer text;
  _label_version text;
  _catalog_manufacturer text;
  _catalog_label_version text;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if _payload is null or jsonb_typeof(_payload) <> 'object' then
    raise exception 'invalid payload' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(_payload->'phases', '[]'::jsonb)) > 24 then
    raise exception 'too many phases (max 24)' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(_payload->'items', '[]'::jsonb)) > 200 then
    raise exception 'too many items (max 200)' using errcode = '22023';
  end if;

  select * into _v from public.protocol_versions
  where id = _version_id for update;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if _v.protocol_id is not null then
    if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
      raise exception 'not authorized to edit this protocol' using errcode = '42501';
    end if;
  else
    if not private.can_author_protocol(_v.organization_id, null) then
      raise exception 'not authorized to edit organization templates' using errcode = '42501';
    end if;
  end if;
  if _v.status <> 'draft' then
    raise exception 'only draft versions can be edited; create a new draft version'
      using errcode = '22023';
  end if;
  if _expected_updated_at is not null
     and date_trunc('milliseconds', _expected_updated_at)
         <> date_trunc('milliseconds', _v.updated_at) then
    raise exception 'this draft changed elsewhere since it was loaded'
      using errcode = '40001';
  end if;

  update public.protocol_versions
  set title = coalesce(nullif(trim(coalesce(_payload->>'title','')), ''), _v.title),
      summary = _payload->>'summary',
      diet_instructions = _payload->>'dietInstructions',
      lifestyle_instructions = _payload->>'lifestyleInstructions',
      monitoring_plan = _payload->>'monitoringPlan',
      followup_plan = _payload->>'followupPlan',
      updated_by = _uid,
      updated_at = now()
  where id = _version_id;

  -- Wholesale replace: the client owns draft ordering, the server owns bounds.
  delete from public.protocol_items where version_id = _version_id;
  delete from public.protocol_phases where version_id = _version_id;

  for _phase in select * from jsonb_array_elements(coalesce(_payload->'phases','[]'::jsonb))
  loop
    if coalesce(trim(_phase->>'name'), '') = '' then
      raise exception 'each phase needs a name' using errcode = '22023';
    end if;
    insert into public.protocol_phases
      (organization_id, version_id, name, position, starts_on, ends_on,
       relative_start_day, relative_duration_days, notes)
    values
      (_v.organization_id, _version_id, left(trim(_phase->>'name'), 120), _idx,
       nullif(_phase->>'startsOn','')::date, nullif(_phase->>'endsOn','')::date,
       nullif(_phase->>'relativeStartDay','')::integer,
       nullif(_phase->>'relativeDurationDays','')::integer,
       _phase->>'notes')
    returning id into _new_phase_id;
    _phase_ids := _phase_ids || _new_phase_id;
    _idx := _idx + 1;
  end loop;

  _idx := 0;
  for _item in select * from jsonb_array_elements(coalesce(_payload->'items','[]'::jsonb))
  loop
    if (_item->>'kind') not in ('product','diet','lifestyle','monitoring','followup') then
      raise exception 'invalid item kind' using errcode = '22023';
    end if;
    if coalesce(trim(_item->>'label'), '') = '' then
      raise exception 'each item needs a label' using errcode = '22023';
    end if;
    _product_id := nullif(_item->>'catalogProductId','')::uuid;
    _product_version_id := nullif(_item->>'catalogProductVersionId','')::uuid;
    -- Catalog references must exist; a bad id is refused, never silently kept.
    if _product_id is not null
       and not exists (select 1 from public.supplement_products sp
                       where sp.id = _product_id) then
      raise exception 'catalog product not found' using errcode = 'P0002';
    end if;
    -- Product identity comes FROM THE CATALOG, not from client text. When a
    -- label version is pinned, the manufacturer and label version stored on the
    -- protocol item are the catalog's own values, and the pinned version must
    -- actually belong to the pinned product.
    _manufacturer := nullif(btrim(coalesce(_item->>'manufacturer','')), '');
    _label_version := nullif(btrim(coalesce(_item->>'labelVersion','')), '');
    if _product_version_id is not null then
      select b.name, v.version_label
        into _catalog_manufacturer, _catalog_label_version
      from public.supplement_product_versions v
      join public.supplement_products p on p.id = v.product_id
      left join public.supplement_brands b on b.id = p.brand_id
      where v.id = _product_version_id
        and (_product_id is null or v.product_id = _product_id);
      if not found then
        raise exception 'catalog product version not found for this product'
          using errcode = 'P0002';
      end if;
      _manufacturer := _catalog_manufacturer;
      _label_version := _catalog_label_version;
    end if;
    insert into public.protocol_items
      (organization_id, version_id, phase_id, kind, position, label, instructions,
       catalog_product_id, catalog_product_version_id, manufacturer, label_version,
       dosage_text, timing_text, route, verification_status,
       interaction_review_state, affiliate_url)
    values
      (_v.organization_id, _version_id,
       case when (_item->>'phaseIndex') is null then null
            else _phase_ids[(_item->>'phaseIndex')::integer + 1] end,
       _item->>'kind', _idx, left(trim(_item->>'label'), 240),
       _item->>'instructions',
       _product_id,
       _product_version_id,
       _manufacturer, _label_version,
       _item->>'dosageText', _item->>'timingText', _item->>'route',
       -- DERIVED, never client-asserted. A caller cannot declare a product
       -- structured-verified by sending a field; verification reflects what the
       -- catalog actually contains.
       private.catalog_verification_status(_product_id, _product_version_id),
       -- Interaction review is a practitioner act recorded by its own action;
       -- an autosave can never claim it happened.
       'not_completed',
       _item->>'affiliateUrl');
    _idx := _idx + 1;
  end loop;

  select * into _v from public.protocol_versions where id = _version_id;
  return jsonb_build_object('ok', true, 'versionId', _version_id,
    'updatedAt', _v.updated_at, 'message', 'Draft saved.');
end;
$$;
revoke all on function public.save_protocol_draft(uuid, jsonb, timestamptz) from public, anon;
grant execute on function public.save_protocol_draft(uuid, jsonb, timestamptz) to authenticated, service_role;


commit;
