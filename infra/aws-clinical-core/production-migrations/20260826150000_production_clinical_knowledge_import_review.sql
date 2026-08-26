-- Tenant-scoped clinical knowledge staging and practitioner review. This
-- migration creates no import rows, approves no pathway, verifies no product,
-- and grants no production activation authority.

create table clinical_core.clinical_knowledge_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  source_name text not null check (char_length(btrim(source_name)) between 1 and 240),
  source_revision text check (source_revision is null or char_length(source_revision) <= 120),
  schema_version text not null check (schema_version = 'clinical-knowledge-import-v1'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'in_review'
    check (status in ('in_review','completed','cancelled')),
  item_count integer not null check (item_count between 1 and 250),
  no_phi_attested_by_person_id uuid not null references clinical_core.persons(id),
  no_phi_attested_at timestamptz not null default clock_timestamp(),
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  data_classification text not null default 'reference_only'
    check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false),
  unique (organization_id,source_sha256,schema_version),
  unique (id,organization_id),
  check ((status='completed')=(completed_at is not null))
);

create table clinical_core.clinical_knowledge_import_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  organization_id uuid not null references clinical_core.organizations(id),
  entity_type text not null check (entity_type in ('pathway','product_label')),
  external_key text not null check (char_length(btrim(external_key)) between 1 and 200),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 300),
  source_sheet text check (source_sheet is null or char_length(source_sheet) <= 200),
  payload jsonb not null check (
    jsonb_typeof(payload)='object'
    and octet_length(payload::text) <= 524288
    and payload::text !~* '"(affiliateUrl|affiliateUrls|destinationUrl|discountCode|trackingCode)"'
  ),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  warnings jsonb not null default '[]'::jsonb check (
    jsonb_typeof(warnings)='array' and jsonb_array_length(warnings)<=50
    and octet_length(warnings::text)<=32768
  ),
  validation_errors jsonb not null default '[]'::jsonb check (
    jsonb_typeof(validation_errors)='array' and jsonb_array_length(validation_errors)<=25
  ),
  status text not null default 'needs_review'
    check (status in ('needs_review','applied','rejected')),
  review_note text check (review_note is null or char_length(review_note)<=2000),
  reviewed_by_person_id uuid references clinical_core.persons(id),
  reviewed_at timestamptz,
  applied_ref_type text check (
    applied_ref_type is null or applied_ref_type in ('clinical_pathway_version','product_label_candidate')
  ),
  applied_ref_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  data_classification text not null default 'reference_only'
    check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false),
  foreign key (batch_id,organization_id)
    references clinical_core.clinical_knowledge_import_batches(id,organization_id),
  unique (batch_id,external_key),
  check (
    (status='needs_review' and reviewed_at is null and reviewed_by_person_id is null
      and applied_ref_type is null and applied_ref_id is null)
    or (status='rejected' and reviewed_at is not null and reviewed_by_person_id is not null
      and applied_ref_type is null and applied_ref_id is null)
    or (status='applied' and reviewed_at is not null and reviewed_by_person_id is not null
      and applied_ref_type is not null and applied_ref_id is not null)
  )
);

create table clinical_reference.product_label_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  product_code text not null check (product_code ~ '^[a-z0-9][a-z0-9_-]{2,95}$'),
  product_name text not null check (char_length(btrim(product_name)) between 1 and 200),
  brand text not null check (char_length(btrim(brand)) between 1 and 200),
  exact_label jsonb not null check (
    jsonb_typeof(exact_label)='object' and octet_length(exact_label::text)<=262144
    and exact_label::text !~* '"(affiliateUrl|affiliateUrls|destinationUrl|discountCode|trackingCode)"'
  ),
  label_sha256 text not null check (label_sha256 ~ '^[0-9a-f]{64}$'),
  source_url text not null check (source_url ~ '^https://[^[:space:]]{1,1990}$'),
  review_status text not null default 'needs_review' check (review_status='needs_review'),
  source_import_item_id uuid not null unique
    references clinical_core.clinical_knowledge_import_items(id),
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  data_classification text not null default 'reference_only'
    check (data_classification='reference_only'),
  contains_phi boolean not null default false check (contains_phi=false),
  unique (organization_id,product_code,label_sha256)
);

create index clinical_knowledge_import_batches_org_idx
  on clinical_core.clinical_knowledge_import_batches(organization_id,created_at desc,id);
create index clinical_knowledge_import_items_batch_idx
  on clinical_core.clinical_knowledge_import_items(batch_id,status,created_at,id);
create index clinical_knowledge_import_items_org_idx
  on clinical_core.clinical_knowledge_import_items(organization_id,created_at,id);
create index product_label_candidates_org_idx
  on clinical_reference.product_label_candidates(organization_id,product_code,created_at desc);

alter table clinical_core.clinical_knowledge_import_batches enable row level security;
alter table clinical_core.clinical_knowledge_import_items enable row level security;
alter table clinical_reference.product_label_candidates enable row level security;
revoke all on clinical_core.clinical_knowledge_import_batches,
  clinical_core.clinical_knowledge_import_items,
  clinical_reference.product_label_candidates from public,clinical_core_api;

create or replace function clinical_private.protect_knowledge_import_batch()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    raise exception using errcode='55000',message='knowledge_import_batch_append_only';
  end if;
  if (to_jsonb(new)-'status'-'completed_at')<>(to_jsonb(old)-'status'-'completed_at')
    or old.status='completed' or new.status not in ('completed','cancelled') then
    raise exception using errcode='55000',message='knowledge_import_batch_source_immutable';
  end if;
  return new;
end $$;

create trigger clinical_knowledge_import_batches_protected
  before update or delete on clinical_core.clinical_knowledge_import_batches
  for each row execute function clinical_private.protect_knowledge_import_batch();

create or replace function clinical_private.protect_knowledge_import_item()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    raise exception using errcode='55000',message='knowledge_import_item_append_only';
  end if;
  if (to_jsonb(new)-'status'-'review_note'-'reviewed_by_person_id'-'reviewed_at'
      -'applied_ref_type'-'applied_ref_id')
    <>(to_jsonb(old)-'status'-'review_note'-'reviewed_by_person_id'-'reviewed_at'
      -'applied_ref_type'-'applied_ref_id')
    or old.status<>'needs_review' or new.status not in ('applied','rejected') then
    raise exception using errcode='55000',message='knowledge_import_item_source_immutable';
  end if;
  return new;
end $$;

create trigger clinical_knowledge_import_items_protected
  before update or delete on clinical_core.clinical_knowledge_import_items
  for each row execute function clinical_private.protect_knowledge_import_item();

create trigger product_label_candidates_append_only
  before update or delete on clinical_reference.product_label_candidates
  for each row execute function clinical_reference.reject_immutable_catalog_history();

create or replace function clinical_private.knowledge_import_validation_errors(
  _entity_type text,_payload jsonb
) returns jsonb language plpgsql immutable set search_path='' as $$
declare _errors jsonb:='[]'::jsonb; _content jsonb; _label jsonb; _sources jsonb;
begin
  if _payload::text ~* '"(affiliateUrl|affiliateUrls|destinationUrl|discountCode|trackingCode)"' then
    _errors:=_errors||'["Commercial fields must use the separate governed commercial import"]'::jsonb;
  end if;
  if _entity_type='pathway' then
    _content:=_payload->'content'; _sources:=_payload->'sourceRefs';
    if coalesce(_payload->>'code','') !~ '^[a-z0-9][a-z0-9_-]{1,63}$' then
      _errors:=_errors||'["Pathway code is invalid"]'::jsonb; end if;
    if char_length(btrim(coalesce(_payload->>'name',''))) not between 1 and 200 then
      _errors:=_errors||'["Pathway name is required"]'::jsonb; end if;
    if coalesce(_payload->>'domainCode','') !~ '^[a-z0-9][a-z0-9_-]{1,63}$' then
      _errors:=_errors||'["Pathway domain is invalid"]'::jsonb; end if;
    if jsonb_typeof(_sources)<>'array' or jsonb_array_length(_sources)=0
      or jsonb_array_length(_sources)>100 or octet_length(coalesce(_sources,'[]'::jsonb)::text)>131072 then
      _errors:=_errors||'["At least one bounded pathway source reference is required"]'::jsonb; end if;
    if jsonb_typeof(_content)<>'object' then
      _errors:=_errors||'["Pathway content must be an object"]'::jsonb;
    elsif jsonb_typeof(coalesce(_content->'differentiatingQuestions','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(_content->'labStrategy','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(_content->'productCandidates','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(_content->'nutrition','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(_content->'lifestyle','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(_content->'safetyStops','[]'::jsonb))<>'array'
      or octet_length(_content::text)>524288 then
      _errors:=_errors||'["Pathway content arrays are invalid or oversized"]'::jsonb;
    end if;
  elsif _entity_type='product_label' then
    _label:=_payload->'exactLabel';
    if coalesce(_payload->>'productCode','') !~ '^[a-z0-9][a-z0-9_-]{2,95}$' then
      _errors:=_errors||'["Product code is invalid"]'::jsonb; end if;
    if char_length(btrim(coalesce(_payload->>'productName',''))) not between 1 and 200 then
      _errors:=_errors||'["Product name is required"]'::jsonb; end if;
    if char_length(btrim(coalesce(_payload->>'brand',''))) not between 1 and 200 then
      _errors:=_errors||'["Product brand is required"]'::jsonb; end if;
    if jsonb_typeof(_label)<>'object' then
      _errors:=_errors||'["Exact product label must be an object"]'::jsonb;
    else
      if coalesce(btrim(_label->>'ingredients'),'')='' then
        _errors:=_errors||'["Ingredient amounts and units are required"]'::jsonb; end if;
      if coalesce(btrim(_label->>'servingSize'),'')='' then
        _errors:=_errors||'["Serving size is required"]'::jsonb; end if;
    end if;
    if coalesce(_payload->>'sourceUrl','') !~ '^https://[^[:space:]]{1,1990}$' then
      _errors:=_errors||'["Current manufacturer label URL is required"]'::jsonb; end if;
  else
    _errors:=_errors||'["Unsupported import entity type"]'::jsonb;
  end if;
  return _errors;
end $$;

create or replace function clinical_core.stage_clinical_knowledge_import(
  _organization_id uuid,_source_name text,_source_revision text,_schema_version text,
  _items jsonb,_attests_no_phi boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _batch_id uuid; _existing record; _item jsonb; _payload jsonb;
  _entity_type text; _source_sha text; _payload_sha text; _count integer;
begin
  _actor:=clinical_private.require_knowledge_editor(_organization_id);
  if _attests_no_phi is distinct from true then
    raise exception using errcode='55000',message='knowledge_import_no_phi_attestation_required'; end if;
  if char_length(btrim(coalesce(_source_name,''))) not between 1 and 240
    or char_length(coalesce(_source_revision,''))>120
    or _schema_version<>'clinical-knowledge-import-v1'
    or jsonb_typeof(_items)<>'array' or octet_length(coalesce(_items,'[]'::jsonb)::text)>4194304 then
    raise exception using errcode='22023',message='knowledge_import_bundle_invalid'; end if;
  _count:=jsonb_array_length(_items);
  if _count not between 1 and 250 then
    raise exception using errcode='22023',message='knowledge_import_item_count_invalid'; end if;
  if _items::text ~* '"(affiliateUrl|affiliateUrls|destinationUrl|discountCode|trackingCode)"' then
    raise exception using errcode='22023',message='knowledge_import_commercial_data_refused'; end if;
  _source_sha:=encode(public.digest(convert_to(_items::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    _organization_id::text||':'||_source_sha||':'||_schema_version,0));
  select id,item_count into _existing from clinical_core.clinical_knowledge_import_batches
    where organization_id=_organization_id and source_sha256=_source_sha
      and schema_version=_schema_version;
  if found then
    return jsonb_build_object('batchId',_existing.id,'itemCount',_existing.item_count,'duplicate',true);
  end if;
  insert into clinical_core.clinical_knowledge_import_batches(
    organization_id,source_name,source_revision,schema_version,source_sha256,status,item_count,
    no_phi_attested_by_person_id,created_by_person_id
  ) values(_organization_id,btrim(_source_name),nullif(btrim(_source_revision),''),_schema_version,
    _source_sha,'in_review',_count,_actor,_actor) returning id into _batch_id;
  for _item in select value from jsonb_array_elements(_items) loop
    if jsonb_typeof(_item)<>'object' or jsonb_typeof(_item->'payload')<>'object'
      or char_length(btrim(coalesce(_item->>'externalKey',''))) not between 1 and 200
      or char_length(btrim(coalesce(_item->>'displayName',''))) not between 1 and 300
      or char_length(coalesce(_item->>'sourceSheet',''))>200
      or jsonb_typeof(coalesce(_item->'warnings','[]'::jsonb))<>'array'
      or jsonb_array_length(coalesce(_item->'warnings','[]'::jsonb))>50 then
      raise exception using errcode='22023',message='knowledge_import_item_invalid'; end if;
    _entity_type:=_item->>'entityType'; _payload:=_item->'payload';
    if _entity_type not in ('pathway','product_label')
      or octet_length(_payload::text)>524288 then
      raise exception using errcode='22023',message='knowledge_import_item_invalid'; end if;
    _payload_sha:=encode(public.digest(convert_to(_payload::text,'UTF8'),'sha256'),'hex');
    insert into clinical_core.clinical_knowledge_import_items(
      batch_id,organization_id,entity_type,external_key,display_name,source_sheet,payload,
      payload_sha256,warnings,validation_errors
    ) values(_batch_id,_organization_id,_entity_type,btrim(_item->>'externalKey'),
      btrim(_item->>'displayName'),nullif(btrim(_item->>'sourceSheet'),''),_payload,_payload_sha,
      coalesce(_item->'warnings','[]'::jsonb),
      clinical_private.knowledge_import_validation_errors(_entity_type,_payload));
  end loop;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_organization_id,_actor,'knowledge.import_staged',
    'clinical_knowledge_import_batch',_batch_id,'Clinical knowledge import staged for review',
    'clinical_data',jsonb_build_object('itemCount',_count,'schemaVersion',_schema_version));
  return jsonb_build_object('batchId',_batch_id,'itemCount',_count,'duplicate',false);
end $$;

create or replace function clinical_core.review_clinical_knowledge_import_item(
  _item_id uuid,_decision text,_review_note text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _item clinical_core.clinical_knowledge_import_items%rowtype;
  _batch clinical_core.clinical_knowledge_import_batches%rowtype; _actor uuid;
  _payload jsonb; _pathway_id uuid; _applied_id uuid; _applied_type text;
  _version integer; _label_sha text;
begin
  select * into _item from clinical_core.clinical_knowledge_import_items
    where id=_item_id for update;
  if not found then raise exception using errcode='P0002',message='knowledge_import_item_not_found'; end if;
  _actor:=clinical_private.require_knowledge_editor(_item.organization_id);
  if _item.status<>'needs_review' then
    raise exception using errcode='55000',message='knowledge_import_item_already_reviewed'; end if;
  if _decision not in ('accept','reject')
    or char_length(btrim(coalesce(_review_note,''))) not between 10 and 2000 then
    raise exception using errcode='22023',message='knowledge_import_review_invalid'; end if;
  select * into _batch from clinical_core.clinical_knowledge_import_batches
    where id=_item.batch_id for update;
  if _decision='reject' then
    update clinical_core.clinical_knowledge_import_items set status='rejected',
      review_note=btrim(_review_note),reviewed_by_person_id=_actor,reviewed_at=clock_timestamp()
      where id=_item.id;
  else
    if jsonb_array_length(_item.validation_errors)>0 then
      raise exception using errcode='55000',message='knowledge_import_source_correction_required'; end if;
    _payload:=_item.payload;
    if _item.entity_type='pathway' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        _item.organization_id::text||':pathway:'||(_payload->>'code'),0));
      select id into _pathway_id from clinical_core.clinical_pathways
        where organization_id=_item.organization_id and code=_payload->>'code' and retired_at is null
        for update;
      if _pathway_id is null then
        insert into clinical_core.clinical_pathways(organization_id,code,name,domain_code,description,
          created_by_person_id) values(_item.organization_id,_payload->>'code',btrim(_payload->>'name'),
          _payload->>'domainCode',left(coalesce(_payload->>'description',''),10000),_actor)
          returning id into _pathway_id;
      end if;
      select coalesce(max(version),0)+1 into _version from clinical_core.clinical_pathway_versions
        where pathway_id=_pathway_id;
      insert into clinical_core.clinical_pathway_versions(pathway_id,organization_id,version,status,
        content,source_refs,content_sha256,change_summary,created_by_person_id)
      values(_pathway_id,_item.organization_id,_version,'draft',_payload->'content',
        _payload->'sourceRefs',encode(public.digest(convert_to((_payload->'content')::text,'UTF8'),'sha256'),'hex'),
        left('Imported from '||_batch.source_name||'; separate approval required',2000),_actor)
      returning id into _applied_id;
      _applied_type:='clinical_pathway_version';
    elsif _item.entity_type='product_label' then
      _label_sha:=encode(public.digest(convert_to((_payload->'exactLabel')::text,'UTF8'),'sha256'),'hex');
      insert into clinical_reference.product_label_candidates(organization_id,product_code,product_name,
        brand,exact_label,label_sha256,source_url,source_import_item_id,created_by_person_id)
      values(_item.organization_id,_payload->>'productCode',btrim(_payload->>'productName'),
        btrim(_payload->>'brand'),_payload->'exactLabel',_label_sha,_payload->>'sourceUrl',_item.id,_actor)
      returning id into _applied_id;
      _applied_type:='product_label_candidate';
    else
      raise exception using errcode='55000',message='knowledge_import_apply_path_missing';
    end if;
    update clinical_core.clinical_knowledge_import_items set status='applied',
      review_note=btrim(_review_note),reviewed_by_person_id=_actor,reviewed_at=clock_timestamp(),
      applied_ref_type=_applied_type,applied_ref_id=_applied_id where id=_item.id;
  end if;
  if not exists(select 1 from clinical_core.clinical_knowledge_import_items
      where batch_id=_item.batch_id and status='needs_review') then
    update clinical_core.clinical_knowledge_import_batches set status='completed',
      completed_at=clock_timestamp() where id=_item.batch_id;
  end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_item.organization_id,_actor,
    case when _decision='accept' then 'knowledge.import_item_applied'
      else 'knowledge.import_item_rejected' end,'clinical_knowledge_import_item',_item.id,
    case when _decision='accept' then 'Clinical knowledge item applied as a non-approved candidate'
      else 'Clinical knowledge import item rejected' end,'clinical_data',
    jsonb_build_object('entityType',_item.entity_type,'decision',_decision));
  return jsonb_build_object('status',case when _decision='accept' then 'applied' else 'rejected' end,
    'appliedRefType',_applied_type,'appliedRefId',_applied_id);
end $$;

create or replace function clinical_core.list_clinical_knowledge_import_batches(
  _organization_id uuid,_limit integer default 20
) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.require_knowledge_editor(_organization_id);
  if coalesce(_limit,0) not between 1 and 20 then
    raise exception using errcode='22023',message='knowledge_import_limit_invalid'; end if;
  return coalesce((select jsonb_agg(to_jsonb(batch) order by batch.created_at desc,batch.id)
    from (select id,organization_id,source_name,source_revision,schema_version,source_sha256,status,
      item_count,no_phi_attested_at,created_at,completed_at
      from clinical_core.clinical_knowledge_import_batches
      where organization_id=_organization_id order by created_at desc,id limit _limit) batch),'[]'::jsonb);
end $$;

create or replace function clinical_core.list_clinical_knowledge_import_items(
  _organization_id uuid,_batch_ids uuid[]
) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.require_knowledge_editor(_organization_id);
  if _batch_ids is null or cardinality(_batch_ids) not between 1 and 20 then
    raise exception using errcode='22023',message='knowledge_import_batch_ids_invalid'; end if;
  return coalesce((select jsonb_agg(to_jsonb(item) order by item.created_at,item.id)
    from (select id,batch_id,entity_type,external_key,display_name,source_sheet,payload_sha256,
      warnings,validation_errors,status,review_note,reviewed_at,applied_ref_type,applied_ref_id,created_at
      from clinical_core.clinical_knowledge_import_items
      where organization_id=_organization_id and batch_id=any(_batch_ids)
      order by created_at,id limit 5000) item),'[]'::jsonb);
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
  'knowledge.import_staged','knowledge.import_item_applied','knowledge.import_item_rejected'));

alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check check(resource_type in(
  'connection','consent','lab_import','clinical_record','privacy_request','patient_profile','lab_observation',
  'biomarker_observation','lab_document','report','audit_log','organization_membership','review_queue_item',
  'appointment','encounter','clinical_note','patient_protocol','patient_protocol_version',
  'sync_outbound_event','sync_inbound_event','sync_inbound_correction','sync_conflict','sync_provider',
  'protocol_item','protocol_template','protocol_template_version','clinical_pathway',
  'clinical_pathway_version','clinical_hypothesis','differential_question','lens_evaluation',
  'clinical_knowledge_import_batch','clinical_knowledge_import_item'));

revoke all on function clinical_core.stage_clinical_knowledge_import(uuid,text,text,text,jsonb,boolean)
  from public;
revoke all on function clinical_core.review_clinical_knowledge_import_item(uuid,text,text) from public;
revoke all on function clinical_core.list_clinical_knowledge_import_batches(uuid,integer) from public;
revoke all on function clinical_core.list_clinical_knowledge_import_items(uuid,uuid[]) from public;
grant execute on function clinical_core.stage_clinical_knowledge_import(uuid,text,text,text,jsonb,boolean)
  to clinical_core_api;
grant execute on function clinical_core.review_clinical_knowledge_import_item(uuid,text,text)
  to clinical_core_api;
grant execute on function clinical_core.list_clinical_knowledge_import_batches(uuid,integer)
  to clinical_core_api;
grant execute on function clinical_core.list_clinical_knowledge_import_items(uuid,uuid[])
  to clinical_core_api;
