-- Phase 9E-A.2: warning resolutions (append-only), safe bulk operations,
-- commercial-clinical isolation reinforcement, and pgcrypto digest fix for
-- the product label editor RPCs.

-- ============================================== warning resolutions

create table if not exists public.curation_warning_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  preview_item_id uuid references public.clinical_knowledge_import_items(id) on delete restrict,
  supplement_product_id uuid references public.supplement_products(id) on delete restrict,
  knowledge_reference_id uuid references public.governed_knowledge_references(id) on delete restrict,
  warning_key text not null,
  disposition text not null check (disposition in
    ('resolved','superseded','accepted_risk','not_applicable')),
  reason text not null check (btrim(reason) <> ''),
  decided_by uuid not null references auth.users(id),
  decided_at timestamptz not null default clock_timestamp(),
  constraint curation_warning_resolutions_exactly_one_subject
  check (
    (case when preview_item_id is null then 0 else 1 end)
    + (case when supplement_product_id is null then 0 else 1 end)
    + (case when knowledge_reference_id is null then 0 else 1 end)
    = 1
  )
);

alter table public.curation_warning_resolutions enable row level security;

create policy curation_warning_resolutions_read_org
  on public.curation_warning_resolutions for select
  using (organization_id in (
    select organization_id from public.organization_memberships
    where user_id = (select auth.uid()) and status = 'active'
  ));

create trigger curation_warning_resolutions_append_only
  before update or delete on public.curation_warning_resolutions
  for each row execute function private.knowledge_append_only();

create or replace function public.record_warning_resolution(
  _organization_id uuid,
  _subject_type text,
  _subject_id uuid,
  _warning_key text,
  _disposition text,
  _reason text
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _preview_item_id uuid;
  _product_id uuid;
  _reference_id uuid;
  _id uuid;
  _resource_type text;
  _subject_org uuid;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if _subject_type not in ('preview_item','product','knowledge_reference') then
    raise exception 'unknown subject_type' using errcode='22023';
  end if;
  if _disposition not in ('resolved','superseded','accepted_risk','not_applicable') then
    raise exception 'unknown disposition' using errcode='22023';
  end if;
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'a warning resolution requires a stated reason' using errcode='22023';
  end if;
  if coalesce(btrim(_warning_key), '') = '' then
    raise exception 'warning_key is required' using errcode='22023';
  end if;

  if _subject_type = 'preview_item' then
    select organization_id into _subject_org
    from public.clinical_knowledge_import_items where id = _subject_id;
    if not found then raise exception 'preview item not found' using errcode='P0002'; end if;
    if _subject_org is distinct from _organization_id then
      raise exception 'subject preview item belongs to a different tenant' using errcode='42501';
    end if;
    _preview_item_id := _subject_id;
    _resource_type := 'clinical_knowledge_import_item';
  elsif _subject_type = 'product' then
    if not exists (select 1 from public.supplement_products where id = _subject_id) then
      raise exception 'product not found' using errcode='P0002';
    end if;
    _product_id := _subject_id;
    _resource_type := 'supplement_product';
  else
    select organization_id into _subject_org
    from public.governed_knowledge_references where id = _subject_id;
    if not found then raise exception 'reference not found' using errcode='P0002'; end if;
    if _subject_org is distinct from _organization_id then
      raise exception 'subject reference belongs to a different tenant' using errcode='42501';
    end if;
    _reference_id := _subject_id;
    _resource_type := 'governed_knowledge_reference';
  end if;

  insert into public.curation_warning_resolutions
    (organization_id, preview_item_id, supplement_product_id,
     knowledge_reference_id, warning_key, disposition, reason, decided_by)
  values
    (_organization_id, _preview_item_id, _product_id, _reference_id,
     btrim(_warning_key), _disposition, btrim(_reason), _uid)
  returning id into _id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'curation.warning_resolved',
     _resource_type, _subject_id::text,
     'Warning disposition recorded',
     jsonb_build_object('disposition', _disposition, 'warningKey', _warning_key,
                        'subjectType', _subject_type));

  return jsonb_build_object('ok', true, 'id', _id, 'subjectType', _subject_type,
                            'disposition', _disposition);
end;
$function$;

revoke all on function public.record_warning_resolution(uuid, text, uuid, text, text, text) from public, anon;
grant execute on function public.record_warning_resolution(uuid, text, uuid, text, text, text) to authenticated;

create or replace function public.list_warning_resolutions(
  _organization_id uuid,
  _subject_type text,
  _subject_id uuid
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _rows jsonb;
begin
  if _uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id=_organization_id and user_id=_uid and status='active') then
    raise exception 'not a member of this organization' using errcode='42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'warningKey', r.warning_key, 'disposition', r.disposition,
    'reason', r.reason, 'decidedBy', r.decided_by, 'decidedAt', r.decided_at
  ) order by r.decided_at desc), '[]'::jsonb) into _rows
  from public.curation_warning_resolutions r
  where r.organization_id = _organization_id
    and (
      (_subject_type = 'preview_item' and r.preview_item_id = _subject_id)
      or (_subject_type = 'product' and r.supplement_product_id = _subject_id)
      or (_subject_type = 'knowledge_reference' and r.knowledge_reference_id = _subject_id)
    );

  return jsonb_build_object('subjectType', _subject_type, 'subjectId', _subject_id,
                            'resolutions', _rows);
end;
$function$;

revoke all on function public.list_warning_resolutions(uuid, text, uuid) from public, anon;
grant execute on function public.list_warning_resolutions(uuid, text, uuid) to authenticated;

-- ============================================== safe bulk operations

alter table public.clinical_knowledge_import_items
  add column if not exists assigned_reviewer_id uuid references auth.users(id),
  add column if not exists org_tag text,
  add column if not exists duplicate_of_item_id uuid references public.clinical_knowledge_import_items(id);

create or replace function public.bulk_assign_reviewer(
  _organization_id uuid,
  _item_ids uuid[],
  _assignee uuid,
  _reason text
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _updated int;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if _item_ids is null or cardinality(_item_ids) = 0 then
    raise exception 'no items selected' using errcode='22023';
  end if;
  if cardinality(_item_ids) > 500 then
    raise exception 'bulk operation upper bound is 500 items' using errcode='22023';
  end if;
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'a bulk-assign action requires a stated reason' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id = _organization_id and user_id = _assignee and status = 'active') then
    raise exception 'assignee is not a member of this organization' using errcode='42501';
  end if;

  with permitted as (
    select id from public.clinical_knowledge_import_items
    where organization_id = _organization_id and id = any(_item_ids)
  )
  update public.clinical_knowledge_import_items
  set assigned_reviewer_id = _assignee
  where id in (select id from permitted);
  get diagnostics _updated = row_count;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'curation.bulk_assign_reviewer',
     'clinical_knowledge_import_batch', null,
     'Bulk assign reviewer recorded',
     jsonb_build_object('itemsSelected', cardinality(_item_ids),
                        'itemsUpdated', _updated,
                        'assignee', _assignee));

  return jsonb_build_object('ok', true, 'itemsUpdated', _updated);
end;
$function$;

revoke all on function public.bulk_assign_reviewer(uuid, uuid[], uuid, text) from public, anon;
grant execute on function public.bulk_assign_reviewer(uuid, uuid[], uuid, text) to authenticated;

create or replace function public.bulk_apply_org_tag(
  _organization_id uuid,
  _item_ids uuid[],
  _tag text,
  _reason text
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _updated int;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if _item_ids is null or cardinality(_item_ids) = 0 then
    raise exception 'no items selected' using errcode='22023';
  end if;
  if cardinality(_item_ids) > 500 then
    raise exception 'bulk operation upper bound is 500 items' using errcode='22023';
  end if;
  if coalesce(btrim(_tag), '') = '' then
    raise exception 'tag is required' using errcode='22023';
  end if;
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'a bulk-tag action requires a stated reason' using errcode='22023';
  end if;
  if _tag ~* '(approved|verified|cleared|activated|published|selectable|attached)' then
    raise exception 'this tag looks like a clinical review outcome; use the dedicated governed action instead'
      using errcode='22023';
  end if;

  with permitted as (
    select id from public.clinical_knowledge_import_items
    where organization_id = _organization_id and id = any(_item_ids)
  )
  update public.clinical_knowledge_import_items
  set org_tag = btrim(_tag)
  where id in (select id from permitted);
  get diagnostics _updated = row_count;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'curation.bulk_apply_org_tag',
     'clinical_knowledge_import_batch', null,
     'Bulk organizational tag applied',
     jsonb_build_object('itemsSelected', cardinality(_item_ids),
                        'itemsUpdated', _updated,
                        'tag', btrim(_tag)));

  return jsonb_build_object('ok', true, 'itemsUpdated', _updated);
end;
$function$;

revoke all on function public.bulk_apply_org_tag(uuid, uuid[], text, text) from public, anon;
grant execute on function public.bulk_apply_org_tag(uuid, uuid[], text, text) to authenticated;

create or replace function public.bulk_mark_duplicate(
  _organization_id uuid,
  _item_ids uuid[],
  _duplicate_of_item_id uuid,
  _reason text
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _updated int;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if _item_ids is null or cardinality(_item_ids) = 0 then
    raise exception 'no items selected' using errcode='22023';
  end if;
  if cardinality(_item_ids) > 500 then
    raise exception 'bulk operation upper bound is 500 items' using errcode='22023';
  end if;
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'a bulk-mark-duplicate action requires a stated reason' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.clinical_knowledge_import_items
    where id = _duplicate_of_item_id and organization_id = _organization_id) then
    raise exception 'canonical item not found or belongs to a different tenant'
      using errcode='42501';
  end if;

  with permitted as (
    select id from public.clinical_knowledge_import_items
    where organization_id = _organization_id and id = any(_item_ids)
      and id <> _duplicate_of_item_id
  )
  update public.clinical_knowledge_import_items
  set duplicate_of_item_id = _duplicate_of_item_id
  where id in (select id from permitted);
  get diagnostics _updated = row_count;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'curation.bulk_mark_duplicate',
     'clinical_knowledge_import_batch', null,
     'Bulk duplicate marker applied',
     jsonb_build_object('itemsSelected', cardinality(_item_ids),
                        'itemsUpdated', _updated,
                        'canonical', _duplicate_of_item_id));

  return jsonb_build_object('ok', true, 'itemsUpdated', _updated);
end;
$function$;

revoke all on function public.bulk_mark_duplicate(uuid, uuid[], uuid, text) from public, anon;
grant execute on function public.bulk_mark_duplicate(uuid, uuid[], uuid, text) to authenticated;

-- ============================================== commercial-clinical isolation

create or replace function public.clinical_ranking_snapshot(_product_id uuid)
returns text language sql stable security invoker set search_path to '' as $function$
  select extensions.digest(
    coalesce(p.name, '')
    || '|' || coalesce(p.brand_id::text, '')
    || '|' || coalesce(p.sku, '')
    || '|' || coalesce(p.upc, '')
    || '|' || coalesce(p.status, '')
    || '|' || coalesce(array_to_string(p.restricted_flags, ','), '')
    || '|' || coalesce(p.regulatory_classification, '')
    || '|' || coalesce(p.jurisdiction, ''),
    'sha256')::text
  from public.supplement_products p
  where p.id = _product_id;
$function$;

grant execute on function public.clinical_ranking_snapshot(uuid) to authenticated;

-- ============================================== label editor: extensions.digest fix

create or replace function public.create_product_label_draft(
  _organization_id uuid,
  _product_code text,
  _product_name text,
  _brand text,
  _exact_label jsonb,
  _source_url text default null,
  _serving_size text default null,
  _ingredients jsonb default '[]'::jsonb,
  _other_ingredients text default null,
  _allergens text default null,
  _contraindications text default null,
  _warnings_text text default null,
  _storage_instructions text default null,
  _observed_date date default null,
  _jurisdiction text default null,
  _label_image_ref text default null
)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _id uuid;
  _next_version int;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_product_code), '') = '' then
    raise exception 'product_code is required' using errcode = '22023';
  end if;
  if coalesce(btrim(_product_name), '') = '' then
    raise exception 'product_name is required' using errcode = '22023';
  end if;
  if coalesce(btrim(_brand), '') = '' then
    raise exception 'brand is required' using errcode = '22023';
  end if;

  select coalesce(max(version), 0) + 1 into _next_version
  from public.product_label_versions
  where organization_id = _organization_id and product_code = _product_code;

  insert into public.product_label_versions
    (organization_id, product_code, version, product_name, brand,
     exact_label, label_sha256, source_url, status, created_by,
     serving_size, ingredients, other_ingredients, allergens,
     contraindications, warnings_text, storage_instructions,
     observed_date, jurisdiction, label_image_ref)
  values
    (_organization_id, btrim(_product_code), _next_version, btrim(_product_name), btrim(_brand),
     _exact_label, encode(extensions.digest(_exact_label::text, 'sha256'), 'hex'),
     nullif(btrim(coalesce(_source_url, '')), ''),
     'pending', _uid,
     nullif(btrim(coalesce(_serving_size, '')), ''), coalesce(_ingredients, '[]'::jsonb),
     nullif(btrim(coalesce(_other_ingredients, '')), ''),
     nullif(btrim(coalesce(_allergens, '')), ''),
     nullif(btrim(coalesce(_contraindications, '')), ''),
     nullif(btrim(coalesce(_warnings_text, '')), ''),
     nullif(btrim(coalesce(_storage_instructions, '')), ''),
     _observed_date, nullif(btrim(coalesce(_jurisdiction, '')), ''),
     nullif(btrim(coalesce(_label_image_ref, '')), ''))
  returning id into _id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'product_label.draft_created',
     'product_label_version', _id::text,
     'Draft label version created',
     jsonb_build_object('productCode', _product_code, 'version', _next_version));

  return jsonb_build_object('ok', true, 'id', _id, 'version', _next_version, 'status', 'pending');
end;
$function$;

create or replace function public.supersede_product_label_version(
  _organization_id uuid,
  _supersedes_id uuid,
  _exact_label jsonb,
  _reason text,
  _serving_size text default null,
  _ingredients jsonb default '[]'::jsonb,
  _other_ingredients text default null,
  _allergens text default null,
  _contraindications text default null,
  _warnings_text text default null,
  _storage_instructions text default null,
  _source_url text default null,
  _observed_date date default null
)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid;
  _prior public.product_label_versions%rowtype;
  _id uuid;
  _next_version int;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'supersede requires a stated reason' using errcode = '22023';
  end if;

  select * into _prior from public.product_label_versions where id = _supersedes_id;
  if not found then
    raise exception 'prior label version not found' using errcode = 'P0002';
  end if;
  if _prior.organization_id <> _organization_id then
    raise exception 'prior label version belongs to a different tenant' using errcode = '42501';
  end if;

  select max(version) + 1 into _next_version
  from public.product_label_versions
  where organization_id = _organization_id and product_code = _prior.product_code;

  insert into public.product_label_versions
    (organization_id, product_code, version, product_name, brand,
     exact_label, label_sha256, source_url, status, created_by,
     serving_size, ingredients, other_ingredients, allergens,
     contraindications, warnings_text, storage_instructions,
     observed_date, jurisdiction, supersedes_id)
  values
    (_organization_id, _prior.product_code, _next_version, _prior.product_name, _prior.brand,
     _exact_label, encode(extensions.digest(_exact_label::text, 'sha256'), 'hex'),
     coalesce(nullif(btrim(coalesce(_source_url, '')), ''), _prior.source_url),
     'pending', _uid,
     coalesce(nullif(btrim(coalesce(_serving_size, '')), ''), _prior.serving_size),
     coalesce(nullif(_ingredients, '[]'::jsonb), _prior.ingredients),
     coalesce(nullif(btrim(coalesce(_other_ingredients, '')), ''), _prior.other_ingredients),
     coalesce(nullif(btrim(coalesce(_allergens, '')), ''), _prior.allergens),
     coalesce(nullif(btrim(coalesce(_contraindications, '')), ''), _prior.contraindications),
     coalesce(nullif(btrim(coalesce(_warnings_text, '')), ''), _prior.warnings_text),
     coalesce(nullif(btrim(coalesce(_storage_instructions, '')), ''), _prior.storage_instructions),
     coalesce(_observed_date, _prior.observed_date), _prior.jurisdiction,
     _supersedes_id)
  returning id into _id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'product_label.superseded',
     'product_label_version', _id::text,
     'New draft supersedes prior verified label',
     jsonb_build_object('supersedes', _supersedes_id, 'newVersion', _next_version));

  return jsonb_build_object('ok', true, 'id', _id, 'version', _next_version,
                            'supersedesId', _supersedes_id, 'status', 'pending');
end;
$function$;
