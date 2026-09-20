-- Production overlay: the recording workspace lists finished recordings so the
-- encounter page can review transcription after a reload. Same authority path,
-- same audit event; grants are unchanged (create or replace keeps them).
create or replace function clinical_private.get_encounter_recording_workspace(_encounter uuid,_locale text,_jurisdiction text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters; _participants jsonb; _releases jsonb; _capture jsonb; _finished jsonb;
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
  -- Finished recordings the encounter can still act on: closed with a finish
  -- disposition, no discard or consent-revoked cleanup, deadline not passed.
  -- Newest first, bounded. No token, object key, bucket or transcript content.
  select coalesce(jsonb_agg(f order by f->>'finishedAt' desc,f->>'id' desc),'[]'::jsonb) into _finished from (
    select jsonb_build_object('id',c.id,'contentType',c.content_type,'createdAt',c.created_at,'finishedAt',d.created_at,
        'deletionDeadline',c.deletion_deadline,'segmentCount',jsonb_array_length(d.inventory),
        'transcription',(select jsonb_build_object('jobId',j.id,'status',j.status) from clinical_private.recording_transcription_jobs j
          where j.recording_id=c.id and j.status in ('requested','processing','completed') order by j.created_at desc limit 1)) as f
      from clinical_private.encounter_captures c
      join clinical_private.recording_dispositions d on d.recording_id=c.id and d.disposition='finish'
      where c.encounter_id=_encounter and c.status='closed' and c.deletion_deadline>clock_timestamp()
        and not exists(select 1 from clinical_private.recording_cleanup_intents i where i.recording_id=c.id and i.reason in ('discard','consent_revoked'))
      order by d.created_at desc,c.id desc limit 20) x;
  insert into clinical_private.recording_access_events(encounter_id,actor_id,action)
    values(_encounter,clinical_private.actor_person_id(),'workspace.read');
  return jsonb_build_object('encounterId',_encounter,'encounterStatus',_e.status,
    'participants',_participants,'consentReleases',_releases,'activeCapture',_capture,'finishedCaptures',_finished);
end $$;
