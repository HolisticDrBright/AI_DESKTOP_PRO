-- Unregistered source candidate (workforce-consent-decision-clinic-status). BLOCKED: applied nowhere, registered in no
-- manifest, and no route, role or setting depends on it.
--
-- Parents (20260812010000_production_identity_consent.sql), prosrc SHA-256:
--   clinical_core.record_consent_grant  75d010fcb9ea0a014d72cc056a8606b071e22ee65bf03eb509b266f7d782bba3
--   clinical_core.revoke_consent_grant  0bb066f2d50d473906527ce1dc2dca38b8416e5d5e6c556751b092a2b22be0af
-- The successor redefines exactly these two functions, each identical to its parent except for one added workforce
-- check, and adds one private helper. Signatures, owner, SECURITY DEFINER, search_path and grants are kept (create or
-- replace keeps the parents' EXECUTE grants). No table, row, policy or role changes. It is independent of
-- legacy-claims-clinic-status.sql, which it does not touch and which stays byte-pinned.
-- Rollback: workforce-consent-decision-clinic-status-rollback.sql restores both parents exactly and drops the helper.
--
-- The defect (suspended-clinic-custody.database.test.ts pins it): the legacy-claims-clinic-status successor refuses
-- workforce clinical_data and identity_link in a closed clinic but admits workforce consent_management, because that
-- one purpose also carries the authorized cleanup, retention and privacy paths, and the request context cannot tell
-- them apart. So a practitioner of a suspended or archived clinic could still record a new consent grant or
-- withdrawal for that clinic's patient. The practitioner's decision has its own boundary that does tell the actors
-- apart: these two functions, whose workforce branch is a clinical role in the connection's clinic. Here that branch
-- also requires the clinic to be active, share-locked inside the operation's transaction. Nothing else changes:
-- the patient's own grant and withdrawal (consumer pool), consent reads, the retention service and privacy operators
-- (separately assigned, never this function) and recording cleanup (its own operator check) are as they were. The
-- refusal is the existing `consent_actor_refused`, which a non-member already receives, so it says neither whether
-- the clinic exists nor why it is closed. Whether a practitioner may still record a patient's withdrawal in a closed
-- clinic is Brandon's and counsel's decision (docs/suspended-clinic-custody-2026-10-16.md): this candidate refuses it,
-- as directed, and the patient's own withdrawal stays open.
begin;

do $guard$
begin
  if not exists (select 1 from information_schema.columns c where c.table_schema = 'clinical_core' and c.table_name = 'organizations'
      and c.column_name = 'organization_label')
    or exists (select 1 from information_schema.columns c where c.table_schema = 'clinical_core' and c.table_name = 'organizations'
      and c.column_name = 'synthetic_label') then
    raise exception using errcode = '55000', message = 'consent_decision_schema_refused';
  end if;
  if to_regprocedure('clinical_private.require_active_consent_clinic(uuid)') is not null
    or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('clinical_core.record_consent_grant(uuid,uuid,text,text,text)') and p.prosecdef
      and p.proconfig = array['search_path=""']::text[] and p.proowner = (select oid from pg_roles where rolname = current_user))
    or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('clinical_core.revoke_consent_grant(uuid,text,text)') and p.prosecdef
      and p.proconfig = array['search_path=""']::text[] and p.proowner = (select oid from pg_roles where rolname = current_user))
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.record_consent_grant(uuid,uuid,text,text,text)')) <> '75d010fcb9ea0a014d72cc056a8606b071e22ee65bf03eb509b266f7d782bba3'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.revoke_consent_grant(uuid,text,text)')) <> '0bb066f2d50d473906527ce1dc2dca38b8416e5d5e6c556751b092a2b22be0af' then
    raise exception using errcode = '55000', message = 'consent_decision_parent_refused';
  end if;
end
$guard$;

create function clinical_private.require_active_consent_clinic(_organization_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform 1 from clinical_core.organizations o
    where o.id = _organization_id and o.status = 'active'
    for share;
  if not found then
    raise exception using errcode = '42501', message = 'consent_actor_refused';
  end if;
end
$$;
revoke all on function clinical_private.require_active_consent_clinic(uuid) from public;

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
  -- workforce-consent-decision-clinic-status: a workforce actor records a consent decision only for an active clinic,
  -- read and share-locked until this transaction ends, so a suspension waits for an admitted decision and a decision
  -- waiting on an uncommitted suspension re-reads it and is refused. The patient's own decision (consumer pool) is not
  -- gated here, and no cleanup, retention or privacy path calls this function.
  if clinical_private.claim('identity_pool') = 'workforce' then
    perform clinical_private.require_active_consent_clinic(_connection.organization_id);
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
  -- workforce-consent-decision-clinic-status: a workforce actor records a consent decision only for an active clinic,
  -- read and share-locked until this transaction ends, so a suspension waits for an admitted decision and a decision
  -- waiting on an uncommitted suspension re-reads it and is refused. The patient's own decision (consumer pool) is not
  -- gated here, and no cleanup, retention or privacy path calls this function.
  if clinical_private.claim('identity_pool') = 'workforce' then
    perform clinical_private.require_active_consent_clinic(_connection.organization_id);
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

do $post$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.record_consent_grant(uuid,uuid,text,text,text)')) <> '89ebfcfc7dbf9cb5443fec121ebac0b4eadde24c6fccc802ec2030ea9c3cf33c'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.revoke_consent_grant(uuid,text,text)')) <> 'fafbcf48ed8a24c7d50d8171c7955bd7c3ac0bf7a8a863f94ea2795733b8a9a1'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_private.require_active_consent_clinic(uuid)')) <> 'b0831b02f1f634d5d5d49e29a12c3ac2f0f7d634a834cdd14773a991c4a49888'
    or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('clinical_private.require_active_consent_clinic(uuid)') and p.prosecdef
      and p.proconfig = array['search_path=""']::text[] and p.proowner = (select oid from pg_roles where rolname = current_user))
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.require_active_consent_clinic(uuid)') and a.grantee = 0 and a.privilege_type = 'EXECUTE')
    or has_function_privilege('clinical_core_api', to_regprocedure('clinical_private.require_active_consent_clinic(uuid)'), 'EXECUTE')
    or not has_function_privilege('clinical_core_api', to_regprocedure('clinical_core.record_consent_grant(uuid,uuid,text,text,text)'), 'EXECUTE')
    or not has_function_privilege('clinical_core_api', to_regprocedure('clinical_core.revoke_consent_grant(uuid,text,text)'), 'EXECUTE') then
    raise exception using errcode = '55000', message = 'consent_decision_successor_refused';
  end if;
end
$post$;

commit;
