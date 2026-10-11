-- BLOCKED, distinct source successor to program-media-ledger.sql, SHA-256
-- 6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d.
-- Apply only in embedded qualification after that exact candidate and its
-- pinned synthetic parents. NOT registered, reviewed, deployed or activated.
-- The old source identity is preserved. No runtime/API grants are added.
--
-- Durable admissions are not expiring leases. An open or uncertain storage
-- writer prevents cleanup regardless of elapsed time. A reviewed recovery
-- protocol is needed to resolve crashed/uncertain writers; this artifact does
-- not invent a provider settlement bound or grant a deletion SLA.
-- Every function is one short SQL transaction. Storage I/O MUST occur outside
-- it. All writers and cleanup use the same artifact row lock and durable seal.

create table clinical_private.program_media_work (
 claim_id uuid primary key,
 artifact_id uuid not null references clinical_core.program_media_artifacts(id),
 organization_id uuid not null references clinical_core.organizations(id),
 actor_id uuid not null references clinical_core.persons(id),
 kind text not null check(kind in('admit','reconcile','cleanup')),
 state text not null default 'open' check(state in('open','uncertain','settled')),
 started_at timestamptz not null default clock_timestamp(),
 settled_at timestamptz,
 check((state='open')=(settled_at is null))
);
create index program_media_work_unsettled on clinical_private.program_media_work(artifact_id)
 where kind<>'cleanup' and state<>'settled';
create table clinical_private.program_media_cleanup_seals (
 artifact_id uuid primary key references clinical_core.program_media_artifacts(id),
 started_at timestamptz not null default clock_timestamp(),
 certified_at timestamptz,
 certified_by uuid references clinical_core.persons(id),
 proof jsonb,
 proof_sha256 text check(proof_sha256 is null or proof_sha256 ~ '^[a-f0-9]{64}$'),
 check((proof is null)=(certified_at is null) and (proof is null)=(certified_by is null) and (proof is null)=(proof_sha256 is null))
);
alter table clinical_private.program_media_work enable row level security;
alter table clinical_private.program_media_work force row level security;
alter table clinical_private.program_media_cleanup_seals enable row level security;
alter table clinical_private.program_media_cleanup_seals force row level security;
revoke all on clinical_private.program_media_work,clinical_private.program_media_cleanup_seals from public,clinical_core_api;
create trigger program_media_work_no_delete before delete on clinical_private.program_media_work
 for each row execute function clinical_private.block_update_delete();
create trigger program_media_cleanup_seals_no_delete before delete on clinical_private.program_media_cleanup_seals
 for each row execute function clinical_private.block_update_delete();
create function clinical_private.program_media_work_transition() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (new.claim_id,new.artifact_id,new.organization_id,new.actor_id,new.kind,new.started_at)
 is distinct from (old.claim_id,old.artifact_id,old.organization_id,old.actor_id,old.kind,old.started_at)
 or old.state<>'open' then raise exception 'program_media_work_immutable'; end if;
 return new;
end $$;
create trigger program_media_work_transition before update on clinical_private.program_media_work
 for each row execute function clinical_private.program_media_work_transition();
create function clinical_private.program_media_cleanup_proof_transition() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (new.artifact_id,new.started_at) is distinct from (old.artifact_id,old.started_at) or old.proof is not null
 or new.proof is null or new.proof_sha256 is distinct from encode(sha256(convert_to(new.proof::text,'UTF8')),'hex') then
  raise exception 'program_media_cleanup_proof_immutable'; end if;
 return new;
end $$;
create trigger program_media_cleanup_proof_transition before update on clinical_private.program_media_cleanup_seals
 for each row execute function clinical_private.program_media_cleanup_proof_transition();

create function clinical_private.program_media_begin_work(_org uuid,_actor uuid,_artifact uuid,_claim uuid,_kind text) returns boolean
language plpgsql security definer set search_path='' as $$
declare a clinical_core.program_media_artifacts%rowtype; w clinical_private.program_media_work%rowtype;
begin
 if _org is null or _actor is null or _artifact is null or _claim is null or _kind is null or _kind not in('admit','reconcile') then
  raise exception 'program_media_work_refused'; end if;
 select * into a from clinical_core.program_media_artifacts where id=_artifact and organization_id=_org for update;
 if a.id is null then return false; end if;
 select * into w from clinical_private.program_media_work where claim_id=_claim;
 if w.claim_id is not null then
  if (w.artifact_id,w.organization_id,w.actor_id,w.kind) is distinct from (_artifact,_org,_actor,_kind) then raise exception 'program_media_claim_mismatch'; end if;
  return w.state='open';
 end if;
 if a.state in('held','retired','abandoned') or exists(select 1 from clinical_private.program_media_cleanup_seals where artifact_id=_artifact)
 or (_kind='admit' and clock_timestamp()>=a.accept_before) then return false; end if;
 insert into clinical_private.program_media_work(claim_id,artifact_id,organization_id,actor_id,kind) values(_claim,_artifact,_org,_actor,_kind);
 return true;
end $$;

create function clinical_private.program_media_finish_work(_org uuid,_actor uuid,_artifact uuid,_claim uuid,_outcome text) returns void
language plpgsql security definer set search_path='' as $$
declare w clinical_private.program_media_work%rowtype;
begin
 perform 1 from clinical_core.program_media_artifacts where id=_artifact and organization_id=_org for update;
 if not found or _outcome is null or _outcome not in('settled','uncertain') then raise exception 'program_media_work_refused'; end if;
 select * into w from clinical_private.program_media_work where claim_id=_claim and artifact_id=_artifact and organization_id=_org and actor_id=_actor and kind<>'cleanup';
 if w.claim_id is null or (w.state<>'open' and w.state<>_outcome) then raise exception 'program_media_claim_mismatch'; end if;
 update clinical_private.program_media_work set state=_outcome,settled_at=clock_timestamp() where claim_id=_claim and state='open';
end $$;

create function clinical_private.program_media_begin_cleanup(_org uuid,_actor uuid,_artifact uuid,_claim uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare a clinical_core.program_media_artifacts%rowtype; w clinical_private.program_media_work%rowtype;
begin
 if _org is null or _actor is null or _artifact is null or _claim is null then raise exception 'program_media_work_refused'; end if;
 select * into a from clinical_core.program_media_artifacts where id=_artifact and organization_id=_org for update;
 if a.id is null or a.state in('ready','retired','held') or clock_timestamp()<a.accept_before
 or exists(select 1 from clinical_private.program_media_work where artifact_id=_artifact and kind<>'cleanup' and state<>'settled')
 or exists(select 1 from clinical_private.program_media_cleanup_seals where artifact_id=_artifact and proof is not null) then return false; end if;
 select * into w from clinical_private.program_media_work where claim_id=_claim;
 if w.claim_id is not null then
  if (w.artifact_id,w.organization_id,w.actor_id,w.kind) is distinct from (_artifact,_org,_actor,'cleanup'::text) then raise exception 'program_media_claim_mismatch'; end if;
  return w.state='open';
 end if;
 insert into clinical_private.program_media_cleanup_seals(artifact_id) values(_artifact) on conflict do nothing;
 insert into clinical_private.program_media_work(claim_id,artifact_id,organization_id,actor_id,kind) values(_claim,_artifact,_org,_actor,'cleanup');
 return true;
end $$;

create function clinical_private.program_media_mutation_fence() returns trigger
language plpgsql security definer set search_path='' as $$
declare c text:=current_setting('alp.program_media_work_claim',true);
begin
 if new.state='ready' and old.state<>'ready' then
  if c is null or c !~ '^[a-f0-9-]{36}$' or exists(select 1 from clinical_private.program_media_cleanup_seals where artifact_id=old.id)
  or not exists(select 1 from clinical_private.program_media_work where claim_id=c::uuid and artifact_id=old.id and organization_id=old.organization_id and kind in('admit','reconcile') and state='open') then
   raise exception 'program_media_commit_not_admitted'; end if;
 end if;
 if new.state='abandoned' and exists(select 1 from clinical_private.program_media_work where artifact_id=old.id and kind<>'cleanup' and state<>'settled') then
  raise exception 'program_media_writer_pending'; end if;
 return new;
end $$;
create trigger program_media_mutation_fence before update on clinical_core.program_media_artifacts
 for each row execute function clinical_private.program_media_mutation_fence();

create function clinical_private.program_media_commit_work(_org uuid,_actor uuid,_artifact uuid,_claim uuid,_object_version text) returns void
language plpgsql security definer set search_path='' as $$
declare a clinical_core.program_media_artifacts%rowtype; previous text;
begin
 select * into a from clinical_core.program_media_artifacts where id=_artifact and organization_id=_org for update;
 if a.id is null or exists(select 1 from clinical_private.program_media_cleanup_seals where artifact_id=_artifact)
 or not exists(select 1 from clinical_private.program_media_work where claim_id=_claim and artifact_id=_artifact and organization_id=_org and actor_id=_actor and kind in('admit','reconcile') and state='open') then
  raise exception 'program_media_commit_not_admitted'; end if;
 if a.state='ready' and a.object_version=_object_version then return; end if;
 if a.state not in('reserved','error') then raise exception 'program_media_commit_refused'; end if;
 previous:=current_setting('alp.program_media_work_claim',true);
 perform set_config('alp.program_media_work_claim',_claim::text,true);
 update clinical_core.program_media_artifacts set state='ready',object_version=_object_version,committed_at=clock_timestamp(),version=version+1 where id=_artifact;
 perform set_config('alp.program_media_work_claim',coalesce(previous,''),true);
end $$;

create function clinical_private.program_media_certify_cleanup(_org uuid,_actor uuid,_artifact uuid,_claim uuid,_proof jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare a clinical_core.program_media_artifacts%rowtype;
begin
 select * into a from clinical_core.program_media_artifacts where id=_artifact and organization_id=_org for update;
 if a.id is null or a.state in('ready','retired','held')
 or not exists(select 1 from clinical_private.program_media_cleanup_seals where artifact_id=_artifact and proof is null)
 or not exists(select 1 from clinical_private.program_media_work where claim_id=_claim and artifact_id=_artifact and organization_id=_org and actor_id=_actor and kind='cleanup' and state='open')
 or exists(select 1 from clinical_private.program_media_work where artifact_id=_artifact and kind<>'cleanup' and state<>'settled') then raise exception 'program_media_cleanup_not_admitted'; end if;
 if _proof is null or jsonb_typeof(_proof) is distinct from 'object'
 or (_proof->>'artifactId') is distinct from _artifact::text or (_proof->>'claimId') is distinct from _claim::text
 or (_proof->>'objectKey') is distinct from a.object_key or (_proof->'complete') is distinct from 'true'::jsonb
 or (_proof->'remainingVersions') is distinct from '0'::jsonb or jsonb_typeof(_proof->'removedVersions') is distinct from 'array'
 or jsonb_array_length(_proof->'removedVersions')>1000 or jsonb_typeof(_proof->'checkedAt') is distinct from 'string'
 or (select count(*) from jsonb_object_keys(_proof))<>7
 or exists(select 1 from jsonb_array_elements(_proof->'removedVersions') v where jsonb_typeof(v) is distinct from 'string' or char_length(v#>>'{}') not between 1 and 1024) then raise exception 'program_media_absence_unproven'; end if;
 if (_proof->>'checkedAt')::timestamptz<=(select started_at from clinical_private.program_media_cleanup_seals where artifact_id=_artifact)-interval '1 second'
 or (_proof->>'checkedAt')::timestamptz>clock_timestamp()+interval '1 second' then raise exception 'program_media_absence_unproven'; end if;
 -- This receipt attests the trusted store adapter's complete exact-key listing,
 -- not merely its DeleteObject response. Native observation is still required.
 update clinical_private.program_media_cleanup_seals set certified_at=clock_timestamp(),certified_by=_actor,proof=_proof,
 proof_sha256=encode(sha256(convert_to(_proof::text,'UTF8')),'hex') where artifact_id=_artifact;
 if a.state<>'abandoned' then update clinical_core.program_media_artifacts set state='abandoned',failure='absence_proven',version=version+1 where id=_artifact; end if;
 update clinical_private.program_media_work set state='settled',settled_at=clock_timestamp() where claim_id=_claim;
end $$;

-- A whole publication is immutable evidence, including supplied-text provenance.
-- Existing rows without this column remain unknown, never retroactively verified.
alter table clinical_core.program_media_publications add column reference jsonb;
create function clinical_private.program_media_full_reference_admit() returns trigger
language plpgsql security definer set search_path='' as $$
declare a clinical_core.program_media_artifacts%rowtype; expected jsonb;
begin
 select * into a from clinical_core.program_media_artifacts where id=new.artifact_id for update;
 if a.id is null or a.state<>'ready' or a.version<>new.version or a.organization_id<>new.organization_id
 or new.reference is null or jsonb_typeof(new.reference) is distinct from 'object' then raise exception 'program_media_publication_refused'; end if;
 expected:=jsonb_build_object('contractVersion','program-media-reference/1','artifactId',a.id,'version',a.version,'sha256',a.sha256,
 'kind',a.kind,'contentType',a.content_type,'bytes',a.bytes,'origin',jsonb_build_object('clinic',a.organization_id,'programId',a.program_id),
 'url',new.url,'publishedAt',new.reference->'publishedAt',
 'caption',case when a.caption_text is null then null else jsonb_build_object('source',a.caption_source,'sha256',a.caption_sha256) end,
 'transcript',case when a.transcript_text is null then null else jsonb_build_object('source',a.transcript_source,'sha256',a.transcript_sha256,'format',a.transcript_format) end);
 if new.reference is distinct from expected or jsonb_typeof(new.reference->'publishedAt') is distinct from 'string'
 or (new.reference->>'publishedAt')::timestamptz is distinct from new.published_at then raise exception 'program_media_publication_refused'; end if;
 return new;
end $$;
create trigger program_media_full_reference_admit before insert on clinical_core.program_media_publications
 for each row execute function clinical_private.program_media_full_reference_admit();

revoke all on function clinical_private.program_media_begin_work(uuid,uuid,uuid,uuid,text),
 clinical_private.program_media_finish_work(uuid,uuid,uuid,uuid,text),
 clinical_private.program_media_begin_cleanup(uuid,uuid,uuid,uuid),
 clinical_private.program_media_mutation_fence(),
 clinical_private.program_media_commit_work(uuid,uuid,uuid,uuid,text),
 clinical_private.program_media_certify_cleanup(uuid,uuid,uuid,uuid,jsonb),
 clinical_private.program_media_full_reference_admit(),
 clinical_private.program_media_work_transition(),clinical_private.program_media_cleanup_proof_transition() from public,clinical_core_api;
