-- Authoritative, owner-scoped active personal plan pointer with append-only
-- lineage. Adoption is a server-validated, idempotent transition from an
-- expected predecessor to an exact immutable record revision; deletion of the
-- adopted record clears the pointer in the same transaction. This creates no
-- plan, consent, identity or clinical row and does not approve any content.

create table clinical_core.owned_consumer_active_plans (
  owner_id uuid primary key references clinical_core.persons(id),
  record_id uuid not null,
  revision integer not null check (revision>=1),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  consent_revision integer not null check (consent_revision>=1),
  adopted_at timestamptz not null,
  adoption_request_id uuid not null,
  supersedes_record_id uuid,
  supersedes_revision integer check (supersedes_revision is null or supersedes_revision>=1),
  check ((supersedes_record_id is null)=(supersedes_revision is null))
);
create table clinical_core.owned_consumer_active_plan_history (
  id bigint generated always as identity primary key,
  owner_id uuid not null references clinical_core.persons(id),
  action text not null check (action in ('adopted','released','record_deleted')),
  request_id uuid not null,
  record_id uuid not null,
  revision integer not null check (revision>=1),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[a-f0-9]{64}$'),
  consent_revision integer check (consent_revision is null or consent_revision>=1),
  previous_record_id uuid,
  previous_revision integer,
  recorded_at timestamptz not null default clock_timestamp(),
  unique(owner_id, request_id)
);
create index owned_consumer_active_plan_history_owner_time on clinical_core.owned_consumer_active_plan_history(owner_id, recorded_at, id);

alter table clinical_core.owned_consumer_active_plans enable row level security;
alter table clinical_core.owned_consumer_active_plans force row level security;
alter table clinical_core.owned_consumer_active_plan_history enable row level security;
alter table clinical_core.owned_consumer_active_plan_history force row level security;
create policy owned_active_plan_owner on clinical_core.owned_consumer_active_plans for select to clinical_core_api
  using (owner_id=(select clinical_private.owned_consumer_actor()) and
    clinical_private.owned_consumer_consent(owner_id,'protocols_supplements') is not null);
create policy owned_active_plan_history_owner on clinical_core.owned_consumer_active_plan_history for select to clinical_core_api
  using (owner_id=(select clinical_private.owned_consumer_actor()) and
    clinical_private.owned_consumer_consent(owner_id,'protocols_supplements') is not null);

alter table clinical_audit.consumer_storage_events drop constraint if exists consumer_storage_events_action_check;
alter table clinical_audit.consumer_storage_events add constraint consumer_storage_events_action_check check (action in (
  'consent.granted','consent.revoked','record.written','record.deleted','records.listed',
  'active_plan.adopted','active_plan.released','active_plan.record_deleted'));

create function clinical_private.owned_active_plan_json(_owner uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'current',(select jsonb_build_object('recordId',p.record_id,'revision',p.revision,'contentSha256',p.content_sha256,
        'consentRevision',p.consent_revision,'adoptedAt',p.adopted_at,'adoptionRequestId',p.adoption_request_id,
        'supersedes',case when p.supersedes_record_id is null then null
          else jsonb_build_object('recordId',p.supersedes_record_id,'revision',p.supersedes_revision) end)
      from clinical_core.owned_consumer_active_plans p where p.owner_id=_owner),
    'history',(select coalesce(jsonb_agg(jsonb_build_object('action',h.action,'requestId',h.request_id,'recordId',h.record_id,
        'revision',h.revision,'previousRecordId',h.previous_record_id,'previousRevision',h.previous_revision,'recordedAt',h.recorded_at)
        order by h.recorded_at desc,h.id desc),'[]'::jsonb)
      from (select * from clinical_core.owned_consumer_active_plan_history where owner_id=_owner order by recorded_at desc,id desc limit 100) h),
    'historyLimit',100)
$$;

create function clinical_core.get_owned_active_plan()
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor();
begin
  if clinical_private.claim('purpose') is distinct from 'clinical_data' then
    raise exception using errcode='22023',message='active_plan_request_invalid';
  end if;
  if clinical_private.owned_consumer_consent(_actor,'protocols_supplements') is null then
    raise exception using errcode='42501',message='consumer_storage_consent_required';
  end if;
  return clinical_private.owned_active_plan_json(_actor);
end $$;

-- Adoption binds an exact immutable record revision. The record must be the
-- owner's latest, non-deleted protocols revision; the predecessor must match
-- the current pointer exactly (or be absent); the request is idempotent.
create function clinical_core.adopt_owned_active_plan(
  _record_id uuid,_revision integer,_content_sha256 text,_consent_revision integer,_request_id uuid,
  _expected_record_id uuid,_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _current clinical_core.owned_consumer_active_plans;
  _previous clinical_core.owned_consumer_active_plan_history; _latest integer; _deleted boolean; _now timestamptz:=clock_timestamp();
begin
  if clinical_private.claim('purpose') is distinct from 'clinical_data'
    or _record_id is null or _revision is null or _revision<1 or _request_id is null
    or _content_sha256 is null or _content_sha256 !~ '^[a-f0-9]{64}$'
    or _consent_revision is null or _consent_revision<1
    or ((_expected_record_id is null)<>(_expected_revision is null))
    or (_expected_revision is not null and _expected_revision<1) then
    raise exception using errcode='22023',message='active_plan_request_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  if clinical_private.owned_consumer_consent(_actor,'protocols_supplements') is distinct from _consent_revision then
    raise exception using errcode='42501',message='consumer_storage_consent_required';
  end if;
  select * into _previous from clinical_core.owned_consumer_active_plan_history where owner_id=_actor and request_id=_request_id;
  if found then
    if _previous.action<>'adopted' or _previous.record_id<>_record_id or _previous.revision<>_revision then
      raise exception using errcode='40001',message='active_plan_idempotency_conflict';
    end if;
    return clinical_private.owned_active_plan_json(_actor)||jsonb_build_object('duplicate',true);
  end if;
  select max(revision) into _latest from clinical_core.owned_consumer_record_versions
    where owner_id=_actor and collection='protocols' and record_id=_record_id;
  if _latest is null then
    raise exception using errcode='40001',message='active_plan_record_missing';
  end if;
  if _latest<>_revision then
    raise exception using errcode='40001',message='active_plan_record_stale';
  end if;
  select deleted into _deleted from clinical_core.owned_consumer_record_versions
    where owner_id=_actor and collection='protocols' and record_id=_record_id and revision=_revision;
  if _deleted then
    raise exception using errcode='40001',message='active_plan_record_deleted';
  end if;
  select * into _current from clinical_core.owned_consumer_active_plans where owner_id=_actor;
  if (found and (_expected_record_id is null or _current.record_id<>_expected_record_id or _current.revision<>_expected_revision))
    or (not found and _expected_record_id is not null) then
    raise exception using errcode='40001',message='active_plan_predecessor_conflict';
  end if;
  if found and _current.record_id=_record_id and _current.revision=_revision then
    raise exception using errcode='40001',message='active_plan_already_adopted';
  end if;
  insert into clinical_core.owned_consumer_active_plan_history
    (owner_id,action,request_id,record_id,revision,content_sha256,consent_revision,previous_record_id,previous_revision)
    values(_actor,'adopted',_request_id,_record_id,_revision,_content_sha256,_consent_revision,_expected_record_id,_expected_revision);
  insert into clinical_core.owned_consumer_active_plans
    (owner_id,record_id,revision,content_sha256,consent_revision,adopted_at,adoption_request_id,supersedes_record_id,supersedes_revision)
    values(_actor,_record_id,_revision,_content_sha256,_consent_revision,_now,_request_id,_expected_record_id,_expected_revision)
    on conflict (owner_id) do update set record_id=excluded.record_id,revision=excluded.revision,content_sha256=excluded.content_sha256,
      consent_revision=excluded.consent_revision,adopted_at=excluded.adopted_at,adoption_request_id=excluded.adoption_request_id,
      supersedes_record_id=excluded.supersedes_record_id,supersedes_revision=excluded.supersedes_revision;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope,collection,record_id,revision)
    values(_actor,'active_plan.adopted','protocols_supplements','protocols',_record_id,_revision);
  return clinical_private.owned_active_plan_json(_actor)||jsonb_build_object('duplicate',false);
end $$;

create function clinical_core.release_owned_active_plan(_request_id uuid,_expected_record_id uuid,_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _current clinical_core.owned_consumer_active_plans;
  _previous clinical_core.owned_consumer_active_plan_history;
begin
  if clinical_private.claim('purpose') is distinct from 'clinical_data'
    or _request_id is null or _expected_record_id is null or _expected_revision is null or _expected_revision<1 then
    raise exception using errcode='22023',message='active_plan_request_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  if clinical_private.owned_consumer_consent(_actor,'protocols_supplements') is null then
    raise exception using errcode='42501',message='consumer_storage_consent_required';
  end if;
  select * into _previous from clinical_core.owned_consumer_active_plan_history where owner_id=_actor and request_id=_request_id;
  if found then
    if _previous.action<>'released' or _previous.record_id<>_expected_record_id or _previous.revision<>_expected_revision then
      raise exception using errcode='40001',message='active_plan_idempotency_conflict';
    end if;
    return clinical_private.owned_active_plan_json(_actor)||jsonb_build_object('duplicate',true);
  end if;
  select * into _current from clinical_core.owned_consumer_active_plans where owner_id=_actor;
  if not found or _current.record_id<>_expected_record_id or _current.revision<>_expected_revision then
    raise exception using errcode='40001',message='active_plan_predecessor_conflict';
  end if;
  insert into clinical_core.owned_consumer_active_plan_history
    (owner_id,action,request_id,record_id,revision,previous_record_id,previous_revision)
    values(_actor,'released',_request_id,_current.record_id,_current.revision,_current.record_id,_current.revision);
  delete from clinical_core.owned_consumer_active_plans where owner_id=_actor;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope,collection,record_id,revision)
    values(_actor,'active_plan.released','protocols_supplements','protocols',_current.record_id,_current.revision);
  return clinical_private.owned_active_plan_json(_actor)||jsonb_build_object('duplicate',false);
end $$;

-- Deletion reconciliation: a tombstone of the adopted protocols record clears
-- the pointer in the same transaction, with attributable lineage.
create function clinical_private.owned_active_plan_on_delete()
returns trigger language plpgsql security definer set search_path='' as $$
declare _current clinical_core.owned_consumer_active_plans;
begin
  if new.deleted and new.collection='protocols' then
    select * into _current from clinical_core.owned_consumer_active_plans where owner_id=new.owner_id and record_id=new.record_id;
    if found then
      insert into clinical_core.owned_consumer_active_plan_history
        (owner_id,action,request_id,record_id,revision,previous_record_id,previous_revision)
        values(new.owner_id,'record_deleted',new.request_id,_current.record_id,_current.revision,_current.record_id,_current.revision);
      delete from clinical_core.owned_consumer_active_plans where owner_id=new.owner_id;
      insert into clinical_audit.consumer_storage_events(owner_id,action,scope,collection,record_id,revision)
        values(new.owner_id,'active_plan.record_deleted','protocols_supplements','protocols',_current.record_id,_current.revision);
    end if;
  end if;
  return new;
end $$;
create trigger owned_active_plan_record_deleted after insert on clinical_core.owned_consumer_record_versions
  for each row execute function clinical_private.owned_active_plan_on_delete();

revoke all on clinical_core.owned_consumer_active_plans,clinical_core.owned_consumer_active_plan_history from public,clinical_core_api;
grant select on clinical_core.owned_consumer_active_plans,clinical_core.owned_consumer_active_plan_history to clinical_core_api;
revoke all on function clinical_private.owned_active_plan_json(uuid),clinical_private.owned_active_plan_on_delete(),
  clinical_core.get_owned_active_plan(),
  clinical_core.adopt_owned_active_plan(uuid,integer,text,integer,uuid,uuid,integer),
  clinical_core.release_owned_active_plan(uuid,uuid,integer) from public;
grant execute on function clinical_core.get_owned_active_plan(),
  clinical_core.adopt_owned_active_plan(uuid,integer,text,integer,uuid,uuid,integer),
  clinical_core.release_owned_active_plan(uuid,uuid,integer) to clinical_core_api;
