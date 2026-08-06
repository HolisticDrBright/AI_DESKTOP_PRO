-- Phase 9E-B — bounded practitioner review of the Research Handoff.
--
-- 1. `research_review_verdict` on import items: a RECORDED PRACTITIONER
--    CLAIM ('verified' | 'blocked'), never an apply. The item's `status`
--    stays 'needs_review', so every downstream gate (commit, activation,
--    attachment, approval) remains exactly as closed as before the
--    verdict was recorded.
-- 2. A guard on the generic `review_clinical_knowledge_import_item`:
--    an 'accept' whose entity type has NO governed apply path previously
--    fell through and marked the item 'applied' with `applied_ref_type =
--    null` — a claim that something was applied when nothing was. It now
--    refuses with 55000. (The commit path only routes 'pathway' and
--    'product_label' through this RPC; both have apply paths.)
-- 3. `record_research_handoff_item_review` — the governed per-item
--    decision RPC for research-handoff items. Requires a knowledge
--    editor, a research_handoff batch, an item awaiting review, and a
--    substantive note. Re-recording is allowed; every recording appends
--    an audit event, so the trail preserves history.
-- 4. `get_research_handoff_review` — a BOUNDED read: at most 50 caller-
--    supplied PRH ids, returning clinical / evidence / commercial slices
--    under separate top-level keys. The caller derives the audited set
--    from the hash-verified package manifest; nothing here infers it.

-- --- 1. the verdict column -------------------------------------------------

alter table public.clinical_knowledge_import_items
  add column if not exists research_review_verdict text;
alter table public.clinical_knowledge_import_items
  drop constraint if exists ckii_research_review_verdict_check;
alter table public.clinical_knowledge_import_items
  add constraint ckii_research_review_verdict_check
  check (research_review_verdict is null
         or research_review_verdict in ('verified', 'blocked'));

-- --- 2. guard the generic review RPC ---------------------------------------

create or replace function public.review_clinical_knowledge_import_item(
  _item_id uuid, _decision text, _review_note text default null::text
) returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  _item public.clinical_knowledge_import_items%rowtype;
  _batch public.clinical_knowledge_import_batches%rowtype;
  _uid uuid;
  _payload jsonb;
  _pathway_id uuid;
  _version_id uuid;
  _label_id uuid;
  _version integer;
  _applied_type text;
  _applied_id uuid;
  _affiliate text;
begin
  select * into _item
  from public.clinical_knowledge_import_items
  where id = _item_id
  for update;
  if not found then
    raise exception 'clinical knowledge import item not found' using errcode = 'P0002';
  end if;
  _uid := private.require_knowledge_editor(_item.organization_id);
  if _item.status <> 'needs_review' then
    raise exception 'only an item awaiting review can be decided' using errcode = '55000';
  end if;
  if _decision not in ('accept', 'reject') then
    raise exception 'decision must be accept or reject' using errcode = '22023';
  end if;

  select * into _batch
  from public.clinical_knowledge_import_batches
  where id = _item.batch_id
  for update;

  if _decision = 'reject' then
    update public.clinical_knowledge_import_items
    set status = 'rejected', review_note = _review_note,
        reviewed_by = _uid, reviewed_at = now()
    where id = _item_id;
  else
    if jsonb_array_length(_item.validation_errors) > 0 then
      raise exception 'validation errors must be resolved in the source and re-imported'
        using errcode = '55000';
    end if;
    _payload := _item.payload;

    if _item.entity_type = 'pathway' then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          _item.organization_id::text || ':pathway:' || lower(btrim(_payload ->> 'code')),
          0
        )
      );
      select id into _pathway_id
      from public.clinical_pathways
      where organization_id = _item.organization_id
        and code = lower(btrim(_payload ->> 'code'))
        and retired_at is null
      for update;

      if _pathway_id is null then
        insert into public.clinical_pathways
          (organization_id, code, name, domain_code, description, created_by)
        values
          (_item.organization_id, lower(btrim(_payload ->> 'code')),
           btrim(_payload ->> 'name'), lower(btrim(_payload ->> 'domainCode')),
           coalesce(_payload ->> 'description', ''), _uid)
        returning id into _pathway_id;
      end if;

      select coalesce(max(version), 0) + 1 into _version
      from public.clinical_pathway_versions
      where pathway_id = _pathway_id;

      insert into public.clinical_pathway_versions
        (pathway_id, organization_id, version, content, source_refs,
         content_sha256, change_summary, created_by)
      values
        (_pathway_id, _item.organization_id, _version, _payload -> 'content',
         case when jsonb_typeof(_payload -> 'sourceRefs') = 'array'
              then _payload -> 'sourceRefs' else '[]'::jsonb end,
         private.sha256_hex((_payload -> 'content')::text),
         'Imported from ' || _batch.source_name || '; practitioner review required',
         _uid)
      returning id into _version_id;

      _applied_type := 'clinical_pathway_version';
      _applied_id := _version_id;
    elsif _item.entity_type = 'product_label' then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          _item.organization_id::text || ':product-label:' || lower(btrim(_payload ->> 'productCode')),
          0
        )
      );
      select coalesce(max(version), 0) + 1 into _version
      from public.product_label_versions
      where organization_id = _item.organization_id
        and product_code = lower(btrim(_payload ->> 'productCode'));

      insert into public.product_label_versions
        (organization_id, product_code, version, product_name, brand,
         exact_label, label_sha256, source_url, created_by)
      values
        (_item.organization_id, lower(btrim(_payload ->> 'productCode')),
         _version, btrim(_payload ->> 'productName'), btrim(_payload ->> 'brand'),
         _payload -> 'exactLabel',
         private.sha256_hex((_payload -> 'exactLabel')::text),
         nullif(btrim(_payload ->> 'sourceUrl'), ''), _uid)
      returning id into _label_id;

      _affiliate := nullif(btrim(coalesce(_payload ->> 'affiliateUrl', '')), '');
      if _affiliate is not null then
        insert into public.product_label_commercial_links
          (organization_id, label_version_id, kind, url, commission_disclosure,
           recorded_by)
        values
          (_item.organization_id, _label_id, 'affiliate', _affiliate,
           'Imported from ' || _batch.source_name || ' without explicit disclosure '
             || 'text. Review and complete the disclosure before this link is shown.',
           _uid);
      end if;

      _applied_type := 'product_label_version';
      _applied_id := _label_id;
    end if;

    -- The guard: an accept that applied nothing is a claim nobody made.
    if _applied_type is null then
      raise exception
        'no governed apply path exists for entity type "%"; record a research-handoff review instead of accepting',
        _item.entity_type
        using errcode = '55000';
    end if;

    update public.clinical_knowledge_import_items
    set status = 'applied', review_note = _review_note,
        reviewed_by = _uid, reviewed_at = now(),
        applied_ref_type = _applied_type, applied_ref_id = _applied_id
    where id = _item_id;
  end if;

  if not exists (
    select 1 from public.clinical_knowledge_import_items
    where batch_id = _item.batch_id and status = 'needs_review'
  ) then
    update public.clinical_knowledge_import_batches
    set status = 'completed', completed_at = now()
    where id = _item.batch_id;
  end if;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_item.organization_id, _uid,
     case when _decision = 'accept'
          then 'knowledge.import_item_applied'
          else 'knowledge.import_item_rejected' end,
     'clinical_knowledge_import_item', _item_id::text,
     case when _decision = 'accept'
          then 'Clinical knowledge import item applied as non-approved draft'
          else 'Clinical knowledge import item rejected' end,
     jsonb_build_object('entityType', _item.entity_type));

  return jsonb_build_object(
    'status', case when _decision = 'accept' then 'applied' else 'rejected' end,
    'appliedRefType', _applied_type,
    'appliedRefId', _applied_id
  );
end;
$function$;

-- --- 3. the governed research-handoff decision RPC -------------------------

create or replace function public.record_research_handoff_item_review(
  _item_id uuid, _verdict text, _note text
) returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  _item public.clinical_knowledge_import_items%rowtype;
  _batch public.clinical_knowledge_import_batches%rowtype;
  _uid uuid;
begin
  select * into _item
  from public.clinical_knowledge_import_items
  where id = _item_id
  for update;
  if not found then
    raise exception 'clinical knowledge import item not found' using errcode = 'P0002';
  end if;
  _uid := private.require_knowledge_editor(_item.organization_id);

  select * into _batch
  from public.clinical_knowledge_import_batches
  where id = _item.batch_id;
  if _batch.source_kind is distinct from 'research_handoff' then
    raise exception 'research-handoff review applies only to research_handoff batches'
      using errcode = '55000';
  end if;
  if _item.status <> 'needs_review' then
    raise exception 'only an item awaiting review can carry a research-handoff verdict'
      using errcode = '55000';
  end if;
  if _verdict not in ('verified', 'blocked') then
    raise exception 'verdict must be verified or blocked' using errcode = '22023';
  end if;
  if length(btrim(coalesce(_note, ''))) < 10 then
    raise exception 'a substantive review note is required (10+ characters)'
      using errcode = '22023';
  end if;

  -- A recorded claim, not an apply: status stays 'needs_review'.
  update public.clinical_knowledge_import_items
  set research_review_verdict = _verdict,
      review_note = btrim(_note),
      reviewed_by = _uid, reviewed_at = now()
  where id = _item_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_item.organization_id, _uid, 'research_handoff.item_reviewed',
     'clinical_knowledge_import_item', _item_id::text,
     'Research-handoff practitioner verdict recorded. Item status unchanged; nothing applied, activated, or attached.',
     jsonb_build_object(
       'externalKey', _item.external_key,
       'entityType', _item.entity_type,
       'verdict', _verdict,
       'batchId', _item.batch_id));

  return jsonb_build_object(
    'ok', true,
    'itemId', _item_id,
    'externalKey', _item.external_key,
    'verdict', _verdict,
    'status', 'needs_review');
end;
$function$;

revoke all on function public.record_research_handoff_item_review(uuid, text, text)
  from public, anon;
grant execute on function public.record_research_handoff_item_review(uuid, text, text)
  to authenticated, service_role;

-- --- 4. the bounded read ----------------------------------------------------

create or replace function public.get_research_handoff_review(
  _organization_id uuid, _prh_ids text[]
) returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare
  _uid uuid;
  _id text;
  _batches jsonb;
  _records jsonb;
  _evidence jsonb;
  _commercial jsonb;
begin
  _uid := private.require_knowledge_editor(_organization_id);

  if _prh_ids is null or array_length(_prh_ids, 1) is null then
    raise exception 'at least one PRH id is required' using errcode = '22023';
  end if;
  if array_length(_prh_ids, 1) > 50 then
    raise exception 'a bounded review reads at most 50 records at a time'
      using errcode = '22023';
  end if;
  foreach _id in array _prh_ids loop
    if _id !~ '^PRH-\d{4}$' then
      raise exception 'PRH ids must match PRH-9999' using errcode = '22023';
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'sourceName', b.source_name, 'status', b.status,
    'itemCount', b.item_count, 'commercialOnly', b.commercial_only,
    'manifestSha256', b.manifest_sha256)
    order by b.created_at), '[]'::jsonb)
  into _batches
  from public.clinical_knowledge_import_batches b
  where b.organization_id = _organization_id
    and b.source_kind = 'research_handoff';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'externalKey', i.external_key,
    'displayName', i.display_name, 'status', i.status,
    'verdict', i.research_review_verdict,
    'reviewNote', i.review_note, 'reviewedAt', i.reviewed_at,
    'warnings', i.warnings, 'payload', i.payload)
    order by i.external_key), '[]'::jsonb)
  into _records
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.organization_id = _organization_id
    and b.source_kind = 'research_handoff'
    and i.entity_type = 'product_label_research'
    and i.external_key = any(_prh_ids);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'externalKey', i.external_key,
    'productResearchId', i.payload ->> 'product_research_id',
    'payload', i.payload)
    order by i.external_key), '[]'::jsonb)
  into _evidence
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.organization_id = _organization_id
    and b.source_kind = 'research_handoff'
    and i.entity_type = 'product_label_evidence'
    and i.payload ->> 'product_research_id' = any(_prh_ids);

  -- Commercial rows come back under their OWN top-level key. They are
  -- quarantined commercial-only data and are rendered separately.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'externalKey', i.external_key, 'payload', i.payload)
    order by i.external_key), '[]'::jsonb)
  into _commercial
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.organization_id = _organization_id
    and b.source_kind = 'research_handoff'
    and b.commercial_only = true
    and i.entity_type = 'product_label_commercial_link'
    and i.external_key = any(_prh_ids);

  return jsonb_build_object(
    'batches', _batches,
    'records', _records,
    'evidence', _evidence,
    'commercial', _commercial,
    'boundary',
    'Verdicts recorded here are practitioner claims on research records. '
    || 'Nothing is applied, activated, attached, committed, or approved by this surface.');
end;
$function$;

revoke all on function public.get_research_handoff_review(uuid, text[])
  from public, anon;
grant execute on function public.get_research_handoff_review(uuid, text[])
  to authenticated, service_role;
