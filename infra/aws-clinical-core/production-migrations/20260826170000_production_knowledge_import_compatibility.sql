-- AWS-native compatibility surface for the Desktop governed knowledge-import UI.
-- This migration creates no rows, imports no catalog, approves no clinical
-- content, and does not alter the PHI activation boundary.

alter table clinical_core.clinical_knowledge_import_batches
  add column source_kind text check (source_kind is null or source_kind in (
    'product_spreadsheet','affiliate_sheet','protocol_document','obsidian_export',
    'reference_list','other','research_handoff')),
  add column source_filename text check (
    source_filename is null or (char_length(source_filename) between 1 and 260
      and source_filename !~ '[/\\]')),
  add column source_byte_size bigint check (source_byte_size is null or source_byte_size between 0 and 20971520),
  add column source_restricted_flags text[] not null default '{}'::text[]
    check (cardinality(source_restricted_flags)<=20),
  add column source_restricted_reason text
    check (source_restricted_reason is null or char_length(source_restricted_reason)<=2000),
  add column commercial_only boolean not null default false check (commercial_only=false);

alter table clinical_core.clinical_knowledge_import_items
  drop constraint clinical_knowledge_import_items_batch_id_external_key_key,
  add column source_row_number integer check (source_row_number is null or source_row_number between 1 and 250),
  add column change_kind text not null default 'add'
    check (change_kind in ('add','change','unchanged','conflict')),
  add column conflict_with_item_id uuid references clinical_core.clinical_knowledge_import_items(id),
  add column conflict_reason text check (conflict_reason is null or char_length(conflict_reason)<=1000);

create unique index clinical_knowledge_import_items_nonconflict_key
  on clinical_core.clinical_knowledge_import_items(batch_id,external_key)
  where change_kind<>'conflict';

create table clinical_core.knowledge_import_conflict_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  item_id uuid not null unique references clinical_core.clinical_knowledge_import_items(id),
  resolution text not null check (resolution in ('keep_existing','take_incoming','skip')),
  note text not null check (char_length(btrim(note)) between 10 and 2000),
  resolved_by_person_id uuid not null references clinical_core.persons(id),
  resolved_at timestamptz not null default clock_timestamp(),
  data_classification text not null default 'reference_only' check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false)
);

create table clinical_core.research_handoff_item_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  item_id uuid not null unique references clinical_core.clinical_knowledge_import_items(id),
  verdict text not null check (verdict in ('verified','blocked')),
  note text not null check (char_length(btrim(note)) between 10 and 2000),
  reviewed_by_person_id uuid not null references clinical_core.persons(id),
  reviewed_at timestamptz not null default clock_timestamp(),
  data_classification text not null default 'reference_only' check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false)
);

create index knowledge_import_conflict_resolutions_org_idx
  on clinical_core.knowledge_import_conflict_resolutions(organization_id,resolved_at desc);
create index research_handoff_item_reviews_org_idx
  on clinical_core.research_handoff_item_reviews(organization_id,reviewed_at desc);

alter table clinical_core.knowledge_import_conflict_resolutions enable row level security;
alter table clinical_core.research_handoff_item_reviews enable row level security;
revoke all on clinical_core.knowledge_import_conflict_resolutions,
  clinical_core.research_handoff_item_reviews from public,clinical_core_api;

create trigger knowledge_import_conflict_resolutions_append_only
  before update or delete on clinical_core.knowledge_import_conflict_resolutions
  for each row execute function clinical_reference.reject_immutable_catalog_history();
create trigger research_handoff_item_reviews_append_only
  before update or delete on clinical_core.research_handoff_item_reviews
  for each row execute function clinical_reference.reject_immutable_catalog_history();

create or replace function clinical_core.preview_knowledge_import(
  _organization_id uuid,_source_kind text,_source_name text,_schema_version text,
  _items jsonb,_attests_no_phi boolean,_source_filename text default null,
  _source_byte_size bigint default null,_source_revision text default null,
  _source_restricted_flags text[] default '{}'::text[],
  _source_restricted_reason text default null,_commercial_only boolean default false
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _batch_id uuid; _existing record; _item jsonb; _payload jsonb;
  _entity_type text; _source_sha text; _payload_sha text; _count integer; _row integer:=0;
  _first_id uuid; _change text; _added integer:=0; _conflicts integer:=0; _warnings jsonb;
begin
  _actor:=clinical_private.require_knowledge_editor(_organization_id);
  if _attests_no_phi is distinct from true then
    raise exception using errcode='55000',message='knowledge_import_no_phi_attestation_required'; end if;
  if _commercial_only is distinct from false then
    raise exception using errcode='55000',message='knowledge_import_commercial_only_refused'; end if;
  if _source_kind is not null and _source_kind not in ('product_spreadsheet','affiliate_sheet',
    'protocol_document','obsidian_export','reference_list','other','research_handoff') then
    raise exception using errcode='22023',message='knowledge_import_source_kind_invalid'; end if;
  if char_length(btrim(coalesce(_source_name,''))) not between 1 and 240
    or char_length(coalesce(_source_revision,''))>120
    or _schema_version<>'clinical-knowledge-import-v1'
    or (_source_filename is not null and (char_length(_source_filename) not between 1 and 260
      or _source_filename ~ '[/\\]'))
    or (_source_byte_size is not null and _source_byte_size not between 0 and 20971520)
    or cardinality(coalesce(_source_restricted_flags,'{}'::text[]))>20
    or char_length(coalesce(_source_restricted_reason,''))>2000
    or jsonb_typeof(_items)<>'array' or octet_length(coalesce(_items,'[]'::jsonb)::text)>4194304 then
    raise exception using errcode='22023',message='knowledge_import_bundle_invalid'; end if;
  _count:=jsonb_array_length(_items);
  if _count not between 1 and 250 then
    raise exception using errcode='22023',message='knowledge_import_item_count_invalid'; end if;
  if _items::text ~* '"(affiliateUrl|affiliateUrls|destinationUrl|discountCode|trackingCode)"' then
    raise exception using errcode='22023',message='knowledge_import_commercial_data_refused'; end if;
  _source_sha:=encode(public.digest(convert_to(_items::text||'|'||coalesce(_source_kind,'')||'|'||
    coalesce(array_to_string(_source_restricted_flags,','),''),'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    _organization_id::text||':'||_source_sha||':'||_schema_version,0));
  select id,item_count into _existing from clinical_core.clinical_knowledge_import_batches
    where organization_id=_organization_id and source_sha256=_source_sha and schema_version=_schema_version;
  if found then return jsonb_build_object('batchId',_existing.id,'idempotent',true,'status','in_review',
    'itemCount',_existing.item_count,'added',_existing.item_count,'changed',0,'unchanged',0,
    'conflicts',0,'removals',0,'ambiguous',0,
    'restricted',case when cardinality(coalesce(_source_restricted_flags,'{}'::text[]))>0 then _existing.item_count else 0 end,
    'sourceSha256',_source_sha,'message','This exact governed source was already staged; no row was duplicated.'); end if;
  insert into clinical_core.clinical_knowledge_import_batches(organization_id,source_name,source_revision,
    schema_version,source_sha256,status,item_count,no_phi_attested_by_person_id,created_by_person_id,
    source_kind,source_filename,source_byte_size,source_restricted_flags,source_restricted_reason)
  values(_organization_id,btrim(_source_name),nullif(btrim(_source_revision),''),_schema_version,_source_sha,
    'in_review',_count,_actor,_actor,_source_kind,nullif(btrim(_source_filename),''),_source_byte_size,
    coalesce(_source_restricted_flags,'{}'::text[]),nullif(btrim(_source_restricted_reason),''))
  returning id into _batch_id;
  for _item in select value from jsonb_array_elements(_items) loop
    _row:=_row+1; _payload:=_item->'payload'; _entity_type:=_item->>'entityType';
    if jsonb_typeof(_item)<>'object' or jsonb_typeof(_payload)<>'object'
      or _entity_type not in ('pathway','product_label')
      or char_length(btrim(coalesce(_item->>'externalKey',''))) not between 1 and 200
      or char_length(btrim(coalesce(_item->>'displayName',''))) not between 1 and 300
      or char_length(coalesce(_item->>'sourceSheet',''))>200
      or octet_length(_payload::text)>524288 then
      raise exception using errcode='22023',message='knowledge_import_item_invalid'; end if;
    _warnings:=coalesce(_item->'warnings','[]'::jsonb);
    if jsonb_typeof(_warnings)<>'array' or jsonb_array_length(_warnings)>50
      or octet_length(_warnings::text)>32768 then
      raise exception using errcode='22023',message='knowledge_import_item_invalid'; end if;
    select id into _first_id from clinical_core.clinical_knowledge_import_items
      where batch_id=_batch_id and external_key=btrim(_item->>'externalKey')
      order by source_row_number limit 1;
    _change:=case when _first_id is null then 'add' else 'conflict' end;
    _payload_sha:=encode(public.digest(convert_to(_payload::text,'UTF8'),'sha256'),'hex');
    insert into clinical_core.clinical_knowledge_import_items(batch_id,organization_id,entity_type,
      external_key,display_name,source_sheet,payload,payload_sha256,warnings,validation_errors,
      source_row_number,change_kind,conflict_with_item_id,conflict_reason)
    values(_batch_id,_organization_id,_entity_type,btrim(_item->>'externalKey'),btrim(_item->>'displayName'),
      nullif(btrim(_item->>'sourceSheet'),''),_payload,_payload_sha,_warnings,
      clinical_private.knowledge_import_validation_errors(_entity_type,_payload),_row,_change,_first_id,
      case when _first_id is not null then 'Another row in this source uses the same external key.' end);
    if _change='add' then _added:=_added+1; else _conflicts:=_conflicts+1; end if;
  end loop;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_organization_id,_actor,'knowledge.import_staged',
    'clinical_knowledge_import_batch',_batch_id,'Governed knowledge source staged for practitioner review',
    'clinical_data',jsonb_build_object('itemCount',_count,'added',_added,'conflicts',_conflicts));
  return jsonb_build_object('batchId',_batch_id,'idempotent',false,'status','in_review','itemCount',_count,
    'added',_added,'changed',0,'unchanged',0,'conflicts',_conflicts,'removals',0,'ambiguous',0,
    'restricted',case when cardinality(coalesce(_source_restricted_flags,'{}'::text[]))>0 then _count else 0 end,
    'sourceSha256',_source_sha,'message','Preview staged. No item is approved; commit requires explicit review.');
end $$;

create or replace function clinical_core.get_knowledge_import_preview(_batch_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _batch clinical_core.clinical_knowledge_import_batches%rowtype; _items jsonb;
begin
  select * into _batch from clinical_core.clinical_knowledge_import_batches
    where id=_batch_id and organization_id=clinical_private.organization_id();
  if not found then raise exception using errcode='P0002',message='knowledge_import_batch_not_found'; end if;
  perform clinical_private.require_knowledge_editor(_batch.organization_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'entityType',i.entity_type,
    'displayName',i.display_name,'sourceSheet',i.source_sheet,'sourceRowNumber',i.source_row_number,
    'dedupeKey',i.external_key,'changeKind',i.change_kind,'status',i.status,
    'payloadSha256',i.payload_sha256,'existingRefType',null,'existingRefId',null,
    'conflictWithItemId',i.conflict_with_item_id,'conflictReason',i.conflict_reason,
    'conflictResolution',r.resolution,'validationErrors',i.validation_errors,'warnings',i.warnings,
    'reviewNote',i.review_note,'appliedRefType',i.applied_ref_type,'appliedRefId',i.applied_ref_id)
    order by i.source_row_number,i.id),'[]'::jsonb) into _items
  from clinical_core.clinical_knowledge_import_items i
  left join clinical_core.knowledge_import_conflict_resolutions r on r.item_id=i.id
  where i.batch_id=_batch.id;
  return jsonb_build_object('batch',jsonb_build_object('id',_batch.id,'status',_batch.status,
    'sourceName',_batch.source_name,'sourceKind',_batch.source_kind,'sourceFilename',_batch.source_filename,
    'sourceByteSize',_batch.source_byte_size,'sourceSha256',_batch.source_sha256,
    'schemaVersion',_batch.schema_version,'itemCount',_batch.item_count,
    'added',(select count(*) from clinical_core.clinical_knowledge_import_items where batch_id=_batch.id and change_kind='add'),
    'changed',0,'unchanged',0,
    'conflicts',(select count(*) from clinical_core.clinical_knowledge_import_items where batch_id=_batch.id and change_kind='conflict'),
    'removals',0,'ambiguous',0,
    'restricted',case when cardinality(_batch.source_restricted_flags)>0 then _batch.item_count else 0 end,
    'previewGeneratedAt',_batch.created_at,'committedAt',_batch.completed_at,'createdAt',_batch.created_at),
    'items',_items,'reportedRemovals','[]'::jsonb,
    'removalPolicy','Imports never delete governed clinical content; removals require a separate reviewed lifecycle action.');
end $$;

create or replace function clinical_core.resolve_knowledge_import_conflict(
  _item_id uuid,_resolution text,_note text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _item clinical_core.clinical_knowledge_import_items%rowtype; _actor uuid;
begin
  select * into _item from clinical_core.clinical_knowledge_import_items where id=_item_id for update;
  if not found then raise exception using errcode='P0002',message='knowledge_import_item_not_found'; end if;
  _actor:=clinical_private.require_knowledge_editor(_item.organization_id);
  if _item.change_kind<>'conflict' or _item.status<>'needs_review' then
    raise exception using errcode='55000',message='knowledge_import_item_not_open_conflict'; end if;
  if _resolution not in ('keep_existing','take_incoming','skip')
    or char_length(btrim(coalesce(_note,''))) not between 10 and 2000 then
    raise exception using errcode='22023',message='knowledge_import_conflict_resolution_invalid'; end if;
  insert into clinical_core.knowledge_import_conflict_resolutions(organization_id,item_id,resolution,note,
    resolved_by_person_id) values(_item.organization_id,_item.id,_resolution,btrim(_note),_actor);
  if _resolution in ('keep_existing','skip') then
    update clinical_core.clinical_knowledge_import_items set status='rejected',review_note=btrim(_note),
      reviewed_by_person_id=_actor,reviewed_at=clock_timestamp() where id=_item.id;
  else
    update clinical_core.clinical_knowledge_import_items set status='rejected',
      review_note='Superseded by the reviewed incoming duplicate',reviewed_by_person_id=_actor,
      reviewed_at=clock_timestamp() where batch_id=_item.batch_id and external_key=_item.external_key
      and id<>_item.id and status='needs_review';
  end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_item.organization_id,_actor,
    'knowledge.import_conflict_resolved','clinical_knowledge_import_item',_item.id,
    'Knowledge import conflict resolved by a named reviewer','clinical_data',
    jsonb_build_object('resolution',_resolution));
  return jsonb_build_object('ok',true,'itemId',_item.id,'resolution',_resolution);
end $$;

create or replace function clinical_core.record_research_handoff_item_review(
  _item_id uuid,_verdict text,_note text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _item clinical_core.clinical_knowledge_import_items%rowtype; _actor uuid; _existing record;
begin
  select i.* into _item from clinical_core.clinical_knowledge_import_items i
    join clinical_core.clinical_knowledge_import_batches b on b.id=i.batch_id
    where i.id=_item_id and b.source_kind='research_handoff';
  if not found then raise exception using errcode='P0002',message='research_handoff_item_not_found'; end if;
  _actor:=clinical_private.require_knowledge_editor(_item.organization_id);
  if _verdict not in ('verified','blocked') or char_length(btrim(coalesce(_note,''))) not between 10 and 2000 then
    raise exception using errcode='22023',message='research_handoff_review_invalid'; end if;
  select verdict,note into _existing from clinical_core.research_handoff_item_reviews where item_id=_item.id;
  if found then
    if _existing.verdict=_verdict and _existing.note=btrim(_note) then
      return jsonb_build_object('ok',true,'itemId',_item.id,'externalKey',_item.external_key,
        'verdict',_verdict,'status',_item.status); end if;
    raise exception using errcode='40001',message='research_handoff_review_already_recorded';
  end if;
  insert into clinical_core.research_handoff_item_reviews(organization_id,item_id,verdict,note,
    reviewed_by_person_id) values(_item.organization_id,_item.id,_verdict,btrim(_note),_actor);
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_item.organization_id,_actor,
    'knowledge.research_review_recorded','clinical_knowledge_import_item',_item.id,
    'Research handoff review recorded; no clinical content was approved','clinical_data',
    jsonb_build_object('verdict',_verdict));
  return jsonb_build_object('ok',true,'itemId',_item.id,'externalKey',_item.external_key,
    'verdict',_verdict,'status',_item.status);
end $$;

create or replace function clinical_core.get_research_handoff_review(
  _organization_id uuid,_prh_ids text[]
) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.require_knowledge_editor(_organization_id);
  if _prh_ids is null or cardinality(_prh_ids) not between 1 and 50
    or exists(select 1 from unnest(_prh_ids) id where char_length(id) not between 1 and 200) then
    raise exception using errcode='22023',message='research_handoff_ids_invalid'; end if;
  return jsonb_build_object(
    'batches',coalesce((select jsonb_agg(distinct jsonb_build_object('id',b.id,'sourceName',b.source_name,
      'status',b.status,'itemCount',b.item_count,'commercialOnly',false,'manifestSha256',null))
      from clinical_core.clinical_knowledge_import_batches b
      join clinical_core.clinical_knowledge_import_items i on i.batch_id=b.id
      where b.organization_id=_organization_id and b.source_kind='research_handoff'
        and i.external_key=any(_prh_ids)),'[]'::jsonb),
    'records',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'externalKey',i.external_key,
      'displayName',i.display_name,'status',i.status,'verdict',r.verdict,'reviewNote',r.note,
      'reviewedAt',r.reviewed_at,'warnings',i.warnings,'payload',i.payload) order by i.source_row_number)
      from clinical_core.clinical_knowledge_import_items i
      join clinical_core.clinical_knowledge_import_batches b on b.id=i.batch_id
      left join clinical_core.research_handoff_item_reviews r on r.item_id=i.id
      where i.organization_id=_organization_id and b.source_kind='research_handoff'
        and i.external_key=any(_prh_ids)),'[]'::jsonb),
    'evidence','[]'::jsonb,'commercial','[]'::jsonb,
    'boundary','Clinical records, evidence, and commercial data remain separate. Practitioner review does not approve or publish content.');
end $$;

create or replace function clinical_core.commit_knowledge_import(
  _batch_id uuid,_expected_counts jsonb default null,_note text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _batch clinical_core.clinical_knowledge_import_batches%rowtype; _item record;
  _actor uuid; _added integer; _applied integer:=0; _skipped integer:=0; _review_note text;
begin
  select * into _batch from clinical_core.clinical_knowledge_import_batches where id=_batch_id for update;
  if not found then raise exception using errcode='P0002',message='knowledge_import_batch_not_found'; end if;
  _actor:=clinical_private.require_knowledge_editor(_batch.organization_id);
  if _batch.status='completed' then return jsonb_build_object('ok',true,'batchId',_batch.id,
    'applied',_batch.item_count,'skipped',0,'approvalState','draft','message','This batch was already committed.'); end if;
  if _batch.status<>'in_review' then raise exception using errcode='55000',message='knowledge_import_batch_not_committable'; end if;
  select count(*) into _added from clinical_core.clinical_knowledge_import_items
    where batch_id=_batch.id and change_kind='add';
  if _expected_counts is not null and (jsonb_typeof(_expected_counts)<>'object'
    or coalesce((_expected_counts->>'added')::integer,-1)<>_added
    or coalesce((_expected_counts->>'changed')::integer,-1)<>0) then
    raise exception using errcode='40001',message='knowledge_import_preview_changed'; end if;
  if exists(select 1 from clinical_core.clinical_knowledge_import_items i
    where i.batch_id=_batch.id and i.change_kind='conflict' and i.status='needs_review'
      and not exists(select 1 from clinical_core.knowledge_import_conflict_resolutions r where r.item_id=i.id)) then
    raise exception using errcode='55000',message='knowledge_import_conflicts_unresolved'; end if;
  if exists(select 1 from clinical_core.clinical_knowledge_import_items i
    where i.batch_id=_batch.id and i.status='needs_review' and jsonb_array_length(i.validation_errors)>0) then
    raise exception using errcode='55000',message='knowledge_import_source_correction_required'; end if;
  if _batch.source_kind='research_handoff' and exists(select 1
    from clinical_core.clinical_knowledge_import_items i
    left join clinical_core.research_handoff_item_reviews r on r.item_id=i.id
    where i.batch_id=_batch.id and i.status='needs_review' and r.verdict is distinct from 'verified') then
    raise exception using errcode='55000',message='research_handoff_review_required'; end if;
  _review_note:=case when char_length(btrim(coalesce(_note,''))) between 10 and 2000
    then btrim(_note) else 'Committed after explicit governed import review.' end;
  for _item in select i.id from clinical_core.clinical_knowledge_import_items i
    left join clinical_core.knowledge_import_conflict_resolutions r on r.item_id=i.id
    where i.batch_id=_batch.id and i.status='needs_review'
      and (i.change_kind<>'conflict' or r.resolution='take_incoming')
    order by i.source_row_number,i.id loop
    perform clinical_core.review_clinical_knowledge_import_item(_item.id,'accept',_review_note);
    _applied:=_applied+1;
  end loop;
  select count(*) into _skipped from clinical_core.clinical_knowledge_import_items
    where batch_id=_batch.id and status='rejected';
  if exists(select 1 from clinical_core.clinical_knowledge_import_items where batch_id=_batch.id and status='needs_review') then
    raise exception using errcode='55000',message='knowledge_import_review_incomplete'; end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_batch.organization_id,_actor,'knowledge.import_committed',
    'clinical_knowledge_import_batch',_batch.id,'Governed knowledge import committed as non-approved drafts',
    'clinical_data',jsonb_build_object('applied',_applied,'skipped',_skipped));
  return jsonb_build_object('ok',true,'batchId',_batch.id,'applied',_applied,'skipped',_skipped,
    'approvalState','draft','message','Import committed as drafts. Separate clinical approval remains required.');
end $$;

create or replace function clinical_core.cancel_knowledge_import(_batch_id uuid,_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _batch clinical_core.clinical_knowledge_import_batches%rowtype; _actor uuid;
begin
  select * into _batch from clinical_core.clinical_knowledge_import_batches where id=_batch_id for update;
  if not found then raise exception using errcode='P0002',message='knowledge_import_batch_not_found'; end if;
  _actor:=clinical_private.require_knowledge_editor(_batch.organization_id);
  if char_length(btrim(coalesce(_reason,''))) not between 10 and 1000 then
    raise exception using errcode='22023',message='knowledge_import_cancel_reason_invalid'; end if;
  if _batch.status='cancelled' then return jsonb_build_object('ok',true,'batchId',_batch.id,
    'status','cancelled'); end if;
  if _batch.status<>'in_review' then raise exception using errcode='55000',message='knowledge_import_batch_not_cancellable'; end if;
  update clinical_core.clinical_knowledge_import_items set status='rejected',review_note=btrim(_reason),
    reviewed_by_person_id=_actor,reviewed_at=clock_timestamp()
    where batch_id=_batch.id and status='needs_review';
  update clinical_core.clinical_knowledge_import_batches set status='cancelled' where id=_batch.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_batch.organization_id,_actor,'knowledge.import_cancelled',
    'clinical_knowledge_import_batch',_batch.id,'Governed knowledge import cancelled','clinical_data','{}'::jsonb);
  return jsonb_build_object('ok',true,'batchId',_batch.id,'status','cancelled');
end $$;

create or replace function clinical_core.list_label_commercial_links(_label_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _product text;
begin
  perform clinical_private.require_catalog_member(clinical_private.organization_id(),false);
  select product_stable_id into _product from clinical_reference.catalog_product_versions where id=_label_version_id;
  if _product is null then raise exception using errcode='P0002',message='catalog_product_version_not_found'; end if;
  return jsonb_build_object('labelVersionId',_label_version_id,'links',coalesce((select jsonb_agg(
    jsonb_build_object('id',v.id,'kind',case v.kind when 'affiliate' then 'affiliate' else 'supplier' end,
      'url',v.destination_url,'supplierName',v.supplier_name,'commissionDisclosure',v.commission_disclosure,
      'availabilityStatus',v.availability_status,'lastVerifiedAt',v.last_verified_at,'revokedAt',null,
      'recordedAt',v.created_at) order by v.created_at desc)
    from commercial_reference.affiliate_offers o join commercial_reference.affiliate_offer_versions v
      on v.offer_stable_id=o.stable_id and v.version=o.active_version
    where o.product_stable_id=_product and o.review_status='approved' and v.review_status='approved'),'[]'::jsonb),
    'disclaimer','Commercial links are disclosed separately and never affect clinical eligibility, ranking, or safety review.');
end $$;

create or replace function clinical_core.list_protocol_commercial_links(_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.require_catalog_member(clinical_private.organization_id(),false);
  if not exists(select 1 from clinical_reference.protocol_template_versions where id=_version_id) then
    raise exception using errcode='P0002',message='protocol_template_version_not_found'; end if;
  return jsonb_build_object('protocolVersionId',_version_id,'links',coalesce((select jsonb_agg(
    jsonb_build_object('id',v.id,'kind',case v.kind when 'affiliate' then 'affiliate' else 'supplier' end,
      'url',v.destination_url,'itemLabel',i.label,'catalogProductVersionId',null,
      'supplierName',v.supplier_name,'commissionDisclosure',v.commission_disclosure,
      'availabilityStatus',v.availability_status,'lastVerifiedAt',v.last_verified_at,'revokedAt',null,
      'recordedAt',v.created_at) order by i.position,v.created_at desc)
    from clinical_reference.protocol_template_items i
    join commercial_reference.affiliate_offers o on o.product_stable_id=i.product_stable_id
    join commercial_reference.affiliate_offer_versions v on v.offer_stable_id=o.stable_id and v.version=o.active_version
    where i.template_version_id=_version_id and o.review_status='approved' and v.review_status='approved'),'[]'::jsonb),
    'disclaimer','Commercial links are disclosed separately and never affect clinical eligibility, ranking, or safety review.');
end $$;

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check(action in(
  'connection.invitation_issued','connection.invitation_claimed','connection.paused','connection.resumed',
  'connection.revoked','consent.granted','consent.revoked','lab_import.received','lab_import.duplicate',
  'lab_import.accepted','lab_import.rejected','clinical_record.received','clinical_record.duplicate',
  'privacy_request.submitted','patient.created','lab_observation.reviewed','marker.view','document.viewed',
  'document.exported','report.exported','audit.exported','membership.role_changed','membership.suspended',
  'review_task.created','review_task.resolved','appointment.booked','appointment.rescheduled',
  'appointment.status_changed','appointment.corrected','encounter.started','encounter.completed',
  'encounter.cancelled','encounter.entered_in_error','note.draft_created','note.draft_saved',
  'note.ready_for_review','note.signed','note.addendum_created','note.entered_in_error',
  'protocol.draft_created','protocol.draft_saved','protocol.approved','protocol.activated',
  'protocol.paused','protocol.completed','protocol.discontinued','protocol.revision_created',
  'sync.export_queued','sync.resource_withdrawal_queued','sync.event_retried','sync.event_cancelled',
  'sync.inbound_accepted','sync.inbound_rejected','sync.inbound_correction_recorded','sync.conflict_resolved',
  'sync.provider_registered','sync.provider_reviewed','protocol.interaction_reviewed',
  'protocol_template.created','protocol_template.approved','protocol_template.archived',
  'hypothesis.accepted','hypothesis.rejected','hypothesis.needs_data','lens.question_accepted',
  'lens.question_asked','lens.question_deferred','lens.question_skipped','lens.question_dismissed',
  'lens.question_answered','lens.answer_corrected','lens.question_added_to_note','lens.safety_block_reviewed',
  'knowledge.pathway_draft_created','knowledge.pathway_draft_updated','knowledge.pathway_approved',
  'knowledge.import_staged','knowledge.import_item_applied','knowledge.import_item_rejected',
  'knowledge.import_conflict_resolved','knowledge.research_review_recorded',
  'knowledge.import_committed','knowledge.import_cancelled'));

revoke all on function clinical_core.preview_knowledge_import(uuid,text,text,text,jsonb,boolean,text,bigint,text,text[],text,boolean) from public;
revoke all on function clinical_core.get_knowledge_import_preview(uuid) from public;
revoke all on function clinical_core.resolve_knowledge_import_conflict(uuid,text,text) from public;
revoke all on function clinical_core.record_research_handoff_item_review(uuid,text,text) from public;
revoke all on function clinical_core.get_research_handoff_review(uuid,text[]) from public;
revoke all on function clinical_core.commit_knowledge_import(uuid,jsonb,text) from public;
revoke all on function clinical_core.cancel_knowledge_import(uuid,text) from public;
revoke all on function clinical_core.list_label_commercial_links(uuid) from public;
revoke all on function clinical_core.list_protocol_commercial_links(uuid) from public;
grant execute on function clinical_core.preview_knowledge_import(uuid,text,text,text,jsonb,boolean,text,bigint,text,text[],text,boolean) to clinical_core_api;
grant execute on function clinical_core.get_knowledge_import_preview(uuid) to clinical_core_api;
grant execute on function clinical_core.resolve_knowledge_import_conflict(uuid,text,text) to clinical_core_api;
grant execute on function clinical_core.record_research_handoff_item_review(uuid,text,text) to clinical_core_api;
grant execute on function clinical_core.get_research_handoff_review(uuid,text[]) to clinical_core_api;
grant execute on function clinical_core.commit_knowledge_import(uuid,jsonb,text) to clinical_core_api;
grant execute on function clinical_core.cancel_knowledge_import(uuid,text) to clinical_core_api;
grant execute on function clinical_core.list_label_commercial_links(uuid) to clinical_core_api;
grant execute on function clinical_core.list_protocol_commercial_links(uuid) to clinical_core_api;
