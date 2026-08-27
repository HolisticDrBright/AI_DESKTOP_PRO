-- Production patient-application connection controls. The deployment remains
-- PHI-disabled; these contracts are migration candidates only until activation.

alter table clinical_core.patient_connections
  add column external_system text not null default 'alp',
  add column contract_version text not null default 'patient-sync/1',
  add column paused_at timestamptz,
  add column revoke_reason_safe text,
  add column version integer not null default 1,
  add constraint patient_connections_external_system_check check (external_system = 'alp'),
  add constraint patient_connections_contract_version_check check (contract_version = 'patient-sync/1'),
  add constraint patient_connections_version_check check (version > 0),
  add constraint patient_connections_pause_time_check
    check ((state = 'paused' and paused_at is not null) or (state <> 'paused' and paused_at is null)),
  add constraint patient_connections_revoke_time_check
    check ((state = 'revoked' and revoked_at is not null) or state <> 'revoked'),
  add constraint patient_connections_revoke_reason_check
    check (revoke_reason_safe is null or char_length(revoke_reason_safe) between 1 and 500);

alter table clinical_core.consent_artifacts
  add column artifact_title text not null default 'Governed consent artifact',
  add constraint consent_artifacts_title_check
    check (char_length(btrim(artifact_title)) between 1 and 200);

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed','connection.paused',
  'connection.resumed','connection.revoked','consent.granted','consent.revoked',
  'lab_import.received','lab_import.duplicate','lab_import.accepted','lab_import.rejected',
  'clinical_record.received','clinical_record.duplicate','privacy_request.submitted','patient.created',
  'lab_observation.reviewed','marker.view','document.viewed','document.exported','report.exported',
  'audit.exported','membership.role_changed','membership.suspended','review_task.created',
  'review_task.resolved','appointment.booked','appointment.rescheduled','appointment.status_changed',
  'appointment.corrected','encounter.started','encounter.completed','encounter.cancelled',
  'encounter.entered_in_error','note.draft_created','note.draft_saved','note.ready_for_review',
  'note.signed','note.addendum_created','note.entered_in_error'));

create or replace function clinical_core.create_sync_invitation(
  _organization_id uuid, _patient_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  _actor uuid := clinical_private.actor_person_id();
  _connection clinical_core.patient_connections%rowtype;
  _invitation_id uuid;
  _token text;
  _token_hash text;
  _expires_at timestamptz := clock_timestamp() + interval '24 hours';
begin
  perform clinical_private.require_clinical_patient(_organization_id,_patient_id);
  select * into _connection from clinical_core.patient_connections connection
    where connection.organization_id=_organization_id
      and connection.patient_record_id=_patient_id and connection.state <> 'revoked'
    for update;
  if found and _connection.state <> 'invitation_pending' then
    raise exception using errcode='55000',message='connection_not_invitable';
  end if;
  if not found then
    insert into clinical_core.patient_connections(organization_id,patient_record_id)
      values(_organization_id,_patient_id) returning * into _connection;
  end if;

  update clinical_core.connection_invitations invitation set status='superseded'
    where invitation.connection_id=_connection.id and invitation.status='pending';
  _token := upper(substr(translate(rtrim(encode(gen_random_bytes(8),'base64'),'='),'+/','-_'),1,10));
  _token_hash := encode(digest(_token,'sha256'),'hex');
  insert into clinical_core.connection_invitations(
    organization_id,patient_record_id,connection_id,token_hash,idempotency_key,
    expires_at,created_by_person_id
  ) values(
    _organization_id,_patient_id,_connection.id,_token_hash,
    'desktop:' || replace(gen_random_uuid()::text,'-',''),_expires_at,_actor
  ) returning id into _invitation_id;
  insert into clinical_audit.events(
    organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata
  ) values(
    _organization_id,_actor,'connection.invitation_issued','connection',_connection.id,
    'identity_link',jsonb_build_object('invitation_id',_invitation_id,'expires_at',_expires_at)
  );
  return jsonb_build_object(
    'ok',true,'message','Invitation created','connectionId',_connection.id,
    'invitationId',_invitation_id,'token',_token,'expiresAt',_expires_at,
    'state','invitation_pending','version',_connection.version
  );
end $$;

create or replace function clinical_core.pause_sync_connection(
  _connection_id uuid, _expected_version integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _connection clinical_core.patient_connections%rowtype; _actor uuid := clinical_private.actor_person_id();
begin
  select * into _connection from clinical_core.patient_connections connection
    where connection.id=_connection_id for update;
  if not found then raise exception using errcode='P0002',message='connection_not_found'; end if;
  perform clinical_private.assert_production_context(_connection.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_connection.organization_id) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _connection.version <> _expected_version then
    raise exception using errcode='40001',message='connection_version_conflict'; end if;
  if _connection.state = 'paused' then
    return jsonb_build_object('ok',true,'message','Connection already paused','connectionId',_connection.id,
      'state',_connection.state,'version',_connection.version,'alreadyApplied',true); end if;
  if _connection.state <> 'verified' then
    raise exception using errcode='55000',message='verified_connection_required'; end if;
  update clinical_core.patient_connections connection
    set state='paused',paused_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
    where connection.id=_connection.id returning * into _connection;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose)
    values(_connection.organization_id,_actor,'connection.paused','connection',_connection.id,'clinical_data');
  return jsonb_build_object('ok',true,'message','Connection paused','connectionId',_connection.id,
    'state',_connection.state,'version',_connection.version);
end $$;

create or replace function clinical_core.resume_sync_connection(
  _connection_id uuid, _expected_version integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _connection clinical_core.patient_connections%rowtype; _actor uuid := clinical_private.actor_person_id();
begin
  select * into _connection from clinical_core.patient_connections connection
    where connection.id=_connection_id for update;
  if not found then raise exception using errcode='P0002',message='connection_not_found'; end if;
  perform clinical_private.assert_production_context(_connection.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_connection.organization_id) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _connection.version <> _expected_version then
    raise exception using errcode='40001',message='connection_version_conflict'; end if;
  if _connection.state = 'verified' then
    return jsonb_build_object('ok',true,'message','Connection already active','connectionId',_connection.id,
      'state',_connection.state,'version',_connection.version,'alreadyApplied',true); end if;
  if _connection.state <> 'paused' then
    raise exception using errcode='55000',message='paused_connection_required'; end if;
  update clinical_core.patient_connections connection
    set state='verified',paused_at=null,updated_at=clock_timestamp(),version=version+1
    where connection.id=_connection.id returning * into _connection;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose)
    values(_connection.organization_id,_actor,'connection.resumed','connection',_connection.id,'clinical_data');
  return jsonb_build_object('ok',true,'message','Connection resumed','connectionId',_connection.id,
    'state',_connection.state,'version',_connection.version);
end $$;

create or replace function clinical_core.revoke_sync_connection(
  _connection_id uuid, _expected_version integer, _reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _actor uuid := clinical_private.actor_person_id();
  _consent clinical_core.current_consent%rowtype;
  _next_version integer;
  _consent_id uuid;
begin
  select * into _connection from clinical_core.patient_connections connection
    where connection.id=_connection_id for update;
  if not found then raise exception using errcode='P0002',message='connection_not_found'; end if;
  perform clinical_private.assert_production_context(_connection.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_connection.organization_id) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _connection.version <> _expected_version then
    raise exception using errcode='40001',message='connection_version_conflict'; end if;
  if char_length(btrim(coalesce(_reason,''))) not between 1 and 500 then
    raise exception using errcode='22023',message='revoke_reason_required'; end if;
  if _connection.state = 'revoked' then
    return jsonb_build_object('ok',true,'message','Connection already revoked','connectionId',_connection.id,
      'state',_connection.state,'version',_connection.version,'alreadyApplied',true); end if;

  update clinical_core.patient_connections connection set state='revoked',paused_at=null,
    revoked_at=clock_timestamp(),revoke_reason_safe=btrim(_reason),updated_at=clock_timestamp(),version=version+1
    where connection.id=_connection.id returning * into _connection;
  update clinical_core.connection_invitations invitation set status='revoked'
    where invitation.connection_id=_connection.id and invitation.status='pending';

  for _consent in select * from clinical_core.current_consent current_scope
    where current_scope.connection_id=_connection.id and current_scope.status='granted'
  loop
    _next_version := _consent.version + 1;
    insert into clinical_core.consent_grants(
      organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,
      representative_authority,reason_code,version,recorded_by_person_id
    ) values(
      _connection.organization_id,_connection.patient_record_id,_connection.id,null,_consent.scope,'revoked',
      _consent.method,_consent.representative_authority,'connection_revoked',_next_version,_actor
    ) returning id into _consent_id;
    insert into clinical_audit.events(
      organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata
    ) values(
      _connection.organization_id,_actor,'consent.revoked','consent',_consent_id,'consent_management',
      jsonb_build_object('scope',_consent.scope,'version',_next_version,'reason_code','connection_revoked')
    );
  end loop;
  insert into clinical_audit.events(
    organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata
  ) values(
    _connection.organization_id,_actor,'connection.revoked','connection',_connection.id,'clinical_data',
    jsonb_build_object('reason_present',true)
  );
  return jsonb_build_object('ok',true,'message','Connection revoked','connectionId',_connection.id,
    'state',_connection.state,'version',_connection.version);
end $$;

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

create or replace function clinical_core.get_patient_sync_overview(
  _patient_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  _organization_id uuid := clinical_private.organization_id();
  _connection clinical_core.patient_connections%rowtype;
  _provider_configured boolean;
  _invitation jsonb;
  _scopes jsonb;
  _history jsonb;
begin
  perform clinical_private.require_clinical_patient(_organization_id,_patient_id);
  select * into _connection from clinical_core.patient_connections connection
    where connection.organization_id=_organization_id and connection.patient_record_id=_patient_id
    order by (connection.state <> 'revoked') desc,connection.created_at desc limit 1;
  select exists(select 1 from clinical_core.sync_providers provider
    where provider.organization_id=_organization_id and provider.stable_id='alp_patient_sync'
      and provider.state='active') into _provider_configured;
  if _connection.id is null then
    return jsonb_build_object(
      'providerConfigured',_provider_configured,'connection',null,'invitation',null,'scopes','[]'::jsonb,
      'counts',jsonb_build_object('pendingOutbound',0,'failedOutbound',0,'deadLetter',0,
        'inboundPendingReview',0,'openConflicts',0),
      'lastSuccessfulSyncAt',null,'resources','[]'::jsonb,'outbound','[]'::jsonb,
      'inbound','[]'::jsonb,'conflicts','[]'::jsonb,'history','[]'::jsonb,
      'generatedAt',clock_timestamp());
  end if;
  select jsonb_build_object(
    'id',invitation.id,'expiresAt',invitation.expires_at,'createdAt',invitation.created_at,
    'usedAt',invitation.used_at,'expired',invitation.expires_at <= clock_timestamp()
  ) into _invitation from clinical_core.connection_invitations invitation
    where invitation.connection_id=_connection.id
    order by invitation.created_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',scope_row.id,'scope',scope_row.scope,'status',scope_row.status,
    'artifactTitle',artifact.artifact_title,'artifactVersion',artifact.artifact_version,
    'jurisdiction',artifact.jurisdiction,'method',scope_row.method,
    'authority',scope_row.representative_authority,
    'grantedAt',grant_row.recorded_at,
    'revokedAt',case when scope_row.status='revoked' then scope_row.recorded_at else null end,
    'revokeSource',case when scope_row.status='revoked' then 'practitioner' else null end
  ) order by scope_row.scope),'[]'::jsonb) into _scopes
  from clinical_core.current_consent scope_row
  left join lateral (
    select prior.artifact_id,prior.recorded_at from clinical_core.consent_grants prior
      where prior.connection_id=scope_row.connection_id and prior.scope=scope_row.scope
        and prior.status='granted' order by prior.version desc limit 1
  ) grant_row on true
  left join clinical_core.consent_artifacts artifact on artifact.id=grant_row.artifact_id
  where scope_row.connection_id=_connection.id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind',event.action,'fromValue',null,'toValue',null,'note',null,'createdAt',event.occurred_at
  ) order by event.occurred_at desc),'[]'::jsonb) into _history
  from clinical_audit.events event where event.resource_type='connection' and event.resource_id=_connection.id;
  return jsonb_build_object(
    'providerConfigured',_provider_configured,
    'connection',jsonb_build_object('id',_connection.id,'externalSystem',_connection.external_system,
      'state',_connection.state,'contractVersion',_connection.contract_version,
      'verifiedAt',_connection.verified_at,'pausedAt',_connection.paused_at,
      'revokedAt',_connection.revoked_at,'version',_connection.version,'createdAt',_connection.created_at),
    'invitation',_invitation,'scopes',_scopes,
    'counts',jsonb_build_object('pendingOutbound',0,'failedOutbound',0,'deadLetter',0,
      'inboundPendingReview',0,'openConflicts',0),
    'lastSuccessfulSyncAt',null,'resources','[]'::jsonb,'outbound','[]'::jsonb,
    'inbound','[]'::jsonb,'conflicts','[]'::jsonb,'history',_history,
    'generatedAt',clock_timestamp());
end $$;

create or replace function clinical_core.get_org_sync_operations(
  _organization_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _provider clinical_core.sync_providers%rowtype;
begin
  perform clinical_private.assert_production_context(_organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  select * into _provider from clinical_core.sync_providers provider
    where provider.organization_id=_organization_id and provider.stable_id='alp_patient_sync'
    order by provider.created_at desc limit 1;
  return jsonb_build_object(
    'providerConfigured',coalesce(_provider.state='active',false),
    'provider',case when _provider.id is null then null else _provider.stable_id end,
    'posture',case when _provider.state='active' then 'approved' else 'disabled' end,
    'contractVersions',case when _provider.id is null then '[]'::jsonb
      else jsonb_build_array(_provider.contract_version,_provider.lab_contract_version) end,
    'connections',jsonb_build_object(
      'verified',(select count(*) from clinical_core.patient_connections connection
        where connection.organization_id=_organization_id and connection.state='verified'),
      'invitationPending',(select count(*) from clinical_core.patient_connections connection
        where connection.organization_id=_organization_id and connection.state='invitation_pending'),
      'paused',(select count(*) from clinical_core.patient_connections connection
        where connection.organization_id=_organization_id and connection.state='paused'),
      'revoked',(select count(*) from clinical_core.patient_connections connection
        where connection.organization_id=_organization_id and connection.state='revoked')),
    'outbound',jsonb_build_object('queued',0,'sending',0,'failed',0,'deadLetter',0,'delivered',0),
    'inbound',jsonb_build_object('pendingReview',0,'processed',0,'conflicts',0),
    'maxQueueAgeSeconds',0,'lastWorkerCycle',null,'circuit',null,'deadLetters','[]'::jsonb,
    'generatedAt',clock_timestamp());
end $$;

revoke all on function clinical_core.create_sync_invitation(uuid,uuid) from public;
revoke all on function clinical_core.pause_sync_connection(uuid,integer) from public;
revoke all on function clinical_core.resume_sync_connection(uuid,integer) from public;
revoke all on function clinical_core.revoke_sync_connection(uuid,integer,text) from public;
revoke all on function clinical_core.set_sync_consent_scope(uuid,text,boolean,text,text,text,text,text) from public;
revoke all on function clinical_core.get_patient_sync_overview(uuid) from public;
revoke all on function clinical_core.get_org_sync_operations(uuid) from public;
grant execute on function clinical_core.create_sync_invitation(uuid,uuid) to clinical_core_api;
grant execute on function clinical_core.pause_sync_connection(uuid,integer) to clinical_core_api;
grant execute on function clinical_core.resume_sync_connection(uuid,integer) to clinical_core_api;
grant execute on function clinical_core.revoke_sync_connection(uuid,integer,text) to clinical_core_api;
grant execute on function clinical_core.set_sync_consent_scope(uuid,text,boolean,text,text,text,text,text) to clinical_core_api;
grant execute on function clinical_core.get_patient_sync_overview(uuid) to clinical_core_api;
grant execute on function clinical_core.get_org_sync_operations(uuid) to clinical_core_api;
