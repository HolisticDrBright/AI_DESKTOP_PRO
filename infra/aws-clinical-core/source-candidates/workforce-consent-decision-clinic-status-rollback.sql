-- Rollback for the unregistered source candidate workforce-consent-decision-clinic-status.sql. BLOCKED like it.
-- It runs only over the exact successor and restores both parents byte for byte (prosrc SHA-256
-- record_consent_grant 75d010fcb9ea0a014d72cc056a8606b071e22ee65bf03eb509b266f7d782bba3, revoke_consent_grant 0bb066f2d50d473906527ce1dc2dca38b8416e5d5e6c556751b092a2b22be0af), keeping their owner, security, search_path and
-- grants, then drops the private helper. No consent history, connection or audit row is changed.
begin;

do $guard$
begin
  if to_regprocedure('clinical_private.require_active_consent_clinic(uuid)') is null
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.record_consent_grant(uuid,uuid,text,text,text)')) <> '89ebfcfc7dbf9cb5443fec121ebac0b4eadde24c6fccc802ec2030ea9c3cf33c'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.revoke_consent_grant(uuid,text,text)')) <> 'fafbcf48ed8a24c7d50d8171c7955bd7c3ac0bf7a8a863f94ea2795733b8a9a1'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_private.require_active_consent_clinic(uuid)')) <> 'b0831b02f1f634d5d5d49e29a12c3ac2f0f7d634a834cdd14773a991c4a49888' then
    raise exception using errcode = '55000', message = 'consent_decision_rollback_refused';
  end if;
end
$guard$;

create or replace function clinical_core.record_consent_grant(
  _connection_id uuid,
  _artifact_id uuid,
  _scope text,
  _method text,
  _representative_authority text
)
returns table(
  consent_id uuid, connection_id uuid, scope text, status text,
  version integer, recorded_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _artifact clinical_core.consent_artifacts%rowtype;
  _version integer;
  _latest_status text;
  _id uuid;
  _at timestamptz := clock_timestamp();
begin
  select * into _connection from clinical_core.patient_connections c
  where c.id = _connection_id and c.state in ('verified','paused') for update;
  if not found then raise exception using errcode = 'P0002', message = 'connection_not_found'; end if;
  perform clinical_private.assert_production_context(_connection.organization_id, 'consent_management', null);
  if not (
    (_connection.consumer_person_id = clinical_private.actor_person_id()
      and clinical_private.claim('identity_pool') = 'consumer')
    or (clinical_private.claim('identity_pool') = 'workforce'
      and clinical_private.has_clinical_role(_connection.organization_id))
  ) then
    raise exception using errcode = '42501', message = 'consent_actor_refused';
  end if;
  select * into _artifact from clinical_core.consent_artifacts a
  where a.id = _artifact_id and a.organization_id = _connection.organization_id
    and a.scope = _scope and a.status = 'approved';
  if not found then raise exception using errcode = '55000', message = 'approved_artifact_required'; end if;
  select g.status into _latest_status
  from clinical_core.consent_grants g
  where g.connection_id = _connection_id and g.scope = _scope
  order by g.version desc limit 1;
  if _latest_status = 'granted' then
    raise exception using errcode = '55000', message = 'consent_already_active';
  end if;
  select coalesce(max(g.version), 0) + 1 into _version
  from clinical_core.consent_grants g
  where g.connection_id = _connection_id and g.scope = _scope;
  insert into clinical_core.consent_grants(
    organization_id, patient_record_id, connection_id, artifact_id, scope,
    status, method, representative_authority, version, recorded_at,
    recorded_by_person_id
  ) values (
    _connection.organization_id, _connection.patient_record_id, _connection_id,
    _artifact_id, _scope, 'granted', _method, _representative_authority,
    _version, _at, clinical_private.actor_person_id()
  ) returning id into _id;
  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id, purpose,
    safe_metadata
  ) values (
    _connection.organization_id, clinical_private.actor_person_id(),
    'consent.granted', 'consent', _id, 'consent_management',
    jsonb_build_object('scope', _scope, 'version', _version)
  );
  return query select _id, _connection_id, _scope, 'granted'::text, _version, _at;
end
$$;

create or replace function clinical_core.revoke_consent_grant(
  _connection_id uuid,
  _scope text,
  _reason_code text
)
returns table(
  consent_id uuid, connection_id uuid, scope text, status text,
  version integer, recorded_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _latest clinical_core.consent_grants%rowtype;
  _version integer;
  _id uuid;
  _at timestamptz := clock_timestamp();
begin
  select * into _connection from clinical_core.patient_connections c
  where c.id = _connection_id and c.state in ('verified','paused','revoked') for update;
  if not found then raise exception using errcode = 'P0002', message = 'connection_not_found'; end if;
  perform clinical_private.assert_production_context(_connection.organization_id, 'consent_management', null);
  if not (
    (_connection.consumer_person_id = clinical_private.actor_person_id()
      and clinical_private.claim('identity_pool') = 'consumer')
    or (clinical_private.claim('identity_pool') = 'workforce'
      and clinical_private.has_clinical_role(_connection.organization_id))
  ) then
    raise exception using errcode = '42501', message = 'consent_actor_refused';
  end if;
  select * into _latest from clinical_core.consent_grants g
  where g.connection_id = _connection_id and g.scope = _scope
  order by g.version desc limit 1;
  if not found or _latest.status <> 'granted' then
    raise exception using errcode = '55000', message = 'active_consent_required';
  end if;
  _version := _latest.version + 1;
  insert into clinical_core.consent_grants(
    organization_id, patient_record_id, connection_id, artifact_id, scope,
    status, method, representative_authority, reason_code, version, recorded_at,
    recorded_by_person_id
  ) values (
    _connection.organization_id, _connection.patient_record_id, _connection_id,
    null, _scope, 'revoked', _latest.method, _latest.representative_authority,
    _reason_code, _version, _at, clinical_private.actor_person_id()
  ) returning id into _id;
  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id, purpose,
    safe_metadata
  ) values (
    _connection.organization_id, clinical_private.actor_person_id(),
    'consent.revoked', 'consent', _id, 'consent_management',
    jsonb_build_object('scope', _scope, 'version', _version, 'reason_code', _reason_code)
  );
  return query select _id, _connection_id, _scope, 'revoked'::text, _version, _at;
end
$$;

drop function clinical_private.require_active_consent_clinic(uuid);

do $post$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.record_consent_grant(uuid,uuid,text,text,text)')) <> '75d010fcb9ea0a014d72cc056a8606b071e22ee65bf03eb509b266f7d782bba3'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.revoke_consent_grant(uuid,text,text)')) <> '0bb066f2d50d473906527ce1dc2dca38b8416e5d5e6c556751b092a2b22be0af'
    or to_regprocedure('clinical_private.require_active_consent_clinic(uuid)') is not null
    or not has_function_privilege('clinical_core_api', to_regprocedure('clinical_core.record_consent_grant(uuid,uuid,text,text,text)'), 'EXECUTE')
    or not has_function_privilege('clinical_core_api', to_regprocedure('clinical_core.revoke_consent_grant(uuid,text,text)'), 'EXECUTE') then
    raise exception using errcode = '55000', message = 'consent_decision_rollback_refused';
  end if;
end
$post$;

commit;
