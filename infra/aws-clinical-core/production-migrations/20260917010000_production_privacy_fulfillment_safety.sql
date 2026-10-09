-- Privacy fulfillment safety. No assignments or policy approvals are seeded.
-- A workforce identity alone does not confer authority over another owner.
create table clinical_private.owned_privacy_operator_assignments (
  operator_id uuid not null references clinical_core.persons(id),
  owner_id uuid not null references clinical_core.persons(id),
  reviewed_by uuid not null references clinical_core.persons(id),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > approved_at),
  revoked_at timestamptz,
  primary key(operator_id,owner_id),
  check (operator_id <> reviewed_by and operator_id <> owner_id)
);
alter table clinical_private.owned_privacy_operator_assignments enable row level security;
alter table clinical_private.owned_privacy_operator_assignments force row level security;
revoke all on clinical_private.owned_privacy_operator_assignments from public,clinical_core_api;
alter table clinical_private.owned_privacy_requests add column completed_by uuid references clinical_core.persons(id);
alter table clinical_private.owned_privacy_fulfillment
  add column retention_policy_version text references clinical_private.owned_retention_policies(version),
  add column retention_policy_sha256 text check (retention_policy_sha256 ~ '^[a-f0-9]{64}$'),
  add column fulfillment_version text check (fulfillment_version='privacy-fulfillment/2');

create function clinical_private.privacy_operator_for_owner(_owner uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.privacy_operator(); _assignment clinical_private.owned_privacy_operator_assignments;
begin
  if _owner is null or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
    or not exists(select 1 from clinical_core.identities where person_id=_actor and identity_pool='workforce'
      and identity_subject=clinical_private.claim('identity_subject') and status='active' and production_bound=true) then
    raise exception using errcode='42501',message='privacy_operator_required';
  end if;
  -- Shared owner lock with consumer writes, hold placement and all fulfillment.
  perform pg_advisory_xact_lock(hashtextextended(_owner::text,0));
  perform clinical_private.privacy_operator();
  perform 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
    where i.person_id=_actor and i.identity_pool='workforce' and i.identity_subject=clinical_private.claim('identity_subject')
      and i.status='active' and i.production_bound=true and p.status='active' for share of i,p;
  if not found then raise exception using errcode='42501',message='privacy_operator_required'; end if;
  select * into _assignment from clinical_private.owned_privacy_operator_assignments
    where operator_id=_actor and owner_id=_owner for share;
  if not found or _assignment.revoked_at is not null or _assignment.approved_at>clock_timestamp()
    or _assignment.expires_at<=clock_timestamp() then
    raise exception using errcode='42501',message='privacy_operator_assignment_required';
  end if;
  return _actor;
end $$;

create function clinical_private.lock_owned_privacy_request(_id uuid,_allow_held boolean default false)
returns clinical_private.owned_privacy_requests language plpgsql security definer set search_path='' as $$
declare _request clinical_private.owned_privacy_requests;
begin
  perform clinical_private.privacy_operator();
  select * into _request from clinical_private.owned_privacy_requests where id=_id;
  if not found then raise exception using errcode='22023',message='privacy_request_invalid'; end if;
  perform clinical_private.privacy_operator_for_owner(_request.owner_id);
  -- Re-read after acquiring the owner lock; the pre-lock read grants no authority.
  select * into _request from clinical_private.owned_privacy_requests where id=_id for update;
  if not found or _request.status in ('completed','refused') then
    raise exception using errcode='22023',message='privacy_request_invalid';
  end if;
  if not _allow_held and (_request.status='held' or exists(select 1 from clinical_private.owned_legal_holds
    where owner_id=_request.owner_id and released_at is null)) then
    raise exception using errcode='42501',message='privacy_request_held';
  end if;
  return _request;
end $$;

create function clinical_private.verified_owned_retention_policy(_version text)
returns clinical_private.owned_retention_policies language plpgsql security definer set search_path='' as $$
declare _policy clinical_private.owned_retention_policies;
begin
  select * into _policy from clinical_private.owned_retention_policies where version=_version for share;
  if not found or _policy.retired_at is not null or _policy.approved_at>clock_timestamp()
    or btrim(_policy.approved_by)='' or btrim(_policy.content)=''
    or _policy.content_sha256 is distinct from encode(public.digest(_policy.content,'sha256'),'hex') then
    raise exception using errcode='42501',message='retention_policy_required';
  end if;
  return _policy;
end $$;

-- Keep previous implementations as private helpers; remove their API grants.
alter function clinical_private.place_owned_legal_hold(uuid,text) rename to place_owned_legal_hold_v1;
alter function clinical_private.release_owned_legal_hold(uuid) rename to release_owned_legal_hold_v1;
alter function clinical_private.record_owned_privacy_fulfillment(uuid,text,text,text) rename to record_owned_privacy_fulfillment_v1;
alter function clinical_private.purge_owned_personal_history(uuid,text) rename to purge_owned_personal_history_v1;
revoke all on function clinical_private.place_owned_legal_hold_v1(uuid,text),
  clinical_private.release_owned_legal_hold_v1(uuid),clinical_private.record_owned_privacy_fulfillment_v1(uuid,text,text,text),
  clinical_private.purge_owned_personal_history_v1(uuid,text) from public,clinical_core_api;

create function clinical_private.place_owned_legal_hold(_owner uuid,_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  perform clinical_private.privacy_operator_for_owner(_owner);
  return clinical_private.place_owned_legal_hold_v1(_owner,_reason);
end $$;

create function clinical_private.release_owned_legal_hold(_hold uuid)
returns void language plpgsql security definer set search_path='' as $$
declare _owner uuid;
begin
  perform clinical_private.privacy_operator();
  select owner_id into _owner from clinical_private.owned_legal_holds where id=_hold;
  if not found then raise exception using errcode='22023',message='legal_hold_invalid'; end if;
  perform clinical_private.privacy_operator_for_owner(_owner);
  -- The helper's active-hold read now occurs while the owner lock is held.
  perform clinical_private.release_owned_legal_hold_v1(_hold);
end $$;

create function clinical_private.record_owned_privacy_fulfillment(_privacy_request uuid,_store text,_outcome text,_evidence text)
returns void language plpgsql security definer set search_path='' as $$
declare _request clinical_private.owned_privacy_requests;
begin
  _request:=clinical_private.lock_owned_privacy_request(_privacy_request,true);
  if _outcome='retained_by_policy' then
    raise exception using errcode='22023',message='retention_policy_receipt_required';
  end if;
  if _outcome in ('purged','not_applicable') and (_evidence is null or _evidence !~ '^[a-f0-9]{64}$') then
    raise exception using errcode='22023',message='privacy_fulfillment_evidence_required';
  end if;
  if _outcome in ('purged','tombstoned') and exists(select 1 from clinical_private.owned_legal_holds
    where owner_id=_request.owner_id and released_at is null) then
    raise exception using errcode='42501',message='privacy_request_held';
  end if;
  if _request.status='held' and _outcome in ('purged','tombstoned') then
    raise exception using errcode='42501',message='privacy_request_held';
  end if;
  insert into clinical_private.owned_privacy_fulfillment(privacy_request_id,store,outcome,evidence_sha256,operator,fulfillment_version)
    values(_privacy_request,_store,_outcome,_evidence,'workforce:'||clinical_private.privacy_operator()::text,'privacy-fulfillment/2');
  update clinical_private.owned_privacy_requests set status=case when status='submitted' then 'in_progress' else status end,
    updated_at=clock_timestamp() where id=_privacy_request;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_request.owner_id,'privacy_request.fulfillment','privacy');
end $$;

-- Retention is attributable and policy-bound; it never means the data was erased.
create function clinical_private.record_owned_privacy_retention(_privacy_request uuid,_store text,_evidence text,_policy_version text)
returns void language plpgsql security definer set search_path='' as $$
declare _request clinical_private.owned_privacy_requests; _policy clinical_private.owned_retention_policies;
begin
  _request:=clinical_private.lock_owned_privacy_request(_privacy_request);
  _policy:=clinical_private.verified_owned_retention_policy(_policy_version);
  if _evidence is null or _evidence !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='privacy_fulfillment_evidence_required';
  end if;
  insert into clinical_private.owned_privacy_fulfillment
    (privacy_request_id,store,outcome,evidence_sha256,operator,retention_policy_version,retention_policy_sha256,fulfillment_version)
    values(_privacy_request,_store,'retained_by_policy',_evidence,'workforce:'||clinical_private.privacy_operator()::text,_policy.version,_policy.content_sha256,'privacy-fulfillment/2');
  update clinical_private.owned_privacy_requests set status='in_progress',updated_at=clock_timestamp() where id=_privacy_request;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_request.owner_id,'privacy_request.fulfillment','privacy');
end $$;

create or replace function clinical_private.complete_owned_privacy_request(_privacy_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _request clinical_private.owned_privacy_requests; _store text; _receipt clinical_private.owned_privacy_fulfillment;
  _policy clinical_private.owned_retention_policies;
begin
  _request:=clinical_private.lock_owned_privacy_request(_privacy_request);
  -- Deletion receipts cannot prove a requested correction was applied.
  if _request.kind='correction' then
    raise exception using errcode='40001',message='privacy_correction_resolution_required';
  end if;
  foreach _store in array array['personal_records','personal_consents','active_plan','lab_jobs_and_documents',
    'voice_jobs_and_transcripts','identity','clinic_records','device_caches_and_recovery_archives','backups_and_audit'] loop
    select * into _receipt from clinical_private.owned_privacy_fulfillment
      where privacy_request_id=_privacy_request and store=_store order by recorded_at desc,id desc limit 1;
    if not found or _receipt.outcome not in ('purged','not_applicable','retained_by_policy') or _receipt.evidence_sha256 is null
      or _receipt.fulfillment_version is distinct from 'privacy-fulfillment/2' then
      raise exception using errcode='40001',message='privacy_request_store_pending';
    end if;
    if _receipt.outcome='retained_by_policy' then
      _policy:=clinical_private.verified_owned_retention_policy(_receipt.retention_policy_version);
      if _receipt.retention_policy_sha256 is distinct from _policy.content_sha256 then
        raise exception using errcode='42501',message='retention_policy_required';
      end if;
    end if;
  end loop;
  update clinical_private.owned_privacy_requests set status='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp(),
    completed_by=clinical_private.privacy_operator() where id=_privacy_request;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_request.owner_id,'privacy_request.completed','privacy');
  return clinical_private.owned_privacy_request_json(_request.owner_id,_privacy_request);
end $$;

create function clinical_private.purge_owned_personal_history(_privacy_request uuid,_policy_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _before bigint; _result jsonb;
begin
  perform clinical_private.lock_owned_privacy_request(_privacy_request);
  perform clinical_private.verified_owned_retention_policy(_policy_version);
  select coalesce(max(id),0) into _before from clinical_private.owned_privacy_fulfillment where privacy_request_id=_privacy_request;
  _result:=clinical_private.purge_owned_personal_history_v1(_privacy_request,_policy_version);
  update clinical_private.owned_privacy_fulfillment set fulfillment_version='privacy-fulfillment/2'
    where privacy_request_id=_privacy_request and id>_before;
  return _result;
end $$;

revoke all on function clinical_private.privacy_operator_for_owner(uuid),clinical_private.lock_owned_privacy_request(uuid,boolean),
  clinical_private.verified_owned_retention_policy(text),clinical_private.place_owned_legal_hold(uuid,text),
  clinical_private.release_owned_legal_hold(uuid),clinical_private.record_owned_privacy_fulfillment(uuid,text,text,text),
  clinical_private.record_owned_privacy_retention(uuid,text,text,text),clinical_private.complete_owned_privacy_request(uuid),
  clinical_private.purge_owned_personal_history(uuid,text) from public,clinical_core_api;
grant execute on function clinical_private.place_owned_legal_hold(uuid,text),clinical_private.release_owned_legal_hold(uuid),
  clinical_private.record_owned_privacy_fulfillment(uuid,text,text,text),clinical_private.record_owned_privacy_retention(uuid,text,text,text),
  clinical_private.complete_owned_privacy_request(uuid),clinical_private.purge_owned_personal_history(uuid,text) to clinical_core_api;
