-- Rollback for synthetic-invitation-clinic-status.sql (BLOCKED; applied nowhere). Restores
-- clinical_core.issue_connection_invitation and clinical_core.claim_connection_invitation to their parents byte for byte
-- (20260812220000_identity_function_column_qualification.sql) and drops the helper. It refuses unless the successor is
-- exactly present, and afterwards unless both parents are exactly restored. Fictional synthetic-staging only.
begin;

do $guard$
begin
  if not exists (select 1 from information_schema.columns c where c.table_schema = 'clinical_core' and c.table_name = 'organizations'
      and c.column_name = 'synthetic_label') then
    raise exception using errcode = '55000', message = 'synthetic_invitation_schema_refused';
  end if;
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.issue_connection_invitation(uuid,uuid,text,timestamptz,text)')) is distinct from 'd2b67c8228e9e092302c4100ad40b678708a1ad2c0f36cfe8668675b656649df'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.claim_connection_invitation(text,uuid)')) is distinct from '5f76b92ab1ef46cd583d7cee2fda01d9dba78cbc1c84a55fef65c03c0aff1baa'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_private.require_active_synthetic_clinic(uuid)')) is distinct from '846785ecc92ee91b810a08ed88ccd217007b63e85ae689a18816fd9e1b777a65' then
    raise exception using errcode = '55000', message = 'synthetic_invitation_rollback_refused';
  end if;
end
$guard$;

create or replace function clinical_core.issue_connection_invitation(
  _organization_id uuid,
  _patient_record_id uuid,
  _token_hash text,
  _expires_at timestamptz,
  _idempotency_key text
)
returns table(invitation_id uuid, connection_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  _connection_id uuid;
  _invitation_id uuid;
  _existing clinical_core.connection_invitations%rowtype;
begin
  perform clinical_private.assert_synthetic_context(_organization_id, 'identity_link', 'workforce');
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  if _token_hash !~ '^[0-9a-f]{64}$'
    or _expires_at <= clock_timestamp()
    or _expires_at > clock_timestamp() + interval '48 hours' then
    raise exception using errcode = '22023', message = 'invitation_shape_invalid';
  end if;
  if not exists (
    select 1 from clinical_core.patient_records p
    where p.id = _patient_record_id and p.organization_id = _organization_id
      and p.status = 'active' and p.contains_phi = false
  ) then
    raise exception using errcode = 'P0002', message = 'synthetic_patient_not_found';
  end if;

  select * into _existing from clinical_core.connection_invitations i
  where i.organization_id = _organization_id and i.idempotency_key = _idempotency_key;
  if found then
    if _existing.patient_record_id <> _patient_record_id
      or _existing.token_hash <> _token_hash
      or _existing.expires_at <> _expires_at then
      raise exception using errcode = '40001', message = 'idempotency_conflict';
    end if;
    return query select _existing.id, _existing.connection_id, _existing.expires_at;
    return;
  end if;

  select c.id into _connection_id from clinical_core.patient_connections c
  where c.organization_id = _organization_id
    and c.patient_record_id = _patient_record_id
    and c.state <> 'revoked'
  for update;
  if _connection_id is not null and exists (
    select 1 from clinical_core.patient_connections c
    where c.id = _connection_id and c.state <> 'invitation_pending'
  ) then
    raise exception using errcode = '55000', message = 'connection_not_invitable';
  end if;
  if _connection_id is null then
    insert into clinical_core.patient_connections(organization_id, patient_record_id)
    values (_organization_id, _patient_record_id)
    returning id into _connection_id;
  end if;

  update clinical_core.connection_invitations i
  set status = 'superseded'
  where i.connection_id = _connection_id and i.status = 'pending';

  insert into clinical_core.connection_invitations(
    organization_id, patient_record_id, connection_id, token_hash,
    idempotency_key, expires_at, created_by_person_id
  ) values (
    _organization_id, _patient_record_id, _connection_id, _token_hash,
    _idempotency_key, _expires_at, clinical_private.actor_person_id()
  ) returning id into _invitation_id;

  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id, purpose,
    safe_metadata
  ) values (
    _organization_id, clinical_private.actor_person_id(),
    'connection.invitation_issued', 'connection', _connection_id, 'identity_link',
    jsonb_build_object('invitation_id', _invitation_id)
  );
  return query select _invitation_id, _connection_id, _expires_at;
end
$$;

create or replace function clinical_core.claim_connection_invitation(
  _token_hash text,
  _consumer_person_id uuid
)
returns table(
  connection_id uuid, patient_record_id uuid, consumer_person_id uuid,
  state text, verified_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  _invitation clinical_core.connection_invitations%rowtype;
  _verified_at timestamptz := clock_timestamp();
begin
  if clinical_private.actor_person_id() <> _consumer_person_id
    or clinical_private.claim('identity_pool') <> 'consumer'
    or clinical_private.claim('purpose') <> 'identity_link'
    or clinical_private.claim('environment') <> 'synthetic-staging'
    or clinical_private.claim('data_classification') <> 'synthetic_only' then
    raise exception using errcode = '42501', message = 'consumer_identity_required';
  end if;
  select * into _invitation from clinical_core.connection_invitations i
  where i.token_hash = _token_hash for update;
  if not found or _invitation.status <> 'pending' or _invitation.expires_at <= _verified_at then
    raise exception using errcode = 'P0002', message = 'invitation_invalid_or_expired';
  end if;
  perform clinical_private.assert_synthetic_context(_invitation.organization_id, 'identity_link', 'consumer');

  update clinical_core.patient_connections c
  set consumer_person_id = _consumer_person_id,
      state = 'verified', verified_at = _verified_at, updated_at = _verified_at
  where c.id = _invitation.connection_id and c.state = 'invitation_pending';
  if not found then
    raise exception using errcode = '55000', message = 'connection_not_claimable';
  end if;
  update clinical_core.connection_invitations i set status = 'accepted', used_at = _verified_at
  where i.id = _invitation.id;
  update clinical_core.connection_invitations i
  set status = 'superseded'
  where i.connection_id = _invitation.connection_id and i.status = 'pending' and i.id <> _invitation.id;

  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id, purpose
  ) values (
    _invitation.organization_id, _consumer_person_id,
    'connection.invitation_claimed', 'connection', _invitation.connection_id, 'identity_link'
  );
  return query select _invitation.connection_id, _invitation.patient_record_id,
    _consumer_person_id, 'verified'::text, _verified_at;
end
$$;

drop function clinical_private.require_active_synthetic_clinic(uuid);

do $check$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.issue_connection_invitation(uuid,uuid,text,timestamptz,text)')) <> '5602dbabe5145e522e70c4b6e4d905dd18a39238f8d9052be75bd7d02d2125b7'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = to_regprocedure('clinical_core.claim_connection_invitation(text,uuid)')) <> '7decec8ec32ec6e0fcc9c3597d4c1ba96fdc835414515159d37e9a650a19da30'
    or to_regprocedure('clinical_private.require_active_synthetic_clinic(uuid)') is not null
    or not has_function_privilege('clinical_core_api', to_regprocedure('clinical_core.issue_connection_invitation(uuid,uuid,text,timestamptz,text)'), 'EXECUTE') or not has_function_privilege('clinical_core_api', to_regprocedure('clinical_core.claim_connection_invitation(text,uuid)'), 'EXECUTE') then
    raise exception using errcode = '55000', message = 'synthetic_invitation_rollback_refused';
  end if;
end
$check$;

commit;
