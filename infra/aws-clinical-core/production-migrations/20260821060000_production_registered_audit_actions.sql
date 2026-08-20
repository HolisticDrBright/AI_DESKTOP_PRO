-- Production-only registered generic audit actions for the Desktop UI.
-- The caller supplies a fixed event key and bounded identifiers/metadata;
-- action wording and resource classification remain database-owned.

alter table clinical_audit.events alter column resource_id drop not null;
alter table clinical_audit.events
  add column external_resource_id text,
  add column patient_record_id uuid references clinical_core.patient_records(id),
  add column safe_message text;

alter table clinical_audit.events
  add constraint events_external_resource_id_check
    check (external_resource_id is null or char_length(external_resource_id) between 1 and 128),
  add constraint events_safe_message_check
    check (safe_message is null or char_length(safe_message) between 1 and 200),
  add constraint events_resource_identity_check
    check (resource_id is null or external_resource_id is null);

create index audit_events_patient_time_idx
  on clinical_audit.events(patient_record_id, occurred_at desc)
  where patient_record_id is not null;

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed',
  'consent.granted','consent.revoked','lab_import.received',
  'lab_import.duplicate','lab_import.accepted','lab_import.rejected',
  'clinical_record.received','clinical_record.duplicate','privacy_request.submitted',
  'patient.created','lab_observation.reviewed','marker.view',
  'document.viewed','document.exported','report.exported','audit.exported'));

alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check
  check (resource_type in (
    'connection','consent','lab_import','clinical_record','privacy_request',
    'patient_profile','lab_observation','biomarker_observation','lab_document',
    'report','audit_log'));

create or replace function clinical_core.record_registered_audit_event(
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
  _action text;
  _resource_type text;
  _safe_message text;
  _patient_required boolean;
  _resource_required boolean;
  _allowed_metadata_keys text[];
  _normalized_resource text := nullif(btrim(_resource_id), '');
  _resource_uuid uuid;
  _external_resource text;
  _id uuid;
begin
  perform clinical_private.assert_production_context(
    _organization_id, 'clinical_data', 'workforce'
  );
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;

  select definition.action, definition.resource_type, definition.safe_message,
    definition.patient_required, definition.resource_required,
    definition.allowed_metadata_keys
  into _action, _resource_type, _safe_message, _patient_required,
    _resource_required, _allowed_metadata_keys
  from (values
    ('marker.view','marker.view','biomarker_observation','Marker viewed',true,true,array[]::text[]),
    ('document.viewed','document.viewed','lab_document','Source document viewed',true,true,array[]::text[]),
    ('document.exported','document.exported','lab_document','Source document exported',true,true,array['format']::text[]),
    ('report.exported','report.exported','report','Report exported',false,true,array['format','report_type']::text[]),
    ('audit.exported','audit.exported','audit_log','Audit log exported',false,false,array['format','row_count']::text[])
  ) as definition(event_type, action, resource_type, safe_message,
    patient_required, resource_required, allowed_metadata_keys)
  where definition.event_type = _event_type;

  if not found then
    raise exception using errcode = '22023', message = 'unregistered_audit_event';
  end if;
  if _resource_required and _normalized_resource is null then
    raise exception using errcode = '22023', message = 'resource_id_required';
  end if;
  if _normalized_resource is not null and char_length(_normalized_resource) > 128 then
    raise exception using errcode = '22023', message = 'resource_id_too_long';
  end if;
  if _patient_required and _patient_id is null then
    raise exception using errcode = '22023', message = 'patient_id_required';
  end if;
  if _patient_id is not null and not exists (
    select 1 from clinical_core.patient_records patient
    where patient.id = _patient_id
      and patient.organization_id = _organization_id
      and patient.deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'patient_access_refused';
  end if;

  if _metadata is null or jsonb_typeof(_metadata) <> 'object'
    or length(_metadata::text) > 2048
    or (select count(*) from jsonb_object_keys(_metadata)) > 16 then
    raise exception using errcode = '22023', message = 'metadata_invalid';
  end if;
  if exists (
    select 1 from jsonb_object_keys(_metadata) key
    where not (key = any(_allowed_metadata_keys))
  ) or exists (
    select 1 from jsonb_each(_metadata) item
    where jsonb_typeof(item.value) not in ('string','number','boolean')
  ) then
    raise exception using errcode = '22023', message = 'metadata_not_allowed';
  end if;

  if _normalized_resource ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    _resource_uuid := _normalized_resource::uuid;
  else
    _external_resource := _normalized_resource;
  end if;

  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id,
    external_resource_id, patient_record_id, safe_message, purpose, safe_metadata
  ) values (
    _organization_id, clinical_private.actor_person_id(), _action, _resource_type,
    _resource_uuid, _external_resource, _patient_id, _safe_message,
    'clinical_data', _metadata
  ) returning id into _id;
  return _id;
end
$$;

create or replace function clinical_core.list_audit_events(
  _organization_id uuid,
  _limit integer default 50
) returns table(
  id uuid,
  action text,
  resource_type text,
  resource_id text,
  safe_message text,
  patient_id uuid,
  actor_user_id uuid,
  occurred_at timestamptz,
  metadata jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  perform clinical_private.assert_production_context(
    _organization_id, 'clinical_data', 'workforce'
  );
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  if _limit < 1 or _limit > 200 then
    raise exception using errcode = '22023', message = 'limit_invalid';
  end if;

  return query
  select event.id, event.action, event.resource_type,
    coalesce(event.resource_id::text, event.external_resource_id),
    event.safe_message, event.patient_record_id, event.actor_person_id,
    event.occurred_at, event.safe_metadata
  from clinical_audit.events event
  where event.organization_id = _organization_id
  order by event.occurred_at desc, event.id desc
  limit _limit;
end
$$;

revoke all on function clinical_core.record_registered_audit_event(
  uuid, text, text, uuid, jsonb) from public;
revoke all on function clinical_core.list_audit_events(uuid, integer) from public;
grant execute on function clinical_core.record_registered_audit_event(
  uuid, text, text, uuid, jsonb) to clinical_core_api;
grant execute on function clinical_core.list_audit_events(uuid, integer)
  to clinical_core_api;
