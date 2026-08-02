-- Phase 9D repair — restore commit_knowledge_import correctly with the
-- commercial-only gate added.
--
-- The Phase 9D source-restriction migration (`20260802215557`) replaced
-- `commit_knowledge_import` with a placeholder body that named a helper
-- (`private.knowledge_import_resolve_reference`) that does not exist —
-- I mis-remembered the real function's shape. This restores the correct
-- body from `20260801224354` (the last known-good version) and adds the
-- new commercial-only entry gate immediately after the status check.
--
-- The gate refuses to commit a batch declared `commercial_only=true`
-- with SQLSTATE `55000`. Commercial rows must be attached to existing
-- clinical products through `save_product_label_version`, which routes
-- affiliate URLs and disclosure statements into
-- `product_label_commercial_links`. This is the entry gate; refusing
-- here means the clinical apply path is never entered for these rows.

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

  -- Commercial-only entry gate. Refusing here keeps the clinical apply
  -- path unreachable for these rows; commercial data lands via
  -- `save_product_label_version` under Phase 9B's commercial separation.
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

  select count(*) into _ambiguous from public.clinical_knowledge_import_items
   where batch_id = _batch_id and change_kind = 'ambiguous';
  if _ambiguous > 0 then
    raise exception 'resolve all % ambiguous rows before committing; each one resembles an existing product closely enough that applying it blind would duplicate or overwrite it', _ambiguous
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
    'message', 'Imported content is stored as NON-APPROVED drafts. Import is not review, and nothing here is approved for clinical use until a practitioner approves it. Imported products are NOT selectable in the protocol picker until their review state is completed.');
end;
$$;
