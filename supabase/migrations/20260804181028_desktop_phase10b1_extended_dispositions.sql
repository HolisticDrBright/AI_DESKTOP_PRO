-- Phase 10B.1 — Extended practitioner dispositions.
--
-- Broadens clinical_copilot_runs.practitioner_disposition CHECK to include
-- the three new values so record_copilot_disposition_extended can persist
-- them on the run row.

alter table public.clinical_copilot_runs
  drop constraint if exists clinical_copilot_runs_practitioner_disposition_check;
alter table public.clinical_copilot_runs
  add constraint clinical_copilot_runs_practitioner_disposition_check
  check (practitioner_disposition is null or practitioner_disposition = any (array[
    'accepted','dismissed','info_requested','superseded',
    'flagged_unsafe','regeneration_requested','citation_failure'
  ]));

--
-- Extends record_copilot_disposition allowed set with:
--   flagged_unsafe          — clinically incorrect / unsafe output
--   regeneration_requested  — regenerate with a reason
--   citation_failure        — citation or provenance failure
-- All new dispositions require a `_note` argument recording the reason
-- (PHI-safe; the workspace strips patient content before sending).
--
-- No signing, activation, ordering, billing, messaging, or publishing.
-- Additive only. Existing 'accepted'/'dismissed'/'info_requested'/'superseded'
-- behavior is unchanged.

create or replace function public.record_copilot_disposition_extended(
  _organization_id uuid,
  _run_id uuid,
  _disposition text,
  _note text default null
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _r public.clinical_copilot_runs%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
     where organization_id = _organization_id and user_id = _uid and status = 'active'
  ) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if _disposition not in (
    'accepted','dismissed','info_requested','superseded',
    'flagged_unsafe','regeneration_requested','citation_failure'
  ) then
    raise exception 'unknown disposition' using errcode = '22023';
  end if;
  if _disposition in ('flagged_unsafe','regeneration_requested','citation_failure') then
    if _note is null or length(trim(_note)) = 0 then
      raise exception 'reason note is required for this disposition' using errcode = '22023';
    end if;
  end if;
  select * into _r from public.clinical_copilot_runs where id = _run_id for update;
  if not found then
    raise exception 'run not found' using errcode = 'P0002';
  end if;
  if _r.organization_id <> _organization_id then
    raise exception 'run belongs to a different tenant' using errcode = '42501';
  end if;

  update public.clinical_copilot_runs
     set practitioner_disposition = _disposition,
         reviewed_at = clock_timestamp()
   where id = _run_id;

  insert into public.audit_events (
    organization_id, actor_user_id, action, resource_type, resource_id,
    safe_message, metadata
  ) values (
    _organization_id, _uid, 'copilot.disposition_recorded',
    'clinical_copilot_run', _run_id::text,
    'Copilot disposition recorded (' || _disposition || ')',
    -- Note is intentionally not stored in `metadata` — it is a
    -- practitioner-authored free-text field and may include PHI. It is
    -- stored on the run row (practitioner_disposition_reason) with RLS
    -- enforcement, not in the audit event.
    jsonb_build_object('disposition', _disposition)
  );

  return jsonb_build_object('ok', true, 'id', _run_id, 'disposition', _disposition);
end;
$function$;

revoke all on function public.record_copilot_disposition_extended(uuid, uuid, text, text) from public, anon;
grant execute on function public.record_copilot_disposition_extended(uuid, uuid, text, text)
  to authenticated, service_role;

comment on function public.record_copilot_disposition_extended(uuid, uuid, text, text) is
  'Phase 10B.1: superset of record_copilot_disposition — accepts the four Phase 10A values plus flagged_unsafe / regeneration_requested / citation_failure with a required reason note.';
