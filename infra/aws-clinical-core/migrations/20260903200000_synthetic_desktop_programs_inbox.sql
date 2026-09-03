-- Synthetic-only AWS storage for the Desktop Programs and Inbox workspaces.
-- No rows are seeded. External message delivery remains fail-closed.

create table clinical_core.synthetic_desktop_activity_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  actor_person_id uuid not null references clinical_core.persons(id),
  action text not null check (action in (
    'program.created','program.saved','program.status_changed','program.archived',
    'conversation.created','message.draft_saved','message.draft_cancelled',
    'conversation.workflow_changed','conversation.read','message.send_refused')),
  resource_type text not null check (resource_type in ('program','program_version','conversation','message')),
  resource_id uuid not null,
  safe_metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(safe_metadata) = 'object'
    and not (safe_metadata ?| array['content','body','subject','patient_name'])),
  occurred_at timestamptz not null default clock_timestamp()
);

create table clinical_core.synthetic_desktop_programs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text check (description is null or char_length(description) <= 2000),
  status text not null default 'draft' check (status in ('draft','published','archived')),
  published_version_id uuid,
  archived_at timestamptz,
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, organization_id)
);

create table clinical_core.synthetic_desktop_program_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  program_id uuid not null,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft','in_review','approved','published','superseded')),
  content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  review_note text check (review_note is null or char_length(review_note) <= 2000),
  supersedes_version_id uuid references clinical_core.synthetic_desktop_program_versions(id),
  approved_at timestamptz,
  published_at timestamptz,
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (program_id, organization_id)
    references clinical_core.synthetic_desktop_programs(id, organization_id),
  unique (program_id, version),
  unique (id, organization_id)
);

alter table clinical_core.synthetic_desktop_programs
  add constraint synthetic_desktop_programs_published_version_fk
  foreign key (published_version_id) references clinical_core.synthetic_desktop_program_versions(id);

create table clinical_core.synthetic_desktop_program_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text check (description is null or char_length(description) <= 2000),
  status text not null default 'draft' check (status in ('draft','approved','archived')),
  content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  approved_version_id uuid,
  approved_version integer,
  archived_at timestamptz,
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, organization_id)
);

create table clinical_core.synthetic_desktop_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  subject text not null check (char_length(btrim(subject)) between 1 and 300),
  category text not null check (category in (
    'general','clinical_question','refill','lab','wearable_alert','scheduling','billing',
    'program_check_in','protocol_adherence','administrative')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','snoozed','resolved')),
  assigned_queue text not null default 'practitioner' check (assigned_queue in ('practitioner','staff')),
  assigned_person_id uuid references clinical_core.persons(id),
  follow_up_at timestamptz,
  snoozed_until timestamptz,
  version integer not null default 1 check (version > 0),
  last_message_at timestamptz,
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, organization_id),
  foreign key (patient_record_id, organization_id)
    references clinical_core.patient_records(id, organization_id)
);

create table clinical_core.synthetic_desktop_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  conversation_id uuid not null references clinical_core.synthetic_desktop_conversations(id),
  sender_person_id uuid references clinical_core.persons(id),
  body text not null check (char_length(body) between 1 and 65536),
  status text not null default 'draft' check (status in ('draft','inbound','cancelled')),
  channel text not null default 'alp_in_app' check (channel in ('in_app','alp_in_app','email','sms','push')),
  version integer not null default 1 check (version > 0),
  read_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, organization_id)
);

create table clinical_core.synthetic_desktop_conversation_reads (
  organization_id uuid not null references clinical_core.organizations(id),
  conversation_id uuid not null references clinical_core.synthetic_desktop_conversations(id),
  person_id uuid not null references clinical_core.persons(id),
  last_read_at timestamptz not null default clock_timestamp(),
  primary key (conversation_id, person_id)
);

create index synthetic_desktop_programs_org_idx
  on clinical_core.synthetic_desktop_programs(organization_id, updated_at desc);
create index synthetic_desktop_conversations_org_idx
  on clinical_core.synthetic_desktop_conversations(organization_id, updated_at desc);
create index synthetic_desktop_messages_conversation_idx
  on clinical_core.synthetic_desktop_messages(conversation_id, created_at);

do $$
declare _table text;
begin
  foreach _table in array array[
    'synthetic_desktop_activity_audit','synthetic_desktop_programs',
    'synthetic_desktop_program_versions','synthetic_desktop_program_templates',
    'synthetic_desktop_conversations','synthetic_desktop_messages',
    'synthetic_desktop_conversation_reads'
  ] loop
    execute format('alter table clinical_core.%I enable row level security', _table);
    execute format('revoke all on clinical_core.%I from public, clinical_core_api', _table);
  end loop;
end $$;

create trigger synthetic_desktop_activity_audit_append_only
  before update or delete on clinical_core.synthetic_desktop_activity_audit
  for each row execute function clinical_private.block_update_delete();

create or replace function clinical_private.has_program_author_role(_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from clinical_core.organization_memberships membership
    where membership.organization_id = _organization_id
      and membership.person_id = clinical_private.actor_person_id()
      and membership.status = 'active'
      and membership.role in ('owner','admin','practitioner'))
$$;

create or replace function clinical_private.has_inbox_role(_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from clinical_core.organization_memberships membership
    where membership.organization_id = _organization_id
      and membership.person_id = clinical_private.actor_person_id()
      and membership.status = 'active'
      and membership.role in ('owner','admin','practitioner','staff'))
$$;

create or replace function clinical_private.synthetic_stable_uuid(_seed text)
returns uuid language sql immutable security invoker set search_path = '' as $$
  select (substr(md5(_seed),1,8)||'-'||substr(md5(_seed),9,4)||'-4'||
    substr(md5(_seed),14,3)||'-8'||substr(md5(_seed),18,3)||'-'||substr(md5(_seed),21,12))::uuid
$$;

create or replace function clinical_private.synthetic_program_modules(_version_id uuid, _content jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _modules jsonb := '[]'::jsonb; _lessons jsonb; _blocks jsonb;
  _module jsonb; _lesson jsonb; _block jsonb; _mi bigint; _li bigint; _bi bigint;
begin
  for _module, _mi in
    select value, ordinality from jsonb_array_elements(coalesce(_content->'modules','[]'::jsonb)) with ordinality
  loop
    _lessons := '[]'::jsonb;
    for _lesson, _li in
      select value, ordinality from jsonb_array_elements(coalesce(_module->'lessons','[]'::jsonb)) with ordinality
    loop
      _blocks := '[]'::jsonb;
      for _block, _bi in
        select value, ordinality from jsonb_array_elements(coalesce(_lesson->'blocks','[]'::jsonb)) with ordinality
      loop
        _blocks := _blocks || jsonb_build_array(jsonb_build_object(
          'id', clinical_private.synthetic_stable_uuid(_version_id||':m:'||_mi||':l:'||_li||':b:'||_bi),
          'kind', _block->>'kind', 'title', nullif(_block->>'title',''),
          'content', coalesce(_block->'content','{}'::jsonb),
          'isCommercial', coalesce((_block->>'isCommercial')::boolean,false),
          'position', _bi - 1));
      end loop;
      _lessons := _lessons || jsonb_build_array(jsonb_build_object(
        'id', clinical_private.synthetic_stable_uuid(_version_id||':m:'||_mi||':l:'||_li),
        'title', coalesce(_lesson->>'title',''), 'summary', nullif(_lesson->>'summary',''),
        'position', _li - 1, 'blocks', _blocks));
    end loop;
    _modules := _modules || jsonb_build_array(jsonb_build_object(
      'id', clinical_private.synthetic_stable_uuid(_version_id||':m:'||_mi),
      'name', coalesce(_module->>'name',''), 'summary', nullif(_module->>'summary',''),
      'position', _mi - 1, 'lessons', _lessons));
  end loop;
  return _modules;
end $$;

create or replace function clinical_private.synthetic_program_version_detail(_version_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id',version_row.id,'version',version_row.version,'status',version_row.status,
    'title',nullif(version_row.content->>'title',''),
    'summary',nullif(version_row.content->>'summary',''),
    'audience',nullif(version_row.content->>'audience',''),
    'disclaimer',nullif(version_row.content->>'disclaimer',''),
    'sourceTemplateId',null,'sourceTemplateVersion',null,
    'supersedesVersionId',version_row.supersedes_version_id,
    'reviewNote',version_row.review_note,'approvedAt',version_row.approved_at,
    'publishedAt',version_row.published_at,'updatedAt',version_row.updated_at,
    'createdAt',version_row.created_at,
    'modules',clinical_private.synthetic_program_modules(version_row.id,version_row.content))
  from clinical_core.synthetic_desktop_program_versions version_row
  where version_row.id = _version_id
$$;

create or replace function clinical_compatibility.synthetic_programs_v1(_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _operation text; _args jsonb; _org uuid := clinical_private.organization_id();
  _actor uuid := clinical_private.actor_person_id(); _id uuid; _version_id uuid;
  _program clinical_core.synthetic_desktop_programs%rowtype;
  _version clinical_core.synthetic_desktop_program_versions%rowtype;
  _content jsonb; _now timestamptz; _next integer;
begin
  perform clinical_private.assert_synthetic_context(_org,'clinical_data','workforce');
  if not clinical_private.has_program_author_role(_org) then
    raise exception using errcode='42501',message='program_author_role_required';
  end if;
  if jsonb_typeof(_request) <> 'object' or _request->>'kind' is distinct from 'rpc'
    or jsonb_typeof(_request->'args') <> 'object'
    or (select count(*) from jsonb_object_keys(_request)) <> 3 then
    raise exception using errcode='22023',message='program_request_invalid';
  end if;
  _operation := _request->>'functionName'; _args := _request->'args';
  if _args ? '_organization_id' and (_args->>'_organization_id')::uuid <> _org then
    raise exception using errcode='42501',message='program_tenant_refused';
  end if;

  if _operation = 'list_programs' then
    if (select count(*) from jsonb_object_keys(_args)) <> 4
      or not (_args ?& array['_organization_id','_query','_status','_limit']) then
      raise exception using errcode='22023',message='program_request_invalid'; end if;
    return jsonb_build_object('programs',coalesce((select jsonb_agg(item order by item->>'updatedAt' desc)
      from (select jsonb_build_object(
        'id',program.id,'name',program.name,'description',program.description,'status',program.status,
        'archivedAt',program.archived_at,'updatedAt',program.updated_at,
        'publishedVersion',(select version from clinical_core.synthetic_desktop_program_versions
          where id=program.published_version_id),
        'draftStatus',(select status from clinical_core.synthetic_desktop_program_versions
          where program_id=program.id and status in ('draft','in_review','approved') order by version desc limit 1),
        'enrollment',jsonb_build_object('invited',0,'active',0,'paused',0,'completed',0)) item
      from clinical_core.synthetic_desktop_programs program
      where program.organization_id=_org
        and (nullif(_args->>'_status','') is null or program.status=_args->>'_status')
        and (nullif(_args->>'_query','') is null or program.name ilike '%'||(_args->>'_query')||'%'
          or coalesce(program.description,'') ilike '%'||(_args->>'_query')||'%')
      order by program.updated_at desc limit least(greatest(coalesce((_args->>'_limit')::integer,50),1),500)) visible),'[]'::jsonb),
      'generatedAt',clock_timestamp());
  elsif _operation = 'list_program_templates' then
    if (select count(*) from jsonb_object_keys(_args)) <> 2
      or not (_args ?& array['_organization_id','_include_archived']) then
      raise exception using errcode='22023',message='program_request_invalid'; end if;
    return coalesce((select jsonb_agg(jsonb_build_object(
      'id',template.id,'name',template.name,'description',template.description,'status',template.status,
      'archivedAt',template.archived_at,'approvedVersionId',template.approved_version_id,
      'approvedVersion',template.approved_version,'currentVersionId',template.approved_version_id,
      'updatedAt',template.updated_at) order by template.name)
      from clinical_core.synthetic_desktop_program_templates template
      where template.organization_id=_org and
        (coalesce((_args->>'_include_archived')::boolean,false) or template.status<>'archived')),'[]'::jsonb);
  elsif _operation = 'create_program' then
    if (select count(*) from jsonb_object_keys(_args)) <> 3
      or not (_args ?& array['_organization_id','_name','_from_template_id'])
      or char_length(btrim(coalesce(_args->>'_name',''))) not between 1 and 200 then
      raise exception using errcode='22023',message='program_request_invalid'; end if;
    _content := jsonb_build_object('title',btrim(_args->>'_name'),'summary',null,'audience',null,
      'disclaimer',null,'modules','[]'::jsonb);
    if nullif(_args->>'_from_template_id','') is not null then
      select content into _content from clinical_core.synthetic_desktop_program_templates
      where id=(_args->>'_from_template_id')::uuid and organization_id=_org and status='approved';
      if not found then raise exception using errcode='P0002',message='approved_program_template_not_found'; end if;
    end if;
    insert into clinical_core.synthetic_desktop_programs(organization_id,name,created_by_person_id)
      values(_org,btrim(_args->>'_name'),_actor) returning id into _id;
    insert into clinical_core.synthetic_desktop_program_versions(
      organization_id,program_id,version,content,created_by_person_id)
      values(_org,_id,1,_content,_actor) returning id into _version_id;
    insert into clinical_core.synthetic_desktop_activity_audit(
      organization_id,actor_person_id,action,resource_type,resource_id,safe_metadata)
      values(_org,_actor,'program.created','program',_id,jsonb_build_object('version',1));
    return jsonb_build_object('ok',true,'message','Program created.','programId',_id,
      'versionId',_version_id,'version',1,'status','draft');
  elsif _operation = 'get_program_studio' then
    if (select count(*) from jsonb_object_keys(_args)) <> 1 or not (_args ? '_program_id') then
      raise exception using errcode='22023',message='program_request_invalid'; end if;
    select * into _program from clinical_core.synthetic_desktop_programs
      where id=(_args->>'_program_id')::uuid and organization_id=_org;
    if not found then raise exception using errcode='P0002',message='program_not_found'; end if;
    return jsonb_build_object(
      'program',jsonb_build_object('id',_program.id,'name',_program.name,
        'description',_program.description,'status',_program.status,'archivedAt',_program.archived_at,
        'updatedAt',_program.updated_at,'publishedVersionId',_program.published_version_id),
      'canAuthor',true,
      'editable',(select clinical_private.synthetic_program_version_detail(id)
        from clinical_core.synthetic_desktop_program_versions where program_id=_program.id
          and status in ('draft','in_review') order by version desc limit 1),
      'published',(select clinical_private.synthetic_program_version_detail(id)
        from clinical_core.synthetic_desktop_program_versions where id=_program.published_version_id),
      'history',coalesce((select jsonb_agg(jsonb_build_object(
        'id',v.id,'version',v.version,'status',v.status,'title',nullif(v.content->>'title',''),
        'approvedAt',v.approved_at,'publishedAt',v.published_at,'createdAt',v.created_at,
        'supersedesVersionId',v.supersedes_version_id) order by v.version desc)
        from clinical_core.synthetic_desktop_program_versions v where v.program_id=_program.id),'[]'::jsonb),
      'events','[]'::jsonb,'offers','[]'::jsonb,'roster','[]'::jsonb,'generatedAt',clock_timestamp());
  elsif _operation = 'save_program_draft' then
    if (select count(*) from jsonb_object_keys(_args)) <> 3
      or not (_args ?& array['_version_id','_payload','_expected_updated_at'])
      or jsonb_typeof(_args->'_payload') <> 'object'
      or octet_length((_args->'_payload')::text) > 1048576
      or (_args->'_payload')::text ~ '"(affiliateUrl|destinationUrl|discountCode|trackingCode)"[[:space:]]*:' then
      raise exception using errcode='22023',message='program_payload_invalid'; end if;
    _content := _args->'_payload';
    if jsonb_typeof(coalesce(_content->'modules','[]'::jsonb)) <> 'array' then
      raise exception using errcode='22023',message='program_payload_invalid'; end if;
    _now := clock_timestamp();
    update clinical_core.synthetic_desktop_program_versions set content=_content,updated_at=_now
      where id=(_args->>'_version_id')::uuid and organization_id=_org and status='draft'
        and (nullif(_args->>'_expected_updated_at','') is null
          or updated_at=(nullif(_args->>'_expected_updated_at',''))::timestamptz)
      returning * into _version;
    if not found then raise exception using errcode='40001',message='program_draft_conflict'; end if;
    update clinical_core.synthetic_desktop_programs set name=coalesce(nullif(btrim(_content->>'title'),''),name),
      updated_at=_now where id=_version.program_id;
    insert into clinical_core.synthetic_desktop_activity_audit(
      organization_id,actor_person_id,action,resource_type,resource_id,safe_metadata)
      values(_org,_actor,'program.saved','program_version',_version.id,
        jsonb_build_object('version',_version.version));
    return jsonb_build_object('ok',true,'message','Draft saved.','programId',_version.program_id,
      'versionId',_version.id,'version',_version.version,'status','draft','updatedAt',_now);
  elsif _operation in ('submit_program_version','approve_program_version','return_program_version',
    'publish_program_version','revise_program_version','archive_program') then
    if _operation='archive_program' then
      update clinical_core.synthetic_desktop_programs set
        status=case when coalesce((_args->>'_archived')::boolean,false) then 'archived'
          when published_version_id is null then 'draft' else 'published' end,
        archived_at=case when coalesce((_args->>'_archived')::boolean,false) then clock_timestamp() end,
        updated_at=clock_timestamp()
        where id=(_args->>'_program_id')::uuid and organization_id=_org returning * into _program;
      if not found then raise exception using errcode='P0002',message='program_not_found'; end if;
      insert into clinical_core.synthetic_desktop_activity_audit(
        organization_id,actor_person_id,action,resource_type,resource_id,safe_metadata)
        values(_org,_actor,'program.archived','program',_program.id,
          jsonb_build_object('archived',coalesce((_args->>'_archived')::boolean,false)));
      return jsonb_build_object('ok',true,'message',case when _program.status='archived' then 'Program archived.' else 'Program restored.' end,
        'programId',_program.id,'status',_program.status,'archived',_program.status='archived');
    end if;
    select * into _version from clinical_core.synthetic_desktop_program_versions
      where id=(_args->>'_version_id')::uuid and organization_id=_org for update;
    if not found then raise exception using errcode='P0002',message='program_version_not_found'; end if;
    if _operation='submit_program_version' then
      if _version.status<>'draft' then raise exception using errcode='40001',message='program_submit_refused'; end if;
      update clinical_core.synthetic_desktop_program_versions set status='in_review',updated_at=clock_timestamp()
        where id=_version.id;
      return jsonb_build_object('ok',true,'message','Program submitted for review.','versionId',_version.id,'status','in_review');
    elsif _operation='return_program_version' then
      if _version.status<>'in_review' then raise exception using errcode='40001',message='program_return_refused'; end if;
      update clinical_core.synthetic_desktop_program_versions set status='draft',review_note=nullif(btrim(_args->>'_note'),''),updated_at=clock_timestamp()
        where id=_version.id;
      return jsonb_build_object('ok',true,'message','Program returned to draft.','versionId',_version.id,'status','draft');
    elsif _operation='approve_program_version' then
      if _version.status<>'in_review' or char_length(btrim(coalesce(_args->>'_note',''))) < 10 then
        raise exception using errcode='22023',message='program_approval_refused'; end if;
      update clinical_core.synthetic_desktop_program_versions set status='approved',review_note=btrim(_args->>'_note'),
        approved_at=clock_timestamp(),updated_at=clock_timestamp() where id=_version.id;
      return jsonb_build_object('ok',true,'message','Program approved.','versionId',_version.id,'status','approved');
    elsif _operation='publish_program_version' then
      if _version.status<>'approved' then raise exception using errcode='40001',message='approved_program_required'; end if;
      update clinical_core.synthetic_desktop_program_versions set status='superseded'
        where program_id=_version.program_id and status='published';
      update clinical_core.synthetic_desktop_program_versions set status='published',published_at=clock_timestamp(),updated_at=clock_timestamp()
        where id=_version.id;
      update clinical_core.synthetic_desktop_programs set status='published',published_version_id=_version.id,
        updated_at=clock_timestamp() where id=_version.program_id;
      return jsonb_build_object('ok',true,'message','Program published.','versionId',_version.id,'status','published');
    else
      if _version.status not in ('approved','published') then raise exception using errcode='40001',message='program_version_not_revisable'; end if;
      select coalesce(max(version),0)+1 into _next from clinical_core.synthetic_desktop_program_versions
        where program_id=_version.program_id;
      insert into clinical_core.synthetic_desktop_program_versions(
        organization_id,program_id,version,status,content,supersedes_version_id,created_by_person_id)
        values(_org,_version.program_id,_next,'draft',_version.content,_version.id,_actor) returning id into _version_id;
      return jsonb_build_object('ok',true,'message','New draft created.','programId',_version.program_id,
        'versionId',_version_id,'version',_next,'status','draft','supersedesVersionId',_version.id);
    end if;
  elsif _operation = 'create_program_template' then
    if char_length(btrim(coalesce(_args->>'_name',''))) not between 1 and 200 then
      raise exception using errcode='22023',message='program_template_invalid'; end if;
    _content := '{}';
    if nullif(_args->>'_from_version_id','') is not null then
      select content into _content from clinical_core.synthetic_desktop_program_versions
        where id=(_args->>'_from_version_id')::uuid and organization_id=_org;
      if not found then raise exception using errcode='P0002',message='program_version_not_found'; end if;
    end if;
    insert into clinical_core.synthetic_desktop_program_templates(
      organization_id,name,description,content,created_by_person_id)
      values(_org,btrim(_args->>'_name'),nullif(btrim(_args->>'_description'),''),_content,_actor)
      returning id into _id;
    return jsonb_build_object('ok',true,'message','Program template created.','templateId',_id,'status','draft');
  elsif _operation = 'approve_program_template_version' then
    update clinical_core.synthetic_desktop_program_templates set status='approved',approved_version=1,
      approved_version_id=id,updated_at=clock_timestamp()
      where id=(_args->>'_version_id')::uuid and organization_id=_org and status='draft' returning id into _id;
    if not found then raise exception using errcode='40001',message='program_template_approval_refused'; end if;
    return jsonb_build_object('ok',true,'message','Program template approved.','templateId',_id,'status','approved');
  elsif _operation = 'archive_program_template' then
    update clinical_core.synthetic_desktop_program_templates set
      status=case when coalesce((_args->>'_archived')::boolean,false) then 'archived' else 'draft' end,
      archived_at=case when coalesce((_args->>'_archived')::boolean,false) then clock_timestamp() end,
      updated_at=clock_timestamp()
      where id=(_args->>'_template_id')::uuid and organization_id=_org returning id into _id;
    if not found then raise exception using errcode='P0002',message='program_template_not_found'; end if;
    return jsonb_build_object('ok',true,'message','Program template updated.','templateId',_id);
  end if;
  raise exception using errcode='0A000',message='program_operation_not_supported';
end $$;

create or replace function clinical_compatibility.synthetic_inbox_v1(_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _operation text; _args jsonb; _org uuid := clinical_private.organization_id();
  _actor uuid := clinical_private.actor_person_id(); _id uuid; _conversation clinical_core.synthetic_desktop_conversations%rowtype;
  _message clinical_core.synthetic_desktop_messages%rowtype; _version integer; _action text;
begin
  perform clinical_private.assert_synthetic_context(_org,'clinical_data','workforce');
  if not clinical_private.has_inbox_role(_org) then
    raise exception using errcode='42501',message='inbox_role_required';
  end if;
  if jsonb_typeof(_request) <> 'object' or _request->>'kind' is distinct from 'rpc'
    or jsonb_typeof(_request->'args') <> 'object'
    or (select count(*) from jsonb_object_keys(_request)) <> 3 then
    raise exception using errcode='22023',message='inbox_request_invalid';
  end if;
  _operation := _request->>'functionName'; _args := _request->'args';
  if _args ? '_organization_id' and (_args->>'_organization_id')::uuid <> _org then
    raise exception using errcode='42501',message='inbox_tenant_refused';
  end if;
  if _operation = 'list_inbox' then
    return jsonb_build_object(
      'threads',coalesce((select jsonb_agg(thread order by thread->>'lastMessageAt' desc nulls last)
        from (select jsonb_build_object(
          'id',c.id,'subject',c.subject,'category',c.category,'priority',c.priority,'status',c.status,
          'assignedTo',c.assigned_person_id,'assignedQueue',c.assigned_queue,'followUpAt',c.follow_up_at,
          'snoozedUntil',c.snoozed_until,'urgent',c.priority='urgent','urgentTerms','[]'::jsonb,
          'version',c.version,'lastMessageAt',c.last_message_at,'patientId',c.patient_record_id,
          'patientName',p.synthetic_record_key,
          'unreadCount',(select count(*) from clinical_core.synthetic_desktop_messages m
            where m.conversation_id=c.id and m.status='inbound' and m.read_at is null),
          'messageCount',(select count(*) from clinical_core.synthetic_desktop_messages m
            where m.conversation_id=c.id and m.status<>'cancelled')) thread
        from clinical_core.synthetic_desktop_conversations c
        join clinical_core.patient_records p on p.id=c.patient_record_id and p.organization_id=_org
        where c.organization_id=_org
          and (nullif(_args->>'_status','') is null or c.status=_args->>'_status')
          and (nullif(_args->>'_category','') is null or c.category=_args->>'_category')
          and (nullif(_args->>'_priority','') is null or c.priority=_args->>'_priority')
          and (nullif(_args->>'_queue','') is null or c.assigned_queue=_args->>'_queue')
          and (not coalesce((_args->>'_assigned_to_me')::boolean,false) or c.assigned_person_id=_actor)
          and (not coalesce((_args->>'_unread_only')::boolean,false) or exists(
            select 1 from clinical_core.synthetic_desktop_messages m where m.conversation_id=c.id and m.status='inbound' and m.read_at is null))
          and (not coalesce((_args->>'_due_only')::boolean,false) or c.follow_up_at<=clock_timestamp()+interval '1 day')
          and (nullif(_args->>'_query','') is null or c.subject ilike '%'||(_args->>'_query')||'%'
            or p.synthetic_record_key ilike '%'||(_args->>'_query')||'%')
        order by c.updated_at desc limit least(greatest(coalesce((_args->>'_limit')::integer,50),1),100)) visible),'[]'::jsonb),
      'counts',jsonb_build_object(
        'open',(select count(*) from clinical_core.synthetic_desktop_conversations where organization_id=_org and status='open'),
        'snoozed',(select count(*) from clinical_core.synthetic_desktop_conversations where organization_id=_org and status='snoozed'),
        'resolved',(select count(*) from clinical_core.synthetic_desktop_conversations where organization_id=_org and status='resolved'),
        'urgent',(select count(*) from clinical_core.synthetic_desktop_conversations where organization_id=_org and priority='urgent' and status<>'resolved'),
        'unread',(select count(distinct c.id) from clinical_core.synthetic_desktop_conversations c join clinical_core.synthetic_desktop_messages m on m.conversation_id=c.id where c.organization_id=_org and m.status='inbound' and m.read_at is null),
        'dueSoon',(select count(*) from clinical_core.synthetic_desktop_conversations where organization_id=_org and status<>'resolved' and follow_up_at<=clock_timestamp()+interval '1 day'),
        'mine',(select count(*) from clinical_core.synthetic_desktop_conversations where organization_id=_org and status<>'resolved' and assigned_person_id=_actor)),
      'generatedAt',clock_timestamp());
  elsif _operation = 'create_conversation' then
    if not exists(select 1 from clinical_core.patient_records where id=(_args->>'_patient_id')::uuid
      and organization_id=_org and status='active') then raise exception using errcode='P0002',message='patient_not_found'; end if;
    if (_args->>'_category') not in ('general','clinical_question','refill','lab','wearable_alert','scheduling','billing','program_check_in','protocol_adherence','administrative')
      or (_args->>'_priority') not in ('low','normal','high','urgent')
      or char_length(btrim(coalesce(_args->>'_subject',''))) not between 1 and 300 then
      raise exception using errcode='22023',message='conversation_invalid'; end if;
    insert into clinical_core.synthetic_desktop_conversations(
      organization_id,patient_record_id,subject,category,priority,created_by_person_id)
      values(_org,(_args->>'_patient_id')::uuid,btrim(_args->>'_subject'),_args->>'_category',_args->>'_priority',_actor)
      returning id into _id;
    insert into clinical_core.synthetic_desktop_activity_audit(
      organization_id,actor_person_id,action,resource_type,resource_id,safe_metadata)
      values(_org,_actor,'conversation.created','conversation',_id,
        jsonb_build_object('category',_args->>'_category','priority',_args->>'_priority'));
    return jsonb_build_object('ok',true,'message','Conversation created.','conversationId',_id,'status','open');
  elsif _operation = 'get_conversation' then
    select * into _conversation from clinical_core.synthetic_desktop_conversations
      where id=(_args->>'_conversation_id')::uuid and organization_id=_org;
    if not found then raise exception using errcode='P0002',message='conversation_not_found'; end if;
    return jsonb_build_object(
      'conversation',jsonb_build_object('id',_conversation.id,'subject',_conversation.subject,
        'category',_conversation.category,'priority',_conversation.priority,'status',_conversation.status,
        'assignedTo',_conversation.assigned_person_id,'assignedQueue',_conversation.assigned_queue,
        'followUpAt',_conversation.follow_up_at,'snoozedUntil',_conversation.snoozed_until,
        'urgent',_conversation.priority='urgent','urgentTerms','[]'::jsonb,'version',_conversation.version,
        'lastMessageAt',_conversation.last_message_at,'createdAt',_conversation.created_at),
      'patient',(select jsonb_build_object('id',p.id,'name',p.synthetic_record_key)
        from clinical_core.patient_records p where p.id=_conversation.patient_record_id),
      'messages',coalesce((select jsonb_agg(jsonb_build_object(
        'id',m.id,'body',m.body,'status',m.status,'channel',m.channel,
        'isFromPatient',m.status='inbound','senderUserId',m.sender_person_id,
        'isMine',m.sender_person_id=_actor,'version',m.version,'readAt',m.read_at,
        'sentAt',null,'deliveredAt',null,'failedReason',null,'createdAt',m.created_at,'updatedAt',m.updated_at)
        order by m.created_at) from clinical_core.synthetic_desktop_messages m
        where m.conversation_id=_conversation.id and m.status<>'cancelled'),'[]'::jsonb),
      'attachments','[]'::jsonb,'preferences',null,'consents','[]'::jsonb,
      'aiReviews','[]'::jsonb,'events','[]'::jsonb,'outbox','[]'::jsonb,'generatedAt',clock_timestamp());
  elsif _operation = 'save_message_draft' then
    select * into _conversation from clinical_core.synthetic_desktop_conversations
      where id=(_args->>'_conversation_id')::uuid and organization_id=_org;
    if not found or char_length(btrim(coalesce(_args->>'_body',''))) not between 1 and 65536 then
      raise exception using errcode='22023',message='message_draft_invalid'; end if;
    if nullif(_args->>'_message_id','') is null then
      insert into clinical_core.synthetic_desktop_messages(
        organization_id,conversation_id,sender_person_id,body)
        values(_org,_conversation.id,_actor,btrim(_args->>'_body')) returning * into _message;
    else
      update clinical_core.synthetic_desktop_messages set body=btrim(_args->>'_body'),version=version+1,
        updated_at=clock_timestamp() where id=(_args->>'_message_id')::uuid
        and conversation_id=_conversation.id and sender_person_id=_actor and status='draft'
        and (nullif(_args->>'_expected_version','') is null or version=(_args->>'_expected_version')::integer)
        returning * into _message;
      if not found then raise exception using errcode='40001',message='message_draft_conflict'; end if;
    end if;
    update clinical_core.synthetic_desktop_conversations set last_message_at=_message.updated_at,
      updated_at=_message.updated_at where id=_conversation.id;
    return jsonb_build_object('ok',true,'message','Draft saved.','conversationId',_conversation.id,
      'messageId',_message.id,'version',_message.version,'status','draft');
  elsif _operation = 'cancel_message_draft' then
    update clinical_core.synthetic_desktop_messages set status='cancelled',version=version+1,updated_at=clock_timestamp()
      where id=(_args->>'_message_id')::uuid and organization_id=_org and sender_person_id=_actor
        and status='draft' returning * into _message;
    if not found then raise exception using errcode='40001',message='message_cancel_refused'; end if;
    return jsonb_build_object('ok',true,'message','Draft cancelled.','messageId',_message.id,'status','cancelled');
  elsif _operation = 'send_message' then
    select * into _message from clinical_core.synthetic_desktop_messages
      where id=(_args->>'_message_id')::uuid and organization_id=_org and sender_person_id=_actor and status='draft';
    if not found then raise exception using errcode='40001',message='draft_message_required'; end if;
    insert into clinical_core.synthetic_desktop_activity_audit(
      organization_id,actor_person_id,action,resource_type,resource_id,safe_metadata)
      values(_org,_actor,'message.send_refused','message',_message.id,
        jsonb_build_object('channel',_args->>'_channel','refusal','provider_not_configured'));
    return jsonb_build_object('ok',false,'message','Message delivery is not configured yet. The draft was kept and nothing was sent.',
      'sent',false,'refusal','provider_not_configured','messageId',_message.id,'status','draft');
  elsif _operation = 'mark_conversation_read' then
    update clinical_core.synthetic_desktop_messages set read_at=coalesce(read_at,clock_timestamp())
      where conversation_id=(_args->>'_conversation_id')::uuid and organization_id=_org and status='inbound' and read_at is null;
    get diagnostics _version = row_count;
    insert into clinical_core.synthetic_desktop_conversation_reads(organization_id,conversation_id,person_id)
      select _org,id,_actor from clinical_core.synthetic_desktop_conversations
      where id=(_args->>'_conversation_id')::uuid and organization_id=_org
      on conflict(conversation_id,person_id) do update set last_read_at=clock_timestamp();
    if not found then raise exception using errcode='P0002',message='conversation_not_found'; end if;
    return jsonb_build_object('ok',true,'message','Conversation marked read.','markedRead',_version);
  elsif _operation = 'update_conversation_workflow' then
    _action:=_args->>'_action';
    select * into _conversation from clinical_core.synthetic_desktop_conversations
      where id=(_args->>'_conversation_id')::uuid and organization_id=_org
        and version=(_args->>'_expected_version')::integer for update;
    if not found then raise exception using errcode='40001',message='conversation_version_conflict'; end if;
    if _action='status' and (_args->>'_value') in ('open','snoozed','resolved') then
      update clinical_core.synthetic_desktop_conversations set status=_args->>'_value'
        where id=_conversation.id;
    elsif _action='priority' and (_args->>'_value') in ('low','normal','high','urgent') then
      update clinical_core.synthetic_desktop_conversations set priority=_args->>'_value'
        where id=_conversation.id;
    elsif _action='category' and (_args->>'_value') in ('general','clinical_question','refill','lab','wearable_alert','scheduling','billing','program_check_in','protocol_adherence','administrative') then
      update clinical_core.synthetic_desktop_conversations set category=_args->>'_value'
        where id=_conversation.id;
    elsif _action='queue' and (_args->>'_value') in ('practitioner','staff') then
      update clinical_core.synthetic_desktop_conversations set assigned_queue=_args->>'_value'
        where id=_conversation.id;
    elsif _action='assign' then
      update clinical_core.synthetic_desktop_conversations set assigned_person_id=nullif(_args->>'_value','')::uuid
        where id=_conversation.id;
    elsif _action='follow_up' then
      update clinical_core.synthetic_desktop_conversations set follow_up_at=nullif(_args->>'_at','')::timestamptz
        where id=_conversation.id;
    else raise exception using errcode='22023',message='workflow_action_invalid'; end if;
    update clinical_core.synthetic_desktop_conversations set version=version+1,updated_at=clock_timestamp()
      where id=_conversation.id returning version into _version;
    return jsonb_build_object('ok',true,'message','Conversation updated.','conversationId',_conversation.id,'version',_version);
  elsif _operation = 'get_patient_messages' then
    if not exists(select 1 from clinical_core.patient_records where id=(_args->>'_patient_id')::uuid and organization_id=_org) then
      raise exception using errcode='P0002',message='patient_not_found'; end if;
    return jsonb_build_object('threads',coalesce((select jsonb_agg(jsonb_build_object(
      'id',c.id,'subject',c.subject,'category',c.category,'priority',c.priority,'status',c.status,
      'urgent',c.priority='urgent','lastMessageAt',c.last_message_at,'createdAt',c.created_at,
      'unreadCount',(select count(*) from clinical_core.synthetic_desktop_messages m where m.conversation_id=c.id and m.status='inbound' and m.read_at is null),
      'messageCount',(select count(*) from clinical_core.synthetic_desktop_messages m where m.conversation_id=c.id and m.status<>'cancelled'))
      order by c.updated_at desc) from clinical_core.synthetic_desktop_conversations c
      where c.organization_id=_org and c.patient_record_id=(_args->>'_patient_id')::uuid),'[]'::jsonb),
      'generatedAt',clock_timestamp());
  elsif _operation = 'get_inbox_today_summary' then
    return jsonb_build_object(
      'openThreads',(select count(*) from clinical_core.synthetic_desktop_conversations where organization_id=_org and status='open'),
      'urgentOpen',(select count(*) from clinical_core.synthetic_desktop_conversations where organization_id=_org and status='open' and priority='urgent'),
      'unreadInbound',(select count(*) from clinical_core.synthetic_desktop_messages where organization_id=_org and status='inbound' and read_at is null),
      'dueFollowUps',(select count(*) from clinical_core.synthetic_desktop_conversations where organization_id=_org and status<>'resolved' and follow_up_at<=clock_timestamp()+interval '1 day'),
      'myAssigned',(select count(*) from clinical_core.synthetic_desktop_conversations where organization_id=_org and status<>'resolved' and assigned_person_id=_actor),
      'generatedAt',clock_timestamp());
  end if;
  raise exception using errcode='0A000',message='inbox_operation_not_supported';
end $$;

revoke all on function clinical_private.has_program_author_role(uuid),
  clinical_private.has_inbox_role(uuid),clinical_private.synthetic_stable_uuid(text),
  clinical_private.synthetic_program_modules(uuid,jsonb),
  clinical_private.synthetic_program_version_detail(uuid) from public;
revoke all on function clinical_compatibility.synthetic_programs_v1(jsonb),
  clinical_compatibility.synthetic_inbox_v1(jsonb) from public;
grant execute on function clinical_compatibility.synthetic_programs_v1(jsonb),
  clinical_compatibility.synthetic_inbox_v1(jsonb) to clinical_core_api;
