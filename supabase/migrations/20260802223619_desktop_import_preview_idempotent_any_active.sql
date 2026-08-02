-- Phase 9D repair — preview idempotency must match the partial dedupe index.
--
-- The dedupe partial unique index (`ckib_source_hash_idx`) applies to any
-- batch whose status is NOT `cancelled` — committed and preview batches
-- both occupy the slot. But the idempotent branch of
-- `preview_knowledge_import` only returned an existing batch when its
-- status was `preview`. Result: previewing the SAME items after commit
-- returned nothing from the idempotent check, tried to INSERT a new
-- batch with the same hash, and tripped 23505 unique_violation — which
-- broke acceptance test 25 in `desktop_knowledge_import_graph.sql`
-- ("re-importing the same file is idempotent, not duplicated").
--
-- Fix: return the existing batch regardless of its status. Preview-
-- status batches keep the original meaning ("stage this again for
-- review"). Committed/cancelled batches return with their status so
-- the caller can see what happened, matching the original 9C behavior.

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

  _source_flags := coalesce(
    (select array_agg(distinct lower(btrim(f)))
     from unnest(coalesce(_source_restricted_flags, '{}'::text[])) f
     where btrim(f) <> ''),
    '{}'::text[]);

  _hash := private.sha256_hex(
    _items::text
    || '|' || coalesce(array_to_string(_source_flags, ','), '')
    || '|' || case when _commercial_only then '1' else '0' end);

  -- The idempotent check must match the SCOPE of the dedupe index. The
  -- partial unique on (organization_id, source_sha256) applies to
  -- status <> 'cancelled', so any preview/committed batch with this
  -- hash is what will collide on insert. Returning it here matches
  -- the original 9C idempotency contract for the same-file case.
  select * into _existing_batch from public.clinical_knowledge_import_batches
   where organization_id = _organization_id and source_sha256 = _hash
     and status <> 'cancelled'
   order by preview_generated_at desc
   limit 1;
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
      'message', 'This exact file was already imported with the same source flags. The existing batch is returned unchanged; nothing was staged a second time.');
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
           'The source that produced this row is declared restricted; every item requires clinician review before use (flags: '
             || array_to_string(_flags, ', ') || ').'
         when _flags <> '{}' then
           'Flagged as restricted (' || array_to_string(_flags, ', ') || '). A restricted item is not usable until a named reviewer clears it.'
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
           || ' existing product(s). Applying it would either duplicate one or overwrite the wrong one. Confirm which before committing.' end,
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
    'message', 'Preview only. No governed record has been created or changed. Review every change and commit explicitly to apply.');
end;
$$;

revoke all on function public.preview_knowledge_import(
  uuid, text, text, text, jsonb, boolean, text, bigint, text,
  text[], text, boolean) from public, anon;
grant execute on function public.preview_knowledge_import(
  uuid, text, text, text, jsonb, boolean, text, bigint, text,
  text[], text, boolean) to authenticated;
