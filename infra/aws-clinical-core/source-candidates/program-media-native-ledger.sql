-- BLOCKED distinct source candidate. Unregistered, unapplied, activation OFF.
-- Exact parents (LF bytes): ledger 6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d;
-- settlement 74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04.
-- Complete synthetic educational-media authority. No patient/clinical data or
-- production activation. Storage I/O is outside every short SQL transaction.
-- The worker has one entry point, never raw table or private helper access.

create role program_media_authority nologin noinherit;
create role program_media_worker nologin noinherit;
grant usage on schema clinical_core,clinical_private to program_media_authority,program_media_worker;
grant execute on function clinical_private.set_request_context(uuid,uuid,text,text,text,text,text) to program_media_worker;
grant execute on function clinical_private.claim(text),clinical_private.actor_person_id(),clinical_private.organization_id() to program_media_authority;
-- Existing public RLS predicates are evaluated alongside the new scoped
-- policies. These read-only predicates do not grant private write authority.
grant execute on function clinical_private.is_active_member(uuid),clinical_private.has_clinical_role(uuid),
 clinical_private.has_program_author_role(uuid) to program_media_authority;

alter table clinical_core.program_media_activation
 add column native_evidence_sha256 text check(native_evidence_sha256 is null or native_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 add column expected_bucket_owner text check(expected_bucket_owner is null or expected_bucket_owner ~ '^[0-9]{12}$'),
 add column region text check(region is null or region ~ '^us-(east|west)-[12]$'),
 add column kms_key_arn text,
 add column max_image_bytes bigint check(max_image_bytes between 1 and 16777216),
 add column max_video_bytes bigint check(max_video_bytes between 1 and 268435456),
 add constraint program_media_native_activation_complete check(not enabled or
 (native_evidence_sha256 is not null and expected_bucket_owner is not null and region is not null and kms_key_arn is not null
 and kms_key_arn ~ ('^arn:aws:kms:'||region||':'||expected_bucket_owner||':key/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
 and max_image_bytes is not null and max_video_bytes is not null));

-- A non-bypass definer sees only the current request's educational clinic and
-- actor. Column-id UPDATE rights admit FOR SHARE, not a public mutation RPC.
-- Neither request workers nor clinical_core_api can assume this owner role.
grant select on clinical_core.organizations,clinical_core.persons,clinical_core.identities,
 clinical_core.organization_memberships,clinical_core.synthetic_workforce_identity_aliases,
 clinical_core.synthetic_desktop_programs to program_media_authority;
grant update(id) on clinical_core.organizations,clinical_core.persons,clinical_core.identities,
 clinical_core.organization_memberships,clinical_core.synthetic_workforce_identity_aliases,
 clinical_core.synthetic_desktop_programs to program_media_authority;
create policy program_media_authority_org on clinical_core.organizations to program_media_authority
 using(id=clinical_private.organization_id());
create policy program_media_authority_person on clinical_core.persons to program_media_authority
 using(id=clinical_private.actor_person_id());
create policy program_media_authority_identity on clinical_core.identities to program_media_authority
 using(person_id=clinical_private.actor_person_id());
create policy program_media_authority_member on clinical_core.organization_memberships to program_media_authority
 using(organization_id=clinical_private.organization_id() and person_id=clinical_private.actor_person_id());
create policy program_media_authority_alias on clinical_core.synthetic_workforce_identity_aliases to program_media_authority
 using(exists(select 1 from clinical_core.identities i where i.id=canonical_identity_id and i.person_id=clinical_private.actor_person_id()));
create policy program_media_authority_program on clinical_core.synthetic_desktop_programs to program_media_authority
 using(organization_id=clinical_private.organization_id());

grant select on clinical_core.program_media_activation to program_media_authority;
grant update(singleton) on clinical_core.program_media_activation to program_media_authority;
create policy program_media_authority_activation on clinical_core.program_media_activation to program_media_authority using(true);
grant select,insert,update on clinical_core.program_media_artifacts,clinical_private.program_media_work,
 clinical_private.program_media_cleanup_seals to program_media_authority;
grant select,insert on clinical_core.program_media_events,clinical_core.program_media_publications to program_media_authority;
create policy program_media_authority_artifact on clinical_core.program_media_artifacts to program_media_authority
 using(organization_id=clinical_private.organization_id()) with check(organization_id=clinical_private.organization_id());
create policy program_media_authority_event on clinical_core.program_media_events to program_media_authority
 using(organization_id=clinical_private.organization_id()) with check(organization_id=clinical_private.organization_id());
create policy program_media_authority_publication on clinical_core.program_media_publications to program_media_authority
 using(organization_id=clinical_private.organization_id()) with check(organization_id=clinical_private.organization_id());
create policy program_media_authority_work on clinical_private.program_media_work to program_media_authority
 using(organization_id=clinical_private.organization_id()) with check(organization_id=clinical_private.organization_id());
create policy program_media_authority_seal on clinical_private.program_media_cleanup_seals to program_media_authority
 using(exists(select 1 from clinical_core.program_media_artifacts a where a.id=artifact_id and a.organization_id=clinical_private.organization_id()));

create function clinical_private.program_media_require_actor() returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=clinical_private.actor_person_id(); org uuid:=clinical_private.organization_id(); ident clinical_core.identities%rowtype;
begin
 if clinical_private.claim('identity_pool') is distinct from 'workforce'
 or clinical_private.claim('environment') is distinct from 'synthetic-staging'
 or clinical_private.claim('data_classification') is distinct from 'synthetic_only'
 or clinical_private.claim('purpose') is distinct from 'clinical_data' then raise exception 'pm.access_refused'; end if;
 perform 1 from clinical_core.organizations where id=org and status='active' and contains_phi=false
 and environment='synthetic-staging' and data_classification='synthetic_only' for share;
 if not found then raise exception 'pm.access_refused'; end if;
 perform 1 from clinical_core.persons where id=actor and status='active' and contains_phi=false and data_classification='synthetic_only' for share;
 if not found then raise exception 'pm.access_refused'; end if;
 select * into ident from clinical_core.identities where person_id=actor and identity_pool='workforce' and status='active' and synthetic_attested for share;
 if ident.id is null then raise exception 'pm.access_refused'; end if;
 if ident.identity_subject is distinct from clinical_private.claim('identity_subject') then
  perform 1 from clinical_core.synthetic_workforce_identity_aliases where canonical_identity_id=ident.id
  and alias_identity_subject=clinical_private.claim('identity_subject') and status='active' and synthetic_attested and reviewed_at is not null for share;
  if not found then raise exception 'pm.access_refused'; end if;
 end if;
 perform 1 from clinical_core.organization_memberships where organization_id=org and person_id=actor
 and status='active' and role in('owner','admin','practitioner') for share;
 if not found then raise exception 'pm.access_refused'; end if;
 perform 1 from clinical_core.program_media_activation where singleton and enabled and native_evidence_sha256 is not null for share;
 if not found then raise exception 'pm.program_media_disabled'; end if;
 return actor;
end $$;

create function clinical_private.program_media_require_program(_program uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from clinical_core.synthetic_desktop_programs where id=_program and organization_id=clinical_private.organization_id() and status<>'archived' for share;
 return found;
end $$;

create function clinical_private.program_media_reservation_json(_a clinical_core.program_media_artifacts,_replayed boolean) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('artifactId',_a.id,'clinic',_a.organization_id,'programId',_a.program_id,'commandId',_a.command_id,
 'kind',_a.kind,'contentType',_a.content_type,'bytes',_a.bytes,'sha256',_a.sha256,'objectKey',_a.object_key,
 'state',case when _a.state in('error','abandoned') then _a.state else 'reserved' end,
 'acceptBefore',_a.accept_before,'createdAt',_a.created_at,'replayed',_replayed,'failure',_a.failure)
$$;
create function clinical_private.program_media_artifact_json(_a clinical_core.program_media_artifacts) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('artifactId',_a.id,'clinic',_a.organization_id,'programId',_a.program_id,
 'kind',_a.kind,'contentType',_a.content_type,'bytes',_a.bytes,'sha256',_a.sha256,'objectKey',_a.object_key,
 'version',_a.version,'state',_a.state,'objectVersion',_a.object_version,'committedAt',_a.committed_at,'retiredAt',_a.retired_at,'failure',_a.failure,
 'caption',case when _a.caption_text is null then null else jsonb_build_object('text',_a.caption_text,'source',_a.caption_source,'format',_a.caption_format,'sha256',_a.caption_sha256) end,
 'transcript',case when _a.transcript_text is null then null else jsonb_build_object('text',_a.transcript_text,'source',_a.transcript_source,'format',_a.transcript_format,'sha256',_a.transcript_sha256) end)
$$;

create function clinical_core.program_media_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; org uuid:=clinical_private.organization_id(); op text; p jsonb; keys text[];
 a clinical_core.program_media_artifacts%rowtype; r jsonb; data jsonb; inserted boolean; claim uuid; before_state text;
 config clinical_core.program_media_activation%rowtype; ver bigint; slot text; txt jsonb; failure text;
begin
 actor:=clinical_private.program_media_require_actor();
 if _request is null or jsonb_typeof(_request) is distinct from 'object' or
 (select count(*) from jsonb_object_keys(_request))<>3 or not (_request ?& array['operation','parameters','release'])
 or jsonb_typeof(_request->'operation') is distinct from 'string' or jsonb_typeof(_request->'parameters') is distinct from 'object' then raise exception 'pm.request_invalid'; end if;
 op:=_request->>'operation'; p:=_request->'parameters';
 -- The reviewed store snapshot is host supplied, never a browser authority.
 -- The actor helper already holds the activation row FOR SHARE. Release
 -- changes cannot cross an admitted mutation's short transaction, and every
 -- later operation must re-admit the exact store snapshot after external I/O.
 if op<>'configuration' then
  select * into config from clinical_core.program_media_activation where singleton;
  if _request->'release' is distinct from jsonb_build_object('evidenceSha256',config.native_evidence_sha256,
   'storage',jsonb_build_object('purpose','educational_media','phiAllowed',false,'dedicated',true,'bucket',config.storage_bucket,
   'expectedBucketOwner',config.expected_bucket_owner,'region',config.region,'kmsKeyArn',config.kms_key_arn,
   'maxImageBytes',config.max_image_bytes,'maxVideoBytes',config.max_video_bytes,'publicOrigin',config.public_origin))
   then raise exception 'pm.storage_unverified'; end if;
 end if;
 keys:=case op when 'configuration' then array[]::text[] when 'authorize' then array['programId']
 when 'reserve' then array['reservation'] when 'reservation' then array['artifactId'] when 'artifact' then array['artifactId']
 when 'commit' then array['artifactId','claimId','objectVersion'] when 'settle' then array['artifactId','state','failure','claimId']
 when 'beginWriter' then array['artifactId','claimId','mode'] when 'finishWriter' then array['artifactId','claimId','outcome']
 when 'beginCleanup' then array['artifactId','claimId'] when 'certifyCleanup' then array['artifactId','claimId','proof']
 when 'attachText' then array['artifactId','expectedVersion','slot','text'] when 'retire' then array['artifactId','expectedVersion']
 when 'recordPublication' then array['reference'] when 'hasPublication' then array['reference'] when 'expiredReservations' then array['programId','before'] end;
 if keys is null or not(p ?& keys) or (select count(*) from jsonb_object_keys(p))<>cardinality(keys) then raise exception 'pm.request_invalid'; end if;
 if op='configuration' then
  select * into config from clinical_core.program_media_activation where singleton;
  data:=jsonb_build_object('contractVersion','program-media-native-ledger/1','evidenceSha256',config.native_evidence_sha256,
   'storage',jsonb_build_object('purpose','educational_media','phiAllowed',false,'dedicated',true,'bucket',config.storage_bucket,
   'expectedBucketOwner',config.expected_bucket_owner,'region',config.region,'kmsKeyArn',config.kms_key_arn,
   'maxImageBytes',config.max_image_bytes,'maxVideoBytes',config.max_video_bytes,'publicOrigin',config.public_origin));
 elsif op in('authorize','expiredReservations') then
  if not clinical_private.program_media_require_program((p->>'programId')::uuid) then
   if op='authorize' then data:='false'::jsonb; else raise exception 'pm.access_refused'; end if;
  elsif op='authorize' then data:='true'::jsonb;
  else
   select coalesce(jsonb_agg(clinical_private.program_media_reservation_json(q,false) order by q.accept_before,q.id),'[]'::jsonb) into data
   from (select a.* from clinical_core.program_media_artifacts a where a.organization_id=org and a.program_id=(p->>'programId')::uuid
    and a.state in('reserved','error','abandoned') and a.accept_before<=least((p->>'before')::timestamptz,clock_timestamp())
    and not exists(select 1 from clinical_private.program_media_cleanup_seals s where s.artifact_id=a.id and s.proof is not null)
    order by a.accept_before,a.id limit 1000) q;
  end if;
 elsif op='reserve' then
  r:=p->'reservation';
  if jsonb_typeof(r) is distinct from 'object' or (select count(*) from jsonb_object_keys(r))<>13
  or not(r ?& array['artifactId','clinic','programId','commandId','kind','contentType','bytes','sha256','objectKey','state','acceptBefore','createdAt','failure'])
  or (r->>'clinic')::uuid is distinct from org or r->>'state' is distinct from 'reserved' or r->'failure' is distinct from 'null'::jsonb
  or not clinical_private.program_media_require_program((r->>'programId')::uuid) then raise exception 'pm.request_invalid'; end if;
  select * into config from clinical_core.program_media_activation where singleton;
  if (r->>'bytes')::bigint>(case when r->>'kind'='image' then config.max_image_bytes else config.max_video_bytes end) then raise exception 'pm.request_invalid'; end if;
  insert into clinical_core.program_media_artifacts(id,organization_id,program_id,command_id,created_by,kind,content_type,bytes,sha256,object_key,created_at,accept_before)
   values((r->>'artifactId')::uuid,org,(r->>'programId')::uuid,(r->>'commandId')::uuid,actor,r->>'kind',r->>'contentType',
   (r->>'bytes')::bigint,r->>'sha256',r->>'objectKey',clock_timestamp(),clock_timestamp()+interval '15 minutes')
   on conflict(organization_id,program_id,command_id) do nothing returning * into a;
  inserted:=found;
  if not inserted then
   select * into a from clinical_core.program_media_artifacts where organization_id=org and program_id=(r->>'programId')::uuid and command_id=(r->>'commandId')::uuid for update;
   if (a.kind,a.content_type,a.bytes,a.sha256) is distinct from (r->>'kind',r->>'contentType',(r->>'bytes')::bigint,r->>'sha256') then raise exception 'pm.conflict'; end if;
  else insert into clinical_core.program_media_events(artifact_id,organization_id,actor_id,event) values(a.id,org,actor,'reserved'); end if;
  data:=clinical_private.program_media_reservation_json(a,not inserted);
 else
  if op in('recordPublication','hasPublication') then r:=p->'reference'; else r:=p; end if;
  -- Resolve the program without revealing a foreign artifact. Authority locks
  -- precede the artifact lock consistently across every public action.
  select * into a from clinical_core.program_media_artifacts where id=(r->>'artifactId')::uuid and organization_id=org;
  if a.id is null then
   if op in('reservation','artifact') then data:='null'::jsonb;
   elsif op='hasPublication' then data:='false'::jsonb;
   else raise exception 'pm.not_found'; end if;
  else
   if not clinical_private.program_media_require_program(a.program_id) then raise exception 'pm.access_refused'; end if;
   select * into a from clinical_core.program_media_artifacts where id=a.id and organization_id=org for update;
   if op='reservation' then data:=clinical_private.program_media_reservation_json(a,false);
   elsif op='artifact' then data:=clinical_private.program_media_artifact_json(a);
   elsif op='beginWriter' then data:=to_jsonb(clinical_private.program_media_begin_work(org,actor,a.id,(p->>'claimId')::uuid,p->>'mode'));
   elsif op='finishWriter' then perform clinical_private.program_media_finish_work(org,actor,a.id,(p->>'claimId')::uuid,p->>'outcome'); data:='null'::jsonb;
   elsif op='beginCleanup' then data:=to_jsonb(clinical_private.program_media_begin_cleanup(org,actor,a.id,(p->>'claimId')::uuid));
   elsif op='certifyCleanup' then
    perform clinical_private.program_media_certify_cleanup(org,actor,a.id,(p->>'claimId')::uuid,p->'proof');
    insert into clinical_core.program_media_events(artifact_id,organization_id,actor_id,event) values(a.id,org,actor,'orphan_removed'); data:='null'::jsonb;
   elsif op='commit' then
    before_state:=a.state;
    perform clinical_private.program_media_commit_work(org,actor,a.id,(p->>'claimId')::uuid,p->>'objectVersion');
    select * into a from clinical_core.program_media_artifacts where id=a.id;
    if before_state<>'ready' then insert into clinical_core.program_media_events(artifact_id,organization_id,actor_id,event) values(a.id,org,actor,'committed'); end if;
    data:=clinical_private.program_media_artifact_json(a);
   elsif op='settle' then
    if p->>'state' not in('held','error','abandoned') or char_length(p->>'failure') not between 1 and 80 then raise exception 'pm.request_invalid'; end if;
    claim:=nullif(p->>'claimId','')::uuid;
    if a.state not in('ready','retired') and a.state is distinct from p->>'state' then
     if claim is null then
      if exists(select 1 from clinical_private.program_media_work where artifact_id=a.id and kind<>'cleanup' and state<>'settled') then
       return jsonb_build_object('contractVersion','program-media-native-ledger/1','ok',true,'data',null); end if;
     elsif not exists(select 1 from clinical_private.program_media_work where claim_id=claim and artifact_id=a.id and actor_id=actor and state='open') then raise exception 'pm.conflict'; end if;
     update clinical_core.program_media_artifacts set state=p->>'state',failure=p->>'failure',version=version+1 where id=a.id;
     insert into clinical_core.program_media_events(artifact_id,organization_id,actor_id,event,detail) values(a.id,org,actor,p->>'state',p->>'failure');
    end if; data:='null'::jsonb;
   elsif op in('attachText','retire') then
    if a.state='retired' then raise exception 'pm.retired'; end if;
    if a.state<>'ready' then raise exception 'pm.not_ready'; end if;
    ver:=(p->>'expectedVersion')::bigint;
    if ver<>a.version then raise exception 'pm.conflict'; end if;
    if op='retire' then
     update clinical_core.program_media_artifacts set state='retired',retired_at=clock_timestamp(),version=version+1 where id=a.id returning * into a;
     insert into clinical_core.program_media_events(artifact_id,organization_id,actor_id,event) values(a.id,org,actor,'retired');
    else
     txt:=p->'text';slot:=p->>'slot';
     if slot not in('caption','transcript') or jsonb_typeof(txt) is distinct from 'object' or (select count(*) from jsonb_object_keys(txt))<>4
     or not(txt ?& array['text','source','format','sha256']) or txt->>'source' not in('supplied_by_author','supplied_vendor_file')
     or txt->>'format' not in('plain','vtt') or char_length(txt->>'text') not between 1 and 200000
     or txt->>'sha256' is distinct from encode(sha256(convert_to(txt->>'text','UTF8')),'hex')
     or (a.kind='image' and (slot='transcript' or txt->>'format'<>'plain')) then raise exception 'pm.request_invalid'; end if;
     if slot='caption' then
      update clinical_core.program_media_artifacts set caption_text=txt->>'text',caption_source=txt->>'source',caption_format=txt->>'format',caption_sha256=txt->>'sha256',version=version+1 where id=a.id returning * into a;
     else
      update clinical_core.program_media_artifacts set transcript_text=txt->>'text',transcript_source=txt->>'source',transcript_format=txt->>'format',transcript_sha256=txt->>'sha256',version=version+1 where id=a.id returning * into a;
     end if;
     insert into clinical_core.program_media_events(artifact_id,organization_id,actor_id,event) values(a.id,org,actor,slot);
    end if; data:=clinical_private.program_media_artifact_json(a);
   elsif op='hasPublication' then
    data:=to_jsonb(exists(select 1 from clinical_core.program_media_publications where artifact_id=a.id and organization_id=org and reference=r));
   elsif op='recordPublication' then
    if exists(select 1 from clinical_core.program_media_publications where artifact_id=a.id and reference=r) then data:='null'::jsonb;
    else
     insert into clinical_core.program_media_publications(artifact_id,organization_id,version,sha256,url,published_by,published_at,reference)
      values(a.id,org,(r->>'version')::bigint,r->>'sha256',r->>'url',actor,(r->>'publishedAt')::timestamptz,r);
     insert into clinical_core.program_media_events(artifact_id,organization_id,actor_id,event) values(a.id,org,actor,'published');data:='null'::jsonb;
    end if;
   end if;
  end if;
 end if;
 return jsonb_build_object('contractVersion','program-media-native-ledger/1','ok',true,'data',data);
exception when others then
 failure:=case when SQLERRM like 'pm.%' then substr(SQLERRM,4)
 when SQLERRM in('program_media_claim_mismatch','program_media_commit_not_admitted','program_media_commit_refused','program_media_cleanup_not_admitted','program_media_writer_pending','program_media_version_stale','program_media_publication_refused','program_media_not_ready','program_media_url_mismatch') then 'conflict'
 when SQLERRM in('program_media_absence_unproven','program_media_work_refused') or SQLSTATE in('22P02','22007','22008','23514') then 'request_invalid'
 when SQLSTATE='23505' then 'conflict' else 'service_unavailable' end;
 if failure not in('access_refused','program_media_disabled','request_invalid','not_found','conflict','retired','not_ready','storage_unverified') then failure:='service_unavailable'; end if;
 return jsonb_build_object('contractVersion','program-media-native-ledger/1','ok',false,'error',failure);
end $$;

-- Adopt the existing helpers under the restricted non-bypass owner so the
-- embedded journey exercises FORCE RLS rather than an administrator bypass.
grant create on schema clinical_core,clinical_private to program_media_authority;
alter function clinical_core.program_media_request(jsonb) owner to program_media_authority;
alter function clinical_private.program_media_require_actor() owner to program_media_authority;
alter function clinical_private.program_media_require_program(uuid) owner to program_media_authority;
alter function clinical_private.program_media_reservation_json(clinical_core.program_media_artifacts,boolean) owner to program_media_authority;
alter function clinical_private.program_media_artifact_json(clinical_core.program_media_artifacts) owner to program_media_authority;
alter function clinical_private.program_media_begin_work(uuid,uuid,uuid,uuid,text) owner to program_media_authority;
alter function clinical_private.program_media_finish_work(uuid,uuid,uuid,uuid,text) owner to program_media_authority;
alter function clinical_private.program_media_begin_cleanup(uuid,uuid,uuid,uuid) owner to program_media_authority;
alter function clinical_private.program_media_commit_work(uuid,uuid,uuid,uuid,text) owner to program_media_authority;
alter function clinical_private.program_media_certify_cleanup(uuid,uuid,uuid,uuid,jsonb) owner to program_media_authority;
alter function clinical_private.program_media_mutation_fence() owner to program_media_authority;
alter function clinical_private.program_media_full_reference_admit() owner to program_media_authority;
alter function clinical_private.program_media_publication_admit() owner to program_media_authority;
revoke create on schema clinical_core,clinical_private from program_media_authority;
grant execute on function clinical_private.program_media_extension(text) to program_media_authority;
revoke all on function clinical_core.program_media_request(jsonb) from public,clinical_core_api;
grant execute on function clinical_core.program_media_request(jsonb) to program_media_worker;
revoke all on function clinical_private.program_media_require_actor(),clinical_private.program_media_require_program(uuid),
 clinical_private.program_media_reservation_json(clinical_core.program_media_artifacts,boolean),
 clinical_private.program_media_artifact_json(clinical_core.program_media_artifacts) from public,clinical_core_api,program_media_worker;
