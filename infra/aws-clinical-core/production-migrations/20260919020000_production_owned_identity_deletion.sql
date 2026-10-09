-- Consumer identity deletion as the final reviewed step of an owner deletion.
-- The database identity is disabled before any provider call, so a partial
-- failure leaves the account locked rather than half-deleted. Fulfillment is
-- recorded only after the provider confirmed deletion or reported the user
-- absent. No assignments, approvals or activation are seeded.
alter table clinical_audit.consumer_storage_events drop constraint consumer_storage_events_action_check;
alter table clinical_audit.consumer_storage_events add constraint consumer_storage_events_action_check check(action in (
  'consent.granted','consent.revoked','record.written','record.deleted','records.listed',
  'active_plan.adopted','active_plan.released','active_plan.record_deleted',
  'privacy_request.submitted','privacy_request.held','privacy_request.fulfillment','privacy_request.completed',
  'privacy_request.tombstoned','privacy_request.purged','legal_hold.placed','legal_hold.released','privacy_request.inventory','privacy_request.external_purge','privacy_request.identity'));

create table clinical_private.owned_identity_deletions(
  privacy_request_id uuid primary key references clinical_private.owned_privacy_requests(id),
  owner_id uuid not null references clinical_core.persons(id),
  identity_subject text not null check(identity_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
  begun_by uuid not null references clinical_core.persons(id),
  begun_at timestamptz not null default clock_timestamp(),
  provider_state text not null default 'disabled' check(provider_state in ('disabled','signed_out','deleted','absent')),
  attempts integer not null default 1 check(attempts between 1 and 1000),
  completed_at timestamptz,
  evidence_sha256 text check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  check((completed_at is null)=(evidence_sha256 is null)),
  check(completed_at is null or provider_state in ('deleted','absent'))
);
alter table clinical_private.owned_identity_deletions enable row level security;
alter table clinical_private.owned_identity_deletions force row level security;
revoke all on clinical_private.owned_identity_deletions from public,clinical_core_api;

create function clinical_private.identity_deletion_summary(_d clinical_private.owned_identity_deletions)
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('privacyRequestId',_d.privacy_request_id,'providerState',_d.provider_state,'attempts',_d.attempts,
    'begunAt',_d.begun_at,'completedAt',_d.completed_at,'evidenceSha256',_d.evidence_sha256,'completeAccountDeletion',false)
$$;

-- Identity is last: every other store must already carry an accepted terminal
-- receipt. Disabling the database identity here is what stops further consumer
-- reads and writes even if the provider call never completes.
create function clinical_private.begin_owned_identity_deletion(_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.owned_privacy_requests; _store text; _receipt clinical_private.owned_privacy_fulfillment;
  _identity clinical_core.identities; _d clinical_private.owned_identity_deletions; _operator uuid;
begin
  _r:=clinical_private.lock_owned_privacy_request(_request_id,false);
  _operator:=clinical_private.privacy_operator();
  if _r.kind<>'deletion' then raise exception using errcode='22023',message='identity_deletion_invalid'; end if;
  foreach _store in array array['personal_records','personal_consents','active_plan','lab_jobs_and_documents',
    'voice_jobs_and_transcripts','clinic_records','device_caches_and_recovery_archives','backups_and_audit'] loop
    select * into _receipt from clinical_private.owned_privacy_fulfillment
      where privacy_request_id=_request_id and store=_store order by recorded_at desc,id desc limit 1;
    if not found or _receipt.outcome not in ('purged','not_applicable','retained_by_policy') or _receipt.evidence_sha256 is null
      or _receipt.fulfillment_version is distinct from 'privacy-fulfillment/2' then
      raise exception using errcode='40001',message='privacy_request_store_pending';
    end if;
  end loop;
  select * into _d from clinical_private.owned_identity_deletions where privacy_request_id=_request_id for update;
  if found then
    if _d.completed_at is null then
      update clinical_private.owned_identity_deletions set attempts=least(attempts+1,1000) where privacy_request_id=_request_id returning * into _d;
    end if;
    return clinical_private.identity_deletion_summary(_d)||jsonb_build_object('ownerId',_d.owner_id,'identitySubject',_d.identity_subject);
  end if;
  select * into _identity from clinical_core.identities where person_id=_r.owner_id and identity_pool='consumer' for update;
  if not found then raise exception using errcode='22023',message='identity_missing'; end if;
  update clinical_core.identities set status='disabled' where id=_identity.id;
  insert into clinical_private.owned_identity_deletions(privacy_request_id,owner_id,identity_subject,begun_by)
    values(_request_id,_r.owner_id,_identity.identity_subject,_operator) returning * into _d;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_r.owner_id,'privacy_request.identity','privacy');
  return clinical_private.identity_deletion_summary(_d)||jsonb_build_object('ownerId',_d.owner_id,'identitySubject',_d.identity_subject);
end $$;

-- Provider progress is recorded in order; deletion or absence completes the
-- store with the identity fulfillment. Absence records not_applicable because
-- nothing existed to delete; a completed row never changes again.
create function clinical_private.record_owned_identity_deletion(_request_id uuid,_provider_state text,_evidence text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.owned_privacy_requests; _d clinical_private.owned_identity_deletions; _rank int; _current int;
begin
  _r:=clinical_private.lock_owned_privacy_request(_request_id,true);
  select * into _d from clinical_private.owned_identity_deletions where privacy_request_id=_request_id for update;
  if not found or _provider_state is null or _provider_state not in ('disabled','signed_out','deleted','absent')
    or _evidence is null or _evidence !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='identity_deletion_invalid';
  end if;
  if _d.completed_at is not null then return clinical_private.identity_deletion_summary(_d); end if;
  _rank:=case _provider_state when 'disabled' then 1 when 'signed_out' then 2 else 3 end;
  _current:=case _d.provider_state when 'disabled' then 1 when 'signed_out' then 2 else 3 end;
  if _rank<_current then raise exception using errcode='40001',message='identity_deletion_conflict'; end if;
  if _provider_state in ('deleted','absent') then
    if _r.status='held' or exists(select 1 from clinical_private.owned_legal_holds where owner_id=_r.owner_id and released_at is null) then
      raise exception using errcode='42501',message='privacy_request_held';
    end if;
    update clinical_private.owned_identity_deletions set provider_state=_provider_state,completed_at=clock_timestamp(),evidence_sha256=_evidence
      where privacy_request_id=_request_id returning * into _d;
    perform clinical_private.record_owned_privacy_fulfillment(_request_id,'identity',
      case when _provider_state='deleted' then 'purged' else 'not_applicable' end,_evidence);
  else
    update clinical_private.owned_identity_deletions set provider_state=_provider_state where privacy_request_id=_request_id returning * into _d;
  end if;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_r.owner_id,'privacy_request.identity','privacy');
  return clinical_private.identity_deletion_summary(_d);
end $$;

revoke all on function clinical_private.identity_deletion_summary(clinical_private.owned_identity_deletions),
  clinical_private.begin_owned_identity_deletion(uuid),
  clinical_private.record_owned_identity_deletion(uuid,text,text) from public;
grant execute on function clinical_private.begin_owned_identity_deletion(uuid),
  clinical_private.record_owned_identity_deletion(uuid,text,text) to clinical_core_api;
