-- Phase 9D fix — source-level restriction propagation, deferred-warnings
-- counting, and commercial-only routing.
--
-- WHY. The first real preview against practitioner content classified 49
-- items as restricted where 500 were expected. The gap was a boundary
-- defect: source-level restriction metadata (an operator declaring "this
-- entire workbook is vaccine-related") and per-row text signals broader
-- than the RPC's own vocabulary did not survive parser envelope → preview
-- RPC → item review state. A file the operator declared restricted-by-
-- default became 365 items with an unrestricted classification.
--
-- WHAT THIS ADDS, STRUCTURALLY:
--
--   1. New columns on `clinical_knowledge_import_batches`:
--        * `source_restricted_flags text[]` — flags the operator declared
--          on the whole source (e.g. `vaccine_related`, `peptide`).
--        * `source_restricted_reason text` — human-readable why, per source.
--        * `commercial_only boolean` — the batch's rows are commercial
--          metadata; committing them through the clinical apply path is
--          refused, and the operator must route commercial data via
--          `save_product_label_version` (Phase 9B).
--        * `deferred_count integer` — items carrying `warnings` (dose text
--          preserved as reference metadata, long-excerpt notes, etc.).
--          Deferred is not restricted; the reviewer sees two queues.
--
--   2. `preview_knowledge_import` grows three new named params:
--        `_source_restricted_flags text[] default '{}'::text[]`
--        `_source_restricted_reason text default null`
--        `_commercial_only boolean default false`
--      Existing callers with 9 named params continue to work; new callers
--      pass the extras and the RPC ORs source-level flags into every item.
--      Text-signal classification MAY ADD `suspected_restricted`; it MAY
--      NEVER remove a declared flag or downgrade a declared class.
--      Missing regulatory facts remain Unknown — the classifier never
--      infers "safe" from absence.
--
--   3. `commit_knowledge_import` refuses `commercial_only` batches at the
--      entry, with SQLSTATE `55000`. Refusing at commit rather than at
--      preview lets the reviewer still inspect the staged commercial rows;
--      what's blocked is turning them into clinical content.
--
--   4. Dedupe hash includes the new fields. A previously-cancelled batch
--      does not silently substitute for a re-preview with the correct
--      source-level flags.
--
--   5. Text vocabulary is extended (peptide, semaglutide, IV, vaccine,
--      mRNA, prescription, chelation, stem cell, exosome, HBOT, PEMF, LDN,
--      GLP-1, GHK-Cu, melanotan, jurisdictional markers). The outcome is
--      still the single `suspected_restricted` flag — the vocabulary that
--      matched is deliberately not recorded as a class.
--
-- ADDITIVE: no existing column is dropped, no default changes retroactively,
-- and the existing 9-param callers keep working via defaulted new params.

-- ---------------------------------------------------------------- 1. columns

alter table public.clinical_knowledge_import_batches
  add column if not exists source_restricted_flags text[] not null default '{}'::text[],
  add column if not exists source_restricted_reason text,
  add column if not exists commercial_only boolean not null default false,
  add column if not exists deferred_count integer not null default 0;

-- --------------------------------------------------------- 2. text classifier

create or replace function private.import_restricted_flags(
  _entity_type text, _payload jsonb)
returns text[] language plpgsql immutable set search_path = ''
as $fn$
declare
  _flags text[] := '{}';
  _declared text;
  _route text;
  _text text;
begin
  -- ---------------------------------------------------------------- declared
  -- A DECLARED value carries authority. Text signals never remove one.
  _declared := lower(btrim(coalesce(_payload ->> 'regulatoryClassification', '')));
  if _declared in ('prescription', 'peptide', 'device') then
    _flags := _flags || _declared::text;
  end if;

  _route := lower(btrim(coalesce(_payload ->> 'route', '')));
  if _route in ('iv', 'intravenous', 'infusion', 'im', 'intramuscular',
                'subcutaneous', 'injection') then
    _flags := _flags || 'parenteral_therapy'::text;
  end if;

  if coalesce((_payload ->> 'vaccineRelated')::boolean, false) then
    _flags := _flags || 'vaccine_related'::text;
  end if;

  if jsonb_typeof(_payload -> 'restrictedFlags') = 'array' then
    _flags := _flags || coalesce(array(
      select lower(btrim(value))
      from jsonb_array_elements_text(_payload -> 'restrictedFlags')
      where btrim(value) <> ''), '{}'::text[]);
  end if;

  -- --------------------------------------------------------------- signalled
  --
  -- Concatenated free text, checked for restricted vocabulary. The outcome
  -- is ALWAYS the single `suspected_restricted` flag; the vocabulary that
  -- matched is deliberately not recorded as a class. The scan is over the
  -- fields the reviewer sees when reading the row — including the payload's
  -- structured summary fields for reference rows so a "Peptides for
  -- Cognitive Support" section-heading still trips.
  _text := lower(concat_ws(' ',
    _payload ->> 'name', _payload ->> 'productName', _payload ->> 'description',
    _payload ->> 'statement', _payload ->> 'proposition', _payload ->> 'title',
    _payload ->> 'category', _payload ->> 'form',
    _payload ->> 'subjectLabel', _payload ->> 'mechanism',
    _payload ->> 'suggestedDose', _payload ->> 'directions',
    _payload ->> 'warnings', _payload ->> 'notes'));

  if _text ~ '(peptide|bpc-?157|tb-?500|semaglutide|tirzepatide|ipamorelin|sermorelin|ghk-?cu|melanotan|glp-?1)'
     or _text ~ '(intravenous|\miv\M|infusion|injectable|injection|iv therapy|myers.? cocktail)'
     or _text ~ '(vaccine|\mvax\M|mrna|spike protein|post-?vax|jab injury)'
     or _text ~ '(prescription|\mrx\M|schedule i{1,3}|schedule iv|schedule v|controlled substance|low-?dose naltrexone|\mldn\M)'
     or _text ~ '(chelation|ozone therapy|stem cell|exosome|hbot|hyperbaric|pemf|pbm|cold-?laser)'
     or _text ~ '(not for sale in|\meu only\M|fda-?approved|\mmhra\M|\mtga\M|regulated in)' then
    if not ('suspected_restricted' = any(_flags)) then
      _flags := _flags || 'suspected_restricted'::text;
    end if;
  end if;

  return _flags;
end;
$fn$;

-- ------------------------------------------- 3. preview_knowledge_import v2

drop function if exists public.preview_knowledge_import(
  uuid, text, text, text, jsonb, boolean, text, bigint, text);

create or replace function public.preview_knowledge_import(
  _organization_id uuid,
  _source_kind text,
  _source_name text,
  _schema_version text,
  _items jsonb,
  _attests_no_phi boolean,
  _source_filename text default null,
  _source_byte_size bigint default null,
  _source_revision text default null,
  _source_restricted_flags text[] default '{}'::text[],
  _source_restricted_reason text default null,
  _commercial_only boolean default false
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
  _text_flags text[];
  _source_flags text[];
  _combined_flags text[];
  _missing jsonb;
  _candidates jsonb;
  _source_file_id uuid;
  _added integer := 0; _changed integer := 0; _unchanged integer := 0;
  _conflicts integer := 0; _removed integer := 0;
  _ambiguous integer := 0; _restricted integer := 0;
  _deferred integer := 0;
  _warnings jsonb;
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

  -- Normalise source flags: lower-case, trimmed, deduplicated. `null` and
  -- empty array both mean "no source-level restriction".
  _source_flags := coalesce(
    (select array_agg(distinct lower(btrim(f)))
     from unnest(coalesce(_source_restricted_flags, '{}'::text[])) f
     where btrim(f) <> ''),
    '{}'::text[]);

  -- The dedupe hash includes the new fields so a previously-cancelled
  -- batch does not silently substitute for a re-preview with the correct
  -- source-level flags. Same items + same flags = same hash = idempotent.
  _hash := private.sha256_hex(
    _items::text
    || '|' || coalesce(array_to_string(_source_flags, ','), '')
    || '|' || case when _commercial_only then '1' else '0' end);

  select * into _existing_batch from public.clinical_knowledge_import_batches
   where organization_id = _organization_id and source_sha256 = _hash
     and status = 'preview';
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
      'deferred', _existing_batch.deferred_count,
      'commercialOnly', _existing_batch.commercial_only,
      'message', 'This exact file was already previewed with the same source '
        || 'flags. The existing batch is returned unchanged; nothing was '
        || 'staged a second time.');
  end if;

  if coalesce(btrim(_source_filename), '') <> '' then
    select id into _source_file_id from public.clinical_import_source_files
     where organization_id = _organization_id
       and declared_name = btrim(_source_filename);
  end if;

  insert into public.clinical_knowledge_import_batches
    (organization_id, source_name, source_revision, schema_version, source_sha256,
     source_kind, source_filename, source_byte_size, status, item_count,
     preview_generated_at, no_phi_attested_by, created_by,
     source_restricted_flags, source_restricted_reason, commercial_only)
  values
    (_organization_id, btrim(_source_name), nullif(btrim(_source_revision), ''),
     btrim(_schema_version), _hash, _source_kind, nullif(btrim(_source_filename), ''),
     _source_byte_size, 'preview', _count, now(), _uid, _uid,
     _source_flags, nullif(btrim(_source_restricted_reason), ''),
     coalesce(_commercial_only, false))
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
    _raw := case when jsonb_typeof(_item -> 'sourceRaw') = 'object'
                 then _item -> 'sourceRaw' else '{}'::jsonb end;
    _warnings := case when jsonb_typeof(_item -> 'warnings') = 'array'
                      then _item -> 'warnings' else '[]'::jsonb end;

    _payload_hash := private.sha256_hex(_payload::text);
    _key := private.knowledge_import_dedupe_key(_entity_type, _payload);
    _errors := private.knowledge_import_validation_errors(_entity_type, _payload);
    _text_flags := private.import_restricted_flags(_entity_type, _payload);
    _missing := private.import_missing_facts(_entity_type, _payload);
    _candidates := '[]'::jsonb;
    _dupe_of := null;
    _change := null;

    -- Combine declared/text flags with source-level flags. UNION only —
    -- source flags never suppress a text signal, text signals never
    -- suppress a source flag, and neither ever suppresses a declared flag.
    _combined_flags := coalesce(
      (select array_agg(distinct f)
       from unnest(_text_flags || _source_flags) f
       where f is not null and btrim(f) <> ''),
      '{}'::text[]);
    _flags := _combined_flags;

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
       case
         when _flags <> '{}' and _source_flags <> '{}' and nullif(btrim(_source_restricted_reason), '') is not null then
           btrim(_source_restricted_reason)
             || ' (source-level; flags: ' || array_to_string(_flags, ', ') || ')'
         when _flags <> '{}' and _source_flags <> '{}' then
           'The source that produced this row is declared restricted; every '
             || 'item requires clinician review before use (flags: '
             || array_to_string(_flags, ', ') || ').'
         when _flags <> '{}' then
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
       case when _change in ('unchanged', 'conflict', 'ambiguous') then 'skipped'
            else 'needs_review' end,
       _warnings,
       _errors);

    _added := _added + (case when _change = 'add' then 1 else 0 end);
    _changed := _changed + (case when _change = 'change' then 1 else 0 end);
    _unchanged := _unchanged + (case when _change = 'unchanged' then 1 else 0 end);
    _conflicts := _conflicts + (case when _change = 'conflict' then 1 else 0 end);
    _ambiguous := _ambiguous + (case when _change = 'ambiguous' then 1 else 0 end);
    _restricted := _restricted + (case when _flags <> '{}' then 1 else 0 end);
    _deferred := _deferred + (case when jsonb_array_length(_warnings) > 0 then 1 else 0 end);
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
      ambiguous_count = _ambiguous, restricted_count = _restricted,
      deferred_count = _deferred
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
       'ambiguous', _ambiguous, 'restricted', _restricted, 'deferred', _deferred,
       'sourceRestrictedFlags', _source_flags,
       'commercialOnly', coalesce(_commercial_only, false)));

  return jsonb_build_object(
    'batchId', _batch_id, 'idempotent', false, 'status', 'preview',
    'itemCount', _count, 'added', _added, 'changed', _changed,
    'unchanged', _unchanged, 'conflicts', _conflicts, 'removals', _removed,
    'ambiguous', _ambiguous, 'restricted', _restricted,
    'deferred', _deferred,
    'commercialOnly', coalesce(_commercial_only, false),
    'sourceRestrictedFlags', to_jsonb(_source_flags),
    'sourceSha256', _hash,
    'message', 'Preview only. No governed record has been created or changed. '
      || 'Review every change and commit explicitly to apply.');
end;
$$;

revoke all on function public.preview_knowledge_import(
  uuid, text, text, text, jsonb, boolean, text, bigint, text,
  text[], text, boolean) from public, anon;
grant execute on function public.preview_knowledge_import(
  uuid, text, text, text, jsonb, boolean, text, bigint, text,
  text[], text, boolean) to authenticated;

-- --------------------------- 4. commit_knowledge_import: refuse commercial

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
  _restricted integer := 0;
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

  -- A commercial-only batch never enters the clinical apply path. Its
  -- rows must be attached to existing clinical products through
  -- `save_product_label_version`, which routes commercial URLs and
  -- disclosure statements into `product_label_commercial_links`. Refusing
  -- at commit is the entry gate; that is why this check is at the top of
  -- the function and not inside the per-item loop.
  if _b.commercial_only is true then
    raise exception 'this batch is declared commercial_only; its rows cannot be committed as clinical content. Attach the commercial data to existing clinical products via save_product_label_version instead.'
      using errcode = '55000';
  end if;

  select count(*) into _unresolved from public.clinical_knowledge_import_items
   where batch_id = _batch_id and change_kind = 'conflict'
     and conflict_resolution is null;
  if _unresolved > 0 then
    raise exception 'resolve all % conflicting rows before committing', _unresolved
      using errcode = '55000';
  end if;

  select count(*) into _invalid from public.clinical_knowledge_import_items
   where batch_id = _batch_id and status = 'needs_review'
     and jsonb_array_length(validation_errors) > 0;
  if _invalid > 0 then
    raise exception
      '% row(s) have validation errors; fix them in the source and re-import', _invalid
      using errcode = '55000';
  end if;

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
      perform public.review_clinical_knowledge_import_item(
        _item.id, 'accept', coalesce(_note, 'Committed via import review'));
      select applied_ref_type, applied_ref_id into _ref_type, _ref_id
        from public.clinical_knowledge_import_items where id = _item.id;
      _applied := _applied + 1;

    else
      _grade := lower(btrim(coalesce(_p ->> 'evidenceClassification', 'unclassified')));
      _reference_id := private.knowledge_import_resolve_reference(
        _b.organization_id, _p ->> 'referenceCode');
      if _item.entity_type = 'catalog_product' then
        perform private.apply_catalog_product_item(
          _b.organization_id, _uid, _item.id, _p, _item.restricted_flags,
          _item.restricted_reason, _item.missing_facts, _b.id, _b.source_filename,
          _item.source_sheet, _item.source_row_number, _item.source_raw);
        select applied_ref_type, applied_ref_id into _ref_type, _ref_id
          from public.clinical_knowledge_import_items where id = _item.id;
      else
        perform private.apply_knowledge_graph_item(
          _b.organization_id, _uid, _item.id, _item.entity_type, _p, _reference_id, _grade);
        select applied_ref_type, applied_ref_id into _ref_type, _ref_id
          from public.clinical_knowledge_import_items where id = _item.id;
      end if;

      update public.clinical_knowledge_import_items
      set status = 'applied', applied_ref_type = _ref_type, applied_ref_id = _ref_id,
          reviewed_by = _uid, reviewed_at = now(),
          review_note = coalesce(_note, 'Committed via import review')
      where id = _item.id;
      _applied := _applied + 1;
      _restricted := _restricted
        + (case when _item.restricted_flags <> '{}' then 1 else 0 end);

    end if;
  end loop;

  select count(*) into _skipped from public.clinical_knowledge_import_items
   where batch_id = _batch_id and status = 'skipped';

  update public.clinical_knowledge_import_batches
  set status = 'committed', committed_at = now(), committed_by = _uid,
      applied_count = _applied, commit_note = _note
  where id = _batch_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_b.organization_id, _uid, 'knowledge.import_committed',
     'clinical_knowledge_import_batch', _b.id::text,
     'Import committed as non-approved drafts',
     jsonb_build_object('applied', _applied, 'skipped', _skipped,
       'restricted', _restricted));

  return jsonb_build_object(
    'batchId', _b.id, 'status', 'committed',
    'applied', _applied, 'skipped', _skipped,
    'restricted', _restricted, 'approvalState', 'draft',
    'message', 'Import committed. Every applied row is a NON-APPROVED draft. '
      || 'Restricted rows require a named clinician review before they can be '
      || 'used clinically. Nothing here has been approved.');
end;
$$;

revoke all on function public.commit_knowledge_import(uuid, jsonb, text)
  from public, anon;
grant execute on function public.commit_knowledge_import(uuid, jsonb, text)
  to authenticated;
