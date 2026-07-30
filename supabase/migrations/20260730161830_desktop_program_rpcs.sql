-- desktop_program_rpcs
--
-- The read + mutation layer for the Programs workspace. Contract identical to
-- the protocol RPCs: SECURITY DEFINER, pinned empty search_path, explicit
-- auth + membership + clinical-role gates, tenant agreement across every
-- referenced record, bounded outputs, typed errors (28000/42501/P0002/22023/
-- 40001), PHI-safe audit metadata, anon+public execution revoked.
--
-- Server-generated authority: identity, organization, lifecycle status,
-- version numbers, approval/publication stamps, enrollment eligibility, and
-- reviewer identity all come from the database — never from client claims.
--
-- NOT PRESENT, deliberately: any code path that charges, invoices, messages,
-- enrolls on publish, creates a protocol/order/task/note, or contacts Stripe.
-- Publishing exposes content; enrollment is its own audited action.

begin;

-- Authoring gate: active owner/admin/practitioner. Staff may read (RLS) but
-- may not author or publish education content or manage enrollments.
create or replace function private.can_author_program(_organization_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner','admin','practitioner')
  );
$$;
revoke all on function private.can_author_program(uuid) from public, anon;
grant execute on function private.can_author_program(uuid) to authenticated, service_role;

-- Full nested projection of one version (modules -> lessons -> blocks).
create or replace function private.program_version_json(_version_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', v.id, 'version', v.version, 'status', v.status, 'title', v.title,
    'summary', v.summary, 'audience', v.audience, 'disclaimer', v.disclaimer,
    'sourceTemplateId', v.source_template_id,
    'sourceTemplateVersion', v.source_template_version,
    'supersedesVersionId', v.supersedes_version_id,
    'reviewNote', v.review_note,
    'approvedAt', v.approved_at, 'publishedAt', v.published_at,
    'updatedAt', v.updated_at, 'createdAt', v.created_at,
    'modules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'summary', m.summary, 'position', m.position,
        'lessons', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', l.id, 'title', l.title, 'summary', l.summary, 'position', l.position,
            'blocks', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', b.id, 'kind', b.kind, 'title', b.title,
                'content', b.content, 'isCommercial', b.is_commercial,
                'position', b.position
              ) order by b.position, b.created_at)
              from public.program_blocks b where b.lesson_id = l.id
            ), '[]'::jsonb)
          ) order by l.position, l.created_at)
          from public.program_lessons l where l.module_id = m.id
        ), '[]'::jsonb)
      ) order by m.position, m.created_at)
      from public.program_modules m where m.version_id = v.id
    ), '[]'::jsonb)
  )
  from public.program_versions v where v.id = _version_id;
$$;
revoke all on function private.program_version_json(uuid) from public, anon;
grant execute on function private.program_version_json(uuid) to authenticated, service_role;

-- ---------------------------------------------------------- list_programs
create or replace function public.list_programs(
  _organization_id uuid,
  _query text default null,
  _status text default null,
  _limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _q text; _n integer; _rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if _status is not null and _status not in ('draft','published','archived') then
    raise exception 'unknown program status filter' using errcode = '22023';
  end if;
  _q := nullif(btrim(coalesce(_query,'')),'');
  _n := least(greatest(coalesce(_limit,50),1),100);

  select coalesce(jsonb_agg(r order by r->>'updatedAt' desc), '[]'::jsonb) into _rows
  from (
    select jsonb_build_object(
      'id', p.id, 'name', p.name, 'description', p.description,
      'status', p.status, 'archivedAt', p.archived_at,
      'updatedAt', p.updated_at,
      'publishedVersion', pv.version,
      'draftStatus', dv.status,
      -- Counts of PERSISTED enrollment rows only; nothing is projected.
      'enrollment', jsonb_build_object(
        'invited', count(e.id) filter (where e.status = 'invited'),
        'active',  count(e.id) filter (where e.status = 'active'),
        'paused',  count(e.id) filter (where e.status = 'paused'),
        'completed', count(e.id) filter (where e.status = 'completed'))
    ) as r
    from public.programs p
    left join public.program_versions pv on pv.id = p.published_version_id
    left join public.program_versions dv on dv.id = p.current_version_id
      and dv.status in ('draft','in_review','approved')
    left join public.program_enrollments e
      on e.program_id = p.id and e.deleted_at is null
    where p.organization_id = _organization_id
      and p.deleted_at is null
      and (_status is null or p.status = _status)
      and (_q is null or p.name ilike '%'||_q||'%' or coalesce(p.description,'') ilike '%'||_q||'%')
    group by p.id, pv.version, dv.status
    limit _n
  ) s;
  return jsonb_build_object('programs', _rows, 'generatedAt', now());
end;
$$;
revoke all on function public.list_programs(uuid, text, text, integer) from public, anon;
grant execute on function public.list_programs(uuid, text, text, integer) to authenticated, service_role;

-- ------------------------------------------------------ get_program_studio
create or replace function public.get_program_studio(_program_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _p public.programs%rowtype; _editable uuid; _out jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _p from public.programs where id = _program_id and deleted_at is null;
  if not found then raise exception 'program not found' using errcode = 'P0002'; end if;
  if not private.is_org_member(_p.organization_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  select id into _editable from public.program_versions
  where program_id = _program_id and status in ('draft','in_review')
  order by version desc limit 1;

  select jsonb_build_object(
    'program', jsonb_build_object(
      'id', _p.id, 'name', _p.name, 'description', _p.description,
      'status', _p.status, 'archivedAt', _p.archived_at, 'updatedAt', _p.updated_at,
      'publishedVersionId', _p.published_version_id),
    'canAuthor', private.can_author_program(_p.organization_id),
    'editable', case when _editable is null then null
                     else private.program_version_json(_editable) end,
    'published', case when _p.published_version_id is null then null
                      else private.program_version_json(_p.published_version_id) end,
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'version', v.version, 'status', v.status, 'title', v.title,
        'approvedAt', v.approved_at, 'publishedAt', v.published_at,
        'createdAt', v.created_at, 'supersedesVersionId', v.supersedes_version_id
      ) order by v.version desc)
      from public.program_versions v where v.program_id = _program_id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'versionId', ev.version_id, 'fromStatus', ev.from_status,
        'toStatus', ev.to_status, 'note', ev.note, 'createdAt', ev.created_at
      ) order by ev.created_at desc)
      from (select e.version_id, e.from_status, e.to_status, e.note, e.created_at
            from public.program_version_events e
            join public.program_versions v2 on v2.id = e.version_id
            where v2.program_id = _program_id
            order by e.created_at desc limit 50) ev), '[]'::jsonb),
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'name', o.name, 'priceCents', o.price_cents,
        'currency', o.currency, 'accessDurationDays', o.access_duration_days,
        'paymentMode', o.payment_mode, 'enrollmentOpen', o.enrollment_open,
        'status', o.status) order by o.created_at)
      from public.program_offers o where o.program_id = _program_id), '[]'::jsonb),
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object(
        'enrollmentId', e.id, 'patientId', e.patient_id,
        'patientName', btrim(coalesce(pp.first_name,'') || ' ' || coalesce(pp.last_name,'')),
        'status', e.status, 'pinnedVersion', ev2.version,
        'enrolledAt', e.enrolled_at, 'startedAt', e.started_at,
        'expiresAt', e.expires_at, 'completedAt', e.completed_at,
        'compReason', e.comp_reason,
        'lastActivityAt', (select max(pr.completed_at) from public.program_progress pr
                           where pr.enrollment_id = e.id),
        'progressCount', (select count(*) from public.program_progress pr
                          where pr.enrollment_id = e.id),
        'needsReviewCount', (select count(*) from public.program_progress pr
                             where pr.enrollment_id = e.id and pr.needs_review)
      ) order by e.enrolled_at desc)
      from (select * from public.program_enrollments en
            where en.program_id = _program_id and en.deleted_at is null
            order by en.enrolled_at desc limit 200) e
      join public.patient_profiles pp on pp.id = e.patient_id
      left join public.program_versions ev2 on ev2.id = e.program_version_id
    ), '[]'::jsonb),
    'generatedAt', now()
  ) into _out;
  return _out;
end;
$$;
revoke all on function public.get_program_studio(uuid) from public, anon;
grant execute on function public.get_program_studio(uuid) to authenticated, service_role;

-- --------------------------------------------------- list_program_templates
create or replace function public.list_program_templates(
  _organization_id uuid, _include_archived boolean default false
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'description', t.description,
      'status', t.status, 'archivedAt', t.archived_at,
      'approvedVersionId', t.approved_version_id,
      'approvedVersion', t.approved_version,
      'currentVersionId', t.current_version_id,
      'updatedAt', t.updated_at) order by t.updated_at desc)
    from public.program_templates t
    where t.organization_id = _organization_id and t.deleted_at is null
      and (_include_archived or t.status <> 'archived')
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_program_templates(uuid, boolean) from public, anon;
grant execute on function public.list_program_templates(uuid, boolean) to authenticated, service_role;

-- ------------------------------------------------- content copy (detached)
create or replace function private.copy_program_content(
  _from_version uuid, _to_version uuid, _organization_id uuid
) returns void language plpgsql security definer set search_path = ''
as $$
declare _m record; _l record; _b record; _new_m uuid; _new_l uuid;
begin
  for _m in select * from public.program_modules
    where version_id = _from_version order by position, created_at
  loop
    insert into public.program_modules (organization_id, version_id, name, summary, position)
    values (_organization_id, _to_version, _m.name, _m.summary, _m.position)
    returning id into _new_m;
    for _l in select * from public.program_lessons
      where module_id = _m.id order by position, created_at
    loop
      insert into public.program_lessons
        (organization_id, version_id, module_id, title, summary, position)
      values (_organization_id, _to_version, _new_m, _l.title, _l.summary, _l.position)
      returning id into _new_l;
      for _b in select * from public.program_blocks
        where lesson_id = _l.id order by position, created_at
      loop
        insert into public.program_blocks
          (organization_id, version_id, lesson_id, kind, title, content,
           is_commercial, position)
        values (_organization_id, _to_version, _new_l, _b.kind, _b.title,
                _b.content, _b.is_commercial, _b.position);
      end loop;
    end loop;
  end loop;
end;
$$;
revoke all on function private.copy_program_content(uuid, uuid, uuid) from public, anon;
grant execute on function private.copy_program_content(uuid, uuid, uuid) to authenticated, service_role;

-- ----------------------------------------------------------- create_program
create or replace function public.create_program(
  _organization_id uuid, _name text, _from_template_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _tpl public.program_templates%rowtype;
        _tv public.program_versions%rowtype; _pid uuid; _vid uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not private.can_author_program(_organization_id) then
    raise exception 'not authorized to author programs' using errcode = '42501';
  end if;
  if coalesce(btrim(_name),'') = '' then
    raise exception 'a program name is required' using errcode = '22023';
  end if;
  if length(_name) > 200 then raise exception 'name too long' using errcode = '22023'; end if;

  if _from_template_id is not null then
    select * into _tpl from public.program_templates
    where id = _from_template_id and deleted_at is null;
    if not found then raise exception 'template not found' using errcode = 'P0002'; end if;
    if _tpl.organization_id <> _organization_id then
      raise exception 'template belongs to another organization' using errcode = '42501';
    end if;
    if _tpl.status <> 'approved' or _tpl.approved_version_id is null then
      raise exception 'only approved templates can start a program' using errcode = '22023';
    end if;
    select * into _tv from public.program_versions where id = _tpl.approved_version_id;
    if not found then raise exception 'template version not found' using errcode = 'P0002'; end if;
  end if;

  insert into public.programs (organization_id, name, description, status, created_by, updated_by)
  values (_organization_id, btrim(_name), _tv.summary, 'draft', _uid, _uid)
  returning id into _pid;

  insert into public.program_versions
    (organization_id, program_id, version, status, title, summary, audience,
     disclaimer, source_template_id, source_template_version, created_by, updated_by)
  values
    (_organization_id, _pid, 1, 'draft', btrim(_name), _tv.summary, _tv.audience,
     _tv.disclaimer, _from_template_id, _tv.version, _uid, _uid)
  returning id into _vid;

  -- A template copy is fully DETACHED: fresh rows, no back-reference edits.
  if _tv.id is not null then
    perform private.copy_program_content(_tv.id, _vid, _organization_id);
  end if;

  update public.programs set current_version_id = _vid, updated_at = now() where id = _pid;
  insert into public.program_version_events
    (organization_id, version_id, from_status, to_status, actor_user_id)
  values (_organization_id, _vid, null, 'draft', _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_organization_id, _uid, 'program.created', 'program', _pid::text,
    'Program draft created',
    jsonb_build_object('fromTemplate', _from_template_id is not null));

  return jsonb_build_object('ok', true, 'programId', _pid, 'versionId', _vid,
    'message', case when _tv.id is not null
      then 'Program created from the approved template.' else 'Blank program created.' end);
end;
$$;
revoke all on function public.create_program(uuid, text, uuid) from public, anon;
grant execute on function public.create_program(uuid, text, uuid) to authenticated, service_role;

-- ------------------------------------------------------- save_program_draft
-- Wholesale replace of metadata + curriculum with optimistic concurrency.
-- Block content is validated per kind; ids are returned in payload order.
create or replace function public.save_program_draft(
  _version_id uuid, _payload jsonb, _expected_updated_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := auth.uid(); _v public.program_versions%rowtype;
  _mod jsonb; _les jsonb; _blk jsonb;
  _mid uuid; _lid uuid; _bid uuid;
  _mi integer := 0; _li integer; _bi integer;
  _module_ids uuid[] := '{}'; _lesson_ids uuid[] := '{}'; _block_ids uuid[] := '{}';
  _kind text; _content jsonb; _q jsonb; _qi integer;
  _lesson_total integer := 0; _block_total integer := 0;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if _payload is null or jsonb_typeof(_payload) <> 'object' then
    raise exception 'invalid payload' using errcode = '22023';
  end if;
  select * into _v from public.program_versions where id = _version_id for update;
  if not found then raise exception 'program version not found' using errcode = 'P0002'; end if;
  if not private.can_author_program(_v.organization_id) then
    raise exception 'not authorized to edit this program' using errcode = '42501';
  end if;
  if _v.status not in ('draft','in_review') then
    raise exception 'only a draft or in-review version can be edited; revise into a new draft'
      using errcode = '22023';
  end if;
  if _expected_updated_at is not null
     and date_trunc('milliseconds', _expected_updated_at)
         <> date_trunc('milliseconds', _v.updated_at) then
    raise exception 'this draft changed elsewhere since it was loaded' using errcode = '40001';
  end if;
  if jsonb_array_length(coalesce(_payload->'modules','[]'::jsonb)) > 24 then
    raise exception 'too many modules (max 24)' using errcode = '22023';
  end if;

  update public.program_versions set
    title = coalesce(nullif(btrim(coalesce(_payload->>'title','')),''), _v.title),
    summary = left(_payload->>'summary', 4000),
    audience = left(_payload->>'audience', 1000),
    disclaimer = left(_payload->>'disclaimer', 4000),
    updated_by = _uid, updated_at = now()
  where id = _version_id;

  delete from public.program_blocks where version_id = _version_id;
  delete from public.program_lessons where version_id = _version_id;
  delete from public.program_modules where version_id = _version_id;

  for _mod in select * from jsonb_array_elements(coalesce(_payload->'modules','[]'::jsonb))
  loop
    if coalesce(btrim(_mod->>'name'),'') = '' then
      raise exception 'each module needs a name' using errcode = '22023';
    end if;
    insert into public.program_modules (organization_id, version_id, name, summary, position)
    values (_v.organization_id, _version_id, left(btrim(_mod->>'name'),160),
            left(_mod->>'summary',2000), _mi)
    returning id into _mid;
    _module_ids := _module_ids || _mid; _mi := _mi + 1;

    _li := 0;
    for _les in select * from jsonb_array_elements(coalesce(_mod->'lessons','[]'::jsonb))
    loop
      _lesson_total := _lesson_total + 1;
      if _lesson_total > 150 then
        raise exception 'too many lessons (max 150)' using errcode = '22023';
      end if;
      if coalesce(btrim(_les->>'title'),'') = '' then
        raise exception 'each lesson needs a title' using errcode = '22023';
      end if;
      insert into public.program_lessons
        (organization_id, version_id, module_id, title, summary, position)
      values (_v.organization_id, _version_id, _mid, left(btrim(_les->>'title'),200),
              left(_les->>'summary',2000), _li)
      returning id into _lid;
      _lesson_ids := _lesson_ids || _lid; _li := _li + 1;

      _bi := 0;
      for _blk in select * from jsonb_array_elements(coalesce(_les->'blocks','[]'::jsonb))
      loop
        _block_total := _block_total + 1;
        if _block_total > 500 then
          raise exception 'too many content blocks (max 500)' using errcode = '22023';
        end if;
        _kind := _blk->>'kind';
        _content := coalesce(_blk->'content','{}'::jsonb);
        if jsonb_typeof(_content) <> 'object' or length(_content::text) > 20000 then
          raise exception 'invalid block content' using errcode = '22023';
        end if;
        -- Every declared block kind is validated; nothing unknown is stored.
        if _kind = 'text' then
          if coalesce(btrim(_content->>'body'),'') = '' then
            raise exception 'a text block needs a body' using errcode = '22023';
          end if;
        elsif _kind in ('image','video_url','document_link','resource') then
          if coalesce(_content->>'url','') !~ '^https?://' then
            raise exception 'a % block needs an http(s) url', _kind using errcode = '22023';
          end if;
        elsif _kind = 'quiz' then
          _q := _content->'questions';
          if _q is null or jsonb_typeof(_q) <> 'array'
             or jsonb_array_length(_q) < 1 or jsonb_array_length(_q) > 20 then
            raise exception 'a quiz needs 1-20 questions' using errcode = '22023';
          end if;
          for _qi in 0 .. jsonb_array_length(_q) - 1 loop
            if coalesce(btrim(_q->_qi->>'prompt'),'') = ''
               or jsonb_typeof(_q->_qi->'options') <> 'array'
               or jsonb_array_length(_q->_qi->'options') < 2
               or jsonb_array_length(_q->_qi->'options') > 8 then
              raise exception 'each quiz question needs a prompt and 2-8 options'
                using errcode = '22023';
            end if;
            if _q->_qi->>'answerIndex' is not null
               and ((_q->_qi->>'answerIndex')::int < 0
                    or (_q->_qi->>'answerIndex')::int >= jsonb_array_length(_q->_qi->'options')) then
              raise exception 'quiz answerIndex out of range' using errcode = '22023';
            end if;
          end loop;
        elsif _kind = 'check_in' then
          if coalesce(btrim(_content->>'prompt'),'') = ''
             or coalesce(_content->>'responseType','')
                 not in ('text','scale_1_5','yes_no','number') then
            raise exception 'a check-in needs a prompt and a valid responseType'
              using errcode = '22023';
          end if;
        else
          raise exception 'unknown block kind' using errcode = '22023';
        end if;

        insert into public.program_blocks
          (organization_id, version_id, lesson_id, kind, title, content,
           is_commercial, position)
        values (_v.organization_id, _version_id, _lid, _kind,
                left(_blk->>'title',200), _content,
                coalesce((_blk->>'isCommercial')::boolean, false), _bi)
        returning id into _bid;
        _block_ids := _block_ids || _bid; _bi := _bi + 1;
      end loop;
    end loop;
  end loop;

  select * into _v from public.program_versions where id = _version_id;
  return jsonb_build_object('ok', true, 'versionId', _version_id,
    'updatedAt', _v.updated_at,
    'moduleIds', to_jsonb(_module_ids), 'lessonIds', to_jsonb(_lesson_ids),
    'blockIds', to_jsonb(_block_ids), 'message', 'Draft saved.');
end;
$$;
revoke all on function public.save_program_draft(uuid, jsonb, timestamptz) from public, anon;
grant execute on function public.save_program_draft(uuid, jsonb, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------- lifecycle transitions
create or replace function private.program_version_transition(
  _version_id uuid, _to text, _note text
) returns public.program_versions language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _v public.program_versions%rowtype; _ok boolean;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _v from public.program_versions where id = _version_id for update;
  if not found then raise exception 'program version not found' using errcode = 'P0002'; end if;
  if _v.program_id is null then
    raise exception 'this transition applies to program versions' using errcode = '22023';
  end if;
  if not private.can_author_program(_v.organization_id) then
    raise exception 'not authorized to manage this program' using errcode = '42501';
  end if;
  _ok := (_v.status = 'draft' and _to = 'in_review')
      or (_v.status = 'in_review' and _to in ('draft','approved'))
      or (_v.status = 'approved' and _to = 'published');
  if not _ok then
    raise exception 'a % version cannot move to %', _v.status, _to using errcode = '22023';
  end if;

  update public.program_versions set
    status = _to,
    review_note = case when _to in ('draft','approved') then coalesce(_note, review_note)
                       else review_note end,
    approved_at = case when _to = 'approved' then now() else approved_at end,
    approved_by = case when _to = 'approved' then _uid else approved_by end,
    published_at = case when _to = 'published' then now() else published_at end,
    published_by = case when _to = 'published' then _uid else published_by end,
    updated_by = _uid, updated_at = now()
  where id = _version_id;

  insert into public.program_version_events
    (organization_id, version_id, from_status, to_status, note, actor_user_id)
  values (_v.organization_id, _version_id, _v.status, _to, left(_note, 500), _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_v.organization_id, _uid, 'program.version_' || _to, 'program_version',
    _version_id::text, 'Program version ' || replace(_to,'_',' '),
    jsonb_build_object('programId', _v.program_id, 'version', _v.version,
                       'fromStatus', _v.status));

  select * into _v from public.program_versions where id = _version_id;
  return _v;
end;
$$;
revoke all on function private.program_version_transition(uuid, text, text) from public, anon;
grant execute on function private.program_version_transition(uuid, text, text) to authenticated, service_role;

create or replace function public.submit_program_version(_version_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _v public.program_versions%rowtype;
begin
  _v := private.program_version_transition(_version_id, 'in_review', null);
  return jsonb_build_object('ok', true, 'versionId', _v.id, 'status', _v.status,
    'message', 'Version submitted for review.');
end;
$$;
create or replace function public.return_program_version(_version_id uuid, _note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _v public.program_versions%rowtype;
begin
  _v := private.program_version_transition(_version_id, 'draft', _note);
  return jsonb_build_object('ok', true, 'versionId', _v.id, 'status', _v.status,
    'message', 'Version returned to draft for changes.');
end;
$$;
create or replace function public.approve_program_version(_version_id uuid, _note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _v public.program_versions%rowtype;
begin
  _v := private.program_version_transition(_version_id, 'approved', _note);
  return jsonb_build_object('ok', true, 'versionId', _v.id, 'status', _v.status,
    'message', 'Version approved and frozen. It is NOT published until you publish it.');
end;
$$;

-- Publishing exposes content. It supersedes the previously published version
-- WITHOUT touching enrollments pinned to it, and creates NO enrollment,
-- charge, invoice, message, protocol, order, task, or note.
create or replace function public.publish_program_version(_version_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _v public.program_versions%rowtype; _prev uuid;
begin
  _v := private.program_version_transition(_version_id, 'published', null);
  select published_version_id into _prev from public.programs
  where id = _v.program_id for update;
  if _prev is not null and _prev <> _version_id then
    update public.program_versions set status = 'superseded', updated_at = now()
    where id = _prev;
    insert into public.program_version_events
      (organization_id, version_id, from_status, to_status, actor_user_id)
    values (_v.organization_id, _prev, 'published', 'superseded', _uid);
  end if;
  update public.programs set
    status = 'published', published_version_id = _version_id,
    current_version_id = _version_id, updated_by = _uid, updated_at = now()
  where id = _v.program_id;
  return jsonb_build_object('ok', true, 'versionId', _version_id,
    'version', _v.version, 'status', 'published',
    'message', 'Version published. Existing enrollments keep their pinned version.');
end;
$$;

create or replace function public.revise_program_version(_version_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _src public.program_versions%rowtype;
        _next integer; _new uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _src from public.program_versions where id = _version_id;
  if not found then raise exception 'program version not found' using errcode = 'P0002'; end if;
  if _src.program_id is null then
    raise exception 'revise applies to program versions' using errcode = '22023';
  end if;
  if not private.can_author_program(_src.organization_id) then
    raise exception 'not authorized to manage this program' using errcode = '42501';
  end if;
  if _src.status not in ('approved','published','superseded') then
    raise exception 'only a frozen version can be revised' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(_src.program_id::text || ':program-version', 0));
  if exists (select 1 from public.program_versions
             where program_id = _src.program_id and status in ('draft','in_review')) then
    raise exception 'a draft version already exists for this program' using errcode = '22023';
  end if;
  select coalesce(max(version),0)+1 into _next from public.program_versions
  where program_id = _src.program_id;

  insert into public.program_versions
    (organization_id, program_id, version, status, title, summary, audience,
     disclaimer, supersedes_version_id, created_by, updated_by)
  values (_src.organization_id, _src.program_id, _next, 'draft', _src.title,
     _src.summary, _src.audience, _src.disclaimer, _version_id, _uid, _uid)
  returning id into _new;
  perform private.copy_program_content(_version_id, _new, _src.organization_id);
  update public.programs set current_version_id = _new, updated_by = _uid, updated_at = now()
  where id = _src.program_id;
  insert into public.program_version_events
    (organization_id, version_id, from_status, to_status, actor_user_id)
  values (_src.organization_id, _new, null, 'draft', _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_src.organization_id, _uid, 'program.version_revised', 'program_version',
    _new::text, 'Program version revised into a new draft',
    jsonb_build_object('programId', _src.program_id, 'fromVersion', _src.version,
                       'newVersion', _next));
  return jsonb_build_object('ok', true, 'versionId', _new, 'version', _next,
    'supersedesVersionId', _version_id,
    'message', 'New draft version ' || _next || ' created. Version ' || _src.version || ' is unchanged.');
end;
$$;
revoke all on function public.submit_program_version(uuid) from public, anon;
revoke all on function public.return_program_version(uuid, text) from public, anon;
revoke all on function public.approve_program_version(uuid, text) from public, anon;
revoke all on function public.publish_program_version(uuid) from public, anon;
revoke all on function public.revise_program_version(uuid) from public, anon;
grant execute on function public.submit_program_version(uuid) to authenticated, service_role;
grant execute on function public.return_program_version(uuid, text) to authenticated, service_role;
grant execute on function public.approve_program_version(uuid, text) to authenticated, service_role;
grant execute on function public.publish_program_version(uuid) to authenticated, service_role;
grant execute on function public.revise_program_version(uuid) to authenticated, service_role;

-- ----------------------------------------------------------- archive_program
create or replace function public.archive_program(_program_id uuid, _archived boolean default true)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _p public.programs%rowtype;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _p from public.programs where id = _program_id and deleted_at is null for update;
  if not found then raise exception 'program not found' using errcode = 'P0002'; end if;
  if not private.can_author_program(_p.organization_id) then
    raise exception 'not authorized to manage this program' using errcode = '42501';
  end if;
  update public.programs set
    status = case when _archived then 'archived'
                  when _p.published_version_id is not null then 'published'
                  else 'draft' end,
    archived_at = case when _archived then now() else null end,
    updated_by = _uid, updated_at = now()
  where id = _program_id;
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_p.organization_id, _uid,
    case when _archived then 'program.archived' else 'program.restored' end,
    'program', _program_id::text,
    case when _archived then 'Program archived' else 'Program restored' end,
    '{}'::jsonb);
  return jsonb_build_object('ok', true, 'programId', _program_id, 'archived', _archived,
    'message', case when _archived
      then 'Program archived. Published history and enrollments are preserved.'
      else 'Program restored.' end);
end;
$$;
revoke all on function public.archive_program(uuid, boolean) from public, anon;
grant execute on function public.archive_program(uuid, boolean) to authenticated, service_role;

-- ------------------------------------------------------------- templates
create or replace function public.create_program_template(
  _organization_id uuid, _name text, _description text default null,
  _from_version_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _src public.program_versions%rowtype;
        _tid uuid; _vid uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not private.can_author_program(_organization_id) then
    raise exception 'not authorized to author program templates' using errcode = '42501';
  end if;
  if coalesce(btrim(_name),'') = '' then
    raise exception 'a template name is required' using errcode = '22023';
  end if;
  if _from_version_id is not null then
    select * into _src from public.program_versions where id = _from_version_id;
    if not found then raise exception 'source version not found' using errcode = 'P0002'; end if;
    if _src.organization_id <> _organization_id then
      raise exception 'source version belongs to another organization' using errcode = '42501';
    end if;
  end if;

  insert into public.program_templates
    (organization_id, name, description, status, created_by, updated_by)
  values (_organization_id, btrim(_name), _description, 'draft', _uid, _uid)
  returning id into _tid;
  insert into public.program_versions
    (organization_id, template_id, version, status, title, summary, audience,
     disclaimer, created_by, updated_by)
  values (_organization_id, _tid, 1, 'draft', btrim(_name), _src.summary,
     _src.audience, _src.disclaimer, _uid, _uid)
  returning id into _vid;
  if _src.id is not null then
    perform private.copy_program_content(_src.id, _vid, _organization_id);
  end if;
  update public.program_templates set current_version_id = _vid, updated_at = now()
  where id = _tid;
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_organization_id, _uid, 'program.template_created', 'program_template',
    _tid::text, 'Program template created',
    jsonb_build_object('fromVersion', _from_version_id is not null));
  return jsonb_build_object('ok', true, 'templateId', _tid, 'versionId', _vid,
    'message', case when _src.id is not null
      then 'Template created as a detached copy of that version.'
      else 'Blank template created.' end);
end;
$$;
create or replace function public.approve_program_template_version(_version_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _v public.program_versions%rowtype;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _v from public.program_versions where id = _version_id for update;
  if not found or _v.template_id is null then
    raise exception 'template version not found' using errcode = 'P0002';
  end if;
  if not private.can_author_program(_v.organization_id) then
    raise exception 'not authorized to manage program templates' using errcode = '42501';
  end if;
  if _v.status <> 'draft' then
    raise exception 'only a draft template version can be approved' using errcode = '22023';
  end if;
  update public.program_versions set status = 'approved', approved_at = now(),
    approved_by = _uid, updated_by = _uid, updated_at = now()
  where id = _version_id;
  update public.program_templates set status = 'approved',
    approved_version_id = _version_id, approved_version = _v.version,
    updated_by = _uid, updated_at = now()
  where id = _v.template_id;
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_v.organization_id, _uid, 'program.template_approved', 'program_version',
    _version_id::text, 'Program template version approved',
    jsonb_build_object('templateId', _v.template_id, 'version', _v.version));
  return jsonb_build_object('ok', true, 'versionId', _version_id,
    'message', 'Template version approved.');
end;
$$;
create or replace function public.archive_program_template(
  _template_id uuid, _archived boolean default true
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _t public.program_templates%rowtype;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _t from public.program_templates
  where id = _template_id and deleted_at is null for update;
  if not found then raise exception 'template not found' using errcode = 'P0002'; end if;
  if not private.can_author_program(_t.organization_id) then
    raise exception 'not authorized to manage program templates' using errcode = '42501';
  end if;
  -- Archiving NEVER cascades into programs created from this template.
  update public.program_templates set
    status = case when _archived then 'archived'
                  when _t.approved_version_id is not null then 'approved' else 'draft' end,
    archived_at = case when _archived then now() else null end,
    updated_by = _uid, updated_at = now()
  where id = _template_id;
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_t.organization_id, _uid,
    case when _archived then 'program.template_archived' else 'program.template_restored' end,
    'program_template', _template_id::text,
    case when _archived then 'Program template archived' else 'Program template restored' end,
    '{}'::jsonb);
  return jsonb_build_object('ok', true, 'templateId', _template_id, 'archived', _archived,
    'message', case when _archived
      then 'Template archived. Programs created from it are untouched.'
      else 'Template restored.' end);
end;
$$;
revoke all on function public.create_program_template(uuid, text, text, uuid) from public, anon;
revoke all on function public.approve_program_template_version(uuid) from public, anon;
revoke all on function public.archive_program_template(uuid, boolean) from public, anon;
grant execute on function public.create_program_template(uuid, text, text, uuid) to authenticated, service_role;
grant execute on function public.approve_program_template_version(uuid) to authenticated, service_role;
grant execute on function public.archive_program_template(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------- offers
create or replace function public.upsert_program_offer(
  _program_id uuid, _offer_id uuid default null, _name text default null,
  _price_cents integer default 0, _currency text default 'usd',
  _access_duration_days integer default null, _payment_mode text default 'free',
  _enrollment_open boolean default true, _status text default 'active'
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _p public.programs%rowtype; _oid uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _p from public.programs where id = _program_id and deleted_at is null;
  if not found then raise exception 'program not found' using errcode = 'P0002'; end if;
  if not private.can_author_program(_p.organization_id) then
    raise exception 'not authorized to manage program offers' using errcode = '42501';
  end if;
  if _payment_mode not in ('free','manual_comp','stripe') then
    raise exception 'unknown payment mode' using errcode = '22023';
  end if;
  if _status not in ('active','retired') then
    raise exception 'unknown offer status' using errcode = '22023';
  end if;
  if _offer_id is null then
    if coalesce(btrim(_name),'') = '' then
      raise exception 'an offer name is required' using errcode = '22023';
    end if;
    insert into public.program_offers
      (organization_id, program_id, name, price_cents, currency,
       access_duration_days, payment_mode, enrollment_open, status,
       created_by, updated_by)
    values (_p.organization_id, _program_id, btrim(_name),
       greatest(coalesce(_price_cents,0),0), lower(coalesce(_currency,'usd')),
       _access_duration_days, _payment_mode, _enrollment_open, _status, _uid, _uid)
    returning id into _oid;
  else
    update public.program_offers set
      name = coalesce(nullif(btrim(coalesce(_name,'')),''), name),
      price_cents = greatest(coalesce(_price_cents, price_cents),0),
      currency = lower(coalesce(_currency, currency)),
      access_duration_days = _access_duration_days,
      payment_mode = _payment_mode, enrollment_open = _enrollment_open,
      status = _status, updated_by = _uid, updated_at = now()
    where id = _offer_id and program_id = _program_id
      and organization_id = _p.organization_id
    returning id into _oid;
    if _oid is null then raise exception 'offer not found' using errcode = 'P0002'; end if;
  end if;
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_p.organization_id, _uid, 'program.offer_saved', 'program_offer',
    _oid::text, 'Program offer saved',
    jsonb_build_object('programId', _program_id, 'paymentMode', _payment_mode));
  return jsonb_build_object('ok', true, 'offerId', _oid,
    'message', 'Offer saved. No payment is processed by this application.');
end;
$$;
revoke all on function public.upsert_program_offer(uuid, uuid, text, integer, text, integer, text, boolean, text) from public, anon;
grant execute on function public.upsert_program_offer(uuid, uuid, text, integer, text, integer, text, boolean, text) to authenticated, service_role;

-- ------------------------------------------------------------- enrollment
create or replace function public.enroll_patient_in_program(
  _program_id uuid, _patient_id uuid, _offer_id uuid default null,
  _activate boolean default true, _comp_reason text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _p public.programs%rowtype;
        _o public.program_offers%rowtype; _eid uuid; _status text;
        _expires timestamptz;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _p from public.programs where id = _program_id and deleted_at is null;
  if not found then raise exception 'program not found' using errcode = 'P0002'; end if;
  if not private.can_author_program(_p.organization_id) then
    raise exception 'not authorized to manage enrollments' using errcode = '42501';
  end if;
  if not private.can_write_patient_data(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  -- Tenant agreement: patient and program in the same organization.
  if not exists (select 1 from public.patient_profiles pp
                 where pp.id = _patient_id
                   and pp.organization_id = _p.organization_id
                   and pp.deleted_at is null) then
    raise exception 'patient does not belong to this organization' using errcode = '42501';
  end if;
  if _p.status = 'archived' then
    raise exception 'an archived program cannot take new enrollments' using errcode = '22023';
  end if;
  if _p.published_version_id is null then
    raise exception 'this program has no published version to enroll into' using errcode = '22023';
  end if;
  if _offer_id is not null then
    select * into _o from public.program_offers where id = _offer_id;
    if not found then raise exception 'offer not found' using errcode = 'P0002'; end if;
    if _o.program_id <> _program_id or _o.organization_id <> _p.organization_id then
      raise exception 'offer does not belong to this program' using errcode = '42501';
    end if;
    if _o.status <> 'active' or not _o.enrollment_open then
      raise exception 'this offer is not open for enrollment' using errcode = '22023';
    end if;
    if _o.payment_mode = 'stripe' then
      -- HONEST REFUSAL: no verified payment integration exists. Enrollment
      -- must never claim a payment happened.
      raise exception 'Stripe payment processing is not configured; this offer cannot enroll patients yet'
        using errcode = '22023';
    end if;
    if _o.payment_mode = 'manual_comp'
       and coalesce(btrim(_comp_reason),'') = '' then
      raise exception 'a complimentary enrollment requires a reason' using errcode = '22023';
    end if;
  end if;
  if exists (select 1 from public.program_enrollments e
             where e.program_id = _program_id and e.patient_id = _patient_id
               and e.deleted_at is null
               and e.status in ('invited','active','paused')) then
    raise exception 'this patient already has an open enrollment in this program'
      using errcode = '22023';
  end if;

  _status := case when _activate then 'active' else 'invited' end;
  _expires := case when _activate and _o.access_duration_days is not null
                   then now() + make_interval(days => _o.access_duration_days) end;
  insert into public.program_enrollments
    (organization_id, patient_id, program_id, program_version_id, offer_id,
     status, enrolled_at, invited_at, started_at, expires_at, comp_reason,
     authorized_by, source, created_by, updated_by)
  values
    (_p.organization_id, _patient_id, _program_id, _p.published_version_id,
     _offer_id, _status, now(),
     case when _status = 'invited' then now() end,
     case when _status = 'active' then now() end,
     _expires, nullif(btrim(coalesce(_comp_reason,'')),''), _uid, 'manual', _uid, _uid)
  returning id into _eid;

  insert into public.program_enrollment_events
    (organization_id, enrollment_id, from_status, to_status,
     reason, actor_user_id)
  values (_p.organization_id, _eid, null, _status,
     nullif(btrim(coalesce(_comp_reason,'')),''), _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_p.organization_id, _uid, 'program.enrolled', 'program_enrollment',
    _eid::text, 'Patient enrolled in a program', _patient_id,
    jsonb_build_object('programId', _program_id,
      'pinnedVersionId', _p.published_version_id, 'status', _status,
      'comp', _o.payment_mode = 'manual_comp'));

  return jsonb_build_object('ok', true, 'enrollmentId', _eid, 'status', _status,
    'pinnedVersionId', _p.published_version_id,
    'message', case when _status = 'active'
      then 'Enrollment active, pinned to the published version.'
      else 'Invitation recorded, pinned to the published version.' end);
end;
$$;
revoke all on function public.enroll_patient_in_program(uuid, uuid, uuid, boolean, text) from public, anon;
grant execute on function public.enroll_patient_in_program(uuid, uuid, uuid, boolean, text) to authenticated, service_role;

create or replace function public.set_program_enrollment_status(
  _enrollment_id uuid, _status text, _reason text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _e public.program_enrollments%rowtype;
        _o public.program_offers%rowtype; _ok boolean;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _e from public.program_enrollments
  where id = _enrollment_id and deleted_at is null for update;
  if not found then raise exception 'enrollment not found' using errcode = 'P0002'; end if;
  if not private.can_author_program(_e.organization_id) then
    raise exception 'not authorized to manage enrollments' using errcode = '42501';
  end if;
  if not private.can_write_patient_data(_e.patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  _ok := (_e.status = 'invited' and _status in ('active','cancelled'))
      or (_e.status = 'active' and _status in ('paused','completed','cancelled','expired'))
      or (_e.status = 'paused' and _status in ('active','cancelled','expired'));
  if not _ok then
    raise exception 'an enrollment cannot move from % to %', _e.status, _status
      using errcode = '22023';
  end if;
  if _e.offer_id is not null then
    select * into _o from public.program_offers where id = _e.offer_id;
  end if;
  update public.program_enrollments set
    status = _status, status_reason = left(_reason, 500),
    started_at = case when _status = 'active' and started_at is null then now()
                      else started_at end,
    expires_at = case when _status = 'active' and expires_at is null
                        and _o.access_duration_days is not null
                      then now() + make_interval(days => _o.access_duration_days)
                      else expires_at end,
    completed_at = case when _status = 'completed' then now() else completed_at end,
    updated_by = _uid, updated_at = now()
  where id = _enrollment_id;
  insert into public.program_enrollment_events
    (organization_id, enrollment_id, from_status, to_status, reason, actor_user_id)
  values (_e.organization_id, _enrollment_id, _e.status, _status, left(_reason,500), _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_e.organization_id, _uid, 'program.enrollment_' || _status,
    'program_enrollment', _enrollment_id::text,
    'Program enrollment ' || _status, _e.patient_id,
    jsonb_build_object('fromStatus', _e.status));
  return jsonb_build_object('ok', true, 'enrollmentId', _enrollment_id,
    'status', _status, 'previousStatus', _e.status,
    'message', 'Enrollment ' || _status || '.');
end;
$$;
revoke all on function public.set_program_enrollment_status(uuid, text, text) from public, anon;
grant execute on function public.set_program_enrollment_status(uuid, text, text) to authenticated, service_role;

-- --------------------------------------------------------------- progress
create or replace function public.record_program_progress(
  _enrollment_id uuid, _kind text, _lesson_id uuid default null,
  _block_id uuid default null, _payload jsonb default '{}'::jsonb,
  _needs_review boolean default false
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _e public.program_enrollments%rowtype; _pid uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if _kind not in ('lesson_completed','check_in','quiz_response','adherence') then
    raise exception 'unknown progress kind' using errcode = '22023';
  end if;
  if _payload is null or jsonb_typeof(_payload) <> 'object'
     or length(_payload::text) > 8000 then
    raise exception 'invalid progress payload' using errcode = '22023';
  end if;
  select * into _e from public.program_enrollments
  where id = _enrollment_id and deleted_at is null;
  if not found then raise exception 'enrollment not found' using errcode = 'P0002'; end if;
  if not private.can_author_program(_e.organization_id) then
    raise exception 'not authorized to record program progress' using errcode = '42501';
  end if;
  if not private.can_write_patient_data(_e.patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  if _e.status <> 'active' then
    raise exception 'progress can only be recorded on an active enrollment'
      using errcode = '22023';
  end if;
  -- Version agreement: the lesson/block must belong to the enrollment's
  -- PINNED version — never another version, never another tenant.
  if _lesson_id is not null and not exists (
    select 1 from public.program_lessons l
    where l.id = _lesson_id and l.version_id = _e.program_version_id
      and l.organization_id = _e.organization_id) then
    raise exception 'lesson does not belong to the enrolled program version'
      using errcode = '22023';
  end if;
  if _block_id is not null and not exists (
    select 1 from public.program_blocks b
    where b.id = _block_id and b.version_id = _e.program_version_id
      and b.organization_id = _e.organization_id) then
    raise exception 'block does not belong to the enrolled program version'
      using errcode = '22023';
  end if;
  if _kind = 'lesson_completed' and _lesson_id is null then
    raise exception 'lesson_completed requires a lesson' using errcode = '22023';
  end if;

  insert into public.program_progress
    (organization_id, patient_id, enrollment_id, lesson_id, block_id, kind,
     payload, needs_review, recorded_by)
  values (_e.organization_id, _e.patient_id, _enrollment_id, _lesson_id,
     _block_id, _kind, _payload, coalesce(_needs_review,false), _uid)
  returning id into _pid;
  -- PHI-safe: the audit row carries identifiers and kind, never the payload.
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_e.organization_id, _uid, 'program.progress_recorded', 'program_progress',
    _pid::text, 'Program progress recorded', _e.patient_id,
    jsonb_build_object('enrollmentId', _enrollment_id, 'kind', _kind,
      'needsReview', coalesce(_needs_review,false)));
  return jsonb_build_object('ok', true, 'progressId', _pid,
    'message', 'Progress recorded.');
end;
$$;
create or replace function public.review_program_progress(_progress_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _pr public.program_progress%rowtype;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _pr from public.program_progress where id = _progress_id for update;
  if not found then raise exception 'progress entry not found' using errcode = 'P0002'; end if;
  if not private.can_author_program(_pr.organization_id) then
    raise exception 'not authorized to review program progress' using errcode = '42501';
  end if;
  if not private.can_write_patient_data(_pr.patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  if _pr.reviewed_at is not null then
    return jsonb_build_object('ok', true, 'progressId', _progress_id,
      'alreadyReviewed', true, 'message', 'This entry was already reviewed.');
  end if;
  update public.program_progress set needs_review = false,
    reviewed_by = _uid, reviewed_at = now()
  where id = _progress_id;
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_pr.organization_id, _uid, 'program.progress_reviewed', 'program_progress',
    _progress_id::text, 'Program progress reviewed', _pr.patient_id, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'progressId', _progress_id,
    'alreadyReviewed', false, 'message', 'Progress reviewed.');
end;
$$;
revoke all on function public.record_program_progress(uuid, text, uuid, uuid, jsonb, boolean) from public, anon;
revoke all on function public.review_program_progress(uuid) from public, anon;
grant execute on function public.record_program_progress(uuid, text, uuid, uuid, jsonb, boolean) to authenticated, service_role;
grant execute on function public.review_program_progress(uuid) to authenticated, service_role;

-- ---------------------------------------------------- get_patient_programs
create or replace function public.get_patient_programs(_patient_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  return jsonb_build_object('enrollments', coalesce((
    select jsonb_agg(jsonb_build_object(
      'enrollmentId', e.id, 'programId', e.program_id,
      'programName', p.name, 'status', e.status,
      'pinnedVersion', v.version, 'pinnedVersionTitle', v.title,
      'enrolledAt', e.enrolled_at, 'startedAt', e.started_at,
      'expiresAt', e.expires_at, 'completedAt', e.completed_at,
      'lastActivityAt', (select max(pr.completed_at) from public.program_progress pr
                         where pr.enrollment_id = e.id),
      'progressCount', (select count(*) from public.program_progress pr
                        where pr.enrollment_id = e.id),
      'lessonsCompleted', (select count(*) from public.program_progress pr
                           where pr.enrollment_id = e.id
                             and pr.kind = 'lesson_completed'),
      'lessonTotal', (select count(*) from public.program_lessons l
                      where l.version_id = e.program_version_id),
      'needsReviewCount', (select count(*) from public.program_progress pr
                           where pr.enrollment_id = e.id and pr.needs_review)
    ) order by e.enrolled_at desc)
    from (select * from public.program_enrollments en
          where en.patient_id = _patient_id and en.deleted_at is null
          order by en.enrolled_at desc limit 50) e
    join public.programs p on p.id = e.program_id
    left join public.program_versions v on v.id = e.program_version_id
  ), '[]'::jsonb), 'generatedAt', now());
end;
$$;
revoke all on function public.get_patient_programs(uuid) from public, anon;
grant execute on function public.get_patient_programs(uuid) to authenticated, service_role;

commit;
