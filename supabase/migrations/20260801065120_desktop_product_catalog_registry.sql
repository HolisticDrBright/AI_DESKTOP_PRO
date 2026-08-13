-- Phase 9B: the Product Catalog registry read surface.
--
-- The catalog UI needs verification state, label version history, ingredients,
-- warnings, catalog mappings, import provenance, and the review queue. It also
-- needs commercial disclosure — and that is the whole reason this is one
-- carefully shaped RPC rather than a handful of table reads.
--
-- THE COMMERCIAL FIREWALL, RESTATED AS A SHAPE.
--
-- Commercial data is returned under its own top-level `commercial` key, built
-- from its own table, and NOTHING under `clinical` is computed from it. That is
-- not a convention a reviewer has to take on trust: the acceptance suite reads
-- the function body and fails if any clinical field's expression mentions the
-- commercial tables. An affiliate link cannot change eligibility, ranking,
-- safety or evidence here because there is no code path along which it could.
--
-- UNKNOWN STAYS UNKNOWN. `exact_label` holds only what was actually captured
-- from a label. Absent keys come back as SQL NULL and render as "Unknown".
-- Nothing is inferred from a product name — not an ingredient, not a warning,
-- not a regulatory status.

begin;

/**
 * Everything the catalog list view shows, plus the counts it reports.
 *
 * Deliberately returns zero rows rather than sample content when the registry
 * is empty: an empty governed catalog is the honest state until an operator
 * imports one, and a placeholder product is indistinguishable from a real one
 * at a glance.
 */
create or replace function public.get_product_catalog(
  _organization_id uuid,
  _query text default null,
  _status text default null,
  _limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare _rows jsonb; _counts jsonb; _queue jsonb; _n integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if _status is not null and _status not in ('draft','published','superseded','withdrawn') then
    raise exception 'unknown status filter' using errcode = '22023';
  end if;
  _n := least(greatest(coalesce(_limit, 100), 1), 500);

  -- One row per PRODUCT CODE, showing its current version. A product whose
  -- label was reissued is one entry with a history, not several entries.
  with latest as (
    select distinct on (v.product_code) v.*
    from public.product_label_versions v
    where v.organization_id = _organization_id
      and (_status is null or v.status = _status)
      and (_query is null or _query = ''
           or v.product_name ilike '%' || _query || '%'
           or v.brand ilike '%' || _query || '%'
           or v.product_code ilike '%' || _query || '%')
    order by v.product_code, v.version desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'labelVersionId', l.id,
    'productCode', l.product_code,
    'productName', l.product_name,
    'brand', l.brand,
    'version', l.version,
    'status', l.status,
    'labelSha256', l.label_sha256,
    'sourceUrl', l.source_url,
    'effectiveAt', l.effective_at,
    'expiresAt', l.expires_at,
    'verifiedAt', l.verified_at,
    -- DERIVED, never asserted by a caller. "verified" means a named person
    -- checked this exact label; nothing else may set it.
    'verificationState',
      case when l.verified_at is not null then 'verified' else 'unverified' end,
    'versionCount', (
      select count(*) from public.product_label_versions h
      where h.organization_id = _organization_id and h.product_code = l.product_code),
    'ingredientCount', jsonb_array_length(
      coalesce(l.exact_label->'ingredientRows', '[]'::jsonb)),
    'hasWarnings', coalesce(nullif(btrim(coalesce(l.exact_label->>'warnings','')), ''), null)
      is not null,
    -- A COUNT of commercial links, never their content, and never anything
    -- derived from them. The list view says "3 commercial links recorded" so an
    -- operator knows to look; it cannot sort or filter by them.
    'commercialLinkCount', (
      select count(*) from public.product_label_commercial_links c
      where c.label_version_id = l.id and c.revoked_at is null),
    'commercialDisclosureComplete', not exists (
      select 1 from public.product_label_commercial_links c
      where c.label_version_id = l.id and c.revoked_at is null
        and c.kind = 'affiliate' and c.url is not null
        and c.commission_disclosure is null))
    order by l.product_name, l.product_code), '[]'::jsonb)
  into _rows
  from (select * from latest limit _n) l;

  select jsonb_build_object(
    'total', count(*),
    'verified', count(*) filter (where verified_at is not null),
    'unverified', count(*) filter (where verified_at is null),
    'published', count(*) filter (where status = 'published'),
    'draft', count(*) filter (where status = 'draft'))
  into _counts
  from public.product_label_versions
  where organization_id = _organization_id;

  -- Import rows still awaiting a decision. This is real queued work, not a
  -- badge: an empty queue means nothing is waiting, which is worth stating.
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', i.id,
    'displayName', i.display_name,
    'externalKey', i.external_key,
    'changeKind', i.change_kind,
    'sourceName', b.source_name,
    'validationErrors', i.validation_errors,
    'conflictReason', i.conflict_reason,
    'createdAt', i.created_at)
    order by i.created_at), '[]'::jsonb)
  into _queue
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where i.organization_id = _organization_id
    and i.entity_type = 'product_label'
    and i.status = 'needs_review';

  return jsonb_build_object(
    'clinical', jsonb_build_object('products', _rows, 'counts', _counts),
    'reviewQueue', _queue,
    'generatedAt', now(),
    'emptyStateMessage',
      'No governed product labels have been imported yet. This list stays '
      || 'empty until an operator imports exact labels — no example products '
      || 'are shown, because a placeholder is indistinguishable from a real '
      || 'product at a glance.',
    'commercialPolicy',
      'Commercial links are recorded in a separate table and are never an '
      || 'input to eligibility, ranking, safety or evidence. This list can '
      || 'report that links exist; it cannot sort or filter by them.',
    'unknownPolicy',
      'Only what was captured from an exact label is shown. Anything not '
      || 'recorded reads as Unknown. Nothing is inferred from a product name.');
end;
$fn$;

revoke all on function public.get_product_catalog(uuid, text, text, integer)
  from public, anon;
grant execute on function public.get_product_catalog(uuid, text, text, integer)
  to authenticated;

/**
 * One label version in full: the exact label, its version history, the catalog
 * product it maps to, where it came from, and — separately — its commercial
 * links.
 */
create or replace function public.get_product_label_detail(_label_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare
  _v public.product_label_versions%rowtype;
  _versions jsonb; _imports jsonb; _commercial jsonb; _mapping jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _v from public.product_label_versions where id = _label_version_id;
  if not found then
    raise exception 'product label version not found' using errcode = 'P0002';
  end if;
  if not private.is_org_member(_v.organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'labelVersionId', h.id, 'version', h.version, 'status', h.status,
    'labelSha256', h.label_sha256, 'effectiveAt', h.effective_at,
    'expiresAt', h.expires_at, 'verifiedAt', h.verified_at,
    'verificationNote', h.verification_note, 'createdAt', h.created_at)
    order by h.version desc), '[]'::jsonb)
  into _versions
  from public.product_label_versions h
  where h.organization_id = _v.organization_id and h.product_code = _v.product_code;

  -- Provenance: which import, from which source file, wrote this row.
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', i.id, 'sourceName', b.source_name,
    'sourceFilename', b.source_filename,
    'sourceSha256', b.source_sha256,
    'changeKind', i.change_kind, 'status', i.status,
    'reviewedAt', i.reviewed_at, 'importedAt', b.committed_at)
    order by b.committed_at desc nulls last), '[]'::jsonb)
  into _imports
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where i.applied_ref_type = 'product_label' and i.applied_ref_id = _v.id;

  -- The mapping to the structured catalog, if one was made. Matched on the
  -- recorded SKU/UPC only — never on a name, because two products can share a
  -- name and mapping the wrong one silently changes what a protocol means.
  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', p.id, 'name', p.name, 'form', p.form,
    'sku', p.sku, 'upc', p.upc)), '[]'::jsonb)
  into _mapping
  from public.supplement_products p
  where (p.sku is not null and p.sku = _v.exact_label->>'sku')
     or (p.upc is not null and p.upc = _v.exact_label->>'upc');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'url', c.url,
    'supplierName', c.supplier_name,
    'commissionDisclosure', c.commission_disclosure,
    'availabilityStatus', c.availability_status,
    'lastVerifiedAt', c.last_verified_at,
    'revokedAt', c.revoked_at, 'revokedReason', c.revoked_reason,
    'recordedAt', c.recorded_at)
    order by c.recorded_at desc), '[]'::jsonb)
  into _commercial
  from public.product_label_commercial_links c
  where c.label_version_id = _v.id;

  return jsonb_build_object(
    -- Everything clinical lives under this key and is built only from the
    -- label and the registry. The acceptance suite asserts that no expression
    -- inside this branch touches a commercial table.
    'clinical', jsonb_build_object(
      'labelVersionId', _v.id,
      'productCode', _v.product_code,
      'productName', _v.product_name,
      'brand', _v.brand,
      'version', _v.version,
      'status', _v.status,
      'labelSha256', _v.label_sha256,
      'sourceUrl', _v.source_url,
      'effectiveAt', _v.effective_at,
      'expiresAt', _v.expires_at,
      'verifiedAt', _v.verified_at,
      'verificationNote', _v.verification_note,
      'verificationState',
        case when _v.verified_at is not null then 'verified' else 'unverified' end,
      -- Straight from the captured label. Absent keys stay NULL -> "Unknown".
      'servingSize', _v.exact_label->>'servingSize',
      'servingsPerContainer', _v.exact_label->>'servingsPerContainer',
      'ingredients', _v.exact_label->>'ingredients',
      'ingredientRows', coalesce(_v.exact_label->'ingredientRows', '[]'::jsonb),
      'otherIngredients', _v.exact_label->>'otherIngredients',
      'allergens', _v.exact_label->>'allergens',
      'directions', _v.exact_label->>'directions',
      'warnings', _v.exact_label->>'warnings',
      'storage', _v.exact_label->>'storage',
      'jurisdiction', _v.exact_label->>'jurisdiction',
      'sku', _v.exact_label->>'sku',
      'upc', _v.exact_label->>'upc',
      'versions', _versions,
      'catalogMappings', _mapping,
      'importHistory', _imports),
    'commercial', jsonb_build_object(
      'links', _commercial,
      'disclosureComplete', not exists (
        select 1 from public.product_label_commercial_links c
        where c.label_version_id = _v.id and c.revoked_at is null
          and c.kind = 'affiliate' and c.url is not null
          and c.commission_disclosure is null),
      'notice',
        'Commercial information is stored separately from clinical data and '
        || 'has no effect on eligibility, ranking, safety or evidence. An '
        || 'affiliate link with no completed disclosure must not be shown to '
        || 'a patient.'),
    'unknownPolicy',
      'Fields that were not captured from the label are Unknown. They are not '
      || 'inferred from the product name, the brand, or any other product.');
end;
$fn$;

revoke all on function public.get_product_label_detail(uuid) from public, anon;
grant execute on function public.get_product_label_detail(uuid) to authenticated;

commit;
