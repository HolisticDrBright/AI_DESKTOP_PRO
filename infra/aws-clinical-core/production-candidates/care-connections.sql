-- Unreleased production connection/consent port. No identities, patients,
-- approval rows or consent grants are seeded. Must become an ordered migration
-- with a preserving upgrade before any candidate can be deployed.
create table clinical_core.care_consent_texts (
  artifact_id uuid primary key,
  organization_id uuid not null references clinical_core.organizations(id),
  content text not null check(octet_length(content) between 1 and 16000),
  content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
  registered_at timestamptz not null default clock_timestamp(),
  foreign key(artifact_id,organization_id) references clinical_core.consent_artifacts(id,organization_id),
  check(encode(public.digest(convert_to(content,'UTF8'),'sha256'),'hex')=content_sha256)
);
alter table clinical_core.care_consent_texts enable row level security;
alter table clinical_core.care_consent_texts force row level security;
revoke all on clinical_core.care_consent_texts from public,clinical_core_api;
create trigger care_consent_texts_immutable before update or delete on clinical_core.care_consent_texts
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.guard_care_consent_text() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from clinical_core.consent_artifacts a
    join clinical_core.identities i on i.person_id=a.approved_by_person_id and i.identity_pool='workforce'
    join clinical_core.persons p on p.id=i.person_id
    join clinical_core.organization_memberships m on m.person_id=i.person_id and m.organization_id=a.organization_id
    where a.id=new.artifact_id and a.organization_id=new.organization_id and a.content_sha256=new.content_sha256
      and a.status='approved' and a.approved_at<=clock_timestamp() and i.production_bound
      and i.status='active' and p.status='active' and m.status='active' and m.role in ('owner','admin','practitioner')) then
    raise exception using errcode='42501',message='care_connection_approved_copy_required';
  end if;
  return new;
end $$;
create trigger care_consent_texts_approved before insert on clinical_core.care_consent_texts
  for each row execute function clinical_private.guard_care_consent_text();

-- A release insertion/retirement and a grant must agree on which approved
-- version is current, even when the new release has no copy registered yet.
create function clinical_private.serialize_care_consent_release() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('care-consent-release:'||new.organization_id::text||':'||new.scope,1));
  return new;
end $$;
create trigger care_consent_release_serialized before insert or update on clinical_core.consent_artifacts
  for each row execute function clinical_private.serialize_care_consent_release();

create function clinical_private.protect_care_consent_artifact() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from clinical_core.care_consent_texts where artifact_id=old.id) and (
    (to_jsonb(new)-'status') is distinct from (to_jsonb(old)-'status')
    or (new.status is distinct from old.status and not(old.status='approved' and new.status='retired'))) then
    raise exception using errcode='55000',message='care_connection_artifact_immutable';
  end if;
  return new;
end $$;
create trigger care_consent_artifact_immutable before update on clinical_core.consent_artifacts
  for each row execute function clinical_private.protect_care_consent_artifact();

create function clinical_private.care_connection_actor(_pool text,_purpose text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
begin
  if _actor is null or _org is null or _pool is null or _purpose is null
    or _pool not in ('consumer','workforce') or _purpose not in ('identity_link','consent_management','clinical_data')
    or clinical_private.claim('identity_pool') is distinct from _pool
    or clinical_private.claim('purpose') is distinct from _purpose
    or clinical_private.claim('environment') is distinct from 'production-clinical'
    or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
    or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
      where i.person_id=_actor and i.identity_pool=_pool and i.identity_subject=clinical_private.claim('identity_subject')
        and i.production_bound and i.status='active' and p.status='active')
    or not exists(select 1 from clinical_core.organizations where id=_org and status='active')
    or (_pool='workforce' and not clinical_private.has_clinical_role(_org)) then
    raise exception using errcode='42501',message='care_connection_refused';
  end if;
  return _actor;
end $$;

create function clinical_private.care_connection_artifact(_scope text) returns clinical_core.consent_artifacts
language plpgsql security definer set search_path='' as $$
declare _a clinical_core.consent_artifacts;
begin
  -- Do not fall back to an older copy when the newest approved release lacks text.
  perform pg_advisory_xact_lock(hashtextextended('care-consent-release:'||clinical_private.organization_id()::text||':'||_scope,1));
  select * into _a from clinical_core.consent_artifacts
    where organization_id=clinical_private.organization_id() and scope=_scope and status='approved'
    order by approved_at desc,created_at desc,id desc limit 1 for share;
  if _a.id is null or _a.approved_at>clock_timestamp() or not exists(
    select 1 from clinical_core.care_consent_texts t where t.artifact_id=_a.id
      and t.organization_id=_a.organization_id and t.content_sha256=_a.content_sha256) then
    raise exception using errcode='42501',message='care_connection_approved_copy_required';
  end if;
  return _a;
end $$;

-- Existing Desktop issuance and the new workforce API share this implementation.
-- The patient row is locked even before its first connection exists.
create or replace function clinical_core.create_sync_invitation(_organization_id uuid,_patient_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.care_connection_actor('workforce','clinical_data');
  _c clinical_core.patient_connections; _id uuid; _token text:=''; _random bytea:=public.gen_random_bytes(13);
  _alphabet text:='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; _expires timestamptz:=clock_timestamp()+interval '24 hours'; _n integer;
begin
  if _organization_id is distinct from clinical_private.organization_id() then
    raise exception using errcode='42501',message='care_connection_refused'; end if;
  perform 1 from clinical_core.patient_records where id=_patient_id and organization_id=_organization_id and status='active' for update;
  if not found then raise exception using errcode='42501',message='care_connection_refused'; end if;
  select * into _c from clinical_core.patient_connections
    where organization_id=_organization_id and patient_record_id=_patient_id and state<>'revoked' for update;
  if _c.id is not null and _c.state<>'invitation_pending' then
    raise exception using errcode='40001',message='care_connection_conflict'; end if;
  if _c.id is null then insert into clinical_core.patient_connections(organization_id,patient_record_id)
    values(_organization_id,_patient_id) returning * into _c; end if;
  for _n in 0..12 loop _token:=_token||substr(_alphabet,(get_byte(_random,_n)%32)+1,1); end loop;
  update clinical_core.connection_invitations set status='superseded' where connection_id=_c.id and status='pending';
  insert into clinical_core.connection_invitations(organization_id,patient_record_id,connection_id,token_hash,idempotency_key,expires_at,created_by_person_id)
    values(_organization_id,_patient_id,_c.id,encode(public.digest(_token,'sha256'),'hex'),
      'care:'||public.gen_random_uuid()::text,_expires,_actor) returning id into _id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
    values(_organization_id,_actor,'connection.invitation_issued','connection',_c.id,'identity_link',
      jsonb_build_object('invitation_id',_id,'expires_at',_expires));
  return jsonb_build_object('ok',true,'message','Invitation created','connectionId',_c.id,'invitationId',_id,
    'token',_token,'expiresAt',_expires,'state','invitation_pending','version',_c.version);
end $$;

create function clinical_core.production_care_connection_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _action text:=_request->>'action'; _actor uuid; _org uuid:=clinical_private.organization_id();
  _c clinical_core.patient_connections; _i clinical_core.connection_invitations; _a clinical_core.consent_artifacts;
  _g clinical_core.consent_grants; _copy text; _token text; _scope text; _expected integer; _grant_id uuid;
  _keys text[]; _state text;
begin
  if jsonb_typeof(_request) is distinct from 'object' or _action is null or octet_length(_request::text)>22000 then
    raise exception using errcode='22023',message='care_connection_invalid'; end if;
  _keys:=case _action when 'issue' then array['action','patientRecordId'] when 'claim' then array['action','token']
    when 'connection' then array['action'] when 'consent' then array['action','connectionId','scope']
    when 'grant' then array['action','connectionId','scope','artifactId','contentSha256','expectedVersion']
    when 'withdraw' then array['action','connectionId','scope','expectedVersion'] else null end;
  if _keys is null or exists(select 1 from jsonb_object_keys(_request) k where not(k=any(_keys)))
    or exists(select 1 from unnest(_keys) k where not(_request ? k)) then
    raise exception using errcode='22023',message='care_connection_invalid'; end if;
  -- The SQL dispatcher is also a boundary: callers with execute privilege must
  -- not bypass the application schema using JSON nulls or coerced scalar types.
  if jsonb_typeof(_request->'action') is distinct from 'string'
    or exists(select 1 from unnest(array['patientRecordId','connectionId','artifactId']) k
      where _request ? k and (jsonb_typeof(_request->k) is distinct from 'string'
        or (_request->>k) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    or (_request ? 'scope' and jsonb_typeof(_request->'scope') is distinct from 'string')
    or (_request ? 'contentSha256' and (jsonb_typeof(_request->'contentSha256') is distinct from 'string'
      or (_request->>'contentSha256') !~ '^[a-f0-9]{64}$')) then
    raise exception using errcode='22023',message='care_connection_invalid'; end if;
  if _action='issue' then
    return clinical_core.create_sync_invitation(_org,(_request->>'patientRecordId')::uuid);
  end if;
  _actor:=clinical_private.care_connection_actor('consumer',case when _action='claim' then 'identity_link' else 'consent_management' end);
  if _action='connection' then
    select c.* into _c from clinical_core.patient_connections c join clinical_core.patient_records p on p.id=c.patient_record_id
      where c.organization_id=_org and c.consumer_person_id=_actor and c.state in ('verified','paused') and p.status='active';
    if _c.id is null then return jsonb_build_object('connection',null); end if;
    return jsonb_build_object('connection',jsonb_build_object('connectionId',_c.id,'patientRecordId',_c.patient_record_id,
      'state',_c.state,'verifiedAt',_c.verified_at,'version',_c.version));
  end if;
  if _action='claim' then
    if jsonb_typeof(_request->'token') is distinct from 'string' then
      raise exception using errcode='22023',message='care_connection_invalid'; end if;
    _token:=upper(replace(btrim(_request->>'token'),'-',''));
    if _token !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{13}$' then
      raise exception using errcode='22023',message='care_connection_invalid'; end if;
    select * into _i from clinical_core.connection_invitations where organization_id=_org
      and token_hash=encode(public.digest(_token,'sha256'),'hex');
    if _i.id is null then raise exception using errcode='42501',message='care_connection_refused'; end if;
    -- Admission locks the chart before the connection, matching issuance. A
    -- concurrently archived chart must not become a newly admitted link.
    perform 1 from clinical_core.patient_records where id=_i.patient_record_id
      and organization_id=_org and status='active' for share;
    if not found then raise exception using errcode='42501',message='care_connection_refused'; end if;
    select * into _c from clinical_core.patient_connections where id=_i.connection_id for update;
    -- Same connection-then-owner lock order as messaging and withdrawal.
    perform clinical_private.assert_owned_storage_writable(_actor);
    select * into _i from clinical_core.connection_invitations where id=_i.id for update;
    if _i.status<>'pending' or _i.expires_at<=clock_timestamp() or _c.state<>'invitation_pending'
      or _c.consumer_person_id is not null or not exists(select 1 from clinical_core.patient_records
        where id=_c.patient_record_id and organization_id=_org and status='active') then
      raise exception using errcode='42501',message='care_connection_refused'; end if;
    if exists(select 1 from clinical_core.patient_connections where consumer_person_id=_actor and state<>'revoked') then
      raise exception using errcode='40001',message='care_connection_conflict'; end if;
    update clinical_core.patient_connections set consumer_person_id=_actor,state='verified',verified_at=clock_timestamp(),
      updated_at=clock_timestamp(),version=version+1 where id=_c.id returning * into _c;
    update clinical_core.connection_invitations set status='accepted',used_at=clock_timestamp() where id=_i.id;
    update clinical_core.connection_invitations set status='superseded' where connection_id=_c.id and status='pending';
    insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
      values(_org,_actor,'connection.invitation_claimed','connection',_c.id,'identity_link',jsonb_build_object('invitation_id',_i.id));
    return jsonb_build_object('connectionId',_c.id,'patientRecordId',_c.patient_record_id,'state',_c.state,
      'verifiedAt',_c.verified_at,'version',_c.version);
  end if;
  _scope:=_request->>'scope';
  if _scope is null or _scope not in ('programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','reproductive_health','lab_summaries','lab_results_import',
    'lab_specimen_context','billing_links','research_n_of_1') then
    raise exception using errcode='22023',message='care_connection_invalid'; end if;
  if _action='grant' then
    perform 1 from clinical_core.patient_records p join clinical_core.patient_connections c on c.patient_record_id=p.id
      where c.id=(_request->>'connectionId')::uuid and c.organization_id=_org and c.consumer_person_id=_actor
        and p.organization_id=_org and p.status='active' for share of p;
    if not found then raise exception using errcode='42501',message='care_connection_refused'; end if;
  end if;
  select * into _c from clinical_core.patient_connections where id=(_request->>'connectionId')::uuid
    and organization_id=_org and consumer_person_id=_actor and state<>'invitation_pending' for update;
  if _c.id is null then raise exception using errcode='42501',message='care_connection_refused'; end if;
  select * into _g from clinical_core.consent_grants where connection_id=_c.id and scope=_scope order by version desc limit 1;
  if _action='consent' then
    _state:=coalesce(_g.status,'not_granted');
    -- Withdrawal/status remains available when a release is removed or the link revoked.
    begin
      _a:=clinical_private.care_connection_artifact(_scope);
      select content into _copy from clinical_core.care_consent_texts where artifact_id=_a.id;
    exception when sqlstate '42501' then _a:=null; _copy:=null; end;
    return jsonb_build_object('connectionId',_c.id,'connectionState',_c.state,'scope',_scope,'status',_state,
      'version',coalesce(_g.version,0),'currentArtifactId',_g.artifact_id,'artifact',case when _a.id is null then null else
      jsonb_build_object('artifactId',_a.id,'artifactVersion',_a.artifact_version,'contentSha256',_a.content_sha256,
        'jurisdiction',_a.jurisdiction,'approvedAt',_a.approved_at,'content',_copy) end);
  end if;
  if jsonb_typeof(_request->'expectedVersion') is distinct from 'number'
    or (_request->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' then
    raise exception using errcode='22023',message='care_connection_invalid'; end if;
  _expected:=(_request->>'expectedVersion')::integer;
  if _action='grant' then
    if _c.state<>'verified' then raise exception using errcode='42501',message='care_connection_refused'; end if;
    perform clinical_private.assert_owned_storage_writable(_actor);
    _a:=clinical_private.care_connection_artifact(_scope);
    if _a.id is distinct from (_request->>'artifactId')::uuid or _a.content_sha256 is distinct from (_request->>'contentSha256') then
      raise exception using errcode='40001',message='care_connection_conflict'; end if;
    if _g.status='granted' and _g.artifact_id=_a.id and _g.recorded_by_person_id=_actor
      and _g.method='patient_app' and _g.representative_authority='self' and _g.version in (_expected,_expected+1) then
      return jsonb_build_object('connectionId',_c.id,'scope',_scope,'status','granted','version',_g.version,'alreadyApplied',true);
    end if;
    if _g.status='granted' or coalesce(_g.version,0)<>_expected then
      raise exception using errcode='40001',message='care_connection_conflict'; end if;
    insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,
      method,representative_authority,version,recorded_by_person_id)
      values(_org,_c.patient_record_id,_c.id,_a.id,_scope,'granted','patient_app','self',_expected+1,_actor) returning id into _grant_id;
  else
    -- No new sharing and no erasure claim: withdrawal is allowed even during deletion.
    if (_g.id is null and _expected=0) or (_g.status='revoked' and _g.version in (_expected,_expected+1)) then
      return jsonb_build_object('connectionId',_c.id,'scope',_scope,'status',coalesce(_g.status,'not_granted'),
        'version',coalesce(_g.version,0),'alreadyApplied',true);
    end if;
    if coalesce(_g.version,0)<>_expected then raise exception using errcode='40001',message='care_connection_conflict'; end if;
    insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,
      representative_authority,reason_code,version,recorded_by_person_id)
      values(_org,_c.patient_record_id,_c.id,_scope,'revoked','patient_app','self','patient_request',_expected+1,_actor) returning id into _grant_id;
  end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
    values(_org,_actor,case when _action='grant' then 'consent.granted' else 'consent.revoked' end,'consent',_grant_id,
      'consent_management',jsonb_build_object('scope',_scope,'version',_expected+1));
  return jsonb_build_object('connectionId',_c.id,'scope',_scope,'status',case when _action='grant' then 'granted' else 'revoked' end,
    'version',_expected+1,'alreadyApplied',false);
end $$;
revoke all on function clinical_private.guard_care_consent_text(),clinical_private.protect_care_consent_artifact(),
  clinical_private.serialize_care_consent_release(),clinical_private.care_connection_actor(text,text),clinical_private.care_connection_artifact(text) from public,clinical_core_api;
revoke all on function clinical_core.production_care_connection_request(jsonb),clinical_core.create_sync_invitation(uuid,uuid) from public;
grant execute on function clinical_core.production_care_connection_request(jsonb),clinical_core.create_sync_invitation(uuid,uuid) to clinical_core_api;
