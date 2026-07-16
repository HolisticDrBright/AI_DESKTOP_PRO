-- ============================================================
-- 0013 App-facing RPC functions (the secure write path)
--
-- The first backend-connected vertical slice needs to (a) mark a lab
-- biomarker reviewed and (b) write a persistent, append-only audit_events
-- row for that review — atomically, as the authenticated practitioner.
--
-- `audit_events` is append-only by design (migration 0003): it has a SELECT
-- policy for org admins and NO insert/update/delete policy, so no role except
-- service_role can write it through PostgREST directly. Rather than hand the
-- backend a service-role key for this flow (which would bypass every RLS
-- check), these SECURITY DEFINER functions are the least-privilege write path:
--   * they run as the function owner (so they can append to audit_events),
--   * but they authorize the CALLER explicitly with the same private.* helpers
--     RLS uses (auth.uid() still resolves to the caller's JWT inside a definer
--     function), and
--   * they stamp actor/reviewer ids from auth.uid() server-side — a client can
--     never spoof who performed the action.
--
-- search_path is pinned empty and every object is schema-qualified, so the
-- definer body cannot be hijacked by a caller-controlled search_path.
--
-- Applied + verified against project urcjiehlxoehievobezf via MCP under a
-- simulated authenticated practitioner in a rolled-back transaction
-- (see supabase/tests/app_facing_functions.sql).
-- ============================================================

-- ------------------------------------------------------------
-- review_biomarker: mark one biomarker_observation reviewed and append an
-- audit_events row, atomically. Updates ONLY the review columns — lab value,
-- unit, original reference interval, provenance, source and confidence are
-- never touched, so historical lab data and provenance are preserved.
-- ------------------------------------------------------------
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
    'audit_event_id', _audit
  );
end;
$$;

-- ------------------------------------------------------------
-- record_audit_event: general append-only audit writer for review actions.
-- The caller must be an active member of the org (and, if a patient is named,
-- be allowed to access that patient). actor_user_id is stamped from auth.uid().
-- Callers pass only PHI-safe safe_message / metadata (enforced at the app layer).
-- ------------------------------------------------------------
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
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not an organization member' using errcode = '42501';
  end if;
  if _patient_id is not null and not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
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

-- ------------------------------------------------------------
-- list_audit_events: read the append-only audit log for the caller's org.
-- audit_events' SELECT policy is admin-only; this lets a non-admin practitioner
-- read the events they themselves performed, while org admins see all org
-- events. Returns a jsonb array, newest first.
-- ------------------------------------------------------------
create or replace function public.list_audit_events(
  _organization_id uuid,
  _limit int default 50
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _uid      uuid := auth.uid();
  _is_admin boolean;
  _rows     jsonb;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not an organization member' using errcode = '42501';
  end if;
  _is_admin := private.is_org_admin(_organization_id);

  select coalesce(jsonb_agg(t order by t.occurred_at desc), '[]'::jsonb)
    into _rows
  from (
    select ae.id, ae.action, ae.resource_type, ae.resource_id,
           ae.safe_message, ae.metadata, ae.patient_id,
           ae.actor_user_id, ae.occurred_at
    from public.audit_events ae
    where ae.organization_id = _organization_id
      and (_is_admin or ae.actor_user_id = _uid)
    order by ae.occurred_at desc
    limit least(greatest(_limit, 1), 200)
  ) t;

  return _rows;
end;
$$;

-- ------------------------------------------------------------
-- create_review_task: downstream link from a review — enqueue a review_queue
-- item (default an abnormal-result review) and audit it. Org is derived from
-- the patient server-side; the caller only needs write access to the patient.
-- ------------------------------------------------------------
create or replace function public.create_review_task(
  _patient_id uuid,
  _title text,
  _item_type text default 'abnormal_result',
  _priority text default 'medium',
  _ref_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid   uuid := auth.uid();
  _org   uuid;
  _item  uuid;
  _audit uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if _item_type not in (
    'lab_extraction','abnormal_result','reasoning_snapshot','hypothesis',
    'recommendation','supplement_interaction','protocol','experiment',
    'assessment','patient_message','safety_alert','refill_request',
    'low_adherence','overdue_followup'
  ) then
    raise exception 'invalid item_type: %', _item_type using errcode = '22023';
  end if;
  if _priority not in ('low', 'medium', 'high') then
    raise exception 'invalid priority: %', _priority using errcode = '22023';
  end if;

  if not private.can_write_patient_data(_patient_id) then
    raise exception 'not authorized to create tasks for this patient' using errcode = '42501';
  end if;

  select organization_id into _org from public.patient_profiles where id = _patient_id;
  if _org is null then
    raise exception 'patient not found' using errcode = 'P0002';
  end if;

  insert into public.review_queue_items (
    organization_id, patient_id, item_type, ref_id, title,
    priority, status, created_by, updated_by
  ) values (
    _org, _patient_id, _item_type, _ref_id, _title,
    _priority, 'open', _uid, _uid
  ) returning id into _item;

  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _org, _patient_id, _uid, 'review_task.create',
    'review_queue_item', _item::text,
    'Created review task',
    jsonb_build_object('item_type', _item_type, 'priority', _priority, 'ref_id', _ref_id)
  ) returning id into _audit;

  return jsonb_build_object('id', _item, 'status', 'open', 'audit_event_id', _audit);
end;
$$;

-- ------------------------------------------------------------
-- Least privilege: these are only for signed-in users. Revoke both the
-- implicit PUBLIC grant AND the explicit anon grant that Supabase's default
-- privileges attach to every new public function, then grant to authenticated.
-- ------------------------------------------------------------
revoke all on function public.review_biomarker(uuid, text, text) from public, anon;
revoke all on function public.record_audit_event(uuid, text, text, text, text, uuid, jsonb) from public, anon;
revoke all on function public.list_audit_events(uuid, int) from public, anon;
revoke all on function public.create_review_task(uuid, text, text, text, uuid) from public, anon;

grant execute on function public.review_biomarker(uuid, text, text) to authenticated;
grant execute on function public.record_audit_event(uuid, text, text, text, text, uuid, jsonb) to authenticated;
grant execute on function public.list_audit_events(uuid, int) to authenticated;
grant execute on function public.create_review_task(uuid, text, text, text, uuid) to authenticated;
