-- Blocked 118 source candidate; exact 117 parent only. No seeded identities,
-- release rows, consents, provider authority, runtime admission or PHI approval.
do $parent$
declare _n integer; _ledger text; _assembly text;
begin
  select count(*)::integer,
    encode(sha256(convert_to(string_agg(version||':'||sha256,E'\n' order by version collate "C"),'UTF8')),'hex'),
    encode(sha256(convert_to(string_agg(version||':'||version||'_'||name||'.sql:'||sha256,E'\n' order by version collate "C"),'UTF8')),'hex')
    into _n,_ledger,_assembly from clinical_core.schema_migrations;
  if _n<>117 or _ledger is distinct from '34037e1ff05d583868c9a3796f673937777f88bcf4cebc2d589c6604626e9364'
    or _assembly is distinct from 'd73f67f2197886cf24360f773018a72c92d666789891e679e151ae2c65bd796a' then
    raise exception using errcode='55000',message='telehealth_request_parent_refused';
  end if;
end $parent$;

-- Observation of NEW appointment sharing only. Not a booking/write admission,
-- not telehealth-recording consent, not authority for a retained visit record,
-- and not a gate on cancellation following consent withdrawal. No provider
-- request may run while this transaction is open. A subsequent write needs
-- its own current-authority revalidation and durable settlement protocol.
create function clinical_core.production_telehealth_request_authority(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _action text; _actor uuid; _org uuid:=clinical_private.organization_id();
  _patient uuid; _c clinical_core.patient_connections; _g clinical_core.consent_grants;
  _a clinical_core.consent_artifacts; _n integer; _ledger text; _assembly text; _rows jsonb;
begin
  if _request is null or jsonb_typeof(_request)<>'object' or jsonb_typeof(_request->'action') is distinct from 'string'
    or octet_length(_request::text)>1024 then
    raise exception using errcode='22023',message='telehealth_request_invalid';
  end if;
  _action:=_request->>'action';
  if _action='consumer_appointments' then
    if exists(select 1 from jsonb_object_keys(_request) k where k<>'action') then
      raise exception using errcode='22023',message='telehealth_request_invalid';
    end if;
    _actor:=clinical_private.care_connection_actor('consumer','clinical_data');
  elsif _action='workforce_appointments' then
    if exists(select 1 from jsonb_object_keys(_request) k where k not in ('action','patientRecordId'))
      or (_request ? 'patientRecordId' and (jsonb_typeof(_request->'patientRecordId') is distinct from 'string'
        or (_request->>'patientRecordId') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')) then
      raise exception using errcode='22023',message='telehealth_request_invalid';
    end if;
    _actor:=clinical_private.care_connection_actor('workforce','clinical_data');
    _patient:=(_request->>'patientRecordId')::uuid;
  else
    raise exception using errcode='22023',message='telehealth_request_invalid';
  end if;

  -- No raw ledger/table grant to the API role. The consumer/workforce check
  -- precedes this observation. The compiled port additionally checks EVERY
  -- ordered receipt including this extension's pinned SHA and live body/ACLs.
  select count(*)::integer,jsonb_agg(jsonb_build_object('version',version,'name',name,'sha256',sha256) order by version collate "C")
    into _n,_rows from clinical_core.schema_migrations;
  select encode(sha256(convert_to(string_agg(version||':'||sha256,E'\n' order by version collate "C"),'UTF8')),'hex'),
    encode(sha256(convert_to(string_agg(version||':'||version||'_'||name||'.sql:'||sha256,E'\n' order by version collate "C"),'UTF8')),'hex')
    into _ledger,_assembly from clinical_core.schema_migrations where version<'20261011180000';
  if _n<>118 or _ledger is distinct from '34037e1ff05d583868c9a3796f673937777f88bcf4cebc2d589c6604626e9364'
    or _assembly is distinct from 'd73f67f2197886cf24360f773018a72c92d666789891e679e151ae2c65bd796a'
    or not exists(select 1 from clinical_core.schema_migrations where version='20261011180000'
      and name='production_telehealth_request_authority') then
    raise exception using errcode='55000',message='telehealth_request_release_refused';
  end if;

  if _action='consumer_appointments' then
    select count(*)::integer into _n from clinical_core.patient_connections c
      join clinical_core.patient_records p on p.id=c.patient_record_id and p.organization_id=c.organization_id
      where c.organization_id=_org and c.consumer_person_id=_actor and c.state='verified'
        and p.status='active' and p.deleted_at is null;
    if _n<>1 then raise exception using errcode='42501',message='telehealth_request_identity_refused'; end if;
    select c.* into _c from clinical_core.patient_connections c
      join clinical_core.patient_records p on p.id=c.patient_record_id and p.organization_id=c.organization_id
      where c.organization_id=_org and c.consumer_person_id=_actor and c.state='verified'
        and p.status='active' and p.deleted_at is null;
    _patient:=_c.patient_record_id;
    _a:=clinical_private.care_connection_artifact('appointments');
    select * into _g from clinical_core.consent_grants
      where connection_id=_c.id and organization_id=_org and patient_record_id=_patient and scope='appointments'
      order by version desc limit 1;
    if _g.id is null or _g.status<>'granted' or _g.artifact_id is distinct from _a.id
      or _g.recorded_by_person_id<>_actor or _g.method<>'patient_app' or _g.representative_authority<>'self' then
      raise exception using errcode='42501',message='telehealth_request_consent_required';
    end if;
  elsif _patient is not null and not exists(select 1 from clinical_core.patient_records
    where id=_patient and organization_id=_org and status='active' and deleted_at is null) then
    raise exception using errcode='42501',message='telehealth_request_identity_refused';
  end if;

  return jsonb_build_object('contract','telehealth-request-authority-observation/1',
    'observedAt',clock_timestamp(),'databaseName',current_database(),'action',_action,
    'actorPersonId',_actor,'organizationId',_org,'identityPool',clinical_private.claim('identity_pool'),
    'identitySubject',clinical_private.claim('identity_subject'),'patientRecordId',_patient,
    'connectionId',_c.id,'appointmentsConsent',case when _g.id is not null then jsonb_build_object(
      'artifactId',_a.id,'artifactVersion',_a.artifact_version,'contentSha256',_a.content_sha256,
      'grantId',_g.id,'version',_g.version) else null end,'migrationLedger',_rows);
end $$;
revoke all on function clinical_core.production_telehealth_request_authority(jsonb) from public,clinical_core_api;
grant execute on function clinical_core.production_telehealth_request_authority(jsonb) to clinical_core_api;
