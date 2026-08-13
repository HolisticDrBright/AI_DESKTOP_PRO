-- Phase 9C: the apply paths that use the safety layer.
--
-- `20260801185637` built the refusals. Nothing called them. A gate nobody is
-- routed through is a comment, so this migration routes the pipeline through
-- them and gives `catalog_product` the apply path it never had.
--
-- Before this, committing a batch of products reported them `skipped` — honest,
-- and useless: the operator's product spreadsheet could be previewed, hashed,
-- deduped and committed, and no product existed afterwards. This adds the write,
-- and makes it the kind of write that is safe to have.
--
-- WHAT AN IMPORTED PRODUCT IS WHEN IT LANDS:
--
--   * NOT `active`, so `private.catalog_product_is_selectable` refuses it,
--     which means search does not offer it and `protocol_items` will not take
--     it. A spreadsheet row is a claim about a bottle nobody here has held.
--   * carrying its `restricted_flags`, computed by the classifier, uncleared.
--   * carrying a `clinical_import_provenance` row: which file, which sheet,
--     which line, the verbatim cell values, and the facts the source did not
--     supply. Append-only, so it still answers the question next year.
--
-- AND THE NEW CHANGE KIND. `ambiguous` is the case Phase 9B could not express.
-- A row whose identity matches nothing but which strongly resembles a governed
-- product is not an `add` — applying it duplicates a product. It is not a
-- `change` either — applying it as one overwrites the wrong product. Both are
-- silent, and both reach a patient. The row stops and names its candidates.

begin;

-- ===================================================== facts the source omitted
--
-- Absence recorded as absence, per the standing rule. This does not invent a
-- value and does not guess one; it says which questions the file left blank so
-- the reviewer is looking at the gap rather than at a tidy row.

create or replace function private.import_missing_facts(
  _entity_type text, _payload jsonb)
returns jsonb language plpgsql immutable set search_path = ''
as $fn$
declare _m jsonb := '[]'::jsonb;
begin
  if _entity_type = 'catalog_product' then
    if coalesce(btrim(_payload ->> 'brand'), '') = '' then
      _m := _m || '["manufacturer or brand"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'form'), '') = '' then
      _m := _m || '["dose form"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'servingSize'), '') = '' then
      _m := _m || '["serving size"]'::jsonb;
    end if;
    if jsonb_typeof(_payload -> 'ingredients') <> 'array'
       or jsonb_array_length(coalesce(_payload -> 'ingredients', '[]'::jsonb)) = 0 then
      _m := _m || '["ingredient amounts and units"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'sourceUrl'), '') = '' then
      _m := _m || '["manufacturer label reference"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'regulatoryClassification'), '') = '' then
      _m := _m || '["regulatory classification"]'::jsonb;
    end if;
  end if;
  return _m;
end;
$fn$;

-- `servingSize` and `ingredients` are what a dose is read from. Without them
-- the product is `incomplete` — a distinct state from `needs_review`, because
-- "we have not looked at this yet" and "we looked, and the file does not say"
-- are different things to tell a reviewer.
create or replace function private.import_product_review_state(_missing jsonb)
returns text language sql immutable set search_path = ''
as $fn$
  select case
    when _missing @> '["serving size"]'::jsonb
      or _missing @> '["ingredient amounts and units"]'::jsonb
    then 'incomplete' else 'needs_review' end;
$fn$;

-- ============================================================ near-identity
--
-- Candidates are products that RESEMBLE this row without sharing its identity.
-- Resemblance is judged on the normalised name, and on name-with-brand, because
-- those are the two ways an operator's second spreadsheet refers to a product
-- their first spreadsheet already loaded.
--
-- The output is a LIST FOR A HUMAN, never a match. Nothing downstream treats a
-- candidate as the row's identity — that is the whole point of stopping.

create or replace function private.import_product_candidates(_payload jsonb)
returns jsonb language plpgsql stable set search_path = ''
as $fn$
declare _name text; _brand text; _sku text; _upc text; _mid text; _out jsonb;
begin
  _name := lower(btrim(coalesce(_payload ->> 'name', '')));
  if _name = '' then
    return '[]'::jsonb;
  end if;
  _brand := lower(btrim(coalesce(_payload ->> 'brand', '')));
  _sku := nullif(lower(btrim(coalesce(_payload ->> 'sku', ''))), '');
  _upc := nullif(lower(btrim(coalesce(_payload ->> 'upc', ''))), '');
  _mid := nullif(lower(btrim(coalesce(_payload ->> 'manufacturerIdentifier', ''))), '');

  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', p.id, 'name', p.name, 'brand', b.name,
    'sku', p.sku, 'upc', p.upc, 'status', p.status,
    'why', case when lower(p.name) = _name then 'same product name'
                else 'same product name and brand' end)
    order by p.name), '[]'::jsonb)
  into _out
  from public.supplement_products p
  left join public.supplement_brands b on b.id = p.brand_id
  where lower(p.name) = _name
    and (_brand = '' or lower(coalesce(b.name, '')) = _brand)
    -- Identity NOT shared: a row that carries the same code as an existing
    -- product is a `change`, and is resolved by the dedupe key, not here.
    and (_sku is null or lower(coalesce(p.sku, '')) is distinct from _sku)
    and (_upc is null or lower(coalesce(p.upc, '')) is distinct from _upc)
    and (_mid is null
         or lower(coalesce(p.manufacturer_identifier, '')) is distinct from _mid);

  return _out;
end;
$fn$;

-- ================================================================= preview
--
-- Restated in full. The changes from `20260801032740`:
--
--   * the verbatim row (`sourceRaw` on the envelope) is stored beside the
--     normalised payload, so what normalisation discarded is still checkable;
--   * restricted flags and missing facts are computed at stage time, because a
--     reviewer deciding whether to commit needs both before they commit;
--   * `ambiguous` is detected and staged NOT APPLYABLE, like a conflict;
--   * the batch is linked to its declared source file where one was recorded,
--     so a batch can be traced to a file that was actually read.

create or replace function public.preview_knowledge_import(
  _organization_id uuid,
  _source_kind text,
  _source_name text,
  _schema_version text,
  _items jsonb,
  _attests_no_phi boolean,
  _source_filename text default null,
  _source_byte_size bigint default null,
  _source_revision text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid;
  _batch_id uuid;
  _existing_batch public.clinical_knowledge_import_batches%rowtype;
  _item jsonb;
  _entity_type text;
  _payload jsonb;
  _raw jsonb;
  _count integer;
  _hash text;
  _row integer := 0;
  _key text;
  _payload_hash text;
  _state public.clinical_knowledge_import_state%rowtype;
  _change text;
  _seen text[] := '{}';
  _dupe_of uuid;
  _errors jsonb;
  _flags text[];
  _missing jsonb;
  _candidates jsonb;
  _source_file_id uuid;
  _added integer := 0; _changed integer := 0; _unchanged integer := 0;
  _conflicts integer := 0; _removed integer := 0;
  _ambiguous integer := 0; _restricted integer := 0;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if _attests_no_phi is distinct from true then
    raise exception 'no-PHI attestation is required' using errcode = '55000';
  end if;
  if coalesce(btrim(_source_name), '') = ''
     or coalesce(btrim(_schema_version), '') = '' then
    raise exception 'source name and schema version are required' using errcode = '22023';
  end if;
  if _source_kind is not null and _source_kind not in (
     'product_spreadsheet', 'affiliate_sheet', 'protocol_document',
     'obsidian_export', 'reference_list', 'other') then
    raise exception 'unrecognised source kind' using errcode = '22023';
  end if;
  if jsonb_typeof(_items) <> 'array' then
    raise exception 'import items must be an array' using errcode = '22023';
  end if;
  _count := jsonb_array_length(_items);
  if _count < 1 or _count > 5000 then
    raise exception 'an import batch must contain between 1 and 5000 items'
      using errcode = '22023';
  end if;

  _hash := private.sha256_hex(_items::text);

  select * into _existing_batch from public.clinical_knowledge_import_batches
   where organization_id = _organization_id and source_sha256 = _hash;
  if found then
    return jsonb_build_object(
      'batchId', _existing_batch.id,
      'idempotent', true,
      'status', _existing_batch.status,
      'itemCount', _existing_batch.item_count,
      'added', _existing_batch.added_count,
      'changed', _existing_batch.changed_count,
      'unchanged', _existing_batch.unchanged_count,
      'conflicts', _existing_batch.conflict_count,
      'removals', _existing_batch.removed_count,
      'ambiguous', _existing_batch.ambiguous_count,
      'restricted', _existing_batch.restricted_count,
      'message', 'This exact file was already imported. The existing batch is '
        || 'returned unchanged; nothing was staged a second time.');
  end if;

  -- Link to the declared file if the operator recorded one. Not required: a
  -- batch may be staged before its file is inventoried, and refusing here would
  -- make the inventory a gate rather than a record.
  if coalesce(btrim(_source_filename), '') <> '' then
    select id into _source_file_id from public.clinical_import_source_files
     where organization_id = _organization_id
       and declared_name = btrim(_source_filename);
  end if;

  insert into public.clinical_knowledge_import_batches
    (organization_id, source_name, source_revision, schema_version, source_sha256,
     source_kind, source_filename, source_byte_size, status, item_count,
     preview_generated_at, no_phi_attested_by, created_by)
  values
    (_organization_id, btrim(_source_name), nullif(btrim(_source_revision), ''),
     btrim(_schema_version), _hash, _source_kind, nullif(btrim(_source_filename), ''),
     _source_byte_size, 'preview', _count, now(), _uid, _uid)
  returning id into _batch_id;

  for _item in select value from jsonb_array_elements(_items)
  loop
    _row := _row + 1;
    if jsonb_typeof(_item) <> 'object' then
      raise exception 'every import item must be an object' using errcode = '22023';
    end if;
    _entity_type := _item ->> 'entityType';
    _payload := _item -> 'payload';
    if jsonb_typeof(_payload) <> 'object' then
      raise exception 'every import item must contain an object payload'
        using errcode = '22023';
    end if;
    -- The verbatim row, when the caller supplied one. Absent is stored as an
    -- empty object rather than as the normalised payload: pretending the
    -- normalised view IS the source is exactly the loss this column prevents.
    _raw := case when jsonb_typeof(_item -> 'sourceRaw') = 'object'
                 then _item -> 'sourceRaw' else '{}'::jsonb end;

    _payload_hash := private.sha256_hex(_payload::text);
    _key := private.knowledge_import_dedupe_key(_entity_type, _payload);
    _errors := private.knowledge_import_validation_errors(_entity_type, _payload);
    _flags := private.import_restricted_flags(_entity_type, _payload);
    _missing := private.import_missing_facts(_entity_type, _payload);
    _candidates := '[]'::jsonb;
    _dupe_of := null;
    _change := null;

    if _key is not null and (_entity_type || '|' || _key) = any(_seen) then
      _change := 'conflict';
      select id into _dupe_of from public.clinical_knowledge_import_items
       where batch_id = _batch_id and entity_type = _entity_type and dedupe_key = _key
       order by source_row_number limit 1;
    else
      if _key is not null then
        _seen := _seen || (_entity_type || '|' || _key);
      end if;

      if _key is null then
        _change := 'add';
      else
        select * into _state from public.clinical_knowledge_import_state
         where organization_id = _organization_id
           and entity_type = _entity_type and dedupe_key = _key;
        if not found then
          _change := 'add';
        elsif _state.last_payload_sha256 = _payload_hash then
          _change := 'unchanged';
        else
          _change := 'change';
        end if;
      end if;

      -- Only an `add` can be ambiguous. A row that matched a governed identity
      -- is a change and needs no candidates; a row that matched nothing but
      -- looks like something is the dangerous case.
      if _change = 'add' and _entity_type = 'catalog_product' then
        _candidates := private.import_product_candidates(_payload);
        if jsonb_array_length(_candidates) > 0 then
          _change := 'ambiguous';
        end if;
      end if;
    end if;

    insert into public.clinical_knowledge_import_items
      (batch_id, organization_id, entity_type, external_key, display_name,
       source_sheet, source_row_number, dedupe_key, payload, payload_sha256,
       source_raw, restricted_flags, restricted_reason, missing_facts,
       candidate_matches, source_file_id,
       change_kind, existing_ref_type, existing_ref_id,
       conflict_with_item_id, conflict_reason,
       status, warnings, validation_errors)
    values
      (_batch_id, _organization_id, _entity_type,
       coalesce(nullif(btrim(_item ->> 'externalKey'), ''), gen_random_uuid()::text),
       coalesce(nullif(btrim(_item ->> 'displayName'), ''), 'Unnamed import item'),
       nullif(btrim(_item ->> 'sourceSheet'), ''), _row, _key,
       _payload, _payload_hash, _raw, _flags,
       case when _flags <> '{}' then
         'Flagged as restricted (' || array_to_string(_flags, ', ') || '). '
         || 'A restricted item is not usable until a named reviewer clears it.'
       end,
       _missing, _candidates, _source_file_id,
       _change,
       case when _change in ('change', 'unchanged') then _state.ref_type end,
       case when _change in ('change', 'unchanged') then _state.ref_id end,
       _dupe_of,
       case when _change = 'conflict' then
         'Another row earlier in this file claims the same identity ('
           || _key || '). Resolve which row is correct before committing.'
            when _change = 'ambiguous' then
         'This row matches no governed identity but closely resembles '
           || jsonb_array_length(_candidates)
           || ' existing product(s). Applying it would either duplicate one or '
           || 'overwrite the wrong one. Confirm which before committing.' end,
       -- Conflicting, unchanged AND ambiguous rows are staged but NOT
       -- APPLYABLE. Visible to the reviewer, inert until they decide.
       case when _change in ('unchanged', 'conflict', 'ambiguous') then 'skipped'
            else 'needs_review' end,
       case when jsonb_typeof(_item -> 'warnings') = 'array'
            then _item -> 'warnings' else '[]'::jsonb end,
       _errors);

    _added := _added + (case when _change = 'add' then 1 else 0 end);
    _changed := _changed + (case when _change = 'change' then 1 else 0 end);
    _unchanged := _unchanged + (case when _change = 'unchanged' then 1 else 0 end);
    _conflicts := _conflicts + (case when _change = 'conflict' then 1 else 0 end);
    _ambiguous := _ambiguous + (case when _change = 'ambiguous' then 1 else 0 end);
    _restricted := _restricted + (case when _flags <> '{}' then 1 else 0 end);
  end loop;

  if _source_kind is not null then
    select count(*) into _removed
    from public.clinical_knowledge_import_state s
    where s.organization_id = _organization_id
      and s.source_kind = _source_kind
      and not exists (
        select 1 from public.clinical_knowledge_import_items i
        where i.batch_id = _batch_id
          and i.entity_type = s.entity_type
          and i.dedupe_key = s.dedupe_key);
  end if;

  update public.clinical_knowledge_import_batches
  set added_count = _added, changed_count = _changed, unchanged_count = _unchanged,
      conflict_count = _conflicts, removed_count = _removed,
      ambiguous_count = _ambiguous, restricted_count = _restricted
  where id = _batch_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'knowledge.import_previewed',
     'clinical_knowledge_import_batch', _batch_id::text,
     'Import preview generated; no governed record was created or changed',
     jsonb_build_object('itemCount', _count, 'added', _added, 'changed', _changed,
       'unchanged', _unchanged, 'conflicts', _conflicts, 'removals', _removed,
       'ambiguous', _ambiguous, 'restricted', _restricted));

  return jsonb_build_object(
    'batchId', _batch_id, 'idempotent', false, 'status', 'preview',
    'itemCount', _count, 'added', _added, 'changed', _changed,
    'unchanged', _unchanged, 'conflicts', _conflicts, 'removals', _removed,
    'ambiguous', _ambiguous, 'restricted', _restricted,
    'sourceSha256', _hash,
    'message', 'Preview only. No governed record has been created or changed. '
      || 'Review every change and commit explicitly to apply.');
end;
$$;

-- ==================================================== resolving an ambiguity
--
-- Three answers, and no fourth. Either this row is a new product, or it IS one
-- of the candidates, or it should not be applied. There is deliberately no
-- "apply it and sort it out later": that is the state the ambiguity exists to
-- prevent, and it is unrecoverable once two near-identical products are live.

create or replace function public.resolve_knowledge_import_ambiguity(
  _item_id uuid, _resolution text, _note text,
  _existing_product_id uuid default null)
returns jsonb language plpgsql security definer set search_path = ''
as $fn$
declare _item public.clinical_knowledge_import_items%rowtype; _uid uuid;
begin
  select * into _item from public.clinical_knowledge_import_items
   where id = _item_id for update;
  if not found then
    raise exception 'import item not found' using errcode = 'P0002';
  end if;
  _uid := private.require_knowledge_editor(_item.organization_id);
  if _item.change_kind <> 'ambiguous' then
    raise exception 'this item is not ambiguous' using errcode = '55000';
  end if;
  if _resolution not in ('new_product', 'same_as_existing', 'skip') then
    raise exception 'resolution must be new_product, same_as_existing or skip'
      using errcode = '22023';
  end if;
  if coalesce(btrim(_note), '') = '' then
    raise exception 'resolving an ambiguity requires a stated reason'
      using errcode = '22023';
  end if;

  if _resolution = 'new_product' then
    update public.clinical_knowledge_import_items
    set change_kind = 'add', status = 'needs_review', review_note = btrim(_note),
        reviewed_by = _uid, reviewed_at = now()
    where id = _item_id;

  elsif _resolution = 'same_as_existing' then
    if _existing_product_id is null then
      raise exception 'name the existing product this row refers to'
        using errcode = '22023';
    end if;
    -- The named product must be one of the candidates this row actually
    -- raised. Accepting an arbitrary id would let a reviewer point the row at
    -- a product nobody compared it against, which is the overwrite the
    -- ambiguity exists to stop.
    if not exists (
      select 1 from jsonb_array_elements(_item.candidate_matches) c
      where (c ->> 'productId')::uuid = _existing_product_id) then
      raise exception 'that product is not among this row''s candidates'
        using errcode = '22023';
    end if;
    update public.clinical_knowledge_import_items
    set change_kind = 'change', status = 'needs_review',
        existing_ref_type = 'supplement_product',
        existing_ref_id = _existing_product_id,
        review_note = btrim(_note), reviewed_by = _uid, reviewed_at = now()
    where id = _item_id;

  else
    update public.clinical_knowledge_import_items
    set status = 'skipped', review_note = btrim(_note),
        reviewed_by = _uid, reviewed_at = now()
    where id = _item_id;
  end if;

  update public.clinical_knowledge_import_batches
  set ambiguous_count = greatest(ambiguous_count - 1, 0)
  where id = _item.batch_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_item.organization_id, _uid, 'knowledge.import_ambiguity_resolved',
     'clinical_knowledge_import_item', _item_id::text,
     'An ambiguous import row was resolved by a reviewer',
     jsonb_build_object('resolution', _resolution));

  return jsonb_build_object('ok', true, 'itemId', _item_id,
    'resolution', _resolution);
end;
$fn$;

revoke all on function public.resolve_knowledge_import_ambiguity(
  uuid, text, text, uuid) from public, anon;
grant execute on function public.resolve_knowledge_import_ambiguity(
  uuid, text, text, uuid) to authenticated;

-- ================================================== the catalog product write
--
-- Separated from `commit_knowledge_import` so the write can be read on its own.
-- It is the only path that creates a product from a file, and everything it
-- does is visible in twenty lines.

create or replace function private.apply_catalog_product_item(
  _item_id uuid, _uid uuid)
returns uuid language plpgsql security definer set search_path = ''
as $fn$
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
    -- A changed source row RE-ENTERS REVIEW. The earlier review covered the
    -- earlier content; carrying its verdict forward would attribute to a
    -- reviewer an approval of text they never saw. Any clearance is dropped
    -- for the same reason.
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

  -- A label version is written only when the source actually supplied label
  -- content. An empty version row would make the catalog look as though a
  -- label had been captured, which is the "None vs Unknown" failure wearing a
  -- different hat.
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
       -- `incomplete`, always. Nobody in this system has compared this against
       -- a manufacturer label, and `verified` requires a named person.
       'incomplete', 'draft', _uid);
  end if;

  return _product_id;
end;
$fn$;

-- ================================================================= commit
--
-- Restated in full. The changes from `20260801031652`:
--
--   * `catalog_product` has an apply path;
--   * every applied row writes an append-only provenance record;
--   * an unresolved ambiguity refuses the commit, exactly as an unresolved
--     conflict does.

create or replace function public.commit_knowledge_import(
  _batch_id uuid, _expected_counts jsonb default null, _note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  _b public.clinical_knowledge_import_batches%rowtype;
  _uid uuid;
  _item public.clinical_knowledge_import_items%rowtype;
  _p jsonb;
  _unresolved integer;
  _ambiguous integer;
  _invalid integer;
  _applied integer := 0;
  _skipped integer := 0;
  _restricted integer := 0;
  _ref_type text;
  _ref_id uuid;
  _grade text;
  _reference_id uuid;
  _file_name text;
  _file_sha text;
begin
  select * into _b from public.clinical_knowledge_import_batches
   where id = _batch_id for update;
  if not found then
    raise exception 'import batch not found' using errcode = 'P0002';
  end if;
  _uid := private.require_knowledge_editor(_b.organization_id);
  if _b.status not in ('preview', 'staged', 'in_review') then
    raise exception 'only a previewed batch can be committed' using errcode = '55000';
  end if;

  -- A conflict left unresolved is a question nobody answered. Refuse.
  select count(*) into _unresolved from public.clinical_knowledge_import_items
   where batch_id = _batch_id and change_kind = 'conflict'
     and conflict_resolution is null;
  if _unresolved > 0 then
    raise exception 'resolve all % conflicting rows before committing', _unresolved
      using errcode = '55000';
  end if;

  -- An ambiguity left unresolved is the same kind of question, and the answer
  -- matters more: applying it either duplicates a product or overwrites one.
  select count(*) into _ambiguous from public.clinical_knowledge_import_items
   where batch_id = _batch_id and change_kind = 'ambiguous';
  if _ambiguous > 0 then
    raise exception 'resolve all % ambiguous rows before committing; each one resembles an existing product closely enough that applying it blind would duplicate or overwrite it', _ambiguous
      using errcode = '55000';
  end if;

  -- A row with validation errors is never applied, and never silently dropped.
  select count(*) into _invalid from public.clinical_knowledge_import_items
   where batch_id = _batch_id and status = 'needs_review'
     and jsonb_array_length(validation_errors) > 0;
  if _invalid > 0 then
    raise exception
      '% row(s) have validation errors; fix them in the source and re-import', _invalid
      using errcode = '55000';
  end if;

  -- The reviewer confirms what they saw. If the staged counts moved since the
  -- preview was read, the commit refuses rather than applying a different set.
  if _expected_counts is not null then
    if coalesce((_expected_counts ->> 'added')::integer, -1) <> _b.added_count
       or coalesce((_expected_counts ->> 'changed')::integer, -1) <> _b.changed_count then
      raise exception
        'this preview changed since it was reviewed (staged add/change is %/%); reload and review again',
        _b.added_count, _b.changed_count
        using errcode = '40001';
    end if;
  end if;

  select f.declared_name, f.content_sha256 into _file_name, _file_sha
  from public.clinical_import_source_files f
  where f.organization_id = _b.organization_id
    and f.declared_name = _b.source_filename;

  for _item in
    select * from public.clinical_knowledge_import_items
     where batch_id = _batch_id and status = 'needs_review'
     order by source_row_number, created_at
  loop
    _p := _item.payload;
    _ref_type := null; _ref_id := null;

    if _item.entity_type in ('pathway', 'product_label') then
      -- Delegate to the existing, already-governed apply path. One apply
      -- implementation per entity type; no second copy to drift out of step.
      perform public.review_clinical_knowledge_import_item(
        _item.id, 'accept', coalesce(_note, 'Committed via import review'));
      select applied_ref_type, applied_ref_id into _ref_type, _ref_id
        from public.clinical_knowledge_import_items where id = _item.id;
      _applied := _applied + 1;

    elsif _item.entity_type = 'catalog_product' then
      _ref_id := private.apply_catalog_product_item(_item.id, _uid);
      _ref_type := 'supplement_product';

      update public.clinical_knowledge_import_items
      set status = 'applied', reviewed_by = _uid, reviewed_at = now(),
          review_note = coalesce(_note, 'Committed via import review'),
          applied_ref_type = _ref_type, applied_ref_id = _ref_id
      where id = _item.id;
      _applied := _applied + 1;
      _restricted := _restricted
        + (case when _item.restricted_flags <> '{}' then 1 else 0 end);

    else
      _grade := lower(btrim(coalesce(_p ->> 'evidenceClassification', 'unclassified')));
      -- Resolve a named reference to a real governed row. A code that does not
      -- resolve is NOT quietly downgraded to ungraded — it is refused, because
      -- silently regrading a practitioner's claim misrepresents them.
      _reference_id := null;
      if coalesce(btrim(_p ->> 'referenceCode'), '') <> '' then
        select id into _reference_id from public.clinical_knowledge_sources
         where code = lower(btrim(_p ->> 'referenceCode'))
         order by revision desc limit 1;
        if _reference_id is null then
          raise exception
            'row % cites reference "%" which is not in the governed registry; import the reference first',
            _item.source_row_number, _p ->> 'referenceCode'
            using errcode = 'P0002';
        end if;
      end if;

      if _item.entity_type = 'lab_suggestion' then
        insert into public.clinical_lab_suggestions
          (organization_id, code, name, clinical_question, hypotheses,
           prerequisites, limitations, intent, reference_id,
           evidence_classification, review_status, created_by)
        values
          (_b.organization_id, lower(btrim(_p ->> 'code')), btrim(_p ->> 'name'),
           btrim(_p ->> 'clinicalQuestion'),
           coalesce(array(select jsonb_array_elements_text(
             case when jsonb_typeof(_p -> 'hypotheses') = 'array'
                  then _p -> 'hypotheses' else '[]'::jsonb end)), '{}'),
           coalesce(array(select jsonb_array_elements_text(
             case when jsonb_typeof(_p -> 'prerequisites') = 'array'
                  then _p -> 'prerequisites' else '[]'::jsonb end)), '{}'),
           nullif(btrim(coalesce(_p ->> 'limitations', '')), ''),
           lower(btrim(_p ->> 'intent')), _reference_id, _grade, 'draft', _uid)
        returning id into _ref_id;
        _ref_type := 'clinical_lab_suggestion';

      elsif _item.entity_type = 'interpretation_rule' then
        insert into public.clinical_interpretation_rules
          (organization_id, biomarker_code, name, condition, interpretation,
           caveats, population, reference_id, evidence_classification,
           review_status, created_by)
        values
          (_b.organization_id, lower(btrim(_p ->> 'biomarkerCode')),
           btrim(_p ->> 'name'), _p -> 'condition', btrim(_p ->> 'interpretation'),
           nullif(btrim(coalesce(_p ->> 'caveats', '')), ''),
           nullif(btrim(coalesce(_p ->> 'population', '')), ''),
           _reference_id, _grade, 'draft', _uid)
        returning id into _ref_id;
        _ref_type := 'clinical_interpretation_rule';

      elsif _item.entity_type = 'intervention_class' then
        insert into public.clinical_intervention_classes
          (organization_id, code, name, description, category,
           jurisdiction_sensitive, monitoring_requirements, stopping_rules,
           contraindications, followup_interval_days, reference_id,
           evidence_classification, review_status, created_by)
        values
          (_b.organization_id, lower(btrim(_p ->> 'code')), btrim(_p ->> 'name'),
           nullif(btrim(coalesce(_p ->> 'description', '')), ''),
           nullif(btrim(coalesce(_p ->> 'category', '')), ''),
           coalesce((_p ->> 'jurisdictionSensitive')::boolean, false),
           coalesce(array(select jsonb_array_elements_text(
             case when jsonb_typeof(_p -> 'monitoringRequirements') = 'array'
                  then _p -> 'monitoringRequirements' else '[]'::jsonb end)), '{}'),
           coalesce(array(select jsonb_array_elements_text(
             case when jsonb_typeof(_p -> 'stoppingRules') = 'array'
                  then _p -> 'stoppingRules' else '[]'::jsonb end)), '{}'),
           coalesce(array(select jsonb_array_elements_text(
             case when jsonb_typeof(_p -> 'contraindications') = 'array'
                  then _p -> 'contraindications' else '[]'::jsonb end)), '{}'),
           nullif(btrim(coalesce(_p ->> 'followupIntervalDays', '')), '')::integer,
           _reference_id, _grade, 'draft', _uid)
        returning id into _ref_id;
        _ref_type := 'clinical_intervention_class';

      elsif _item.entity_type = 'graph_edge' then
        insert into public.clinical_graph_edges
          (organization_id, from_kind, from_ref, relation, to_kind, to_ref,
           reference_id, evidence_classification, rationale, paradigm_code,
           review_status, created_by)
        values
          (_b.organization_id, lower(btrim(_p ->> 'fromKind')), btrim(_p ->> 'fromRef'),
           lower(btrim(_p ->> 'relation')), lower(btrim(_p ->> 'toKind')),
           btrim(_p ->> 'toRef'), _reference_id, _grade,
           nullif(btrim(coalesce(_p ->> 'rationale', '')), ''),
           nullif(btrim(coalesce(_p ->> 'paradigmCode', '')), ''),
           'draft', _uid)
        returning id into _ref_id;
        _ref_type := 'clinical_graph_edge';

      else
        -- An entity type with no apply path is REPORTED, not swallowed. It
        -- stays staged so an operator can see exactly what did not land.
        update public.clinical_knowledge_import_items
        set status = 'skipped',
            review_note = 'No apply path is implemented for entity type "'
              || _item.entity_type || '" in this release; the row remains staged '
              || 'and unapplied.'
        where id = _item.id;
        _skipped := _skipped + 1;
        continue;
      end if;

      update public.clinical_knowledge_import_items
      set status = 'applied', reviewed_by = _uid, reviewed_at = now(),
          review_note = coalesce(_note, 'Committed via import review'),
          applied_ref_type = _ref_type, applied_ref_id = _ref_id
      where id = _item.id;
      _applied := _applied + 1;
    end if;

    -- WHERE THIS RECORD CAME FROM, written beside the record itself. Append
    -- only; `on conflict do nothing` because re-running must not rewrite an
    -- earlier answer, and the append-only trigger would refuse anyway.
    if _ref_type is not null and _ref_id is not null then
      insert into public.clinical_import_provenance
        (organization_id, ref_type, ref_id, batch_id, item_id,
         source_file_name, source_file_sha256, source_sheet, source_row_number,
         payload_sha256, raw_values, normalized_values, missing_facts,
         restricted_flags, imported_by)
      values
        (_b.organization_id, _ref_type, _ref_id, _batch_id, _item.id,
         coalesce(_file_name, _b.source_filename), coalesce(_file_sha, _b.source_sha256),
         _item.source_sheet, _item.source_row_number, _item.payload_sha256,
         _item.source_raw, _item.payload, _item.missing_facts,
         _item.restricted_flags, _uid)
      on conflict (ref_type, ref_id, item_id) do nothing;
    end if;

    -- Remember the row identity so a later import of the same file is
    -- `unchanged` rather than a duplicate.
    if _item.dedupe_key is not null then
      insert into public.clinical_knowledge_import_state
        (organization_id, entity_type, dedupe_key, source_kind,
         last_payload_sha256, ref_type, ref_id, last_batch_id)
      values
        (_b.organization_id, _item.entity_type, _item.dedupe_key, _b.source_kind,
         _item.payload_sha256, _ref_type, _ref_id, _batch_id)
      on conflict (organization_id, entity_type, dedupe_key) do update
      set last_payload_sha256 = excluded.last_payload_sha256,
          ref_type = excluded.ref_type, ref_id = excluded.ref_id,
          last_batch_id = excluded.last_batch_id,
          source_kind = coalesce(excluded.source_kind,
                                 public.clinical_knowledge_import_state.source_kind),
          updated_at = now();
    end if;
  end loop;

  update public.clinical_knowledge_import_batches
  set status = 'committed', committed_at = now(), committed_by = _uid,
      completed_at = now()
  where id = _batch_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_b.organization_id, _uid, 'knowledge.import_committed',
     'clinical_knowledge_import_batch', _batch_id::text,
     'Import committed; all content entered as non-approved drafts',
     jsonb_build_object('applied', _applied, 'skipped', _skipped,
       'restricted', _restricted));

  return jsonb_build_object(
    'ok', true, 'batchId', _batch_id, 'applied', _applied, 'skipped', _skipped,
    'restricted', _restricted,
    'approvalState', 'draft',
    'message', 'Imported content is stored as NON-APPROVED drafts. Import is not '
      || 'review, and nothing here is approved for clinical use until a '
      || 'practitioner approves it. Imported products are NOT selectable in the '
      || 'protocol picker until their review state is completed.');
end;
$$;

commit;
