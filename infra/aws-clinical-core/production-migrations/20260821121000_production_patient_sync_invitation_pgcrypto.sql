-- Qualify pgcrypto calls inside the security-definer invitation function.
-- The deliberately empty search path remains intact.

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
  _token := upper(substr(translate(rtrim(encode(public.gen_random_bytes(8),'base64'),'='),'+/','-_'),1,10));
  _token_hash := encode(public.digest(_token,'sha256'),'hex');
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

revoke all on function clinical_core.create_sync_invitation(uuid,uuid) from public;
grant execute on function clinical_core.create_sync_invitation(uuid,uuid) to clinical_core_api;
