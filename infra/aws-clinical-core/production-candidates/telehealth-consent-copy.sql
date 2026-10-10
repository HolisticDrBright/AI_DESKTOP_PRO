-- Forward-only consent-copy port. No approvals, identities or grants seeded.
-- The original care connection function and all historical SQL remain intact.
create function clinical_core.production_telehealth_consent_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _action text:=_request->>'action'; _actor uuid; _org uuid:=clinical_private.organization_id();
  _c clinical_core.patient_connections; _a clinical_core.consent_artifacts;
  _g clinical_core.consent_grants; _keys text[]; _copy text; _expected integer; _grant_id uuid;
begin
  if jsonb_typeof(_request) is distinct from 'object' or _action is null or octet_length(_request::text)>22000 then
    raise exception using errcode='22023',message='telehealth_consent_invalid'; end if;
  _keys:=case _action when 'connection' then array['action']
    when 'consent' then array['action','connectionId','scope']
    when 'grant' then array['action','connectionId','scope','artifactId','contentSha256','expectedVersion']
    when 'withdraw' then array['action','connectionId','scope','expectedVersion'] else null end;
  if _keys is null or exists(select 1 from jsonb_object_keys(_request) k where not(k=any(_keys)))
    or exists(select 1 from unnest(_keys) k where not(_request ? k))
    or jsonb_typeof(_request->'action') is distinct from 'string'
    or exists(select 1 from unnest(array['connectionId','artifactId']) k where _request ? k
      and (jsonb_typeof(_request->k) is distinct from 'string'
        or (_request->>k) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    or (_action<>'connection' and (jsonb_typeof(_request->'scope') is distinct from 'string'
      or _request->>'scope' is distinct from 'telehealth_recording'))
    or (_request ? 'contentSha256' and (jsonb_typeof(_request->'contentSha256') is distinct from 'string'
      or (_request->>'contentSha256') !~ '^[a-f0-9]{64}$')) then
    raise exception using errcode='22023',message='telehealth_consent_invalid'; end if;
  _actor:=clinical_private.care_connection_actor('consumer','consent_management');
  if _action='connection' then
    select c.* into _c from clinical_core.patient_connections c join clinical_core.patient_records p on p.id=c.patient_record_id
      where c.organization_id=_org and c.consumer_person_id=_actor and c.state in ('verified','paused') and p.status='active';
    if _c.id is null then return jsonb_build_object('connection',null); end if;
    return jsonb_build_object('connection',jsonb_build_object('connectionId',_c.id,'patientRecordId',_c.patient_record_id,
      'state',_c.state,'verifiedAt',_c.verified_at,'version',_c.version));
  end if;
  if _action='grant' then
    perform 1 from clinical_core.patient_records p join clinical_core.patient_connections c on c.patient_record_id=p.id
      where c.id=(_request->>'connectionId')::uuid and c.organization_id=_org and c.consumer_person_id=_actor
        and p.organization_id=_org and p.status='active' for share of p;
    if not found then raise exception using errcode='42501',message='telehealth_consent_refused'; end if;
  end if;
  select * into _c from clinical_core.patient_connections where id=(_request->>'connectionId')::uuid
    and organization_id=_org and consumer_person_id=_actor and state<>'invitation_pending' for update;
  if _c.id is null then raise exception using errcode='42501',message='telehealth_consent_refused'; end if;
  if _action='grant' and _c.state<>'verified' then
    raise exception using errcode='42501',message='telehealth_consent_refused'; end if;
  select * into _g from clinical_core.consent_grants where connection_id=_c.id and scope='telehealth_recording'
    order by version desc limit 1;
  if _action in ('consent','grant') then
    -- The newest approved artifact must have its exact immutable copy. A newer
    -- release without copy never exposes or authorizes an older release.
    begin
      _a:=clinical_private.care_connection_artifact('telehealth_recording');
      perform 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
        join clinical_core.organization_memberships m on m.person_id=i.person_id
        where i.person_id=_a.approved_by_person_id and i.identity_pool='workforce' and i.production_bound
          and i.status='active' and p.status='active' and m.organization_id=_org and m.status='active'
          and m.role in ('owner','admin','practitioner') for share of i,p,m;
      if not found then
        raise exception using errcode='42501',message='telehealth_consent_copy_required'; end if;
      select content into _copy from clinical_core.care_consent_texts where artifact_id=_a.id and organization_id=_org;
    exception when sqlstate '42501' then
      if _action='grant' then raise exception using errcode='42501',message='telehealth_consent_copy_required'; end if;
      _a:=null; _copy:=null;
    end;
  end if;
  if _action='consent' then
    return jsonb_build_object('connectionId',_c.id,'connectionState',_c.state,'scope','telehealth_recording',
      'status',coalesce(_g.status,'not_granted'),'version',coalesce(_g.version,0),'currentArtifactId',_g.artifact_id,
      'artifact',case when _a.id is null then null else jsonb_build_object('artifactId',_a.id,
        'artifactVersion',_a.artifact_version,'contentSha256',_a.content_sha256,'jurisdiction',_a.jurisdiction,
        'approvedAt',_a.approved_at,'content',_copy) end);
  end if;
  if jsonb_typeof(_request->'expectedVersion') is distinct from 'number'
    or (_request->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' then
    raise exception using errcode='22023',message='telehealth_consent_invalid'; end if;
  _expected:=(_request->>'expectedVersion')::integer;
  if _action='grant' then
    perform clinical_private.assert_owned_storage_writable(_actor);
    if _a.id is distinct from (_request->>'artifactId')::uuid or _a.content_sha256 is distinct from (_request->>'contentSha256') then
      raise exception using errcode='40001',message='telehealth_consent_conflict'; end if;
    if _g.status='granted' and _g.artifact_id=_a.id and _g.recorded_by_person_id=_actor
      and _g.method='patient_app' and _g.representative_authority='self' and _g.version in (_expected,_expected+1) then
      return jsonb_build_object('connectionId',_c.id,'scope','telehealth_recording','status','granted',
        'artifactId',_g.artifact_id,'version',_g.version,'alreadyApplied',true);
    end if;
    if _g.status='granted' or coalesce(_g.version,0)<>_expected then
      raise exception using errcode='40001',message='telehealth_consent_conflict'; end if;
    insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,
      method,representative_authority,version,recorded_by_person_id)
      values(_org,_c.patient_record_id,_c.id,_a.id,'telehealth_recording','granted','patient_app','self',_expected+1,_actor)
      returning id into _grant_id;
  else
    -- Withdrawal remains available after release removal or link revocation.
    -- It authorizes no new processing and is not a deletion certificate.
    if (_g.id is null and _expected=0) or (_g.status='revoked' and _g.version in (_expected,_expected+1)) then
      return jsonb_build_object('connectionId',_c.id,'scope','telehealth_recording','status',coalesce(_g.status,'not_granted'),
        'artifactId',null,'version',coalesce(_g.version,0),'alreadyApplied',true); end if;
    if coalesce(_g.version,0)<>_expected then raise exception using errcode='40001',message='telehealth_consent_conflict'; end if;
    insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,
      representative_authority,reason_code,version,recorded_by_person_id)
      values(_org,_c.patient_record_id,_c.id,'telehealth_recording','revoked','patient_app','self','patient_request',_expected+1,_actor)
      returning id into _grant_id;
  end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
    values(_org,_actor,case when _action='grant' then 'consent.granted' else 'consent.revoked' end,'consent',_grant_id,
      'consent_management',jsonb_build_object('scope','telehealth_recording','version',_expected+1));
  return jsonb_build_object('connectionId',_c.id,'scope','telehealth_recording',
    'status',case when _action='grant' then 'granted' else 'revoked' end,
    'artifactId',case when _action='grant' then _a.id else null end,'version',_expected+1,'alreadyApplied',false);
end $$;
revoke all on function clinical_core.production_telehealth_consent_request(jsonb) from public;
grant execute on function clinical_core.production_telehealth_consent_request(jsonb) to clinical_core_api;
