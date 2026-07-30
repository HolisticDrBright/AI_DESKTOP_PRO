-- desktop_protocol_rpcs
--
-- The write + read layer for versioned protocols and templates. Every function
-- follows the established Desktop contract: SECURITY DEFINER, pinned empty
-- search_path, explicit auth + membership + clinical-role + patient-access
-- gates, tenant agreement validated across every referenced record, bounded
-- outputs, typed errors (28000 / 42501 / P0002 / 22023 / 40001), PHI-safe
-- audit metadata, anon+public execution revoked.
--
--   get_patient_protocol(org, patient)        current draft + approved/active +
--                                            full version history (bounded)
--   create_protocol_draft(org, patient, …)    blank draft OR copy of an
--                                            approved template version
--   save_protocol_draft(version, payload, expected_updated_at)
--                                            autosave with optimistic
--                                            concurrency → 40001 on conflict
--   approve_protocol_version(version, note)   draft → approved (freezes it)
--   activate_protocol_version(version)        approved → active, SEPARATE and
--                                            separately permissioned
--   set_protocol_lifecycle(protocol, status)  pause / complete / discontinue
--   revise_protocol_version(version)          approved/active → NEW draft copy
--   list_protocol_templates(org)              org templates (bounded)
--   create_protocol_template(org, name, from_version)
--   approve_protocol_template_version(version)
--   archive_protocol_template(template, archived)
--
-- NOT PRESENT, deliberately: any code path that sends a message, places an
-- order, charges, modifies medications, writes into a note, or activates a
-- protocol implicitly. Activation is its own RPC with its own permission check
-- and the UI confirms it.

begin;

-- Clinical role gate for protocol authoring: owner/admin/practitioner with
-- write access to the patient. Staff may not author clinical instructions.
create or replace function private.can_author_protocol(
  _organization_id uuid,
  _patient_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner','admin','practitioner')
  )
  and (_patient_id is null or private.can_write_patient_data(_patient_id));
$$;
revoke all on function private.can_author_protocol(uuid, uuid) from public, anon;
grant execute on function private.can_author_protocol(uuid, uuid) to authenticated, service_role;

-- Bounded projection of one version with its phases and items.
create or replace function private.protocol_version_json(_version_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', v.id,
    'version', v.version,
    'status', v.status,
    'title', v.title,
    'summary', v.summary,
    'dietInstructions', v.diet_instructions,
    'lifestyleInstructions', v.lifestyle_instructions,
    'monitoringPlan', v.monitoring_plan,
    'followupPlan', v.followup_plan,
    'sourceTemplateId', v.source_template_id,
    'sourceTemplateVersion', v.source_template_version,
    'supersedesVersionId', v.supersedes_version_id,
    'approvedAt', v.approved_at,
    'activatedAt', v.activated_at,
    'reviewNote', v.review_note,
    'updatedAt', v.updated_at,
    'createdAt', v.created_at,
    'phases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ph.id, 'name', ph.name, 'position', ph.position,
        'startsOn', ph.starts_on, 'endsOn', ph.ends_on,
        'relativeStartDay', ph.relative_start_day,
        'relativeDurationDays', ph.relative_duration_days,
        'notes', ph.notes) order by ph.position, ph.created_at)
      from public.protocol_phases ph where ph.version_id = v.id), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', it.id, 'phaseId', it.phase_id, 'kind', it.kind,
        'position', it.position, 'label', it.label,
        'instructions', it.instructions,
        'catalogProductId', it.catalog_product_id,
        'catalogProductVersionId', it.catalog_product_version_id,
        'manufacturer', it.manufacturer, 'labelVersion', it.label_version,
        'dosageText', it.dosage_text, 'timingText', it.timing_text,
        'route', it.route,
        'verificationStatus', it.verification_status,
        'interactionReviewState', it.interaction_review_state,
        'affiliateUrl', it.affiliate_url) order by it.kind, it.position, it.created_at)
      from public.protocol_items it where it.version_id = v.id), '[]'::jsonb)
  )
  from public.protocol_versions v where v.id = _version_id;
$$;
revoke all on function private.protocol_version_json(uuid) from public, anon;
grant execute on function private.protocol_version_json(uuid) to authenticated, service_role;

-- ------------------------------------------------------------- read
create or replace function public.get_patient_protocol(
  _organization_id uuid,
  _patient_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _protocol public.protocols%rowtype;
  _history jsonb;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;

  select * into _protocol
  from public.protocols
  where patient_id = _patient_id
    and organization_id = _organization_id
    and deleted_at is null
  order by created_at desc
  limit 1;

  -- Honest empty state: no protocol exists yet.
  if not found then
    return jsonb_build_object(
      'exists', false,
      'canAuthor', private.can_author_protocol(_organization_id, _patient_id),
      'protocol', null, 'draft', null, 'approved', null, 'active', null,
      'history', '[]'::jsonb,
      'generatedAt', now());
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'version', v.version, 'status', v.status,
      'title', v.title, 'approvedAt', v.approved_at,
      'activatedAt', v.activated_at, 'createdAt', v.created_at,
      'supersedesVersionId', v.supersedes_version_id)
      order by v.version desc), '[]'::jsonb)
  into _history
  from public.protocol_versions v
  where v.protocol_id = _protocol.id;

  return jsonb_build_object(
    'exists', true,
    'canAuthor', private.can_author_protocol(_organization_id, _patient_id),
    'protocol', jsonb_build_object(
      'id', _protocol.id, 'title', _protocol.title, 'status', _protocol.status,
      'createdAt', _protocol.created_at, 'updatedAt', _protocol.updated_at),
    'draft', (
      select private.protocol_version_json(v.id) from public.protocol_versions v
      where v.protocol_id = _protocol.id and v.status = 'draft'
      order by v.version desc limit 1),
    'approved', (
      select private.protocol_version_json(v.id) from public.protocol_versions v
      where v.protocol_id = _protocol.id and v.status = 'approved'
      order by v.version desc limit 1),
    'active', (
      select private.protocol_version_json(v.id) from public.protocol_versions v
      where v.protocol_id = _protocol.id and v.status = 'active'
      order by v.version desc limit 1),
    'history', _history,
    'generatedAt', now());
end;
$$;
revoke all on function public.get_patient_protocol(uuid, uuid) from public, anon;
grant execute on function public.get_patient_protocol(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------- create draft
create or replace function public.create_protocol_draft(
  _organization_id uuid,
  _patient_id uuid,
  _title text,
  _from_template_id uuid default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _protocol_id uuid;
  _next integer;
  _new_version_id uuid;
  _tpl public.protocol_templates%rowtype;
  _tpl_version public.protocol_versions%rowtype;
  _phase_map jsonb := '{}'::jsonb;
  _ph record;
  _new_phase_id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.can_author_protocol(_organization_id, _patient_id) then
    raise exception 'not authorized to author protocols for this patient'
      using errcode = '42501';
  end if;
  if _title is null or trim(_title) = '' then
    raise exception 'a protocol title is required' using errcode = '22023';
  end if;
  if length(_title) > 200 then
    raise exception 'title too long' using errcode = '22023';
  end if;

  -- Tenant agreement: the patient must belong to this organization.
  if not exists (
    select 1 from public.patient_profiles p
    where p.id = _patient_id and p.organization_id = _organization_id
      and p.deleted_at is null
  ) then
    raise exception 'patient does not belong to this organization' using errcode = '42501';
  end if;

  if _from_template_id is not null then
    select * into _tpl from public.protocol_templates
    where id = _from_template_id and deleted_at is null;
    if not found then
      raise exception 'template not found' using errcode = 'P0002';
    end if;
    -- Cross-tenant template use is refused outright.
    if _tpl.organization_id <> _organization_id then
      raise exception 'template belongs to another organization' using errcode = '42501';
    end if;
    if _tpl.status <> 'approved' or _tpl.approved_version_id is null then
      raise exception 'only approved templates can start a protocol' using errcode = '22023';
    end if;
    select * into _tpl_version from public.protocol_versions
    where id = _tpl.approved_version_id;
    if not found then
      raise exception 'template version not found' using errcode = 'P0002';
    end if;
  end if;

  select id into _protocol_id from public.protocols
  where patient_id = _patient_id and organization_id = _organization_id
    and deleted_at is null
  order by created_at desc limit 1;

  if _protocol_id is null then
    insert into public.protocols
      (organization_id, patient_id, title, status, created_by, updated_by)
    values (_organization_id, _patient_id, trim(_title), 'draft', _uid, _uid)
    returning id into _protocol_id;
  end if;

  if exists (
    select 1 from public.protocol_versions
    where protocol_id = _protocol_id and status = 'draft'
  ) then
    raise exception 'a draft version already exists for this protocol'
      using errcode = '22023';
  end if;

  select coalesce(max(version), 0) + 1 into _next
  from public.protocol_versions where protocol_id = _protocol_id;

  insert into public.protocol_versions
    (organization_id, protocol_id, patient_id, version, status, title, summary,
     diet_instructions, lifestyle_instructions, monitoring_plan, followup_plan,
     source_template_id, source_template_version, created_by, updated_by)
  values
    (_organization_id, _protocol_id, _patient_id, _next, 'draft', trim(_title),
     _tpl_version.summary, _tpl_version.diet_instructions,
     _tpl_version.lifestyle_instructions, _tpl_version.monitoring_plan,
     _tpl_version.followup_plan,
     case when _tpl.id is not null then _tpl.id else null end,
     _tpl_version.version, _uid, _uid)
  returning id into _new_version_id;

  -- Copy template phases + items into the NEW draft. The copy is fully
  -- detached: editing this draft can never reach back into the template.
  if _tpl_version.id is not null then
    for _ph in
      select * from public.protocol_phases where version_id = _tpl_version.id
      order by position, created_at
    loop
      insert into public.protocol_phases
        (organization_id, version_id, name, position, starts_on, ends_on,
         relative_start_day, relative_duration_days, notes)
      values
        (_organization_id, _new_version_id, _ph.name, _ph.position, _ph.starts_on,
         _ph.ends_on, _ph.relative_start_day, _ph.relative_duration_days, _ph.notes)
      returning id into _new_phase_id;
      _phase_map := jsonb_set(_phase_map, array[_ph.id::text], to_jsonb(_new_phase_id));
    end loop;

    insert into public.protocol_items
      (organization_id, version_id, phase_id, kind, position, label, instructions,
       catalog_product_id, catalog_product_version_id, manufacturer, label_version,
       dosage_text, timing_text, route, verification_status,
       interaction_review_state, affiliate_url)
    select
      _organization_id, _new_version_id,
      case when it.phase_id is null then null
           else (_phase_map->>it.phase_id::text)::uuid end,
      it.kind, it.position, it.label, it.instructions,
      it.catalog_product_id, it.catalog_product_version_id, it.manufacturer,
      it.label_version, it.dosage_text, it.timing_text, it.route,
      it.verification_status,
      -- A copied item's interaction review does NOT carry over: the new
      -- patient context requires its own practitioner review.
      'not_completed',
      it.affiliate_url
    from public.protocol_items it
    where it.version_id = _tpl_version.id;
  end if;

  update public.protocols
  set current_version_id = _new_version_id, updated_by = _uid
  where id = _protocol_id;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_organization_id, _patient_id, _uid, 'protocol.draft_created',
     'protocol_version', _new_version_id::text,
     'Protocol draft created',
     jsonb_build_object('version', _next,
                        'fromTemplate', _from_template_id is not null));

  return jsonb_build_object('ok', true, 'protocolId', _protocol_id,
    'versionId', _new_version_id, 'version', _next,
    'message', case when _from_template_id is null
      then 'Blank protocol draft created.'
      else 'Draft created from the approved template. Customizing it never changes the template.' end);
end;
$$;
revoke all on function public.create_protocol_draft(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.create_protocol_draft(uuid, uuid, text, uuid) to authenticated, service_role;

-- ------------------------------------------------------------- autosave
-- Replaces the draft's content, phases, and items wholesale from a bounded
-- payload. `_expected_updated_at` is the optimistic-concurrency token: a
-- mismatch raises 40001 so a second tab cannot silently overwrite the first.
create or replace function public.save_protocol_draft(
  _version_id uuid,
  _payload jsonb,
  _expected_updated_at timestamptz default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _v public.protocol_versions%rowtype;
  _phase jsonb;
  _item jsonb;
  _phase_ids uuid[] := '{}';
  _new_phase_id uuid;
  _idx integer := 0;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if _payload is null or jsonb_typeof(_payload) <> 'object' then
    raise exception 'invalid payload' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(_payload->'phases', '[]'::jsonb)) > 24 then
    raise exception 'too many phases (max 24)' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(_payload->'items', '[]'::jsonb)) > 200 then
    raise exception 'too many items (max 200)' using errcode = '22023';
  end if;

  select * into _v from public.protocol_versions
  where id = _version_id for update;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if _v.protocol_id is not null then
    if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
      raise exception 'not authorized to edit this protocol' using errcode = '42501';
    end if;
  else
    if not private.can_author_protocol(_v.organization_id, null) then
      raise exception 'not authorized to edit organization templates' using errcode = '42501';
    end if;
  end if;
  if _v.status <> 'draft' then
    raise exception 'only draft versions can be edited; create a new draft version'
      using errcode = '22023';
  end if;
  if _expected_updated_at is not null
     and date_trunc('milliseconds', _expected_updated_at)
         <> date_trunc('milliseconds', _v.updated_at) then
    raise exception 'this draft changed elsewhere since it was loaded'
      using errcode = '40001';
  end if;

  update public.protocol_versions
  set title = coalesce(nullif(trim(coalesce(_payload->>'title','')), ''), _v.title),
      summary = _payload->>'summary',
      diet_instructions = _payload->>'dietInstructions',
      lifestyle_instructions = _payload->>'lifestyleInstructions',
      monitoring_plan = _payload->>'monitoringPlan',
      followup_plan = _payload->>'followupPlan',
      updated_by = _uid,
      updated_at = now()
  where id = _version_id;

  -- Wholesale replace: the client owns draft ordering, the server owns bounds.
  delete from public.protocol_items where version_id = _version_id;
  delete from public.protocol_phases where version_id = _version_id;

  for _phase in select * from jsonb_array_elements(coalesce(_payload->'phases','[]'::jsonb))
  loop
    if coalesce(trim(_phase->>'name'), '') = '' then
      raise exception 'each phase needs a name' using errcode = '22023';
    end if;
    insert into public.protocol_phases
      (organization_id, version_id, name, position, starts_on, ends_on,
       relative_start_day, relative_duration_days, notes)
    values
      (_v.organization_id, _version_id, left(trim(_phase->>'name'), 120), _idx,
       nullif(_phase->>'startsOn','')::date, nullif(_phase->>'endsOn','')::date,
       nullif(_phase->>'relativeStartDay','')::integer,
       nullif(_phase->>'relativeDurationDays','')::integer,
       _phase->>'notes')
    returning id into _new_phase_id;
    _phase_ids := _phase_ids || _new_phase_id;
    _idx := _idx + 1;
  end loop;

  _idx := 0;
  for _item in select * from jsonb_array_elements(coalesce(_payload->'items','[]'::jsonb))
  loop
    if (_item->>'kind') not in ('product','diet','lifestyle','monitoring','followup') then
      raise exception 'invalid item kind' using errcode = '22023';
    end if;
    if coalesce(trim(_item->>'label'), '') = '' then
      raise exception 'each item needs a label' using errcode = '22023';
    end if;
    -- Catalog references must exist; a bad id is refused, never silently kept.
    if (_item->>'catalogProductId') is not null
       and not exists (select 1 from public.supplement_products sp
                       where sp.id = (_item->>'catalogProductId')::uuid) then
      raise exception 'catalog product not found' using errcode = 'P0002';
    end if;
    insert into public.protocol_items
      (organization_id, version_id, phase_id, kind, position, label, instructions,
       catalog_product_id, catalog_product_version_id, manufacturer, label_version,
       dosage_text, timing_text, route, verification_status,
       interaction_review_state, affiliate_url)
    values
      (_v.organization_id, _version_id,
       case when (_item->>'phaseIndex') is null then null
            else _phase_ids[(_item->>'phaseIndex')::integer + 1] end,
       _item->>'kind', _idx, left(trim(_item->>'label'), 240),
       _item->>'instructions',
       nullif(_item->>'catalogProductId','')::uuid,
       nullif(_item->>'catalogProductVersionId','')::uuid,
       _item->>'manufacturer', _item->>'labelVersion',
       _item->>'dosageText', _item->>'timingText', _item->>'route',
       coalesce(nullif(_item->>'verificationStatus',''), 'unverified'),
       -- Interaction review is a practitioner act recorded by its own action;
       -- an autosave can never claim it happened.
       'not_completed',
       _item->>'affiliateUrl');
    _idx := _idx + 1;
  end loop;

  select * into _v from public.protocol_versions where id = _version_id;
  return jsonb_build_object('ok', true, 'versionId', _version_id,
    'updatedAt', _v.updated_at, 'message', 'Draft saved.');
end;
$$;
revoke all on function public.save_protocol_draft(uuid, jsonb, timestamptz) from public, anon;
grant execute on function public.save_protocol_draft(uuid, jsonb, timestamptz) to authenticated, service_role;

-- ------------------------------------------------------------- approve
create or replace function public.approve_protocol_version(
  _version_id uuid,
  _review_note text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _v public.protocol_versions%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _v from public.protocol_versions where id = _version_id for update;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if _v.protocol_id is null then
    raise exception 'use approve_protocol_template_version for templates'
      using errcode = '22023';
  end if;
  if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
    raise exception 'not authorized to approve this protocol' using errcode = '42501';
  end if;
  if _v.status <> 'draft' then
    raise exception 'only draft versions can be approved' using errcode = '22023';
  end if;
  if not exists (select 1 from public.protocol_items where version_id = _version_id) then
    raise exception 'an empty protocol cannot be approved' using errcode = '22023';
  end if;

  -- Approval freezes THIS version. It does NOT activate it: activation is a
  -- separate, explicitly confirmed action.
  update public.protocol_versions
  set status = 'approved', approved_by = _uid, approved_at = now(),
      review_note = nullif(trim(coalesce(_review_note,'')), ''),
      updated_by = _uid
  where id = _version_id;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_v.organization_id, _v.patient_id, _uid, 'protocol.approved',
     'protocol_version', _version_id::text,
     'Protocol version approved by practitioner',
     jsonb_build_object('version', _v.version, 'hadNote', _review_note is not null));

  return jsonb_build_object('ok', true, 'versionId', _version_id,
    'status', 'approved',
    'message', 'Version approved and now immutable. It is NOT active — activate it separately.');
end;
$$;
revoke all on function public.approve_protocol_version(uuid, text) from public, anon;
grant execute on function public.approve_protocol_version(uuid, text) to authenticated, service_role;

-- ------------------------------------------------------------- activate
create or replace function public.activate_protocol_version(
  _version_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _v public.protocol_versions%rowtype;
  _prev uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _v from public.protocol_versions where id = _version_id for update;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if _v.protocol_id is null then
    raise exception 'templates are not activated' using errcode = '22023';
  end if;
  if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
    raise exception 'not authorized to activate this protocol' using errcode = '42501';
  end if;
  if _v.status <> 'approved' then
    raise exception 'only an approved version can be activated' using errcode = '22023';
  end if;

  -- Supersede the previously active version (never delete it).
  select active_version_id into _prev from public.protocols where id = _v.protocol_id;
  if _prev is not null and _prev <> _version_id then
    update public.protocol_versions
    set status = 'superseded', updated_by = _uid where id = _prev;
  end if;

  update public.protocol_versions
  set status = 'active', activated_by = _uid, activated_at = now(), updated_by = _uid
  where id = _version_id;

  update public.protocols
  set status = 'active', active_version_id = _version_id,
      current_version_id = _version_id, updated_by = _uid
  where id = _v.protocol_id;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_v.organization_id, _v.patient_id, _uid, 'protocol.activated',
     'protocol_version', _version_id::text,
     'Protocol version activated',
     jsonb_build_object('version', _v.version,
                        'supersededVersionId', coalesce(_prev::text, '')));

  return jsonb_build_object('ok', true, 'versionId', _version_id, 'status', 'active',
    'message', 'Version activated. No orders, messages, charges, or note entries were created.');
end;
$$;
revoke all on function public.activate_protocol_version(uuid) from public, anon;
grant execute on function public.activate_protocol_version(uuid) to authenticated, service_role;

-- ------------------------------------------------------------- lifecycle
create or replace function public.set_protocol_lifecycle(
  _protocol_id uuid,
  _status text,
  _reason text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _p public.protocols%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if _status not in ('active','paused','completed','discontinued') then
    raise exception 'invalid protocol status' using errcode = '22023';
  end if;
  select * into _p from public.protocols
  where id = _protocol_id and deleted_at is null for update;
  if not found then
    raise exception 'protocol not found' using errcode = 'P0002';
  end if;
  if not private.can_author_protocol(_p.organization_id, _p.patient_id) then
    raise exception 'not authorized to manage this protocol' using errcode = '42501';
  end if;
  if _p.status = _status then
    return jsonb_build_object('ok', true, 'status', _status, 'alreadySet', true,
      'message', 'Protocol already in that state.');
  end if;
  -- Only a protocol with an active version has a course to pause/complete.
  if _status in ('paused','completed') and _p.active_version_id is null then
    raise exception 'no active version to %', _status using errcode = '22023';
  end if;
  if _p.status in ('completed','discontinued') then
    raise exception 'protocol is already closed' using errcode = '22023';
  end if;

  update public.protocols
  set status = _status, updated_by = _uid where id = _protocol_id;

  if _status = 'discontinued' and _p.active_version_id is not null then
    update public.protocol_versions
    set status = 'discontinued', updated_by = _uid
    where id = _p.active_version_id;
  end if;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_p.organization_id, _p.patient_id, _uid, 'protocol.' || _status,
     'protocol', _protocol_id::text,
     'Protocol ' || _status,
     jsonb_build_object('previousStatus', _p.status,
                        'hadReason', _reason is not null));

  return jsonb_build_object('ok', true, 'status', _status, 'alreadySet', false,
    'message', 'Protocol ' || _status || '.');
end;
$$;
revoke all on function public.set_protocol_lifecycle(uuid, text, text) from public, anon;
grant execute on function public.set_protocol_lifecycle(uuid, text, text) to authenticated, service_role;

-- ------------------------------------------------------------- revise
-- Editing an approved/active version is impossible by design; this is the
-- sanctioned path: copy it into a NEW draft that supersedes it on approval.
-- The source version is untouched and stays readable forever.
create or replace function public.revise_protocol_version(
  _version_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _v public.protocol_versions%rowtype;
  _next integer;
  _new_id uuid;
  _ph record;
  _phase_map jsonb := '{}'::jsonb;
  _new_phase_id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _v from public.protocol_versions where id = _version_id;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if _v.protocol_id is null then
    raise exception 'use the template draft flow for templates' using errcode = '22023';
  end if;
  if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
    raise exception 'not authorized to revise this protocol' using errcode = '42501';
  end if;
  if _v.status not in ('approved','active') then
    raise exception 'only approved or active versions are revised into a new draft'
      using errcode = '22023';
  end if;
  if exists (select 1 from public.protocol_versions
             where protocol_id = _v.protocol_id and status = 'draft') then
    raise exception 'a draft version already exists for this protocol'
      using errcode = '22023';
  end if;

  select coalesce(max(version), 0) + 1 into _next
  from public.protocol_versions where protocol_id = _v.protocol_id;

  insert into public.protocol_versions
    (organization_id, protocol_id, patient_id, version, status, title, summary,
     diet_instructions, lifestyle_instructions, monitoring_plan, followup_plan,
     source_template_id, source_template_version, supersedes_version_id,
     created_by, updated_by)
  values
    (_v.organization_id, _v.protocol_id, _v.patient_id, _next, 'draft', _v.title,
     _v.summary, _v.diet_instructions, _v.lifestyle_instructions,
     _v.monitoring_plan, _v.followup_plan, _v.source_template_id,
     _v.source_template_version, _v.id, _uid, _uid)
  returning id into _new_id;

  for _ph in select * from public.protocol_phases where version_id = _v.id
             order by position, created_at
  loop
    insert into public.protocol_phases
      (organization_id, version_id, name, position, starts_on, ends_on,
       relative_start_day, relative_duration_days, notes)
    values
      (_v.organization_id, _new_id, _ph.name, _ph.position, _ph.starts_on,
       _ph.ends_on, _ph.relative_start_day, _ph.relative_duration_days, _ph.notes)
    returning id into _new_phase_id;
    _phase_map := jsonb_set(_phase_map, array[_ph.id::text], to_jsonb(_new_phase_id));
  end loop;

  insert into public.protocol_items
    (organization_id, version_id, phase_id, kind, position, label, instructions,
     catalog_product_id, catalog_product_version_id, manufacturer, label_version,
     dosage_text, timing_text, route, verification_status,
     interaction_review_state, affiliate_url)
  select _v.organization_id, _new_id,
    case when it.phase_id is null then null
         else (_phase_map->>it.phase_id::text)::uuid end,
    it.kind, it.position, it.label, it.instructions, it.catalog_product_id,
    it.catalog_product_version_id, it.manufacturer, it.label_version,
    it.dosage_text, it.timing_text, it.route, it.verification_status,
    'not_completed', it.affiliate_url
  from public.protocol_items it where it.version_id = _v.id;

  update public.protocols
  set current_version_id = _new_id, updated_by = _uid where id = _v.protocol_id;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_v.organization_id, _v.patient_id, _uid, 'protocol.revised',
     'protocol_version', _new_id::text,
     'New protocol draft created from a previous version',
     jsonb_build_object('version', _next, 'supersedesVersion', _v.version));

  return jsonb_build_object('ok', true, 'versionId', _new_id, 'version', _next,
    'supersedesVersionId', _v.id,
    'message', 'New draft version ' || _next || ' created. The previous version is unchanged.');
end;
$$;
revoke all on function public.revise_protocol_version(uuid) from public, anon;
grant execute on function public.revise_protocol_version(uuid) to authenticated, service_role;

-- ------------------------------------------------------------- templates
create or replace function public.list_protocol_templates(
  _organization_id uuid,
  _include_archived boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'description', t.description,
      'status', t.status, 'archivedAt', t.archived_at,
      'approvedVersionId', t.approved_version_id,
      'currentVersionId', t.current_version_id,
      'approvedVersion', (select v.version from public.protocol_versions v
                          where v.id = t.approved_version_id),
      'updatedAt', t.updated_at) order by t.name)
    from public.protocol_templates t
    where t.organization_id = _organization_id
      and t.deleted_at is null
      and (_include_archived or t.status <> 'archived')
    limit 200), '[]'::jsonb);
end;
$$;
revoke all on function public.list_protocol_templates(uuid, boolean) from public, anon;
grant execute on function public.list_protocol_templates(uuid, boolean) to authenticated, service_role;

create or replace function public.create_protocol_template(
  _organization_id uuid,
  _name text,
  _description text default null,
  _from_version_id uuid default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _template_id uuid;
  _version_id uuid;
  _src public.protocol_versions%rowtype;
  _ph record;
  _phase_map jsonb := '{}'::jsonb;
  _new_phase_id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.can_author_protocol(_organization_id, null) then
    raise exception 'not authorized to author organization templates' using errcode = '42501';
  end if;
  if _name is null or trim(_name) = '' then
    raise exception 'a template name is required' using errcode = '22023';
  end if;
  if length(_name) > 200 then
    raise exception 'name too long' using errcode = '22023';
  end if;

  if _from_version_id is not null then
    select * into _src from public.protocol_versions where id = _from_version_id;
    if not found then
      raise exception 'source version not found' using errcode = 'P0002';
    end if;
    -- Tenant agreement + patient-access: copying a patient draft into a
    -- reusable template requires access to that patient's record.
    if _src.organization_id <> _organization_id then
      raise exception 'source version belongs to another organization' using errcode = '42501';
    end if;
    if _src.patient_id is not null
       and not private.can_access_patient(_src.patient_id) then
      raise exception 'not authorized for the source patient record' using errcode = '42501';
    end if;
  end if;

  insert into public.protocol_templates
    (organization_id, name, description, status, created_by, updated_by)
  values (_organization_id, trim(_name), _description, 'draft', _uid, _uid)
  returning id into _template_id;

  insert into public.protocol_versions
    (organization_id, template_id, version, status, title, summary,
     diet_instructions, lifestyle_instructions, monitoring_plan, followup_plan,
     created_by, updated_by)
  values
    (_organization_id, _template_id, 1, 'draft', trim(_name),
     coalesce(_src.summary, _description), _src.diet_instructions,
     _src.lifestyle_instructions, _src.monitoring_plan, _src.followup_plan,
     _uid, _uid)
  returning id into _version_id;

  if _src.id is not null then
    for _ph in select * from public.protocol_phases where version_id = _src.id
               order by position, created_at
    loop
      insert into public.protocol_phases
        (organization_id, version_id, name, position, starts_on, ends_on,
         relative_start_day, relative_duration_days, notes)
      values
        -- Absolute patient dates are deliberately dropped when a draft becomes
        -- a reusable template: another patient's phase cannot inherit this
        -- patient's calendar. Relative timing is preserved.
        (_organization_id, _version_id, _ph.name, _ph.position, null, null,
         _ph.relative_start_day, _ph.relative_duration_days, _ph.notes)
      returning id into _new_phase_id;
      _phase_map := jsonb_set(_phase_map, array[_ph.id::text], to_jsonb(_new_phase_id));
    end loop;

    insert into public.protocol_items
      (organization_id, version_id, phase_id, kind, position, label, instructions,
       catalog_product_id, catalog_product_version_id, manufacturer, label_version,
       dosage_text, timing_text, route, verification_status,
       interaction_review_state, affiliate_url)
    select _organization_id, _version_id,
      case when it.phase_id is null then null
           else (_phase_map->>it.phase_id::text)::uuid end,
      it.kind, it.position, it.label, it.instructions, it.catalog_product_id,
      it.catalog_product_version_id, it.manufacturer, it.label_version,
      it.dosage_text, it.timing_text, it.route, it.verification_status,
      'not_completed', it.affiliate_url
    from public.protocol_items it where it.version_id = _src.id;
  end if;

  update public.protocol_templates
  set current_version_id = _version_id, updated_by = _uid where id = _template_id;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_organization_id, null, _uid, 'protocol_template.created',
     'protocol_template', _template_id::text,
     'Protocol template created',
     jsonb_build_object('fromVersion', _from_version_id is not null));

  return jsonb_build_object('ok', true, 'templateId', _template_id,
    'versionId', _version_id,
    'message', 'Template draft created. Approve it before starting protocols from it.');
end;
$$;
revoke all on function public.create_protocol_template(uuid, text, text, uuid) from public, anon;
grant execute on function public.create_protocol_template(uuid, text, text, uuid) to authenticated, service_role;

create or replace function public.approve_protocol_template_version(
  _version_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _v public.protocol_versions%rowtype;
  _t public.protocol_templates%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _v from public.protocol_versions where id = _version_id for update;
  if not found then
    raise exception 'template version not found' using errcode = 'P0002';
  end if;
  if _v.template_id is null then
    raise exception 'not a template version' using errcode = '22023';
  end if;
  if not private.can_author_protocol(_v.organization_id, null) then
    raise exception 'not authorized to approve organization templates' using errcode = '42501';
  end if;
  if _v.status <> 'draft' then
    raise exception 'only draft template versions can be approved' using errcode = '22023';
  end if;

  select * into _t from public.protocol_templates where id = _v.template_id for update;
  if _t.approved_version_id is not null then
    update public.protocol_versions set status = 'superseded', updated_by = _uid
    where id = _t.approved_version_id;
  end if;

  update public.protocol_versions
  set status = 'approved', approved_by = _uid, approved_at = now(), updated_by = _uid
  where id = _version_id;

  update public.protocol_templates
  set status = 'approved', approved_version_id = _version_id,
      current_version_id = _version_id, updated_by = _uid
  where id = _v.template_id;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_v.organization_id, null, _uid, 'protocol_template.approved',
     'protocol_version', _version_id::text, 'Protocol template version approved',
     jsonb_build_object('version', _v.version));

  return jsonb_build_object('ok', true, 'versionId', _version_id, 'status', 'approved',
    'message', 'Template version approved and immutable.');
end;
$$;
revoke all on function public.approve_protocol_template_version(uuid) from public, anon;
grant execute on function public.approve_protocol_template_version(uuid) to authenticated, service_role;

create or replace function public.archive_protocol_template(
  _template_id uuid,
  _archived boolean default true
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _t public.protocol_templates%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _t from public.protocol_templates
  where id = _template_id and deleted_at is null for update;
  if not found then
    raise exception 'template not found' using errcode = 'P0002';
  end if;
  if not private.can_author_protocol(_t.organization_id, null) then
    raise exception 'not authorized to manage organization templates' using errcode = '42501';
  end if;

  -- Archiving is reversible and NEVER cascades: protocols already created from
  -- this template keep their own copied versions untouched.
  update public.protocol_templates
  set status = case when _archived then 'archived'
                    when _t.approved_version_id is not null then 'approved'
                    else 'draft' end,
      archived_at = case when _archived then now() else null end,
      updated_by = _uid
  where id = _template_id;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_t.organization_id, null, _uid,
     case when _archived then 'protocol_template.archived' else 'protocol_template.restored' end,
     'protocol_template', _template_id::text,
     case when _archived then 'Protocol template archived' else 'Protocol template restored' end,
     '{}'::jsonb);

  return jsonb_build_object('ok', true, 'templateId', _template_id,
    'archived', _archived,
    'message', case when _archived
      then 'Template archived. Protocols created from it are unaffected.'
      else 'Template restored.' end);
end;
$$;
revoke all on function public.archive_protocol_template(uuid, boolean) from public, anon;
grant execute on function public.archive_protocol_template(uuid, boolean) to authenticated, service_role;

commit;
