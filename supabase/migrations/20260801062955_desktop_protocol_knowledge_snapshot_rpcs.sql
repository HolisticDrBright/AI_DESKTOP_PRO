-- Phase 9B Part 9, wiring (2 of 2): the RPCs that write protocol items.
--
-- Split from the trigger/dependency migration purely because they were applied
-- as two ledger entries; read them together. The preceding migration made the
-- dependency edges DERIVED from items, which is why nothing here rebuilds them
-- by hand.
--
--   * `save_protocol_draft` snapshots governance onto each item at save time
--     and freezes exact product identity from the catalog row.
--   * `approve_protocol_version` calls the dose-provenance gate: draft stays
--     permissive, approval refuses a dose that names no source.
--   * The three copy-forward RPCs are extended mechanically so a revision or a
--     template copy cannot silently lose stopping rules.
--
-- NOTHING HERE INVENTS CONTENT. Every value is copied from a governed row or
-- supplied by the practitioner. An item with no intervention class keeps empty
-- arrays and NULL intervals, which render as "Unknown" — never as "no
-- monitoring required", which would be a fabricated clinical claim.

begin;

-- ================================================ snapshot governance on save

create or replace function public.save_protocol_draft(
  _version_id uuid, _payload jsonb,
  _expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = ''
as $fn$
declare
  _uid uuid := auth.uid();
  _v public.protocol_versions%rowtype;
  _phase jsonb;
  _item jsonb;
  _phase_ids uuid[] := '{}';
  _new_phase_id uuid;
  _idx integer := 0;
  _product_id uuid;
  _product_version_id uuid;
  _manufacturer text;
  _label_version text;
  _catalog_manufacturer text;
  _catalog_label_version text;
  _new_item_id uuid;
  _item_ids uuid[] := '{}';
  _affiliate text;
  _item_label text;
  -- Part 9 additions.
  _class public.clinical_intervention_classes%rowtype;
  _class_id uuid;
  _dose_kind text;
  _dose_ref text;
  _dose_reference_id uuid;
  _sku text;
  _upc text;
  _label_captured_at timestamptz;
  _label_sha256 text;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if _payload is null or jsonb_typeof(_payload) <> 'object' then
    raise exception 'invalid payload' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(_payload->'phases', '[]'::jsonb)) > 24 then
    raise exception 'too many phases (max 24)' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(_payload->'items', '[]'::jsonb)) > 200 then
    raise exception 'too many items (max 200)' using errcode = '22023';
  end if;

  select * into _v from public.protocol_versions
  where id = _version_id for update;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if _v.protocol_id is not null then
    if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
      raise exception 'not authorized to edit this protocol' using errcode = '42501';
    end if;
  else
    if not private.can_author_protocol(_v.organization_id, null) then
      raise exception 'not authorized to edit organization templates' using errcode = '42501';
    end if;
  end if;
  if _v.status <> 'draft' then
    raise exception 'only draft versions can be edited; create a new draft version'
      using errcode = '22023';
  end if;
  if _expected_updated_at is not null
     and date_trunc('milliseconds', _expected_updated_at)
         <> date_trunc('milliseconds', _v.updated_at) then
    raise exception 'this draft changed elsewhere since it was loaded'
      using errcode = '40001';
  end if;

  update public.protocol_versions
  set title = coalesce(nullif(trim(coalesce(_payload->>'title','')), ''), _v.title),
      summary = _payload->>'summary',
      diet_instructions = _payload->>'dietInstructions',
      lifestyle_instructions = _payload->>'lifestyleInstructions',
      monitoring_plan = _payload->>'monitoringPlan',
      followup_plan = _payload->>'followupPlan',
      updated_by = _uid,
      updated_at = now()
  where id = _version_id;

  delete from public.protocol_items where version_id = _version_id;
  delete from public.protocol_phases where version_id = _version_id;

  for _phase in select * from jsonb_array_elements(coalesce(_payload->'phases','[]'::jsonb))
  loop
    if coalesce(trim(_phase->>'name'), '') = '' then
      raise exception 'each phase needs a name' using errcode = '22023';
    end if;
    insert into public.protocol_phases
      (organization_id, version_id, name, position, starts_on, ends_on,
       relative_start_day, relative_duration_days, notes)
    values
      (_v.organization_id, _version_id, left(trim(_phase->>'name'), 120), _idx,
       nullif(_phase->>'startsOn','')::date, nullif(_phase->>'endsOn','')::date,
       nullif(_phase->>'relativeStartDay','')::integer,
       nullif(_phase->>'relativeDurationDays','')::integer,
       _phase->>'notes')
    returning id into _new_phase_id;
    _phase_ids := _phase_ids || _new_phase_id;
    _idx := _idx + 1;
  end loop;

  _idx := 0;
  for _item in select * from jsonb_array_elements(coalesce(_payload->'items','[]'::jsonb))
  loop
    if (_item->>'kind') not in ('product','diet','lifestyle','monitoring','followup') then
      raise exception 'invalid item kind' using errcode = '22023';
    end if;
    if coalesce(trim(_item->>'label'), '') = '' then
      raise exception 'each item needs a label' using errcode = '22023';
    end if;
    _product_id := nullif(_item->>'catalogProductId','')::uuid;
    _product_version_id := nullif(_item->>'catalogProductVersionId','')::uuid;
    if _product_id is not null
       and not exists (select 1 from public.supplement_products sp
                       where sp.id = _product_id) then
      raise exception 'catalog product not found' using errcode = 'P0002';
    end if;
    _manufacturer := nullif(btrim(coalesce(_item->>'manufacturer','')), '');
    _label_version := nullif(btrim(coalesce(_item->>'labelVersion','')), '');
    _sku := null; _upc := null; _label_captured_at := null; _label_sha256 := null;
    if _product_version_id is not null then
      -- Exact identity comes from the catalog row, never from the payload. A
      -- client-supplied SKU would let a caller relabel one product as another
      -- while keeping the verified badge.
      select b.name, v.version_label, p.sku, p.upc, v.label_captured_at, v.label_hash
        into _catalog_manufacturer, _catalog_label_version,
             _sku, _upc, _label_captured_at, _label_sha256
      from public.supplement_product_versions v
      join public.supplement_products p on p.id = v.product_id
      left join public.supplement_brands b on b.id = p.brand_id
      where v.id = _product_version_id
        and (_product_id is null or v.product_id = _product_id);
      if not found then
        raise exception 'catalog product version not found for this product'
          using errcode = 'P0002';
      end if;
      _manufacturer := _catalog_manufacturer;
      _label_version := _catalog_label_version;
    end if;

    -- ------------------------------------------- governed class snapshot
    _class_id := nullif(_item->>'interventionClassId','')::uuid;
    _class := null;
    if _class_id is not null then
      select * into _class from public.clinical_intervention_classes c
      where c.id = _class_id
        -- Platform-governed classes (NULL org) are visible to everyone; an
        -- org-owned class is visible only to that org. Without this an item
        -- could snapshot another tenant's stopping rules.
        and (c.organization_id is null or c.organization_id = _v.organization_id);
      if not found then
        raise exception 'intervention class not found' using errcode = 'P0002';
      end if;
    end if;

    -- ------------------------------------------------- dose provenance
    _dose_kind := nullif(btrim(coalesce(_item->>'doseSourceKind','')), '');
    if _dose_kind is not null
       and _dose_kind not in ('product_label','practitioner_protocol','governed_reference') then
      raise exception 'invalid dose source kind' using errcode = '22023';
    end if;
    _dose_ref := nullif(btrim(coalesce(_item->>'doseSourceRef','')), '');
    _dose_reference_id := nullif(_item->>'doseSourceReferenceId','')::uuid;
    if _dose_reference_id is not null
       and not exists (select 1 from public.clinical_knowledge_sources s
                       where s.id = _dose_reference_id) then
      raise exception 'governed reference not found' using errcode = 'P0002';
    end if;

    _item_label := left(trim(_item->>'label'), 240);
    insert into public.protocol_items
      (organization_id, version_id, phase_id, kind, position, label, instructions,
       catalog_product_id, catalog_product_version_id, manufacturer, label_version,
       dosage_text, timing_text, route, verification_status,
       interaction_review_state,
       dose_source_kind, dose_source_ref, dose_source_reference_id,
       intervention_class_id, intervention_class_code,
       monitoring_requirements, stopping_rules, contraindications,
       followup_interval_days, jurisdiction_sensitive,
       product_sku, product_upc, label_captured_at, label_sha256)
    values
      (_v.organization_id, _version_id,
       case when (_item->>'phaseIndex') is null then null
            else _phase_ids[(_item->>'phaseIndex')::integer + 1] end,
       _item->>'kind', _idx, _item_label,
       _item->>'instructions',
       _product_id,
       _product_version_id,
       _manufacturer, _label_version,
       _item->>'dosageText', _item->>'timingText', _item->>'route',
       private.catalog_verification_status(_product_id, _product_version_id),
       'not_completed',
       _dose_kind, _dose_ref, _dose_reference_id,
       _class_id, _class.code,
       -- Empty arrays where no class is attached. NOT "no monitoring required":
       -- the UI renders empty as "Unknown", which is the honest reading.
       coalesce(_class.monitoring_requirements, '{}'),
       coalesce(_class.stopping_rules, '{}'),
       coalesce(_class.contraindications, '{}'),
       _class.followup_interval_days,
       coalesce(_class.jurisdiction_sensitive, false),
       _sku, _upc, _label_captured_at, _label_sha256)
    returning id into _new_item_id;

    _affiliate := nullif(btrim(coalesce(_item->>'affiliateUrl','')), '');
    if _affiliate is not null
       and not exists (
         select 1 from public.protocol_commercial_links l
         where l.protocol_version_id = _version_id
           and l.url = _affiliate
           and coalesce(l.item_label, '') = coalesce(_item_label, '')
           and l.revoked_at is null) then
      insert into public.protocol_commercial_links
        (organization_id, protocol_version_id, catalog_product_version_id,
         item_label, kind, url, commission_disclosure, recorded_by)
      values
        (_v.organization_id, _version_id, _product_version_id, _item_label,
         'affiliate', _affiliate,
         'Recorded from a protocol draft without explicit disclosure text. '
           || 'Review and complete the disclosure before this link is shown.',
         _uid);
    end if;

    _item_ids := _item_ids || _new_item_id;
    _idx := _idx + 1;
  end loop;

  -- No explicit source rebuild here: the trigger on `protocol_items` owns that,
  -- so this path and the copy-forward paths cannot drift apart.

  select * into _v from public.protocol_versions where id = _version_id;
  return jsonb_build_object('ok', true, 'versionId', _version_id,
    'updatedAt', _v.updated_at,
    'itemIds', to_jsonb(_item_ids),
    'message', 'Draft saved.');
end;
$fn$;

revoke all on function public.save_protocol_draft(uuid, jsonb, timestamptz)
  from public, anon;
grant execute on function public.save_protocol_draft(uuid, jsonb, timestamptz)
  to authenticated;

-- =========================================== approval enforces dose provenance

create or replace function public.approve_protocol_version(
  _version_id uuid, _review_note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $fn$
declare
  _uid uuid := auth.uid();
  _v public.protocol_versions%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _v from public.protocol_versions where id = _version_id for update;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if _v.protocol_id is null then
    raise exception 'use approve_protocol_template_version for templates'
      using errcode = '22023';
  end if;
  if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
    raise exception 'not authorized to approve this protocol' using errcode = '42501';
  end if;
  if _v.status <> 'draft' then
    raise exception 'only draft versions can be approved' using errcode = '22023';
  end if;
  if not exists (select 1 from public.protocol_items where version_id = _version_id) then
    raise exception 'an empty protocol cannot be approved' using errcode = '22023';
  end if;

  -- Part 9: a dose reaching an approved protocol must name where it came from.
  -- Raises 55000 and names the offending items.
  perform private.protocol_dose_provenance_gate(_version_id);

  update public.protocol_versions
  set status = 'approved', approved_by = _uid, approved_at = now(),
      review_note = nullif(trim(coalesce(_review_note,'')), ''),
      updated_by = _uid
  where id = _version_id;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_v.organization_id, _v.patient_id, _uid, 'protocol.approved',
     'protocol_version', _version_id::text,
     'Protocol version approved by practitioner',
     jsonb_build_object('version', _v.version, 'hadNote', _review_note is not null));

  return jsonb_build_object('ok', true, 'versionId', _version_id,
    'status', 'approved',
    'message', 'Version approved and now immutable. It is NOT active — activate it separately.');
end;
$fn$;

revoke all on function public.approve_protocol_version(uuid, text) from public, anon;
grant execute on function public.approve_protocol_version(uuid, text) to authenticated;

-- ======================================= carry the snapshot through copies
--
-- Three RPCs copy items into a new version: starting a protocol from a
-- template, revising an approved version, and saving a version as a template.
-- All three list item columns explicitly, so a new column is silently dropped
-- rather than failing loudly — a revision would quietly lose its stopping
-- rules and contraindications, which is precisely the kind of silent safety
-- regression this phase exists to prevent.
--
-- Rewritten mechanically from the live definitions rather than restated by
-- hand: restating 300 lines of unrelated logic to change two lines is how an
-- unrelated behavior change gets smuggled in. The guard aborts the whole
-- migration if any function does not have exactly the shape assumed here.

do $do$
declare
  _fn text;
  _def text;
  _cols text;
  _vals text;
begin
  _cols := 'interaction_review_state,
       dose_source_kind, dose_source_ref, dose_source_reference_id,
       intervention_class_id, intervention_class_code,
       monitoring_requirements, stopping_rules, contraindications,
       followup_interval_days, jurisdiction_sensitive,
       product_sku, product_upc, label_captured_at, label_sha256)';

  _vals := $q$'not_completed',
      it.dose_source_kind, it.dose_source_ref, it.dose_source_reference_id,
      it.intervention_class_id, it.intervention_class_code,
      it.monitoring_requirements, it.stopping_rules, it.contraindications,
      it.followup_interval_days, it.jurisdiction_sensitive,
      it.product_sku, it.product_upc, it.label_captured_at, it.label_sha256
    from public.protocol_items it$q$;

  foreach _fn in array array[
    'public.create_protocol_draft(uuid, uuid, text, uuid)',
    'public.revise_protocol_version(uuid)',
    'public.create_protocol_template(uuid, text, text, uuid)']
  loop
    select pg_get_functiondef(_fn::regprocedure) into _def;

    -- Exactly one item-insert column list, and exactly one item-select tail.
    if (select count(*) from regexp_matches(_def, 'interaction_review_state\)', 'g')) <> 1 then
      raise exception
        '% does not have exactly one item column list; the mechanical rewrite '
        'would be guessing. Aborting rather than half-applying.', _fn;
    end if;
    if (select count(*) from regexp_matches(
          _def, '''not_completed''\s*\n\s*from public\.protocol_items it', 'g')) <> 1 then
      raise exception
        '% does not have exactly one item copy-select; the mechanical rewrite '
        'would be guessing. Aborting rather than half-applying.', _fn;
    end if;
    -- If it already carries the new columns this migration has run before.
    if position('label_sha256' in _def) > 0 then
      raise exception '% already carries the Part 9 columns; refusing to '
        'rewrite it twice.', _fn;
    end if;

    _def := replace(_def, 'interaction_review_state)', _cols);
    _def := regexp_replace(
      _def, '''not_completed''\s*\n\s*from public\.protocol_items it', _vals);

    execute _def;
  end loop;
end
$do$;

commit;
