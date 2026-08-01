-- Phase 9B correction: finish the commercial separation, and repair the
-- regression the first attempt introduced.
--
-- TWO DEFECTS, both found by asking a better question than the first pass did.
--
-- 1. REGRESSION I CAUSED. `20260801210000` dropped
--    `product_label_versions.affiliate_url`, but
--    `review_clinical_knowledge_import_item` still INSERTS that column. plpgsql
--    bodies are not validated against the catalog at definition time, so the
--    function kept its definition and would fail only when a reviewer accepted
--    a product-label import. My separation proof searched for commercial TABLE
--    names and so could never have matched a bare COLUMN name.
--
-- 2. DEFECT THE FIRST PASS MISSED ENTIRELY. `protocol_items.affiliate_url` —
--    an affiliate link on the clinical protocol line itself. It is worse than
--    the label case in three ways:
--      * it is COPIED FORWARD by create_protocol_template,
--        create_protocol_draft and revise_protocol_version, so it propagates
--        through every clinical version automatically;
--      * `private.protocol_version_json` EMITS it as `affiliateUrl`, so the
--        clinical read path served commercial data to the browser beside the
--        dosage;
--      * `save_protocol_draft` accepts it from the client payload.
--    A claim that commercial data cannot influence clinical ranking is not
--    provable while an affiliate URL rides inside the clinical payload.
--
-- WHY THE LINK IS KEYED TO THE VERSION, NOT THE ITEM. `save_protocol_draft`
-- wholesale-deletes and reinserts every protocol_item on each autosave. A
-- commercial row keyed to `protocol_items.id` would be cascade-deleted on the
-- next keystroke. `protocol_versions.id` is stable, so the link hangs there and
-- names the product version it concerns plus the item label it came from.
-- The label is a human locator, deliberately NOT a foreign key: it must not
-- become a second path by which commercial data re-enters a clinical join.

begin;

create table public.protocol_commercial_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  protocol_version_id uuid not null
    references public.protocol_versions(id) on delete cascade,
  /** The commercial subject, where one is known. Null means the link was
      recorded against a line with no catalog product (a book, a device). */
  catalog_product_version_id uuid
    references public.supplement_product_versions(id) on delete set null,
  /** Human locator only. Never joined to, never used to resolve a product. */
  item_label text,

  kind text not null default 'affiliate'
    check (kind in ('affiliate', 'supplier', 'retailer', 'other')),
  url text,
  supplier_name text,
  commission_disclosure text,
  availability_status text
    check (availability_status in ('available', 'out_of_stock', 'discontinued', 'unknown')),
  last_verified_at timestamptz,

  supersedes_id uuid references public.protocol_commercial_links(id),
  revoked_at timestamptz,
  revoked_reason text,

  recorded_at timestamptz not null default now(),
  recorded_by uuid references auth.users(id),

  constraint procl_affiliate_needs_disclosure check (
    kind <> 'affiliate' or url is null or commission_disclosure is not null)
);

create index procl_org_idx on public.protocol_commercial_links (organization_id);
create index procl_version_idx
  on public.protocol_commercial_links (protocol_version_id, recorded_at desc);
create index procl_product_idx
  on public.protocol_commercial_links (catalog_product_version_id);
create index procl_supersedes_idx on public.protocol_commercial_links (supersedes_id);
create index procl_recorded_by_idx on public.protocol_commercial_links (recorded_by);

alter table public.protocol_commercial_links enable row level security;

create policy protocol_commercial_links_select on public.protocol_commercial_links
  for select to authenticated using (private.is_org_member(organization_id));

revoke insert, update, delete on public.protocol_commercial_links from anon, authenticated;

create trigger protocol_commercial_links_append_only
  before update or delete on public.protocol_commercial_links
  for each row execute function private.knowledge_append_only();

-- ------------------------------------------------------- preserve history
--
-- Zero rows today. Written to be correct against a populated database anyway,
-- because that is the difference between a migration and a convenience.

insert into public.protocol_commercial_links
  (organization_id, protocol_version_id, catalog_product_version_id, item_label,
   kind, url, commission_disclosure, recorded_at, recorded_by)
select it.organization_id, it.version_id, it.catalog_product_version_id, it.label,
       'affiliate', it.affiliate_url,
       'Migrated from protocol_items.affiliate_url. The original record carried '
         || 'no disclosure text; treat it as undisclosed pending review.',
       it.created_at, null
from public.protocol_items it
where it.affiliate_url is not null and btrim(it.affiliate_url) <> '';

-- ============================== repair the import RPC before the column goes
--
-- Same body as before, with the affiliate write routed to the commercial model.
-- Everything else is byte-for-byte the existing function: this is a repair, not
-- a redesign, and the import acceptance suite must keep passing unchanged.

create or replace function public.review_clinical_knowledge_import_item(
  _item_id uuid, _decision text, _review_note text default null::text)
returns jsonb language plpgsql security definer set search_path = ''
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

      -- Commercial data is accepted from the source, but it lands in the
      -- commercial model. The label row itself no longer has a column for it.
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

-- ================================ stop the clinical read path serving commerce
--
-- `affiliateUrl` is removed from the protocol version payload. This is the
-- single most important line in the migration: it is what makes "an affiliate
-- link cannot influence clinical ranking" true rather than aspirational,
-- because the clinical payload no longer contains one to rank by.

create or replace function private.protocol_version_json(_version_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select jsonb_build_object(
    'id', v.id,
    'version', v.version,
    'status', v.status,
    'title', v.title,
    'summary', v.summary,
    'dietInstructions', v.diet_instructions,
    'lifestyleInstructions', v.lifestyle_instructions,
    'monitoringPlan', v.monitoring_plan,
    'followupPlan', v.followup_plan,
    'sourceTemplateId', v.source_template_id,
    'sourceTemplateVersion', v.source_template_version,
    'supersedesVersionId', v.supersedes_version_id,
    'approvedAt', v.approved_at,
    'activatedAt', v.activated_at,
    'reviewNote', v.review_note,
    'updatedAt', v.updated_at,
    'createdAt', v.created_at,
    'phases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ph.id, 'name', ph.name, 'position', ph.position,
        'startsOn', ph.starts_on, 'endsOn', ph.ends_on,
        'relativeStartDay', ph.relative_start_day,
        'relativeDurationDays', ph.relative_duration_days,
        'notes', ph.notes) order by ph.position, ph.created_at)
      from public.protocol_phases ph where ph.version_id = v.id), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', it.id, 'phaseId', it.phase_id, 'kind', it.kind,
        'position', it.position, 'label', it.label,
        'instructions', it.instructions,
        'catalogProductId', it.catalog_product_id,
        'catalogProductVersionId', it.catalog_product_version_id,
        'manufacturer', it.manufacturer, 'labelVersion', it.label_version,
        'dosageText', it.dosage_text, 'timingText', it.timing_text,
        'route', it.route,
        'verificationStatus', it.verification_status,
        'interactionReviewState', it.interaction_review_state)
        order by it.kind, it.position, it.created_at)
      from public.protocol_items it where it.version_id = v.id), '[]'::jsonb)
  )
  from public.protocol_versions v where v.id = _version_id;
$function$;

-- ====================== drop the column reference from the copy-forward path
--
-- `create_protocol_template`, `create_protocol_draft` and
-- `revise_protocol_version` are long functions whose ONLY change here is the
-- removal of one column from an insert list and its matching value from the
-- select. Rewriting them by hand means retyping ~80 lines each and risking a
-- silent unrelated edit, so the removal is done mechanically — and GUARDED:
-- each function must contain exactly the two expected occurrences before, and
-- zero after, or the migration aborts. A rewrite that does not match its
-- expectation fails loudly instead of producing a subtly wrong function.

do $do$
declare
  _fn text;
  _def text;
  _before integer;
  _after integer;
begin
  foreach _fn in array array[
    'public.create_protocol_template(uuid, text, text, uuid)',
    'public.create_protocol_draft(uuid, uuid, text, uuid)',
    'public.revise_protocol_version(uuid)'
  ]
  loop
    select pg_get_functiondef(_fn::regprocedure) into _def;

    select count(*) into _before
    from regexp_matches(_def, 'affiliate_url', 'g');
    if _before <> 2 then
      raise exception
        'expected exactly 2 affiliate_url references in %, found % — aborting '
        'rather than rewriting a function that is not what this migration '
        'was written against', _fn, _before
        using errcode = '22023';
    end if;

    -- the insert column list, then the matching select value
    _def := replace(_def, ', affiliate_url)', ')');
    _def := regexp_replace(_def, ',\s*it\.affiliate_url', '', 'g');

    select count(*) into _after
    from regexp_matches(_def, 'affiliate_url', 'g');
    if _after <> 0 then
      raise exception 'rewrite of % left % affiliate_url reference(s)', _fn, _after
        using errcode = '22023';
    end if;

    execute _def;
  end loop;
end
$do$;

-- ================================== the draft save keeps its caller contract
--
-- A payload carrying `affiliateUrl` is NOT silently ignored — silent dropping
-- is how data loss gets called a feature. It is recorded, in the commercial
-- model, attributed to the item label it arrived with. Because a draft autosave
-- replaces every item on every keystroke, the insert is guarded so repeated
-- saves do not append the same link over and over.

create or replace function public.save_protocol_draft(
  _version_id uuid, _payload jsonb,
  _expected_updated_at timestamp with time zone default null::timestamp with time zone)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
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

  -- Wholesale replace: the client owns draft ordering, the server owns bounds.
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
    -- Catalog references must exist; a bad id is refused, never silently kept.
    if _product_id is not null
       and not exists (select 1 from public.supplement_products sp
                       where sp.id = _product_id) then
      raise exception 'catalog product not found' using errcode = 'P0002';
    end if;
    -- Product identity comes FROM THE CATALOG, not from client text.
    _manufacturer := nullif(btrim(coalesce(_item->>'manufacturer','')), '');
    _label_version := nullif(btrim(coalesce(_item->>'labelVersion','')), '');
    if _product_version_id is not null then
      select b.name, v.version_label
        into _catalog_manufacturer, _catalog_label_version
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
    _item_label := left(trim(_item->>'label'), 240);
    insert into public.protocol_items
      (organization_id, version_id, phase_id, kind, position, label, instructions,
       catalog_product_id, catalog_product_version_id, manufacturer, label_version,
       dosage_text, timing_text, route, verification_status,
       interaction_review_state)
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
       -- DERIVED, never client-asserted.
       private.catalog_verification_status(_product_id, _product_version_id),
       -- Interaction review is a practitioner act recorded by its own action;
       -- an autosave can never claim it happened.
       'not_completed')
    returning id into _new_item_id;

    -- Commercial data does not go on the clinical row. It is recorded beside
    -- the version, once, and never read back into the clinical payload.
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

    -- Returned in payload order so the caller can address the row it just
    -- saved (an interaction review targets a persisted item, never a form row).
    _item_ids := _item_ids || _new_item_id;
    _idx := _idx + 1;
  end loop;

  select * into _v from public.protocol_versions where id = _version_id;
  return jsonb_build_object('ok', true, 'versionId', _version_id,
    'updatedAt', _v.updated_at,
    'itemIds', to_jsonb(_item_ids),
    'message', 'Draft saved.');
end;
$function$;

-- ------------------------------------------------------------ drop the column

alter table public.protocol_items drop column affiliate_url;

-- ------------------------------------------------- read commerce, separately

/**
 * Commercial links recorded against a protocol version.
 *
 * A SEPARATE call, exactly like `list_label_commercial_links`. Nothing in the
 * clinical path invokes it. That is what makes the separation checkable: the
 * acceptance suite asserts no clinical function body names this table.
 */
create or replace function public.list_protocol_commercial_links(_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _org uuid; _out jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select organization_id into _org from public.protocol_versions where id = _version_id;
  if _org is null then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if not private.is_org_member(_org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'kind', l.kind, 'url', l.url,
    'itemLabel', l.item_label,
    'catalogProductVersionId', l.catalog_product_version_id,
    'supplierName', l.supplier_name,
    'commissionDisclosure', l.commission_disclosure,
    'availabilityStatus', l.availability_status,
    'lastVerifiedAt', l.last_verified_at, 'revokedAt', l.revoked_at,
    'recordedAt', l.recorded_at) order by l.recorded_at desc), '[]'::jsonb)
  into _out
  from public.protocol_commercial_links l
  where l.protocol_version_id = _version_id;

  return jsonb_build_object(
    'protocolVersionId', _version_id,
    'links', _out,
    'disclaimer', 'Commercial information is recorded for disclosure only. It is '
      || 'not read by any clinical eligibility, ranking, safety or evidence path.');
end;
$$;

revoke all on function public.list_protocol_commercial_links(uuid) from public, anon;
grant execute on function public.list_protocol_commercial_links(uuid) to authenticated;

commit;
