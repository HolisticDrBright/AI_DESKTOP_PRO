-- Production-only patient directory and practitioner lab-review contracts.
-- This schema can hold PHI, but deployment and request routing remain blocked
-- until the separately governed PHI activation gate is approved.

alter table clinical_core.patient_records
  add column mrn text,
  add column first_name text not null,
  add column last_name text not null,
  add column date_of_birth date,
  add column sex text not null default 'unknown',
  add column email text,
  add column phone text,
  add column source text not null default 'manual',
  add column created_by_person_id uuid references clinical_core.persons(id),
  add column updated_by_person_id uuid references clinical_core.persons(id),
  add column updated_at timestamptz not null default clock_timestamp(),
  add column deleted_at timestamptz,
  add constraint patient_records_first_name_check
    check (char_length(btrim(first_name)) between 1 and 100),
  add constraint patient_records_last_name_check
    check (char_length(btrim(last_name)) between 1 and 100),
  add constraint patient_records_mrn_check
    check (mrn is null or char_length(mrn) between 1 and 64),
  add constraint patient_records_dob_check
    check (date_of_birth is null or date_of_birth >= date '1900-01-01'),
  add constraint patient_records_sex_check
    check (sex in ('male','female','other','unknown')),
  add constraint patient_records_email_check
    check (email is null or (char_length(email) between 3 and 320 and email = lower(email))),
  add constraint patient_records_phone_check
    check (phone is null or char_length(phone) between 1 and 40),
  add constraint patient_records_source_check
    check (source in ('manual','governed_import'));

create unique index patient_records_live_mrn_uniq
  on clinical_core.patient_records(organization_id, mrn)
  where mrn is not null and deleted_at is null;
create index patient_records_directory_idx
  on clinical_core.patient_records(organization_id, last_name, first_name, id)
  where deleted_at is null;

alter table clinical_core.lab_observations
  drop constraint lab_observations_review_status_check;
alter table clinical_core.lab_observations
  add constraint lab_observations_review_status_check
    check (review_status in ('unreviewed','accepted','flagged','rejected'));

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed',
  'consent.granted','consent.revoked','lab_import.received',
  'lab_import.duplicate','lab_import.accepted','lab_import.rejected',
  'clinical_record.received','clinical_record.duplicate','privacy_request.submitted',
  'patient.created','lab_observation.reviewed'));
alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check
  check (resource_type in (
    'connection','consent','lab_import','clinical_record','privacy_request',
    'patient_profile','lab_observation'));

create or replace function clinical_core.create_patient_profile(
  _organization_id uuid,
  _first_name text,
  _last_name text,
  _date_of_birth date default null,
  _sex text default 'unknown',
  _mrn text default null,
  _email text default null,
  _phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _actor uuid := clinical_private.actor_person_id();
  _patient clinical_core.patient_records%rowtype;
  _first text := btrim(coalesce(_first_name, ''));
  _last text := btrim(coalesce(_last_name, ''));
  _normalized_sex text := lower(btrim(coalesce(_sex, 'unknown')));
  _normalized_mrn text := nullif(btrim(_mrn), '');
  _normalized_email text := nullif(lower(btrim(_email)), '');
  _normalized_phone text := nullif(btrim(_phone), '');
begin
  perform clinical_private.assert_production_context(_organization_id, 'clinical_data', 'workforce');
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  if _first = '' or char_length(_first) > 100
    or _last = '' or char_length(_last) > 100 then
    raise exception using errcode = '22023', message = 'patient_name_invalid';
  end if;
  if _normalized_sex not in ('male','female','other','unknown') then
    raise exception using errcode = '22023', message = 'recorded_sex_invalid';
  end if;
  if _date_of_birth is not null
    and (_date_of_birth < date '1900-01-01' or _date_of_birth > current_date) then
    raise exception using errcode = '22023', message = 'date_of_birth_invalid';
  end if;
  if char_length(coalesce(_normalized_mrn, '')) > 64
    or char_length(coalesce(_normalized_email, '')) > 320
    or char_length(coalesce(_normalized_phone, '')) > 40 then
    raise exception using errcode = '22023', message = 'patient_field_too_long';
  end if;
  if _normalized_email is not null
    and (_normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception using errcode = '22023', message = 'patient_email_invalid';
  end if;

  insert into clinical_core.patient_records(
    organization_id, patient_key, data_classification, contains_phi, status,
    mrn, first_name, last_name, date_of_birth, sex, email, phone, source,
    created_by_person_id, updated_by_person_id
  ) values (
    _organization_id, 'patient_' || replace(gen_random_uuid()::text, '-', ''),
    'clinical_phi', true, 'active', _normalized_mrn, _first, _last,
    _date_of_birth, _normalized_sex, _normalized_email, _normalized_phone,
    'manual', _actor, _actor
  ) returning * into _patient;

  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id,
    purpose, safe_metadata
  ) values (
    _organization_id, _actor, 'patient.created', 'patient_profile', _patient.id,
    'clinical_data', jsonb_build_object('source', 'manual')
  );

  return jsonb_build_object(
    'id', _patient.id,
    'organization_id', _patient.organization_id,
    'mrn', _patient.mrn,
    'first_name', _patient.first_name,
    'last_name', _patient.last_name,
    'date_of_birth', _patient.date_of_birth,
    'sex', _patient.sex,
    'status', _patient.status
  );
end
$$;

create or replace function clinical_core.review_biomarker(
  _observation_id uuid,
  _decision text,
  _note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _actor uuid := clinical_private.actor_person_id();
  _observation clinical_core.lab_observations%rowtype;
  _normalized_decision text := lower(btrim(coalesce(_decision, '')));
  _previous_status text;
  _reviewed_at timestamptz;
  _reviewed_by uuid;
  _audit_id uuid;
begin
  if _normalized_decision not in ('accepted','flagged','rejected') then
    raise exception using errcode = '22023', message = 'review_decision_invalid';
  end if;
  if char_length(coalesce(_note, '')) > 500 then
    raise exception using errcode = '22023', message = 'review_note_too_long';
  end if;

  select * into _observation
  from clinical_core.lab_observations o
  where o.id = _observation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'lab_observation_not_found';
  end if;

  perform clinical_private.assert_production_context(
    _observation.organization_id, 'clinical_data', 'workforce');
  if not clinical_private.has_clinical_role(_observation.organization_id) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  _previous_status := _observation.review_status;

  if _previous_status = _normalized_decision then
    return jsonb_build_object(
      'id', _observation.id,
      'review_status', _previous_status,
      'reviewed_by', _observation.reviewed_by_person_id,
      'reviewed_at', _observation.reviewed_at,
      'previous_status', _previous_status,
      'already_set', true,
      'audit_event_id', null
    );
  end if;

  update clinical_core.lab_observations o
  set review_status = _normalized_decision,
      reviewed_at = clock_timestamp(),
      reviewed_by_person_id = _actor
  where o.id = _observation.id
  returning o.reviewed_at, o.reviewed_by_person_id into _reviewed_at, _reviewed_by;

  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id,
    purpose, safe_metadata
  ) values (
    _observation.organization_id, _actor, 'lab_observation.reviewed',
    'lab_observation', _observation.id, 'clinical_data',
    jsonb_build_object(
      'decision', _normalized_decision,
      'previous_status', _previous_status,
      'note_present', coalesce(char_length(btrim(_note)), 0) > 0
    )
  ) returning id into _audit_id;

  return jsonb_build_object(
    'id', _observation.id,
    'review_status', _normalized_decision,
    'reviewed_by', _reviewed_by,
    'reviewed_at', _reviewed_at,
    'previous_status', _previous_status,
    'already_set', false,
    'audit_event_id', _audit_id
  );
end
$$;

grant execute on function clinical_core.create_patient_profile(
  uuid,text,text,date,text,text,text,text) to clinical_core_api;
grant execute on function clinical_core.review_biomarker(uuid,text,text)
  to clinical_core_api;

revoke all on all tables in schema clinical_core from public;
revoke all on all functions in schema clinical_core from public;
