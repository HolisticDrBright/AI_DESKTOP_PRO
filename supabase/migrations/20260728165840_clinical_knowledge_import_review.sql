-- Governed import/review queue for practitioner-authored clinical knowledge.
-- Imported material never becomes an approved pathway or verified product
-- label. Acceptance creates only a pathway draft or pending label version.

begin;

create or replace function public.update_clinical_pathway_draft(
  _version_id uuid,
  _content jsonb,
  _source_refs jsonb default '[]'::jsonb,
  _change_summary text default null
) returns void language plpgsql security definer set search_path = ''
as $$
declare
  _version public.clinical_pathway_versions%rowtype;
  _uid uuid;
begin
  select * into _version
  from public.clinical_pathway_versions
  where id = _version_id
  for update;
  if not found then
    raise exception 'clinical pathway version not found' using errcode = 'P0002';
  end if;
  _uid := private.require_knowledge_editor(_version.organization_id);
  if _version.status <> 'draft' then
    raise exception 'only a draft pathway version can be updated' using errcode = '55000';
  end if;
  if jsonb_typeof(_content) <> 'object' or jsonb_typeof(_source_refs) <> 'array' then
    raise exception 'content must be an object and sources must be an array' using errcode = '22023';
  end if;

  update public.clinical_pathway_versions
  set content = _content,
      source_refs = _source_refs,
      content_sha256 = private.sha256_hex(_content::text),
      change_summary = nullif(btrim(_change_summary), '')
  where id = _version_id;

  insert into public.audit_events (
    organization_id, actor_user_id, action, resource_type, resource_id,
    safe_message, metadata
  ) values (
    _version.organization_id, _uid, 'knowledge.pathway_draft_updated',
    'clinical_pathway_version', _version_id::text,
    'Clinical pathway draft updated',
    jsonb_build_object('version', _version.version)
  );
end;
$$;

create table public.clinical_knowledge_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_name text not null check (char_length(source_name) between 1 and 240),
  source_revision text,
  schema_version text not null check (char_length(schema_version) between 1 and 120),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'staged'
    check (status in ('staged', 'in_review', 'completed', 'cancelled')),
  item_count integer not null check (item_count between 1 and 250),
  no_phi_attested_by uuid not null references auth.users(id) on delete restrict,
  no_phi_attested_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index clinical_knowledge_import_batches_org_idx
  on public.clinical_knowledge_import_batches (organization_id, created_at desc);

create table public.clinical_knowledge_import_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null
    references public.clinical_knowledge_import_batches(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  entity_type text not null check (entity_type in ('pathway', 'product_label')),
  external_key text not null check (char_length(external_key) between 1 and 200),
  display_name text not null check (char_length(display_name) between 1 and 300),
  source_sheet text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  validation_errors jsonb not null default '[]'::jsonb
    check (jsonb_typeof(validation_errors) = 'array'),
  status text not null default 'needs_review'
    check (status in ('needs_review', 'applied', 'rejected')),
  review_note text,
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  applied_ref_type text check (applied_ref_type in ('clinical_pathway_version', 'product_label_version')),
  applied_ref_id uuid,
  created_at timestamptz not null default now(),
  unique (batch_id, external_key)
);

create index clinical_knowledge_import_items_batch_idx
  on public.clinical_knowledge_import_items (batch_id, status, entity_type);
create index clinical_knowledge_import_items_org_idx
  on public.clinical_knowledge_import_items (organization_id, created_at desc);

create or replace function private.clinical_knowledge_import_batch_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'clinical knowledge import batches are append-only' using errcode = '22023';
  end if;
  if new.organization_id is distinct from old.organization_id
     or new.source_name is distinct from old.source_name
     or new.source_revision is distinct from old.source_revision
     or new.schema_version is distinct from old.schema_version
     or new.source_sha256 is distinct from old.source_sha256
     or new.item_count is distinct from old.item_count
     or new.no_phi_attested_by is distinct from old.no_phi_attested_by
     or new.no_phi_attested_at is distinct from old.no_phi_attested_at
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'clinical knowledge import source metadata is immutable' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger clinical_knowledge_import_batch_guard
  before update or delete on public.clinical_knowledge_import_batches
  for each row execute function private.clinical_knowledge_import_batch_guard();

create or replace function private.clinical_knowledge_import_item_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'clinical knowledge import items are append-only' using errcode = '22023';
  end if;
  if new.batch_id is distinct from old.batch_id
     or new.organization_id is distinct from old.organization_id
     or new.entity_type is distinct from old.entity_type
     or new.external_key is distinct from old.external_key
     or new.display_name is distinct from old.display_name
     or new.source_sheet is distinct from old.source_sheet
     or new.payload is distinct from old.payload
     or new.payload_sha256 is distinct from old.payload_sha256
     or new.warnings is distinct from old.warnings
     or new.validation_errors is distinct from old.validation_errors
     or new.created_at is distinct from old.created_at then
    raise exception 'clinical knowledge import source items are immutable' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger clinical_knowledge_import_item_guard
  before update or delete on public.clinical_knowledge_import_items
  for each row execute function private.clinical_knowledge_import_item_guard();

alter table public.clinical_knowledge_import_batches enable row level security;
alter table public.clinical_knowledge_import_items enable row level security;

create policy clinical_knowledge_import_batches_select
  on public.clinical_knowledge_import_batches
  for select to authenticated
  using (private.is_org_member(organization_id));

create policy clinical_knowledge_import_items_select
  on public.clinical_knowledge_import_items
  for select to authenticated
  using (private.is_org_member(organization_id));

create or replace function private.knowledge_import_validation_errors(
  _entity_type text, _payload jsonb
) returns jsonb language plpgsql immutable set search_path = ''
as $$
declare _errors jsonb := '[]'::jsonb; _content jsonb; _label jsonb;
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
  else
    _errors := _errors || '["Unsupported import entity type"]'::jsonb;
  end if;
  return _errors;
end;
$$;

create or replace function public.stage_clinical_knowledge_import(
  _organization_id uuid,
  _source_name text,
  _source_revision text,
  _schema_version text,
  _items jsonb,
  _attests_no_phi boolean
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid;
  _batch_id uuid;
  _item jsonb;
  _entity_type text;
  _payload jsonb;
  _count integer;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if _attests_no_phi is distinct from true then
    raise exception 'no-PHI attestation is required' using errcode = '55000';
  end if;
  if coalesce(btrim(_source_name), '') = ''
     or coalesce(btrim(_schema_version), '') = '' then
    raise exception 'source name and schema version are required' using errcode = '22023';
  end if;
  if jsonb_typeof(_items) <> 'array' then
    raise exception 'import items must be an array' using errcode = '22023';
  end if;
  _count := jsonb_array_length(_items);
  if _count < 1 or _count > 250 then
    raise exception 'an import batch must contain between 1 and 250 items' using errcode = '22023';
  end if;

  insert into public.clinical_knowledge_import_batches
    (organization_id, source_name, source_revision, schema_version, source_sha256,
     status, item_count, no_phi_attested_by, created_by)
  values
    (_organization_id, btrim(_source_name), nullif(btrim(_source_revision), ''),
     btrim(_schema_version), private.sha256_hex(_items::text), 'in_review',
     _count, _uid, _uid)
  returning id into _batch_id;

  for _item in select value from jsonb_array_elements(_items)
  loop
    _entity_type := _item ->> 'entityType';
    _payload := _item -> 'payload';
    if jsonb_typeof(_item) <> 'object' or jsonb_typeof(_payload) <> 'object' then
      raise exception 'every import item must contain an object payload' using errcode = '22023';
    end if;
    insert into public.clinical_knowledge_import_items
      (batch_id, organization_id, entity_type, external_key, display_name,
       source_sheet, payload, payload_sha256, warnings, validation_errors)
    values
      (_batch_id, _organization_id, _entity_type,
       coalesce(nullif(btrim(_item ->> 'externalKey'), ''), gen_random_uuid()::text),
       coalesce(nullif(btrim(_item ->> 'displayName'), ''), 'Unnamed import item'),
       nullif(btrim(_item ->> 'sourceSheet'), ''),
       _payload, private.sha256_hex(_payload::text),
       case when jsonb_typeof(_item -> 'warnings') = 'array'
            then _item -> 'warnings' else '[]'::jsonb end,
       private.knowledge_import_validation_errors(_entity_type, _payload));
  end loop;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'knowledge.import_staged',
     'clinical_knowledge_import_batch', _batch_id::text,
     'Clinical knowledge import staged for review',
     jsonb_build_object('itemCount', _count, 'schemaVersion', _schema_version));

  return jsonb_build_object('batchId', _batch_id, 'itemCount', _count);
end;
$$;

create or replace function public.review_clinical_knowledge_import_item(
  _item_id uuid,
  _decision text,
  _review_note text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
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
      select id into _pathway_id
      from public.clinical_pathways
      where organization_id = _item.organization_id
        and code = lower(btrim(_payload ->> 'code'))
        and retired_at is null;

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
      select coalesce(max(version), 0) + 1 into _version
      from public.product_label_versions
      where organization_id = _item.organization_id
        and product_code = lower(btrim(_payload ->> 'productCode'));

      insert into public.product_label_versions
        (organization_id, product_code, version, product_name, brand,
         exact_label, label_sha256, source_url, affiliate_url, created_by)
      values
        (_item.organization_id, lower(btrim(_payload ->> 'productCode')),
         _version, btrim(_payload ->> 'productName'), btrim(_payload ->> 'brand'),
         _payload -> 'exactLabel',
         private.sha256_hex((_payload -> 'exactLabel')::text),
         nullif(btrim(_payload ->> 'sourceUrl'), ''),
         nullif(btrim(_payload ->> 'affiliateUrl'), ''), _uid)
      returning id into _label_id;

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
$$;

revoke all on table public.clinical_knowledge_import_batches from anon, authenticated;
revoke all on table public.clinical_knowledge_import_items from anon, authenticated;
grant select on table public.clinical_knowledge_import_batches to authenticated;
grant select on table public.clinical_knowledge_import_items to authenticated;

revoke all on function public.stage_clinical_knowledge_import(
  uuid, text, text, text, jsonb, boolean
) from public, anon;
revoke all on function public.review_clinical_knowledge_import_item(
  uuid, text, text
) from public, anon;
revoke all on function public.update_clinical_pathway_draft(
  uuid, jsonb, jsonb, text
) from public, anon;
grant execute on function public.stage_clinical_knowledge_import(
  uuid, text, text, text, jsonb, boolean
) to authenticated;
grant execute on function public.review_clinical_knowledge_import_item(
  uuid, text, text
) to authenticated;
grant execute on function public.update_clinical_pathway_draft(
  uuid, jsonb, jsonb, text
) to authenticated;

commit;
