-- Human-entered patient sync codes: 13 unambiguous characters (65 bits),
-- short-lived, single-use, and SHA-256-only at rest.
begin;

create or replace function private.generate_sync_invitation_code()
returns text language plpgsql volatile set search_path = ''
as $$
declare
  _alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  _random bytea := extensions.gen_random_bytes(13);
  _code text := '';
  _index integer;
begin
  for _index in 0..12 loop
    _code := _code || substr(_alphabet, (get_byte(_random, _index) & 31) + 1, 1);
  end loop;
  return _code;
end;
$$;

revoke all on function private.generate_sync_invitation_code() from public, anon, authenticated;
grant execute on function private.generate_sync_invitation_code() to service_role;

create or replace function public.create_sync_invitation(
  _organization_id uuid, _patient_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _c public.patient_app_connections%rowtype;
        _token text; _iid uuid; _expires timestamptz;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not private.can_manage_sync(_organization_id) then
    raise exception 'managing patient-app connections requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  if not exists (select 1 from public.patient_profiles pp
                 where pp.id = _patient_id and pp.organization_id = _organization_id
                   and pp.deleted_at is null) then
    raise exception 'patient does not belong to this organization' using errcode = '42501';
  end if;

  select * into _c from public.patient_app_connections
  where organization_id = _organization_id and patient_id = _patient_id
    and external_system = 'alp' and state <> 'revoked'
  for update;

  if _c.id is not null and _c.state = 'verified' then
    raise exception 'this patient is already connected; revoke first to re-link'
      using errcode = '22023';
  end if;

  if _c.id is null then
    insert into public.patient_app_connections
      (organization_id, patient_id, external_system, state, created_by, updated_by)
    values (_organization_id, _patient_id, 'alp', 'invitation_pending', _uid, _uid)
    returning * into _c;
    perform private.log_sync_event(_organization_id, _c.id, 'connection_created',
      null, 'invitation_pending', null, _uid);
  else
    update public.patient_app_connections
    set state = 'invitation_pending', failed_reason_safe = null, paused_at = null,
        version = version + 1, updated_at = now(), updated_by = _uid
    where id = _c.id;
  end if;

  update public.patient_sync_invitations
  set superseded_at = now()
  where connection_id = _c.id and used_at is null and superseded_at is null;

  _token := private.generate_sync_invitation_code();
  _expires := now() + interval '48 hours';
  insert into public.patient_sync_invitations
    (organization_id, patient_id, connection_id, token_hash, expires_at, created_by)
  values (_organization_id, _patient_id, _c.id, private.sha256_hex(_token), _expires, _uid)
  returning id into _iid;

  perform private.log_sync_event(_organization_id, _c.id, 'invitation_created',
    null, _iid::text, null, _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_organization_id, _uid, 'sync.invitation_created', 'patient_app_connection',
    _c.id::text, 'Patient app connection invitation created', _patient_id,
    jsonb_build_object('invitationId', _iid));

  return jsonb_build_object('ok', true, 'connectionId', _c.id,
    'invitationId', _iid, 'token', _token, 'expiresAt', _expires,
    'deliveryConfigured', false,
    'message', 'Invitation recorded. Delivery provider not configured — no invitation was transmitted anywhere.');
end;
$$;

create or replace function public.verify_sync_invitation(
  _token text, _external_subject_id text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _i public.patient_sync_invitations%rowtype;
        _c public.patient_app_connections%rowtype;
        _normalized_token text := regexp_replace(upper(coalesce(_token, '')), '[[:space:]-]', '', 'g');
begin
  if _normalized_token !~ '^[A-HJ-NP-Z2-9]{13}$'
     or coalesce(btrim(_external_subject_id),'') = '' then
    raise exception 'valid code and external subject are required' using errcode = '22023';
  end if;
  select * into _i from public.patient_sync_invitations
  where token_hash = private.sha256_hex(_normalized_token)
  for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  if _i.used_at is not null then
    raise exception 'this invitation was already used' using errcode = '22023';
  end if;
  if _i.superseded_at is not null then
    raise exception 'this invitation was superseded' using errcode = '22023';
  end if;
  if _i.expires_at < now() then
    raise exception 'this invitation has expired' using errcode = '22023';
  end if;
  select * into _c from public.patient_app_connections where id = _i.connection_id for update;
  if _c.state <> 'invitation_pending' then
    raise exception 'this connection is not awaiting verification; it is %', _c.state
      using errcode = '22023';
  end if;

  update public.patient_sync_invitations set used_at = now() where id = _i.id;
  update public.patient_app_connections
  set state = 'verified', external_subject_id = btrim(_external_subject_id),
      verified_at = now(), version = version + 1, updated_at = now()
  where id = _c.id;

  perform private.log_sync_event(_c.organization_id, _c.id, 'verified',
    'invitation_pending', 'verified', null, null);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id)
  values (_c.organization_id, null, 'sync.connection_verified', 'patient_app_connection',
    _c.id::text, 'Patient app connection verified', _c.patient_id);
  return jsonb_build_object('ok', true, 'connectionId', _c.id,
    'organizationId', _c.organization_id, 'patientId', _c.patient_id,
    'contractVersion', _c.contract_version);
end;
$$;

revoke all on function public.create_sync_invitation(uuid, uuid) from public, anon;
grant execute on function public.create_sync_invitation(uuid, uuid) to authenticated, service_role;
revoke all on function public.verify_sync_invitation(text, text) from public, anon, authenticated;
grant execute on function public.verify_sync_invitation(text, text) to service_role;

commit;
