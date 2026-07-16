-- ============================================================
-- 0014 resolve_review_queue_item — the Tasks live-slice write path
--
-- Resolving a review-queue item must (a) update the row's status and
-- (b) append an audit_events row, atomically, as the authenticated
-- practitioner. audit_events is append-only (no INSERT policy), so this is a
-- SECURITY DEFINER function in the same least-privilege pattern as 0013:
-- runs as owner, but authorizes the CALLER with the same private.* helpers
-- RLS uses, and stamps actor ids from auth.uid() server-side.
--
-- Idempotent by design: resolving an already-resolved item returns its
-- current state (already_resolved = true) and writes NO duplicate audit row —
-- safe for client retries.
--
-- search_path pinned empty; EXECUTE revoked from public/anon, granted to
-- authenticated. Applied + verified against project urcjiehlxoehievobezf via
-- MCP under a simulated authenticated practitioner in a rolled-back
-- transaction (see supabase/tests/resolve_review_queue_item.sql).
-- ============================================================

create or replace function public.resolve_review_queue_item(
  _item_id uuid,
  _note text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid   uuid := auth.uid();
  _item  record;
  _audit uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select id, organization_id, patient_id, item_type, title, status
    into _item
  from public.review_queue_items
  where id = _item_id and deleted_at is null
  for update;

  if not found then
    raise exception 'review queue item not found' using errcode = 'P0002';
  end if;

  -- Patient-scoped items require write access to that patient; org-level
  -- items (patient_id null) require a practitioner/admin role in the org.
  if _item.patient_id is not null then
    if not private.can_write_patient_data(_item.patient_id) then
      raise exception 'not authorized to resolve this item' using errcode = '42501';
    end if;
  else
    if not (private.is_org_admin(_item.organization_id)
         or private.has_org_role(_item.organization_id, 'practitioner')) then
      raise exception 'not authorized to resolve this item' using errcode = '42501';
    end if;
  end if;

  if _item.status = 'resolved' then
    return jsonb_build_object(
      'id', _item.id,
      'status', 'resolved',
      'previous_status', 'resolved',
      'already_resolved', true
    );
  end if;

  update public.review_queue_items
     set status = 'resolved',
         updated_by = _uid,
         updated_at = now()
   where id = _item_id;

  -- Append-only audit row. Title stays out of metadata; safe_message only.
  insert into public.audit_events (
    organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata
  ) values (
    _item.organization_id, _item.patient_id, _uid, 'review_task.resolve',
    'review_queue_item', _item.id::text,
    'Review task resolved',
    jsonb_build_object(
      'previous_status', _item.status,
      'item_type', _item.item_type,
      'note_present', (_note is not null and length(btrim(_note)) > 0)
    )
  ) returning id into _audit;

  return jsonb_build_object(
    'id', _item.id,
    'status', 'resolved',
    'previous_status', _item.status,
    'already_resolved', false,
    'resolved_by', _uid,
    'resolved_at', now(),
    'audit_event_id', _audit
  );
end;
$$;

revoke all on function public.resolve_review_queue_item(uuid, text) from public, anon;
grant execute on function public.resolve_review_queue_item(uuid, text) to authenticated;
