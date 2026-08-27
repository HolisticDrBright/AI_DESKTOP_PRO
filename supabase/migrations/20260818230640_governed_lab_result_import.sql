-- Governed AI Longevity Pro -> Desktop lab-result import.
-- Separate consent, signed service-only ingress, deterministic replay
-- protection, immutable provenance, and clinician-gated chart materialization.
begin;

create or replace function private.sync_scope_valid(_scope text)
returns boolean language sql immutable security definer set search_path = ''
as $$
  select _scope in ('programs','protocols_supplements','nutrition','appointments',
    'messaging','forms_checkins','symptoms_adherence','wearables',
    'lab_summaries','lab_results_import','billing_links','research_n_of_1');
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
    when 'lab_result' then 'lab_results_import'
    when 'patient_message' then 'messaging'
    when 'appointment_request' then 'appointments'
    else null
  end;
$$;

alter table public.sync_inbound_events
  drop constraint if exists sync_inbound_events_resource_type_check;
alter table public.sync_inbound_events
  add constraint sync_inbound_events_resource_type_check check (resource_type in
    ('program_progress','quiz_response','checkin_response','protocol_adherence',
     'supplement_adherence','symptom_report','outcome_report','wearable_summary',
     'lab_result','patient_message','appointment_request','consent_change',
     'delivery_receipt','read_receipt'));

create unique index if not exists lab_documents_alp_source_uniq
  on public.lab_documents (organization_id, patient_id, source, source_record_id)
  where source = 'alp_patient_sync' and source_record_id is not null and deleted_at is null;
create unique index if not exists lab_panels_alp_source_uniq
  on public.lab_panels (organization_id, patient_id, source, source_record_id)
  where source = 'alp_patient_sync' and source_record_id is not null and deleted_at is null;
create unique index if not exists biomarker_observations_alp_source_uniq
  on public.biomarker_observations (organization_id, patient_id, source, source_record_id)
  where source = 'alp_patient_sync' and source_record_id is not null and deleted_at is null;

create or replace function public.record_sync_lab_result(
  _connection_id uuid, _provider_event_id text, _contract_version text,
  _resource_type text, _payload jsonb, _payload_hash text,
  _occurred_at timestamptz, _external_resource_id text default null,
  _resource_version text default null, _signature_key_id text default null,
  _correlation_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.patient_app_connections%rowtype; _eid uuid; _conflict_id uuid;
        _state text := 'review_pending'; _collected_at timestamptz;
begin
  select * into _c from public.patient_app_connections where id = _connection_id;
  if not found then raise exception 'connection not found' using errcode = 'P0002'; end if;
  if _c.state <> 'verified' then
    raise exception 'lab import requires a verified connection' using errcode = '42501';
  end if;
  if private.sync_provider_configured(_c.organization_id) is null then
    raise exception 'approved sync provider is not registered' using errcode = '42501';
  end if;
  if _contract_version <> 'patient-sync/1' or _resource_type <> 'lab_result' then
    raise exception 'unsupported lab import contract' using errcode = '22023';
  end if;
  if coalesce(btrim(_provider_event_id),'') = ''
     or coalesce(btrim(_external_resource_id),'') = ''
     or coalesce(btrim(_resource_version),'') = '' then
    raise exception 'lab import identity and version are required' using errcode = '22023';
  end if;
  if _occurred_at is null or _occurred_at > now() + interval '5 minutes' then
    raise exception 'inbound timestamp outside the accepted window' using errcode = '22023';
  end if;
  if _payload is null or jsonb_typeof(_payload) <> 'object' or length(_payload::text) > 16384
     or private.sha256_hex(_payload::text) is distinct from _payload_hash then
    raise exception 'invalid lab result payload or hash' using errcode = '22023';
  end if;
  if (_payload - array['schemaVersion','source','panel','result']) <> '{}'::jsonb
     or _payload->>'schemaVersion' <> 'lab-result/1'
     or jsonb_typeof(_payload->'source') <> 'object'
     or jsonb_typeof(_payload->'panel') <> 'object'
     or jsonb_typeof(_payload->'result') <> 'object'
     or jsonb_typeof(_payload#>'{result,referenceRange}') <> 'object'
     or (_payload->'source' - array['system','recordType','panelId','markerId','recordVersion']) <> '{}'::jsonb
     or (_payload->'panel' - array['name','collectedAt','sourceLabel']) <> '{}'::jsonb
     or (_payload->'result' - array['name','value','unit','sourceStatus','referenceRange']) <> '{}'::jsonb
     or (_payload#>'{result,referenceRange}' - array['min','max']) <> '{}'::jsonb
     or _payload#>>'{source,system}' <> 'ai_longevity_pro_v2'
     or _payload#>>'{source,recordType}' <> 'lab_panels'
     or _payload#>>'{source,recordVersion}' <> _resource_version
     or (_payload#>>'{source,panelId}') || ':' || (_payload#>>'{source,markerId}') <> _external_resource_id
     or jsonb_typeof(_payload#>'{result,value}') <> 'number'
     or coalesce(length(btrim(_payload#>>'{result,name}')),0) not between 1 and 200
     or coalesce(length(_payload#>>'{result,unit}'),0) > 80
     or coalesce(length(btrim(_payload#>>'{panel,name}')),0) not between 1 and 200
     or coalesce(length(_payload#>>'{panel,sourceLabel}'),0) > 200 then
    raise exception 'lab result payload does not match lab-result/1' using errcode = '22023';
  end if;
  begin
    _collected_at := (_payload#>>'{panel,collectedAt}')::timestamptz;
  exception when others then
    raise exception 'lab collection timestamp is invalid' using errcode = '22023';
  end;
  if _collected_at > now() + interval '1 day' then
    raise exception 'lab collection timestamp is in the future' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sync_consent_scopes s
                 where s.connection_id = _c.id and s.scope = 'lab_results_import'
                   and s.status = 'granted') then
    perform private.log_sync_event(_c.organization_id, _c.id, 'inbound_refused_consent',
      'lab_result', 'lab_results_import', null, null);
    raise exception 'lab results import consent is not granted' using errcode = '42501';
  end if;

  begin
    insert into public.sync_inbound_events
      (organization_id, connection_id, patient_id, contract_version,
       provider_event_id, idempotency_key, scope, resource_type,
       external_resource_id, resource_version, occurred_at, payload,
       payload_hash, signature_key_id, correlation_id, state)
    values (_c.organization_id, _c.id, _c.patient_id, _contract_version,
       btrim(_provider_event_id), _c.id::text || ':in:' || btrim(_provider_event_id),
       'lab_results_import', 'lab_result', _external_resource_id, _resource_version,
       _occurred_at, _payload, _payload_hash, _signature_key_id, _correlation_id,
       'review_pending')
    returning id into _eid;
  exception when unique_violation then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end;

  if exists (select 1 from public.sync_inbound_events p
             where p.connection_id = _c.id and p.resource_type = 'lab_result'
               and p.external_resource_id = _external_resource_id and p.id <> _eid
               and p.resource_version >= _resource_version) then
    _state := 'conflict';
    update public.sync_inbound_events set state = 'conflict' where id = _eid;
    insert into public.sync_conflicts
      (organization_id, connection_id, patient_id, scope, resource_type,
       resource_ref, inbound_event_id, external_version, reason_safe)
    values (_c.organization_id, _c.id, _c.patient_id, 'lab_results_import', 'lab_result',
       _external_resource_id, _eid, _resource_version,
       'stale or out-of-order lab result version; newer data already recorded')
    returning id into _conflict_id;
    perform private.sync_review_task(_c.organization_id, _c.patient_id, _conflict_id,
      'Sync conflict: imported lab result', 'medium');
  else
    perform private.sync_review_task(_c.organization_id, _c.patient_id, _eid,
      'Review imported lab result: ' || left(_payload#>>'{result,name}', 120), 'medium');
  end if;

  insert into public.sync_cursors as sc
    (organization_id, connection_id, direction, scope, position_at, last_event_id)
  values (_c.organization_id, _c.id, 'inbound', 'lab_results_import', _occurred_at, _eid)
  on conflict (connection_id, direction, scope) do update
  set position_at = greatest(sc.position_at, excluded.position_at),
      last_event_id = excluded.last_event_id, updated_at = now();

  perform private.log_sync_event(_c.organization_id, _c.id, 'inbound_received',
    'lab_result', _state, null, null);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, null, 'sync.inbound_received', 'sync_inbound_event',
    _eid::text, 'Inbound lab result received for review', _c.patient_id,
    jsonb_build_object('resourceType','lab_result','state',_state));
  return jsonb_build_object('ok', true, 'duplicate', false, 'eventId', _eid, 'state', _state);
end;
$$;

create or replace function private.materialize_sync_lab_result(_event_id uuid, _reviewer uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e public.sync_inbound_events%rowtype; _document_id uuid; _panel_id uuid;
        _observation_id uuid; _definition_id uuid; _inserted integer := 0;
        _panel_source_id text; _marker_name text; _source_status text;
        _range_low text; _range_high text; _reference_interval text;
begin
  select * into _e from public.sync_inbound_events where id = _event_id;
  if not found or _e.resource_type <> 'lab_result' then
    raise exception 'lab result event not found' using errcode = 'P0002';
  end if;
  perform private.require_clinical_actor(_e.organization_id, _e.patient_id);
  _panel_source_id := _e.payload#>>'{source,panelId}';
  _marker_name := _e.payload#>>'{result,name}';
  _source_status := lower(coalesce(_e.payload#>>'{result,sourceStatus}',''));
  _range_low := _e.payload#>>'{result,referenceRange,min}';
  _range_high := _e.payload#>>'{result,referenceRange,max}';
  _reference_interval := case when _range_low is not null or _range_high is not null
    then coalesce(_range_low,'') || '–' || coalesce(_range_high,'') else null end;

  insert into public.lab_documents
    (organization_id, patient_id, file_name, file_type, storage_path, lab_company,
     panel_name, lab_date, processing_status, source, source_record_id, created_by, updated_by)
  values (_e.organization_id, _e.patient_id,
    left(_e.payload#>>'{panel,name}',180) || ' (patient app import)', 'application/json',
    'sync://ai_longevity_pro_v2/lab_panels/' || _panel_source_id,
    left(_e.payload#>>'{panel,sourceLabel}',200), left(_e.payload#>>'{panel,name}',200),
    (_e.payload#>>'{panel,collectedAt}')::timestamptz::date, 'reviewed',
    'alp_patient_sync', _panel_source_id, _reviewer, _reviewer)
  on conflict (organization_id, patient_id, source, source_record_id)
    where source = 'alp_patient_sync' and source_record_id is not null and deleted_at is null
  do nothing;
  select id into _document_id from public.lab_documents
  where organization_id = _e.organization_id and patient_id = _e.patient_id
    and source = 'alp_patient_sync' and source_record_id = _panel_source_id and deleted_at is null;

  insert into public.lab_panels
    (organization_id, patient_id, lab_document_id, name, collected_at, reported_at,
     source, source_record_id, created_by, updated_by)
  values (_e.organization_id, _e.patient_id, _document_id,
    left(_e.payload#>>'{panel,name}',200), (_e.payload#>>'{panel,collectedAt}')::timestamptz,
    _e.occurred_at, 'alp_patient_sync', _panel_source_id, _reviewer, _reviewer)
  on conflict (organization_id, patient_id, source, source_record_id)
    where source = 'alp_patient_sync' and source_record_id is not null and deleted_at is null
  do nothing;
  select id into _panel_id from public.lab_panels
  where organization_id = _e.organization_id and patient_id = _e.patient_id
    and source = 'alp_patient_sync' and source_record_id = _panel_source_id and deleted_at is null;

  select d.id into _definition_id from public.biomarker_definitions d
  where lower(btrim(d.canonical_name)) = lower(btrim(_marker_name)) order by d.id limit 1;
  if _definition_id is null then
    select a.biomarker_definition_id into _definition_id
    from public.biomarker_aliases a where lower(btrim(a.alias)) = lower(btrim(_marker_name))
    order by a.id limit 1;
  end if;

  insert into public.biomarker_observations
    (organization_id, patient_id, biomarker_definition_id, lab_panel_id, lab_document_id,
     value_numeric, unit, status, original_name, original_value, original_unit,
     original_reference_interval, observed_at, data_quality, confidence, provenance,
     review_status, source, source_record_id, created_by, updated_by)
  values (_e.organization_id, _e.patient_id, _definition_id, _panel_id, _document_id,
    (_e.payload#>>'{result,value}')::numeric, nullif(_e.payload#>>'{result,unit}',''),
    case when _source_status in ('optimal','normal') then _source_status else null end,
    _marker_name, _e.payload#>>'{result,value}', nullif(_e.payload#>>'{result,unit}',''),
    _reference_interval, (_e.payload#>>'{panel,collectedAt}')::timestamptz,
    'patient_reported', null,
    jsonb_build_object('sourceSystem','ai_longevity_pro_v2','syncEventId',_e.id,
      'providerEventId',_e.provider_event_id,'signatureKeyId',_e.signature_key_id,
      'externalResourceId',_e.external_resource_id,'resourceVersion',_e.resource_version,
      'clinicianImportedBy',_reviewer,'clinicianImportedAt',now())::text,
    'unreviewed', 'alp_patient_sync', _e.external_resource_id, _reviewer, _reviewer)
  on conflict (organization_id, patient_id, source, source_record_id)
    where source = 'alp_patient_sync' and source_record_id is not null and deleted_at is null
  do nothing returning id into _observation_id;
  get diagnostics _inserted = row_count;

  if _inserted = 1 then
    insert into public.review_queue_items
      (organization_id, patient_id, item_type, ref_id, title, priority, status, created_by, updated_by)
    values (_e.organization_id, _e.patient_id, 'lab_extraction', _observation_id,
      'Review imported lab marker: ' || left(_marker_name,120), 'medium', 'open', _reviewer, _reviewer);
  else
    select id into _observation_id from public.biomarker_observations
    where organization_id = _e.organization_id and patient_id = _e.patient_id
      and source = 'alp_patient_sync' and source_record_id = _e.external_resource_id
      and deleted_at is null;
  end if;

  insert into public.audit_events (organization_id, patient_id, actor_user_id, action,
    resource_type, resource_id, safe_message, metadata)
  values (_e.organization_id, _e.patient_id, _reviewer, 'sync.lab_result_materialized',
    'biomarker_observation', _observation_id::text,
    case when _inserted = 1 then 'Imported lab result staged for marker review'
         else 'Imported lab result was already staged' end,
    jsonb_build_object('syncEventId',_e.id,'duplicate',_inserted = 0));
  return jsonb_build_object('observationId',_observation_id,'duplicate',_inserted = 0);
end;
$$;

create or replace function public.review_sync_inbound(
  _event_id uuid, _action text, _note text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e public.sync_inbound_events%rowtype; _uid uuid := auth.uid(); _materialized jsonb := null;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _e from public.sync_inbound_events where id = _event_id for update;
  if not found then raise exception 'inbound event not found' using errcode = 'P0002'; end if;
  perform private.sync_connection_guard(_e.connection_id);
  if not private.can_manage_sync(_e.organization_id) then
    raise exception 'reviewing inbound data requires an owner, admin, or practitioner role' using errcode = '42501';
  end if;
  if _action not in ('accept','reject') then raise exception 'unknown review action' using errcode = '22023'; end if;
  if _e.state <> 'review_pending' then
    return jsonb_build_object('ok',true,'alreadyApplied',true,'state',_e.state,
      'message','This inbound event was already handled.');
  end if;
  if _action = 'reject' and coalesce(btrim(_note),'') = '' then
    raise exception 'rejecting inbound data requires a note' using errcode = '22023';
  end if;
  if _action = 'accept' and _e.resource_type = 'lab_result' then
    _materialized := private.materialize_sync_lab_result(_e.id, _uid);
  end if;

  update public.sync_inbound_events
  set state = case when _action = 'accept' then 'processed' else 'rejected' end,
      rejection_reason_safe = case when _action = 'reject' then left(btrim(_note),300) end,
      processed_at = now(), reviewed_by = _uid, reviewed_at = now(),
      review_note = left(btrim(coalesce(_note,'')),500)
  where id = _e.id;
  update public.review_queue_items set status = 'resolved', updated_at = now(), updated_by = _uid
  where item_type = 'sync_review' and ref_id = _e.id and status in ('open','in_review');

  perform private.log_sync_event(_e.organization_id,_e.connection_id,'inbound_reviewed',
    _e.resource_type,_action,left(btrim(coalesce(_note,'')),300),_uid);
  insert into public.audit_events (organization_id,actor_user_id,action,resource_type,
    resource_id,safe_message,patient_id,metadata)
  values (_e.organization_id,_uid,'sync.inbound_' || _action || 'ed','sync_inbound_event',
    _e.id::text,'Inbound sync data ' || _action || 'ed',_e.patient_id,
    jsonb_build_object('resourceType',_e.resource_type));
  return jsonb_build_object('ok',true,
    'state',case when _action='accept' then 'processed' else 'rejected' end,
    'materialized',_materialized,
    'message',case when _action='accept' and _e.resource_type='lab_result'
      then 'Accepted and staged in Labs for marker review.'
      when _action='accept' then 'Accepted.' else 'Rejected.' end);
end;
$$;

-- Preserve original marker names in the Labs UI when a dictionary mapping is absent.
create or replace function public.list_patient_lab_observations(
  _organization_id uuid, _patient_id uuid
)
returns table (
  id uuid, biomarker_definition_id uuid, canonical_name text, biological_system text,
  value_numeric numeric, value_text text, unit text, status text,
  original_reference_interval text, confidence numeric, provenance text,
  review_status text, reviewed_at timestamptz, observed_at timestamptz,
  ingested_at timestamptz, lab_document_id uuid, source text,
  document_file_name text, document_lab_company text
)
language sql stable security invoker set search_path = ''
as $$
  select o.id,o.biomarker_definition_id,coalesce(d.canonical_name,o.original_name),
    d.biological_system,o.value_numeric,o.value_text,o.unit,o.status,
    o.original_reference_interval,o.confidence,o.provenance,o.review_status,
    o.reviewed_at,o.observed_at,o.ingested_at,o.lab_document_id,o.source,
    doc.file_name,doc.lab_company
  from public.biomarker_observations o
  left join public.biomarker_definitions d on d.id=o.biomarker_definition_id
  left join public.lab_documents doc on doc.id=o.lab_document_id
  where o.organization_id=_organization_id and o.patient_id=_patient_id and o.deleted_at is null
  order by o.observed_at desc,o.id limit 1000;
$$;

revoke all on function private.sync_scope_valid(text) from public, anon, authenticated;
revoke all on function private.sync_inbound_scope_for(text) from public, anon, authenticated;
revoke all on function private.materialize_sync_lab_result(uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_sync_lab_result(uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.record_sync_lab_result(uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid)
  to service_role;
revoke all on function public.review_sync_inbound(uuid,text,text) from public, anon;
grant execute on function public.review_sync_inbound(uuid,text,text) to authenticated, service_role;
revoke all on function public.list_patient_lab_observations(uuid,uuid) from public, anon;
grant execute on function public.list_patient_lab_observations(uuid,uuid) to authenticated;

commit;
