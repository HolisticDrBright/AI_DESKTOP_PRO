-- Commercial-links revocation must go through supersedes_id, not UPDATE.
--
-- product_label_commercial_links carries a trigger from
-- private.knowledge_append_only() that raises 42501 on any UPDATE or
-- DELETE. My earlier revoke_commercial_link tried to set revoked_at +
-- revoked_reason via UPDATE and was rejected before the row ever changed.
--
-- The correct pattern (matching how the rest of the append-only knowledge
-- surface works) is: INSERT a NEW row that carries supersedes_id pointing
-- at the original, plus the revocation timestamp and reason. The original
-- row stays untouched. Queries for "the current state of this link" walk
-- through supersedes_id chains and pick the newest.

create or replace function public.revoke_commercial_link(
  _organization_id uuid,
  _link_id uuid,
  _reason text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _uid uuid;
  _link public.product_label_commercial_links%rowtype;
  _new_id uuid;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'revoking a commercial link requires a reason'
      using errcode = '22023';
  end if;
  select * into _link from public.product_label_commercial_links
    where id = _link_id and organization_id = _organization_id;
  if not found then
    raise exception 'commercial link not found'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.product_label_commercial_links
    where supersedes_id = _link_id and organization_id = _organization_id
  ) then
    raise exception 'this commercial link has already been revoked or superseded'
      using errcode = '55000';
  end if;
  insert into public.product_label_commercial_links
    (organization_id, label_version_id, kind, url, supplier_name,
     commission_disclosure, availability_status, last_verified_at,
     supersedes_id, revoked_at, revoked_reason, recorded_by)
  values
    (_link.organization_id, _link.label_version_id, _link.kind,
     _link.url, _link.supplier_name, _link.commission_disclosure,
     'discontinued', _link.last_verified_at,
     _link.id, now(), btrim(_reason), _uid)
  returning id into _new_id;
  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'catalog.commercial_link_revoked',
     'product_label_commercial_link', _new_id::text,
     'Commercial link revoked with a stated reason (superseded original)',
     jsonb_build_object('supersedes_id', _link_id, 'reason', btrim(_reason)));
  return jsonb_build_object('ok', true, 'linkId', _new_id, 'supersedesId', _link_id);
end;
$function$;
