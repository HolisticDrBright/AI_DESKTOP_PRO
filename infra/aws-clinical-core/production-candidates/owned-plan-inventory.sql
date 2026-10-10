-- Separately built forward candidate. No reference rows, approvals, identities or activation
-- are seeded; historical catalog/adoption bytes remain unchanged.

-- A human admin verifies the FULL label and its canonical ingredient mapping.
-- Existing append-only verification history records their identity and time.
-- Historical prose notes are not full inventories. R/S sources stay held.
create function clinical_core.verify_product_ingredient_inventory(_version uuid,_release jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare _product clinical_reference.catalog_product_versions; _key text;
begin
  perform clinical_private.require_catalog_member(clinical_private.organization_id(),true);
  if _version is null or _release is null or jsonb_typeof(_release)<>'object' or length(_release::text)>2000 then
    raise exception using errcode='22023',message='ingredient_inventory_invalid';
  end if;
  for _key in select jsonb_object_keys(_release) loop
    if _key not in ('contract','productId','productVersion','productContentSha256','labelVersionId','labelSha256',
      'completeness','sourceVerification','ingredientKeys','sourceRefs') then
      raise exception using errcode='22023',message='ingredient_inventory_invalid';
    end if;
  end loop;
  select * into _product from clinical_reference.catalog_product_versions where id=_version;
  if not found or _product.label_sha256 is null
    or _release->>'contract' is distinct from 'production-catalog-ingredient-release/1'
    or _release->>'productId' is distinct from _product.product_stable_id
    or _release->'productVersion' is distinct from to_jsonb(_product.version)
    or _release->>'productContentSha256' is distinct from _product.content_sha256
    or _release->>'labelVersionId' is distinct from _version::text
    or _release->>'labelSha256' is distinct from _product.label_sha256
    or _release->>'completeness' is distinct from 'complete'
    or _release->>'sourceVerification' is distinct from 'V'
    or jsonb_typeof(_release->'ingredientKeys') is distinct from 'array'
    or jsonb_typeof(_release->'sourceRefs') is distinct from 'array' then
    raise exception using errcode='22023',message='ingredient_inventory_invalid';
  end if;
  if jsonb_array_length(_release->'ingredientKeys') not between 1 and 40
    or jsonb_array_length(_release->'sourceRefs') not between 1 and 100
    or exists(select 1 from jsonb_array_elements(_release->'ingredientKeys') k
      where jsonb_typeof(k)<>'string' or k#>>'{}' !~ '^[a-z0-9][a-z0-9_.:-]{0,159}$')
    or (select count(distinct k) from jsonb_array_elements_text(_release->'ingredientKeys') k)<>jsonb_array_length(_release->'ingredientKeys')
    or exists(select 1 from jsonb_array_elements(_release->'sourceRefs') s
      where jsonb_typeof(s)<>'string' or not _product.source_refs @> jsonb_build_array(s))
    or (select count(distinct s) from jsonb_array_elements_text(_release->'sourceRefs') s)<>jsonb_array_length(_release->'sourceRefs') then
    raise exception using errcode='22023',message='ingredient_inventory_invalid';
  end if;
  perform clinical_core.verify_product_label_version(_version,_release::text);
end $$;

create function clinical_core.withdraw_product_ingredient_inventory(_version uuid,_reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform clinical_private.require_catalog_member(clinical_private.organization_id(),true);
  if _version is null or coalesce(length(btrim(_reason)),0) not between 1 and 1000 then
    raise exception using errcode='22023',message='ingredient_inventory_invalid';
  end if;
  perform clinical_core.verify_product_label_version(_version,jsonb_build_object(
    'contract','production-catalog-ingredient-withdrawal/1','reason',btrim(_reason))::text);
end $$;

-- Consumer-specific security-definer read, not general catalog table access.
-- The owner lock is shared with adoption, writes and consent withdrawal. The
-- record, pointer and catalog are read by one statement in the same database.
create function clinical_core.get_owned_plan_inventory_source()
returns jsonb language plpgsql security definer set search_path='' as $$
declare _owner uuid:=clinical_private.owned_consumer_actor(); _source jsonb;
begin
  if clinical_private.claim('purpose') is distinct from 'clinical_data' then
    raise exception using errcode='22023',message='owned_inventory_request_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_owner::text,0));
  if clinical_private.owned_consumer_consent(_owner,'protocols_supplements') is null then
    raise exception using errcode='42501',message='consumer_storage_consent_required';
  end if;
  with plan as materialized (select clinical_private.owned_active_plan_json(_owner) as state),
    stored as materialized (select plan.state,case when plan.state->'current'<>'null'::jsonb
      then clinical_core.get_owned_consumer_record('protocols',(plan.state->'current'->>'recordId')::uuid) else null end as record from plan)
  select jsonb_build_object('ownerId',_owner,'state',stored.state,'record',stored.record,
    'consentRevision',clinical_private.owned_consumer_consent(_owner,'protocols_supplements'),
    'asOf',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'catalog',coalesce((select jsonb_agg(c.result order by c.product_id) from (
      select p.stable_id as product_id,jsonb_build_object('productId',p.stable_id,'productVersion',v.version,
        'productContentSha256',v.content_sha256,'labelVersionId',v.id,'labelSha256',v.label_sha256,
        'sourceRefs',v.source_refs,'verificationNote',verification.verification_note) as result
      from clinical_reference.catalog_products p
      join clinical_reference.catalog_product_versions v on v.product_stable_id=p.stable_id and v.version=p.active_version
      join lateral (select q.verification_note from clinical_reference.product_label_verifications q
        where q.product_version_id=v.id order by q.verified_at desc,q.id desc limit 1) verification on true
      where p.review_status='approved' and v.review_status='approved' and p.environment='production-clinical'
        and p.contains_phi=false and v.label_sha256 is not null
        and p.stable_id in (select e->'governedProduct'->>'productId' from jsonb_array_elements(
          case when jsonb_typeof(stored.record->'payload'->'supplements_json')='array'
            then stored.record->'payload'->'supplements_json' else '[]'::jsonb end) e)
    ) c),'[]'::jsonb)) into _source from stored;
  return _source;
end $$;
revoke all on function clinical_core.verify_product_ingredient_inventory(uuid,jsonb),clinical_core.withdraw_product_ingredient_inventory(uuid,text),clinical_core.get_owned_plan_inventory_source() from public;
grant execute on function clinical_core.verify_product_ingredient_inventory(uuid,jsonb),clinical_core.withdraw_product_ingredient_inventory(uuid,text),clinical_core.get_owned_plan_inventory_source() to clinical_core_api;
