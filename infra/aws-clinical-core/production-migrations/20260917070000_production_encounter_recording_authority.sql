-- Encounter recording authority. No records, approvals, provider activation or
-- audio objects are seeded. Transport/transcription/deletion workers are separate.
create table clinical_private.recording_controls (
  encounter_id uuid primary key,
  organization_id uuid not null,
  patient_record_id uuid not null,
  authority_epoch bigint not null default 0 check(authority_epoch>=0),
  foreign key(encounter_id,organization_id,patient_record_id)
    references clinical_core.encounters(id,organization_id,patient_record_id)
);
create table clinical_private.recording_consent_releases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  scope text not null check(scope in ('recording','transcription','ai_drafting')),
  version text not null check(length(version) between 1 and 80),
  locale text not null check(length(locale) between 2 and 20),
  jurisdiction text not null check(length(jurisdiction) between 1 and 80),
  content text not null check(length(content) between 1 and 32768),
  content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by text not null check(length(btrim(approved_by)) between 1 and 200),
  approved_at timestamptz not null,
  retired_at timestamptz,
  unique(organization_id,scope,version,locale,jurisdiction)
);
create table clinical_private.recording_participants (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references clinical_private.recording_controls(encounter_id),
  kind text not null check(kind in ('patient','practitioner','caregiver','other')),
  display_name text not null check(length(btrim(display_name)) between 1 and 200),
  can_self_consent boolean not null,
  created_by uuid not null references clinical_core.persons(id),
  joined_at timestamptz not null default clock_timestamp(),
  unique(id,encounter_id)
);
create index recording_participants_encounter on clinical_private.recording_participants(encounter_id,id);
-- Evidence reviewed outside the ordinary consent-entry operation. An API caller
-- cannot manufacture representative authority by supplying free text.
create table clinical_private.recording_representative_authorities (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references clinical_private.recording_participants(id),
  basis text not null check(basis in ('minor_guardian','legal_authorized_representative','surrogate_unable_to_consent')),
  representative_name text not null check(length(btrim(representative_name)) between 1 and 200),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_by uuid not null references clinical_core.persons(id),
  reviewed_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check(expires_at>reviewed_at)
);
create index recording_authorities_participant on clinical_private.recording_representative_authorities(participant_id);
create table clinical_private.recording_consent_grants (
  id uuid primary key default gen_random_uuid(),
  command_id uuid not null,
  participant_id uuid not null references clinical_private.recording_participants(id),
  release_id uuid not null references clinical_private.recording_consent_releases(id),
  method text not null check(method in ('verbal_attested','written','electronic_signature')),
  acknowledgment text not null check(length(btrim(acknowledgment)) between 1 and 2000),
  representative_authority_id uuid references clinical_private.recording_representative_authorities(id),
  granted_by uuid not null references clinical_core.persons(id),
  granted_at timestamptz not null default clock_timestamp(),
  unique(participant_id,command_id)
);
create index recording_grants_release on clinical_private.recording_consent_grants(release_id);
create table clinical_private.recording_consent_withdrawals (
  grant_id uuid primary key references clinical_private.recording_consent_grants(id),
  withdrawn_by uuid not null references clinical_core.persons(id),
  withdrawn_at timestamptz not null default clock_timestamp(),
  reason text not null check(length(btrim(reason)) between 1 and 1000)
);
-- Operator-reviewed configuration, not a user-selectable provider. Its digest
-- binds all transport/retention values. Absence, expiry or retirement refuses.
create table clinical_private.recording_capture_releases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  configuration jsonb not null check(jsonb_typeof(configuration)='object'),
  configuration_sha256 text not null check(configuration_sha256 ~ '^[a-f0-9]{64}$'),
  qualification_sha256 text not null check(qualification_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by text not null check(length(btrim(approved_by)) between 1 and 200),
  approved_at timestamptz not null,
  expires_at timestamptz not null,
  retired_at timestamptz,
  check(expires_at>approved_at)
);
create index recording_capture_release_org on clinical_private.recording_capture_releases(organization_id);
create table clinical_private.encounter_captures (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references clinical_private.recording_controls(encounter_id),
  capture_session_id uuid not null unique default gen_random_uuid(),
  command_id uuid not null,
  release_id uuid not null references clinical_private.recording_capture_releases(id),
  created_by uuid not null references clinical_core.persons(id),
  content_type text not null check(content_type in ('audio/webm','audio/ogg','audio/wav','audio/mp4','audio/mpeg')),
  status text not null check(status in ('capturing','paused','revoked','closed')),
  authority_epoch bigint not null,
  participant_ids uuid[] not null check(cardinality(participant_ids)>0),
  recording_grant_ids uuid[] not null check(cardinality(recording_grant_ids)>0),
  token_sha256 text not null check(token_sha256 ~ '^[a-f0-9]{64}$'),
  token_expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  last_authorized_at timestamptz not null default clock_timestamp(),
  deletion_deadline timestamptz not null,
  unique(encounter_id,command_id)
);
create unique index encounter_capture_one_open on clinical_private.encounter_captures(encounter_id)
  where status in ('capturing','paused','revoked');
create table clinical_private.recording_authority_events (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references clinical_private.recording_controls(encounter_id),
  actor_id uuid not null references clinical_core.persons(id),
  action text not null check(action in ('participant.added','consent.granted','consent.withdrawn','capture.started','capture.paused','capture.resumed')),
  resource_id uuid not null,
  authority_epoch bigint not null,
  created_at timestamptz not null default clock_timestamp()
);
create index recording_authority_events_encounter on clinical_private.recording_authority_events(encounter_id,created_at,id);

alter table clinical_private.recording_controls enable row level security;
alter table clinical_private.recording_controls force row level security;
alter table clinical_private.recording_consent_releases enable row level security;
alter table clinical_private.recording_consent_releases force row level security;
alter table clinical_private.recording_participants enable row level security;
alter table clinical_private.recording_participants force row level security;
alter table clinical_private.recording_representative_authorities enable row level security;
alter table clinical_private.recording_representative_authorities force row level security;
alter table clinical_private.recording_consent_grants enable row level security;
alter table clinical_private.recording_consent_grants force row level security;
alter table clinical_private.recording_consent_withdrawals enable row level security;
alter table clinical_private.recording_consent_withdrawals force row level security;
alter table clinical_private.recording_capture_releases enable row level security;
alter table clinical_private.recording_capture_releases force row level security;
alter table clinical_private.encounter_captures enable row level security;
alter table clinical_private.encounter_captures force row level security;
alter table clinical_private.recording_authority_events enable row level security;
alter table clinical_private.recording_authority_events force row level security;
revoke all on clinical_private.recording_controls,clinical_private.recording_consent_releases,
  clinical_private.recording_participants,clinical_private.recording_representative_authorities,
  clinical_private.recording_consent_grants,clinical_private.recording_consent_withdrawals,
  clinical_private.recording_capture_releases,clinical_private.encounter_captures,
  clinical_private.recording_authority_events from public,clinical_core_api;

create trigger recording_grants_immutable before update or delete on clinical_private.recording_consent_grants
  for each row execute function clinical_private.block_update_delete();
create trigger recording_withdrawals_immutable before update or delete on clinical_private.recording_consent_withdrawals
  for each row execute function clinical_private.block_update_delete();
create trigger recording_participants_immutable before update or delete on clinical_private.recording_participants
  for each row execute function clinical_private.block_update_delete();
create trigger recording_events_immutable before update or delete on clinical_private.recording_authority_events
  for each row execute function clinical_private.block_update_delete();
create function clinical_private.guard_recording_release_update() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' or (to_jsonb(new)-'retired_at') is distinct from (to_jsonb(old)-'retired_at')
    or old.retired_at is not null or new.retired_at is null then
    raise exception using errcode='55000',message='recording_release_immutable';
  end if;
  return new;
end $$;
create trigger recording_consent_release_immutable before update or delete on clinical_private.recording_consent_releases
  for each row execute function clinical_private.guard_recording_release_update();
create trigger recording_capture_release_immutable before update or delete on clinical_private.recording_capture_releases
  for each row execute function clinical_private.guard_recording_release_update();

-- Evidence cannot be rewritten or un-revoked underneath an existing grant.
create function clinical_private.guard_recording_authority_update() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' or (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at')
    or old.revoked_at is not null or new.revoked_at is null then
    raise exception using errcode='55000',message='recording_authority_immutable';
  end if;
  return new;
end $$;
create trigger recording_representative_authority_immutable before update or delete on clinical_private.recording_representative_authorities
  for each row execute function clinical_private.guard_recording_authority_update();

-- Single encounter row is the lock root for roster, consent and capture commands.
-- Authorization is checked before acquiring it, then checked again afterward.
create function clinical_private.lock_recording_encounter(_encounter uuid)
returns clinical_core.encounters language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters;
begin
  select * into _e from clinical_core.encounters where id=_encounter and deleted_at is null;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  perform clinical_private.require_clinical_patient(_e.organization_id,_e.patient_record_id);
  select * into _e from clinical_core.encounters where id=_encounter and deleted_at is null for update;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  perform clinical_private.require_clinical_patient(_e.organization_id,_e.patient_record_id);
  insert into clinical_private.recording_controls(encounter_id,organization_id,patient_record_id)
    values(_e.id,_e.organization_id,_e.patient_record_id) on conflict do nothing;
  return _e;
end $$;

create function clinical_private.add_encounter_recording_participant(_encounter uuid,_kind text,_name text,_self boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters; _id uuid; _epoch bigint;
begin
  _e:=clinical_private.lock_recording_encounter(_encounter);
  if _e.status<>'in_progress' or _kind is null or _kind not in ('patient','practitioner','caregiver','other')
    or _self is null or length(btrim(coalesce(_name,''))) not between 1 and 200 then
    raise exception using errcode='22023',message='recording_participant_invalid'; end if;
  if (select count(*) from clinical_private.recording_participants where encounter_id=_encounter)>=20 then
    raise exception using errcode='22023',message='recording_participant_limit'; end if;
  insert into clinical_private.recording_participants(encounter_id,kind,display_name,can_self_consent,created_by)
    values(_encounter,_kind,btrim(_name),_self,clinical_private.actor_person_id()) returning id into _id;
  update clinical_private.recording_controls set authority_epoch=authority_epoch+1 where encounter_id=_encounter returning authority_epoch into _epoch;
  update clinical_private.encounter_captures set status='paused',token_expires_at=clock_timestamp()
    where encounter_id=_encounter and status='capturing';
  insert into clinical_private.recording_authority_events(encounter_id,actor_id,action,resource_id,authority_epoch)
    values(_encounter,clinical_private.actor_person_id(),'participant.added',_id,_epoch);
  return _id;
end $$;

create function clinical_private.grant_encounter_recording_consent(_participant uuid,_release uuid,_command uuid,
  _method text,_ack text,_authority uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare _p clinical_private.recording_participants; _e clinical_core.encounters;
  _d clinical_private.recording_consent_releases; _g clinical_private.recording_consent_grants; _id uuid;
begin
  select * into _p from clinical_private.recording_participants where id=_participant;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  _e:=clinical_private.lock_recording_encounter(_p.encounter_id);
  if _command is null or _method is null or _method not in ('verbal_attested','written','electronic_signature')
    or length(btrim(coalesce(_ack,''))) not between 1 and 2000 then
    raise exception using errcode='22023',message='recording_consent_invalid'; end if;
  select * into _g from clinical_private.recording_consent_grants where participant_id=_participant and command_id=_command;
  if found then
    if _g.release_id is distinct from _release or _g.method<>_method or _g.acknowledgment<>btrim(_ack)
      or _g.representative_authority_id is distinct from _authority or _g.granted_by<>clinical_private.actor_person_id() then
      raise exception using errcode='40001',message='recording_consent_conflict'; end if;
    return _g.id; -- receipt only; never re-grants a withdrawn consent
  end if;
  if _e.status<>'in_progress' then raise exception using errcode='55000',message='recording_encounter_closed'; end if;
  select * into _d from clinical_private.recording_consent_releases where id=_release and organization_id=_e.organization_id
    and retired_at is null and approved_at<=clock_timestamp()
    and content_sha256=encode(public.digest(content,'sha256'),'hex') for share;
  if not found then raise exception using errcode='55000',message='recording_consent_release_required'; end if;
  if (not _p.can_self_consent or _authority is not null) and not exists(
    select 1 from clinical_private.recording_representative_authorities where id=_authority and participant_id=_participant
      and reviewed_at<=clock_timestamp() and expires_at>clock_timestamp() and revoked_at is null) then
    raise exception using errcode='42501',message='recording_representative_authority_required'; end if;
  if exists(select 1 from clinical_private.recording_consent_grants g
    join clinical_private.recording_consent_releases d on d.id=g.release_id
    where g.participant_id=_participant and d.scope=_d.scope
      and not exists(select 1 from clinical_private.recording_consent_withdrawals w where w.grant_id=g.id)) then
    raise exception using errcode='40001',message='recording_consent_already_granted'; end if;
  insert into clinical_private.recording_consent_grants(command_id,participant_id,release_id,method,acknowledgment,representative_authority_id,granted_by)
    values(_command,_participant,_release,_method,btrim(_ack),_authority,clinical_private.actor_person_id()) returning id into _id;
  insert into clinical_private.recording_authority_events(encounter_id,actor_id,action,resource_id,authority_epoch)
    select _e.id,clinical_private.actor_person_id(),'consent.granted',_id,authority_epoch
      from clinical_private.recording_controls where encounter_id=_e.id;
  return _id;
end $$;

create function clinical_private.withdraw_encounter_recording_consent(_grant uuid,_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare _encounter uuid; _e clinical_core.encounters; _epoch bigint;
begin
  select p.encounter_id into _encounter from clinical_private.recording_consent_grants g
    join clinical_private.recording_participants p on p.id=g.participant_id where g.id=_grant;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  _e:=clinical_private.lock_recording_encounter(_encounter);
  if length(btrim(coalesce(_reason,''))) not between 1 and 1000 then
    raise exception using errcode='22023',message='recording_consent_invalid'; end if;
  if exists(select 1 from clinical_private.recording_consent_withdrawals where grant_id=_grant) then return; end if;
  insert into clinical_private.recording_consent_withdrawals(grant_id,withdrawn_by,reason)
    values(_grant,clinical_private.actor_person_id(),btrim(_reason));
  update clinical_private.recording_controls set authority_epoch=authority_epoch+1 where encounter_id=_encounter returning authority_epoch into _epoch;
  -- All scopes revoke technical capture. Re-consent cannot revive old authority.
  update clinical_private.encounter_captures set status='revoked',token_expires_at=clock_timestamp()
    where encounter_id=_encounter and status in ('capturing','paused');
  insert into clinical_private.recording_authority_events(encounter_id,actor_id,action,resource_id,authority_epoch)
    values(_encounter,clinical_private.actor_person_id(),'consent.withdrawn',_grant,_epoch);
end $$;

create function clinical_private.recording_grants_for_scope(_encounter uuid,_scope text,_participants uuid[])
returns uuid[] language plpgsql security definer set search_path='' as $$
declare _ids uuid[]; _count integer;
begin
  if _scope is null or _scope not in ('recording','transcription','ai_drafting') or coalesce(cardinality(_participants),0)=0 then
    raise exception using errcode='55000',message='recording_consent_required'; end if;
  select array_agg(g.id order by p.id),count(distinct p.id) into _ids,_count
    from clinical_private.recording_participants p
    join clinical_private.recording_controls c on c.encounter_id=p.encounter_id
    join clinical_private.recording_consent_grants g on g.participant_id=p.id
    join clinical_private.recording_consent_releases d on d.id=g.release_id
    where p.encounter_id=_encounter and p.id=any(_participants) and d.scope=_scope and d.organization_id=c.organization_id
      and d.retired_at is null and d.approved_at<=clock_timestamp()
      and d.content_sha256=encode(public.digest(d.content,'sha256'),'hex')
      and not exists(select 1 from clinical_private.recording_consent_withdrawals w where w.grant_id=g.id)
      and ((p.can_self_consent and g.representative_authority_id is null) or exists(
        select 1 from clinical_private.recording_representative_authorities a where a.id=g.representative_authority_id
          and a.participant_id=p.id and a.revoked_at is null and a.reviewed_at<=clock_timestamp() and a.expires_at>clock_timestamp()));
  if _count<>cardinality(_participants) or cardinality(_ids)<>cardinality(_participants) then
    raise exception using errcode='55000',message='recording_consent_required'; end if;
  return _ids;
end $$;

create function clinical_private.require_recording_capture_release(_release uuid,_org uuid)
returns clinical_private.recording_capture_releases language plpgsql security definer set search_path='' as $$
declare _r clinical_private.recording_capture_releases; _keys text[];
begin
  select * into _r from clinical_private.recording_capture_releases where id=_release and organization_id=_org
    and retired_at is null and approved_at<=clock_timestamp() and expires_at>clock_timestamp()
    and configuration_sha256=encode(public.digest(configuration::text,'sha256'),'hex') for share;
  if not found then raise exception using errcode='55000',message='recording_capture_release_required'; end if;
  select array_agg(k order by k) into _keys from jsonb_object_keys(_r.configuration) k;
  if _keys is distinct from array['audioRetentionHours','maxRecordingBytes','provider','region']
    or (_r.configuration->>'provider') is distinct from 'aws_healthscribe'
    or coalesce(_r.configuration->>'region','') !~ '^us-(east|west)-[12]$'
    or jsonb_typeof(_r.configuration->'audioRetentionHours')<>'number'
    or jsonb_typeof(_r.configuration->'maxRecordingBytes')<>'number'
    or coalesce(_r.configuration->>'audioRetentionHours','') !~ '^[0-9]+$'
    or coalesce(_r.configuration->>'maxRecordingBytes','') !~ '^[0-9]+$' then
    raise exception using errcode='55000',message='recording_capture_release_required'; end if;
  if (_r.configuration->>'audioRetentionHours')::numeric not between 1 and 24
    or (_r.configuration->>'maxRecordingBytes')::numeric not between 1 and 2147483648 then
    raise exception using errcode='55000',message='recording_capture_release_required'; end if;
  return _r;
end $$;

create function clinical_private.begin_encounter_capture(_encounter uuid,_release uuid,_command uuid,_content_type text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters; _policy clinical_private.recording_capture_releases;
  _r clinical_private.encounter_captures; _participants uuid[]; _grants uuid[]; _token text; _epoch bigint;
begin
  _e:=clinical_private.lock_recording_encounter(_encounter);
  if _e.status<>'in_progress' then raise exception using errcode='55000',message='recording_encounter_closed'; end if;
  if _command is null or _content_type is null or _content_type not in ('audio/webm','audio/ogg','audio/wav','audio/mp4','audio/mpeg') then
    raise exception using errcode='22023',message='recording_capture_invalid'; end if;
  select * into _r from clinical_private.encounter_captures where encounter_id=_encounter and command_id=_command;
  if found then
    if _r.created_by<>clinical_private.actor_person_id() or _r.release_id is distinct from _release or _r.content_type<>_content_type then
      raise exception using errcode='40001',message='recording_capture_conflict'; end if;
    -- Replayed begin is a receipt, never a replayable token or implicit resume.
    return jsonb_build_object('recordingId',_r.id,'sessionId',_r.capture_session_id,'status',_r.status,'replayed',true);
  end if;
  _policy:=clinical_private.require_recording_capture_release(_release,_e.organization_id);
  if exists(select 1 from clinical_private.encounter_captures where encounter_id=_encounter and status<>'closed') then
    raise exception using errcode='55000',message='recording_disposition_required'; end if;
  if not exists(select 1 from clinical_private.recording_participants where encounter_id=_encounter and kind='patient')
    or not exists(select 1 from clinical_private.recording_participants where encounter_id=_encounter and kind='practitioner') then
    raise exception using errcode='55000',message='recording_roster_required'; end if;
  select array_agg(id order by id) into _participants from clinical_private.recording_participants where encounter_id=_encounter;
  _grants:=clinical_private.recording_grants_for_scope(_encounter,'recording',_participants);
  select authority_epoch into _epoch from clinical_private.recording_controls where encounter_id=_encounter;
  _token:=encode(public.gen_random_bytes(32),'hex');
  insert into clinical_private.encounter_captures(encounter_id,command_id,release_id,created_by,content_type,status,
    authority_epoch,participant_ids,recording_grant_ids,token_sha256,token_expires_at,deletion_deadline)
    values(_encounter,_command,_release,clinical_private.actor_person_id(),_content_type,'capturing',_epoch,
      _participants,_grants,encode(public.digest(_token,'sha256'),'hex'),clock_timestamp()+interval '120 seconds',
      clock_timestamp()+make_interval(hours=>(_policy.configuration->>'audioRetentionHours')::integer)) returning * into _r;
  insert into clinical_private.recording_authority_events(encounter_id,actor_id,action,resource_id,authority_epoch)
    values(_encounter,clinical_private.actor_person_id(),'capture.started',_r.id,_epoch);
  return jsonb_build_object('recordingId',_r.id,'sessionId',_r.capture_session_id,'status',_r.status,
    'captureToken',_token,'expiresAt',_r.token_expires_at,'authorityEpoch',_epoch,'replayed',false);
end $$;

-- This verifies control authority, NOT an S3 receipt or successful audio upload.
create function clinical_private.authorize_encounter_capture(_recording uuid,_session uuid,_token text,_scope text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _e clinical_core.encounters; _epoch bigint; _grants uuid[];
begin
  select * into _r from clinical_private.encounter_captures where id=_recording;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  _e:=clinical_private.lock_recording_encounter(_r.encounter_id);
  select * into _r from clinical_private.encounter_captures where id=_recording for update;
  select authority_epoch into _epoch from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  if _e.status<>'in_progress' or _r.created_by<>clinical_private.actor_person_id() or _r.status<>'capturing'
    or _r.capture_session_id is distinct from _session or _r.authority_epoch<>_epoch
    or _token is null or _token !~ '^[a-f0-9]{64}$' or _r.token_sha256<>encode(public.digest(_token,'sha256'),'hex')
    or _r.token_expires_at<=clock_timestamp() or _r.deletion_deadline<=clock_timestamp() then
    raise exception using errcode='42501',message='recording_capture_refused'; end if;
  perform clinical_private.require_recording_capture_release(_r.release_id,_e.organization_id);
  _grants:=clinical_private.recording_grants_for_scope(_r.encounter_id,'recording',_r.participant_ids);
  if _grants is distinct from _r.recording_grant_ids then raise exception using errcode='42501',message='recording_capture_refused'; end if;
  perform clinical_private.recording_grants_for_scope(_r.encounter_id,_scope,_r.participant_ids);
  update clinical_private.encounter_captures set last_authorized_at=clock_timestamp() where id=_recording;
  return jsonb_build_object('recordingId',_r.id,'sessionId',_r.capture_session_id,'authorityEpoch',_epoch,'scope',_scope);
end $$;

revoke all on function clinical_private.guard_recording_release_update(),clinical_private.guard_recording_authority_update(),clinical_private.lock_recording_encounter(uuid),
  clinical_private.recording_grants_for_scope(uuid,text,uuid[]),clinical_private.require_recording_capture_release(uuid,uuid)
  from public,clinical_core_api;
revoke all on function clinical_private.add_encounter_recording_participant(uuid,text,text,boolean),
  clinical_private.grant_encounter_recording_consent(uuid,uuid,uuid,text,text,uuid),
  clinical_private.withdraw_encounter_recording_consent(uuid,text),clinical_private.begin_encounter_capture(uuid,uuid,uuid,text),
  clinical_private.authorize_encounter_capture(uuid,uuid,text,text) from public;
grant execute on function clinical_private.add_encounter_recording_participant(uuid,text,text,boolean),
  clinical_private.grant_encounter_recording_consent(uuid,uuid,uuid,text,text,uuid),
  clinical_private.withdraw_encounter_recording_consent(uuid,text),clinical_private.begin_encounter_capture(uuid,uuid,uuid,text),
  clinical_private.authorize_encounter_capture(uuid,uuid,text,text) to clinical_core_api;
