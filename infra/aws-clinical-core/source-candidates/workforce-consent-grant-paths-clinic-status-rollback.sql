-- Rollback of the UNREGISTERED, BLOCKED workforce-consent-grant-paths-clinic-status.sql. Applied nowhere.
-- Restores set_sync_consent_scope and grant_encounter_recording_consent exactly as the production artifact defines them
-- (prosrc ebbd09fd... and e28248a0...). Every consent and recording-consent row stays as recorded. It refuses unless both
-- functions are exactly the successor's.

begin;

do $guard$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_core.set_sync_consent_scope(uuid,text,boolean,text,text,text,text,text)'))
      is distinct from '6dc59bb3337cd6135a901444b14fddf701adb5b33513c332b87bf3d62270f723'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.grant_encounter_recording_consent(uuid,uuid,uuid,text,text,uuid)'))
      is distinct from 'a7df57f5e4e8e7f29839d47ef1202460dedd0a8d8b92a9644cf6dabcc3ff860f' then
    raise exception using errcode = '55000', message = 'consent_grant_paths_rollback_refused';
  end if;
end
$guard$;

create or replace function clinical_core.set_sync_consent_scope(
  _connection_id uuid, _scope text, _grant boolean, _artifact_title text,
  _artifact_version text, _jurisdiction text, _method text, _authority text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _artifact clinical_core.consent_artifacts%rowtype;
  _latest clinical_core.consent_grants%rowtype;
  _actor uuid := clinical_private.actor_person_id();
  _next_version integer;
  _consent_id uuid;
  _at timestamptz := clock_timestamp();
begin
  if _scope not in ('programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','lab_summaries','lab_results_import',
    'billing_links','research_n_of_1') then
    raise exception using errcode='22023',message='consent_scope_invalid'; end if;
  if _method not in ('patient_app','portal','in_person','written')
    or _authority not in ('self','guardian','healthcare_proxy','legal_representative') then
    raise exception using errcode='22023',message='consent_method_or_authority_invalid'; end if;
  select * into _connection from clinical_core.patient_connections connection
    where connection.id=_connection_id and connection.state in ('verified','paused') for update;
  if not found then raise exception using errcode='P0002',message='connection_not_found'; end if;
  perform clinical_private.assert_production_context(_connection.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_connection.organization_id) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  select * into _latest from clinical_core.consent_grants grant_row
    where grant_row.connection_id=_connection.id and grant_row.scope=_scope
    order by grant_row.version desc limit 1;

  if _grant then
    if char_length(btrim(coalesce(_artifact_title,''))) not between 1 and 200
      or char_length(btrim(coalesce(_artifact_version,''))) not between 1 and 64
      or char_length(btrim(coalesce(_jurisdiction,''))) not between 2 and 64 then
      raise exception using errcode='22023',message='governed_consent_artifact_required'; end if;
    select * into _artifact from clinical_core.consent_artifacts artifact
      where artifact.organization_id=_connection.organization_id and artifact.scope=_scope
        and artifact.artifact_title=btrim(_artifact_title)
        and artifact.artifact_version=btrim(_artifact_version)
        and artifact.jurisdiction=btrim(_jurisdiction) and artifact.status='approved';
    if not found then
      raise exception using errcode='55000',message='approved_consent_artifact_required'; end if;
    if _latest.status = 'granted' then
      if _latest.artifact_id=_artifact.id and _latest.method=_method
        and _latest.representative_authority=_authority then
        return jsonb_build_object('ok',true,'message','Consent already granted','connectionId',_connection.id,
          'scope',_scope,'status','granted','version',_latest.version,'alreadyApplied',true); end if;
      raise exception using errcode='55000',message='active_consent_must_be_revoked_first';
    end if;
    _next_version := coalesce(_latest.version,0)+1;
    insert into clinical_core.consent_grants(
      organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,
      representative_authority,version,recorded_at,recorded_by_person_id
    ) values(
      _connection.organization_id,_connection.patient_record_id,_connection.id,_artifact.id,_scope,
      'granted',_method,_authority,_next_version,_at,_actor
    ) returning id into _consent_id;
    insert into clinical_audit.events(
      organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata
    ) values(
      _connection.organization_id,_actor,'consent.granted','consent',_consent_id,'consent_management',
      jsonb_build_object('scope',_scope,'version',_next_version,'artifact_id',_artifact.id)
    );
    return jsonb_build_object('ok',true,'message','Consent granted','connectionId',_connection.id,
      'scope',_scope,'status','granted','version',_next_version);
  end if;

  if _latest.id is null or _latest.status <> 'granted' then
    return jsonb_build_object('ok',true,'message','Consent already revoked','connectionId',_connection.id,
      'scope',_scope,'status','revoked','version',coalesce(_latest.version,0),'alreadyApplied',true);
  end if;
  _next_version := _latest.version+1;
  insert into clinical_core.consent_grants(
    organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,
    representative_authority,reason_code,version,recorded_at,recorded_by_person_id
  ) values(
    _connection.organization_id,_connection.patient_record_id,_connection.id,null,_scope,'revoked',
    _latest.method,_latest.representative_authority,'scope_changed',_next_version,_at,_actor
  ) returning id into _consent_id;
  insert into clinical_audit.events(
    organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata
  ) values(
    _connection.organization_id,_actor,'consent.revoked','consent',_consent_id,'consent_management',
    jsonb_build_object('scope',_scope,'version',_next_version,'reason_code','scope_changed')
  );
  return jsonb_build_object('ok',true,'message','Consent revoked','connectionId',_connection.id,
    'scope',_scope,'status','revoked','version',_next_version);
end $$;

create or replace function clinical_private.grant_encounter_recording_consent(_participant uuid,_release uuid,_command uuid,
  _method text,_ack text,_authority uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare _p clinical_private.recording_participants; _e clinical_core.encounters;
  _d clinical_private.recording_consent_releases; _g clinical_private.recording_consent_grants; _id uuid;
begin
  select * into _p from clinical_private.recording_participants where id=_participant;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  _e:=clinical_private.lock_recording_encounter(_p.encounter_id);
  if _command is null or _method is null or _method not in ('verbal_attested','written','electronic_signature')
    or length(btrim(coalesce(_ack,''))) not between 1 and 2000 then
    raise exception using errcode='22023',message='recording_consent_invalid'; end if;
  select * into _g from clinical_private.recording_consent_grants where participant_id=_participant and command_id=_command;
  if found then
    if _g.release_id is distinct from _release or _g.method<>_method or _g.acknowledgment<>btrim(_ack)
      or _g.representative_authority_id is distinct from _authority or _g.granted_by<>clinical_private.actor_person_id() then
      raise exception using errcode='40001',message='recording_consent_conflict'; end if;
    return _g.id; -- receipt only; never re-grants a withdrawn consent
  end if;
  if _e.status<>'in_progress' then raise exception using errcode='55000',message='recording_encounter_closed'; end if;
  select * into _d from clinical_private.recording_consent_releases where id=_release and organization_id=_e.organization_id
    and retired_at is null and approved_at<=clock_timestamp()
    and content_sha256=encode(public.digest(content,'sha256'),'hex') for share;
  if not found then raise exception using errcode='55000',message='recording_consent_release_required'; end if;
  if (not _p.can_self_consent or _authority is not null) and not exists(
    select 1 from clinical_private.recording_representative_authorities where id=_authority and participant_id=_participant
      and reviewed_at<=clock_timestamp() and expires_at>clock_timestamp() and revoked_at is null) then
    raise exception using errcode='42501',message='recording_representative_authority_required'; end if;
  if exists(select 1 from clinical_private.recording_consent_grants g
    join clinical_private.recording_consent_releases d on d.id=g.release_id
    where g.participant_id=_participant and d.scope=_d.scope
      and not exists(select 1 from clinical_private.recording_consent_withdrawals w where w.grant_id=g.id)) then
    raise exception using errcode='40001',message='recording_consent_already_granted'; end if;
  insert into clinical_private.recording_consent_grants(command_id,participant_id,release_id,method,acknowledgment,representative_authority_id,granted_by)
    values(_command,_participant,_release,_method,btrim(_ack),_authority,clinical_private.actor_person_id()) returning id into _id;
  insert into clinical_private.recording_authority_events(encounter_id,actor_id,action,resource_id,authority_epoch)
    select _e.id,clinical_private.actor_person_id(),'consent.granted',_id,authority_epoch
      from clinical_private.recording_controls where encounter_id=_e.id;
  return _id;
end $$;

do $check$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_core.set_sync_consent_scope(uuid,text,boolean,text,text,text,text,text)'))
      <> 'ebbd09fd16dcf44d8b8c7aac7a3ee0a75fa4a1a3f75011e82006e1da53d202ad'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.grant_encounter_recording_consent(uuid,uuid,uuid,text,text,uuid)'))
      <> 'e28248a0ad68b7e3412aaf04cdd9e94fd7f64ee878fa6afc7e32962e4c754625' then
    raise exception using errcode = '55000', message = 'consent_grant_paths_rollback_refused';
  end if;
end
$check$;

commit;
