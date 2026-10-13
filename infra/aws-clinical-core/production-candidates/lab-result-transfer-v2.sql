-- Unreleased production candidate: lab-result/2, the patient-app lab transfer that carries where a reading came from
-- and what the app claimed about it, and never a laboratory flag. BLOCKED: applied nowhere, registered in no
-- manifest, and its activation row below is disabled.
--
-- Parent: the 106-migration production artifact built by scripts/build-aws-production-clinical-core.mjs
-- (clinical_core.lab_import_events, lab_observations, sync_providers, patient_connections, current_consent,
-- clinical_audit.events, clinical_private.assert_production_context/actor_person_id). Order with its siblings:
--   1. this file;
--   2. lab-observation-attestation.sql (binds a reviewer's attestation to the document digest recorded here);
--   3. production-program-assignments.sql (reads attested clinic readings for its lab-aware review).
-- No historical migration, ledger, grant outside this file, IAM or custody file changes. Registration, the activation
-- evidence and execution are Codex work after review.
--
-- What changes, and what does not:
--   * lab-result/1 is unchanged and stays readable. Its rows carry no transfer provenance, so every reader treats
--     them as unverified, and a /1 row's source_status is what the APP said about the reading — never the
--     laboratory's flag (the V2 sender has sent 'unknown' since 2026-10-13; older rows may hold an app status).
--   * lab-result/2 rows record the origin (uploaded report analysis, owner entry, personal import), the SHA-256 of
--     each uploaded document the reading was read from, the app's own verification mark as a claim, and the
--     server's verification state 'needs_human_review'. source_status is always null: /2 has no field that could
--     carry a status, a flag, an interpretation or a "verified" boolean, and a request naming one is refused.
--   * Nothing here verifies a reading. A reviewer's attestation is the only transition out of needs_human_review.
--   * The measured fields of an import event cannot change after it is recorded, for /1 and /2 alike: an attestation
--     binds to them, and a binding to fields that can move binds to nothing.

create table clinical_core.lab_result_transfer_v2_activation(
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  reviewed_by text check(reviewed_by is null or char_length(reviewed_by) between 1 and 200),
  reviewed_at timestamptz,
  check(not enabled or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null))
);
insert into clinical_core.lab_result_transfer_v2_activation(singleton,enabled) values(true,false);
-- The API role reads the switch only through the request function; it can never flip it.
revoke all on clinical_core.lab_result_transfer_v2_activation from public,clinical_core_api;

alter table clinical_core.lab_import_events add column transfer_provenance jsonb;
alter table clinical_core.lab_import_events add constraint lab_import_events_transfer_provenance_check check(
  transfer_provenance is null or (
    jsonb_typeof(transfer_provenance)='object'
    and transfer_provenance->>'contract'='lab-result/2'
    and transfer_provenance->>'verification'='needs_human_review'
    and source_status is null));

create function clinical_private.lab_import_measurement_immutable() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.organization_id<>old.organization_id or new.patient_record_id<>old.patient_record_id
    or new.connection_id<>old.connection_id or new.provider_id<>old.provider_id
    or new.provider_event_id<>old.provider_event_id or new.external_panel_id<>old.external_panel_id
    or new.external_marker_id<>old.external_marker_id or new.resource_version<>old.resource_version
    or new.panel_name<>old.panel_name or new.source_label is distinct from old.source_label
    or new.marker_name<>old.marker_name or new.value_numeric<>old.value_numeric
    or new.unit is distinct from old.unit or new.reference_min is distinct from old.reference_min
    or new.reference_max is distinct from old.reference_max or new.source_status is distinct from old.source_status
    or new.collected_at<>old.collected_at or new.occurred_at<>old.occurred_at
    or new.payload_sha256<>old.payload_sha256 or new.transfer_provenance is distinct from old.transfer_provenance then
    raise exception using errcode='55000',message='lab_import_measurement_immutable';
  end if;
  return new;
end $$;
create trigger lab_import_events_measurement_immutable before update on clinical_core.lab_import_events
  for each row execute function clinical_private.lab_import_measurement_immutable();

-- One transfer: the same envelope as /1 (provider, event, connection, resource version, occurrence, source, panel)
-- with a result that carries no status and a provenance block that carries no authority.
create function clinical_core.record_lab_import_v2(_request jsonb)
returns table(event_id uuid, state text, duplicate boolean)
language plpgsql security definer set search_path='' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _provider clinical_core.sync_providers%rowtype;
  _event clinical_core.lab_import_events%rowtype;
  _state text:='review_pending';
  _source jsonb:=_request->'source'; _panel jsonb:=_request->'panel'; _result jsonb:=_request->'result';
  _provenance jsonb:=_request->'provenance'; _range jsonb:=_request->'result'->'referenceRange';
  _documents jsonb; _min numeric; _max numeric; _collected timestamptz; _occurred timestamptz; _digest text;
begin
  if not exists(select 1 from clinical_core.lab_result_transfer_v2_activation where singleton and enabled) then
    raise exception using errcode='42501',message='lab_result_v2_disabled'; end if;
  -- Shape first, exactly: every object is closed, so a status, a flag, an interpretation or a "verified" boolean
  -- has nowhere to go and is refused rather than ignored.
  if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>16384
    or _request-array['schemaVersion','provider','providerEventId','connectionId','resourceVersion','occurredAt',
      'source','panel','result','provenance']<>'{}'::jsonb
    or _request->>'schemaVersion' is distinct from 'lab-result/2'
    or _request->>'provider' is distinct from 'alp_patient_sync'
    or coalesce(_request->>'providerEventId','') !~ '^[A-Za-z0-9:_-]{8,160}$'
    or coalesce(_request->>'connectionId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(_request->>'resourceVersion','') !~ '^[A-Za-z0-9._:-]{1,64}$'
    or jsonb_typeof(_source)<>'object' or _source-array['system','recordType','panelId','markerId']<>'{}'::jsonb
    or _source->>'system' is distinct from 'ai_longevity_pro_v2' or _source->>'recordType' is distinct from 'lab_panels'
    or coalesce(_source->>'panelId','') !~ '^[A-Za-z0-9:_-]{1,160}$'
    or coalesce(_source->>'markerId','') !~ '^[A-Za-z0-9:_-]{1,160}$'
    or jsonb_typeof(_panel)<>'object' or _panel-array['name','collectedAt','sourceLabel']<>'{}'::jsonb
    or jsonb_typeof(_panel->'name')<>'string' or char_length(btrim(_panel->>'name')) not between 1 and 200
    or (_panel ? 'sourceLabel' and (jsonb_typeof(_panel->'sourceLabel')<>'string' or char_length(btrim(_panel->>'sourceLabel')) not between 1 and 200))
    or jsonb_typeof(_result)<>'object' or _result-array['name','value','unit','referenceRange']<>'{}'::jsonb
    or jsonb_typeof(_result->'name')<>'string' or char_length(btrim(_result->>'name')) not between 1 and 200
    or jsonb_typeof(_result->'value')<>'number'
    or (_result ? 'unit' and (jsonb_typeof(_result->'unit')<>'string' or char_length(btrim(_result->>'unit')) not between 1 and 80))
    or (_result ? 'referenceRange' and (jsonb_typeof(_range)<>'object' or _range-array['min','max']<>'{}'::jsonb
      or _range='{}'::jsonb or (_range ? 'min' and jsonb_typeof(_range->'min')<>'number')
      or (_range ? 'max' and jsonb_typeof(_range->'max')<>'number')))
    or jsonb_typeof(_provenance)<>'object'
    or _provenance-array['origin','documents','reportedVerification']<>'{}'::jsonb
    or _provenance->>'origin' is null
    or _provenance->>'origin' not in ('uploaded_report_analysis','owner_entered','personal_import')
    or _provenance->>'reportedVerification' is null
    or _provenance->>'reportedVerification' not in ('analysis_cross_checked','needs_human_review','not_recorded')
    or jsonb_typeof(_provenance->'documents')<>'array' or jsonb_array_length(_provenance->'documents')>20
    or exists(select 1 from jsonb_array_elements(_provenance->'documents') d
      where jsonb_typeof(d.value)<>'string' or d.value#>>'{}' !~ '^[0-9a-f]{64}$')
    -- A reading read from an uploaded report names the documents it was read from; any other origin names none.
    or (_provenance->>'origin'='uploaded_report_analysis') <> (jsonb_array_length(_provenance->'documents')>0) then
    raise exception using errcode='22023',message='lab_import_invalid'; end if;
  select coalesce(jsonb_agg(distinct d.value order by d.value),'[]'::jsonb) into _documents
    from jsonb_array_elements(_provenance->'documents') d;
  if jsonb_array_length(_documents)<>jsonb_array_length(_provenance->'documents') then
    raise exception using errcode='22023',message='lab_import_invalid'; end if;
  _min:=(_range->>'min')::numeric; _max:=(_range->>'max')::numeric;
  if _min is not null and _max is not null and _min>_max then
    raise exception using errcode='22023',message='lab_import_invalid'; end if;
  begin
    _collected:=(_panel->>'collectedAt')::timestamptz; _occurred:=(_request->>'occurredAt')::timestamptz;
  exception when others then raise exception using errcode='22023',message='lab_import_invalid'; end;
  if _collected is null or _occurred is null then raise exception using errcode='22023',message='lab_import_invalid'; end if;

  -- Authority: the same as /1, re-checked here.
  select * into _connection from clinical_core.patient_connections c
    where c.id=(_request->>'connectionId')::uuid and c.state='verified';
  if not found then raise exception using errcode='P0002',message='verified_connection_required'; end if;
  perform clinical_private.assert_production_context(_connection.organization_id,'clinical_data','consumer');
  if _connection.consumer_person_id is distinct from clinical_private.actor_person_id() then
    raise exception using errcode='42501',message='consumer_connection_refused'; end if;
  if not exists(select 1 from clinical_core.current_consent c
    where c.connection_id=_connection.id and c.scope='lab_results_import' and c.status='granted') then
    raise exception using errcode='42501',message='lab_import_consent_required'; end if;
  select * into _provider from clinical_core.sync_providers p
    where p.organization_id=_connection.organization_id and p.stable_id='alp_patient_sync' and p.state='active'
      and p.contract_version='patient-sync/1';
  if not found then raise exception using errcode='42501',message='approved_provider_required'; end if;
  if _occurred>clock_timestamp()+interval '5 minutes' or _occurred<clock_timestamp()-interval '30 days'
    or _collected>clock_timestamp()+interval '1 day' or _collected>_occurred+interval '1 day' then
    raise exception using errcode='22023',message='lab_import_invalid'; end if;

  -- The digest covers every clinical field and the provenance, not the delivery envelope: a retry is a duplicate,
  -- a changed value or provenance under the same identity is a conflict.
  _digest:=encode(public.digest(convert_to(jsonb_build_object('schemaVersion','lab-result/2','source',_source,
    'panel',_panel,'result',_result,'provenance',jsonb_build_object('origin',_provenance->'origin','documents',_documents,
    'reportedVerification',_provenance->'reportedVerification'))::text,'UTF8'),'sha256'),'hex');

  select * into _event from clinical_core.lab_import_events e
    where e.provider_id=_provider.id and e.connection_id=_connection.id and e.provider_event_id=_request->>'providerEventId';
  if found then
    if _event.payload_sha256<>_digest then raise exception using errcode='40001',message='provider_event_conflict'; end if;
    insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
    values(_connection.organization_id,clinical_private.actor_person_id(),'lab_import.duplicate','lab_import',_event.id,
      'clinical_data',jsonb_build_object('provider','alp_patient_sync','contract','lab-result/2'));
    return query select _event.id,_event.state,true; return;
  end if;
  select * into _event from clinical_core.lab_import_events e
    where e.provider_id=_provider.id and e.connection_id=_connection.id
      and e.external_panel_id=_source->>'panelId' and e.external_marker_id=_source->>'markerId'
      and e.resource_version=_request->>'resourceVersion';
  if found then
    if _event.payload_sha256<>_digest then raise exception using errcode='40001',message='resource_version_conflict'; end if;
    insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
    values(_connection.organization_id,clinical_private.actor_person_id(),'lab_import.duplicate','lab_import',_event.id,
      'clinical_data',jsonb_build_object('provider','alp_patient_sync','contract','lab-result/2'));
    return query select _event.id,_event.state,true; return;
  end if;
  if exists(select 1 from clinical_core.lab_import_events e
    where e.provider_id=_provider.id and e.connection_id=_connection.id
      and e.external_panel_id=_source->>'panelId' and e.external_marker_id=_source->>'markerId') then
    _state:='conflict'; end if;

  insert into clinical_core.lab_import_events(organization_id,patient_record_id,connection_id,provider_id,
    provider_event_id,external_panel_id,external_marker_id,resource_version,panel_name,source_label,marker_name,
    value_numeric,unit,reference_min,reference_max,source_status,collected_at,occurred_at,payload_sha256,state,
    transfer_provenance)
  values(_connection.organization_id,_connection.patient_record_id,_connection.id,_provider.id,
    _request->>'providerEventId',_source->>'panelId',_source->>'markerId',_request->>'resourceVersion',
    btrim(_panel->>'name'),nullif(btrim(coalesce(_panel->>'sourceLabel','')),''),btrim(_result->>'name'),
    (_result->>'value')::numeric,nullif(btrim(coalesce(_result->>'unit','')),''),_min,_max,
    -- Never a status: /2 carries none, and a reading's classification is the practice's, on review.
    null,_collected,_occurred,_digest,_state,
    jsonb_build_object('contract','lab-result/2','origin',_provenance->>'origin','documents',_documents,
      'reportedVerification',_provenance->>'reportedVerification','verification','needs_human_review'))
  returning id into _event.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
  values(_connection.organization_id,clinical_private.actor_person_id(),'lab_import.received','lab_import',_event.id,
    'clinical_data',jsonb_build_object('provider','alp_patient_sync','state',_state,'contract','lab-result/2'));
  return query select _event.id,_state,false;
end $$;
revoke all on function clinical_core.record_lab_import_v2(jsonb) from public;
grant execute on function clinical_core.record_lab_import_v2(jsonb) to clinical_core_api;

-- What a reviewer is shown about where an import came from. A /1 row has no provenance and reads as unverified, with
-- its stored status named as the app's assessment. Nothing returned here is ever a laboratory-issued flag: no
-- transfer contract carries one. The state is the one at transfer; whether a reading has since been verified is
-- the attestation candidate's question, answered there.
create function clinical_core.lab_import_provenance(_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _event clinical_core.lab_import_events%rowtype;
begin
  select * into _event from clinical_core.lab_import_events e where e.id=_event_id;
  if not found then raise exception using errcode='P0002',message='lab_import_not_found'; end if;
  perform clinical_private.assert_production_context(_event.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_event.organization_id) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _event.transfer_provenance is null then
    return jsonb_build_object('contract','lab-result/1','origin','not_recorded','documents','[]'::jsonb,
      'reportedVerification','not_recorded','verificationAtTransfer','needs_human_review',
      'appAssessment',_event.source_status,'laboratoryFlag',null);
  end if;
  return jsonb_build_object('contract','lab-result/2','origin',_event.transfer_provenance->>'origin',
    'documents',_event.transfer_provenance->'documents',
    'reportedVerification',_event.transfer_provenance->>'reportedVerification',
    'verificationAtTransfer','needs_human_review','appAssessment',null,'laboratoryFlag',null);
end $$;
revoke all on function clinical_core.lab_import_provenance(uuid) from public;
grant execute on function clinical_core.lab_import_provenance(uuid) to clinical_core_api;
