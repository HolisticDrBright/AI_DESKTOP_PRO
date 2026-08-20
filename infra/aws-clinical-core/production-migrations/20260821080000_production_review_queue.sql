-- Production clinical review queue. Titles may contain clinical context and
-- remain in the encrypted clinical table; audit events store no title/note.

create table clinical_core.review_queue_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid references clinical_core.patient_records(id),
  item_type text not null check (item_type in (
    'lab_extraction','abnormal_result','reasoning_snapshot','hypothesis',
    'recommendation','supplement_interaction','protocol','experiment',
    'assessment','patient_message','safety_alert','refill_request',
    'low_adherence','overdue_followup')),
  reference_id uuid,
  title text not null check (char_length(title) between 1 and 200),
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  status text not null default 'open'
    check (status in ('open','in_review','resolved','snoozed','dismissed')),
  assignee_person_id uuid references clinical_core.persons(id),
  due_at timestamptz,
  created_by_person_id uuid not null references clinical_core.persons(id),
  updated_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  foreign key (patient_record_id, organization_id)
    references clinical_core.patient_records(id, organization_id)
);
create index review_queue_org_status_idx
  on clinical_core.review_queue_items(organization_id, status, priority, created_at desc);
create index review_queue_patient_idx
  on clinical_core.review_queue_items(patient_record_id, created_at desc)
  where patient_record_id is not null and deleted_at is null;

alter table clinical_core.review_queue_items enable row level security;
revoke all on clinical_core.review_queue_items from public, clinical_core_api;

create or replace function clinical_private.protect_review_queue_identity()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.organization_id <> old.organization_id
    or new.patient_record_id is distinct from old.patient_record_id
    or new.item_type <> old.item_type
    or new.reference_id is distinct from old.reference_id
    or new.title <> old.title
    or new.created_by_person_id <> old.created_by_person_id
    or new.created_at <> old.created_at then
    raise exception using errcode = '55000', message = 'review_queue_identity_immutable';
  end if;
  return new;
end
$$;
create trigger review_queue_identity_immutable
  before update on clinical_core.review_queue_items
  for each row execute function clinical_private.protect_review_queue_identity();

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed',
  'consent.granted','consent.revoked','lab_import.received',
  'lab_import.duplicate','lab_import.accepted','lab_import.rejected',
  'clinical_record.received','clinical_record.duplicate','privacy_request.submitted',
  'patient.created','lab_observation.reviewed','marker.view',
  'document.viewed','document.exported','report.exported','audit.exported',
  'membership.role_changed','membership.suspended',
  'review_task.created','review_task.resolved'));

alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check
  check (resource_type in (
    'connection','consent','lab_import','clinical_record','privacy_request',
    'patient_profile','lab_observation','biomarker_observation','lab_document',
    'report','audit_log','organization_membership','review_queue_item'));

create or replace function clinical_core.create_review_task(
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
  _organization_id uuid := clinical_private.organization_id();
  _normalized_title text := btrim(_title);
  _item_id uuid;
  _audit_id uuid;
begin
  perform clinical_private.assert_production_context(
    _organization_id, 'clinical_data', 'workforce'
  );
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  if _normalized_title is null or char_length(_normalized_title) not between 1 and 200
    or _item_type not in (
      'lab_extraction','abnormal_result','reasoning_snapshot','hypothesis',
      'recommendation','supplement_interaction','protocol','experiment',
      'assessment','patient_message','safety_alert','refill_request',
      'low_adherence','overdue_followup')
    or _priority not in ('low','medium','high') then
    raise exception using errcode = '22023', message = 'review_task_invalid';
  end if;
  if not exists (
    select 1 from clinical_core.patient_records patient
    where patient.id = _patient_id
      and patient.organization_id = _organization_id
      and patient.deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'patient_access_refused';
  end if;

  insert into clinical_core.review_queue_items(
    organization_id, patient_record_id, item_type, reference_id, title,
    priority, created_by_person_id, updated_by_person_id
  ) values (
    _organization_id, _patient_id, _item_type, _ref_id, _normalized_title,
    _priority, clinical_private.actor_person_id(), clinical_private.actor_person_id()
  ) returning id into _item_id;

  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id,
    patient_record_id, safe_message, purpose, safe_metadata
  ) values (
    _organization_id, clinical_private.actor_person_id(), 'review_task.created',
    'review_queue_item', _item_id, _patient_id, 'Review task created',
    'clinical_data', jsonb_build_object(
      'item_type', _item_type, 'priority', _priority,
      'reference_id', _ref_id)
  ) returning id into _audit_id;
  return jsonb_build_object(
    'id', _item_id, 'status', 'open', 'audit_event_id', _audit_id);
end
$$;

create or replace function clinical_core.list_review_queue(_organization_id uuid)
returns table(
  id uuid, item_type text, title text, priority text, status text,
  patient_id uuid, patient_name text, assignee_name text,
  due_at timestamptz, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform clinical_private.assert_production_context(
    _organization_id, 'clinical_data', 'workforce'
  );
  if not clinical_private.is_active_member(_organization_id) then
    raise exception using errcode = '42501', message = 'active_membership_required';
  end if;
  return query
  select item.id, item.item_type, item.title, item.priority, item.status,
    item.patient_record_id,
    nullif(btrim(concat_ws(' ', patient.first_name, patient.last_name)), ''),
    case when item.assignee_person_id = clinical_private.actor_person_id()
      then 'You' else null end,
    item.due_at, item.created_at
  from clinical_core.review_queue_items item
  left join clinical_core.patient_records patient
    on patient.id = item.patient_record_id
   and patient.organization_id = _organization_id
   and patient.deleted_at is null
  where item.organization_id = _organization_id
    and item.status <> 'dismissed'
    and item.deleted_at is null
  order by item.created_at desc, item.id
  limit 200;
end
$$;

create or replace function clinical_core.resolve_review_queue_item(
  _item_id uuid,
  _note text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _organization_id uuid := clinical_private.organization_id();
  _item clinical_core.review_queue_items%rowtype;
  _previous_status text;
  _audit_id uuid;
begin
  perform clinical_private.assert_production_context(
    _organization_id, 'clinical_data', 'workforce'
  );
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  if _note is not null and char_length(_note) > 500 then
    raise exception using errcode = '22023', message = 'review_note_too_long';
  end if;
  select * into _item from clinical_core.review_queue_items
  where id = _item_id
    and organization_id = _organization_id
    and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'review_task_not_found';
  end if;
  if _item.status = 'resolved' then
    return jsonb_build_object(
      'id', _item.id, 'status', 'resolved',
      'previous_status', 'resolved', 'already_resolved', true);
  end if;
  _previous_status := _item.status;
  update clinical_core.review_queue_items
  set status = 'resolved', updated_by_person_id = clinical_private.actor_person_id(),
    updated_at = clock_timestamp()
  where id = _item.id;

  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id,
    patient_record_id, safe_message, purpose, safe_metadata
  ) values (
    _organization_id, clinical_private.actor_person_id(), 'review_task.resolved',
    'review_queue_item', _item.id, _item.patient_record_id,
    'Review task resolved', 'clinical_data', jsonb_build_object(
      'previous_status', _previous_status, 'item_type', _item.item_type,
      'note_present', coalesce(char_length(btrim(_note)), 0) > 0)
  ) returning id into _audit_id;
  return jsonb_build_object(
    'id', _item.id, 'status', 'resolved',
    'previous_status', _previous_status, 'already_resolved', false,
    'resolved_by', clinical_private.actor_person_id(),
    'resolved_at', clock_timestamp(), 'audit_event_id', _audit_id);
end
$$;

revoke all on function clinical_core.create_review_task(uuid, text, text, text, uuid) from public;
revoke all on function clinical_core.list_review_queue(uuid) from public;
revoke all on function clinical_core.resolve_review_queue_item(uuid, text) from public;
grant execute on function clinical_core.create_review_task(uuid, text, text, text, uuid) to clinical_core_api;
grant execute on function clinical_core.list_review_queue(uuid) to clinical_core_api;
grant execute on function clinical_core.resolve_review_queue_item(uuid, text) to clinical_core_api;
