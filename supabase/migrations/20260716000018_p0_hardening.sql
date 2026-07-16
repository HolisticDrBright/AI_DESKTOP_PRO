-- 0018_p0_hardening
-- Phase 0 correctness + tenant-isolation hardening:
--   1) review_biomarker: repeating the SAME decision is idempotent — returns
--      already_set and appends NO duplicate audit row.
--   2) record_audit_event: a supplied patient MUST belong to the supplied
--      organization (a user who is a member of two organizations could
--      previously cross-reference org B's patient inside org A's audit log);
--      plus database-side caps — action/message lengths, metadata size and
--      shape — so no client can smuggle free-form clinical content into the
--      audit trail even if an app layer regresses.

-- 1) Idempotent biomarker review ------------------------------------------------
create or replace function public.review_biomarker(
  _observation_id uuid,
  _decision text,
  _note text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid   uuid := auth.uid();
  _obs   record;
  _prev  text;
  _audit uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- 'unreviewed' is the initial state, not a review decision.
  if _decision not in ('accepted', 'flagged', 'rejected') then
    raise exception 'invalid review decision: %', _decision using errcode = '22023';
  end if;

  -- Definer read bypasses RLS, so we lock the row and authorize explicitly.
  select id, organization_id, patient_id, biomarker_definition_id, review_status
    into _obs
  from public.biomarker_observations
  where id = _observation_id and deleted_at is null
  for update;

  if not found then
    raise exception 'biomarker observation not found' using errcode = 'P0002';
  end if;

  if not private.can_write_patient_data(_obs.patient_id) then
    raise exception 'not authorized to review this patient''s data' using errcode = '42501';
  end if;

  _prev := _obs.review_status;

  -- Same decision again: no state change, no duplicate audit row.
  if _prev = _decision then
    return jsonb_build_object(
      'id', _observation_id,
      'review_status', _decision,
      'reviewed_by', _uid,
      'reviewed_at', now(),
      'previous_status', _prev,
      'already_set', true,
      'audit_event_id', null
    );
  end if;

  update public.biomarker_observations
     set review_status = _decision,
         reviewed_by    = _uid,
         reviewed_at    = now(),
         updated_by     = _uid,
         updated_at     = now()
   where id = _observation_id;

  -- Append-only audit row. No raw lab value, unit, or note text — PHI-safe.
  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _obs.organization_id, _obs.patient_id, _uid, 'biomarker.review',
    'biomarker_observation', _observation_id::text,
    'Biomarker marked ' || _decision,
    jsonb_build_object(
      'decision', _decision,
      'previous_status', _prev,
      'biomarker_definition_id', _obs.biomarker_definition_id,
      'note_present', (_note is not null and length(btrim(_note)) > 0)
    )
  ) returning id into _audit;

  return jsonb_build_object(
    'id', _observation_id,
    'review_status', _decision,
    'reviewed_by', _uid,
    'reviewed_at', now(),
    'previous_status', _prev,
    'already_set', false,
    'audit_event_id', _audit
  );
end;
$$;

-- 2) Tenant-safe, capped audit writer --------------------------------------------
create or replace function public.record_audit_event(
  _organization_id uuid,
  _action text,
  _resource_type text default null,
  _resource_id text default null,
  _safe_message text default null,
  _patient_id uuid default null,
  _metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _id  uuid;
  _patient_org uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not an organization member' using errcode = '42501';
  end if;

  if _patient_id is not null then
    if not private.can_access_patient(_patient_id) then
      raise exception 'not authorized for this patient' using errcode = '42501';
    end if;
    -- TENANT ISOLATION: the patient must belong to the SUPPLIED organization —
    -- a dual-org member must not cross-reference org B's patient in org A.
    select organization_id into _patient_org
    from public.patient_profiles
    where id = _patient_id and deleted_at is null;
    if _patient_org is distinct from _organization_id then
      raise exception 'patient does not belong to this organization' using errcode = '42501';
    end if;
  end if;

  -- Shape and size caps: the audit trail stores identifiers and operational
  -- facts, never free-form clinical narrative.
  if _action is null or btrim(_action) = '' or length(_action) > 64
     or _action !~ '^[a-z0-9_.-]+$' then
    raise exception 'invalid audit action' using errcode = '22023';
  end if;
  if _resource_type is not null and length(_resource_type) > 64 then
    raise exception 'resource_type too long' using errcode = '22023';
  end if;
  if _resource_id is not null and length(_resource_id) > 128 then
    raise exception 'resource_id too long' using errcode = '22023';
  end if;
  if _safe_message is not null and length(_safe_message) > 200 then
    raise exception 'safe_message too long' using errcode = '22023';
  end if;
  if _metadata is not null then
    if jsonb_typeof(_metadata) <> 'object' then
      raise exception 'metadata must be an object' using errcode = '22023';
    end if;
    if length(_metadata::text) > 2048 then
      raise exception 'metadata too large' using errcode = '22023';
    end if;
    if (select count(*) from jsonb_object_keys(_metadata)) > 16 then
      raise exception 'too many metadata keys' using errcode = '22023';
    end if;
  end if;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _organization_id, _patient_id, _uid, _action,
    _resource_type, _resource_id, _safe_message, coalesce(_metadata, '{}'::jsonb)
  ) returning id into _id;

  return _id;
end;
$$;

-- Grants unchanged (same signatures): authenticated only; anon revoked in 0013.
