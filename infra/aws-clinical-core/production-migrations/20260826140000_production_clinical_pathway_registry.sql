-- AWS-native clinical pathway authoring and approval registry. This migration
-- creates no pathways, imports no catalog content, records no approval, and
-- does not enable the production API or PHI routing.

create table clinical_core.clinical_pathways (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  code text not null check (code ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  domain_code text not null check (domain_code ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  description text not null default '' check (char_length(description) <= 10000),
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  retired_by_person_id uuid references clinical_core.persons(id),
  retired_at timestamptz,
  unique (organization_id,code),
  unique (id,organization_id),
  check ((retired_at is null)=(retired_by_person_id is null))
);

create table clinical_core.clinical_pathway_versions (
  id uuid primary key default gen_random_uuid(),
  pathway_id uuid not null,
  organization_id uuid not null references clinical_core.organizations(id),
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft','approved','superseded','retired')),
  content jsonb not null check (
    jsonb_typeof(content)='object'
    and jsonb_typeof(coalesce(content->'differentiatingQuestions','[]'::jsonb))='array'
    and jsonb_typeof(coalesce(content->'labStrategy','[]'::jsonb))='array'
    and jsonb_typeof(coalesce(content->'productCandidates','[]'::jsonb))='array'
    and jsonb_typeof(coalesce(content->'nutrition','[]'::jsonb))='array'
    and jsonb_typeof(coalesce(content->'lifestyle','[]'::jsonb))='array'
    and jsonb_typeof(coalesce(content->'safetyStops','[]'::jsonb))='array'
    and octet_length(content::text) <= 524288
    and content::text !~* '"(affiliateUrl|destinationUrl|discountCode|trackingCode)"'
  ),
  source_refs jsonb not null default '[]'::jsonb check (
    jsonb_typeof(source_refs)='array'
    and jsonb_array_length(source_refs) <= 100
    and octet_length(source_refs::text) <= 131072
  ),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  change_summary text check (change_summary is null or char_length(change_summary) <= 2000),
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  approved_by_person_id uuid references clinical_core.persons(id),
  approved_at timestamptz,
  superseded_by_version_id uuid references clinical_core.clinical_pathway_versions(id),
  retired_by_person_id uuid references clinical_core.persons(id),
  retired_at timestamptz,
  foreign key (pathway_id,organization_id)
    references clinical_core.clinical_pathways(id,organization_id),
  unique (pathway_id,version),
  unique (id,organization_id),
  check (
    (status='draft' and approved_at is null and approved_by_person_id is null)
    or (status in ('approved','superseded') and approved_at is not null and approved_by_person_id is not null)
    or status='retired'
  )
);

create unique index clinical_pathway_one_approved_idx
  on clinical_core.clinical_pathway_versions(pathway_id) where status='approved';
create index clinical_pathways_org_idx
  on clinical_core.clinical_pathways(organization_id,name,id) where retired_at is null;
create index clinical_pathway_versions_path_idx
  on clinical_core.clinical_pathway_versions(pathway_id,version desc);

alter table clinical_core.clinical_pathways enable row level security;
alter table clinical_core.clinical_pathway_versions enable row level security;
revoke all on clinical_core.clinical_pathways,clinical_core.clinical_pathway_versions
  from public,clinical_core_api;

create or replace function clinical_private.protect_clinical_pathway()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    raise exception using errcode='55000',message='clinical_pathway_delete_refused';
  end if;
  if new.organization_id<>old.organization_id or new.code<>old.code
    or new.created_by_person_id<>old.created_by_person_id or new.created_at<>old.created_at then
    raise exception using errcode='55000',message='clinical_pathway_identity_immutable';
  end if;
  return new;
end $$;

create trigger clinical_pathways_protected
  before update or delete on clinical_core.clinical_pathways
  for each row execute function clinical_private.protect_clinical_pathway();

create or replace function clinical_private.protect_clinical_pathway_version()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    raise exception using errcode='55000',message='clinical_pathway_version_append_only';
  end if;
  if old.status<>'draft' and not (
    old.status='approved' and new.status='superseded'
    and new.superseded_by_version_id is not null
    and (to_jsonb(new)-'status'-'superseded_by_version_id')
      =(to_jsonb(old)-'status'-'superseded_by_version_id')
  ) then
    raise exception using errcode='55000',message='approved_clinical_pathway_immutable';
  end if;
  if old.status='draft' and new.status='approved' and (
    new.content<>old.content or new.source_refs<>old.source_refs
    or new.content_sha256<>old.content_sha256 or new.version<>old.version
    or new.pathway_id<>old.pathway_id or new.organization_id<>old.organization_id
  ) then
    raise exception using errcode='55000',message='clinical_pathway_approval_content_changed';
  end if;
  return new;
end $$;

create trigger clinical_pathway_versions_protected
  before update or delete on clinical_core.clinical_pathway_versions
  for each row execute function clinical_private.protect_clinical_pathway_version();

create or replace function clinical_private.require_knowledge_editor(_organization_id uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare _actor uuid;
begin
  perform clinical_private.assert_production_context(_organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode='42501',message='knowledge_editor_role_required';
  end if;
  _actor:=clinical_private.actor_person_id();
  return _actor;
end $$;

create or replace function clinical_private.require_knowledge_admin(_organization_id uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id();
begin
  perform clinical_private.assert_production_context(_organization_id,'clinical_data','workforce');
  if not exists(select 1 from clinical_core.organization_memberships membership
    where membership.organization_id=_organization_id and membership.person_id=_actor
      and membership.status='active' and membership.role in ('owner','admin')) then
    raise exception using errcode='42501',message='knowledge_admin_role_required';
  end if;
  return _actor;
end $$;

create or replace function clinical_core.list_clinical_pathways(_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.require_knowledge_editor(_organization_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',pathway.id,'organization_id',pathway.organization_id,'code',pathway.code,
    'name',pathway.name,'domain_code',pathway.domain_code,'description',pathway.description,
    'retired_at',pathway.retired_at,'clinical_pathway_versions',coalesce((select jsonb_agg(
      jsonb_build_object('id',version.id,'version',version.version,'status',version.status,
        'content',version.content,'source_refs',version.source_refs,
        'change_summary',version.change_summary,'created_at',version.created_at,
        'approved_at',version.approved_at) order by version.version desc)
      from clinical_core.clinical_pathway_versions version
      where version.pathway_id=pathway.id),'[]'::jsonb)) order by pathway.name,pathway.id)
    from clinical_core.clinical_pathways pathway
    where pathway.organization_id=_organization_id and pathway.retired_at is null),'[]'::jsonb);
end $$;

create or replace function clinical_core.create_clinical_pathway_draft(
  _pathway_id uuid,_content jsonb,_source_refs jsonb default '[]'::jsonb,
  _change_summary text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _pathway clinical_core.clinical_pathways%rowtype; _actor uuid;
  _version integer; _version_id uuid; _sha text;
begin
  select * into _pathway from clinical_core.clinical_pathways
    where id=_pathway_id and retired_at is null for update;
  if not found then raise exception using errcode='P0002',message='clinical_pathway_not_found'; end if;
  _actor:=clinical_private.require_knowledge_editor(_pathway.organization_id);
  if jsonb_typeof(_content)<>'object' or jsonb_typeof(_source_refs)<>'array'
    or octet_length(_content::text)>524288 or octet_length(_source_refs::text)>131072
    or jsonb_array_length(_source_refs)>100
    or _content::text ~* '"(affiliateUrl|destinationUrl|discountCode|trackingCode)"'
    or char_length(coalesce(_change_summary,''))>2000 then
    raise exception using errcode='22023',message='clinical_pathway_content_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(_pathway_id::text,0));
  select coalesce(max(version),0)+1 into _version
    from clinical_core.clinical_pathway_versions where pathway_id=_pathway_id;
  _sha:=pg_catalog.encode(public.digest(pg_catalog.convert_to(_content::text,'UTF8'),'sha256'),'hex');
  insert into clinical_core.clinical_pathway_versions(pathway_id,organization_id,version,status,
    content,source_refs,content_sha256,change_summary,created_by_person_id)
    values(_pathway_id,_pathway.organization_id,_version,'draft',_content,_source_refs,_sha,
      nullif(btrim(_change_summary),''),_actor) returning id into _version_id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_pathway.organization_id,_actor,
    'knowledge.pathway_draft_created','clinical_pathway_version',_version_id,
    'Clinical pathway draft created','clinical_data',jsonb_build_object('version',_version));
  return jsonb_build_object('versionId',_version_id,'version',_version);
end $$;

create or replace function clinical_core.update_clinical_pathway_draft(
  _version_id uuid,_content jsonb,_source_refs jsonb default '[]'::jsonb,
  _change_summary text default null
) returns void language plpgsql security definer set search_path='' as $$
declare _version clinical_core.clinical_pathway_versions%rowtype; _actor uuid; _sha text;
begin
  select * into _version from clinical_core.clinical_pathway_versions where id=_version_id for update;
  if not found then raise exception using errcode='P0002',message='clinical_pathway_version_not_found'; end if;
  _actor:=clinical_private.require_knowledge_editor(_version.organization_id);
  if _version.status<>'draft' then
    raise exception using errcode='55000',message='clinical_pathway_version_not_draft'; end if;
  if jsonb_typeof(_content)<>'object' or jsonb_typeof(_source_refs)<>'array'
    or octet_length(_content::text)>524288 or octet_length(_source_refs::text)>131072
    or jsonb_array_length(_source_refs)>100
    or _content::text ~* '"(affiliateUrl|destinationUrl|discountCode|trackingCode)"'
    or char_length(coalesce(_change_summary,''))>2000 then
    raise exception using errcode='22023',message='clinical_pathway_content_invalid';
  end if;
  _sha:=pg_catalog.encode(public.digest(pg_catalog.convert_to(_content::text,'UTF8'),'sha256'),'hex');
  update clinical_core.clinical_pathway_versions set content=_content,source_refs=_source_refs,
    content_sha256=_sha,change_summary=nullif(btrim(_change_summary),'') where id=_version_id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_version.organization_id,_actor,
    'knowledge.pathway_draft_updated','clinical_pathway_version',_version_id,
    'Clinical pathway draft updated','clinical_data',jsonb_build_object('version',_version.version));
end $$;

create or replace function clinical_core.approve_clinical_pathway_version(_version_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare _version clinical_core.clinical_pathway_versions%rowtype; _actor uuid;
begin
  select * into _version from clinical_core.clinical_pathway_versions where id=_version_id for update;
  if not found then raise exception using errcode='P0002',message='clinical_pathway_version_not_found'; end if;
  _actor:=clinical_private.require_knowledge_admin(_version.organization_id);
  if _version.status<>'draft' then
    raise exception using errcode='55000',message='clinical_pathway_version_not_draft'; end if;
  if jsonb_array_length(_version.source_refs)=0 then
    raise exception using errcode='55000',message='clinical_pathway_source_review_required'; end if;
  update clinical_core.clinical_pathway_versions set status='superseded',
    superseded_by_version_id=_version_id
    where pathway_id=_version.pathway_id and status='approved';
  update clinical_core.clinical_pathway_versions set status='approved',
    approved_at=clock_timestamp(),approved_by_person_id=_actor where id=_version_id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    safe_message,purpose,safe_metadata) values(_version.organization_id,_actor,
    'knowledge.pathway_approved','clinical_pathway_version',_version_id,
    'Clinical pathway version approved','clinical_data',jsonb_build_object('version',_version.version));
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
  'knowledge.pathway_draft_created','knowledge.pathway_draft_updated','knowledge.pathway_approved'));

alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check check(resource_type in(
  'connection','consent','lab_import','clinical_record','privacy_request','patient_profile','lab_observation',
  'biomarker_observation','lab_document','report','audit_log','organization_membership','review_queue_item',
  'appointment','encounter','clinical_note','patient_protocol','patient_protocol_version',
  'sync_outbound_event','sync_inbound_event','sync_inbound_correction','sync_conflict','sync_provider',
  'protocol_item','protocol_template','protocol_template_version','clinical_pathway',
  'clinical_pathway_version','clinical_hypothesis','differential_question','lens_evaluation'));

revoke all on function clinical_core.list_clinical_pathways(uuid) from public;
revoke all on function clinical_core.create_clinical_pathway_draft(uuid,jsonb,jsonb,text) from public;
revoke all on function clinical_core.update_clinical_pathway_draft(uuid,jsonb,jsonb,text) from public;
revoke all on function clinical_core.approve_clinical_pathway_version(uuid) from public;

grant execute on function clinical_core.list_clinical_pathways(uuid) to clinical_core_api;
grant execute on function clinical_core.create_clinical_pathway_draft(uuid,jsonb,jsonb,text) to clinical_core_api;
grant execute on function clinical_core.update_clinical_pathway_draft(uuid,jsonb,jsonb,text) to clinical_core_api;
grant execute on function clinical_core.approve_clinical_pathway_version(uuid) to clinical_core_api;
