-- Phase 9C: the reads the review workspace needs.
--
-- The safety layer refuses things. A reviewer cannot act on a refusal they
-- cannot see, so this migration is the other half: the reads that put a
-- refusal, its reason, and the evidence behind it on one screen.
--
-- FOUR THINGS THE WORKSPACE COULD NOT ASK FOR BEFORE:
--
--   1. WHAT DID THIS ROW BRING? `get_knowledge_import_preview` returned the
--      normalised payload and nothing else. It now returns the verbatim source
--      row, the restricted flags, the missing facts and the candidate matches —
--      the four things a reviewer needs in order to be the one deciding.
--   2. WHICH FIELDS ACTUALLY CHANGED? A `change` row said "something moved".
--      `private.import_item_field_diffs` says which fields, with the current
--      value beside the incoming one. Approving a diff you cannot see is
--      approving a summary.
--   3. WHERE DID THIS RECORD COME FROM? `get_import_provenance` reads the
--      append-only ledger.
--   4. WHAT IS STILL WAITING? `get_catalog_review_queue` lists the imported
--      products that are not yet usable, and says for each one WHY —
--      `private.catalog_product_block_reason`, the same function the attach
--      trigger raises. One answer, so the screen and the refusal cannot drift.
--
-- And one write: `complete_catalog_product_review`, which is how a product
-- leaves the review state deliberately. It refuses `incomplete` outright and
-- names what the source did not supply, because "complete the review" must not
-- become the button that makes missing label data stop being missing.

begin;

-- ------------------------------------------------------------- field diffs
--
-- Only for catalog products against a governed row. Every other entity type
-- returns an empty array rather than a guess: a diff implies the two sides are
-- comparable, and inventing that for an entity this function does not
-- understand would be a claim about clinical content.
--
-- A NULL incoming value is NOT a diff. The source not mentioning a field is
-- silence, and rendering silence as "changing X to nothing" would turn an
-- absent column into a deletion the practitioner never asked for.

create or replace function private.import_item_field_diffs(
  _entity_type text, _payload jsonb, _ref_type text, _ref_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare _p public.supplement_products%rowtype; _out jsonb := '[]'::jsonb;
begin
  if _entity_type <> 'catalog_product' or _ref_type <> 'supplement_product'
     or _ref_id is null then
    return _out;
  end if;
  select * into _p from public.supplement_products where id = _ref_id;
  if not found then
    return _out;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'field', d.field, 'current', d.current_value, 'incoming', d.incoming)
    order by d.field), '[]'::jsonb)
  into _out
  from (
    values
      ('name', _p.name, _payload ->> 'name'),
      ('brand', (select b.name from public.supplement_brands b where b.id = _p.brand_id),
        _payload ->> 'brand'),
      ('form', _p.form, _payload ->> 'form'),
      ('sku', _p.sku, _payload ->> 'sku'),
      ('upc', _p.upc, _payload ->> 'upc'),
      ('manufacturerIdentifier', _p.manufacturer_identifier,
        _payload ->> 'manufacturerIdentifier'),
      ('category', _p.category, _payload ->> 'category'),
      ('regulatoryClassification', _p.regulatory_classification,
        _payload ->> 'regulatoryClassification'),
      ('jurisdiction', _p.jurisdiction, _payload ->> 'jurisdiction'),
      ('description', _p.description, _payload ->> 'description')
  ) as d(field, current_value, incoming)
  where coalesce(btrim(d.current_value), '') is distinct from coalesce(btrim(d.incoming), '')
    and d.incoming is not null;

  return _out;
end;
$fn$;

-- ------------------------------------------------------------- the preview
--
-- Restated in full. The additions are the last six item keys and the two batch
-- counters; nothing that was returned before has changed shape, so the Phase 9B
-- reader keeps working.

create or replace function public.get_knowledge_import_preview(_batch_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _b public.clinical_knowledge_import_batches%rowtype; _items jsonb; _removals jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _b from public.clinical_knowledge_import_batches where id = _batch_id;
  if not found then
    raise exception 'import batch not found' using errcode = 'P0002';
  end if;
  if not private.is_org_member(_b.organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'entityType', i.entity_type, 'displayName', i.display_name,
    'sourceSheet', i.source_sheet, 'sourceRowNumber', i.source_row_number,
    'dedupeKey', i.dedupe_key, 'changeKind', i.change_kind,
    'status', i.status, 'payloadSha256', i.payload_sha256,
    'existingRefType', i.existing_ref_type, 'existingRefId', i.existing_ref_id,
    'conflictWithItemId', i.conflict_with_item_id,
    'conflictReason', i.conflict_reason,
    'conflictResolution', i.conflict_resolution,
    'validationErrors', i.validation_errors, 'warnings', i.warnings,
    'reviewNote', i.review_note,
    'appliedRefType', i.applied_ref_type, 'appliedRefId', i.applied_ref_id,
    'sourceRaw', i.source_raw,
    'restrictedFlags', to_jsonb(i.restricted_flags),
    'restrictedReason', i.restricted_reason,
    'missingFacts', i.missing_facts,
    'candidateMatches', i.candidate_matches,
    'fieldDiffs', private.import_item_field_diffs(
      i.entity_type, i.payload, i.existing_ref_type, i.existing_ref_id))
    order by i.source_row_number, i.created_at), '[]'::jsonb)
  into _items
  from public.clinical_knowledge_import_items i where i.batch_id = _batch_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'entityType', s.entity_type, 'dedupeKey', s.dedupe_key,
    'refType', s.ref_type, 'refId', s.ref_id)), '[]'::jsonb)
  into _removals
  from public.clinical_knowledge_import_state s
  where s.organization_id = _b.organization_id
    and s.source_kind is not distinct from _b.source_kind
    and _b.source_kind is not null
    and not exists (
      select 1 from public.clinical_knowledge_import_items i
      where i.batch_id = _batch_id
        and i.entity_type = s.entity_type and i.dedupe_key = s.dedupe_key);

  return jsonb_build_object(
    'batch', jsonb_build_object(
      'id', _b.id, 'status', _b.status, 'sourceName', _b.source_name,
      'sourceKind', _b.source_kind, 'sourceFilename', _b.source_filename,
      'sourceByteSize', _b.source_byte_size, 'sourceSha256', _b.source_sha256,
      'schemaVersion', _b.schema_version, 'itemCount', _b.item_count,
      'added', _b.added_count, 'changed', _b.changed_count,
      'unchanged', _b.unchanged_count, 'conflicts', _b.conflict_count,
      'removals', _b.removed_count,
      'ambiguous', _b.ambiguous_count, 'restricted', _b.restricted_count,
      'previewGeneratedAt', _b.preview_generated_at,
      'committedAt', _b.committed_at, 'createdAt', _b.created_at),
    'items', _items,
    'reportedRemovals', _removals,
    'removalPolicy', 'Removals are reported for review only. This pipeline '
      || 'never deletes governed clinical content; retire a record deliberately '
      || 'with its own action and reason.');
end;
$$;

revoke all on function public.get_knowledge_import_preview(uuid) from public, anon;
grant execute on function public.get_knowledge_import_preview(uuid) to authenticated;

-- ------------------------------------------------------- provenance history

create or replace function public.get_import_provenance(
  _organization_id uuid, _ref_type text default null, _ref_id uuid default null,
  _limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare _rows jsonb; _n integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  _n := least(greatest(coalesce(_limit, 50), 1), 200);

  select coalesce(jsonb_agg(r order by r->>'importedAt' desc), '[]'::jsonb) into _rows
  from (
    select jsonb_build_object(
      'id', pr.id, 'refType', pr.ref_type, 'refId', pr.ref_id,
      'batchId', pr.batch_id, 'itemId', pr.item_id,
      'sourceFileName', pr.source_file_name,
      'sourceFileSha256', pr.source_file_sha256,
      'sourceSheet', pr.source_sheet, 'sourceRowNumber', pr.source_row_number,
      'payloadSha256', pr.payload_sha256,
      'rawValues', pr.raw_values, 'normalizedValues', pr.normalized_values,
      'missingFacts', pr.missing_facts,
      'restrictedFlags', to_jsonb(pr.restricted_flags),
      'importedAt', pr.imported_at,
      'batchSourceName', b.source_name) as r
    from public.clinical_import_provenance pr
    join public.clinical_knowledge_import_batches b on b.id = pr.batch_id
    where pr.organization_id = _organization_id
      and (_ref_type is null or pr.ref_type = _ref_type)
      and (_ref_id is null or pr.ref_id = _ref_id)
    order by pr.imported_at desc
    limit _n
  ) s;

  select count(*) into _n from public.clinical_import_provenance pr
  where pr.organization_id = _organization_id;

  return jsonb_build_object(
    'records', _rows,
    'total', _n,
    'immutable', true,
    'emptyStateMessage',
      'No governed record in this organization was created by an import. '
      || 'That is a statement about the import history, not about the catalog.');
end;
$fn$;

revoke all on function public.get_import_provenance(uuid, text, uuid, integer)
  from public, anon;
grant execute on function public.get_import_provenance(uuid, text, uuid, integer)
  to authenticated;

-- ----------------------------------------------------------- review queue
--
-- `blockReason` comes from `private.catalog_product_block_reason` — the SAME
-- function the attach trigger raises. The screen and the refusal cannot
-- disagree, because there is one sentence and both read it.
--
-- Scoped to products carrying a provenance row. A product a practitioner typed
-- in is not waiting for anything and does not belong in a queue.

create or replace function public.get_catalog_review_queue(_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare _rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(r order by r->>'name'), '[]'::jsonb) into _rows
  from (
    select jsonb_build_object(
      'productId', p.id, 'name', p.name, 'brand', b.name,
      'sku', p.sku, 'upc', p.upc, 'status', p.status,
      'restrictedFlags', to_jsonb(p.restricted_flags),
      'restrictedClearedAt', p.restricted_cleared_at,
      'restrictedClearanceNote', p.restricted_clearance_note,
      'selectable', private.catalog_product_is_selectable(p.id),
      'blockReason', private.catalog_product_block_reason(p.id),
      'missingFacts', coalesce((
        select pr.missing_facts from public.clinical_import_provenance pr
        where pr.ref_type = 'supplement_product' and pr.ref_id = p.id
        order by pr.imported_at desc limit 1), '[]'::jsonb),
      'sourceFileName', (
        select pr.source_file_name from public.clinical_import_provenance pr
        where pr.ref_type = 'supplement_product' and pr.ref_id = p.id
        order by pr.imported_at desc limit 1)) as r
    from public.supplement_products p
    left join public.supplement_brands b on b.id = p.brand_id
    where (p.status <> 'active' or p.restricted_flags <> '{}')
      and exists (
        select 1 from public.clinical_import_provenance pr
        where pr.ref_type = 'supplement_product' and pr.ref_id = p.id
          and pr.organization_id = _organization_id)
  ) s;

  return jsonb_build_object(
    'products', _rows,
    'counts', jsonb_build_object(
      'total', jsonb_array_length(_rows),
      'restricted', (
        select count(*) from jsonb_array_elements(_rows) e
        where jsonb_array_length(e -> 'restrictedFlags') > 0),
      'notSelectable', (
        select count(*) from jsonb_array_elements(_rows) e
        where (e ->> 'selectable')::boolean is not true)),
    'emptyStateMessage',
      'No imported product is waiting for review. Products entered by hand are '
      || 'not listed here — this queue is for records that arrived in a file.');
end;
$fn$;

revoke all on function public.get_catalog_review_queue(uuid) from public, anon;
grant execute on function public.get_catalog_review_queue(uuid) to authenticated;

-- ------------------------------------------------- completing a review
--
-- `incomplete` is REFUSED here, and the refusal names the facts the source did
-- not supply. This is the one place where "just mark it reviewed" would be
-- most tempting and most damaging: the product would become selectable while
-- the serving size it is dosed from is still absent.
--
-- Completing a review is also not approval. The message says so, because the
-- label-identity gate still stands between this product and an approved
-- protocol, and a reviewer who thinks they are finished will find that out at
-- the worst moment otherwise.

create or replace function public.complete_catalog_product_review(
  _product_id uuid, _note text)
returns jsonb language plpgsql security definer set search_path = ''
as $fn$
declare _p public.supplement_products%rowtype; _uid uuid; _missing jsonb;
begin
  select * into _p from public.supplement_products where id = _product_id for update;
  if not found then
    raise exception 'catalog product not found' using errcode = 'P0002';
  end if;
  _uid := auth.uid();
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.user_id = _uid and m.status = 'active'
      and m.role in ('owner', 'admin', 'practitioner')) then
    raise exception 'completing a catalog review requires a clinical role'
      using errcode = '42501';
  end if;
  if coalesce(btrim(_note), '') = '' then
    raise exception 'completing a review requires a stated reason' using errcode = '22023';
  end if;
  if _p.status not in ('draft', 'incomplete', 'needs_review') then
    raise exception 'this product is not in a review state' using errcode = '55000';
  end if;

  select pr.missing_facts into _missing from public.clinical_import_provenance pr
  where pr.ref_type = 'supplement_product' and pr.ref_id = _product_id
  order by pr.imported_at desc limit 1;

  if _p.status = 'incomplete' then
    raise exception 'this product is incomplete: the source did not supply %. Record the missing facts against the product before completing its review.',
      coalesce(nullif((select string_agg(value, ', ')
                       from jsonb_array_elements_text(coalesce(_missing, '[]'::jsonb))), ''),
               'required label detail')
      using errcode = '55000';
  end if;

  update public.supplement_products
  set status = 'active', updated_by = _uid, updated_at = now()
  where id = _product_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  select m.organization_id, _uid, 'catalog.review_completed',
         'supplement_product', _product_id::text,
         'An imported catalog product completed review',
         jsonb_build_object('note', btrim(_note))
  from public.organization_memberships m
  where m.user_id = _uid and m.status = 'active'
    and m.role in ('owner', 'admin', 'practitioner')
  limit 1;

  return jsonb_build_object('ok', true, 'productId', _product_id,
    'status', 'active',
    'message', 'Review complete. The product is now selectable. It still cannot '
      || 'reach an APPROVED protocol until a reviewer verifies its exact label '
      || 'identity against the manufacturer.');
end;
$fn$;

revoke all on function public.complete_catalog_product_review(uuid, text)
  from public, anon;
grant execute on function public.complete_catalog_product_review(uuid, text)
  to authenticated;

commit;
