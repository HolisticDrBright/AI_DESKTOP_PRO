-- Phase 6B: the real ALP adapter projects the claimed envelope into the
-- patient-sync/1 WIRE DTO (PatientSyncOutboundEnvelopeV1). organizationId
-- and causationId are contract fields the previous projection omitted; the
-- adapter must emit them from the database, never fabricate them. ONLY the
-- event projection changes; claiming, leases, and reclaim are verbatim.

begin;

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
      'correlationId', correlation_id, 'causationId', causation_id,
      'organizationId', organization_id, 'attempts', attempts,
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

commit;
