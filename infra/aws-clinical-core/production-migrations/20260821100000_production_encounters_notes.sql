-- Production encounter and signed clinical-note lifecycle. No rows are seeded.

alter table clinical_core.appointments add constraint appointments_identity_patient_uniq
  unique (id, organization_id, patient_record_id);

create or replace function clinical_private.appointment_transition_allowed(_from text, _to text)
returns boolean language sql immutable security invoker set search_path = '' as $$
  select case _from
    when 'scheduled' then _to in ('confirmed','arrived','in_encounter','cancelled','no_show')
    when 'confirmed' then _to in ('arrived','in_encounter','cancelled','no_show')
    when 'arrived' then _to in ('in_encounter','completed','cancelled','no_show')
    when 'in_encounter' then _to in ('completed','cancelled')
    else false end
$$;

create table clinical_core.encounters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  appointment_id uuid references clinical_core.appointments(id),
  visit_type text not null check (visit_type in
    ('initial','follow-up','lab-review','supplement','telehealth','acute','administrative')),
  status text not null default 'in_progress' check (status in
    ('scheduled','in_progress','completed','cancelled','entered_in_error')),
  status_reason text check (status_reason is null or char_length(status_reason) between 1 and 1000),
  practitioner_person_id uuid not null references clinical_core.persons(id),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  foreign key (patient_record_id, organization_id)
    references clinical_core.patient_records(id, organization_id),
  foreign key (appointment_id, organization_id, patient_record_id)
    references clinical_core.appointments(id, organization_id, patient_record_id),
  unique (id, organization_id, patient_record_id)
);
create index encounters_patient_time_idx
  on clinical_core.encounters(patient_record_id, started_at desc) where deleted_at is null;
create unique index encounters_one_active_per_appointment_idx
  on clinical_core.encounters(appointment_id)
  where appointment_id is not null and status = 'in_progress' and deleted_at is null;

create table clinical_core.clinical_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  encounter_id uuid not null references clinical_core.encounters(id),
  note_type text not null check (note_type in
    ('soap','narrative','follow_up','adime','patient_instructions')),
  status text not null default 'draft' check (status in
    ('draft','ready_for_review','signed','amended','entered_in_error')),
  current_version integer not null default 0 check (current_version >= 0),
  author_person_id uuid not null references clinical_core.persons(id),
  status_reason text check (status_reason is null or char_length(status_reason) between 1 and 1000),
  signed_at timestamptz,
  signed_by_person_id uuid references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  foreign key (patient_record_id, organization_id)
    references clinical_core.patient_records(id, organization_id),
  foreign key (encounter_id, organization_id, patient_record_id)
    references clinical_core.encounters(id, organization_id, patient_record_id)
);
create index clinical_notes_encounter_idx on clinical_core.clinical_notes(encounter_id, updated_at desc);
create index clinical_notes_patient_idx
  on clinical_core.clinical_notes(patient_record_id, created_at desc) where deleted_at is null;

create table clinical_core.clinical_note_versions (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references clinical_core.clinical_notes(id),
  version integer not null check (version > 0),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  save_kind text not null check (save_kind in ('autosave','manual')),
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (note_id, version)
);
create table clinical_core.note_signatures (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null unique references clinical_core.clinical_notes(id),
  note_version integer not null check (note_version > 0),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  signed_by_person_id uuid not null references clinical_core.persons(id),
  signed_at timestamptz not null default clock_timestamp(),
  attestation text not null default 'I attest this note is accurate and complete.'
    check (char_length(attestation) between 1 and 500),
  foreign key (note_id, note_version)
    references clinical_core.clinical_note_versions(note_id, version)
);
create table clinical_core.note_addenda (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references clinical_core.clinical_notes(id),
  referenced_version integer not null check (referenced_version > 0),
  author_person_id uuid not null references clinical_core.persons(id),
  reason text not null check (char_length(reason) between 1 and 500),
  content text not null check (char_length(content) between 1 and 65536),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (note_id, referenced_version)
    references clinical_core.clinical_note_versions(note_id, version)
);
create table clinical_core.note_provenance_refs (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references clinical_core.clinical_notes(id),
  section_key text not null check (char_length(section_key) between 1 and 60),
  ref_type text not null check (ref_type in
    ('appointment','encounter','lab_observation','lab_document','patient_form','chart_item',
     'practitioner_entered','transcript','differential_question','lens_evaluation')),
  ref_id uuid,
  label text not null check (char_length(label) between 1 and 200),
  created_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp()
);

alter table clinical_core.encounters enable row level security;
alter table clinical_core.clinical_notes enable row level security;
alter table clinical_core.clinical_note_versions enable row level security;
alter table clinical_core.note_signatures enable row level security;
alter table clinical_core.note_addenda enable row level security;
alter table clinical_core.note_provenance_refs enable row level security;
revoke all on clinical_core.encounters, clinical_core.clinical_notes,
  clinical_core.clinical_note_versions, clinical_core.note_signatures,
  clinical_core.note_addenda, clinical_core.note_provenance_refs
  from public, clinical_core_api;

create or replace function clinical_private.forbid_note_versions_after_signing()
returns trigger language plpgsql security definer set search_path = '' as $$
declare _status text;
begin
  select status into _status from clinical_core.clinical_notes where id = new.note_id;
  if _status in ('signed','amended','entered_in_error') then
    raise exception using errcode='22023',message='note_content_frozen'; end if;
  return new;
end $$;
create trigger clinical_note_versions_freeze before insert on clinical_core.clinical_note_versions
  for each row execute function clinical_private.forbid_note_versions_after_signing();
create trigger clinical_note_versions_append_only before update or delete on clinical_core.clinical_note_versions
  for each row execute function clinical_private.block_update_delete();
create trigger note_signatures_append_only before update or delete on clinical_core.note_signatures
  for each row execute function clinical_private.block_update_delete();
create trigger note_addenda_append_only before update or delete on clinical_core.note_addenda
  for each row execute function clinical_private.block_update_delete();
create or replace function clinical_private.forbid_provenance_after_signing()
returns trigger language plpgsql security definer set search_path = '' as $$
declare _note_id uuid := case when tg_op='DELETE' then old.note_id else new.note_id end; _status text;
begin
  select status into _status from clinical_core.clinical_notes where id=_note_id;
  if _status in ('signed','amended','entered_in_error') then
    raise exception using errcode='22023',message='note_provenance_frozen'; end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger note_provenance_freeze before insert or update or delete on clinical_core.note_provenance_refs
  for each row execute function clinical_private.forbid_provenance_after_signing();

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed','consent.granted','consent.revoked',
  'lab_import.received','lab_import.duplicate','lab_import.accepted','lab_import.rejected',
  'clinical_record.received','clinical_record.duplicate','privacy_request.submitted','patient.created',
  'lab_observation.reviewed','marker.view','document.viewed','document.exported','report.exported',
  'audit.exported','membership.role_changed','membership.suspended','review_task.created',
  'review_task.resolved','appointment.booked','appointment.rescheduled','appointment.status_changed',
  'appointment.corrected','encounter.started','encounter.completed','encounter.cancelled',
  'encounter.entered_in_error','note.draft_created','note.draft_saved','note.ready_for_review',
  'note.signed','note.addendum_created','note.entered_in_error'));
alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check check (resource_type in (
  'connection','consent','lab_import','clinical_record','privacy_request','patient_profile',
  'lab_observation','biomarker_observation','lab_document','report','audit_log',
  'organization_membership','review_queue_item','appointment','encounter','clinical_note'));

create or replace function clinical_private.require_clinical_patient(
  _organization_id uuid, _patient_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare _actor uuid := clinical_private.actor_person_id();
begin
  perform clinical_private.assert_production_context(_organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  if not exists(select 1 from clinical_core.patient_records patient
    where patient.id=_patient_id and patient.organization_id=_organization_id
      and patient.deleted_at is null and patient.status='active') then
    raise exception using errcode='P0002',message='patient_not_found'; end if;
  return _actor;
end $$;

create or replace function clinical_core.start_encounter(
  _organization_id uuid,_patient_id uuid,_visit_type text default 'follow-up',_appointment_id uuid default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare _actor uuid; _appointment clinical_core.appointments%rowtype; _id uuid;
begin
  _actor := clinical_private.require_clinical_patient(_organization_id,_patient_id);
  if _visit_type not in ('initial','follow-up','lab-review','supplement','telehealth','acute','administrative') then
    raise exception using errcode='22023',message='visit_type_invalid'; end if;
  if _appointment_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(_appointment_id::text,0));
    select * into _appointment from clinical_core.appointments where id=_appointment_id and deleted_at is null;
    if not found then raise exception using errcode='P0002',message='appointment_not_found'; end if;
    if _appointment.organization_id<>_organization_id or _appointment.patient_record_id<>_patient_id then
      raise exception using errcode='42501',message='appointment_patient_mismatch'; end if;
    select id into _id from clinical_core.encounters where appointment_id=_appointment_id
      and status='in_progress' and deleted_at is null;
    if found then return _id; end if;
  end if;
  insert into clinical_core.encounters(organization_id,patient_record_id,appointment_id,visit_type,status,
    practitioner_person_id,started_at) values(_organization_id,_patient_id,_appointment_id,_visit_type,
    'in_progress',_actor,clock_timestamp()) returning id into _id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_organization_id,_actor,'encounter.started',
    'encounter',_id,_patient_id,'Encounter started','clinical_data',jsonb_build_object(
      'visit_type',_visit_type,'appointment_linked',_appointment_id is not null));
  if _appointment_id is not null and _appointment.status in ('scheduled','confirmed','arrived') then
    perform clinical_core.transition_appointment(_appointment_id,'in_encounter',_appointment.version,
      'encounter-start:'||_id::text,null);
  end if;
  return _id;
end $$;

create or replace function clinical_core.set_encounter_status(_encounter_id uuid,_status text,_reason text default null)
returns void language plpgsql security definer set search_path='' as $$
declare _actor uuid; _encounter clinical_core.encounters%rowtype; _appointment clinical_core.appointments%rowtype;
begin
  select * into _encounter from clinical_core.encounters where id=_encounter_id and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='encounter_not_found'; end if;
  _actor := clinical_private.require_clinical_patient(_encounter.organization_id,_encounter.patient_record_id);
  if _status not in ('completed','cancelled','entered_in_error')
    or not ((_encounter.status='in_progress' and _status in ('completed','cancelled','entered_in_error'))
      or (_encounter.status='scheduled' and _status in ('cancelled','entered_in_error'))) then
    raise exception using errcode='22023',message='encounter_transition_refused'; end if;
  if _status='entered_in_error' and nullif(btrim(_reason),'') is null then
    raise exception using errcode='22023',message='reason_required'; end if;
  if char_length(coalesce(_reason,''))>1000 then raise exception using errcode='22023',message='reason_too_long'; end if;
  update clinical_core.encounters set status=_status,
    ended_at=case when _status='completed' then clock_timestamp() else ended_at end,
    status_reason=coalesce(nullif(btrim(_reason),''),status_reason),updated_at=clock_timestamp()
    where id=_encounter.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_encounter.organization_id,_actor,
    'encounter.'||_status,'encounter',_encounter.id,_encounter.patient_record_id,
    case _status when 'completed' then 'Encounter completed' when 'cancelled' then 'Encounter cancelled'
      else 'Encounter marked entered in error' end,'clinical_data',jsonb_build_object(
        'previous_status',_encounter.status,'reason_present',coalesce(char_length(btrim(_reason)),0)>0));
  if _encounter.appointment_id is not null and _status in ('completed','cancelled') then
    select * into _appointment from clinical_core.appointments where id=_encounter.appointment_id and deleted_at is null;
    if found and _appointment.status='in_encounter' then
      perform clinical_core.transition_appointment(_appointment.id,_status,_appointment.version,
        'encounter-end:'||_encounter.id::text,null); end if;
  end if;
end $$;

create or replace function clinical_core.save_note_draft(
  _organization_id uuid,_encounter_id uuid,_note_type text,_content jsonb,_expected_version integer,
  _note_id uuid default null,_save_kind text default 'autosave',_provenance jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _encounter clinical_core.encounters%rowtype; _note clinical_core.clinical_notes%rowtype;
  _version integer; _sha text; _saved_at timestamptz := clock_timestamp();
begin
  select * into _encounter from clinical_core.encounters where id=_encounter_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='encounter_not_found'; end if;
  _actor := clinical_private.require_clinical_patient(_organization_id,_encounter.patient_record_id);
  if _encounter.organization_id<>_organization_id or _encounter.status not in ('in_progress','completed') then
    raise exception using errcode='42501',message='encounter_documentation_refused'; end if;
  if _note_type not in ('soap','narrative','follow_up','adime','patient_instructions')
    or jsonb_typeof(_content)<>'object' or octet_length(_content::text)>262144
    or _save_kind not in ('autosave','manual') or _expected_version<0 then
    raise exception using errcode='22023',message='note_payload_invalid'; end if;
  if exists(select 1 from jsonb_each(_content) part where char_length(part.key)>60
    or jsonb_typeof(part.value)<>'string' or char_length(part.value#>>'{}')>65536) then
    raise exception using errcode='22023',message='note_content_invalid'; end if;
  if jsonb_typeof(_provenance)<>'array' or jsonb_array_length(_provenance)>50 then
    raise exception using errcode='22023',message='provenance_invalid'; end if;
  _sha := pg_catalog.encode(public.digest(pg_catalog.convert_to(_content::text,'UTF8'),'sha256'),'hex');
  if _note_id is null then
    if _expected_version<>0 then raise exception using errcode='40001',message='note_version_conflict'; end if;
    insert into clinical_core.clinical_notes(organization_id,patient_record_id,encounter_id,note_type,
      status,current_version,author_person_id) values(_organization_id,_encounter.patient_record_id,
      _encounter_id,_note_type,'draft',1,_actor) returning * into _note;
    _version:=1;
    insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
      patient_record_id,safe_message,purpose,safe_metadata) values(_organization_id,_actor,
      'note.draft_created','clinical_note',_note.id,_note.patient_record_id,'Draft note created',
      'clinical_data',jsonb_build_object('note_type',_note_type));
  else
    select * into _note from clinical_core.clinical_notes where id=_note_id and deleted_at is null for update;
    if not found then raise exception using errcode='P0002',message='note_not_found'; end if;
    if _note.organization_id<>_organization_id or _note.encounter_id<>_encounter_id then
      raise exception using errcode='42501',message='note_encounter_mismatch'; end if;
    if _note.status not in ('draft','ready_for_review') then
      raise exception using errcode='22023',message='note_content_frozen'; end if;
    if _note.current_version<>_expected_version then
      raise exception using errcode='40001',message='note_version_conflict'; end if;
    _version:=_note.current_version+1;
    update clinical_core.clinical_notes set current_version=_version,status='draft',updated_at=_saved_at
      where id=_note.id;
    insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
      patient_record_id,safe_message,purpose,safe_metadata) values(_organization_id,_actor,
      'note.draft_saved','clinical_note',_note.id,_note.patient_record_id,'Draft note saved',
      'clinical_data',jsonb_build_object('version',_version,'save_kind',_save_kind));
  end if;
  insert into clinical_core.clinical_note_versions(note_id,version,content,content_sha256,save_kind,
    created_by_person_id,created_at) values(_note.id,_version,_content,_sha,_save_kind,_actor,_saved_at);
  delete from clinical_core.note_provenance_refs where note_id=_note.id;
  begin
    insert into clinical_core.note_provenance_refs(note_id,section_key,ref_type,ref_id,label,created_by_person_id)
    select _note.id,entry->>'sectionKey',entry->>'refType',nullif(entry->>'refId','')::uuid,
      entry->>'label',_actor from jsonb_array_elements(_provenance) entry;
  exception when check_violation or invalid_text_representation or not_null_violation then
    raise exception using errcode='22023',message='provenance_invalid';
  end;
  return jsonb_build_object('note_id',_note.id,'version',_version,'saved_at',_saved_at,'status','draft');
end $$;

create or replace function clinical_core.mark_note_ready(_note_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare _actor uuid; _note clinical_core.clinical_notes%rowtype;
begin
  select * into _note from clinical_core.clinical_notes where id=_note_id and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='note_not_found'; end if;
  _actor:=clinical_private.require_clinical_patient(_note.organization_id,_note.patient_record_id);
  if _note.status<>'draft' or _note.current_version<1 then
    raise exception using errcode='22023',message='note_not_ready'; end if;
  update clinical_core.clinical_notes set status='ready_for_review',updated_at=clock_timestamp() where id=_note.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_note.organization_id,_actor,
    'note.ready_for_review','clinical_note',_note.id,_note.patient_record_id,'Note marked ready for review',
    'clinical_data',jsonb_build_object('version',_note.current_version));
end $$;

create or replace function clinical_core.sign_note(_note_id uuid,_expected_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _note clinical_core.clinical_notes%rowtype; _version clinical_core.clinical_note_versions%rowtype;
  _signature clinical_core.note_signatures%rowtype;
begin
  select * into _note from clinical_core.clinical_notes where id=_note_id and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='note_not_found'; end if;
  _actor:=clinical_private.require_clinical_patient(_note.organization_id,_note.patient_record_id);
  select * into _signature from clinical_core.note_signatures where note_id=_note.id;
  if found then
    if _signature.note_version=_expected_version then return jsonb_build_object('signature_id',_signature.id,
      'already_signed',true,'version',_signature.note_version,'signed_at',_signature.signed_at); end if;
    raise exception using errcode='22023',message='note_already_signed';
  end if;
  if _note.status not in ('draft','ready_for_review') or _note.current_version<>_expected_version then
    raise exception using errcode='40001',message='note_version_conflict'; end if;
  select * into _version from clinical_core.clinical_note_versions
    where note_id=_note.id and version=_note.current_version;
  if not found then raise exception using errcode='22023',message='note_content_missing'; end if;
  insert into clinical_core.note_signatures(note_id,note_version,content_sha256,signed_by_person_id)
    values(_note.id,_version.version,_version.content_sha256,_actor) returning * into _signature;
  update clinical_core.clinical_notes set status='signed',signed_at=_signature.signed_at,
    signed_by_person_id=_actor,updated_at=_signature.signed_at where id=_note.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_note.organization_id,_actor,'note.signed',
    'clinical_note',_note.id,_note.patient_record_id,'Note signed','clinical_data',
    jsonb_build_object('version',_version.version));
  return jsonb_build_object('signature_id',_signature.id,'already_signed',false,
    'version',_signature.note_version,'signed_at',_signature.signed_at);
end $$;

create or replace function clinical_core.add_note_addendum(_note_id uuid,_reason text,_content text)
returns uuid language plpgsql security definer set search_path='' as $$
declare _actor uuid; _note clinical_core.clinical_notes%rowtype; _signature clinical_core.note_signatures%rowtype; _id uuid;
begin
  select * into _note from clinical_core.clinical_notes where id=_note_id and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='note_not_found'; end if;
  _actor:=clinical_private.require_clinical_patient(_note.organization_id,_note.patient_record_id);
  if _note.status not in ('signed','amended') or nullif(btrim(_reason),'') is null
    or nullif(btrim(_content),'') is null or char_length(_reason)>500 or char_length(_content)>65536 then
    raise exception using errcode='22023',message='addendum_invalid'; end if;
  select * into _signature from clinical_core.note_signatures where note_id=_note.id;
  insert into clinical_core.note_addenda(note_id,referenced_version,author_person_id,reason,content)
    values(_note.id,coalesce(_signature.note_version,_note.current_version),_actor,btrim(_reason),_content)
    returning id into _id;
  update clinical_core.clinical_notes set status='amended',updated_at=clock_timestamp() where id=_note.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_note.organization_id,_actor,
    'note.addendum_created','clinical_note',_note.id,_note.patient_record_id,'Addendum added',
    'clinical_data',jsonb_build_object('referenced_version',coalesce(_signature.note_version,_note.current_version)));
  return _id;
end $$;

create or replace function clinical_core.mark_note_error(_note_id uuid,_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare _actor uuid; _note clinical_core.clinical_notes%rowtype;
begin
  select * into _note from clinical_core.clinical_notes where id=_note_id and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='note_not_found'; end if;
  _actor:=clinical_private.require_clinical_patient(_note.organization_id,_note.patient_record_id);
  if nullif(btrim(_reason),'') is null or char_length(_reason)>1000 then
    raise exception using errcode='22023',message='reason_required'; end if;
  if _note.status='entered_in_error' then return; end if;
  update clinical_core.clinical_notes set status='entered_in_error',status_reason=btrim(_reason),
    updated_at=clock_timestamp() where id=_note.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_note.organization_id,_actor,
    'note.entered_in_error','clinical_note',_note.id,_note.patient_record_id,'Note marked entered in error',
    'clinical_data',jsonb_build_object('previous_status',_note.status,'reason_present',true));
end $$;

create or replace function clinical_core.get_desktop_encounter(_encounter_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _encounter clinical_core.encounters%rowtype; _notes jsonb;
begin
  select * into _encounter from clinical_core.encounters where id=_encounter_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='encounter_not_found'; end if;
  perform clinical_private.require_clinical_patient(_encounter.organization_id,_encounter.patient_record_id);
  select coalesce(jsonb_agg(jsonb_build_object('note_id',note.id,'encounter_id',note.encounter_id,
    'patient_id',note.patient_record_id,'note_type',note.note_type,'status',note.status,
    'current_version',note.current_version,'author_user_id',note.author_person_id,
    'status_reason',note.status_reason,'created_at',note.created_at,'updated_at',note.updated_at)
    order by note.updated_at desc,note.id),'[]'::jsonb) into _notes
    from clinical_core.clinical_notes note where note.encounter_id=_encounter.id and note.deleted_at is null;
  return jsonb_build_object('encounter',jsonb_build_object('encounter_id',_encounter.id,
    'organization_id',_encounter.organization_id,'patient_id',_encounter.patient_record_id,
    'appointment_id',_encounter.appointment_id,'visit_type',_encounter.visit_type,'status',_encounter.status,
    'started_at',_encounter.started_at,'ended_at',_encounter.ended_at,'status_reason',_encounter.status_reason,
    'created_at',_encounter.created_at),'notes',_notes);
end $$;

create or replace function clinical_core.list_desktop_patient_encounters(_patient_id uuid,_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _patient clinical_core.patient_records%rowtype; _rows jsonb;
begin
  select * into _patient from clinical_core.patient_records where id=_patient_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='patient_not_found'; end if;
  perform clinical_private.require_clinical_patient(_patient.organization_id,_patient.id);
  if _limit<1 or _limit>200 then raise exception using errcode='22023',message='limit_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('encounter_id',encounter.id,'organization_id',encounter.organization_id,
    'patient_id',encounter.patient_record_id,'appointment_id',encounter.appointment_id,
    'visit_type',encounter.visit_type,'status',encounter.status,'started_at',encounter.started_at,
    'ended_at',encounter.ended_at,'status_reason',encounter.status_reason,'created_at',encounter.created_at)
    order by coalesce(encounter.started_at,encounter.created_at) desc,encounter.id),'[]'::jsonb) into _rows
    from (select * from clinical_core.encounters where patient_record_id=_patient_id and deleted_at is null
      order by coalesce(started_at,created_at) desc,id limit _limit) encounter;
  return _rows;
end $$;

create or replace function clinical_core.get_desktop_note(_note_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _note clinical_core.clinical_notes%rowtype; _version clinical_core.clinical_note_versions%rowtype;
  _signature jsonb; _addenda jsonb; _provenance jsonb;
begin
  select * into _note from clinical_core.clinical_notes where id=_note_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='note_not_found'; end if;
  perform clinical_private.require_clinical_patient(_note.organization_id,_note.patient_record_id);
  select * into _version from clinical_core.clinical_note_versions
    where note_id=_note.id and version=_note.current_version;
  select jsonb_build_object('signature_id',signature.id,'version',signature.note_version,
    'signed_by',signature.signed_by_person_id,'signed_at',signature.signed_at,
    'attestation',signature.attestation) into _signature from clinical_core.note_signatures signature
    where signature.note_id=_note.id;
  select coalesce(jsonb_agg(jsonb_build_object('addendum_id',addendum.id,
    'referenced_version',addendum.referenced_version,'author_user_id',addendum.author_person_id,
    'reason',addendum.reason,'content',addendum.content,'created_at',addendum.created_at)
    order by addendum.created_at,addendum.id),'[]'::jsonb) into _addenda
    from clinical_core.note_addenda addendum where addendum.note_id=_note.id;
  select coalesce(jsonb_agg(jsonb_build_object('section_key',provenance.section_key,
    'ref_type',provenance.ref_type,'ref_id',provenance.ref_id,'label',provenance.label)
    order by provenance.created_at,provenance.id),'[]'::jsonb) into _provenance
    from clinical_core.note_provenance_refs provenance where provenance.note_id=_note.id;
  return jsonb_build_object('note',jsonb_build_object('note_id',_note.id,'encounter_id',_note.encounter_id,
    'patient_id',_note.patient_record_id,'note_type',_note.note_type,'status',_note.status,
    'current_version',_note.current_version,'author_user_id',_note.author_person_id,
    'status_reason',_note.status_reason,'created_at',_note.created_at,'updated_at',_note.updated_at),
    'content',coalesce(_version.content,'{}'::jsonb),'content_version',coalesce(_version.version,0),
    'last_saved_at',_version.created_at,'signature',_signature,'addenda',_addenda,'provenance',_provenance);
end $$;

create or replace function clinical_core.get_desktop_patient_timeline(_patient_id uuid,_limit integer default 200)
returns table(event_at timestamptz,event_type text,title text,ref_type text,ref_id uuid,detail jsonb)
language plpgsql stable security definer set search_path='' as $$
declare _patient clinical_core.patient_records%rowtype;
begin
  select * into _patient from clinical_core.patient_records where id=_patient_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='patient_not_found'; end if;
  perform clinical_private.require_clinical_patient(_patient.organization_id,_patient.id);
  if _limit<1 or _limit>500 then raise exception using errcode='22023',message='limit_invalid'; end if;
  return query select event.event_at,event.event_type,event.title,event.ref_type,event.ref_id,event.detail from (
    select encounter.started_at event_at,'encounter.started'::text event_type,
      'Encounter started ('||encounter.visit_type||')' title,'encounter'::text ref_type,encounter.id ref_id,
      jsonb_build_object('status',encounter.status) detail from clinical_core.encounters encounter
      where encounter.patient_record_id=_patient_id and encounter.started_at is not null and encounter.deleted_at is null
    union all select encounter.ended_at,'encounter.completed','Encounter completed','encounter',encounter.id,
      jsonb_build_object('visit_type',encounter.visit_type) from clinical_core.encounters encounter
      where encounter.patient_record_id=_patient_id and encounter.status='completed' and encounter.ended_at is not null
    union all select note.created_at,'note.draft_created','Draft note created ('||note.note_type||')',
      'clinical_note',note.id,jsonb_build_object('status',note.status) from clinical_core.clinical_notes note
      where note.patient_record_id=_patient_id and note.deleted_at is null
    union all select signature.signed_at,'note.signed','Note signed','clinical_note',signature.note_id,
      jsonb_build_object('version',signature.note_version) from clinical_core.note_signatures signature
      join clinical_core.clinical_notes note on note.id=signature.note_id
      where note.patient_record_id=_patient_id and note.deleted_at is null
    union all select addendum.created_at,'note.addendum','Addendum added','clinical_note',addendum.note_id,
      jsonb_build_object('referenced_version',addendum.referenced_version) from clinical_core.note_addenda addendum
      join clinical_core.clinical_notes note on note.id=addendum.note_id
      where note.patient_record_id=_patient_id and note.deleted_at is null
    union all select appointment.starts_at,'appointment',appointment.appointment_type,'appointment',appointment.id,
      jsonb_build_object('status',appointment.status) from clinical_core.appointments appointment
      where appointment.patient_record_id=_patient_id and appointment.deleted_at is null
  ) event order by event.event_at desc,event.ref_id limit _limit;
end $$;

revoke all on function clinical_private.forbid_note_versions_after_signing(),
  clinical_private.forbid_provenance_after_signing(),
  clinical_private.require_clinical_patient(uuid,uuid) from public;
grant execute on function clinical_private.forbid_note_versions_after_signing(),
  clinical_private.forbid_provenance_after_signing(),
  clinical_private.require_clinical_patient(uuid,uuid) to clinical_core_api;
revoke all on function clinical_core.start_encounter(uuid,uuid,text,uuid),
  clinical_core.set_encounter_status(uuid,text,text),
  clinical_core.save_note_draft(uuid,uuid,text,jsonb,integer,uuid,text,jsonb),
  clinical_core.mark_note_ready(uuid),clinical_core.sign_note(uuid,integer),
  clinical_core.add_note_addendum(uuid,text,text),clinical_core.mark_note_error(uuid,text),
  clinical_core.get_desktop_encounter(uuid),clinical_core.list_desktop_patient_encounters(uuid,integer),
  clinical_core.get_desktop_note(uuid),clinical_core.get_desktop_patient_timeline(uuid,integer) from public;
grant execute on function clinical_core.start_encounter(uuid,uuid,text,uuid),
  clinical_core.set_encounter_status(uuid,text,text),
  clinical_core.save_note_draft(uuid,uuid,text,jsonb,integer,uuid,text,jsonb),
  clinical_core.mark_note_ready(uuid),clinical_core.sign_note(uuid,integer),
  clinical_core.add_note_addendum(uuid,text,text),clinical_core.mark_note_error(uuid,text),
  clinical_core.get_desktop_encounter(uuid),clinical_core.list_desktop_patient_encounters(uuid,integer),
  clinical_core.get_desktop_note(uuid),clinical_core.get_desktop_patient_timeline(uuid,integer) to clinical_core_api;
