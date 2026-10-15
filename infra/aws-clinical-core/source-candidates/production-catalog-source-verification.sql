-- BLOCKED source candidate. No migration registration, release row or patient-facing activation.
-- Reusable exact-source verification for a future production catalog projection.
-- The caller-facing projection must establish current clinic membership separately.

create or replace function clinical_private.current_catalog_source_v(_product_version_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  _version record;
  _verification record;
  _proof jsonb;
begin
  select v.id, v.product_stable_id, v.version, v.content_sha256, v.label_sha256,
         v.source_refs, v.review_status as version_status, v.import_batch_id,
         p.review_status as product_status, p.active_version, p.environment,
         p.contains_phi, b.status as batch_status
    into _version
    from clinical_reference.catalog_product_versions v
    join clinical_reference.catalog_products p on p.stable_id = v.product_stable_id
    join clinical_reference.catalog_import_batches b on b.id = v.import_batch_id
   where v.id = _product_version_id;
  if not found or _version.product_status <> 'approved'
    or _version.version_status <> 'approved'
    or _version.active_version <> _version.version
    or _version.environment <> 'production-clinical'
    or _version.contains_phi is distinct from false
    or _version.batch_status <> 'succeeded'
    or _version.label_sha256 is null then
    return false;
  end if;

  -- The latest verification event is authoritative. A later withdrawal, free-text
  -- note, invalid JSON or disabled reviewer withholds the earlier source-V release.
  select q.verification_note, reviewer.status as reviewer_status
    into _verification
    from clinical_reference.product_label_verifications q
    join clinical_core.persons reviewer on reviewer.id = q.reviewer_person_id
   where q.product_version_id = _version.id
   order by q.verified_at desc, q.id desc limit 1;
  if not found or _verification.reviewer_status <> 'active' then return false; end if;
  begin
    _proof := _verification.verification_note::jsonb;
  exception when invalid_text_representation then
    return false;
  end;
  if jsonb_typeof(_proof) is distinct from 'object'
    or not (_proof ?& array['contract','productId','productVersion','productContentSha256',
                            'labelVersionId','labelSha256','completeness','sourceVerification',
                            'ingredientKeys','sourceRefs'])
    or _proof - array['contract','productId','productVersion','productContentSha256',
                      'labelVersionId','labelSha256','completeness','sourceVerification',
                      'ingredientKeys','sourceRefs'] <> '{}'::jsonb
    or (_proof->>'contract') is distinct from 'production-catalog-ingredient-release/1'
    or (_proof->>'productId') is distinct from _version.product_stable_id
    or (_proof->'productVersion') is distinct from to_jsonb(_version.version)
    or (_proof->>'productContentSha256') is distinct from _version.content_sha256
    or (_proof->>'labelVersionId') is distinct from _version.id::text
    or (_proof->>'labelSha256') is distinct from _version.label_sha256
    or (_proof->>'completeness') is distinct from 'complete'
    or (_proof->>'sourceVerification') is distinct from 'V'
    or jsonb_typeof(_proof->'ingredientKeys') is distinct from 'array'
    or jsonb_typeof(_proof->'sourceRefs') is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(_proof->'ingredientKeys') not between 1 and 40
    or jsonb_array_length(_proof->'sourceRefs') not between 1 and 100
    or (select count(distinct value) from jsonb_array_elements(_proof->'ingredientKeys'))
       <> jsonb_array_length(_proof->'ingredientKeys')
    or (select count(distinct value) from jsonb_array_elements(_proof->'sourceRefs'))
       <> jsonb_array_length(_proof->'sourceRefs')
    or exists(select 1 from jsonb_array_elements(_proof->'ingredientKeys') k
              where jsonb_typeof(k.value) <> 'string'
                or k.value #>> '{}' !~ '^[a-z0-9][a-z0-9_.:-]{0,159}$')
    or exists(select 1 from jsonb_array_elements(_proof->'sourceRefs') s
              where jsonb_typeof(s.value) <> 'string'
                or length(btrim(s.value #>> '{}')) not between 1 and 4000)
    or not (_version.source_refs @> (_proof->'sourceRefs')) then
    return false;
  end if;
  return true;
end
$$;

revoke all on function clinical_private.current_catalog_source_v(uuid)
  from public, clinical_core_api;
