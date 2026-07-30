-- Phase 6A follow-up: an explicit practitioner re-share after a cancelled or
-- superseded envelope must be possible. Previously the unique idempotency key
-- of the dead envelope blocked the same resource version forever. Now a
-- re-share after cancellation/supersession mints a NEW envelope generation
-- (key suffixed ':rN'); a live envelope (queued/sending/failed/delivered/
-- acknowledged/dead_letter) still answers alreadyQueued — nothing resends
-- silently. ONLY the idempotency block changes; everything else is verbatim.

begin;

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
  if private.sync_provider_configured(_c.organization_id) is null then
    perform private.log_sync_event(_c.organization_id, _c.id, 'export_refused',
      _resource_type, _resource_id::text, 'AI Longevity Pro connection not configured', _uid);
    return jsonb_build_object('ok', false, 'refusal', 'provider_not_configured',
      'message', 'AI Longevity Pro connection not configured. Nothing was queued or sent.');
  end if;

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
  if found and _e.state not in ('cancelled','superseded') then
    return jsonb_build_object('ok', true, 'alreadyQueued', true, 'eventId', _e.id,
      'state', _e.state, 'message', 'This resource version is already in the sync queue.');
  elsif found then
    -- Explicit re-share after cancellation/supersession: a NEW envelope
    -- generation with its own idempotency key. Never a silent resend —
    -- this path only runs from a fresh practitioner action.
    _key := _key || ':r' || (
      select count(*) from public.sync_outbound_events
      where connection_id = _c.id and resource_type = _resource_type
        and resource_id = _resource_id);
  end if;

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

commit;