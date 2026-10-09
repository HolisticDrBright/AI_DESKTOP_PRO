-- Production overlay: a correction may target a nested scalar leaf by dotted
-- path. The same exact-delta verification applies: the successor must equal the
-- reviewed payload with only that leaf changed. Arrays, objects and null leaves
-- still need a domain-specific workflow. Segment rules mirror the shared contract.
alter table clinical_private.owned_correction_targets drop constraint owned_correction_targets_field_check;
alter table clinical_private.owned_correction_targets add constraint owned_correction_targets_field_check check(char_length(field) between 1 and 240);

create function clinical_private.owned_correction_path(_field text) returns text[]
language plpgsql immutable set search_path='' as $$
declare _path text[]; _segment text;
begin
  if _field is null or char_length(_field) not between 1 and 240 then raise exception using errcode='22023',message='privacy_correction_invalid'; end if;
  _path:=string_to_array(_field,'.');
  if cardinality(_path) not between 1 and 6 then raise exception using errcode='22023',message='privacy_correction_invalid'; end if;
  foreach _segment in array _path loop
    if _segment is null or char_length(_segment) not between 1 and 80 or _segment in ('__proto__','prototype','constructor') then
      raise exception using errcode='22023',message='privacy_correction_invalid'; end if;
  end loop;
  return _path;
end $$;
revoke all on function clinical_private.owned_correction_path(text) from public,clinical_core_api;

create or replace function clinical_core.submit_owned_privacy_request(_request_id uuid,_kind text,_correction jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _saved clinical_private.owned_privacy_requests;
  _target clinical_core.owned_consumer_record_versions; _result jsonb; _expected integer; _record uuid; _path text[];
begin
  if _kind is distinct from 'correction' then
    return clinical_core.submit_owned_privacy_request_v1(_request_id,_kind,_correction);
  end if;
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _request_id is null
    or _correction is null or jsonb_typeof(_correction)<>'object' or octet_length(_correction::text)>8192
    or (select count(*) from jsonb_object_keys(_correction))<>8
    or not (_correction ?& array['collection','recordId','expectedRevision','expectedPayloadSha256','field','requestedValue','reason','version'])
    or _correction->>'version' is distinct from 'personal-correction/1'
    or jsonb_typeof(_correction->'collection')<>'string' or jsonb_typeof(_correction->'field')<>'string'
    or jsonb_typeof(_correction->'reason')<>'string' or char_length(btrim(_correction->>'reason')) not between 1 and 2000
    or char_length(_correction->>'field') not between 1 and 240
    or jsonb_typeof(_correction->'requestedValue') not in ('string','number','boolean')
    or jsonb_typeof(_correction->'expectedRevision')<>'number' or (_correction->>'expectedRevision') !~ '^[1-9][0-9]{0,8}$'
    or jsonb_typeof(_correction->'recordId')<>'string' or (_correction->>'recordId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(_correction->'expectedPayloadSha256')<>'string' or (_correction->>'expectedPayloadSha256') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='privacy_correction_invalid';
  end if;
  _expected:=(_correction->>'expectedRevision')::integer; _record:=(_correction->>'recordId')::uuid;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  select * into _saved from clinical_private.owned_privacy_requests where owner_id=_actor and request_id=_request_id;
  if found then
    if _saved.kind<>'correction' or _saved.correction is distinct from _correction then
      raise exception using errcode='40001',message='privacy_request_conflict';
    end if;
    return clinical_private.owned_privacy_request_json(_actor,_saved.id)||jsonb_build_object('duplicate',true);
  end if;
  select * into _target from clinical_core.owned_consumer_record_versions where owner_id=_actor
    and collection=_correction->>'collection' and record_id=_record order by revision desc limit 1;
  if not found or _target.deleted or _target.revision<>_expected
    or encode(public.digest(_target.payload::text,'sha256'),'hex')<>_correction->>'expectedPayloadSha256' then
    raise exception using errcode='40001',message='privacy_correction_target_changed';
  end if;
  _path:=clinical_private.owned_correction_path(_correction->>'field');
  -- The path must reach an existing scalar leaf; the requested value must differ and keep the leaf scalar.
  if (_target.payload #> _path) is null or jsonb_typeof(_target.payload #> _path) not in ('string','number','boolean')
    or (_target.payload #> _path)=(_correction->'requestedValue') then
    raise exception using errcode='22023',message='privacy_correction_invalid';
  end if;
  _result:=clinical_core.submit_owned_privacy_request_v1(_request_id,_kind,_correction);
  insert into clinical_private.owned_correction_targets(privacy_request_id,collection,record_id,expected_revision,expected_payload_sha256,field,request_sha256)
    values((_result->>'privacyRequestId')::uuid,_target.collection,_target.record_id,_target.revision,
      _correction->>'expectedPayloadSha256',_correction->>'field',encode(public.digest(_correction::text,'sha256'),'hex'));
  return clinical_private.owned_privacy_request_json(_actor,(_result->>'privacyRequestId')::uuid)||jsonb_build_object('duplicate',false);
end $$;

create or replace function clinical_private.resolve_owned_correction(_privacy_request uuid,_outcome text,_applied_revision integer,_explanation text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _request clinical_private.owned_privacy_requests; _target clinical_private.owned_correction_targets;
  _saved clinical_private.owned_correction_resolutions; _before clinical_core.owned_consumer_record_versions;
  _after clinical_core.owned_consumer_record_versions; _operator uuid; _after_hash text; _evidence text;
begin
  perform clinical_private.privacy_operator();
  select * into _request from clinical_private.owned_privacy_requests where id=_privacy_request;
  if not found or _request.kind<>'correction' then raise exception using errcode='22023',message='privacy_request_invalid'; end if;
  _operator:=clinical_private.privacy_operator_for_owner(_request.owner_id);
  select * into _saved from clinical_private.owned_correction_resolutions where privacy_request_id=_privacy_request;
  if found then
    if _saved.outcome is distinct from _outcome or _saved.applied_revision is distinct from _applied_revision
      or _saved.explanation is distinct from _explanation then
      raise exception using errcode='40001',message='privacy_correction_resolution_conflict';
    end if;
    return clinical_private.owned_privacy_request_json(_request.owner_id,_privacy_request);
  end if;
  _request:=clinical_private.lock_owned_privacy_request(_privacy_request);
  if _outcome is null or _outcome not in ('applied','declined') or _explanation is null or char_length(btrim(_explanation)) not between 1 and 2000
    or ((_outcome='applied')<>(_applied_revision is not null)) then
    raise exception using errcode='22023',message='privacy_correction_resolution_invalid';
  end if;
  select * into _target from clinical_private.owned_correction_targets where privacy_request_id=_privacy_request;
  if not found or _target.request_sha256<>encode(public.digest(_request.correction::text,'sha256'),'hex') then
    raise exception using errcode='40001',message='privacy_correction_target_required';
  end if;
  if _outcome='applied' then
    select * into _before from clinical_core.owned_consumer_record_versions where owner_id=_request.owner_id
      and collection=_target.collection and record_id=_target.record_id and revision=_target.expected_revision;
    if not found or _before.deleted or encode(public.digest(_before.payload::text,'sha256'),'hex')<>_target.expected_payload_sha256 then
      raise exception using errcode='40001',message='privacy_correction_target_changed';
    end if;
    select * into _after from clinical_core.owned_consumer_record_versions where owner_id=_request.owner_id
      and collection=_target.collection and record_id=_target.record_id order by revision desc limit 1;
    if not found or _after.deleted or _after.revision<>_applied_revision or _after.revision<=_target.expected_revision
      or _after.payload is distinct from jsonb_set(_before.payload,clinical_private.owned_correction_path(_target.field),_request.correction->'requestedValue',false) then
      raise exception using errcode='40001',message='privacy_correction_not_applied';
    end if;
    _after_hash:=encode(public.digest(_after.payload::text,'sha256'),'hex');
  end if;
  _evidence:=encode(public.digest(jsonb_build_array('personal-correction-resolution/1',_privacy_request,_target.request_sha256,
    _target.expected_payload_sha256,_outcome,_applied_revision,_after_hash,_operator,_explanation)::text,'sha256'),'hex');
  insert into clinical_private.owned_correction_resolutions(privacy_request_id,outcome,applied_revision,applied_payload_sha256,evidence_sha256,operator_id,explanation)
    values(_privacy_request,_outcome,_applied_revision,_after_hash,_evidence,_operator,_explanation);
  update clinical_private.owned_privacy_requests set status=case when _outcome='applied' then 'completed' else 'refused' end,
    completed_at=case when _outcome='applied' then clock_timestamp() else null end,completed_by=_operator,updated_at=clock_timestamp() where id=_privacy_request;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope)
    values(_request.owner_id,case when _outcome='applied' then 'privacy_request.completed' else 'privacy_request.fulfillment' end,'privacy');
  return clinical_private.owned_privacy_request_json(_request.owner_id,_privacy_request);
end $$;

-- The operator detail body was renamed to _v1 by the external-inventory overlay, which wraps it; the path-aware read goes there.
create or replace function clinical_private.get_assigned_privacy_request_v1(_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.privacy_operator(); _r clinical_private.owned_privacy_requests;
  _t clinical_private.owned_correction_targets; _original clinical_core.owned_consumer_record_versions;
  _latest clinical_core.owned_consumer_record_versions; _correction jsonb:=null; _receipt jsonb;
begin
  select * into _r from clinical_private.owned_privacy_requests where id=_id;
  if not found then raise exception using errcode='42501',message='privacy_operator_assignment_required'; end if;
  perform clinical_private.privacy_operator_for_owner(_r.owner_id);
  select * into _r from clinical_private.owned_privacy_requests where id=_id for share;
  _receipt:=clinical_private.owned_privacy_request_json(_r.owner_id,_id);
  select * into _t from clinical_private.owned_correction_targets where privacy_request_id=_id;
  if found then
    select * into _original from clinical_core.owned_consumer_record_versions
      where owner_id=_r.owner_id and collection=_t.collection and record_id=_t.record_id and revision=_t.expected_revision;
    select * into _latest from clinical_core.owned_consumer_record_versions
      where owner_id=_r.owner_id and collection=_t.collection and record_id=_t.record_id order by revision desc limit 1;
    -- Field-limited evidence; do not disclose the rest of an intake or lab panel.
    _correction:=jsonb_build_object('target',_receipt->'correctionTarget','reason',_r.correction->>'reason',
      'requestedValue',_r.correction->'requestedValue','originalAvailable',_original.revision is not null and not _original.deleted,
      'originalValue',case when not _original.deleted then _original.payload #> clinical_private.owned_correction_path(_t.field) else null end,
      'currentRevision',_latest.revision,'currentDeleted',coalesce(_latest.deleted,true),
      'currentValue',case when not _latest.deleted then _latest.payload #> clinical_private.owned_correction_path(_t.field) else null end,
      'resolution',_receipt->'correctionResolution');
  end if;
  insert into clinical_audit.privacy_operator_access(operator_id,privacy_request_id,action) values(_actor,_id,'detail');
  return jsonb_build_object('privacyRequestId',_r.id,'ownerId',_r.owner_id,'kind',_r.kind,'status',_r.status,
    'submittedAt',_r.submitted_at,'updatedAt',_r.updated_at,'legalHold',_receipt->'legalHold',
    'fulfillment',_receipt->'fulfillment','correction',_correction);
end $$;
