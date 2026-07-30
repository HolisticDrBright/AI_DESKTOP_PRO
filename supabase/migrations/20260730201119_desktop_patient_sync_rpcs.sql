-- Clinical Runtime Phase 5: patient-sync gateway RPC boundary.
--
-- 13 caller RPCs (authenticated, gated) + 4 worker-boundary RPCs
-- (service_role only). Sending/claiming fails closed without a registered
-- 'alp_patient_sync' connector; nothing is ever marked delivered or
-- acknowledged except through provider evidence recorded by the worker
-- boundary. Payloads are built SERVER-side (minimum necessary) — no caller
-- can inject an envelope body. All state/time/identity from the database.

begin;

-- Sync review work is real review-queue work.
alter table public.review_queue_items drop constraint review_queue_items_item_type_check;
alter table public.review_queue_items add constraint review_queue_items_item_type_check
  check (item_type in ('lab_extraction','abnormal_result','reasoning_snapshot',
    'hypothesis','recommendation','supplement_interaction','protocol','experiment',
    'assessment','patient_message','safety_alert','refill_request','low_adherence',
    'overdue_followup','sync_review'));

-- ------------------------------------------------------- private helpers

create or replace function private.sync_scope_for_resource(_resource_type text)
returns text language sql immutable security definer set search_path = ''
as $$
  select case _resource_type
    when 'program_enrollment' then 'programs'
    when 'protocol_version' then 'protocols_supplements'
    when 'supplement_instructions' then 'protocols_supplements'
    when 'nutrition_plan' then 'nutrition'
    when 'appointment_summary' then 'appointments'
    when 'message' then 'messaging'
    when 'checkin_assignment' then 'forms_checkins'
    when 'lab_summary' then 'lab_summaries'
    else null
  end;
$$;

create or replace function private.sync_inbound_scope_for(_resource_type text)
returns text language sql immutable security definer set search_path = ''
as $$
  select case _resource_type
    when 'program_progress' then 'programs'
    when 'quiz_response' then 'forms_checkins'
    when 'checkin_response' then 'forms_checkins'
    when 'protocol_adherence' then 'symptoms_adherence'
    when 'supplement_adherence' then 'symptoms_adherence'
    when 'symptom_report' then 'symptoms_adherence'
    when 'outcome_report' then 'symptoms_adherence'
    when 'wearable_summary' then 'wearables'
    when 'patient_message' then 'messaging'
    when 'appointment_request' then 'appointments'
    else null -- consent_change / receipts carry their own scope semantics
  end;
$$;

create or replace function private.log_sync_event(
  _organization_id uuid, _connection_id uuid, _kind text,
  _from text, _to text, _note text, _actor uuid
) returns void language sql security definer set search_path = ''
as $$
  insert into public.sync_connection_events
    (organization_id, connection_id, kind, from_value, to_value, note, actor_user_id)
  values (_organization_id, _connection_id, _kind, _from, _to, _note, _actor);
$$;

-- Bounded exponential backoff: 2^attempts minutes, capped at 24 hours.
create or replace function private.sync_backoff(_attempts integer)
returns timestamptz language sql stable security definer set search_path = ''
as $$
  select now() + least(power(2, greatest(_attempts, 0)) * interval '1 minute',
                       interval '24 hours');
$$;

-- Caller-side connection guard: exists + membership + patient access.
create or replace function private.sync_connection_guard(_connection_id uuid)
returns public.patient_app_connections
language plpgsql stable security definer set search_path = ''
as $$
declare _c public.patient_app_connections%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _c from public.patient_app_connections where id = _connection_id;
  if not found then
    raise exception 'connection not found' using errcode = 'P0002';
  end if;
  if not private.is_org_member(_c.organization_id)
     or not private.can_access_patient(_c.patient_id) then
    raise exception 'not authorized for this connection' using errcode = '42501';
  end if;
  return _c;
end;
$$;

-- Idempotent per-ref review task (a real review_queue_items row).
create or replace function private.sync_review_task(
  _organization_id uuid, _patient_id uuid, _ref_id uuid,
  _title text, _priority text
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _tid uuid;
begin
  select id into _tid from public.review_queue_items
  where item_type = 'sync_review' and ref_id = _ref_id and deleted_at is null;
  if found then return _tid; end if;
  insert into public.review_queue_items
    (organization_id, patient_id, item_type, ref_id, title, priority, status)
  values (_organization_id, _patient_id, 'sync_review', _ref_id,
          left(_title, 200), _priority, 'open')
  returning id into _tid;
  return _tid;
end;
$$;

-- ------------------------------------------------------------- overview

create or replace function public.get_patient_sync_overview(_patient_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _c public.patient_app_connections%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  select * into _c from public.patient_app_connections
  where patient_id = _patient_id and state <> 'revoked'
  order by created_at desc limit 1;

  return jsonb_build_object(
    'providerConfigured', (_c.id is not null
        and private.sync_provider_configured(_c.organization_id) is not null)
      or (_c.id is null and exists (
        select 1 from public.patient_profiles pp
        where pp.id = _patient_id
          and private.sync_provider_configured(pp.organization_id) is not null)),
    'connection', case when _c.id is null then null else jsonb_build_object(
      'id', _c.id, 'externalSystem', _c.external_system,
      'state', _c.state, 'contractVersion', _c.contract_version,
      'verifiedAt', _c.verified_at, 'pausedAt', _c.paused_at,
      'revokedAt', _c.revoked_at, 'version', _c.version,
      'createdAt', _c.created_at) end,
    'invitation', (select jsonb_build_object(
        'id', i.id, 'expiresAt', i.expires_at, 'createdAt', i.created_at,
        'usedAt', i.used_at,
        'expired', i.used_at is null and i.expires_at < now())
      from public.patient_sync_invitations i
      where i.connection_id = _c.id and i.superseded_at is null
      order by i.created_at desc limit 1),
    'scopes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'scope', s.scope, 'status', s.status,
        'artifactTitle', s.artifact_title, 'artifactVersion', s.artifact_version,
        'jurisdiction', s.jurisdiction, 'method', s.method,
        'authority', s.representative_authority,
        'grantedAt', s.granted_at, 'revokedAt', s.revoked_at,
        'revokeSource', s.revoke_source)
        order by s.granted_at desc)
      from public.sync_consent_scopes s where s.connection_id = _c.id), '[]'::jsonb),
    'counts', jsonb_build_object(
      'pendingOutbound', (select count(*) from public.sync_outbound_events e
        where e.connection_id = _c.id and e.state in ('queued','sending')),
      'failedOutbound', (select count(*) from public.sync_outbound_events e
        where e.connection_id = _c.id and e.state = 'failed'),
      'deadLetter', (select count(*) from public.sync_outbound_events e
        where e.connection_id = _c.id and e.state = 'dead_letter'),
      'inboundPendingReview', (select count(*) from public.sync_inbound_events e
        where e.connection_id = _c.id and e.state = 'review_pending'),
      'openConflicts', (select count(*) from public.sync_conflicts x
        where x.connection_id = _c.id and x.state = 'open')),
    'lastSuccessfulSyncAt', (select greatest(
        (select max(e.delivered_at) from public.sync_outbound_events e
         where e.connection_id = _c.id),
        (select max(e.received_at) from public.sync_inbound_events e
         where e.connection_id = _c.id and e.state in ('processed','review_pending')))),
    'resources', coalesce((select jsonb_agg(jsonb_build_object(
        'resourceType', a.resource_type, 'resourceId', a.resource_id,
        'resourceVersion', a.resource_version, 'state', a.state,
        'acknowledgedAt', a.acknowledged_at, 'updatedAt', a.updated_at)
        order by a.updated_at desc)
      from public.sync_resource_acks a where a.connection_id = _c.id), '[]'::jsonb),
    'outbound', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'eventUid', e.event_uid, 'scope', e.scope,
        'resourceType', e.resource_type, 'resourceId', e.resource_id,
        'resourceVersion', e.resource_version, 'state', e.state,
        'attempts', e.attempts, 'nextRetryAt', e.next_retry_at,
        'lastError', e.last_error_safe, 'occurredAt', e.occurred_at,
        'deliveredAt', e.delivered_at, 'acknowledgedAt', e.acknowledged_at)
        order by e.created_at desc)
      from (select * from public.sync_outbound_events ee
            where ee.connection_id = _c.id
            order by ee.created_at desc limit 25) e), '[]'::jsonb),
    'inbound', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'scope', e.scope, 'resourceType', e.resource_type,
        'externalResourceId', e.external_resource_id,
        'resourceVersion', e.resource_version, 'state', e.state,
        'occurredAt', e.occurred_at, 'receivedAt', e.received_at,
        'payload', e.payload,
        'corrections', coalesce((select jsonb_agg(jsonb_build_object(
            'version', c2.version, 'overlay', c2.overlay, 'reason', c2.reason,
            'createdAt', c2.created_at) order by c2.version)
          from public.sync_inbound_corrections c2
          where c2.inbound_event_id = e.id), '[]'::jsonb),
        'reviewedAt', e.reviewed_at, 'reviewNote', e.review_note,
        'rejectionReason', e.rejection_reason_safe,
        'providerEventId', e.provider_event_id)
        order by case when e.state = 'review_pending' then 0 else 1 end,
                 e.received_at desc)
      from (select * from public.sync_inbound_events ee
            where ee.connection_id = _c.id
            order by case when ee.state = 'review_pending' then 0 else 1 end,
                     ee.received_at desc limit 25) e), '[]'::jsonb),
    'conflicts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'scope', x.scope, 'resourceType', x.resource_type,
        'resourceRef', x.resource_ref, 'reason', x.reason_safe,
        'desktopVersion', x.desktop_version, 'externalVersion', x.external_version,
        'state', x.state, 'resolutionNote', x.resolution_note,
        'resolvedAt', x.resolved_at, 'version', x.version, 'createdAt', x.created_at)
        order by x.created_at desc)
      from (select * from public.sync_conflicts xx
            where xx.connection_id = _c.id
            order by xx.created_at desc limit 25) x), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object(
        'kind', h.kind, 'fromValue', h.from_value, 'toValue', h.to_value,
        'note', h.note, 'createdAt', h.created_at) order by h.created_at desc)
      from (select * from public.sync_connection_events hh
            where hh.connection_id = _c.id
            order by hh.created_at desc limit 30) h), '[]'::jsonb),
    'generatedAt', now());
end;
$$;

-- ------------------------------------------------------------ invitation

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

  -- Supersede any older pending invitation; single active invitation.
  update public.patient_sync_invitations
  set superseded_at = now()
  where connection_id = _c.id and used_at is null and superseded_at is null;

  -- Opaque 256-bit token. Returned ONCE; only the hash is stored.
  _token := encode(extensions.gen_random_bytes(32), 'hex');
  _expires := now() + interval '7 days';
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

-- --------------------------------------------------- connection lifecycle

create or replace function public.pause_sync_connection(
  _connection_id uuid, _expected_version integer
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.patient_app_connections%rowtype; _uid uuid := auth.uid();
begin
  _c := private.sync_connection_guard(_connection_id);
  if not private.can_manage_sync(_c.organization_id) then
    raise exception 'managing patient-app connections requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  perform 1 from public.patient_app_connections where id = _c.id for update;
  select * into _c from public.patient_app_connections where id = _c.id;
  if _expected_version is distinct from _c.version then
    raise exception 'this connection changed elsewhere since it was loaded' using errcode = '40001';
  end if;
  if _c.state <> 'verified' then
    raise exception 'only a verified connection can be paused; this one is %', _c.state
      using errcode = '22023';
  end if;
  update public.patient_app_connections
  set state = 'paused', paused_at = now(), version = version + 1,
      updated_at = now(), updated_by = _uid
  where id = _c.id;
  perform private.log_sync_event(_c.organization_id, _c.id, 'paused', 'verified', 'paused', null, _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id)
  values (_c.organization_id, _uid, 'sync.connection_paused', 'patient_app_connection',
    _c.id::text, 'Patient app connection paused', _c.patient_id);
  return jsonb_build_object('ok', true, 'state', 'paused', 'version', _c.version + 1,
    'message', 'Connection paused. Nothing syncs in either direction until resumed.');
end;
$$;

create or replace function public.resume_sync_connection(
  _connection_id uuid, _expected_version integer
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.patient_app_connections%rowtype; _uid uuid := auth.uid();
begin
  _c := private.sync_connection_guard(_connection_id);
  if not private.can_manage_sync(_c.organization_id) then
    raise exception 'managing patient-app connections requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  perform 1 from public.patient_app_connections where id = _c.id for update;
  select * into _c from public.patient_app_connections where id = _c.id;
  if _expected_version is distinct from _c.version then
    raise exception 'this connection changed elsewhere since it was loaded' using errcode = '40001';
  end if;
  if _c.state <> 'paused' then
    raise exception 'only a paused connection can be resumed; this one is %', _c.state
      using errcode = '22023';
  end if;
  update public.patient_app_connections
  set state = 'verified', paused_at = null, version = version + 1,
      updated_at = now(), updated_by = _uid
  where id = _c.id;
  perform private.log_sync_event(_c.organization_id, _c.id, 'resumed', 'paused', 'verified', null, _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id)
  values (_c.organization_id, _uid, 'sync.connection_resumed', 'patient_app_connection',
    _c.id::text, 'Patient app connection resumed', _c.patient_id);
  return jsonb_build_object('ok', true, 'state', 'verified', 'version', _c.version + 1,
    'message', 'Connection resumed.');
end;
$$;

create or replace function public.revoke_sync_connection(
  _connection_id uuid, _expected_version integer, _reason text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.patient_app_connections%rowtype; _uid uuid := auth.uid(); _n integer;
begin
  _c := private.sync_connection_guard(_connection_id);
  if not private.can_manage_sync(_c.organization_id) then
    raise exception 'managing patient-app connections requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'revocation requires a reason' using errcode = '22023';
  end if;
  perform 1 from public.patient_app_connections where id = _c.id for update;
  select * into _c from public.patient_app_connections where id = _c.id;
  if _expected_version is distinct from _c.version then
    raise exception 'this connection changed elsewhere since it was loaded' using errcode = '40001';
  end if;
  if _c.state = 'revoked' then
    return jsonb_build_object('ok', true, 'state', 'revoked', 'alreadyApplied', true,
      'message', 'This connection is already revoked.');
  end if;

  update public.patient_app_connections
  set state = 'revoked', revoked_at = now(), revoke_reason_safe = left(_reason, 300),
      version = version + 1, updated_at = now(), updated_by = _uid
  where id = _c.id;

  -- Revocation blocks everything IMMEDIATELY: pending invitations die and
  -- undelivered exports are cancelled. History is preserved, never deleted.
  update public.patient_sync_invitations set superseded_at = now()
  where connection_id = _c.id and used_at is null and superseded_at is null;
  update public.sync_outbound_events
  set state = 'cancelled', updated_at = now(),
      last_error_safe = 'connection revoked'
  where connection_id = _c.id and state in ('queued','sending','failed');
  get diagnostics _n = row_count;

  perform private.log_sync_event(_c.organization_id, _c.id, 'revoked',
    _c.state, 'revoked', left(_reason, 300), _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, _uid, 'sync.connection_revoked', 'patient_app_connection',
    _c.id::text, 'Patient app connection revoked', _c.patient_id,
    jsonb_build_object('cancelledOutbound', _n));
  return jsonb_build_object('ok', true, 'state', 'revoked', 'cancelledOutbound', _n,
    'message', 'Connection revoked. Exports and inbound writes are blocked; re-linking requires a new invitation.');
end;
$$;

-- --------------------------------------------------------- consent scopes

create or replace function public.set_sync_consent_scope(
  _connection_id uuid, _scope text, _grant boolean,
  _artifact_title text default null, _artifact_version text default null,
  _jurisdiction text default null, _method text default 'in_person',
  _authority text default 'self'
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.patient_app_connections%rowtype; _uid uuid := auth.uid(); _s record;
begin
  _c := private.sync_connection_guard(_connection_id);
  if not private.can_manage_sync(_c.organization_id) then
    raise exception 'managing consent scopes requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  if not private.sync_scope_valid(_scope) then
    raise exception 'unknown consent scope' using errcode = '22023';
  end if;

  if _grant then
    if _c.state not in ('verified','paused') then
      raise exception 'consent scopes attach to a verified connection; this one is %', _c.state
        using errcode = '22023';
    end if;
    if coalesce(btrim(_artifact_title),'') = '' or coalesce(btrim(_artifact_version),'') = '' then
      raise exception 'a consent grant must record the presented artifact and its version'
        using errcode = '22023';
    end if;
    if exists (select 1 from public.sync_consent_scopes s
               where s.connection_id = _c.id and s.scope = _scope and s.status = 'granted') then
      return jsonb_build_object('ok', true, 'alreadyApplied', true,
        'message', 'This scope is already granted.');
    end if;
    insert into public.sync_consent_scopes
      (organization_id, patient_id, connection_id, scope, status,
       artifact_title, artifact_version, jurisdiction, method,
       representative_authority, granted_by,
       version)
    values (_c.organization_id, _c.patient_id, _c.id, _scope, 'granted',
       btrim(_artifact_title), btrim(_artifact_version), nullif(btrim(coalesce(_jurisdiction,'')),''),
       _method, _authority, _uid,
       coalesce((select max(version) from public.sync_consent_scopes s
                 where s.connection_id = _c.id and s.scope = _scope), 0) + 1);
    perform private.log_sync_event(_c.organization_id, _c.id, 'scope_granted',
      null, _scope, null, _uid);
    insert into public.audit_events (organization_id, actor_user_id, action,
      resource_type, resource_id, safe_message, patient_id, metadata)
    values (_c.organization_id, _uid, 'sync.scope_granted', 'sync_consent_scope',
      _c.id::text, 'Sync consent scope granted', _c.patient_id,
      jsonb_build_object('scope', _scope, 'method', _method));
    return jsonb_build_object('ok', true, 'scope', _scope, 'status', 'granted',
      'message', 'Scope granted.');
  end if;

  select * into _s from public.sync_consent_scopes
  where connection_id = _c.id and scope = _scope and status = 'granted'
  for update;
  if not found then
    return jsonb_build_object('ok', true, 'alreadyApplied', true,
      'message', 'This scope is not currently granted.');
  end if;
  update public.sync_consent_scopes
  set status = 'revoked', revoked_at = now(), revoked_by = _uid,
      revoke_source = 'practitioner', updated_at = now()
  where id = _s.id;
  -- Future synchronization for THIS scope stops now; other scopes continue.
  update public.sync_outbound_events
  set state = 'cancelled', updated_at = now(), last_error_safe = 'consent revoked'
  where connection_id = _c.id and scope = _scope and state in ('queued','sending','failed');
  perform private.log_sync_event(_c.organization_id, _c.id, 'scope_revoked',
    _scope, null, null, _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, _uid, 'sync.scope_revoked', 'sync_consent_scope',
    _c.id::text, 'Sync consent scope revoked', _c.patient_id,
    jsonb_build_object('scope', _scope));
  return jsonb_build_object('ok', true, 'scope', _scope, 'status', 'revoked',
    'message', 'Scope revoked. Queued exports for this scope were cancelled; historical records are preserved.');
end;
$$;

-- --------------------------------------------------------- queue exports

create or replace function public.queue_sync_export(
  _connection_id uuid, _resource_type text, _resource_id uuid,
  _correlation_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.patient_app_connections%rowtype; _uid uuid := auth.uid();
        _scope text; _payload jsonb; _rver text; _key text;
        _e public.sync_outbound_events%rowtype; _eid uuid; _euid uuid;
begin
  _c := private.sync_connection_guard(_connection_id);
  if not private.can_manage_sync(_c.organization_id) then
    raise exception 'queueing exports requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  _scope := private.sync_scope_for_resource(_resource_type);
  if _scope is null then
    raise exception 'unknown outbound resource type' using errcode = '22023';
  end if;
  if _c.state <> 'verified' then
    raise exception 'exports require a verified connection; this one is %', _c.state
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.sync_consent_scopes s
                 where s.connection_id = _c.id and s.scope = _scope and s.status = 'granted') then
    raise exception 'the patient has not granted the % scope; export refused', _scope
      using errcode = '42501';
  end if;
  -- FAIL CLOSED: no approved AI Longevity Pro provider, no queueing. This is
  -- a durable, honest outcome — nothing is queued that could never deliver.
  if private.sync_provider_configured(_c.organization_id) is null then
    perform private.log_sync_event(_c.organization_id, _c.id, 'export_refused',
      _resource_type, _resource_id::text, 'AI Longevity Pro connection not configured', _uid);
    return jsonb_build_object('ok', false, 'refusal', 'provider_not_configured',
      'message', 'AI Longevity Pro connection not configured. Nothing was queued or sent.');
  end if;

  -- Build the MINIMUM-NECESSARY payload server-side, per resource type.
  if _resource_type = 'program_enrollment' then
    select jsonb_build_object(
        'programId', en.program_id, 'programVersionId', en.program_version_id,
        'programVersion', pv.version, 'enrollmentId', en.id,
        'title', pv.title, 'summary', pv.summary, 'disclaimer', pv.disclaimer,
        'status', en.status),
      pv.version::text
    into _payload, _rver
    from public.program_enrollments en
    join public.program_versions pv on pv.id = en.program_version_id
    where en.id = _resource_id and en.patient_id = _c.patient_id
      and en.organization_id = _c.organization_id and en.deleted_at is null
      and en.status in ('invited','active');
    if _payload is null then
      raise exception 'no active enrollment of this patient matches' using errcode = 'P0002';
    end if;
  elsif _resource_type = 'protocol_version' then
    select jsonb_build_object(
        'protocolId', pv.protocol_id, 'protocolVersionId', pv.id,
        'version', pv.version, 'title', pv.title, 'summary', pv.summary,
        'status', pv.status),
      pv.version::text
    into _payload, _rver
    from public.protocol_versions pv
    where pv.id = _resource_id and pv.patient_id = _c.patient_id
      and pv.organization_id = _c.organization_id
      and pv.status in ('approved','active');
    if _payload is null then
      raise exception 'no approved protocol version of this patient matches' using errcode = 'P0002';
    end if;
  elsif _resource_type = 'supplement_instructions' then
    select jsonb_build_object(
        'protocolVersionId', pv.id, 'version', pv.version,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'label', i.label, 'dosage', i.dosage_text, 'timing', i.timing_text,
            'route', i.route, 'instructions', i.instructions)
            order by i.position)
          from public.protocol_items i where i.version_id = pv.id), '[]'::jsonb)),
      pv.version::text
    into _payload, _rver
    from public.protocol_versions pv
    where pv.id = _resource_id and pv.patient_id = _c.patient_id
      and pv.organization_id = _c.organization_id
      and pv.status in ('approved','active');
    if _payload is null then
      raise exception 'no approved protocol version of this patient matches' using errcode = 'P0002';
    end if;
  elsif _resource_type = 'appointment_summary' then
    select jsonb_build_object(
        'appointmentId', a.id, 'title', a.title, 'appointmentType', a.appointment_type,
        'startsAt', a.starts_at, 'endsAt', a.ends_at, 'location', a.location,
        'telehealthUrl', a.telehealth_url, 'status', a.status),
      a.version::text
    into _payload, _rver
    from public.appointments a
    where a.id = _resource_id and a.patient_id = _c.patient_id
      and a.organization_id = _c.organization_id and a.deleted_at is null;
    if _payload is null then
      raise exception 'no appointment of this patient matches' using errcode = 'P0002';
    end if;
  elsif _resource_type = 'message' then
    select jsonb_build_object(
        'messageId', m.id, 'conversationId', m.conversation_id,
        'body', m.body, 'createdAt', m.created_at),
      m.version::text
    into _payload, _rver
    from public.messages m
    where m.id = _resource_id and m.patient_id = _c.patient_id
      and m.organization_id = _c.organization_id
      and m.is_from_patient = false and m.status in ('queued','sent','delivered');
    if _payload is null then
      raise exception 'only a practitioner message accepted by the messaging outbox can be exported'
        using errcode = '22023';
    end if;
  elsif _resource_type = 'lab_summary' then
    if _resource_id is distinct from _c.patient_id then
      raise exception 'a lab summary is addressed by the patient id' using errcode = '22023';
    end if;
    select jsonb_build_object(
        'reviewedObservationCount', count(*) filter (where o.review_status = 'accepted'),
        'observationCount', count(*),
        'lastObservedAt', max(o.observed_at)),
      coalesce(max(o.observed_at)::text, 'empty')
    into _payload, _rver
    from public.biomarker_observations o
    where o.patient_id = _c.patient_id and o.organization_id = _c.organization_id
      and o.deleted_at is null;
  elsif _resource_type in ('nutrition_plan','checkin_assignment') then
    raise exception 'this resource type has no live source yet; nothing can be exported honestly'
      using errcode = '22023';
  else
    raise exception 'resource withdrawal uses withdraw_sync_resource' using errcode = '22023';
  end if;

  _key := _c.id::text || ':' || _resource_type || ':' || _resource_id::text || ':' || _rver;
  select * into _e from public.sync_outbound_events where idempotency_key = _key;
  if found then
    return jsonb_build_object('ok', true, 'alreadyQueued', true, 'eventId', _e.id,
      'state', _e.state, 'message', 'This resource version is already in the sync queue.');
  end if;

  -- A newer version supersedes any still-undelivered older envelope.
  update public.sync_outbound_events
  set state = 'superseded', updated_at = now(), last_error_safe = 'superseded by newer version'
  where connection_id = _c.id and resource_type = _resource_type
    and resource_id = _resource_id and state in ('queued','failed');

  insert into public.sync_outbound_events
    (organization_id, connection_id, patient_id, scope, resource_type,
     resource_id, resource_version, payload, payload_hash,
     idempotency_key, correlation_id, provenance, created_by)
  values (_c.organization_id, _c.id, _c.patient_id, _scope, _resource_type,
     _resource_id, _rver, _payload, private.sha256_hex(_payload::text),
     _key, _correlation_id,
     jsonb_build_object('producer', 'desktop', 'queuedBy', 'practitioner'),
     _uid)
  returning id, event_uid into _eid, _euid;

  insert into public.sync_resource_acks as a
    (organization_id, connection_id, scope, resource_type, resource_id,
     resource_version, state, last_outbound_event_id)
  values (_c.organization_id, _c.id, _scope, _resource_type, _resource_id,
     _rver, 'pending', _eid)
  on conflict (connection_id, resource_type, resource_id) do update
  set resource_version = excluded.resource_version, state = 'pending',
      last_outbound_event_id = excluded.last_outbound_event_id,
      acknowledged_at = null, updated_at = now();

  insert into public.sync_cursors as sc
    (organization_id, connection_id, direction, scope, position_at, last_event_id)
  values (_c.organization_id, _c.id, 'outbound', _scope, now(), _eid)
  on conflict (connection_id, direction, scope) do update
  set position_at = now(), last_event_id = excluded.last_event_id, updated_at = now();

  perform private.log_sync_event(_c.organization_id, _c.id, 'export_queued',
    _resource_type, _resource_id::text, null, _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, _uid, 'sync.export_queued', 'sync_outbound_event',
    _eid::text, 'Sync export queued', _c.patient_id,
    jsonb_build_object('resourceType', _resource_type, 'scope', _scope));
  return jsonb_build_object('ok', true, 'eventId', _eid, 'eventUid', _euid,
    'state', 'queued',
    'message', 'Queued. It is NOT delivered until the provider acknowledges it.');
end;
$$;

create or replace function public.withdraw_sync_resource(
  _connection_id uuid, _resource_type text, _resource_id uuid, _reason text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.patient_app_connections%rowtype; _uid uuid := auth.uid();
        _a public.sync_resource_acks%rowtype; _eid uuid; _key text;
begin
  _c := private.sync_connection_guard(_connection_id);
  if not private.can_manage_sync(_c.organization_id) then
    raise exception 'withdrawing resources requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  if coalesce(btrim(_reason),'') = '' then
    raise exception 'withdrawal requires a reason' using errcode = '22023';
  end if;
  select * into _a from public.sync_resource_acks
  where connection_id = _c.id and resource_type = _resource_type
    and resource_id = _resource_id
  for update;
  if not found then
    raise exception 'this resource was never exported on this connection' using errcode = 'P0002';
  end if;
  if _a.state = 'withdrawn' then
    return jsonb_build_object('ok', true, 'alreadyApplied', true,
      'message', 'This resource is already withdrawn.');
  end if;

  update public.sync_outbound_events
  set state = 'superseded', updated_at = now(), last_error_safe = 'withdrawn'
  where connection_id = _c.id and resource_type = _resource_type
    and resource_id = _resource_id and state in ('queued','failed');

  _key := _c.id::text || ':withdrawal:' || _resource_type || ':' || _resource_id::text
          || ':' || _a.resource_version;
  if not exists (select 1 from public.sync_outbound_events where idempotency_key = _key) then
    insert into public.sync_outbound_events
      (organization_id, connection_id, patient_id, scope, resource_type,
       resource_id, resource_version,
       payload, payload_hash, idempotency_key, provenance, created_by)
    values (_c.organization_id, _c.id, _c.patient_id, _a.scope, 'resource_withdrawal',
       _resource_id, _a.resource_version,
       jsonb_build_object('withdrawnResourceType', _resource_type,
         'resourceId', _resource_id, 'reason', left(btrim(_reason), 300)),
       private.sha256_hex(jsonb_build_object('withdrawnResourceType', _resource_type,
         'resourceId', _resource_id, 'reason', left(btrim(_reason), 300))::text),
       _key, jsonb_build_object('producer','desktop'), _uid)
    returning id into _eid;
  end if;

  update public.sync_resource_acks
  set state = 'withdrawn', updated_at = now()
  where id = _a.id;

  perform private.log_sync_event(_c.organization_id, _c.id, 'resource_withdrawn',
    _resource_type, _resource_id::text, left(btrim(_reason), 300), _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, _uid, 'sync.resource_withdrawn', 'sync_resource_ack',
    _a.id::text, 'Sync resource withdrawn', _c.patient_id,
    jsonb_build_object('resourceType', _resource_type));
  return jsonb_build_object('ok', true, 'eventId', _eid,
    'message', 'Withdrawal queued; the resource no longer syncs.');
end;
$$;

-- ------------------------------------------------------- retry / conflicts

create or replace function public.retry_sync_event(
  _event_id uuid, _reason text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e public.sync_outbound_events%rowtype; _uid uuid := auth.uid();
        _c public.patient_app_connections%rowtype;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _e from public.sync_outbound_events where id = _event_id for update;
  if not found then raise exception 'sync event not found' using errcode = 'P0002'; end if;
  _c := private.sync_connection_guard(_e.connection_id);
  if not private.can_manage_sync(_e.organization_id) then
    raise exception 'manual retry requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  if coalesce(btrim(_reason),'') = '' then
    raise exception 'manual retry requires a reason' using errcode = '22023';
  end if;
  if _e.state not in ('failed','dead_letter') then
    raise exception 'only a failed or dead-letter event can be retried; this one is %', _e.state
      using errcode = '22023';
  end if;
  if _c.state <> 'verified' then
    raise exception 'the connection is %; resume it before retrying', _c.state
      using errcode = '22023';
  end if;

  update public.sync_outbound_events
  set state = 'queued', next_retry_at = now(), updated_at = now()
  where id = _e.id;
  update public.sync_dead_letters
  set retried_at = now(), retried_by = _uid, retry_reason = left(btrim(_reason), 300)
  where outbound_event_id = _e.id;

  perform private.log_sync_event(_e.organization_id, _e.connection_id, 'manual_retry',
    _e.state, 'queued', left(btrim(_reason), 300), _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_e.organization_id, _uid, 'sync.manual_retry', 'sync_outbound_event',
    _e.id::text, 'Sync event manually retried', _e.patient_id,
    jsonb_build_object('fromState', _e.state));
  return jsonb_build_object('ok', true, 'state', 'queued', 'message', 'Requeued for delivery.');
end;
$$;

create or replace function public.resolve_sync_conflict(
  _conflict_id uuid, _resolution text, _note text, _expected_version integer
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _x public.sync_conflicts%rowtype; _uid uuid := auth.uid();
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _x from public.sync_conflicts where id = _conflict_id for update;
  if not found then raise exception 'conflict not found' using errcode = 'P0002'; end if;
  perform private.sync_connection_guard(_x.connection_id);
  if not private.can_manage_sync(_x.organization_id) then
    raise exception 'resolving conflicts requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  if _resolution not in ('resolved_keep_desktop','resolved_keep_external','resolved_manual','dismissed') then
    raise exception 'unknown conflict resolution' using errcode = '22023';
  end if;
  if _expected_version is distinct from _x.version then
    raise exception 'this conflict changed elsewhere since it was loaded' using errcode = '40001';
  end if;
  if _x.state <> 'open' then
    return jsonb_build_object('ok', true, 'alreadyApplied', true, 'state', _x.state,
      'message', 'This conflict was already resolved.');
  end if;
  if coalesce(btrim(_note),'') = '' then
    raise exception 'conflict resolution requires a note' using errcode = '22023';
  end if;

  -- Resolution NEVER mutates the original records on either side; it decides
  -- which version future synchronization proceeds from.
  update public.sync_conflicts
  set state = _resolution, resolution_note = left(btrim(_note), 500),
      resolved_by = _uid, resolved_at = now(), version = version + 1
  where id = _x.id;
  if _x.inbound_event_id is not null then
    update public.sync_inbound_events
    set state = case when _resolution = 'dismissed' then 'rejected' else 'processed' end,
        rejection_reason_safe = case when _resolution = 'dismissed' then 'conflict dismissed' end,
        processed_at = now(), reviewed_by = _uid, reviewed_at = now(),
        review_note = left(btrim(_note), 500)
    where id = _x.inbound_event_id and state = 'conflict';
  end if;
  update public.review_queue_items
  set status = 'resolved', updated_at = now(), updated_by = _uid
  where item_type = 'sync_review' and ref_id = _x.id and status in ('open','in_review');

  perform private.log_sync_event(_x.organization_id, _x.connection_id, 'conflict_resolved',
    'open', _resolution, left(btrim(_note), 300), _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_x.organization_id, _uid, 'sync.conflict_resolved', 'sync_conflict',
    _x.id::text, 'Sync conflict resolved', _x.patient_id,
    jsonb_build_object('resolution', _resolution));
  return jsonb_build_object('ok', true, 'state', _resolution, 'message', 'Conflict resolved.');
end;
$$;

-- ---------------------------------------------------------- inbound review

create or replace function public.review_sync_inbound(
  _event_id uuid, _action text, _note text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e public.sync_inbound_events%rowtype; _uid uuid := auth.uid();
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _e from public.sync_inbound_events where id = _event_id for update;
  if not found then raise exception 'inbound event not found' using errcode = 'P0002'; end if;
  perform private.sync_connection_guard(_e.connection_id);
  if not private.can_manage_sync(_e.organization_id) then
    raise exception 'reviewing inbound data requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  if _action not in ('accept','reject') then
    raise exception 'unknown review action' using errcode = '22023';
  end if;
  if _e.state <> 'review_pending' then
    return jsonb_build_object('ok', true, 'alreadyApplied', true, 'state', _e.state,
      'message', 'This inbound event was already handled.');
  end if;
  if _action = 'reject' and coalesce(btrim(_note),'') = '' then
    raise exception 'rejecting inbound data requires a note' using errcode = '22023';
  end if;

  update public.sync_inbound_events
  set state = case when _action = 'accept' then 'processed' else 'rejected' end,
      rejection_reason_safe = case when _action = 'reject' then left(btrim(_note), 300) end,
      processed_at = now(), reviewed_by = _uid, reviewed_at = now(),
      review_note = left(btrim(coalesce(_note,'')), 500)
  where id = _e.id;
  update public.review_queue_items
  set status = 'resolved', updated_at = now(), updated_by = _uid
  where item_type = 'sync_review' and ref_id = _e.id and status in ('open','in_review');

  perform private.log_sync_event(_e.organization_id, _e.connection_id, 'inbound_reviewed',
    _e.resource_type, _action, left(btrim(coalesce(_note,'')), 300), _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_e.organization_id, _uid, 'sync.inbound_' || _action || 'ed', 'sync_inbound_event',
    _e.id::text, 'Inbound sync data ' || _action || 'ed', _e.patient_id,
    jsonb_build_object('resourceType', _e.resource_type));
  return jsonb_build_object('ok', true,
    'state', case when _action = 'accept' then 'processed' else 'rejected' end,
    'message', case when _action = 'accept' then 'Accepted.' else 'Rejected.' end);
end;
$$;

create or replace function public.record_sync_inbound_correction(
  _inbound_event_id uuid, _overlay jsonb, _reason text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e public.sync_inbound_events%rowtype; _uid uuid; _v integer;
begin
  select * into _e from public.sync_inbound_events where id = _inbound_event_id;
  if not found then raise exception 'inbound event not found' using errcode = 'P0002'; end if;
  perform private.sync_connection_guard(_e.connection_id);
  -- Correcting patient-submitted clinical data is a clinical act.
  _uid := private.require_clinical_actor(_e.organization_id, _e.patient_id);
  if coalesce(btrim(_reason),'') = '' then
    raise exception 'a correction requires a reason' using errcode = '22023';
  end if;
  if _overlay is null or jsonb_typeof(_overlay) <> 'object' or _overlay = '{}'::jsonb then
    raise exception 'a correction overlay must be a non-empty object' using errcode = '22023';
  end if;
  if length(_overlay::text) > 16384 then
    raise exception 'correction overlay too large' using errcode = '22023';
  end if;

  select coalesce(max(version), 0) + 1 into _v
  from public.sync_inbound_corrections where inbound_event_id = _e.id;
  insert into public.sync_inbound_corrections
    (organization_id, inbound_event_id, version, overlay, reason, created_by)
  values (_e.organization_id, _e.id, _v, _overlay, btrim(_reason), _uid);

  perform private.log_sync_event(_e.organization_id, _e.connection_id, 'inbound_corrected',
    _e.id::text, 'v' || _v, left(btrim(_reason), 300), _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_e.organization_id, _uid, 'sync.inbound_corrected', 'sync_inbound_event',
    _e.id::text, 'Correction overlay recorded over an inbound submission', _e.patient_id,
    jsonb_build_object('version', _v));
  return jsonb_build_object('ok', true, 'version', _v,
    'message', 'Correction recorded as an overlay. The original submission is unchanged.');
end;
$$;

-- --------------------------------------------------------- org operations

create or replace function public.get_org_sync_operations(_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'providerConfigured', private.sync_provider_configured(_organization_id) is not null,
    'provider', private.sync_provider_configured(_organization_id),
    'contractVersions', coalesce((select jsonb_agg(distinct c.contract_version)
      from public.patient_app_connections c
      where c.organization_id = _organization_id), '[]'::jsonb),
    'connections', jsonb_build_object(
      'verified', (select count(*) from public.patient_app_connections c
        where c.organization_id = _organization_id and c.state = 'verified'),
      'invitationPending', (select count(*) from public.patient_app_connections c
        where c.organization_id = _organization_id and c.state = 'invitation_pending'),
      'paused', (select count(*) from public.patient_app_connections c
        where c.organization_id = _organization_id and c.state = 'paused'),
      'revoked', (select count(*) from public.patient_app_connections c
        where c.organization_id = _organization_id and c.state = 'revoked')),
    'outbound', jsonb_build_object(
      'queued', (select count(*) from public.sync_outbound_events e
        where e.organization_id = _organization_id and e.state in ('queued','sending')),
      'failed', (select count(*) from public.sync_outbound_events e
        where e.organization_id = _organization_id and e.state = 'failed'),
      'deadLetter', (select count(*) from public.sync_outbound_events e
        where e.organization_id = _organization_id and e.state = 'dead_letter'),
      'delivered', (select count(*) from public.sync_outbound_events e
        where e.organization_id = _organization_id and e.state in ('delivered','acknowledged'))),
    'inbound', jsonb_build_object(
      'pendingReview', (select count(*) from public.sync_inbound_events e
        where e.organization_id = _organization_id and e.state = 'review_pending'),
      'processed', (select count(*) from public.sync_inbound_events e
        where e.organization_id = _organization_id and e.state = 'processed'),
      'conflicts', (select count(*) from public.sync_conflicts x
        where x.organization_id = _organization_id and x.state = 'open')),
    'deadLetters', coalesce((select jsonb_agg(jsonb_build_object(
        'eventId', d.outbound_event_id, 'reason', d.reason_safe,
        'enteredAt', d.entered_at, 'retriedAt', d.retried_at)
        order by d.entered_at desc)
      from (select * from public.sync_dead_letters dd
            where dd.organization_id = _organization_id
            order by dd.entered_at desc limit 20) d), '[]'::jsonb),
    'generatedAt', now());
end;
$$;

-- ==================================================== WORKER BOUNDARY ====
-- service_role ONLY. This is where provider evidence enters the system —
-- the future sync worker verifies the provider's signature and replay window
-- BEFORE calling these, and passes the key id used so evidence is traceable.

create or replace function public.verify_sync_invitation(
  _token text, _external_subject_id text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _i public.patient_sync_invitations%rowtype;
        _c public.patient_app_connections%rowtype;
begin
  if coalesce(btrim(_token),'') = '' or coalesce(btrim(_external_subject_id),'') = '' then
    raise exception 'token and external subject are required' using errcode = '22023';
  end if;
  select * into _i from public.patient_sync_invitations
  where token_hash = private.sha256_hex(btrim(_token))
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
  -- The unique (external_system, external_subject_id) index refuses a subject
  -- already bound to another live connection (forgery/reuse) as 23505.
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

create or replace function public.claim_sync_outbound(
  _organization_id uuid, _limit integer default 20
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _rows jsonb;
begin
  -- Even the worker cannot claim without an approved provider registration.
  if private.sync_provider_configured(_organization_id) is null then
    raise exception 'AI Longevity Pro connection not configured' using errcode = '22023';
  end if;

  with claimable as (
    select e.id from public.sync_outbound_events e
    join public.patient_app_connections c on c.id = e.connection_id
    where e.organization_id = _organization_id
      and e.state = 'queued'
      and (e.next_retry_at is null or e.next_retry_at <= now())
      and c.state = 'verified'
      and exists (select 1 from public.sync_consent_scopes s
                  where s.connection_id = c.id and s.scope = e.scope
                    and s.status = 'granted')
    order by e.created_at
    limit least(greatest(coalesce(_limit, 20), 1), 100)
    for update of e skip locked
  ), claimed as (
    update public.sync_outbound_events e
    set state = 'sending', attempts = e.attempts + 1, updated_at = now()
    from claimable
    where e.id = claimable.id
    returning e.*
  ), attempts as (
    insert into public.sync_delivery_attempts
      (organization_id, outbound_event_id, attempt_no, outcome)
    select organization_id, id, attempts, 'sent' from claimed
    returning outbound_event_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'eventId', id, 'eventUid', event_uid, 'contractVersion', contract_version,
      'connectionId', connection_id, 'idempotencyKey', idempotency_key,
      'scope', scope, 'resourceType', resource_type, 'resourceId', resource_id,
      'resourceVersion', resource_version, 'occurredAt', occurred_at,
      'producer', producer, 'provenance', provenance,
      'payload', payload, 'payloadHash', payload_hash,
      'correlationId', correlation_id, 'attempts', attempts)), '[]'::jsonb)
  into _rows from claimed;
  return jsonb_build_object('ok', true, 'events', _rows);
end;
$$;

create or replace function public.record_sync_delivery(
  _event_uid uuid, _provider_event_id text, _kind text,
  _occurred_at timestamptz, _error_safe text default null,
  _signature_key_id text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e public.sync_outbound_events%rowtype; _dead boolean := false;
begin
  if _kind not in ('delivered','acknowledged','failed','rejected') then
    raise exception 'unknown delivery kind' using errcode = '22023';
  end if;
  if coalesce(btrim(_provider_event_id),'') = '' then
    raise exception 'provider evidence requires a provider event id' using errcode = '22023';
  end if;
  if _occurred_at is null or _occurred_at > now() + interval '5 minutes' then
    raise exception 'delivery evidence timestamp outside the accepted window' using errcode = '22023';
  end if;
  select * into _e from public.sync_outbound_events where event_uid = _event_uid for update;
  if not found then raise exception 'sync event not found' using errcode = 'P0002'; end if;

  -- Duplicate callbacks dedupe on (connection, provider_event_id).
  begin
    insert into public.sync_delivery_events
      (organization_id, connection_id, outbound_event_id, provider_event_id,
       kind, occurred_at, signature_key_id, error_safe)
    values (_e.organization_id, _e.connection_id, _e.id, btrim(_provider_event_id),
       _kind, _occurred_at, _signature_key_id, left(coalesce(_error_safe,''), 300));
  exception when unique_violation then
    return jsonb_build_object('ok', true, 'duplicate', true, 'state', _e.state);
  end;

  if _kind = 'delivered' then
    -- Forward-only: a late 'delivered' never demotes an acknowledgment.
    if _e.state in ('queued','sending','failed') then
      update public.sync_outbound_events
      set state = 'delivered', delivered_at = coalesce(delivered_at, _occurred_at),
          last_error_safe = null, next_retry_at = null, updated_at = now()
      where id = _e.id;
      update public.sync_resource_acks
      set state = case when state = 'withdrawn' then state else 'delivered' end,
          updated_at = now()
      where connection_id = _e.connection_id and resource_type = _e.resource_type
        and resource_id = _e.resource_id and last_outbound_event_id = _e.id;
    end if;
  elsif _kind = 'acknowledged' then
    if _e.state in ('queued','sending','failed','delivered') then
      update public.sync_outbound_events
      set state = 'acknowledged',
          delivered_at = coalesce(delivered_at, _occurred_at),
          acknowledged_at = _occurred_at,
          ack_provider_event_id = btrim(_provider_event_id),
          last_error_safe = null, next_retry_at = null, updated_at = now()
      where id = _e.id;
      update public.sync_resource_acks
      set state = case when state = 'withdrawn' then state else 'acknowledged' end,
          acknowledged_at = _occurred_at, updated_at = now()
      where connection_id = _e.connection_id and resource_type = _e.resource_type
        and resource_id = _e.resource_id and last_outbound_event_id = _e.id;
    end if;
  else
    -- failed / rejected
    if _e.state in ('delivered','acknowledged') then
      -- Out-of-order stale failure after success: evidence recorded, state kept.
      return jsonb_build_object('ok', true, 'staleEvidence', true, 'state', _e.state);
    end if;
    -- The failure evidence itself lives in sync_delivery_events (inserted
    -- above); the attempt trail comes from claims.
    if _e.attempts >= 8 or _kind = 'rejected' then
      _dead := true;
      update public.sync_outbound_events
      set state = 'dead_letter', last_error_safe = left(coalesce(_error_safe,'delivery failed'), 300),
          next_retry_at = null, updated_at = now()
      where id = _e.id;
      insert into public.sync_dead_letters (organization_id, outbound_event_id, reason_safe)
      values (_e.organization_id, _e.id,
        left(coalesce(_error_safe, 'delivery failed after ' || _e.attempts || ' attempts'), 300))
      on conflict (outbound_event_id) do nothing;
      perform private.sync_review_task(_e.organization_id, _e.patient_id, _e.id,
        'Sync delivery dead-lettered: ' || _e.resource_type, 'high');
    else
      update public.sync_outbound_events
      set state = 'failed', last_error_safe = left(coalesce(_error_safe,'delivery failed'), 300),
          next_retry_at = private.sync_backoff(_e.attempts), updated_at = now()
      where id = _e.id;
    end if;
    update public.sync_resource_acks
    set state = case when state in ('acknowledged','withdrawn') then state else 'failed' end,
        updated_at = now()
    where connection_id = _e.connection_id and resource_type = _e.resource_type
      and resource_id = _e.resource_id and last_outbound_event_id = _e.id;
  end if;

  perform private.log_sync_event(_e.organization_id, _e.connection_id,
    'delivery_' || _kind, _e.state,
    case when _dead then 'dead_letter' else null end,
    left(coalesce(_error_safe,''), 300), null);
  return jsonb_build_object('ok', true, 'duplicate', false,
    'state', (select state from public.sync_outbound_events where id = _e.id),
    'deadLettered', _dead);
end;
$$;

create or replace function public.record_sync_inbound(
  _connection_id uuid, _provider_event_id text, _contract_version text,
  _resource_type text, _payload jsonb, _payload_hash text,
  _occurred_at timestamptz, _external_resource_id text default null,
  _resource_version text default null, _signature_key_id text default null,
  _correlation_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.patient_app_connections%rowtype; _scope text; _eid uuid;
        _state text := 'processed'; _urgent text[]; _conflict_id uuid;
        _target public.sync_outbound_events%rowtype;
begin
  select * into _c from public.patient_app_connections where id = _connection_id;
  if not found then raise exception 'connection not found' using errcode = 'P0002'; end if;
  if _c.state = 'revoked' then
    raise exception 'this connection is revoked; inbound writes are blocked' using errcode = '42501';
  end if;
  if _c.state = 'paused' then
    raise exception 'this connection is paused; inbound writes are held' using errcode = '22023';
  end if;
  if _c.state <> 'verified' then
    raise exception 'inbound data requires a verified connection' using errcode = '42501';
  end if;
  if _contract_version <> 'patient-sync/1' then
    raise exception 'unsupported contract version %', _contract_version using errcode = '22023';
  end if;
  if coalesce(btrim(_provider_event_id),'') = '' then
    raise exception 'a provider event id is required' using errcode = '22023';
  end if;
  if _occurred_at is null or _occurred_at > now() + interval '5 minutes' then
    raise exception 'inbound timestamp outside the accepted window' using errcode = '22023';
  end if;
  if _payload is null or length(_payload::text) > 65536 then
    raise exception 'payload missing or exceeds the size limit' using errcode = '22023';
  end if;
  if private.sha256_hex(_payload::text) is distinct from _payload_hash then
    raise exception 'payload hash mismatch; submission refused' using errcode = '22023';
  end if;

  -- Scope + consent. Receipts route by their target event; consent changes
  -- are about consent itself (a revocation is always accepted).
  if _resource_type in ('delivery_receipt','read_receipt') then
    select * into _target from public.sync_outbound_events
    where event_uid = nullif(_payload->>'eventUid','')::uuid
      and connection_id = _c.id;
    if not found then
      raise exception 'receipt does not reference an outbound event of this connection'
        using errcode = 'P0002';
    end if;
    _scope := _target.scope;
  elsif _resource_type = 'consent_change' then
    _scope := coalesce(_payload->>'scope','');
    if not private.sync_scope_valid(_scope) then
      raise exception 'unknown consent scope in consent change' using errcode = '22023';
    end if;
  else
    _scope := private.sync_inbound_scope_for(_resource_type);
    if _scope is null then
      raise exception 'unknown inbound resource type' using errcode = '22023';
    end if;
    if not exists (select 1 from public.sync_consent_scopes s
                   where s.connection_id = _c.id and s.scope = _scope
                     and s.status = 'granted') then
      perform private.log_sync_event(_c.organization_id, _c.id, 'inbound_refused_consent',
        _resource_type, _scope, null, null);
      raise exception 'consent for the % scope is not granted; inbound data refused', _scope
        using errcode = '42501';
    end if;
  end if;

  -- Idempotency + replay refusal.
  begin
    insert into public.sync_inbound_events
      (organization_id, connection_id, patient_id, contract_version,
       provider_event_id, idempotency_key, scope, resource_type,
       external_resource_id, resource_version, occurred_at, payload,
       payload_hash, signature_key_id, correlation_id)
    values (_c.organization_id, _c.id, _c.patient_id, _contract_version,
       btrim(_provider_event_id),
       _c.id::text || ':in:' || btrim(_provider_event_id),
       _scope, _resource_type, _external_resource_id, _resource_version,
       _occurred_at, _payload, _payload_hash, _signature_key_id, _correlation_id)
    returning id into _eid;
  exception when unique_violation then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end;

  -- Classify. Patient-app data is the AUTHORITATIVE original for patient
  -- submissions; clinically-relevant kinds route to human review; receipts
  -- project onto the outbound event; a consent revocation applies NOW.
  if _resource_type in ('delivery_receipt','read_receipt') then
    perform public.record_sync_delivery(_target.event_uid,
      btrim(_provider_event_id) || ':receipt',
      case when _resource_type = 'delivery_receipt' then 'delivered' else 'acknowledged' end,
      _occurred_at, null, _signature_key_id);
  elsif _resource_type = 'consent_change' then
    if _payload->>'action' = 'revoke' then
      update public.sync_consent_scopes
      set status = 'revoked', revoked_at = now(), revoked_by = null,
          revoke_source = 'patient_app', updated_at = now()
      where connection_id = _c.id and scope = _scope and status = 'granted';
      update public.sync_outbound_events
      set state = 'cancelled', updated_at = now(), last_error_safe = 'consent revoked by patient'
      where connection_id = _c.id and scope = _scope and state in ('queued','sending','failed');
      perform private.log_sync_event(_c.organization_id, _c.id, 'scope_revoked',
        _scope, null, 'patient app revocation', null);
    else
      -- A grant claim from the app needs practitioner confirmation.
      _state := 'review_pending';
    end if;
  elsif _resource_type in ('patient_message','appointment_request','symptom_report') then
    _state := 'review_pending';
  else
    -- Telemetry kinds: out-of-order/stale versions become explicit conflicts,
    -- never silent overwrites of a newer submission.
    if _resource_version is not null and _external_resource_id is not null
       and exists (select 1 from public.sync_inbound_events p
                   where p.connection_id = _c.id and p.resource_type = _resource_type
                     and p.external_resource_id = _external_resource_id
                     and p.id <> _eid
                     and p.resource_version >= _resource_version) then
      _state := 'conflict';
      insert into public.sync_conflicts
        (organization_id, connection_id, patient_id, scope, resource_type,
         resource_ref, inbound_event_id, external_version, reason_safe)
      values (_c.organization_id, _c.id, _c.patient_id, _scope, _resource_type,
         _external_resource_id, _eid, _resource_version,
         'stale or out-of-order submission version; newer data already recorded')
      returning id into _conflict_id;
      perform private.sync_review_task(_c.organization_id, _c.patient_id, _conflict_id,
        'Sync conflict: ' || _resource_type, 'medium');
    end if;
  end if;

  -- Deterministic urgent-language invariant on free-text patient content.
  if _resource_type in ('patient_message','symptom_report','checkin_response') then
    _urgent := private.detect_urgent_language(_payload::text);
    if array_length(_urgent, 1) > 0 then
      _state := 'review_pending';
    end if;
  end if;

  update public.sync_inbound_events
  set state = _state,
      processed_at = case when _state = 'processed' then now() end
  where id = _eid;

  if _state = 'review_pending' then
    perform private.sync_review_task(_c.organization_id, _c.patient_id, _eid,
      'Review inbound ' || replace(_resource_type, '_', ' '),
      case when array_length(_urgent, 1) > 0 then 'high' else 'medium' end);
  end if;

  insert into public.sync_cursors as sc
    (organization_id, connection_id, direction, scope, position_at, last_event_id)
  values (_c.organization_id, _c.id, 'inbound', _scope, _occurred_at, _eid)
  on conflict (connection_id, direction, scope) do update
  set position_at = greatest(sc.position_at, excluded.position_at),
      last_event_id = excluded.last_event_id, updated_at = now();

  perform private.log_sync_event(_c.organization_id, _c.id, 'inbound_received',
    _resource_type, _state, null, null);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, null, 'sync.inbound_received', 'sync_inbound_event',
    _eid::text, 'Inbound sync data received', _c.patient_id,
    jsonb_build_object('resourceType', _resource_type, 'state', _state));
  return jsonb_build_object('ok', true, 'duplicate', false, 'eventId', _eid,
    'state', _state, 'urgent', coalesce(array_length(_urgent, 1), 0) > 0);
end;
$$;

-- ------------------------------------------------------------------ grants

revoke all on function private.sync_scope_valid(text) from public, anon;
revoke all on function private.sync_provider_configured(uuid) from public, anon;
revoke all on function private.can_manage_sync(uuid) from public, anon;
revoke all on function private.sync_scope_for_resource(text) from public, anon;
revoke all on function private.sync_inbound_scope_for(text) from public, anon;
revoke all on function private.log_sync_event(uuid, uuid, text, text, text, text, uuid) from public, anon;
revoke all on function private.sync_backoff(integer) from public, anon;
revoke all on function private.sync_connection_guard(uuid) from public, anon;
revoke all on function private.sync_review_task(uuid, uuid, uuid, text, text) from public, anon;

revoke all on function public.get_patient_sync_overview(uuid) from public, anon;
revoke all on function public.create_sync_invitation(uuid, uuid) from public, anon;
revoke all on function public.pause_sync_connection(uuid, integer) from public, anon;
revoke all on function public.resume_sync_connection(uuid, integer) from public, anon;
revoke all on function public.revoke_sync_connection(uuid, integer, text) from public, anon;
revoke all on function public.set_sync_consent_scope(uuid, text, boolean, text, text, text, text, text) from public, anon;
revoke all on function public.queue_sync_export(uuid, text, uuid, uuid) from public, anon;
revoke all on function public.withdraw_sync_resource(uuid, text, uuid, text) from public, anon;
revoke all on function public.retry_sync_event(uuid, text) from public, anon;
revoke all on function public.resolve_sync_conflict(uuid, text, text, integer) from public, anon;
revoke all on function public.review_sync_inbound(uuid, text, text) from public, anon;
revoke all on function public.record_sync_inbound_correction(uuid, jsonb, text) from public, anon;
revoke all on function public.get_org_sync_operations(uuid) from public, anon;
grant execute on function public.get_patient_sync_overview(uuid) to authenticated, service_role;
grant execute on function public.create_sync_invitation(uuid, uuid) to authenticated, service_role;
grant execute on function public.pause_sync_connection(uuid, integer) to authenticated, service_role;
grant execute on function public.resume_sync_connection(uuid, integer) to authenticated, service_role;
grant execute on function public.revoke_sync_connection(uuid, integer, text) to authenticated, service_role;
grant execute on function public.set_sync_consent_scope(uuid, text, boolean, text, text, text, text, text) to authenticated, service_role;
grant execute on function public.queue_sync_export(uuid, text, uuid, uuid) to authenticated, service_role;
grant execute on function public.withdraw_sync_resource(uuid, text, uuid, text) to authenticated, service_role;
grant execute on function public.retry_sync_event(uuid, text) to authenticated, service_role;
grant execute on function public.resolve_sync_conflict(uuid, text, text, integer) to authenticated, service_role;
grant execute on function public.review_sync_inbound(uuid, text, text) to authenticated, service_role;
grant execute on function public.record_sync_inbound_correction(uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.get_org_sync_operations(uuid) to authenticated, service_role;

-- Worker boundary: service_role ONLY (not authenticated, not anon).
revoke all on function public.verify_sync_invitation(text, text) from public, anon, authenticated;
revoke all on function public.claim_sync_outbound(uuid, integer) from public, anon, authenticated;
revoke all on function public.record_sync_delivery(uuid, text, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.record_sync_inbound(uuid, text, text, text, jsonb, text, timestamptz, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.verify_sync_invitation(text, text) to service_role;
grant execute on function public.claim_sync_outbound(uuid, integer) to service_role;
grant execute on function public.record_sync_delivery(uuid, text, text, timestamptz, text, text) to service_role;
grant execute on function public.record_sync_inbound(uuid, text, text, text, jsonb, text, timestamptz, text, text, text, uuid) to service_role;

commit;
