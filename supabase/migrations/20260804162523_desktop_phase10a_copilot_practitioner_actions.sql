-- Phase 10A reconciliation — practitioner-action RPCs.
--
-- The `clinical_note_versions.save_kind` CHECK is broadened by one value
-- ('copilot_append') so the append RPC can identify itself in the version
-- history. Existing 'autosave' + 'manual' semantics are preserved.

alter table public.clinical_note_versions
  drop constraint if exists clinical_note_versions_save_kind_check;
alter table public.clinical_note_versions
  add constraint clinical_note_versions_save_kind_check
  check (save_kind = any (array['autosave','manual','copilot_append']));

--
-- Three disposition-side-effects, each behind its own SECURITY DEFINER RPC
-- with an empty search_path. Every one:
--
--   * refuses anonymous callers (28000)
--   * refuses non-members of the target organization (42501)
--   * refuses a run that does not belong to that organization (42501)
--   * refuses a run whose status is not in ('completed','signed')
--   * writes to a DRAFT surface only — an unsigned clinical_note_versions
--     row, a draft protocol_versions row, or a pending task
--   * records the copilot run's disposition as 'accepted' so the persistence
--     shows through to the workspace
--   * writes an append-only audit event
--
-- No signing, activation, ordering, billing, messaging, or publishing takes
-- place inside any of these functions. Grepped by the SQL adversarial suite.

-- 1. Attach a copilot-run summary to an unsigned clinical note as a NEW
--    version (save_kind='copilot_append'). The parent `clinical_notes.body`
--    is NOT overwritten — the practitioner reviews the new version and
--    decides whether to promote it.
create or replace function public.apply_copilot_run_to_note(
  _organization_id uuid,
  _run_id uuid,
  _note_id uuid,
  _content jsonb,
  _content_sha256 text
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _r public.clinical_copilot_runs%rowtype;
  _n public.clinical_notes%rowtype;
  _next_version int;
  _new_version_id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode='28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
     where organization_id = _organization_id and user_id = _uid and status = 'active') then
    raise exception 'not a member of this organization' using errcode='42501';
  end if;
  if _content is null or _content_sha256 is null or length(_content_sha256) <> 64 then
    raise exception 'content and 64-char content_sha256 are required' using errcode='22023';
  end if;

  select * into _r from public.clinical_copilot_runs where id = _run_id for update;
  if not found then
    raise exception 'copilot run not found' using errcode='P0002';
  end if;
  if _r.organization_id <> _organization_id then
    raise exception 'run belongs to a different tenant' using errcode='42501';
  end if;
  if _r.status not in ('completed','signed') then
    raise exception 'only a completed or signed run can be attached to a note' using errcode='55000';
  end if;

  select * into _n from public.clinical_notes where id = _note_id;
  if not found then
    raise exception 'note not found' using errcode='P0002';
  end if;
  if _n.organization_id <> _organization_id then
    raise exception 'note belongs to a different tenant' using errcode='42501';
  end if;
  if _n.is_signed is true or _n.status = 'signed' then
    raise exception 'note is signed and cannot accept a draft append' using errcode='55000';
  end if;

  select coalesce(max(version), 0) + 1 into _next_version
    from public.clinical_note_versions where note_id = _note_id;

  insert into public.clinical_note_versions
    (note_id, version, content, content_sha256, save_kind, created_by)
  values
    (_note_id, _next_version, _content, _content_sha256, 'copilot_append', _uid)
  returning id into _new_version_id;

  -- Bump current_version pointer WITHOUT touching signed/status.
  update public.clinical_notes
     set current_version = _next_version,
         updated_by = _uid,
         updated_at = clock_timestamp()
   where id = _note_id;

  -- Record acceptance disposition on the run.
  perform public.record_copilot_disposition(_organization_id, _run_id, 'accepted');

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'copilot.applied_to_note',
     'clinical_note_version', _new_version_id::text,
     'Copilot excerpt appended to an unsigned note as a new draft version',
     jsonb_build_object('runId', _run_id, 'noteId', _note_id, 'version', _next_version));

  return jsonb_build_object(
    'ok', true, 'noteId', _note_id, 'newVersionId', _new_version_id,
    'newVersion', _next_version, 'runId', _run_id, 'status', _r.status);
end;
$function$;

-- 2. Attach a copilot-run summary to a new DRAFT protocol_versions row. The
--    protocol version status is always 'draft' — never 'approved' /
--    'active' / 'published'.
create or replace function public.apply_copilot_run_to_protocol_draft(
  _organization_id uuid,
  _run_id uuid,
  _protocol_id uuid,
  _title text,
  _summary text
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _r public.clinical_copilot_runs%rowtype;
  _p public.protocols%rowtype;
  _next_version int;
  _new_version_id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode='28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
     where organization_id = _organization_id and user_id = _uid and status = 'active') then
    raise exception 'not a member of this organization' using errcode='42501';
  end if;
  if _title is null or length(trim(_title)) = 0 then
    raise exception 'title is required' using errcode='22023';
  end if;

  select * into _r from public.clinical_copilot_runs where id = _run_id for update;
  if not found then
    raise exception 'copilot run not found' using errcode='P0002';
  end if;
  if _r.organization_id <> _organization_id then
    raise exception 'run belongs to a different tenant' using errcode='42501';
  end if;
  if _r.status not in ('completed','signed') then
    raise exception 'only a completed or signed run can be attached to a protocol' using errcode='55000';
  end if;

  select * into _p from public.protocols where id = _protocol_id;
  if not found then
    raise exception 'protocol not found' using errcode='P0002';
  end if;
  if _p.organization_id <> _organization_id then
    raise exception 'protocol belongs to a different tenant' using errcode='42501';
  end if;

  select coalesce(max(version), 0) + 1 into _next_version
    from public.protocol_versions where protocol_id = _protocol_id;

  insert into public.protocol_versions
    (organization_id, protocol_id, patient_id, version, status,
     title, summary, created_by, updated_by)
  values
    (_organization_id, _protocol_id, _p.patient_id, _next_version, 'draft',
     _title, _summary, _uid, _uid)
  returning id into _new_version_id;

  -- Record acceptance disposition on the run.
  perform public.record_copilot_disposition(_organization_id, _run_id, 'accepted');

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'copilot.applied_to_protocol_draft',
     'protocol_version', _new_version_id::text,
     'Copilot summary attached to a new draft protocol version',
     jsonb_build_object('runId', _run_id, 'protocolId', _protocol_id, 'version', _next_version));

  return jsonb_build_object(
    'ok', true, 'protocolId', _protocol_id, 'newVersionId', _new_version_id,
    'newVersion', _next_version, 'runId', _run_id, 'status', 'draft');
end;
$function$;

-- 3. Create a review task pointing at the copilot run. Always
--    status='open', category='copilot_review'. Never fires a
--    notification, message, or external side effect.
create or replace function public.create_copilot_review_task(
  _organization_id uuid,
  _run_id uuid,
  _title text,
  _detail text,
  _due_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _r public.clinical_copilot_runs%rowtype;
  _task_id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode='28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
     where organization_id = _organization_id and user_id = _uid and status = 'active') then
    raise exception 'not a member of this organization' using errcode='42501';
  end if;
  if _title is null or length(trim(_title)) = 0 then
    raise exception 'title is required' using errcode='22023';
  end if;

  select * into _r from public.clinical_copilot_runs where id = _run_id for update;
  if not found then
    raise exception 'copilot run not found' using errcode='P0002';
  end if;
  if _r.organization_id <> _organization_id then
    raise exception 'run belongs to a different tenant' using errcode='42501';
  end if;

  -- tasks.priority ∈ ('low','medium','high'), tasks.status ∈ ('open',
  -- 'in_progress','done','snoozed','cancelled'). A copilot review task lands
  -- as 'open' with 'medium' priority. Nothing sends a notification or an
  -- external message.
  insert into public.tasks
    (organization_id, patient_id, title, detail, priority, status, due_at,
     category, created_by, updated_by)
  values
    (_organization_id, _r.patient_id, _title, _detail, 'medium', 'open',
     _due_at, 'copilot_review', _uid, _uid)
  returning id into _task_id;

  -- Record acceptance disposition on the run.
  perform public.record_copilot_disposition(_organization_id, _run_id, 'accepted');

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'copilot.review_task_created',
     'task', _task_id::text,
     'Copilot review task created (open)',
     jsonb_build_object('runId', _run_id, 'taskId', _task_id));

  return jsonb_build_object(
    'ok', true, 'taskId', _task_id, 'runId', _run_id, 'status', 'open');
end;
$function$;

comment on function public.apply_copilot_run_to_note(uuid, uuid, uuid, jsonb, text) is
  'Phase 10A: appends a copilot excerpt as a new UNSIGNED draft version of a clinical note. Never signs, never overwrites the signed body.';
comment on function public.apply_copilot_run_to_protocol_draft(uuid, uuid, uuid, text, text) is
  'Phase 10A: creates a new DRAFT protocol version from a copilot summary. Never activates, publishes, or attaches a dose.';
comment on function public.create_copilot_review_task(uuid, uuid, text, text, timestamptz) is
  'Phase 10A: creates an OPEN review task tied to a copilot run. Never sends a notification or external message.';
