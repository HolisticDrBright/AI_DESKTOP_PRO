-- The practitioner's own note template, and the house style a draft is written in.
-- Synthetic-only. No real patient data, and nothing here is enabled for production.
--
-- Review-only AI drafting already existed: a transcript goes in, a proposed note comes back,
-- the clinician reviews and signs. What it drafted was one of five fixed structures the
-- product chose. Every clinician with a house layout had to rewrite the draft into it, which
-- is most of the work the feature was supposed to remove.
--
-- So the structure becomes the clinician's. A template names its own sections, in its own
-- order, with its own headings, and may attach a line of guidance per section ("vitals
-- first, then exam"). A separate house style says how the prose should read.
--
-- Three decisions are load-bearing.
--
-- FIRST, style is enumerated, not free text. Verbosity, person, tense, bullets, whether to
-- quote the patient's own words, heading case: each is a fixed set of values. A style cannot
-- carry a sentence, so it cannot carry an instruction to the model. Per-section guidance is
-- free text because that is where the real value is, but it is capped, it is passed as
-- section-scoped data, and the pinned prompt boundary states that the template and the style
-- are data and that the boundary wins if they conflict with it. Free text reaching a model
-- is a real risk and this narrows it rather than pretending it away.
--
-- SECOND, a template version is published and immutable, exactly like a form version or a
-- program version. A draft can be edited; a published version cannot, and its digest is
-- computed here at publish time rather than supplied by a caller. A proposed note records
-- which template version and which style version produced it, so "why does this note read
-- like that" has an answer years later.
--
-- THIRD, prior-chart context is a setting with a default of none. A clinician may want the
-- last note or the problem list in view while a draft is written. That is a much larger
-- disclosure to a model than one encounter's transcript, so it is off unless chosen, and
-- even when chosen this family cannot satisfy it: signed notes live in the production
-- clinical core, not here. The resolver therefore returns what was asked for AND whether it
-- could be supplied, with a reason, instead of silently sending nothing and calling it done.
--
-- A template is practice configuration, not patient data. It is deliberately absent from
-- `care_data_export` and untouched by a patient erasure: nothing in it is about a patient,
-- and erasing one patient must not change the layout every other note is written in.

/* The same care-workforce assertion the dispute domain makes, with the refusal marker passed
   in. Migration 41 hard-coded its own marker, which meant every later domain either inherited
   a misleading name or copied the whole function. Passing the marker is the smaller of the
   two debts, and the next domain can use this one. */
create or replace function clinical_private.assert_practice_workforce(_org uuid,_marker text)
returns uuid language plpgsql stable set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _pool text:=clinical_private.claim('identity_pool');
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 if _actor is null or _pool<>'workforce'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool
   and i.identity_subject=clinical_private.claim('identity_subject')
   and i.status='active' and p.status='active' and i.synthetic_attested)
 or not clinical_private.has_clinical_role(_org) then
  raise exception using errcode='42501',message=_marker;
 end if;
 return _actor;
end $$;
revoke all on function clinical_private.assert_practice_workforce(uuid,text) from public;

create table clinical_core.note_templates(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 note_type text not null check(note_type in(
  'soap','adime','narrative','follow_up','patient_instructions')),
 name text not null check(char_length(btrim(name)) between 1 and 120),
 status text not null default 'active' check(status in('active','archived')),
 created_by_person_id uuid not null references clinical_core.persons(id),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
create index note_templates_org_idx on clinical_core.note_templates(organization_id,note_type,status);

/* Only one template per note type may be the one drafting uses. Archived ones stay for the
   record; a draft note that cites a retired version can still be explained. */
create unique index note_templates_one_active_per_type
 on clinical_core.note_templates(organization_id,note_type) where status='active';

create table clinical_core.note_template_versions(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 template_id uuid not null references clinical_core.note_templates(id) on delete cascade,
 version integer not null check(version>0),
 status text not null default 'draft' check(status in('draft','published','retired')),
 -- One entry per section: key, heading, and optionally a line of the clinician's guidance.
 sections jsonb not null,
 content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
 created_by_person_id uuid not null references clinical_core.persons(id),
 created_at timestamptz not null default clock_timestamp(),
 published_at timestamptz,
 published_by_person_id uuid references clinical_core.persons(id),
 unique(template_id,version),
 -- A retired version was published once, so its publication stamps stay. Only a draft has
 -- never been published, and only a draft may be missing them.
 check((status='draft') = (published_at is null and published_by_person_id is null))
);
create index note_template_versions_template_idx
 on clinical_core.note_template_versions(template_id,version desc);
create unique index note_template_versions_one_published
 on clinical_core.note_template_versions(template_id) where status='published';
create unique index note_template_versions_one_draft
 on clinical_core.note_template_versions(template_id) where status='draft';

create table clinical_core.practice_note_styles(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 version integer not null check(version>0),
 status text not null default 'published' check(status in('published','retired')),
 style jsonb not null,
 content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
 published_at timestamptz not null default clock_timestamp(),
 published_by_person_id uuid not null references clinical_core.persons(id),
 unique(organization_id,version)
);
create unique index practice_note_styles_one_published
 on clinical_core.practice_note_styles(organization_id) where status='published';

/* The shape of a section list. Eight is the ceiling the proposed-note contract already
   enforces, and keys must be distinct because the provider's output is matched to them by
   position and key. */
create or replace function clinical_private.note_template_sections_valid(_sections jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare _item jsonb; _keys text[]:='{}';
begin
 if clinical_private.jsonb_kind(_sections)<>'array' then return false; end if;
 if jsonb_array_length(_sections)<1 or jsonb_array_length(_sections)>8 then return false; end if;
 for _item in select value from jsonb_array_elements(_sections) loop
  if clinical_private.jsonb_kind(_item)<>'object' then return false; end if;
  if _item-array['key','label','guidance']<>'{}'::jsonb then return false; end if;
  if clinical_private.jsonb_kind(_item->'key')<>'string'
  or clinical_private.jsonb_kind(_item->'label')<>'string' then return false; end if;
  if (_item->>'key') !~ '^[A-Za-z][A-Za-z0-9_]{0,7}$' then return false; end if;
  if char_length(btrim(_item->>'label')) not between 1 and 80 then return false; end if;
  -- Guidance may be absent or null; when present it is a bounded line, never a paragraph.
  if clinical_private.jsonb_kind(_item->'guidance') not in('absent','null','string') then return false; end if;
  if clinical_private.jsonb_kind(_item->'guidance')='string'
  and char_length(btrim(_item->>'guidance')) not between 1 and 400 then return false; end if;
  if (_item->>'key')=any(_keys) then return false; end if;
  _keys:=_keys||(_item->>'key');
 end loop;
 return true;
end $$;
revoke all on function clinical_private.note_template_sections_valid(jsonb) from public;

/* The shape of a house style: every field a closed set of values. This is the whole reason
   style is safe to put in a prompt — there is no place in it to write a sentence. */
create or replace function clinical_private.note_style_valid(_style jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
begin
 if clinical_private.jsonb_kind(_style)<>'object' then return false; end if;
 if _style-array['verbosity','person','tense','bullets','quotePatientWords','headingCase',
  'contextBreadth']<>'{}'::jsonb then return false; end if;
 if (_style->>'verbosity') is null or (_style->>'verbosity') not in('terse','standard','detailed')
 or (_style->>'person') is null or (_style->>'person') not in('third','first')
 or (_style->>'tense') is null or (_style->>'tense') not in('past','present')
 or (_style->>'headingCase') is null or (_style->>'headingCase') not in('title','upper','sentence')
 or (_style->>'contextBreadth') is null
  or (_style->>'contextBreadth') not in('none','last_note','problem_list') then return false; end if;
 if clinical_private.jsonb_kind(_style->'bullets')<>'boolean'
 or clinical_private.jsonb_kind(_style->'quotePatientWords')<>'boolean' then return false; end if;
 return true;
end $$;
revoke all on function clinical_private.note_style_valid(jsonb) from public;

alter table clinical_core.note_template_versions
 add constraint note_template_versions_sections_valid
 check(clinical_private.note_template_sections_valid(sections));
alter table clinical_core.practice_note_styles
 add constraint practice_note_styles_style_valid
 check(clinical_private.note_style_valid(style));

/* A published version never changes. Retiring it is the only permitted update, because a
   note that cites version 3 must still be able to show what version 3 said. */
create or replace function clinical_private.protect_note_template_version() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then
  if old.status<>'draft' then
   raise exception using errcode='0A000',message='note_template_version_immutable'; end if;
  return old;
 end if;
 if old.status='draft' then return new; end if;
 if old.status='published' and new.status='retired'
 and new.sections=old.sections and new.content_sha256=old.content_sha256
 and new.version=old.version and new.template_id=old.template_id
 and new.published_at=old.published_at
 and new.published_by_person_id=old.published_by_person_id then return new; end if;
 raise exception using errcode='0A000',message='note_template_version_immutable';
end $$;
create trigger note_template_versions_protect before update or delete
 on clinical_core.note_template_versions
 for each row execute function clinical_private.protect_note_template_version();

create or replace function clinical_private.protect_practice_note_style() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then
  raise exception using errcode='0A000',message='practice_note_style_immutable'; end if;
 if old.status='published' and new.status='retired'
 and new.style=old.style and new.content_sha256=old.content_sha256
 and new.version=old.version and new.published_at=old.published_at then return new; end if;
 raise exception using errcode='0A000',message='practice_note_style_immutable';
end $$;
create trigger practice_note_styles_protect before update or delete
 on clinical_core.practice_note_styles
 for each row execute function clinical_private.protect_practice_note_style();

/* The clinician's own hands on their template. Drafting is deliberately not allowed to
   publish anything: writing a template is a decision, and a model asking for a better prompt
   is exactly the thing this store must not let happen. */
create or replace function clinical_core.note_template_admin(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text;
 _template clinical_core.note_templates%rowtype;
 _version clinical_core.note_template_versions%rowtype;
 _style clinical_core.practice_note_styles%rowtype;
 _note_type text; _next integer; _items jsonb;
begin
 _actor:=clinical_private.assert_practice_workforce(_org,'note_template_forbidden');
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='note_template_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('list','read','save_draft','publish','archive',
  'style_read','style_publish') then
  raise exception using errcode='22023',message='note_template_invalid'; end if;

 if _action='list' then
  if _request-array['action']<>'{}'::jsonb then
   raise exception using errcode='22023',message='note_template_invalid'; end if;
  return jsonb_build_object('action','list','templates',coalesce((
   select jsonb_agg(jsonb_build_object('templateId',t.id,'noteType',t.note_type,'name',t.name,
    'status',t.status,
    'publishedVersion',(select v.version from clinical_core.note_template_versions v
     where v.template_id=t.id and v.status='published'),
    'draftVersion',(select v.version from clinical_core.note_template_versions v
     where v.template_id=t.id and v.status='draft'),
    'updatedAt',to_char(t.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    order by t.note_type,t.created_at)
   from clinical_core.note_templates t where t.organization_id=_org),'[]'::jsonb));
 end if;

 if _action='style_read' then
  if _request-array['action']<>'{}'::jsonb then
   raise exception using errcode='22023',message='note_template_invalid'; end if;
  select * into _style from clinical_core.practice_note_styles
   where organization_id=_org and status='published';
  if _style.id is null then
   return jsonb_build_object('action','style_read','style',null); end if;
  return jsonb_build_object('action','style_read','style',jsonb_build_object(
   'version',_style.version,'style',_style.style,'contentSha256',_style.content_sha256));
 end if;

 if _action='style_publish' then
  if _request-array['action','style']<>'{}'::jsonb then
   raise exception using errcode='22023',message='note_template_invalid'; end if;
  if not clinical_private.note_style_valid(_request->'style') then
   raise exception using errcode='22023',message='note_style_invalid'; end if;
  update clinical_core.practice_note_styles set status='retired'
   where organization_id=_org and status='published';
  select coalesce(max(version),0)+1 into _next from clinical_core.practice_note_styles
   where organization_id=_org;
  insert into clinical_core.practice_note_styles(organization_id,version,style,content_sha256,
   published_by_person_id)
  values(_org,_next,_request->'style',
   encode(public.digest(convert_to((_request->'style')::text,'UTF8'),'sha256'),'hex'),_actor)
  returning * into _style;
  return jsonb_build_object('action','style_publish','version',_style.version,
   'contentSha256',_style.content_sha256);
 end if;

 if _action='save_draft' then
  if _request-array['action','noteType','name','sections']<>'{}'::jsonb then
   raise exception using errcode='22023',message='note_template_invalid'; end if;
  _note_type:=_request->>'noteType';
  if _note_type is null or _note_type not in('soap','adime','narrative','follow_up',
   'patient_instructions') then
   raise exception using errcode='22023',message='note_template_invalid'; end if;
  if clinical_private.jsonb_kind(_request->'name')<>'string'
  or char_length(btrim(_request->>'name')) not between 1 and 120 then
   raise exception using errcode='22023',message='note_template_invalid'; end if;
  if not clinical_private.note_template_sections_valid(_request->'sections') then
   raise exception using errcode='22023',message='note_template_sections_invalid'; end if;
  select * into _template from clinical_core.note_templates
   where organization_id=_org and note_type=_note_type and status='active';
  if _template.id is null then
   insert into clinical_core.note_templates(organization_id,note_type,name,
    created_by_person_id) values(_org,_note_type,btrim(_request->>'name'),_actor)
   returning * into _template;
  else
   update clinical_core.note_templates set name=btrim(_request->>'name'),
    updated_at=clock_timestamp() where id=_template.id returning * into _template;
  end if;
  select * into _version from clinical_core.note_template_versions
   where template_id=_template.id and status='draft';
  if _version.id is null then
   select coalesce(max(version),0)+1 into _next from clinical_core.note_template_versions
    where template_id=_template.id;
   insert into clinical_core.note_template_versions(organization_id,template_id,version,
    sections,content_sha256,created_by_person_id)
   values(_org,_template.id,_next,_request->'sections',
    encode(public.digest(convert_to((_request->'sections')::text,'UTF8'),'sha256'),'hex'),_actor)
   returning * into _version;
  else
   update clinical_core.note_template_versions set sections=_request->'sections',
    content_sha256=encode(public.digest(convert_to((_request->'sections')::text,'UTF8'),'sha256'),'hex')
    where id=_version.id returning * into _version;
  end if;
  return jsonb_build_object('action','save_draft','templateId',_template.id,
   'version',_version.version,'status',_version.status,'contentSha256',_version.content_sha256);
 end if;

 if _action='publish' then
  if _request-array['action','templateId','contentSha256']<>'{}'::jsonb then
   raise exception using errcode='22023',message='note_template_invalid'; end if;
  begin
   select * into _template from clinical_core.note_templates
    where organization_id=_org and id=(_request->>'templateId')::uuid;
  exception when invalid_text_representation then
   raise exception using errcode='22023',message='note_template_invalid'; end;
  if _template.id is null or _template.status<>'active' then
   raise exception using errcode='P0002',message='note_template_absent'; end if;
  select * into _version from clinical_core.note_template_versions
   where template_id=_template.id and status='draft';
  if _version.id is null then
   raise exception using errcode='P0002',message='note_template_draft_absent'; end if;
  -- The caller publishes the version it was shown, not whatever is there now.
  if (_request->>'contentSha256') is distinct from _version.content_sha256 then
   raise exception using errcode='40001',message='note_template_digest_mismatch'; end if;
  update clinical_core.note_template_versions set status='retired'
   where template_id=_template.id and status='published';
  update clinical_core.note_template_versions set status='published',
   published_at=clock_timestamp(),published_by_person_id=_actor
   where id=_version.id returning * into _version;
  update clinical_core.note_templates set updated_at=clock_timestamp() where id=_template.id;
  return jsonb_build_object('action','publish','templateId',_template.id,
   'version',_version.version,'status',_version.status,'contentSha256',_version.content_sha256);
 end if;

 if _action='archive' then
  if _request-array['action','templateId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='note_template_invalid'; end if;
  begin
   select * into _template from clinical_core.note_templates
    where organization_id=_org and id=(_request->>'templateId')::uuid;
  exception when invalid_text_representation then
   raise exception using errcode='22023',message='note_template_invalid'; end;
  if _template.id is null then
   raise exception using errcode='P0002',message='note_template_absent'; end if;
  update clinical_core.note_templates set status='archived',updated_at=clock_timestamp()
   where id=_template.id;
  update clinical_core.note_template_versions set status='retired'
   where template_id=_template.id and status='published';
  delete from clinical_core.note_template_versions
   where template_id=_template.id and status='draft';
  return jsonb_build_object('action','archive','templateId',_template.id,'status','archived');
 end if;

 -- read
 if _request-array['action','templateId']<>'{}'::jsonb then
  raise exception using errcode='22023',message='note_template_invalid'; end if;
 begin
  select * into _template from clinical_core.note_templates
   where organization_id=_org and id=(_request->>'templateId')::uuid;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='note_template_invalid'; end;
 if _template.id is null then
  raise exception using errcode='P0002',message='note_template_absent'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('version',v.version,'status',v.status,
   'sections',v.sections,'contentSha256',v.content_sha256,
   'publishedAt',to_char(v.published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   order by v.version desc),'[]'::jsonb) into _items
 from clinical_core.note_template_versions v where v.template_id=_template.id;
 return jsonb_build_object('action','read','templateId',_template.id,
  'noteType',_template.note_type,'name',_template.name,'status',_template.status,
  'versions',_items);
end $$;
revoke all on function clinical_core.note_template_admin(jsonb) from public;
grant execute on function clinical_core.note_template_admin(jsonb) to clinical_core_api;

/* What drafting is given. Returns the published template and style with their digests, and —
   separately — what prior-chart context the style asked for and whether it can be supplied.
   Saying "none available, because signed notes are not in this family" is the honest answer;
   returning an empty context and letting the caller assume it was searched is not. */
create or replace function clinical_core.note_drafting_context(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _note_type text;
 _template clinical_core.note_templates%rowtype;
 _version clinical_core.note_template_versions%rowtype;
 _style clinical_core.practice_note_styles%rowtype;
 _breadth text; _available boolean; _reason text;
begin
 _actor:=clinical_private.assert_practice_workforce(_org,'note_template_forbidden');
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action','noteType']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'resolve' then
  raise exception using errcode='22023',message='note_template_invalid'; end if;
 _note_type:=_request->>'noteType';
 if _note_type is null or _note_type not in('soap','adime','narrative','follow_up',
  'patient_instructions') then
  raise exception using errcode='22023',message='note_template_invalid'; end if;

 select * into _template from clinical_core.note_templates
  where organization_id=_org and note_type=_note_type and status='active';
 if _template.id is not null then
  select * into _version from clinical_core.note_template_versions
   where template_id=_template.id and status='published';
 end if;
 select * into _style from clinical_core.practice_note_styles
  where organization_id=_org and status='published';

 _breadth:=coalesce(_style.style->>'contextBreadth','none');
 if _breadth='none' then _available:=false; _reason:=null;
 else
  -- Signed notes and problem lists are in the production clinical core, behind its own
  -- boundary. This family cannot reach them, and a caller must be told that rather than
  -- receiving an empty context that looks like "nothing found".
  _available:=false; _reason:='prior_chart_not_available_in_this_family';
 end if;

 return jsonb_build_object('action','resolve','noteType',_note_type,
  'template',case when _version.id is null then null else jsonb_build_object(
   'templateId',_template.id,'name',_template.name,'version',_version.version,
   'sections',_version.sections,'contentSha256',_version.content_sha256) end,
  'style',case when _style.id is null then null else jsonb_build_object(
   'version',_style.version,'style',_style.style,'contentSha256',_style.content_sha256) end,
  'context',jsonb_build_object('breadth',_breadth,'available',_available,
   'withheldReason',_reason));
end $$;
revoke all on function clinical_core.note_drafting_context(jsonb) from public;
grant execute on function clinical_core.note_drafting_context(jsonb) to clinical_core_api;
