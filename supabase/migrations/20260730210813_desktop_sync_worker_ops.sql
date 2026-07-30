-- Clinical Runtime Phase 6A: sync worker operations.
--
-- Operationalizes the phase-5 gateway for a durable, separately-run worker:
-- leased claims with safe reclaim, a consent/connection recheck immediately
-- before external delivery, PHI-free worker-cycle telemetry, persisted
-- circuit-breaker state, callback nonce replay protection, and a
-- reason-required practitioner cancel. State authority stays in PostgreSQL.

begin;

-- ------------------------------------------------------------ lease columns

alter table public.sync_outbound_events
  add column lease_id uuid,
  add column lease_expires_at timestamptz,
  add column claimed_at timestamptz;

-- Claim path: queued rows due for delivery, oldest first.
create index sync_outbound_events_claimable_idx
  on public.sync_outbound_events (organization_id, created_at)
  where state = 'queued';
-- Reclaim path: sending rows whose lease expired (worker died mid-flight).
create index sync_outbound_events_lease_idx
  on public.sync_outbound_events (organization_id, lease_expires_at)
  where state = 'sending';

-- --------------------------------------------------------- worker telemetry

-- PHI-free BY CONSTRUCTION: counts, states, classes, and ages only.
create table public.sync_worker_cycles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  provider text not null,
  contract_version text not null default 'patient-sync/1',
  worker_id uuid,
  started_at timestamptz not null,
  completed_at timestamptz not null default now(),
  claimed integer not null default 0,
  succeeded integer not null default 0,
  retried integer not null default 0,
  dead_lettered integer not null default 0,
  cancelled integer not null default 0,
  lease_reclaims integer not null default 0,
  circuit_state text not null default 'closed'
    check (circuit_state in ('closed','open','half_open')),
  error_class text,
  max_queue_age_seconds integer,
  created_at timestamptz not null default now()
);
create index sync_worker_cycles_org_idx
  on public.sync_worker_cycles (organization_id, completed_at desc);

create table public.sync_circuit_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  provider text not null,
  state text not null default 'closed' check (state in ('closed','open','half_open')),
  failure_count integer not null default 0,
  opened_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

-- Callback replay protection at the HTTP boundary (worker-owned).
create table public.sync_callback_nonces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  provider text not null,
  nonce text not null,
  seen_at timestamptz not null default now(),
  unique (provider, nonce)
);
create index sync_callback_nonces_seen_idx on public.sync_callback_nonces (seen_at);
create index sync_callback_nonces_org_idx on public.sync_callback_nonces (organization_id);

alter table public.sync_worker_cycles enable row level security;
alter table public.sync_circuit_states enable row level security;
alter table public.sync_callback_nonces enable row level security;
-- Telemetry and circuit posture are PHI-free and org-readable; nonces are not
-- readable by clients at all.
create policy sync_worker_cycles_select on public.sync_worker_cycles
  for select to authenticated using (private.is_org_member(organization_id));
create policy sync_circuit_states_select on public.sync_circuit_states
  for select to authenticated using (private.is_org_member(organization_id));
revoke all on public.sync_worker_cycles from anon, public;
revoke all on public.sync_circuit_states from anon, public;
revoke all on public.sync_callback_nonces from anon, public, authenticated;
grant select on public.sync_worker_cycles to authenticated;
grant select on public.sync_circuit_states to authenticated;
revoke insert, update, delete on public.sync_worker_cycles from authenticated;
revoke insert, update, delete on public.sync_circuit_states from authenticated;

-- ------------------------------------------------------------ provider posture

-- 'approved' = alp_patient_sync; 'fixture' = the deterministic contract-test
-- provider (test infrastructure ONLY — the worker refuses to run it in any
-- deployed environment); 'disabled' = neither.
create or replace function private.sync_provider_posture(_organization_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select case
    when exists (select 1 from public.connectors c
      where c.organization_id = _organization_id
        and c.provider = 'alp_patient_sync' and c.sync_status = 'connected')
      then 'approved'
    when exists (select 1 from public.connectors c
      where c.organization_id = _organization_id
        and c.provider = 'sync_contract_fixture' and c.sync_status = 'connected')
      then 'fixture'
    else 'disabled'
  end;
$$;

create or replace function private.sync_provider_configured(_organization_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select c.provider
  from public.connectors c
  where c.organization_id = _organization_id
    and c.provider in ('alp_patient_sync','sync_contract_fixture')
    and c.sync_status = 'connected'
  order by case c.provider when 'alp_patient_sync' then 0 else 1 end
  limit 1;
$$;

-- ------------------------------------------------- lease-aware claim (worker)

drop function public.claim_sync_outbound(uuid, integer);

create or replace function public.claim_sync_outbound(
  _organization_id uuid, _limit integer default 20,
  _lease_seconds integer default 120, _worker_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _rows jsonb; _lease uuid := gen_random_uuid(); _reclaims integer;
begin
  if private.sync_provider_configured(_organization_id) is null then
    raise exception 'no synchronization provider is configured' using errcode = '22023';
  end if;
  if _lease_seconds < 10 or _lease_seconds > 3600 then
    raise exception 'lease must be between 10s and 1h' using errcode = '22023';
  end if;

  -- Reclaim: sending rows whose lease expired (a worker died mid-flight).
  -- Reclaimed work counts as a fresh attempt; nothing is lost or duplicated —
  -- provider-side idempotency keys make redelivery safe.
  with expired as (
    select e.id from public.sync_outbound_events e
    where e.organization_id = _organization_id
      and e.state = 'sending' and e.lease_expires_at < now()
    order by e.lease_expires_at
    limit least(greatest(coalesce(_limit, 20), 1), 100)
    for update of e skip locked
  ), reclaimed as (
    update public.sync_outbound_events e
    set state = 'queued', lease_id = null, lease_expires_at = null,
        next_retry_at = now(), updated_at = now()
    from expired where e.id = expired.id
    returning e.id
  )
  select count(*) into _reclaims from reclaimed;

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
    set state = 'sending', attempts = e.attempts + 1,
        lease_id = _lease, lease_expires_at = now() + make_interval(secs => _lease_seconds),
        claimed_at = now(), updated_at = now()
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
      'correlationId', correlation_id, 'attempts', attempts,
      'leaseExpiresAt', lease_expires_at)), '[]'::jsonb)
  into _rows from claimed;
  return jsonb_build_object('ok', true, 'leaseId', _lease,
    'leaseReclaims', coalesce(_reclaims, 0),
    'maxQueueAgeSeconds', coalesce((
      select extract(epoch from now() - min(e.created_at))::integer
      from public.sync_outbound_events e
      where e.organization_id = _organization_id and e.state = 'queued'), 0),
    'events', _rows);
end;
$$;

-- ------------------------------------- consent recheck at delivery time

-- The worker calls this IMMEDIATELY before handing an envelope to the
-- provider — consent, connection state, and supersession are re-validated at
-- delivery time, not only when the envelope was created. A refusal here is
-- durable: the event is cancelled with an attempt-trail entry, never retried.
create or replace function public.recheck_sync_export(_event_uid uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e public.sync_outbound_events%rowtype;
        _c public.patient_app_connections%rowtype; _reason text;
begin
  select * into _e from public.sync_outbound_events where event_uid = _event_uid for update;
  if not found then raise exception 'sync event not found' using errcode = 'P0002'; end if;
  if _e.state <> 'sending' then
    return jsonb_build_object('deliverable', false, 'reason', 'not_claimed', 'state', _e.state);
  end if;
  select * into _c from public.patient_app_connections where id = _e.connection_id;

  if _c.state <> 'verified' then
    _reason := 'refused_revoked';
  elsif not exists (select 1 from public.sync_consent_scopes s
                    where s.connection_id = _c.id and s.scope = _e.scope
                      and s.status = 'granted') then
    _reason := 'refused_consent';
  elsif exists (select 1 from public.sync_outbound_events n
                where n.connection_id = _e.connection_id
                  and n.resource_type = _e.resource_type
                  and n.resource_id = _e.resource_id
                  and n.id <> _e.id
                  and n.created_at > _e.created_at
                  and n.state <> 'cancelled') then
    _reason := 'superseded';
  end if;

  if _reason is null then
    return jsonb_build_object('deliverable', true);
  end if;

  update public.sync_outbound_events
  set state = case when _reason = 'superseded' then 'superseded' else 'cancelled' end,
      last_error_safe = case _reason
        when 'refused_consent' then 'consent revoked before delivery'
        when 'refused_revoked' then 'connection no longer verified'
        else 'superseded before delivery' end,
      lease_id = null, lease_expires_at = null, next_retry_at = null, updated_at = now()
  where id = _e.id;
  insert into public.sync_delivery_attempts
    (organization_id, outbound_event_id, attempt_no, outcome)
  values (_e.organization_id, _e.id, _e.attempts,
    case when _reason = 'superseded' then 'provider_error' else _reason end)
  on conflict (outbound_event_id, attempt_no) do nothing;
  perform private.log_sync_event(_e.organization_id, _e.connection_id,
    'delivery_recheck_refused', _e.resource_type, _reason, null, null);
  return jsonb_build_object('deliverable', false, 'reason', _reason);
end;
$$;

-- --------------------------------------------------- worker cycle + circuit

create or replace function public.record_sync_worker_cycle(
  _organization_id uuid, _provider text, _started_at timestamptz,
  _claimed integer, _succeeded integer, _retried integer,
  _dead_lettered integer, _cancelled integer, _lease_reclaims integer,
  _circuit_state text, _error_class text default null,
  _max_queue_age_seconds integer default null, _worker_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _cid uuid;
begin
  if _circuit_state not in ('closed','open','half_open') then
    raise exception 'unknown circuit state' using errcode = '22023';
  end if;
  insert into public.sync_worker_cycles
    (organization_id, provider, worker_id, started_at, claimed, succeeded,
     retried, dead_lettered, cancelled, lease_reclaims, circuit_state,
     error_class, max_queue_age_seconds)
  values (_organization_id, _provider, _worker_id, _started_at,
     greatest(_claimed, 0), greatest(_succeeded, 0), greatest(_retried, 0),
     greatest(_dead_lettered, 0), greatest(_cancelled, 0),
     greatest(_lease_reclaims, 0), _circuit_state,
     left(coalesce(_error_class, ''), 100), _max_queue_age_seconds)
  returning id into _cid;
  insert into public.sync_circuit_states as cs
    (organization_id, provider, state, failure_count,
     opened_at, updated_at)
  values (_organization_id, _provider, _circuit_state,
     case when _circuit_state = 'closed' then 0 else 1 end,
     case when _circuit_state = 'open' then now() end, now())
  on conflict (organization_id, provider) do update
  set state = excluded.state,
      failure_count = case when excluded.state = 'closed' then 0
                           else cs.failure_count + 1 end,
      opened_at = case when excluded.state = 'open'
                       then coalesce(cs.opened_at, now()) end,
      updated_at = now();
  return jsonb_build_object('ok', true, 'cycleId', _cid);
end;
$$;

create or replace function public.register_sync_callback_nonce(
  _organization_id uuid, _provider text, _nonce text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(btrim(_nonce),'') = '' then
    raise exception 'a nonce is required' using errcode = '22023';
  end if;
  begin
    insert into public.sync_callback_nonces (organization_id, provider, nonce)
    values (_organization_id, _provider, btrim(_nonce));
  exception when unique_violation then
    return jsonb_build_object('ok', true, 'replay', true);
  end;
  -- Opportunistic prune far outside any replay window.
  delete from public.sync_callback_nonces where seen_at < now() - interval '7 days';
  return jsonb_build_object('ok', true, 'replay', false);
end;
$$;

-- --------------------------------------------- reason-required cancel (caller)

create or replace function public.cancel_sync_event(
  _event_id uuid, _reason text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e public.sync_outbound_events%rowtype; _uid uuid := auth.uid();
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _e from public.sync_outbound_events where id = _event_id for update;
  if not found then raise exception 'sync event not found' using errcode = 'P0002'; end if;
  perform private.sync_connection_guard(_e.connection_id);
  if not private.can_manage_sync(_e.organization_id) then
    raise exception 'cancelling sync work requires an owner, admin, or practitioner role'
      using errcode = '42501';
  end if;
  if coalesce(btrim(_reason),'') = '' then
    raise exception 'cancelling requires a reason' using errcode = '22023';
  end if;
  if _e.state not in ('queued','failed','dead_letter') then
    raise exception 'only queued, failed, or dead-letter work can be cancelled; this one is %', _e.state
      using errcode = '22023';
  end if;
  update public.sync_outbound_events
  set state = 'cancelled', last_error_safe = left(btrim(_reason), 300),
      lease_id = null, lease_expires_at = null, next_retry_at = null, updated_at = now()
  where id = _e.id;
  update public.sync_resource_acks
  set state = case when state in ('acknowledged','withdrawn') then state else 'failed' end,
      updated_at = now()
  where connection_id = _e.connection_id and resource_type = _e.resource_type
    and resource_id = _e.resource_id and last_outbound_event_id = _e.id;
  perform private.log_sync_event(_e.organization_id, _e.connection_id, 'cancelled_by_practitioner',
    _e.state, 'cancelled', left(btrim(_reason), 300), _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_e.organization_id, _uid, 'sync.event_cancelled', 'sync_outbound_event',
    _e.id::text, 'Sync event cancelled by practitioner', _e.patient_id,
    jsonb_build_object('fromState', _e.state));
  return jsonb_build_object('ok', true, 'state', 'cancelled', 'message', 'Cancelled.');
end;
$$;

-- ----------------------------------------- org operations: posture + worker

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
    'posture', private.sync_provider_posture(_organization_id),
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
        where e.organization_id = _organization_id and e.state = 'queued'),
      'sending', (select count(*) from public.sync_outbound_events e
        where e.organization_id = _organization_id and e.state = 'sending'),
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
    'maxQueueAgeSeconds', coalesce((
      select extract(epoch from now() - min(e.created_at))::integer
      from public.sync_outbound_events e
      where e.organization_id = _organization_id and e.state = 'queued'), 0),
    'lastWorkerCycle', (select jsonb_build_object(
        'provider', w.provider, 'contractVersion', w.contract_version,
        'startedAt', w.started_at, 'completedAt', w.completed_at,
        'claimed', w.claimed, 'succeeded', w.succeeded, 'retried', w.retried,
        'deadLettered', w.dead_lettered, 'cancelled', w.cancelled,
        'leaseReclaims', w.lease_reclaims, 'circuitState', w.circuit_state,
        'errorClass', nullif(w.error_class, ''),
        'maxQueueAgeSeconds', w.max_queue_age_seconds)
      from public.sync_worker_cycles w
      where w.organization_id = _organization_id
      order by w.completed_at desc limit 1),
    'circuit', (select jsonb_build_object(
        'provider', cs.provider, 'state', cs.state,
        'failureCount', cs.failure_count, 'openedAt', cs.opened_at,
        'updatedAt', cs.updated_at)
      from public.sync_circuit_states cs
      where cs.organization_id = _organization_id
      order by cs.updated_at desc limit 1),
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

-- ------------------------------------------------------------------- grants

revoke all on function private.sync_provider_posture(uuid) from public, anon;

revoke all on function public.claim_sync_outbound(uuid, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.recheck_sync_export(uuid) from public, anon, authenticated;
revoke all on function public.record_sync_worker_cycle(uuid, text, timestamptz, integer, integer, integer, integer, integer, integer, text, text, integer, uuid) from public, anon, authenticated;
revoke all on function public.register_sync_callback_nonce(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_sync_outbound(uuid, integer, integer, uuid) to service_role;
grant execute on function public.recheck_sync_export(uuid) to service_role;
grant execute on function public.record_sync_worker_cycle(uuid, text, timestamptz, integer, integer, integer, integer, integer, integer, text, text, integer, uuid) to service_role;
grant execute on function public.register_sync_callback_nonce(uuid, text, text) to service_role;

revoke all on function public.cancel_sync_event(uuid, text) from public, anon;
grant execute on function public.cancel_sync_event(uuid, text) to authenticated, service_role;

commit;
