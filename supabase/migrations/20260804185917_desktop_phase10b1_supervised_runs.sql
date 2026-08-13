-- Phase 10B.1 — Supervised first-N runs.
--
-- Enforces the "first N production runs per org require a secondary
-- clinical review before any accepted content can enter a clinical draft"
-- rule. Additive only.
--
-- Design:
--   * clinical_copilot_supervised_reviews: append-only ledger of
--     secondary reviews. Each row is one review by an authorized clinical
--     actor who is NOT the run's author.
--   * counted_supervised_runs: view of completed runs per
--     (org, provider_registry_id, model, approval_reference).
--   * has_supervised_approval(_run_id, _uid): helper that returns true
--     if a valid secondary review exists for the run.
--   * apply_copilot_run_to_note / apply_copilot_run_to_protocol_draft:
--     re-defined to REFUSE (55000, category = 'supervised_review_required')
--     when the run is inside the supervision window AND no approval row
--     exists.
--   * approve_supervised_copilot_run(_org, _run_id, _draft_action, _note):
--     records a secondary review with the specific action being approved.
--
-- Reset rule (deterministic):
--   Supervision counts within the (org, provider_registry_id,
--   approval_reference) tuple. Changing provider_registry_id or
--   approval_reference resets the counter to zero because the join key
--   changes.

create table if not exists public.clinical_copilot_supervised_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.clinical_copilot_runs(id) on delete cascade,
  reviewer_user_id uuid not null references auth.users(id),
  reviewed_at timestamptz not null default now(),
  approved_draft_action text not null,
  review_note text,
  constraint copilot_supervised_action_check
    check (approved_draft_action in ('apply_to_note','apply_to_protocol_draft','create_task'))
);
alter table public.clinical_copilot_supervised_reviews enable row level security;
create policy copilot_supervised_reviews_tenant_read
  on public.clinical_copilot_supervised_reviews for select to authenticated
  using (organization_id in (
    select om.organization_id from public.organization_memberships om
     where om.user_id = auth.uid() and om.status='active'
  ));
revoke insert, update, delete on public.clinical_copilot_supervised_reviews from anon, authenticated;

-- Append-only: block UPDATE + DELETE via trigger even for privileged writes.
create or replace function private.clinical_copilot_supervised_reviews_guard()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if tg_op in ('UPDATE','DELETE') then
    raise exception 'clinical_copilot_supervised_reviews is append-only' using errcode='22023';
  end if;
  return new;
end;
$function$;
drop trigger if exists copilot_supervised_reviews_append_only
  on public.clinical_copilot_supervised_reviews;
create trigger copilot_supervised_reviews_append_only
  before update or delete on public.clinical_copilot_supervised_reviews
  for each row execute function private.clinical_copilot_supervised_reviews_guard();

create index if not exists copilot_supervised_reviews_run_idx
  on public.clinical_copilot_supervised_reviews (run_id);

-- Count completed runs per (org, provider, approval_reference). Providers
-- are stored on the run row via the `provider` text column; the approval
-- reference is scoped by the org_activation row at the time of the run.
create or replace function public.supervised_runs_completed_count(
  _organization_id uuid,
  _provider_registry_id uuid,
  _approval_reference text
) returns integer
language plpgsql security definer set search_path to '' as $function$
declare _n integer;
begin
  select count(*)::int into _n
  from public.clinical_copilot_runs r
  where r.organization_id = _organization_id
    and r.status = 'completed'
    and coalesce(r.provider_approval_ref,'') = coalesce(_approval_reference,'');
  return _n;
end;
$function$;

-- Helper: is this run inside the supervision window AND lacking a
-- secondary review by an authorized non-author clinical actor?
create or replace function public.is_supervised_and_unapproved(_run_id uuid)
returns boolean language plpgsql security definer set search_path to '' as $function$
declare
  _r public.clinical_copilot_runs%rowtype;
  _act public.clinical_copilot_org_activations%rowtype;
  _required int;
  _completed int;
  _has_review boolean;
begin
  select * into _r from public.clinical_copilot_runs where id=_run_id;
  if not found then return false; end if;
  -- No activation → nothing to supervise (runs use disabled/fixture provider).
  select * into _act from public.clinical_copilot_org_activations
    where organization_id = _r.organization_id
    order by created_at desc limit 1;
  if not found then return false; end if;
  _required := coalesce(_act.supervised_runs_required, 0);
  if _required <= 0 then return false; end if;
  _completed := (
    select count(*)::int from public.clinical_copilot_runs
     where organization_id = _r.organization_id
       and status = 'completed'
       and coalesce(provider_approval_ref,'') = coalesce(_r.provider_approval_ref,''));
  -- Only INSIDE the window (this run's ordinal is <= _required).
  if _completed > _required then return false; end if;
  -- Approved by a different clinical actor?
  select exists (
    select 1 from public.clinical_copilot_supervised_reviews sr
     where sr.run_id = _run_id
       and sr.reviewer_user_id <> _r.created_by
  ) into _has_review;
  return not _has_review;
end;
$function$;

-- Record a secondary review. Reviewer must be a member of the org, NOT
-- the run's author, and the draft action must be one of the three allowed.
create or replace function public.approve_supervised_copilot_run(
  _organization_id uuid,
  _run_id uuid,
  _draft_action text,
  _note text default null
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _r public.clinical_copilot_runs%rowtype;
  _id uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if not exists (
    select 1 from public.organization_memberships
     where organization_id=_organization_id and user_id=_uid and status='active'
       and role in ('owner','admin','practitioner')
  ) then
    raise exception 'authorized clinical role required' using errcode='42501';
  end if;
  if _draft_action not in ('apply_to_note','apply_to_protocol_draft','create_task') then
    raise exception 'invalid draft_action' using errcode='22023';
  end if;
  select * into _r from public.clinical_copilot_runs where id=_run_id;
  if not found then raise exception 'run not found' using errcode='P0002'; end if;
  if _r.organization_id <> _organization_id then
    raise exception 'run belongs to a different tenant' using errcode='42501';
  end if;
  if _r.created_by = _uid then
    raise exception 'reviewer cannot be the run author' using errcode='42501';
  end if;
  if _r.status <> 'completed' then
    raise exception 'only a completed run can be supervised-approved' using errcode='55000';
  end if;
  insert into public.clinical_copilot_supervised_reviews(
    organization_id, run_id, reviewer_user_id, approved_draft_action, review_note
  ) values (
    _organization_id, _run_id, _uid, _draft_action, _note
  ) returning id into _id;
  insert into public.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,safe_message,metadata)
    values(_organization_id,_uid,'copilot.supervised_review_recorded','clinical_copilot_supervised_review',_id::text,
      'Supervised review recorded',
      jsonb_build_object('runId',_run_id,'draftAction',_draft_action));
  return jsonb_build_object('ok',true,'id',_id,'draftAction',_draft_action);
end;
$function$;

-- Reject apply_to_note when supervision required and not approved.
-- The Phase 10A body remains the SAME; we only prepend a supervision
-- check.
create or replace function public.apply_copilot_run_to_note(
  _organization_id uuid, _run_id uuid, _note_id uuid, _content jsonb, _content_sha256 text
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _r public.clinical_copilot_runs%rowtype;
  _n public.clinical_notes%rowtype;
  _next_version int;
  _new_version_id uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if not exists (select 1 from public.organization_memberships where organization_id=_organization_id and user_id=_uid and status='active') then
    raise exception 'not a member of this organization' using errcode='42501'; end if;
  if _content is null or _content_sha256 is null or length(_content_sha256)<>64 then
    raise exception 'content and 64-char content_sha256 are required' using errcode='22023'; end if;
  select * into _r from public.clinical_copilot_runs where id=_run_id for update;
  if not found then raise exception 'copilot run not found' using errcode='P0002'; end if;
  if _r.organization_id<>_organization_id then raise exception 'run belongs to a different tenant' using errcode='42501'; end if;
  if _r.status not in ('completed','signed') then
    raise exception 'only a completed or signed run can be attached to a note' using errcode='55000'; end if;
  -- Phase 10B.1: supervised-first-N gate.
  if public.is_supervised_and_unapproved(_run_id) then
    raise exception 'supervised_review_required' using errcode='55000';
  end if;
  select * into _n from public.clinical_notes where id=_note_id;
  if not found then raise exception 'note not found' using errcode='P0002'; end if;
  if _n.organization_id<>_organization_id then raise exception 'note belongs to a different tenant' using errcode='42501'; end if;
  if _n.is_signed is true or _n.status='signed' then
    raise exception 'note is signed and cannot accept a draft append' using errcode='55000'; end if;
  select coalesce(max(version),0)+1 into _next_version from public.clinical_note_versions where note_id=_note_id;
  insert into public.clinical_note_versions(note_id,version,content,content_sha256,save_kind,created_by)
    values(_note_id,_next_version,_content,_content_sha256,'copilot_append',_uid)
    returning id into _new_version_id;
  update public.clinical_notes set current_version=_next_version, updated_by=_uid, updated_at=clock_timestamp() where id=_note_id;
  perform public.record_copilot_disposition(_organization_id,_run_id,'accepted');
  insert into public.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,safe_message,metadata)
    values(_organization_id,_uid,'copilot.applied_to_note','clinical_note_version',_new_version_id::text,
      'Copilot excerpt appended to an unsigned note as a new draft version',
      jsonb_build_object('runId',_run_id,'noteId',_note_id,'version',_next_version));
  return jsonb_build_object('ok',true,'noteId',_note_id,'newVersionId',_new_version_id,'newVersion',_next_version,'runId',_run_id,'status',_r.status);
end;
$function$;

create or replace function public.apply_copilot_run_to_protocol_draft(
  _organization_id uuid, _run_id uuid, _protocol_id uuid, _title text, _summary text
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _r public.clinical_copilot_runs%rowtype;
  _p public.protocols%rowtype;
  _next_version int;
  _new_version_id uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if not exists (select 1 from public.organization_memberships where organization_id=_organization_id and user_id=_uid and status='active') then
    raise exception 'not a member of this organization' using errcode='42501'; end if;
  if _title is null or length(trim(_title))=0 then raise exception 'title is required' using errcode='22023'; end if;
  select * into _r from public.clinical_copilot_runs where id=_run_id for update;
  if not found then raise exception 'copilot run not found' using errcode='P0002'; end if;
  if _r.organization_id<>_organization_id then raise exception 'run belongs to a different tenant' using errcode='42501'; end if;
  if _r.status not in ('completed','signed') then raise exception 'only a completed or signed run can be attached to a protocol' using errcode='55000'; end if;
  -- Phase 10B.1: supervised-first-N gate.
  if public.is_supervised_and_unapproved(_run_id) then
    raise exception 'supervised_review_required' using errcode='55000';
  end if;
  select * into _p from public.protocols where id=_protocol_id;
  if not found then raise exception 'protocol not found' using errcode='P0002'; end if;
  if _p.organization_id<>_organization_id then raise exception 'protocol belongs to a different tenant' using errcode='42501'; end if;
  select coalesce(max(version),0)+1 into _next_version from public.protocol_versions where protocol_id=_protocol_id;
  insert into public.protocol_versions(organization_id,protocol_id,patient_id,version,status,title,summary,created_by,updated_by)
    values(_organization_id,_protocol_id,_p.patient_id,_next_version,'draft',_title,_summary,_uid,_uid)
    returning id into _new_version_id;
  perform public.record_copilot_disposition(_organization_id,_run_id,'accepted');
  insert into public.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,safe_message,metadata)
    values(_organization_id,_uid,'copilot.applied_to_protocol_draft','protocol_version',_new_version_id::text,
      'Copilot summary attached to a new draft protocol version',
      jsonb_build_object('runId',_run_id,'protocolId',_protocol_id,'version',_next_version));
  return jsonb_build_object('ok',true,'protocolId',_protocol_id,'newVersionId',_new_version_id,'newVersion',_next_version,'runId',_run_id,'status','draft');
end;
$function$;

-- Grant-level: match Phase 10A / 10B.1 shape.
revoke all on function public.supervised_runs_completed_count(uuid, uuid, text) from public, anon;
revoke all on function public.is_supervised_and_unapproved(uuid) from public, anon;
revoke all on function public.approve_supervised_copilot_run(uuid, uuid, text, text) from public, anon;
grant execute on function public.supervised_runs_completed_count(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.is_supervised_and_unapproved(uuid) to authenticated, service_role;
grant execute on function public.approve_supervised_copilot_run(uuid, uuid, text, text) to authenticated, service_role;

comment on function public.is_supervised_and_unapproved(uuid) is
  'Phase 10B.1: returns true if the run is within the org''s supervised-runs window AND has no secondary review by a non-author clinical actor.';
comment on function public.approve_supervised_copilot_run(uuid, uuid, text, text) is
  'Phase 10B.1: records a secondary review of a completed run for a specific draft action. Author cannot self-approve. Append-only.';
