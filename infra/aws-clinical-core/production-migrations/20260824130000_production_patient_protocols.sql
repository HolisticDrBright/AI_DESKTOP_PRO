-- AWS-native patient protocol lifecycle. No rows are seeded and no protocol
-- can create orders, messages, charges, prescriptions, or signed notes.

create table clinical_core.patient_protocols (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  status text not null default 'draft' check (status in
    ('draft','active','paused','completed','discontinued')),
  current_version_id uuid,
  active_version_id uuid,
  created_by_person_id uuid not null references clinical_core.persons(id),
  updated_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  foreign key (patient_record_id, organization_id)
    references clinical_core.patient_records(id, organization_id),
  unique (id, organization_id, patient_record_id),
  unique (organization_id, patient_record_id)
);

create table clinical_core.patient_protocol_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  protocol_id uuid not null references clinical_core.patient_protocols(id),
  patient_record_id uuid not null,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in
    ('draft','approved','active','superseded','discontinued')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  summary text check (summary is null or char_length(summary) <= 10000),
  diet_instructions text check (diet_instructions is null or char_length(diet_instructions) <= 20000),
  lifestyle_instructions text check (lifestyle_instructions is null or char_length(lifestyle_instructions) <= 20000),
  monitoring_plan text check (monitoring_plan is null or char_length(monitoring_plan) <= 20000),
  followup_plan text check (followup_plan is null or char_length(followup_plan) <= 20000),
  supersedes_version_id uuid references clinical_core.patient_protocol_versions(id),
  approved_by_person_id uuid references clinical_core.persons(id),
  approved_at timestamptz,
  activated_by_person_id uuid references clinical_core.persons(id),
  activated_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 2000),
  created_by_person_id uuid not null references clinical_core.persons(id),
  updated_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (protocol_id, organization_id, patient_record_id)
    references clinical_core.patient_protocols(id, organization_id, patient_record_id),
  unique (protocol_id, version),
  unique (id, protocol_id)
);

alter table clinical_core.patient_protocols
  add constraint patient_protocols_current_version_fk
    foreign key (current_version_id, id)
      references clinical_core.patient_protocol_versions(id, protocol_id),
  add constraint patient_protocols_active_version_fk
    foreign key (active_version_id, id)
      references clinical_core.patient_protocol_versions(id, protocol_id);

create table clinical_core.patient_protocol_phases (
  id uuid primary key default gen_random_uuid(),
  protocol_version_id uuid not null references clinical_core.patient_protocol_versions(id),
  position integer not null check (position between 0 and 23),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  starts_on date,
  ends_on date,
  relative_start_day integer check (relative_start_day is null or relative_start_day between 0 and 3650),
  relative_duration_days integer check (relative_duration_days is null or relative_duration_days between 1 and 3650),
  notes text check (notes is null or char_length(notes) <= 5000),
  created_at timestamptz not null default clock_timestamp(),
  unique (protocol_version_id, position),
  check ((starts_on is null and ends_on is null)
    or (relative_start_day is null and relative_duration_days is null)),
  check (starts_on is null or ends_on is null or ends_on >= starts_on)
);

create table clinical_core.patient_protocol_items (
  id uuid primary key default gen_random_uuid(),
  protocol_version_id uuid not null references clinical_core.patient_protocol_versions(id),
  phase_id uuid references clinical_core.patient_protocol_phases(id),
  position integer not null check (position between 0 and 199),
  kind text not null check (kind in ('product','diet','lifestyle','monitoring','followup')),
  label text not null check (char_length(btrim(label)) between 1 and 240),
  instructions text check (instructions is null or char_length(instructions) <= 10000),
  catalog_product_stable_id text check (catalog_product_stable_id is null
    or catalog_product_stable_id ~ '^prd_[a-z0-9][a-z0-9_-]{2,95}$'),
  catalog_product_version integer check (catalog_product_version is null or catalog_product_version > 0),
  manufacturer text check (manufacturer is null or char_length(manufacturer) <= 200),
  label_version text check (label_version is null or char_length(label_version) <= 120),
  dosage_text text check (dosage_text is null or char_length(dosage_text) <= 1000),
  timing_text text check (timing_text is null or char_length(timing_text) <= 1000),
  route text check (route is null or char_length(route) <= 120),
  verification_status text not null default 'unverified' check (verification_status in
    ('unverified','label_verified','structured_verified')),
  interaction_review_state text not null default 'not_completed' check (interaction_review_state in
    ('not_completed','reviewed_by_practitioner')),
  created_at timestamptz not null default clock_timestamp(),
  unique (protocol_version_id, position),
  check ((kind = 'product') or
    (catalog_product_stable_id is null and catalog_product_version is null
      and manufacturer is null and label_version is null and dosage_text is null
      and timing_text is null and route is null and verification_status = 'unverified')),
  check ((catalog_product_stable_id is null) = (catalog_product_version is null))
);

create index patient_protocols_patient_idx
  on clinical_core.patient_protocols(patient_record_id, updated_at desc) where deleted_at is null;
create index patient_protocol_versions_protocol_idx
  on clinical_core.patient_protocol_versions(protocol_id, version desc);
create index patient_protocol_items_catalog_idx
  on clinical_core.patient_protocol_items(catalog_product_stable_id)
  where catalog_product_stable_id is not null;

alter table clinical_core.patient_protocols enable row level security;
alter table clinical_core.patient_protocol_versions enable row level security;
alter table clinical_core.patient_protocol_phases enable row level security;
alter table clinical_core.patient_protocol_items enable row level security;
revoke all on clinical_core.patient_protocols, clinical_core.patient_protocol_versions,
  clinical_core.patient_protocol_phases, clinical_core.patient_protocol_items
  from public, clinical_core_api;

create or replace function clinical_private.protect_protocol_version_children()
returns trigger language plpgsql security definer set search_path = '' as $$
declare _version_id uuid := case when tg_op='DELETE' then old.protocol_version_id else new.protocol_version_id end;
  _status text;
begin
  select status into _status from clinical_core.patient_protocol_versions where id=_version_id;
  if _status is distinct from 'draft' then
    raise exception using errcode='55000',message='protocol_version_immutable';
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;

create trigger patient_protocol_phases_draft_only
  before insert or update or delete on clinical_core.patient_protocol_phases
  for each row execute function clinical_private.protect_protocol_version_children();
create trigger patient_protocol_items_draft_only
  before insert or update or delete on clinical_core.patient_protocol_items
  for each row execute function clinical_private.protect_protocol_version_children();

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
  'protocol.completed','protocol.discontinued','protocol.revision_created'));
alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check check (resource_type in (
  'connection','consent','lab_import','clinical_record','privacy_request','patient_profile',
  'lab_observation','biomarker_observation','lab_document','report','audit_log',
  'organization_membership','review_queue_item','appointment','encounter','clinical_note',
  'patient_protocol','patient_protocol_version'));

create or replace function clinical_private.patient_protocol_version_json(_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _version clinical_core.patient_protocol_versions%rowtype; _phases jsonb; _items jsonb;
begin
  select * into _version from clinical_core.patient_protocol_versions where id=_version_id;
  if not found then return null; end if;
  perform clinical_private.require_clinical_patient(_version.organization_id,_version.patient_record_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',phase.id,'name',phase.name,
    'position',phase.position,'startsOn',phase.starts_on,'endsOn',phase.ends_on,
    'relativeStartDay',phase.relative_start_day,'relativeDurationDays',phase.relative_duration_days,
    'notes',phase.notes) order by phase.position,phase.id),'[]'::jsonb) into _phases
    from clinical_core.patient_protocol_phases phase where phase.protocol_version_id=_version.id;
  select coalesce(jsonb_agg(jsonb_build_object('id',item.id,'phaseId',item.phase_id,
    'kind',item.kind,'position',item.position,'label',item.label,'instructions',item.instructions,
    'catalogProductId',item.catalog_product_stable_id,
    'catalogProductVersionId',case when item.catalog_product_version is null then null
      else item.catalog_product_version::text end,
    'manufacturer',item.manufacturer,'labelVersion',item.label_version,'dosageText',item.dosage_text,
    'timingText',item.timing_text,'route',item.route,'verificationStatus',item.verification_status,
    'interactionReviewState',item.interaction_review_state,'affiliateUrl',null)
    order by item.position,item.id),'[]'::jsonb) into _items
    from clinical_core.patient_protocol_items item where item.protocol_version_id=_version.id;
  return jsonb_build_object('id',_version.id,'version',_version.version,'status',_version.status,
    'title',_version.title,'summary',_version.summary,'dietInstructions',_version.diet_instructions,
    'lifestyleInstructions',_version.lifestyle_instructions,'monitoringPlan',_version.monitoring_plan,
    'followupPlan',_version.followup_plan,'sourceTemplateId',null,'sourceTemplateVersion',null,
    'supersedesVersionId',_version.supersedes_version_id,'approvedAt',_version.approved_at,
    'activatedAt',_version.activated_at,'reviewNote',_version.review_note,
    'updatedAt',_version.updated_at,'createdAt',_version.created_at,'phases',_phases,'items',_items);
end $$;

create or replace function clinical_core.get_patient_protocol(_organization_id uuid,_patient_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _protocol clinical_core.patient_protocols%rowtype; _draft uuid; _approved uuid; _history jsonb;
begin
  perform clinical_private.require_clinical_patient(_organization_id,_patient_id);
  select * into _protocol from clinical_core.patient_protocols protocol
    where protocol.organization_id=_organization_id and protocol.patient_record_id=_patient_id
      and protocol.deleted_at is null;
  if not found then return jsonb_build_object('exists',false,'canAuthor',true,'protocol',null,
    'draft',null,'approved',null,'active',null,'history','[]'::jsonb,
    'generatedAt',clock_timestamp()); end if;
  select id into _draft from clinical_core.patient_protocol_versions
    where protocol_id=_protocol.id and status='draft' order by version desc limit 1;
  select id into _approved from clinical_core.patient_protocol_versions
    where protocol_id=_protocol.id and status='approved' order by version desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id',version.id,'version',version.version,
    'status',version.status,'title',version.title,'approvedAt',version.approved_at,
    'activatedAt',version.activated_at,'createdAt',version.created_at,
    'supersedesVersionId',version.supersedes_version_id) order by version.version desc),'[]'::jsonb)
    into _history from clinical_core.patient_protocol_versions version where version.protocol_id=_protocol.id;
  return jsonb_build_object('exists',true,'canAuthor',true,'protocol',jsonb_build_object(
    'id',_protocol.id,'title',_protocol.title,'status',_protocol.status,
    'createdAt',_protocol.created_at,'updatedAt',_protocol.updated_at),
    'draft',clinical_private.patient_protocol_version_json(_draft),
    'approved',clinical_private.patient_protocol_version_json(_approved),
    'active',clinical_private.patient_protocol_version_json(_protocol.active_version_id),
    'history',_history,'generatedAt',clock_timestamp());
end $$;

create or replace function clinical_core.create_protocol_draft(
  _organization_id uuid,_patient_id uuid,_title text,_from_template_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _actor uuid; _protocol clinical_core.patient_protocols%rowtype; _version_id uuid; _next integer;
begin
  _actor:=clinical_private.require_clinical_patient(_organization_id,_patient_id);
  if _from_template_id is not null then
    raise exception using errcode='55000',message='production_protocol_templates_not_ready'; end if;
  if char_length(btrim(coalesce(_title,''))) not between 1 and 200 then
    raise exception using errcode='22023',message='protocol_title_invalid'; end if;
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
    version,status,title,created_by_person_id,updated_by_person_id)
    values(_organization_id,_protocol.id,_patient_id,_next,'draft',btrim(_title),_actor,_actor)
    returning id into _version_id;
  update clinical_core.patient_protocols set current_version_id=_version_id,title=btrim(_title),
    updated_by_person_id=_actor,updated_at=clock_timestamp() where id=_protocol.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_organization_id,_actor,
    'protocol.draft_created','patient_protocol_version',_version_id,_patient_id,
    'Protocol draft created','clinical_data',jsonb_build_object('version',_next,'from_template',false));
  return jsonb_build_object('ok',true,'protocolId',_protocol.id,'versionId',_version_id,
    'version',_next,'message','Blank protocol draft created.');
end $$;

create or replace function clinical_core.save_protocol_draft(
  _version_id uuid,_payload jsonb,_expected_updated_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _actor uuid; _version clinical_core.patient_protocol_versions%rowtype; _phase jsonb; _item jsonb;
  _phase_ids uuid[]:='{}'; _phase_id uuid; _position integer:=0; _phase_index integer;
  _saved_at timestamptz:=clock_timestamp(); _item_ids jsonb:='[]'::jsonb; _item_id uuid;
begin
  select * into _version from clinical_core.patient_protocol_versions where id=_version_id for update;
  if not found then raise exception using errcode='P0002',message='protocol_version_not_found'; end if;
  _actor:=clinical_private.require_clinical_patient(_version.organization_id,_version.patient_record_id);
  if _version.status<>'draft' then raise exception using errcode='55000',message='protocol_version_immutable'; end if;
  if _expected_updated_at is not null and date_trunc('milliseconds',_expected_updated_at)
    <> date_trunc('milliseconds',_version.updated_at) then
    raise exception using errcode='40001',message='protocol_version_conflict'; end if;
  if jsonb_typeof(_payload)<>'object' or octet_length(_payload::text)>524288
    or jsonb_typeof(coalesce(_payload->'phases','[]'::jsonb))<>'array'
    or jsonb_typeof(coalesce(_payload->'items','[]'::jsonb))<>'array'
    or jsonb_array_length(coalesce(_payload->'phases','[]'::jsonb))>24
    or jsonb_array_length(coalesce(_payload->'items','[]'::jsonb))>200
    or _payload::text ~* '"(affiliateUrl|destinationUrl|discountCode|trackingCode)"' then
    raise exception using errcode='22023',message='protocol_payload_invalid'; end if;
  if char_length(coalesce(_payload->>'title',_version.title))>200
    or char_length(coalesce(_payload->>'summary',''))>10000
    or char_length(coalesce(_payload->>'dietInstructions',''))>20000
    or char_length(coalesce(_payload->>'lifestyleInstructions',''))>20000
    or char_length(coalesce(_payload->>'monitoringPlan',''))>20000
    or char_length(coalesce(_payload->>'followupPlan',''))>20000 then
    raise exception using errcode='22023',message='protocol_payload_invalid'; end if;
  update clinical_core.patient_protocol_versions set
    title=coalesce(nullif(btrim(_payload->>'title'),''),title),summary=_payload->>'summary',
    diet_instructions=_payload->>'dietInstructions',lifestyle_instructions=_payload->>'lifestyleInstructions',
    monitoring_plan=_payload->>'monitoringPlan',followup_plan=_payload->>'followupPlan',
    updated_by_person_id=_actor,updated_at=_saved_at where id=_version.id;
  delete from clinical_core.patient_protocol_items where protocol_version_id=_version.id;
  delete from clinical_core.patient_protocol_phases where protocol_version_id=_version.id;
  for _phase in select value from jsonb_array_elements(coalesce(_payload->'phases','[]'::jsonb)) loop
    if jsonb_typeof(_phase)<>'object' or char_length(btrim(coalesce(_phase->>'name',''))) not between 1 and 120
      or char_length(coalesce(_phase->>'notes',''))>5000 then
      raise exception using errcode='22023',message='protocol_phase_invalid'; end if;
    insert into clinical_core.patient_protocol_phases(protocol_version_id,position,name,starts_on,ends_on,
      relative_start_day,relative_duration_days,notes) values(_version.id,_position,btrim(_phase->>'name'),
      nullif(_phase->>'startsOn','')::date,nullif(_phase->>'endsOn','')::date,
      nullif(_phase->>'relativeStartDay','')::integer,nullif(_phase->>'relativeDurationDays','')::integer,
      nullif(_phase->>'notes','')) returning id into _phase_id;
    _phase_ids:=_phase_ids||_phase_id; _position:=_position+1;
  end loop;
  _position:=0;
  for _item in select value from jsonb_array_elements(coalesce(_payload->'items','[]'::jsonb)) loop
    if jsonb_typeof(_item)<>'object' or (_item->>'kind') not in
      ('product','diet','lifestyle','monitoring','followup')
      or char_length(btrim(coalesce(_item->>'label',''))) not between 1 and 240
      or char_length(coalesce(_item->>'instructions',''))>10000 then
      raise exception using errcode='22023',message='protocol_item_invalid'; end if;
    _phase_index:=case when nullif(_item->>'phaseIndex','') is null then null
      else (_item->>'phaseIndex')::integer end;
    if _phase_index is not null and (_phase_index<0 or _phase_index>=coalesce(array_length(_phase_ids,1),0)) then
      raise exception using errcode='22023',message='protocol_phase_reference_invalid'; end if;
    if _item->>'kind'='product' then
      if coalesce(_item->>'catalogProductId','') !~ '^prd_[a-z0-9][a-z0-9_-]{2,95}$'
        or coalesce(_item->>'catalogProductVersionId','') !~ '^[1-9][0-9]{0,8}$' then
        raise exception using errcode='22023',message='protocol_product_identity_invalid'; end if;
    elsif coalesce(_item->>'catalogProductId',_item->>'catalogProductVersionId',
      _item->>'manufacturer',_item->>'labelVersion',_item->>'dosageText',
      _item->>'timingText',_item->>'route','')<>'' then
      raise exception using errcode='22023',message='protocol_nonproduct_identity_refused'; end if;
    insert into clinical_core.patient_protocol_items(protocol_version_id,phase_id,position,kind,label,
      instructions,catalog_product_stable_id,catalog_product_version,manufacturer,label_version,
      dosage_text,timing_text,route,verification_status,interaction_review_state)
    values(_version.id,case when _phase_index is null then null else _phase_ids[_phase_index+1] end,
      _position,_item->>'kind',btrim(_item->>'label'),nullif(_item->>'instructions',''),
      case when _item->>'kind'='product' then _item->>'catalogProductId' else null end,
      case when _item->>'kind'='product' then (_item->>'catalogProductVersionId')::integer else null end,
      case when _item->>'kind'='product' then nullif(_item->>'manufacturer','') else null end,
      case when _item->>'kind'='product' then nullif(_item->>'labelVersion','') else null end,
      case when _item->>'kind'='product' then nullif(_item->>'dosageText','') else null end,
      case when _item->>'kind'='product' then nullif(_item->>'timingText','') else null end,
      case when _item->>'kind'='product' then nullif(_item->>'route','') else null end,
      'unverified','not_completed') returning id into _item_id;
    _item_ids:=_item_ids||to_jsonb(_item_id); _position:=_position+1;
  end loop;
  update clinical_core.patient_protocols set title=coalesce(nullif(btrim(_payload->>'title'),''),title),
    updated_by_person_id=_actor,updated_at=_saved_at where id=_version.protocol_id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_version.organization_id,_actor,
    'protocol.draft_saved','patient_protocol_version',_version.id,_version.patient_record_id,
    'Protocol draft saved','clinical_data',jsonb_build_object('version',_version.version,
      'phase_count',coalesce(array_length(_phase_ids,1),0),'item_count',_position));
  return jsonb_build_object('ok',true,'versionId',_version.id,'updatedAt',_saved_at,
    'itemIds',_item_ids,'message','Draft saved.');
end $$;

create or replace function clinical_core.approve_protocol_version(_version_id uuid,_review_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _actor uuid; _version clinical_core.patient_protocol_versions%rowtype;
begin
  select * into _version from clinical_core.patient_protocol_versions where id=_version_id for update;
  if not found then raise exception using errcode='P0002',message='protocol_version_not_found'; end if;
  _actor:=clinical_private.require_clinical_patient(_version.organization_id,_version.patient_record_id);
  if _version.status<>'draft' then raise exception using errcode='55000',message='protocol_version_not_draft'; end if;
  if not exists(select 1 from clinical_core.patient_protocol_items where protocol_version_id=_version.id) then
    raise exception using errcode='22023',message='protocol_empty'; end if;
  -- Product verification is never accepted from the client. Until the governed
  -- production catalog integration writes server-verified evidence, product
  -- protocols stay drafts. Non-product clinical plans can proceed.
  if exists(select 1 from clinical_core.patient_protocol_items
    where protocol_version_id=_version.id and kind='product') then
    raise exception using errcode='55000',message='governed_product_review_required'; end if;
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

create or replace function clinical_core.activate_protocol_version(_version_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _actor uuid; _version clinical_core.patient_protocol_versions%rowtype; _previous uuid;
begin
  select * into _version from clinical_core.patient_protocol_versions where id=_version_id for update;
  if not found then raise exception using errcode='P0002',message='protocol_version_not_found'; end if;
  _actor:=clinical_private.require_clinical_patient(_version.organization_id,_version.patient_record_id);
  if _version.status<>'approved' then raise exception using errcode='55000',message='protocol_version_not_approved'; end if;
  select active_version_id into _previous from clinical_core.patient_protocols where id=_version.protocol_id for update;
  if _previous is not null and _previous<>_version.id then
    update clinical_core.patient_protocol_versions set status='superseded',
      updated_by_person_id=_actor,updated_at=clock_timestamp() where id=_previous; end if;
  update clinical_core.patient_protocol_versions set status='active',activated_by_person_id=_actor,
    activated_at=clock_timestamp(),updated_by_person_id=_actor,updated_at=clock_timestamp()
    where id=_version.id;
  update clinical_core.patient_protocols set status='active',active_version_id=_version.id,
    current_version_id=_version.id,updated_by_person_id=_actor,updated_at=clock_timestamp()
    where id=_version.protocol_id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_version.organization_id,_actor,
    'protocol.activated','patient_protocol_version',_version.id,_version.patient_record_id,
    'Protocol version activated','clinical_data',jsonb_build_object('version',_version.version,
      'superseded_version_present',_previous is not null));
  return jsonb_build_object('ok',true,'versionId',_version.id,'status','active',
    'message','Version activated. No orders, messages, charges, or note entries were created.');
end $$;

create or replace function clinical_core.set_protocol_lifecycle(_protocol_id uuid,_status text,_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _actor uuid; _protocol clinical_core.patient_protocols%rowtype;
begin
  select * into _protocol from clinical_core.patient_protocols where id=_protocol_id and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='protocol_not_found'; end if;
  _actor:=clinical_private.require_clinical_patient(_protocol.organization_id,_protocol.patient_record_id);
  if _status not in ('active','paused','completed','discontinued')
    or char_length(coalesce(_reason,''))>1000 then
    raise exception using errcode='22023',message='protocol_lifecycle_invalid'; end if;
  if _protocol.status=_status then return jsonb_build_object('ok',true,'status',_status,
    'alreadySet',true,'message','Protocol already in that state.'); end if;
  if _protocol.status in ('completed','discontinued') or
    (_status in ('active','paused','completed') and _protocol.active_version_id is null) then
    raise exception using errcode='55000',message='protocol_lifecycle_refused'; end if;
  update clinical_core.patient_protocols set status=_status,updated_by_person_id=_actor,
    updated_at=clock_timestamp() where id=_protocol.id;
  if _status='discontinued' and _protocol.active_version_id is not null then
    update clinical_core.patient_protocol_versions set status='discontinued',
      updated_by_person_id=_actor,updated_at=clock_timestamp() where id=_protocol.active_version_id; end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_protocol.organization_id,_actor,
    'protocol.'||_status,'patient_protocol',_protocol.id,_protocol.patient_record_id,
    'Protocol '||_status,'clinical_data',jsonb_build_object('previous_status',_protocol.status,
      'reason_present',nullif(btrim(_reason),'') is not null));
  return jsonb_build_object('ok',true,'status',_status,'alreadySet',false,
    'message','Protocol '||_status||'.');
end $$;

create or replace function clinical_core.revise_protocol_version(_version_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _actor uuid; _source clinical_core.patient_protocol_versions%rowtype; _next integer; _new_id uuid;
  _phase record; _phase_map jsonb:='{}'::jsonb; _new_phase uuid;
begin
  select * into _source from clinical_core.patient_protocol_versions where id=_version_id;
  if not found then raise exception using errcode='P0002',message='protocol_version_not_found'; end if;
  _actor:=clinical_private.require_clinical_patient(_source.organization_id,_source.patient_record_id);
  if _source.status not in ('approved','active') then
    raise exception using errcode='55000',message='protocol_version_not_revisable'; end if;
  if exists(select 1 from clinical_core.patient_protocol_versions
    where protocol_id=_source.protocol_id and status='draft') then
    raise exception using errcode='55000',message='protocol_draft_exists'; end if;
  select coalesce(max(version),0)+1 into _next from clinical_core.patient_protocol_versions
    where protocol_id=_source.protocol_id;
  insert into clinical_core.patient_protocol_versions(organization_id,protocol_id,patient_record_id,
    version,status,title,summary,diet_instructions,lifestyle_instructions,monitoring_plan,followup_plan,
    supersedes_version_id,created_by_person_id,updated_by_person_id)
    values(_source.organization_id,_source.protocol_id,_source.patient_record_id,_next,'draft',_source.title,
      _source.summary,_source.diet_instructions,_source.lifestyle_instructions,_source.monitoring_plan,
      _source.followup_plan,_source.id,_actor,_actor) returning id into _new_id;
  for _phase in select * from clinical_core.patient_protocol_phases
    where protocol_version_id=_source.id order by position,id loop
    insert into clinical_core.patient_protocol_phases(protocol_version_id,position,name,starts_on,ends_on,
      relative_start_day,relative_duration_days,notes) values(_new_id,_phase.position,_phase.name,
      _phase.starts_on,_phase.ends_on,_phase.relative_start_day,_phase.relative_duration_days,_phase.notes)
      returning id into _new_phase;
    _phase_map:=jsonb_set(_phase_map,array[_phase.id::text],to_jsonb(_new_phase));
  end loop;
  insert into clinical_core.patient_protocol_items(protocol_version_id,phase_id,position,kind,label,
    instructions,catalog_product_stable_id,catalog_product_version,manufacturer,label_version,
    dosage_text,timing_text,route,verification_status,interaction_review_state)
    select _new_id,case when item.phase_id is null then null else (_phase_map->>item.phase_id::text)::uuid end,
      item.position,item.kind,item.label,item.instructions,item.catalog_product_stable_id,
      item.catalog_product_version,item.manufacturer,item.label_version,item.dosage_text,item.timing_text,
      item.route,'unverified','not_completed' from clinical_core.patient_protocol_items item
      where item.protocol_version_id=_source.id;
  update clinical_core.patient_protocols set current_version_id=_new_id,
    updated_by_person_id=_actor,updated_at=clock_timestamp() where id=_source.protocol_id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_source.organization_id,_actor,
    'protocol.revision_created','patient_protocol_version',_new_id,_source.patient_record_id,
    'Protocol revision draft created','clinical_data',jsonb_build_object('version',_next));
  return jsonb_build_object('ok',true,'protocolId',_source.protocol_id,'versionId',_new_id,
    'version',_next,'supersedesVersionId',_source.id,'message','Revision draft created.');
end $$;

revoke all on function clinical_private.protect_protocol_version_children(),
  clinical_private.patient_protocol_version_json(uuid) from public;
grant execute on function clinical_private.protect_protocol_version_children(),
  clinical_private.patient_protocol_version_json(uuid) to clinical_core_api;
revoke all on function clinical_core.get_patient_protocol(uuid,uuid),
  clinical_core.create_protocol_draft(uuid,uuid,text,uuid),
  clinical_core.save_protocol_draft(uuid,jsonb,timestamptz),
  clinical_core.approve_protocol_version(uuid,text),
  clinical_core.activate_protocol_version(uuid),
  clinical_core.set_protocol_lifecycle(uuid,text,text),
  clinical_core.revise_protocol_version(uuid) from public;
grant execute on function clinical_core.get_patient_protocol(uuid,uuid),
  clinical_core.create_protocol_draft(uuid,uuid,text,uuid),
  clinical_core.save_protocol_draft(uuid,jsonb,timestamptz),
  clinical_core.approve_protocol_version(uuid,text),
  clinical_core.activate_protocol_version(uuid),
  clinical_core.set_protocol_lifecycle(uuid,text,text),
  clinical_core.revise_protocol_version(uuid) to clinical_core_api;
