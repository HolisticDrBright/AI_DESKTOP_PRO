-- Desktop-owned generic audit actions.
--
-- Domain mutations (lab review, note signing, recording, lens evaluation,
-- queue resolution) continue to append their audit row inside the same
-- transaction. This registry covers the smaller set of generic UI events that
-- are not themselves a domain mutation. The caller supplies only a registered
-- event key, identifiers, and tightly bounded scalar metadata; stored wording
-- and resource type remain database-owned.

begin;

create table if not exists private.audit_event_registry (
  event_type text primary key
    check (event_type ~ '^[a-z0-9_.-]+$' and char_length(event_type) <= 64),
  action text not null
    check (action ~ '^[a-z0-9_.-]+$' and char_length(action) <= 64),
  resource_type text not null
    check (char_length(resource_type) between 1 and 64),
  safe_message text not null
    check (char_length(safe_message) between 1 and 200),
  patient_required boolean not null default false,
  resource_required boolean not null default true,
  allowed_metadata_keys text[] not null default '{}'::text[],
  enabled boolean not null default true
);

revoke all privileges on table private.audit_event_registry
from public, anon, authenticated;

insert into private.audit_event_registry (
  event_type,
  action,
  resource_type,
  safe_message,
  patient_required,
  resource_required,
  allowed_metadata_keys
) values
  (
    'marker.view',
    'marker.view',
    'biomarker_observation',
    'Marker viewed',
    true,
    true,
    '{}'::text[]
  ),
  (
    'document.viewed',
    'document.viewed',
    'lab_document',
    'Source document viewed',
    true,
    true,
    '{}'::text[]
  ),
  (
    'document.exported',
    'document.exported',
    'lab_document',
    'Source document exported',
    true,
    true,
    array['format']
  ),
  (
    'report.exported',
    'report.exported',
    'report',
    'Report exported',
    false,
    true,
    array['format', 'report_type']
  ),
  (
    'audit.exported',
    'audit.exported',
    'audit_log',
    'Audit log exported',
    false,
    false,
    array['format', 'row_count']
  )
on conflict (event_type) do update
set action = excluded.action,
    resource_type = excluded.resource_type,
    safe_message = excluded.safe_message,
    patient_required = excluded.patient_required,
    resource_required = excluded.resource_required,
    allowed_metadata_keys = excluded.allowed_metadata_keys,
    enabled = true;

create or replace function public.record_registered_audit_event(
  _organization_id uuid,
  _event_type text,
  _resource_id text default null,
  _patient_id uuid default null,
  _metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _definition private.audit_event_registry%rowtype;
  _patient_org uuid;
  _id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if not private.is_org_member(_organization_id) then
    raise exception 'not an organization member' using errcode = '42501';
  end if;

  select *
  into _definition
  from private.audit_event_registry
  where event_type = _event_type
    and enabled;

  if not found then
    raise exception 'unregistered audit event' using errcode = '22023';
  end if;

  if _definition.resource_required
     and (_resource_id is null or btrim(_resource_id) = '') then
    raise exception 'resource id required' using errcode = '22023';
  end if;
  if _resource_id is not null and char_length(_resource_id) > 128 then
    raise exception 'resource id too long' using errcode = '22023';
  end if;

  if _definition.patient_required and _patient_id is null then
    raise exception 'patient id required' using errcode = '22023';
  end if;

  if _patient_id is not null then
    if not private.can_access_patient(_patient_id) then
      raise exception 'not authorized for this patient' using errcode = '42501';
    end if;

    select organization_id
    into _patient_org
    from public.patient_profiles
    where id = _patient_id
      and deleted_at is null;

    if _patient_org is distinct from _organization_id then
      raise exception 'patient does not belong to this organization' using errcode = '42501';
    end if;
  end if;

  if _metadata is null or jsonb_typeof(_metadata) <> 'object' then
    raise exception 'metadata must be an object' using errcode = '22023';
  end if;
  if length(_metadata::text) > 2048 then
    raise exception 'metadata too large' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(_metadata)) > 16 then
    raise exception 'too many metadata keys' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(_metadata) key
    where not (key = any(_definition.allowed_metadata_keys))
  ) then
    raise exception 'metadata key is not allowed for this event' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_each(_metadata) item
    where jsonb_typeof(item.value) not in ('string', 'number', 'boolean')
  ) then
    raise exception 'metadata values must be scalar' using errcode = '22023';
  end if;

  insert into public.audit_events (
    organization_id,
    patient_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    safe_message,
    metadata
  ) values (
    _organization_id,
    _patient_id,
    _uid,
    _definition.action,
    _definition.resource_type,
    nullif(btrim(_resource_id), ''),
    _definition.safe_message,
    _metadata
  )
  returning id into _id;

  return _id;
end;
$$;

revoke all on function public.record_registered_audit_event(
  uuid, text, text, uuid, jsonb
) from public, anon;
grant execute on function public.record_registered_audit_event(
  uuid, text, text, uuid, jsonb
) to authenticated;

-- Make the existing read contract explicit for Data API configurations that
-- no longer expose new functions automatically.
revoke all on function public.list_audit_events(uuid, int) from public, anon;
grant execute on function public.list_audit_events(uuid, int) to authenticated;

commit;
