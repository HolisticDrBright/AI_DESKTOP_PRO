-- Fix: the batch dedupe index made conflict resolution impossible.
--
-- `ckii_batch_dedupe_idx` was UNIQUE on (batch_id, entity_type, dedupe_key) with
-- the stated intent "within one batch, a dedupe key appears once". That is the
-- wrong invariant, and it contradicted the feature it sat next to: recording a
-- conflict REQUIRES storing both rows, because a reviewer cannot choose between
-- two rows they can only see one of. Preview raised 23505 on the second row and
-- the conflict path could never run.
--
-- The invariant that actually matters is narrower: AT MOST ONE ROW PER IDENTITY
-- MAY BE APPLIED. Rows awaiting a decision are `needs_review`; everything else
-- (`skipped`, `rejected`, `applied`) is not competing to be written. So the
-- index is scoped to `needs_review`, and conflicting rows are staged as
-- `skipped` until a reviewer resolves them.
--
-- `take_incoming` then has to DEMOTE BEFORE IT PROMOTES: a plain unique index is
-- checked per statement, so promoting the incoming row while the superseded one
-- is still `needs_review` would collide. The order is not cosmetic.

begin;

drop index if exists public.ckii_batch_dedupe_idx;

create unique index ckii_batch_applyable_dedupe_idx
  on public.clinical_knowledge_import_items (batch_id, entity_type, dedupe_key)
  where dedupe_key is not null and status = 'needs_review';

-- Stage conflicting rows as `skipped` rather than `needs_review`.
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
       -- A conflicting row is STAGED BUT NOT APPLYABLE. It is visible to the
       -- reviewer and inert until they decide.
       case when _change in ('unchanged', 'conflict') then 'skipped'
            else 'needs_review' end,
       case when jsonb_typeof(_item -> 'warnings') = 'array'
            then _item -> 'warnings' else '[]'::jsonb end,
       _errors);

    _added := _added + (case when _change = 'add' then 1 else 0 end);
    _changed := _changed + (case when _change = 'change' then 1 else 0 end);
    _unchanged := _unchanged + (case when _change = 'unchanged' then 1 else 0 end);
    _conflicts := _conflicts + (case when _change = 'conflict' then 1 else 0 end);
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

-- `take_incoming` supersedes the earlier row. Demote it FIRST: the unique index
-- is checked per statement, so promoting before demoting would collide.
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
  if _item.conflict_resolution is not null then
    raise exception 'this conflict has already been resolved' using errcode = '55000';
  end if;
  if _resolution not in ('keep_existing', 'take_incoming', 'skip') then
    raise exception 'resolution must be keep_existing, take_incoming or skip'
      using errcode = '22023';
  end if;
  if coalesce(btrim(_note), '') = '' then
    raise exception 'a conflict resolution requires a reason' using errcode = '22023';
  end if;

  if _resolution = 'take_incoming' then
    -- Demote the row this one supersedes, so exactly one applyable row remains.
    update public.clinical_knowledge_import_items
    set status = 'skipped',
        review_note = 'Superseded by a later row in the same file, chosen by a reviewer.',
        reviewed_by = _uid, reviewed_at = now()
    where id = _item.conflict_with_item_id;

    update public.clinical_knowledge_import_items
    set conflict_resolution = _resolution, review_note = _note,
        reviewed_by = _uid, reviewed_at = now(),
        change_kind = 'change', status = 'needs_review'
    where id = _item_id;
  else
    update public.clinical_knowledge_import_items
    set conflict_resolution = _resolution, review_note = _note,
        reviewed_by = _uid, reviewed_at = now(), status = 'skipped'
    where id = _item_id;
  end if;

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

commit;
