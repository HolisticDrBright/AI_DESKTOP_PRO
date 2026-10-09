-- Authenticated consent workspace and retry-safe roster commands. No seeds.
create table clinical_private.recording_participant_commands (
  encounter_id uuid not null references clinical_private.recording_controls(encounter_id),
  command_id uuid not null,
  participant_id uuid not null unique references clinical_private.recording_participants(id),
  primary key(encounter_id,command_id)
);
alter table clinical_private.recording_participant_commands enable row level security;
alter table clinical_private.recording_participant_commands force row level security;
revoke all on clinical_private.recording_participant_commands from public,clinical_core_api;
create trigger recording_participant_commands_immutable before update or delete on clinical_private.recording_participant_commands
  for each row execute function clinical_private.block_update_delete();

create table clinical_private.recording_access_events (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references clinical_core.encounters(id),
  actor_id uuid not null references clinical_core.persons(id),
  action text not null check(action in ('workspace.read','consent_release.read')),
  release_id uuid references clinical_private.recording_consent_releases(id),
  occurred_at timestamptz not null default clock_timestamp(),
  check((action='workspace.read' and release_id is null) or (action='consent_release.read' and release_id is not null))
);
create index recording_access_encounter on clinical_private.recording_access_events(encounter_id,occurred_at,id);
create index recording_access_actor on clinical_private.recording_access_events(actor_id);
create index recording_access_release on clinical_private.recording_access_events(release_id) where release_id is not null;
alter table clinical_private.recording_access_events enable row level security;
alter table clinical_private.recording_access_events force row level security;
revoke all on clinical_private.recording_access_events from public,clinical_core_api;
create trigger recording_access_events_immutable before update or delete on clinical_private.recording_access_events
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.add_encounter_recording_participant(_encounter uuid,_kind text,_name text,_self boolean,_command uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters; _p clinical_private.recording_participants; _id uuid;
begin
  _e:=clinical_private.lock_recording_encounter(_encounter);
  if _command is null then raise exception using errcode='22023',message='recording_participant_invalid'; end if;
  select p.* into _p from clinical_private.recording_participant_commands c
    join clinical_private.recording_participants p on p.id=c.participant_id
    where c.encounter_id=_encounter and c.command_id=_command;
  if found then
    if _p.created_by is distinct from clinical_private.actor_person_id() or _p.kind is distinct from _kind
      or _p.display_name is distinct from btrim(_name) or _p.can_self_consent is distinct from _self then
      raise exception using errcode='40001',message='recording_participant_conflict'; end if;
    return _p.id; -- receipt only; does not add a participant or bump the epoch again
  end if;
  _id:=clinical_private.add_encounter_recording_participant(_encounter,_kind,_name,_self);
  insert into clinical_private.recording_participant_commands values(_encounter,_command,_id);
  return _id;
end $$;
revoke all on function clinical_private.add_encounter_recording_participant(uuid,text,text,boolean) from clinical_core_api;
revoke all on function clinical_private.add_encounter_recording_participant(uuid,text,text,boolean,uuid) from public;
grant execute on function clinical_private.add_encounter_recording_participant(uuid,text,text,boolean,uuid) to clinical_core_api;

-- Read authorization does not create controls or acquire the write lock.
create function clinical_private.read_recording_encounter(_encounter uuid)
returns clinical_core.encounters language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters;
begin
  select * into _e from clinical_core.encounters where id=_encounter and deleted_at is null;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  perform clinical_private.require_clinical_patient(_e.organization_id,_e.patient_record_id);
  return _e;
end $$;
revoke all on function clinical_private.read_recording_encounter(uuid) from public,clinical_core_api;

create function clinical_private.get_encounter_recording_workspace(_encounter uuid,_locale text,_jurisdiction text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters; _participants jsonb; _releases jsonb; _capture jsonb;
begin
  _e:=clinical_private.read_recording_encounter(_encounter);
  if length(btrim(coalesce(_locale,''))) not between 2 and 20 or length(btrim(coalesce(_jurisdiction,''))) not between 1 and 80 then
    raise exception using errcode='22023',message='recording_workspace_invalid'; end if;
  -- Exactly one current document per scope for the explicitly requested locale
  -- and jurisdiction. No locale/jurisdiction fallback or content approximation.
  select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'scope',d.scope,'version',d.version,
      'locale',d.locale,'jurisdiction',d.jurisdiction,'contentSha256',d.content_sha256) order by d.scope),'[]'::jsonb)
    into _releases from (
      select distinct on (scope) * from clinical_private.recording_consent_releases
      where organization_id=_e.organization_id and locale=_locale and jurisdiction=_jurisdiction
        and retired_at is null and approved_at<=clock_timestamp()
        and content_sha256=encode(public.digest(content,'sha256'),'hex')
      order by scope,approved_at desc,id desc
    ) d;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'displayName',p.display_name,
      'canSelfConsent',p.can_self_consent,'joinedAt',p.joined_at,'consents',(
        select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'scope',g.scope,'releaseId',g.release_id,
          'status',case when g.withdrawn_at is null then 'granted' else 'withdrawn' end,
          'effective',g.withdrawn_at is null and g.retired_at is null and g.approved_at<=clock_timestamp()
            and g.content_sha256=encode(public.digest(g.content,'sha256'),'hex')
            and ((p.can_self_consent and g.representative_authority_id is null) or exists(
              select 1 from clinical_private.recording_representative_authorities a
              where a.id=g.representative_authority_id and a.participant_id=p.id and a.revoked_at is null
                and a.reviewed_at<=clock_timestamp() and a.expires_at>clock_timestamp())),
          'grantedAt',g.granted_at,'withdrawnAt',g.withdrawn_at) order by g.scope),'[]'::jsonb)
        from (select distinct on (d.scope) g.*,d.scope,d.retired_at,d.approved_at,d.content,d.content_sha256,w.withdrawn_at
          from clinical_private.recording_consent_grants g
          join clinical_private.recording_consent_releases d on d.id=g.release_id
          left join clinical_private.recording_consent_withdrawals w on w.grant_id=g.id
          where g.participant_id=p.id order by d.scope,g.granted_at desc,g.id desc) g
      )) order by p.joined_at,p.id),'[]'::jsonb) into _participants
    from clinical_private.recording_participants p where p.encounter_id=_encounter;
  select jsonb_build_object('id',id,'sessionId',capture_session_id,'status',status,
    'createdAt',created_at,'authorityEpoch',authority_epoch,'deletionDeadline',deletion_deadline)
    into _capture from clinical_private.encounter_captures where encounter_id=_encounter and status<>'closed';
  insert into clinical_private.recording_access_events(encounter_id,actor_id,action)
    values(_encounter,clinical_private.actor_person_id(),'workspace.read');
  return jsonb_build_object('encounterId',_encounter,'encounterStatus',_e.status,
    'participants',_participants,'consentReleases',_releases,'activeCapture',_capture);
end $$;

create function clinical_private.read_encounter_recording_consent_release(_encounter uuid,_release uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters; _d clinical_private.recording_consent_releases;
begin
  _e:=clinical_private.read_recording_encounter(_encounter);
  select * into _d from clinical_private.recording_consent_releases where id=_release and organization_id=_e.organization_id
    and retired_at is null and approved_at<=clock_timestamp()
    and content_sha256=encode(public.digest(content,'sha256'),'hex');
  if not found then raise exception using errcode='55000',message='recording_consent_release_required'; end if;
  insert into clinical_private.recording_access_events(encounter_id,actor_id,action,release_id)
    values(_encounter,clinical_private.actor_person_id(),'consent_release.read',_release);
  return jsonb_build_object('id',_d.id,'scope',_d.scope,'version',_d.version,'locale',_d.locale,
    'jurisdiction',_d.jurisdiction,'contentSha256',_d.content_sha256,'content',_d.content);
end $$;
revoke all on function clinical_private.get_encounter_recording_workspace(uuid,text,text),
  clinical_private.read_encounter_recording_consent_release(uuid,uuid) from public;
grant execute on function clinical_private.get_encounter_recording_workspace(uuid,text,text),
  clinical_private.read_encounter_recording_consent_release(uuid,uuid) to clinical_core_api;
