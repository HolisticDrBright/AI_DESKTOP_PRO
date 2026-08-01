-- Phase 9B: the controlled import pipeline.
--
-- THE ONE RULE: NOTHING IS INSERTED SILENTLY.
--
-- `preview_knowledge_import` parses, hashes, validates, dedupes and classifies
-- an incoming file and writes ONLY into the staging tables. No governed row is
-- created, changed or deleted by a preview — that is what makes it safe to run
-- against production data before a human has looked at anything.
--
-- `commit_knowledge_import` is the only path into governed tables, it requires
-- a reviewer, it refuses while any conflict is unresolved or any applied row
-- would carry a validation error, and it refuses if the counts the reviewer
-- confirms do not match the counts actually staged. Everything it creates
-- enters as a NON-APPROVED DRAFT. Import is not approval.
--
-- IDEMPOTENCY WORKS AT TWO LEVELS:
--   * file — a unique index on (organization_id, source_sha256) means the same
--     bytes cannot produce a second batch; a re-run returns the first batch.
--   * row — `clinical_knowledge_import_state` remembers the last payload hash
--     applied for each (organization, entity type, dedupe key), so a row that
--     has not moved is classified `unchanged` and does nothing.
--
-- The row-level state is also what makes `removal` honest. A key that this
-- organization previously imported FROM THE SAME KIND OF SOURCE and that is
-- absent from the incoming file is reported as a removal. Scoping it to the
-- source kind matters: a protocol document must never appear to delete
-- products just because it does not mention any.
--
-- A REMOVAL IS REPORTED, NEVER PERFORMED. This pipeline has no delete path
-- into governed content. Retiring a clinical row is a supervised act with its
-- own RPC and its own reason; discovering an absence in a spreadsheet is not
-- consent to erase a clinical record.

begin;

-- --------------------------------------------------------------- item status
--
-- `skipped` is added because the existing vocabulary could not express "this
-- row was examined and correctly did nothing". Without it an unchanged row
-- would have to be recorded as `rejected`, which reads in the audit trail as a
-- reviewer refusing content they never actually refused.

alter table public.clinical_knowledge_import_items
  drop constraint clinical_knowledge_import_items_status_check,
  add constraint clinical_knowledge_import_items_status_check
    check (status in ('needs_review', 'applied', 'rejected', 'skipped'));

alter table public.clinical_knowledge_import_items
  add column if not exists conflict_resolution text check (conflict_resolution in (
    'keep_existing', 'take_incoming', 'skip'));

-- ------------------------------------------------------- row-level idempotency

create table public.clinical_knowledge_import_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null,
  dedupe_key text not null,
  source_kind text,

  /** The payload hash last applied for this key. Equal hash = `unchanged`. */
  last_payload_sha256 text not null,
  ref_type text,
  ref_id uuid,
  last_batch_id uuid references public.clinical_knowledge_import_batches(id)
    on delete set null,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, entity_type, dedupe_key)
);

create index ckis_org_idx on public.clinical_knowledge_import_state (organization_id);
create index ckis_batch_idx on public.clinical_knowledge_import_state (last_batch_id);
create index ckis_source_kind_idx
  on public.clinical_knowledge_import_state (organization_id, source_kind);

alter table public.clinical_knowledge_import_state enable row level security;

create policy import_state_select on public.clinical_knowledge_import_state
  for select to authenticated using (private.is_org_member(organization_id));

revoke insert, update, delete on public.clinical_knowledge_import_state
  from anon, authenticated;

-- ============================================================ dedupe identity
--
-- The dedupe key is how a source row is matched to what already exists. It is
-- derived ONLY from fields the source actually supplies. Where a source gives
-- no stable identity the key is null, and a null key can never match anything —
-- such a row is always an `add` and is flagged for a human, because guessing
-- identity is how one product silently overwrites another.

create or replace function private.knowledge_import_dedupe_key(
  _entity_type text, _payload jsonb)
returns text language plpgsql immutable set search_path = ''
as $$
declare _k text;
begin
  _k := case _entity_type
    when 'pathway' then lower(btrim(coalesce(_payload ->> 'code', '')))
    when 'product_label' then lower(btrim(coalesce(_payload ->> 'productCode', '')))
    when 'catalog_product' then
      coalesce(
        nullif(lower(btrim(coalesce(_payload ->> 'sku', ''))), ''),
        nullif(lower(btrim(coalesce(_payload ->> 'upc', ''))), ''),
        nullif(lower(btrim(coalesce(_payload ->> 'brand', '') || '|'
                        || coalesce(_payload ->> 'name', ''))), '|'))
    when 'knowledge_reference' then
      nullif(lower(btrim(coalesce(_payload ->> 'code', ''))), '')
        || '|' || lower(btrim(coalesce(_payload ->> 'revision', '')))
    when 'knowledge_claim' then lower(btrim(coalesce(_payload ->> 'code', '')))
    when 'lab_suggestion' then lower(btrim(coalesce(_payload ->> 'code', '')))
    when 'interpretation_rule' then
      lower(btrim(coalesce(_payload ->> 'biomarkerCode', ''))) || '|'
        || lower(btrim(coalesce(_payload ->> 'name', '')))
    when 'intervention_class' then lower(btrim(coalesce(_payload ->> 'code', '')))
    when 'protocol_template' then lower(btrim(coalesce(_payload ->> 'name', '')))
    when 'graph_edge' then
      lower(btrim(coalesce(_payload ->> 'fromKind', ''))) || '|'
        || lower(btrim(coalesce(_payload ->> 'fromRef', ''))) || '|'
        || lower(btrim(coalesce(_payload ->> 'relation', ''))) || '|'
        || lower(btrim(coalesce(_payload ->> 'toKind', ''))) || '|'
        || lower(btrim(coalesce(_payload ->> 'toRef', '')))
    else null
  end;
  -- A key made only of separators carries no identity.
  if _k is null or btrim(replace(_k, '|', '')) = '' then
    return null;
  end if;
  return _k;
end;
$$;

-- ================================================================ validation
--
-- The two existing branches are reproduced EXACTLY. The Phase-1 import
-- acceptance suite asserts their messages, and this phase is not entitled to
-- change what a previous phase promised.

create or replace function private.knowledge_import_validation_errors(
  _entity_type text, _payload jsonb)
returns jsonb language plpgsql immutable set search_path = ''
as $function$
declare _errors jsonb := '[]'::jsonb; _content jsonb; _label jsonb; _grade text;
begin
  if _entity_type = 'pathway' then
    _content := _payload -> 'content';
    if coalesce(btrim(_payload ->> 'code'), '') = '' then
      _errors := _errors || '["Pathway code is required"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'name'), '') = '' then
      _errors := _errors || '["Pathway name is required"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'domainCode'), '') = '' then
      _errors := _errors || '["Pathway domain is required"]'::jsonb;
    end if;
    if jsonb_typeof(_content) <> 'object' then
      _errors := _errors || '["Pathway content must be an object"]'::jsonb;
    else
      if jsonb_typeof(_content -> 'differentiatingQuestions') <> 'array' then
        _errors := _errors || '["Differentiating questions must be an array"]'::jsonb;
      end if;
      if jsonb_typeof(_content -> 'labStrategy') <> 'array' then
        _errors := _errors || '["Lab strategy must be an array"]'::jsonb;
      end if;
      if jsonb_typeof(_content -> 'productCandidates') <> 'array' then
        _errors := _errors || '["Product candidates must be an array"]'::jsonb;
      end if;
      if jsonb_typeof(_content -> 'safetyStops') <> 'array' then
        _errors := _errors || '["Safety stops must be an array"]'::jsonb;
      end if;
    end if;
  elsif _entity_type = 'product_label' then
    _label := _payload -> 'exactLabel';
    if coalesce(btrim(_payload ->> 'productCode'), '') = '' then
      _errors := _errors || '["Product code is required"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'productName'), '') = '' then
      _errors := _errors || '["Product name is required"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'brand'), '') = '' then
      _errors := _errors || '["Product brand is required"]'::jsonb;
    end if;
    if jsonb_typeof(_label) <> 'object' then
      _errors := _errors || '["Exact product label must be an object"]'::jsonb;
    else
      if coalesce(btrim(_label ->> 'ingredients'), '') = '' then
        _errors := _errors || '["Ingredient amounts and units are required"]'::jsonb;
      end if;
      if coalesce(btrim(_label ->> 'servingSize'), '') = '' then
        _errors := _errors || '["Serving size is required"]'::jsonb;
      end if;
    end if;
    if coalesce(btrim(_payload ->> 'sourceUrl'), '') = '' then
      _errors := _errors || '["Current manufacturer label URL is required"]'::jsonb;
    end if;

  elsif _entity_type = 'catalog_product' then
    if coalesce(btrim(_payload ->> 'name'), '') = '' then
      _errors := _errors || '["Product name is required"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'brand'), '') = '' then
      _errors := _errors || '["Brand is required"]'::jsonb;
    end if;
    -- Identity must come from the source. A product with no SKU, UPC or
    -- manufacturer identifier cannot be matched on a later import, which means
    -- the next import would silently duplicate it.
    if coalesce(btrim(_payload ->> 'sku'), '') = ''
       and coalesce(btrim(_payload ->> 'upc'), '') = ''
       and coalesce(btrim(_payload ->> 'manufacturerIdentifier'), '') = '' then
      _errors := _errors ||
        '["At least one of SKU, UPC or manufacturer identifier is required to identify this product on re-import"]'::jsonb;
    end if;

  elsif _entity_type = 'knowledge_reference' then
    if coalesce(btrim(_payload ->> 'code'), '') = '' then
      _errors := _errors || '["Reference code is required"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'title'), '') = '' then
      _errors := _errors || '["Reference title is required"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'referenceType'), '') = '' then
      _errors := _errors || '["Reference type is required"]'::jsonb;
    end if;
    -- The copyright boundary, enforced at the door rather than trusted.
    if char_length(coalesce(_payload ->> 'shortExcerpt', '')) > 300 then
      _errors := _errors ||
        '["Short excerpt exceeds 300 characters; store a structured summary instead of copied text"]'::jsonb;
    end if;
    if coalesce(btrim(_payload ->> 'body'), '') <> '' then
      _errors := _errors ||
        '["Full source text must not be imported; supply a structured summary and a content hash"]'::jsonb;
    end if;

  elsif _entity_type in ('knowledge_claim', 'lab_suggestion',
                         'interpretation_rule', 'intervention_class', 'graph_edge') then
    _grade := lower(btrim(coalesce(_payload ->> 'evidenceClassification', 'unclassified')));
    if _grade not in ('high', 'moderate', 'low', 'very_low',
                      'practitioner_experience', 'unclassified') then
      _errors := _errors || '["Unrecognised evidence classification"]'::jsonb;
    end if;
    -- The rule that makes "evidence-based" mean something: a graded claim
    -- names its source or it does not import.
    if _grade in ('high', 'moderate', 'low', 'very_low')
       and coalesce(btrim(_payload ->> 'referenceCode'), '') = '' then
      _errors := _errors ||
        '["A graded evidence classification requires a governed reference; unreferenced practitioner content must be imported as practitioner_experience"]'::jsonb;
    end if;

    if _entity_type = 'knowledge_claim' then
      if coalesce(btrim(_payload ->> 'code'), '') = '' then
        _errors := _errors || '["Claim code is required"]'::jsonb;
      end if;
      if coalesce(btrim(_payload ->> 'statement'), '') = '' then
        _errors := _errors || '["Claim statement is required"]'::jsonb;
      end if;
    elsif _entity_type = 'lab_suggestion' then
      if coalesce(btrim(_payload ->> 'code'), '') = '' then
        _errors := _errors || '["Lab suggestion code is required"]'::jsonb;
      end if;
      if coalesce(btrim(_payload ->> 'name'), '') = '' then
        _errors := _errors || '["Lab suggestion name is required"]'::jsonb;
      end if;
      if coalesce(btrim(_payload ->> 'clinicalQuestion'), '') = '' then
        _errors := _errors ||
          '["The clinical question this lab answers is required; a test without a question is not a suggestion"]'::jsonb;
      end if;
      if lower(btrim(coalesce(_payload ->> 'intent', ''))) not in
         ('screening', 'confirmatory', 'monitoring', 'exploratory') then
        _errors := _errors ||
          '["Intent must be screening, confirmatory, monitoring or exploratory"]'::jsonb;
      end if;
    elsif _entity_type = 'interpretation_rule' then
      if coalesce(btrim(_payload ->> 'biomarkerCode'), '') = '' then
        _errors := _errors || '["Biomarker code is required"]'::jsonb;
      end if;
      if coalesce(btrim(_payload ->> 'name'), '') = '' then
        _errors := _errors || '["Rule name is required"]'::jsonb;
      end if;
      if jsonb_typeof(_payload -> 'condition') <> 'object' then
        _errors := _errors || '["Rule condition must be a structured object"]'::jsonb;
      end if;
      if coalesce(btrim(_payload ->> 'interpretation'), '') = '' then
        _errors := _errors || '["Interpretation text is required"]'::jsonb;
      end if;
    elsif _entity_type = 'intervention_class' then
      if coalesce(btrim(_payload ->> 'code'), '') = '' then
        _errors := _errors || '["Intervention class code is required"]'::jsonb;
      end if;
      if coalesce(btrim(_payload ->> 'name'), '') = '' then
        _errors := _errors || '["Intervention class name is required"]'::jsonb;
      end if;
    elsif _entity_type = 'graph_edge' then
      if coalesce(btrim(_payload ->> 'fromKind'), '') = ''
         or coalesce(btrim(_payload ->> 'fromRef'), '') = ''
         or coalesce(btrim(_payload ->> 'relation'), '') = ''
         or coalesce(btrim(_payload ->> 'toKind'), '') = ''
         or coalesce(btrim(_payload ->> 'toRef'), '') = '' then
        _errors := _errors ||
          '["An edge needs fromKind, fromRef, relation, toKind and toRef"]'::jsonb;
      end if;
    end if;

  elsif _entity_type = 'protocol_template' then
    if coalesce(btrim(_payload ->> 'name'), '') = '' then
      _errors := _errors || '["Protocol template name is required"]'::jsonb;
    end if;
    if jsonb_typeof(_payload -> 'items') <> 'array' then
      _errors := _errors || '["Protocol items must be an array"]'::jsonb;
    end if;
  else
    _errors := _errors || '["Unsupported import entity type"]'::jsonb;
  end if;
  return _errors;
end;
$function$;

-- ============================================================ preview
--
-- Writes staging rows only. Read this function looking for an INSERT into a
-- governed table; there is not one.

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
  _added integer := 0; _changed integer := 0; _unchanged integer := 0;
  _conflicts integer := 0; _removed integer := 0;
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

  -- FILE-LEVEL IDEMPOTENCY. The same bytes never produce a second batch.
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
      'message', 'This exact file was already imported. The existing batch is '
        || 'returned unchanged; nothing was staged a second time.');
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

    _payload_hash := private.sha256_hex(_payload::text);
    _key := private.knowledge_import_dedupe_key(_entity_type, _payload);
    _errors := private.knowledge_import_validation_errors(_entity_type, _payload);
    _dupe_of := null;
    _change := null;

    -- INTRA-BATCH CONFLICT: two rows of the same file claiming one identity.
    -- Last-writer-wins here would silently discard a practitioner's row.
    if _key is not null and (_entity_type || '|' || _key) = any(_seen) then
      _change := 'conflict';
      select id into _dupe_of from public.clinical_knowledge_import_items
       where batch_id = _batch_id and entity_type = _entity_type and dedupe_key = _key
       limit 1;
    else
      if _key is not null then
        _seen := _seen || (_entity_type || '|' || _key);
      end if;

      if _key is null then
        -- No stable identity in the source: always new, always human-checked.
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
    end if;

    insert into public.clinical_knowledge_import_items
      (batch_id, organization_id, entity_type, external_key, display_name,
       source_sheet, source_row_number, dedupe_key, payload, payload_sha256,
       change_kind, existing_ref_type, existing_ref_id,
       conflict_with_item_id, conflict_reason,
       status, warnings, validation_errors)
    values
      (_batch_id, _organization_id, _entity_type,
       coalesce(nullif(btrim(_item ->> 'externalKey'), ''), gen_random_uuid()::text),
       coalesce(nullif(btrim(_item ->> 'displayName'), ''), 'Unnamed import item'),
       nullif(btrim(_item ->> 'sourceSheet'), ''), _row, _key,
       _payload, _payload_hash, _change,
       case when _change in ('change', 'unchanged') then _state.ref_type end,
       case when _change in ('change', 'unchanged') then _state.ref_id end,
       _dupe_of,
       case when _change = 'conflict' then
         'Another row earlier in this file claims the same identity ('
           || _key || '). Resolve which row is correct before committing.' end,
       case when _change = 'unchanged' then 'skipped' else 'needs_review' end,
       case when jsonb_typeof(_item -> 'warnings') = 'array'
            then _item -> 'warnings' else '[]'::jsonb end,
       _errors);

    _added := _added + (case when _change = 'add' then 1 else 0 end);
    _changed := _changed + (case when _change = 'change' then 1 else 0 end);
    _unchanged := _unchanged + (case when _change = 'unchanged' then 1 else 0 end);
    _conflicts := _conflicts + (case when _change = 'conflict' then 1 else 0 end);
  end loop;

  -- REMOVALS ARE REPORTED, NEVER PERFORMED. Keys this organization previously
  -- imported from this same kind of source, absent from this file.
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
      conflict_count = _conflicts, removed_count = _removed
  where id = _batch_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'knowledge.import_previewed',
     'clinical_knowledge_import_batch', _batch_id::text,
     'Import preview generated; no governed record was created or changed',
     jsonb_build_object('itemCount', _count, 'added', _added, 'changed', _changed,
       'unchanged', _unchanged, 'conflicts', _conflicts, 'removals', _removed));

  return jsonb_build_object(
    'batchId', _batch_id, 'idempotent', false, 'status', 'preview',
    'itemCount', _count, 'added', _added, 'changed', _changed,
    'unchanged', _unchanged, 'conflicts', _conflicts, 'removals', _removed,
    'sourceSha256', _hash,
    'message', 'Preview only. No governed record has been created or changed. '
      || 'Review every change and commit explicitly to apply.');
end;
$$;

revoke all on function public.preview_knowledge_import(
  uuid, text, text, text, jsonb, boolean, text, bigint, text) from public, anon;
grant execute on function public.preview_knowledge_import(
  uuid, text, text, text, jsonb, boolean, text, bigint, text) to authenticated;

-- ============================================================ read a preview

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
    'appliedRefType', i.applied_ref_type, 'appliedRefId', i.applied_ref_id)
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

-- ========================================================= conflict resolution

create or replace function public.resolve_knowledge_import_conflict(
  _item_id uuid, _resolution text, _note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _item public.clinical_knowledge_import_items%rowtype; _uid uuid;
begin
  select * into _item from public.clinical_knowledge_import_items
   where id = _item_id for update;
  if not found then
    raise exception 'import item not found' using errcode = 'P0002';
  end if;
  _uid := private.require_knowledge_editor(_item.organization_id);
  if _item.change_kind <> 'conflict' then
    raise exception 'this item is not in conflict' using errcode = '55000';
  end if;
  if _resolution not in ('keep_existing', 'take_incoming', 'skip') then
    raise exception 'resolution must be keep_existing, take_incoming or skip'
      using errcode = '22023';
  end if;
  if coalesce(btrim(_note), '') = '' then
    raise exception 'a conflict resolution requires a reason' using errcode = '22023';
  end if;

  update public.clinical_knowledge_import_items
  set conflict_resolution = _resolution,
      review_note = _note,
      reviewed_by = _uid,
      reviewed_at = now(),
      -- Only `take_incoming` re-enters the applyable set; the other two are
      -- decisions to leave governed content alone.
      change_kind = case when _resolution = 'take_incoming' then 'change'
                         else _item.change_kind end,
      status = case when _resolution = 'take_incoming' then 'needs_review'
                    else 'skipped' end
  where id = _item_id;

  update public.clinical_knowledge_import_batches
  set conflict_count = greatest(conflict_count - 1, 0)
  where id = _item.batch_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_item.organization_id, _uid, 'knowledge.import_conflict_resolved',
     'clinical_knowledge_import_item', _item_id::text,
     'Import conflict resolved by a reviewer',
     jsonb_build_object('resolution', _resolution));

  return jsonb_build_object('ok', true, 'itemId', _item_id, 'resolution', _resolution);
end;
$$;

revoke all on function public.resolve_knowledge_import_conflict(uuid, text, text)
  from public, anon;
grant execute on function public.resolve_knowledge_import_conflict(uuid, text, text)
  to authenticated;

-- ================================================================= commit
--
-- The ONLY path from staging into governed content.

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
  _invalid integer;
  _applied integer := 0;
  _skipped integer := 0;
  _ref_type text;
  _ref_id uuid;
  _grade text;
  _reference_id uuid;
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
     jsonb_build_object('applied', _applied, 'skipped', _skipped));

  return jsonb_build_object(
    'ok', true, 'batchId', _batch_id, 'applied', _applied, 'skipped', _skipped,
    'approvalState', 'draft',
    'message', 'Imported content is stored as NON-APPROVED drafts. Import is not '
      || 'review, and nothing here is approved for clinical use until a '
      || 'practitioner approves it.');
end;
$$;

revoke all on function public.commit_knowledge_import(uuid, jsonb, text) from public, anon;
grant execute on function public.commit_knowledge_import(uuid, jsonb, text) to authenticated;

-- ================================================================= cancel

create or replace function public.cancel_knowledge_import(
  _batch_id uuid, _reason text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _b public.clinical_knowledge_import_batches%rowtype; _uid uuid;
begin
  select * into _b from public.clinical_knowledge_import_batches
   where id = _batch_id for update;
  if not found then
    raise exception 'import batch not found' using errcode = 'P0002';
  end if;
  _uid := private.require_knowledge_editor(_b.organization_id);
  if _b.status in ('committed', 'completed') then
    raise exception 'a committed batch cannot be cancelled' using errcode = '55000';
  end if;
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'a cancellation reason is required' using errcode = '22023';
  end if;

  update public.clinical_knowledge_import_items
  set status = 'rejected', review_note = _reason, reviewed_by = _uid, reviewed_at = now()
  where batch_id = _batch_id and status = 'needs_review';

  update public.clinical_knowledge_import_batches
  set status = 'cancelled', completed_at = now() where id = _batch_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_b.organization_id, _uid, 'knowledge.import_cancelled',
     'clinical_knowledge_import_batch', _batch_id::text,
     'Import batch cancelled before commit', jsonb_build_object('reason', _reason));

  return jsonb_build_object('ok', true, 'batchId', _batch_id, 'status', 'cancelled');
end;
$$;

revoke all on function public.cancel_knowledge_import(uuid, text) from public, anon;
grant execute on function public.cancel_knowledge_import(uuid, text) to authenticated;

commit;
