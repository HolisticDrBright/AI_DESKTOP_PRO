-- AWS-native organization protocol templates, governed catalog search, and
-- attributable interaction review. This migration seeds no rows and does not
-- enable the production API or PHI routing.

create table clinical_core.protocol_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text check (description is null or char_length(description) <= 10000),
  status text not null default 'draft' check (status in ('draft','approved','archived')),
  current_version_id uuid,
  approved_version_id uuid,
  archived_at timestamptz,
  created_by_person_id uuid not null references clinical_core.persons(id),
  updated_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, organization_id),
  check ((status='archived')=(archived_at is not null))
);

create table clinical_core.protocol_template_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  template_id uuid not null references clinical_core.protocol_templates(id),
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft','approved','superseded')),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text check (description is null or char_length(description) <= 10000),
  template_payload jsonb not null check (
    jsonb_typeof(template_payload)='object'
    and jsonb_typeof(coalesce(template_payload->'phases','[]'::jsonb))='array'
    and jsonb_typeof(coalesce(template_payload->'items','[]'::jsonb))='array'
    and octet_length(template_payload::text) <= 524288
    and template_payload::text !~* '"(affiliateUrl|destinationUrl|discountCode|trackingCode)"'
  ),
  source_patient_version_id uuid references clinical_core.patient_protocol_versions(id),
  approved_by_person_id uuid references clinical_core.persons(id),
  approved_at timestamptz,
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (template_id, version),
  unique (id, template_id),
  foreign key (template_id, organization_id)
    references clinical_core.protocol_templates(id, organization_id),
  check ((status in ('approved','superseded') and approved_at is not null and approved_by_person_id is not null)
    or (status='draft' and approved_at is null and approved_by_person_id is null))
);

alter table clinical_core.protocol_templates
  add constraint protocol_templates_current_version_fk
    foreign key (current_version_id,id) references clinical_core.protocol_template_versions(id,template_id),
  add constraint protocol_templates_approved_version_fk
    foreign key (approved_version_id,id) references clinical_core.protocol_template_versions(id,template_id);

alter table clinical_core.patient_protocol_items
  add column interaction_reviewed_by_person_id uuid references clinical_core.persons(id),
  add column interaction_reviewed_at timestamptz,
  add column interaction_review_note text check (
    interaction_review_note is null or char_length(interaction_review_note) <= 2000),
  add constraint patient_protocol_item_review_consistent check (
    (interaction_review_state='not_completed' and interaction_reviewed_by_person_id is null
      and interaction_reviewed_at is null and interaction_review_note is null)
    or (interaction_review_state='reviewed_by_practitioner'
      and interaction_reviewed_by_person_id is not null and interaction_reviewed_at is not null)
  );

create index protocol_templates_org_idx
  on clinical_core.protocol_templates(organization_id,status,updated_at desc);
create index protocol_template_versions_template_idx
  on clinical_core.protocol_template_versions(template_id,version desc);

alter table clinical_core.protocol_templates enable row level security;
alter table clinical_core.protocol_template_versions enable row level security;
revoke all on clinical_core.protocol_templates,clinical_core.protocol_template_versions
  from public,clinical_core_api;

create or replace function clinical_private.protect_protocol_template_version()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.status<>'draft' and not (tg_op='UPDATE' and old.status='approved'
    and new.status='superseded'
    and (to_jsonb(new)-'status')=(to_jsonb(old)-'status')) then
    raise exception using errcode='55000',message='protocol_template_version_immutable';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create trigger protocol_template_versions_immutable
  before update or delete on clinical_core.protocol_template_versions
  for each row execute function clinical_private.protect_protocol_template_version();

create or replace function clinical_private.require_protocol_template_author(_organization_id uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare _actor uuid;
begin
  perform clinical_private.assert_production_context(_organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode='42501',message='clinical_role_required';
  end if;
  _actor:=clinical_private.actor_person_id();
  return _actor;
end $$;

create or replace function clinical_core.list_protocol_templates(
  _organization_id uuid,_include_archived boolean default false
) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.require_protocol_template_author(_organization_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',template.id,'name',template.name,'description',template.description,
    'status',template.status,'archivedAt',template.archived_at,
    'approvedVersionId',template.approved_version_id,'currentVersionId',template.current_version_id,
    'approvedVersion',approved.version,'updatedAt',template.updated_at)
    order by template.name,template.id)
    from clinical_core.protocol_templates template
    left join clinical_core.protocol_template_versions approved on approved.id=template.approved_version_id
    where template.organization_id=_organization_id
      and (_include_archived or template.status<>'archived')),'[]'::jsonb);
end $$;

create or replace function clinical_core.create_protocol_template(
  _organization_id uuid,_name text,_description text default null,_from_version_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _template_id uuid; _template_version_id uuid;
  _source clinical_core.patient_protocol_versions%rowtype; _payload jsonb;
begin
  _actor:=clinical_private.require_protocol_template_author(_organization_id);
  if char_length(btrim(coalesce(_name,''))) not between 1 and 200
    or char_length(coalesce(_description,''))>10000 then
    raise exception using errcode='22023',message='protocol_template_input_invalid';
  end if;
  _payload:=jsonb_build_object('title',btrim(_name),'summary',nullif(_description,''),
    'dietInstructions',null,'lifestyleInstructions',null,'monitoringPlan',null,'followupPlan',null,
    'phases','[]'::jsonb,'items','[]'::jsonb);
  if _from_version_id is not null then
    select * into _source from clinical_core.patient_protocol_versions where id=_from_version_id;
    if not found or _source.organization_id<>_organization_id then
      raise exception using errcode='P0002',message='source_protocol_version_not_found';
    end if;
    perform clinical_private.require_clinical_patient(_organization_id,_source.patient_record_id);
    if _source.status not in ('approved','active','superseded') then
      raise exception using errcode='55000',message='approved_source_protocol_required';
    end if;
    -- The reusable template deliberately omits all patient free text, phases,
    -- identifiers, and review claims. Only bounded structured clinical fields
    -- are copied; patient-specific interaction review must be repeated.
    select jsonb_build_object('title',btrim(_name),'summary',nullif(_description,''),
      'dietInstructions',null,'lifestyleInstructions',null,'monitoringPlan',null,'followupPlan',null,
      'phases','[]'::jsonb,'items',coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'kind',item.kind,'label',item.label,'instructions',null,'phaseIndex',null,
        'catalogProductId',item.catalog_product_stable_id,
        'catalogProductVersionId',case when item.catalog_product_version is null then null
          else item.catalog_product_version::text end,
        'manufacturer',item.manufacturer,'labelVersion',item.label_version,
        'dosageText',item.dosage_text,'timingText',item.timing_text,'route',item.route,
        'verificationStatus','unverified')) order by item.position),'[]'::jsonb)) into _payload
      from clinical_core.patient_protocol_items item where item.protocol_version_id=_source.id;
  end if;
  insert into clinical_core.protocol_templates(organization_id,name,description,status,
    created_by_person_id,updated_by_person_id) values(_organization_id,btrim(_name),nullif(_description,''),
    'draft',_actor,_actor) returning id into _template_id;
  insert into clinical_core.protocol_template_versions(organization_id,template_id,version,status,name,
    description,template_payload,source_patient_version_id,created_by_person_id)
    values(_organization_id,_template_id,1,'draft',btrim(_name),nullif(_description,''),_payload,
      _from_version_id,_actor) returning id into _template_version_id;
  update clinical_core.protocol_templates set current_version_id=_template_version_id where id=_template_id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_organization_id,_actor,'protocol_template.created',
    'protocol_template',_template_id,'Protocol template draft created','clinical_data',
    jsonb_build_object('from_patient_version',_from_version_id is not null));
  return jsonb_build_object('ok',true,'templateId',_template_id,'versionId',_template_version_id,
    'version',1,'status','draft','message','Protocol template draft created. Patient free text was not copied.');
end $$;

create or replace function clinical_core.approve_protocol_template_version(_version_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _version clinical_core.protocol_template_versions%rowtype; _actor uuid; _prior uuid;
begin
  select * into _version from clinical_core.protocol_template_versions where id=_version_id for update;
  if not found then raise exception using errcode='P0002',message='protocol_template_version_not_found'; end if;
  _actor:=clinical_private.require_protocol_template_author(_version.organization_id);
  if _version.status<>'draft' then
    raise exception using errcode='55000',message='protocol_template_version_not_draft'; end if;
  if jsonb_array_length(coalesce(_version.template_payload->'items','[]'::jsonb))=0 then
    raise exception using errcode='22023',message='protocol_template_empty'; end if;
  if exists(select 1 from jsonb_array_elements(_version.template_payload->'items') item
    where item->>'kind'='product' and not exists(
      select 1 from clinical_reference.catalog_products product
      join clinical_reference.catalog_product_versions product_version
        on product_version.product_stable_id=product.stable_id and product_version.version=product.active_version
      where product.stable_id=item->>'catalogProductId' and product.review_status='approved'
        and product_version.review_status='approved'
        and product_version.version::text=item->>'catalogProductVersionId'
        and exists(select 1 from clinical_reference.product_label_verifications verification
          where verification.product_version_id=product_version.id))) then
    raise exception using errcode='55000',message='verified_governed_product_required';
  end if;
  select approved_version_id into _prior from clinical_core.protocol_templates
    where id=_version.template_id for update;
  if _prior is not null and _prior<>_version.id then
    update clinical_core.protocol_template_versions set status='superseded' where id=_prior;
  end if;
  update clinical_core.protocol_template_versions set status='approved',approved_by_person_id=_actor,
    approved_at=clock_timestamp() where id=_version.id;
  update clinical_core.protocol_templates set status='approved',approved_version_id=_version.id,
    current_version_id=_version.id,updated_by_person_id=_actor,updated_at=clock_timestamp()
    where id=_version.template_id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_version.organization_id,_actor,
    'protocol_template.approved','protocol_template_version',_version.id,
    'Protocol template version approved','clinical_data',jsonb_build_object('version',_version.version));
  return jsonb_build_object('ok',true,'templateId',_version.template_id,'versionId',_version.id,
    'status','approved','message','Template version approved and immutable.');
end $$;

create or replace function clinical_core.archive_protocol_template(_template_id uuid,_archived boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _template clinical_core.protocol_templates%rowtype; _actor uuid;
begin
  select * into _template from clinical_core.protocol_templates where id=_template_id for update;
  if not found then raise exception using errcode='P0002',message='protocol_template_not_found'; end if;
  _actor:=clinical_private.require_protocol_template_author(_template.organization_id);
  if _archived then
    update clinical_core.protocol_templates set status='archived',archived_at=clock_timestamp(),
      updated_by_person_id=_actor,updated_at=clock_timestamp() where id=_template.id;
  else
    update clinical_core.protocol_templates set status=case when approved_version_id is null then 'draft' else 'approved' end,
      archived_at=null,updated_by_person_id=_actor,updated_at=clock_timestamp() where id=_template.id;
  end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_template.organization_id,_actor,
    'protocol_template.archived','protocol_template',_template.id,
    case when _archived then 'Protocol template archived' else 'Protocol template restored' end,
    'clinical_data',jsonb_build_object('archived',_archived));
  return jsonb_build_object('ok',true,'templateId',_template.id,'archived',_archived,
    'status',case when _archived then 'archived'
      when _template.approved_version_id is null then 'draft' else 'approved' end,
    'message',case when _archived then 'Template archived.' else 'Template restored.' end);
end $$;

create or replace function clinical_core.search_protocol_catalog(
  _organization_id uuid,_query text default null,_limit integer default 20
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _products jsonb; _n integer:=least(greatest(coalesce(_limit,20),1),100);
begin
  perform clinical_private.require_protocol_template_author(_organization_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'productId',product.stable_id,'name',version.display_name,
    'form',version.clinical_payload->>'form','manufacturer',version.brand,
    'productVersionId',version.version::text,'labelVersion',version.version::text,
    'servingSize',version.clinical_payload->>'servingSize',
    'effectiveFrom',version.clinical_payload->>'effectiveAt',
    'verificationStatus',case
      when verification.id is null then 'unverified'
      when jsonb_array_length(coalesce(version.clinical_payload->'ingredientRows','[]'::jsonb))>0
        then 'structured_verified' else 'label_verified' end,
    'structuredIngredientCount',jsonb_array_length(coalesce(version.clinical_payload->'ingredientRows','[]'::jsonb)))
    order by version.display_name,product.stable_id),'[]'::jsonb) into _products
  from (select p.* from clinical_reference.catalog_products p
    where p.review_status='approved' and p.active_version is not null
      and p.environment='production-clinical' and p.contains_phi=false limit _n) product
  join clinical_reference.catalog_product_versions version
    on version.product_stable_id=product.stable_id and version.version=product.active_version
      and version.review_status='approved'
  left join lateral(select v.id from clinical_reference.product_label_verifications v
    where v.product_version_id=version.id order by v.verified_at desc limit 1) verification on true
  where _query is null or btrim(_query)='' or version.display_name ilike '%'||btrim(_query)||'%'
    or coalesce(version.brand,'') ilike '%'||btrim(_query)||'%'
    or product.stable_id ilike '%'||btrim(_query)||'%';
  return jsonb_build_object('products',_products,'query',nullif(btrim(_query),''),
    'generatedAt',clock_timestamp());
end $$;

create or replace function clinical_core.check_protocol_interactions(_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _version clinical_core.patient_protocol_versions%rowtype; _items jsonb;
begin
  select * into _version from clinical_core.patient_protocol_versions where id=_version_id;
  if not found then raise exception using errcode='P0002',message='protocol_version_not_found'; end if;
  perform clinical_private.require_clinical_patient(_version.organization_id,_version.patient_record_id);
  select coalesce(jsonb_agg(jsonb_build_object('itemId',item.id,'label',item.label,
    'verificationStatus',case
      when verification.id is null then 'unverified'
      when jsonb_array_length(coalesce(product_version.clinical_payload->'ingredientRows','[]'::jsonb))>0
        then 'structured_verified' else 'label_verified' end,
    'interactionReviewState',item.interaction_review_state,'state','not_completed',
    'reason',case when product_version.id is null then 'The exact governed product version is unavailable.'
      when verification.id is null then 'The exact governed product label has not been verified.'
      else 'Coded medications and governed interaction references are not yet available in this production boundary.' end,
    'findings','[]'::jsonb) order by item.position,item.id),'[]'::jsonb) into _items
  from clinical_core.patient_protocol_items item
  left join clinical_reference.catalog_product_versions product_version
    on product_version.product_stable_id=item.catalog_product_stable_id
      and product_version.version=item.catalog_product_version
  left join lateral(select v.id from clinical_reference.product_label_verifications v
    where v.product_version_id=product_version.id order by v.verified_at desc limit 1) verification on true
  where item.protocol_version_id=_version.id and item.kind='product';
  return jsonb_build_object('versionId',_version.id,'items',_items,'medicationsRecorded',0,
    'medicationsCoded',0,
    'disclaimer','Interaction review is not completed. No coded medication list or governed interaction reference set is active in this production boundary. A practitioner must review each product before approval.',
    'generatedAt',clock_timestamp());
end $$;

create or replace function clinical_core.review_protocol_item_interactions(_item_id uuid,_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _item clinical_core.patient_protocol_items%rowtype;
  _version clinical_core.patient_protocol_versions%rowtype; _actor uuid; _verification text;
begin
  select * into _item from clinical_core.patient_protocol_items where id=_item_id for update;
  if not found then raise exception using errcode='P0002',message='protocol_item_not_found'; end if;
  select * into _version from clinical_core.patient_protocol_versions where id=_item.protocol_version_id;
  _actor:=clinical_private.require_clinical_patient(_version.organization_id,_version.patient_record_id);
  if _version.status<>'draft' then
    raise exception using errcode='55000',message='protocol_version_immutable'; end if;
  if _item.kind<>'product' then raise exception using errcode='22023',message='product_item_required'; end if;
  if char_length(coalesce(_note,''))>2000 then
    raise exception using errcode='22023',message='interaction_review_note_too_long'; end if;
  if _item.interaction_review_state='reviewed_by_practitioner' then
    return jsonb_build_object('ok',true,'itemId',_item.id,'alreadyReviewed',true,
      'message','Interaction review was already recorded.');
  end if;
  select case when verification.id is null then 'unverified'
    when jsonb_array_length(coalesce(version.clinical_payload->'ingredientRows','[]'::jsonb))>0
      then 'structured_verified' else 'label_verified' end into _verification
  from clinical_reference.catalog_product_versions version
  left join lateral(select v.id from clinical_reference.product_label_verifications v
    where v.product_version_id=version.id order by v.verified_at desc limit 1) verification on true
  where version.product_stable_id=_item.catalog_product_stable_id
    and version.version=_item.catalog_product_version;
  update clinical_core.patient_protocol_items set interaction_review_state='reviewed_by_practitioner',
    interaction_reviewed_by_person_id=_actor,interaction_reviewed_at=clock_timestamp(),
    interaction_review_note=nullif(btrim(_note),''),verification_status=coalesce(_verification,'unverified')
    where id=_item.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_version.organization_id,_actor,
    'protocol.interaction_reviewed','protocol_item',_item.id,_version.patient_record_id,
    'Protocol item interaction review recorded','clinical_data',
    jsonb_build_object('note_present',nullif(btrim(_note),'') is not null,
      'automated_check_completed',false));
  return jsonb_build_object('ok',true,'itemId',_item.id,'alreadyReviewed',false,
    'message','Practitioner interaction review recorded. The automated interaction check remains not completed.');
end $$;

-- Replace the patient draft constructor so an approved organization template
-- can be copied without carrying patient-specific review claims.
create or replace function clinical_core.create_protocol_draft(
  _organization_id uuid,_patient_id uuid,_title text,_from_template_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _protocol clinical_core.patient_protocols%rowtype; _version_id uuid; _next integer;
  _template clinical_core.protocol_templates%rowtype; _template_version clinical_core.protocol_template_versions%rowtype;
  _payload jsonb; _phase jsonb; _item jsonb; _phase_ids uuid[]:='{}'; _phase_id uuid; _phase_index integer;
  _position integer:=0;
begin
  _actor:=clinical_private.require_clinical_patient(_organization_id,_patient_id);
  if char_length(btrim(coalesce(_title,''))) not between 1 and 200 then
    raise exception using errcode='22023',message='protocol_title_invalid'; end if;
  if _from_template_id is not null then
    select * into _template from clinical_core.protocol_templates
      where id=_from_template_id and organization_id=_organization_id and status='approved';
    if not found then raise exception using errcode='P0002',message='approved_protocol_template_not_found'; end if;
    select * into _template_version from clinical_core.protocol_template_versions
      where id=_template.approved_version_id and status='approved';
    if not found then raise exception using errcode='55000',message='approved_protocol_template_version_missing'; end if;
    _payload:=_template_version.template_payload;
  else _payload:=jsonb_build_object('phases','[]'::jsonb,'items','[]'::jsonb); end if;
  select * into _protocol from clinical_core.patient_protocols protocol
    where protocol.organization_id=_organization_id and protocol.patient_record_id=_patient_id
      and protocol.deleted_at is null for update;
  if not found then
    insert into clinical_core.patient_protocols(organization_id,patient_record_id,title,status,
      created_by_person_id,updated_by_person_id) values(_organization_id,_patient_id,btrim(_title),
      'draft',_actor,_actor) returning * into _protocol;
  elsif _protocol.status in ('completed','discontinued') then
    raise exception using errcode='55000',message='protocol_closed';
  end if;
  if exists(select 1 from clinical_core.patient_protocol_versions
    where protocol_id=_protocol.id and status='draft') then
    raise exception using errcode='55000',message='protocol_draft_exists'; end if;
  select coalesce(max(version),0)+1 into _next from clinical_core.patient_protocol_versions
    where protocol_id=_protocol.id;
  insert into clinical_core.patient_protocol_versions(organization_id,protocol_id,patient_record_id,
    version,status,title,summary,diet_instructions,lifestyle_instructions,monitoring_plan,followup_plan,
    created_by_person_id,updated_by_person_id)
    values(_organization_id,_protocol.id,_patient_id,_next,'draft',btrim(_title),_payload->>'summary',
      _payload->>'dietInstructions',_payload->>'lifestyleInstructions',_payload->>'monitoringPlan',
      _payload->>'followupPlan',_actor,_actor) returning id into _version_id;
  for _phase in select value from jsonb_array_elements(coalesce(_payload->'phases','[]'::jsonb)) loop
    insert into clinical_core.patient_protocol_phases(protocol_version_id,position,name,starts_on,ends_on,
      relative_start_day,relative_duration_days,notes) values(_version_id,_position,_phase->>'name',
      nullif(_phase->>'startsOn','')::date,nullif(_phase->>'endsOn','')::date,
      nullif(_phase->>'relativeStartDay','')::integer,nullif(_phase->>'relativeDurationDays','')::integer,
      nullif(_phase->>'notes','')) returning id into _phase_id;
    _phase_ids:=_phase_ids||_phase_id; _position:=_position+1;
  end loop;
  _position:=0;
  for _item in select value from jsonb_array_elements(coalesce(_payload->'items','[]'::jsonb)) loop
    _phase_index:=case when nullif(_item->>'phaseIndex','') is null then null
      else (_item->>'phaseIndex')::integer end;
    insert into clinical_core.patient_protocol_items(protocol_version_id,phase_id,position,kind,label,
      instructions,catalog_product_stable_id,catalog_product_version,manufacturer,label_version,
      dosage_text,timing_text,route,verification_status,interaction_review_state)
    values(_version_id,case when _phase_index is null then null else _phase_ids[_phase_index+1] end,
      _position,_item->>'kind',_item->>'label',nullif(_item->>'instructions',''),
      nullif(_item->>'catalogProductId',''),nullif(_item->>'catalogProductVersionId','')::integer,
      nullif(_item->>'manufacturer',''),nullif(_item->>'labelVersion',''),nullif(_item->>'dosageText',''),
      nullif(_item->>'timingText',''),nullif(_item->>'route',''),'unverified','not_completed');
    _position:=_position+1;
  end loop;
  update clinical_core.patient_protocols set current_version_id=_version_id,title=btrim(_title),
    updated_by_person_id=_actor,updated_at=clock_timestamp() where id=_protocol.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_organization_id,_actor,
    'protocol.draft_created','patient_protocol_version',_version_id,_patient_id,
    'Protocol draft created','clinical_data',jsonb_build_object('version',_next,
      'from_template',_from_template_id is not null));
  return jsonb_build_object('ok',true,'protocolId',_protocol.id,'versionId',_version_id,
    'version',_next,'message',case when _from_template_id is null then 'Blank protocol draft created.'
      else 'Protocol draft created from approved template. Interaction review must be repeated.' end);
end $$;

-- Product approval is now possible only from server-derived governed evidence
-- plus an explicit practitioner interaction review. Client verification claims
-- remain ignored by save_protocol_draft.
create or replace function clinical_core.approve_protocol_version(_version_id uuid,_review_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _version clinical_core.patient_protocol_versions%rowtype;
begin
  select * into _version from clinical_core.patient_protocol_versions where id=_version_id for update;
  if not found then raise exception using errcode='P0002',message='protocol_version_not_found'; end if;
  _actor:=clinical_private.require_clinical_patient(_version.organization_id,_version.patient_record_id);
  if _version.status<>'draft' then raise exception using errcode='55000',message='protocol_version_not_draft'; end if;
  if not exists(select 1 from clinical_core.patient_protocol_items where protocol_version_id=_version.id) then
    raise exception using errcode='22023',message='protocol_empty'; end if;
  if exists(select 1 from clinical_core.patient_protocol_items item
    where item.protocol_version_id=_version.id and item.kind='product' and (
      item.interaction_review_state<>'reviewed_by_practitioner' or not exists(
        select 1 from clinical_reference.catalog_products product
        join clinical_reference.catalog_product_versions product_version
          on product_version.product_stable_id=product.stable_id
            and product_version.version=product.active_version
        where product.stable_id=item.catalog_product_stable_id and product.review_status='approved'
          and product_version.review_status='approved'
          and product_version.version=item.catalog_product_version
          and exists(select 1 from clinical_reference.product_label_verifications verification
            where verification.product_version_id=product_version.id)))) then
    raise exception using errcode='55000',message='governed_product_review_required';
  end if;
  update clinical_core.patient_protocol_versions set status='approved',approved_by_person_id=_actor,
    approved_at=clock_timestamp(),review_note=nullif(btrim(_review_note),''),
    updated_by_person_id=_actor,updated_at=clock_timestamp() where id=_version.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_version.organization_id,_actor,
    'protocol.approved','patient_protocol_version',_version.id,_version.patient_record_id,
    'Protocol version approved','clinical_data',jsonb_build_object('version',_version.version,
      'review_note_present',nullif(btrim(_review_note),'') is not null));
  return jsonb_build_object('ok',true,'versionId',_version.id,'status','approved',
    'message','Version approved and immutable. It is not active.');
end $$;

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed','connection.paused',
  'connection.resumed','connection.revoked','consent.granted','consent.revoked',
  'lab_import.received','lab_import.duplicate','lab_import.accepted','lab_import.rejected',
  'clinical_record.received','clinical_record.duplicate','privacy_request.submitted','patient.created',
  'lab_observation.reviewed','marker.view','document.viewed','document.exported','report.exported',
  'audit.exported','membership.role_changed','membership.suspended','review_task.created',
  'review_task.resolved','appointment.booked','appointment.rescheduled','appointment.status_changed',
  'appointment.corrected','encounter.started','encounter.completed','encounter.cancelled',
  'encounter.entered_in_error','note.draft_created','note.draft_saved','note.ready_for_review',
  'note.signed','note.addendum_created','note.entered_in_error','protocol.draft_created',
  'protocol.draft_saved','protocol.approved','protocol.activated','protocol.paused',
  'protocol.completed','protocol.discontinued','protocol.revision_created',
  'protocol.interaction_reviewed','protocol_template.created','protocol_template.approved',
  'protocol_template.archived'));
alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check check (resource_type in (
  'connection','consent','lab_import','clinical_record','privacy_request','patient_profile',
  'lab_observation','biomarker_observation','lab_document','report','audit_log',
  'organization_membership','review_queue_item','appointment','encounter','clinical_note',
  'patient_protocol','patient_protocol_version','protocol_item','protocol_template',
  'protocol_template_version'));

revoke all on function clinical_private.protect_protocol_template_version(),
  clinical_private.require_protocol_template_author(uuid) from public;
grant execute on function clinical_private.protect_protocol_template_version(),
  clinical_private.require_protocol_template_author(uuid) to clinical_core_api;
revoke all on function clinical_core.list_protocol_templates(uuid,boolean),
  clinical_core.create_protocol_template(uuid,text,text,uuid),
  clinical_core.approve_protocol_template_version(uuid),
  clinical_core.archive_protocol_template(uuid,boolean),
  clinical_core.search_protocol_catalog(uuid,text,integer),
  clinical_core.check_protocol_interactions(uuid),
  clinical_core.review_protocol_item_interactions(uuid,text) from public;
grant execute on function clinical_core.list_protocol_templates(uuid,boolean),
  clinical_core.create_protocol_template(uuid,text,text,uuid),
  clinical_core.approve_protocol_template_version(uuid),
  clinical_core.archive_protocol_template(uuid,boolean),
  clinical_core.search_protocol_catalog(uuid,text,integer),
  clinical_core.check_protocol_interactions(uuid),
  clinical_core.review_protocol_item_interactions(uuid,text) to clinical_core_api;
