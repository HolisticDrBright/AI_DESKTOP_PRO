-- BLOCKED source candidate, dependent on current-workforce context and
-- production-catalog-source-verification.sql. Not registered or activated.
-- This is a workforce reference projection only. No offer or purchase fields.

create or replace function clinical_core.list_current_catalog_reference(
  _cursor text default null, _limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  _products jsonb;
  _has_more boolean;
  _last text;
begin
  if _limit is null or _limit not between 1 and 100
    or (_cursor is not null and _cursor !~ '^prd_[a-z0-9][a-z0-9_-]{2,95}$') then
    raise exception using errcode='22023', message='catalog_page_invalid';
  end if;
  perform clinical_private.require_catalog_member(clinical_private.organization_id(), false);

  with page as materialized (
    select p.stable_id, v.id as label_version_id, v.version, v.display_name,
           v.brand, v.product_type, v.access_tier, v.declared_restricted,
           v.direct_order_allowed, v.content_sha256, v.label_sha256,
           v.source_refs, b.manifest_sha256
      from clinical_reference.catalog_products p
      join clinical_reference.catalog_product_versions v
        on v.product_stable_id=p.stable_id and v.version=p.active_version
      join clinical_reference.catalog_import_batches b on b.id=v.import_batch_id
     where p.review_status='approved' and v.review_status='approved'
       and p.environment='production-clinical' and p.contains_phi=false
       and b.environment='production-clinical' and b.contains_phi=false
       and b.status='succeeded'
       and (_cursor is null or p.stable_id>_cursor)
     order by p.stable_id limit _limit+1
  ), selected as (
    select * from page order by stable_id limit _limit
  )
  select coalesce((select jsonb_agg(jsonb_build_object(
      'productId', s.stable_id, 'productVersion', s.version,
      'displayName', s.display_name, 'brand', s.brand,
      'productType', s.product_type, 'accessTier', s.access_tier,
      'declaredRestricted', s.declared_restricted,
      'declaredDirectOrderAllowed', s.direct_order_allowed,
      'labelVersionId', s.label_version_id, 'labelSha256', s.label_sha256,
      'productContentSha256', s.content_sha256,
      'sourceRefs', s.source_refs, 'importManifestSha256', s.manifest_sha256,
      'sourceVerified', clinical_private.current_catalog_source_v(s.label_version_id)
    ) order by s.stable_id) from selected s), '[]'::jsonb),
    (select count(*)>_limit from page),
    (select max(stable_id) from selected)
    into _products, _has_more, _last;

  return jsonb_build_object(
    'contractVersion','production-catalog-reference/1',
    'audience','workforce', 'products',_products,
    'nextCursor',case when _has_more then _last else null end
  );
end $$;

revoke all on function clinical_core.list_current_catalog_reference(text,integer) from public;
grant execute on function clinical_core.list_current_catalog_reference(text,integer)
  to clinical_core_api;
