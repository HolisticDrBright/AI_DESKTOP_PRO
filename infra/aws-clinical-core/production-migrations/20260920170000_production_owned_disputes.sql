-- Owner disputes of content the owner cannot correct field by field: a processed lab
-- result, a source lab document, a voice transcript, or a whole personal record. The
-- dispute states what is wrong and what the owner asks for (amend, annotate, remove).
-- Submission changes nothing. The assigned operator verifies against the store and
-- records the outcome with the amendment, annotation or removal evidence digest, or
-- declines with an explanation; the owner's ledger returns both. External-store
-- references (lab jobs, voice jobs) are verified by the operator against the
-- inventory, not by this database, which holds no rows for them.
alter table clinical_private.owned_privacy_requests add column dispute jsonb
  check (dispute is null or (jsonb_typeof(dispute)='object' and octet_length(dispute::text)<=8192));
alter table clinical_private.owned_privacy_requests drop constraint owned_privacy_requests_kind_check;
alter table clinical_private.owned_privacy_requests add constraint owned_privacy_requests_kind_check check (kind in ('deletion','correction','dispute'));
alter table clinical_private.owned_privacy_requests drop constraint owned_privacy_requests_check;
alter table clinical_private.owned_privacy_requests add constraint owned_privacy_requests_check
  check ((kind='correction')=(correction is not null) and (kind='dispute')=(dispute is not null));

create table clinical_private.owned_dispute_targets (
  privacy_request_id uuid primary key references clinical_private.owned_privacy_requests(id),
  store text not null check (store in ('lab_processing_result','lab_document','voice_transcript','personal_record')),
  reference_id text not null check (reference_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[a-f0-9]{64}$'),
  requested_action text not null check (requested_action in ('amend','annotate','remove')),
  statement_sha256 text not null check (statement_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create table clinical_private.owned_dispute_resolutions (
  privacy_request_id uuid primary key references clinical_private.owned_privacy_requests(id),
  outcome text not null check (outcome in ('amended','annotated','removed','declined')),
  amendment_sha256 text check (amendment_sha256 is null or amendment_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  operator_id uuid not null references clinical_core.persons(id),
  explanation text not null check (char_length(btrim(explanation)) between 1 and 2000),
  resolved_at timestamptz not null default clock_timestamp(),
  check ((outcome='declined')=(amendment_sha256 is null))
);
alter table clinical_private.owned_dispute_targets enable row level security;
alter table clinical_private.owned_dispute_targets force row level security;
alter table clinical_private.owned_dispute_resolutions enable row level security;
alter table clinical_private.owned_dispute_resolutions force row level security;
revoke all on clinical_private.owned_dispute_targets,clinical_private.owned_dispute_resolutions from public,clinical_core_api;

-- The owner's ledger view carries the dispute target (with the owner's own statement) and the resolution.
create or replace function clinical_private.owned_privacy_request_json(_owner uuid,_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('privacyRequestId',r.id,'requestId',r.request_id,'kind',r.kind,'status',r.status,
    'submittedAt',r.submitted_at,'updatedAt',r.updated_at,'completedAt',r.completed_at,
    'legalHold',exists(select 1 from clinical_private.owned_legal_holds h where h.owner_id=r.owner_id and h.released_at is null),
    'fulfillment',(select coalesce(jsonb_agg(jsonb_build_object('store',f.store,'outcome',f.outcome,'evidenceSha256',f.evidence_sha256,'recordedAt',f.recorded_at)
      order by f.recorded_at,f.id),'[]'::jsonb) from clinical_private.owned_privacy_fulfillment f where f.privacy_request_id=r.id))
    ||case when t.privacy_request_id is null then '{}'::jsonb else jsonb_build_object('correctionTarget',jsonb_build_object(
      'collection',t.collection,'recordId',t.record_id,'expectedRevision',t.expected_revision,'expectedPayloadSha256',t.expected_payload_sha256,
      'field',t.field,'requestSha256',t.request_sha256,'requestedValue',r.correction->'requestedValue','reason',r.correction->>'reason')) end
    ||case when s.privacy_request_id is null then '{}'::jsonb else jsonb_build_object('correctionResolution',jsonb_build_object(
      'outcome',s.outcome,'appliedRevision',s.applied_revision,'appliedPayloadSha256',s.applied_payload_sha256,
      'evidenceSha256',s.evidence_sha256,'explanation',s.explanation,'resolvedAt',s.resolved_at)) end
    ||case when d.privacy_request_id is null then '{}'::jsonb else jsonb_build_object('disputeTarget',jsonb_build_object(
      'store',d.store,'referenceId',d.reference_id,'contentSha256',d.content_sha256,'requestedAction',d.requested_action,
      'statementSha256',d.statement_sha256,'requestSha256',d.request_sha256,'statement',r.dispute->>'statement')) end
    ||case when e.privacy_request_id is null then '{}'::jsonb else jsonb_build_object('disputeResolution',jsonb_build_object(
      'outcome',e.outcome,'amendmentSha256',e.amendment_sha256,'evidenceSha256',e.evidence_sha256,'explanation',e.explanation,'resolvedAt',e.resolved_at)) end
  from clinical_private.owned_privacy_requests r left join clinical_private.owned_correction_targets t on t.privacy_request_id=r.id
    left join clinical_private.owned_correction_resolutions s on s.privacy_request_id=r.id
    left join clinical_private.owned_dispute_targets d on d.privacy_request_id=r.id
    left join clinical_private.owned_dispute_resolutions e on e.privacy_request_id=r.id where r.owner_id=_owner and r.id=_id
$$;

alter function clinical_core.submit_owned_privacy_request(uuid,text,jsonb) rename to submit_owned_privacy_request_v2;
revoke all on function clinical_core.submit_owned_privacy_request_v2(uuid,text,jsonb) from public,clinical_core_api;
create function clinical_core.submit_owned_privacy_request(_request_id uuid,_kind text,_correction jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _saved clinical_private.owned_privacy_requests; _d jsonb:=_correction; _store text; _ref text; _id uuid;
begin
  if _kind is distinct from 'dispute' then
    return clinical_core.submit_owned_privacy_request_v2(_request_id,_kind,_correction);
  end if;
  _actor:=clinical_private.owned_consumer_actor();
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _request_id is null
    or _d is null or jsonb_typeof(_d)<>'object' or octet_length(_d::text)>8192
    or (select count(*) from jsonb_object_keys(_d))<>6
    or not (_d ?& array['version','store','referenceId','contentSha256','statement','requestedAction'])
    or _d->>'version' is distinct from 'personal-dispute/1'
    or jsonb_typeof(_d->'store')<>'string' or _d->>'store' not in ('lab_processing_result','lab_document','voice_transcript','personal_record')
    or jsonb_typeof(_d->'referenceId')<>'string' or (_d->>'referenceId') !~ '^[A-Za-z0-9._:-]{1,128}$'
    or jsonb_typeof(_d->'contentSha256') not in ('null','string')
    or (jsonb_typeof(_d->'contentSha256')='string' and (_d->>'contentSha256') !~ '^[a-f0-9]{64}$')
    or jsonb_typeof(_d->'statement')<>'string' or char_length(btrim(_d->>'statement')) not between 1 and 4000
    or jsonb_typeof(_d->'requestedAction')<>'string' or _d->>'requestedAction' not in ('amend','annotate','remove') then
    raise exception using errcode='22023',message='privacy_dispute_invalid';
  end if;
  _store:=_d->>'store'; _ref:=_d->>'referenceId';
  if (_store in ('lab_processing_result','lab_document','personal_record')
      and _ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (_store='voice_transcript' and _ref !~ '^[a-f0-9]{64}$') then
    raise exception using errcode='22023',message='privacy_dispute_invalid';
  end if;
  -- A personal record must be the owner's; the external stores hold no rows here and are verified by the operator.
  if _store='personal_record' and not exists(select 1 from clinical_core.owned_consumer_record_versions
      where owner_id=_actor and record_id=_ref::uuid) then
    raise exception using errcode='40001',message='privacy_dispute_target_changed';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  select * into _saved from clinical_private.owned_privacy_requests where owner_id=_actor and request_id=_request_id;
  if found then
    if _saved.kind<>'dispute' or _saved.dispute is distinct from _d then
      raise exception using errcode='40001',message='privacy_request_conflict';
    end if;
    return clinical_private.owned_privacy_request_json(_actor,_saved.id)||jsonb_build_object('duplicate',true);
  end if;
  insert into clinical_private.owned_privacy_requests(owner_id,request_id,kind,status,dispute)
    values(_actor,_request_id,'dispute','submitted',_d) returning id into _id;
  insert into clinical_private.owned_dispute_targets(privacy_request_id,store,reference_id,content_sha256,requested_action,statement_sha256,request_sha256)
    values(_id,_store,_ref,_d->>'contentSha256',_d->>'requestedAction',
      encode(public.digest(_d->>'statement','sha256'),'hex'),encode(public.digest(_d::text,'sha256'),'hex'));
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_actor,'privacy_request.submitted','privacy');
  return clinical_private.owned_privacy_request_json(_actor,_id);
end $$;
revoke all on function clinical_core.submit_owned_privacy_request(uuid,text,jsonb) from public;
grant execute on function clinical_core.submit_owned_privacy_request(uuid,text,jsonb) to clinical_core_api;

-- Operator resolution. Amended, annotated and removed each name the evidence digest of what was done
-- (the amended result or annotation record, or the removal receipt); declined names none. Replaying the
-- same decision returns the same receipt; a different decision for a resolved request is refused.
create function clinical_private.resolve_owned_dispute(_privacy_request uuid,_outcome text,_amendment_sha256 text,_explanation text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _request clinical_private.owned_privacy_requests; _target clinical_private.owned_dispute_targets;
  _saved clinical_private.owned_dispute_resolutions; _operator uuid; _evidence text;
begin
  perform clinical_private.privacy_operator();
  select * into _request from clinical_private.owned_privacy_requests where id=_privacy_request;
  if not found or _request.kind<>'dispute' then raise exception using errcode='22023',message='privacy_request_invalid'; end if;
  _operator:=clinical_private.privacy_operator_for_owner(_request.owner_id);
  select * into _saved from clinical_private.owned_dispute_resolutions where privacy_request_id=_privacy_request;
  if found then
    if _saved.outcome is distinct from _outcome or _saved.amendment_sha256 is distinct from _amendment_sha256
      or _saved.explanation is distinct from _explanation then
      raise exception using errcode='40001',message='privacy_dispute_resolution_conflict';
    end if;
    return clinical_private.owned_privacy_request_json(_request.owner_id,_privacy_request);
  end if;
  _request:=clinical_private.lock_owned_privacy_request(_privacy_request);
  if _outcome is null or _outcome not in ('amended','annotated','removed','declined')
    or _explanation is null or char_length(btrim(_explanation)) not between 1 and 2000
    or ((_outcome='declined')<>(_amendment_sha256 is null))
    or (_amendment_sha256 is not null and _amendment_sha256 !~ '^[a-f0-9]{64}$') then
    raise exception using errcode='22023',message='privacy_dispute_resolution_invalid';
  end if;
  select * into _target from clinical_private.owned_dispute_targets where privacy_request_id=_privacy_request;
  if not found or _target.request_sha256<>encode(public.digest(_request.dispute::text,'sha256'),'hex') then
    raise exception using errcode='40001',message='privacy_dispute_target_required';
  end if;
  _evidence:=encode(public.digest(jsonb_build_array('personal-dispute-resolution/1',_privacy_request,_target.request_sha256,
    _outcome,_amendment_sha256,_operator,_explanation)::text,'sha256'),'hex');
  insert into clinical_private.owned_dispute_resolutions(privacy_request_id,outcome,amendment_sha256,evidence_sha256,operator_id,explanation)
    values(_privacy_request,_outcome,_amendment_sha256,_evidence,_operator,_explanation);
  update clinical_private.owned_privacy_requests set status=case when _outcome='declined' then 'refused' else 'completed' end,
    completed_at=case when _outcome='declined' then null else clock_timestamp() end,completed_by=_operator,updated_at=clock_timestamp()
    where id=_privacy_request;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope)
    values(_request.owner_id,case when _outcome='declined' then 'privacy_request.fulfillment' else 'privacy_request.completed' end,'privacy');
  return clinical_private.owned_privacy_request_json(_request.owner_id,_privacy_request);
end $$;
revoke all on function clinical_private.resolve_owned_dispute(uuid,text,text,text) from public;
grant execute on function clinical_private.resolve_owned_dispute(uuid,text,text,text) to clinical_core_api;

-- Operator detail: the dispute target, the owner's statement and any resolution, next to the correction block.
create or replace function clinical_private.get_assigned_privacy_request_v1(_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.privacy_operator(); _r clinical_private.owned_privacy_requests;
  _t clinical_private.owned_correction_targets; _original clinical_core.owned_consumer_record_versions;
  _latest clinical_core.owned_consumer_record_versions; _correction jsonb:=null; _dispute jsonb:=null; _receipt jsonb;
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
  if _receipt ? 'disputeTarget' then
    _dispute:=jsonb_build_object('target',(_receipt->'disputeTarget')-'statement','statement',_r.dispute->>'statement',
      'resolution',_receipt->'disputeResolution');
  end if;
  insert into clinical_audit.privacy_operator_access(operator_id,privacy_request_id,action) values(_actor,_id,'detail');
  return jsonb_build_object('privacyRequestId',_r.id,'ownerId',_r.owner_id,'kind',_r.kind,'status',_r.status,
    'submittedAt',_r.submitted_at,'updatedAt',_r.updated_at,'legalHold',_receipt->'legalHold',
    'fulfillment',_receipt->'fulfillment','correction',_correction,'dispute',_dispute);
end $$;
