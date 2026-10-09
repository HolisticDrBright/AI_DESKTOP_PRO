-- Correction requests bind an exact owner-held revision. Resolution verifies a
-- successor saved through normal record writes; it never writes clinical data,
-- changes consent, or approves a protocol on an operator's behalf.
create table clinical_private.owned_correction_targets (
  privacy_request_id uuid primary key references clinical_private.owned_privacy_requests(id),
  collection text not null,
  record_id uuid not null,
  expected_revision integer not null check(expected_revision>0),
  expected_payload_sha256 text not null check(expected_payload_sha256 ~ '^[a-f0-9]{64}$'),
  field text not null check(char_length(field) between 1 and 80),
  request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$')
);
create table clinical_private.owned_correction_resolutions (
  privacy_request_id uuid primary key references clinical_private.owned_correction_targets(privacy_request_id),
  outcome text not null check(outcome in ('applied','declined')),
  applied_revision integer,
  applied_payload_sha256 text check(applied_payload_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  operator_id uuid not null references clinical_core.persons(id),
  explanation text not null check(char_length(btrim(explanation)) between 1 and 2000),
  resolved_at timestamptz not null default clock_timestamp(),
  check((outcome='applied')=(applied_revision is not null)),
  check((outcome='applied')=(applied_payload_sha256 is not null))
);
alter table clinical_private.owned_correction_targets enable row level security;
alter table clinical_private.owned_correction_targets force row level security;
alter table clinical_private.owned_correction_resolutions enable row level security;
alter table clinical_private.owned_correction_resolutions force row level security;
revoke all on clinical_private.owned_correction_targets,clinical_private.owned_correction_resolutions from public,clinical_core_api;
create trigger owned_correction_target_immutable before update or delete on clinical_private.owned_correction_targets
  for each row execute function clinical_private.block_update_delete();
create trigger owned_correction_resolution_immutable before update or delete on clinical_private.owned_correction_resolutions
  for each row execute function clinical_private.block_update_delete();

create function clinical_core.list_owned_correction_targets(_collection text,_limit integer default 25,_after uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor();
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _collection is null
    or clinical_private.consumer_collection_scope(_collection) is null or _limit is null or _limit<1 or _limit>25 then
    raise exception using errcode='22023',message='privacy_correction_invalid';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('collection',r.collection,'recordId',r.record_id,
    'revision',r.revision,'payloadSha256',encode(public.digest(r.payload::text,'sha256'),'hex'),
    'payload',r.payload,'receivedAt',r.received_at) order by r.record_id),'[]'::jsonb)
    from (select * from (select distinct on(record_id) * from clinical_core.owned_consumer_record_versions
      where owner_id=_actor and collection=_collection and (_after is null or record_id>_after)
      order by record_id,revision desc) latest where not deleted order by record_id limit _limit) r);
end $$;

alter function clinical_core.submit_owned_privacy_request(uuid,text,jsonb) rename to submit_owned_privacy_request_v1;
revoke all on function clinical_core.submit_owned_privacy_request_v1(uuid,text,jsonb) from public,clinical_core_api;
create function clinical_core.submit_owned_privacy_request(_request_id uuid,_kind text,_correction jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _saved clinical_private.owned_privacy_requests;
  _target clinical_core.owned_consumer_record_versions; _result jsonb; _expected integer; _record uuid;
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
    or char_length(_correction->>'field') not between 1 and 80
    or _correction->>'field' in ('__proto__','prototype','constructor')
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
  if not (_target.payload ? (_correction->>'field')) or (_target.payload->(_correction->>'field'))=(_correction->'requestedValue') then
    raise exception using errcode='22023',message='privacy_correction_invalid';
  end if;
  _result:=clinical_core.submit_owned_privacy_request_v1(_request_id,_kind,_correction);
  insert into clinical_private.owned_correction_targets(privacy_request_id,collection,record_id,expected_revision,expected_payload_sha256,field,request_sha256)
    values((_result->>'privacyRequestId')::uuid,_target.collection,_target.record_id,_target.revision,
      _correction->>'expectedPayloadSha256',_correction->>'field',encode(public.digest(_correction::text,'sha256'),'hex'));
  return clinical_private.owned_privacy_request_json(_actor,(_result->>'privacyRequestId')::uuid)||jsonb_build_object('duplicate',false);
end $$;

-- Extend the owner-only representation without returning operator identities.
create or replace function clinical_private.owned_privacy_request_json(_owner uuid,_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('privacyRequestId',r.id,'requestId',r.request_id,'kind',r.kind,'status',r.status,
    'submittedAt',r.submitted_at,'updatedAt',r.updated_at,'completedAt',r.completed_at,
    'legalHold',exists(select 1 from clinical_private.owned_legal_holds h where h.owner_id=r.owner_id and h.released_at is null),
    'fulfillment',(select coalesce(jsonb_agg(jsonb_build_object('store',f.store,'outcome',f.outcome,'evidenceSha256',f.evidence_sha256,'recordedAt',f.recorded_at)
      order by f.recorded_at,f.id),'[]'::jsonb) from clinical_private.owned_privacy_fulfillment f where f.privacy_request_id=r.id))
    ||case when t.privacy_request_id is null then '{}'::jsonb else jsonb_build_object('correctionTarget',jsonb_build_object(
      'collection',t.collection,'recordId',t.record_id,'expectedRevision',t.expected_revision,'expectedPayloadSha256',t.expected_payload_sha256,
      'field',t.field,'requestSha256',t.request_sha256)) end
    ||case when s.privacy_request_id is null then '{}'::jsonb else jsonb_build_object('correctionResolution',jsonb_build_object(
      'outcome',s.outcome,'appliedRevision',s.applied_revision,'appliedPayloadSha256',s.applied_payload_sha256,
      'evidenceSha256',s.evidence_sha256,'explanation',s.explanation,'resolvedAt',s.resolved_at)) end
  from clinical_private.owned_privacy_requests r left join clinical_private.owned_correction_targets t on t.privacy_request_id=r.id
    left join clinical_private.owned_correction_resolutions s on s.privacy_request_id=r.id where r.owner_id=_owner and r.id=_id
$$;

create function clinical_private.resolve_owned_correction(_privacy_request uuid,_outcome text,_applied_revision integer,_explanation text)
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
      or _after.payload is distinct from jsonb_set(_before.payload,array[_target.field],_request.correction->'requestedValue',false) then
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

revoke all on function clinical_core.list_owned_correction_targets(text,integer,uuid),clinical_core.submit_owned_privacy_request(uuid,text,jsonb),
  clinical_private.resolve_owned_correction(uuid,text,integer,text) from public;
grant execute on function clinical_core.list_owned_correction_targets(text,integer,uuid),clinical_core.submit_owned_privacy_request(uuid,text,jsonb),
  clinical_private.resolve_owned_correction(uuid,text,integer,text) to clinical_core_api;
