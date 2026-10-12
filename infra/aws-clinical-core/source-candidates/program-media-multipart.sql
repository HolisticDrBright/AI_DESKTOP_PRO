-- BLOCKED, unregistered, unapplied source candidate. Activation OFF.
-- Exact native parent 69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7,
-- itself on preserved ledger 6dae2f23 and selected settlement 74f54bbb.
-- Synthetic educational media only. This is not an installed migration.
-- Provider I/O and bounded whole-object verification occur OUTSIDE SQL.
-- A composite checksum is never whole-file SHA256. Provider receipts and
-- absence/whole-file observations may enter only from a qualified host adapter,
-- never a browser assertion. Unknown writers do not expire or retry themselves.

alter table clinical_core.program_media_activation
 add column multipart_enabled boolean not null default false,
 add column multipart_evidence_sha256 text check(multipart_evidence_sha256 is null or multipart_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 add constraint program_media_multipart_activation_complete check(not multipart_enabled or
  multipart_evidence_sha256 is not null);
-- Parent withdrawal must remain independently usable by its existing operator.
-- require_actor still requires the parent enabled/current on EVERY operation;
-- this new completeness constraint must not prevent that parent being disabled.

create table clinical_private.program_media_multipart (
 artifact_id uuid primary key references clinical_core.program_media_artifacts(id),
 organization_id uuid not null references clinical_core.organizations(id),
 actor_id uuid not null references clinical_core.persons(id),
 writer_claim_id uuid not null unique references clinical_private.program_media_work(claim_id),
 manifest jsonb not null,
 composite_checksum text not null,
 state text not null default 'prepared' check(state in('prepared','creation_admitted','uploading','completion_admitted','verifying','abort_requested','committed','aborted')),
 upload_id text check(upload_id is null or char_length(upload_id) between 1 and 1024),
 object_version text check(object_version is null or (char_length(object_version) between 1 and 1024 and object_version<>'null')),
 verified_proof jsonb,
 absence_proof jsonb,
 created_at timestamptz not null default clock_timestamp(),
 cancel_requested_at timestamptz,
 check((state='committed')=(verified_proof is not null)),
 check((state='aborted')=(absence_proof is not null))
);
create table clinical_private.program_media_multipart_attempts (
 claim_id uuid primary key,
 artifact_id uuid not null references clinical_private.program_media_multipart(artifact_id),
 organization_id uuid not null references clinical_core.organizations(id),
 actor_id uuid not null references clinical_core.persons(id),
 kind text not null check(kind in('creation','part','completion')),
 part_number integer,
 state text not null default 'open' check(state in('open','uncertain','settled')),
 outcome text check(outcome in('uncertain','not_sent','failed_before_mutation','receipt')),
 receipt jsonb,
 started_at timestamptz not null default clock_timestamp(),
 settled_at timestamptz,
 check((kind='part')=(part_number is not null)),
 check(part_number is null or part_number between 1 and 32),
 check((state='settled')=(settled_at is not null)),
 check((state='open')=(outcome is null)),
 check(state<>'uncertain' or outcome='uncertain'),
 check((state='settled')=coalesce(outcome in('not_sent','failed_before_mutation','receipt'),false)),
 check((receipt is not null)=coalesce(outcome='receipt',false))
);
create unique index program_media_multipart_one_pending on clinical_private.program_media_multipart_attempts(artifact_id,kind,coalesce(part_number,0))
 where state<>'settled';
create index program_media_multipart_attempt_history on clinical_private.program_media_multipart_attempts(artifact_id,started_at,claim_id);
create table clinical_private.program_media_multipart_parts (
 artifact_id uuid not null references clinical_private.program_media_multipart(artifact_id),
 organization_id uuid not null references clinical_core.organizations(id),
 part_number integer not null check(part_number between 1 and 32),
 claim_id uuid not null unique references clinical_private.program_media_multipart_attempts(claim_id),
 bytes bigint not null check(bytes between 1 and 8388608),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 checksum text not null,
 etag text not null check(char_length(etag) between 1 and 1024),
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(artifact_id,part_number)
);
create table clinical_private.program_media_multipart_events (
 id uuid primary key default gen_random_uuid(),
 artifact_id uuid not null references clinical_private.program_media_multipart(artifact_id),
 organization_id uuid not null references clinical_core.organizations(id),
 actor_id uuid not null references clinical_core.persons(id),
 operation text not null check(operation in('start','admitCreation','recordUpload','admitPart','recordPart','admitCompletion','recordCompletion','settleAttempt','cancel','commit','certifyAbort')),
 request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 multipart_evidence_sha256 text not null check(multipart_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 state text not null,
 admitted boolean not null,
 occurred_at timestamptz not null default clock_timestamp(),
 unique(artifact_id,operation,request_sha256)
);
alter table clinical_private.program_media_multipart enable row level security;
alter table clinical_private.program_media_multipart force row level security;
alter table clinical_private.program_media_multipart_attempts enable row level security;
alter table clinical_private.program_media_multipart_attempts force row level security;
alter table clinical_private.program_media_multipart_parts enable row level security;
alter table clinical_private.program_media_multipart_parts force row level security;
alter table clinical_private.program_media_multipart_events enable row level security;
alter table clinical_private.program_media_multipart_events force row level security;
revoke all on clinical_private.program_media_multipart,clinical_private.program_media_multipart_attempts,
 clinical_private.program_media_multipart_parts,clinical_private.program_media_multipart_events from public,clinical_core_api,program_media_worker;
grant select,insert,update on clinical_private.program_media_multipart,clinical_private.program_media_multipart_attempts to program_media_authority;
grant select,insert on clinical_private.program_media_multipart_parts to program_media_authority;
grant select,insert on clinical_private.program_media_multipart_events to program_media_authority;
create policy program_media_multipart_scope on clinical_private.program_media_multipart to program_media_authority
 using(organization_id=clinical_private.organization_id() and actor_id=clinical_private.actor_person_id())
 with check(organization_id=clinical_private.organization_id() and actor_id=clinical_private.actor_person_id());
create policy program_media_multipart_attempt_scope on clinical_private.program_media_multipart_attempts to program_media_authority
 using(organization_id=clinical_private.organization_id() and actor_id=clinical_private.actor_person_id())
 with check(organization_id=clinical_private.organization_id() and actor_id=clinical_private.actor_person_id());
create policy program_media_multipart_part_scope on clinical_private.program_media_multipart_parts to program_media_authority
 using(organization_id=clinical_private.organization_id())
 with check(organization_id=clinical_private.organization_id());
create policy program_media_multipart_event_scope on clinical_private.program_media_multipart_events to program_media_authority
 using(organization_id=clinical_private.organization_id()) with check(organization_id=clinical_private.organization_id() and actor_id=clinical_private.actor_person_id());
create trigger program_media_multipart_no_delete before delete on clinical_private.program_media_multipart
 for each row execute function clinical_private.block_update_delete();
create trigger program_media_multipart_attempt_no_delete before delete on clinical_private.program_media_multipart_attempts
 for each row execute function clinical_private.block_update_delete();
create trigger program_media_multipart_part_immutable before update or delete on clinical_private.program_media_multipart_parts
 for each row execute function clinical_private.block_update_delete();
create trigger program_media_multipart_event_immutable before update or delete on clinical_private.program_media_multipart_events
 for each row execute function clinical_private.block_update_delete();

create function clinical_private.program_media_multipart_transition() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='program_media_multipart' then
  if (new.artifact_id,new.organization_id,new.actor_id,new.writer_claim_id,new.manifest,new.composite_checksum,new.created_at)
   is distinct from (old.artifact_id,old.organization_id,old.actor_id,old.writer_claim_id,old.manifest,old.composite_checksum,old.created_at)
   or (old.upload_id is not null and new.upload_id is distinct from old.upload_id)
   or (old.object_version is not null and new.object_version is distinct from old.object_version)
   or (old.verified_proof is not null and new.verified_proof is distinct from old.verified_proof)
   or (old.absence_proof is not null and new.absence_proof is distinct from old.absence_proof)
   or (old.cancel_requested_at is not null and new.cancel_requested_at is distinct from old.cancel_requested_at)
   or (old.state in('committed','aborted') and new is distinct from old) then raise exception 'pm.conflict'; end if;
 else
  if (new.claim_id,new.artifact_id,new.organization_id,new.actor_id,new.kind,new.part_number,new.started_at)
   is distinct from (old.claim_id,old.artifact_id,old.organization_id,old.actor_id,old.kind,old.part_number,old.started_at)
   or (old.state='settled' and new is distinct from old)
   or (old.state='uncertain' and new.state='open') then raise exception 'pm.conflict'; end if;
 end if;
 return new;
end $$;
create trigger program_media_multipart_transition before update on clinical_private.program_media_multipart
 for each row execute function clinical_private.program_media_multipart_transition();
create trigger program_media_multipart_attempt_transition before update on clinical_private.program_media_multipart_attempts
 for each row execute function clinical_private.program_media_multipart_transition();

-- FORCE RLS for the native authority is clinic scoped here (rather than actor
-- scoped) so the shared parent fences can see another author's session. The
-- closed multipart RPC separately resolves and requires its immutable author.
drop policy program_media_multipart_scope on clinical_private.program_media_multipart;
create policy program_media_multipart_scope on clinical_private.program_media_multipart to program_media_authority
 using(organization_id=clinical_private.organization_id()) with check(organization_id=clinical_private.organization_id());

create function clinical_private.program_media_multipart_parent_fence() returns trigger
language plpgsql security definer set search_path='' as $$
declare m clinical_private.program_media_multipart%rowtype;
begin
 if tg_table_name='program_media_artifacts' then
  select * into m from clinical_private.program_media_multipart where artifact_id=new.id;
  if m.artifact_id is not null and new.state='ready' and old.state<>'ready' and
   (m.state<>'committed' or m.verified_proof is null or m.verified_proof->>'objectVersion' is distinct from new.object_version
    or m.verified_proof->>'sha256' is distinct from new.sha256 or (m.verified_proof->>'bytes')::bigint is distinct from new.bytes)
   then raise exception 'program_media_commit_not_admitted'; end if;
 else
  select * into m from clinical_private.program_media_multipart where artifact_id=new.artifact_id;
  if m.artifact_id is not null and
   ((tg_op='INSERT' and new.kind<>'cleanup' and new.claim_id<>m.writer_claim_id and m.state not in('committed','aborted'))
    or (tg_op='UPDATE' and new.claim_id=m.writer_claim_id and new.state is distinct from old.state and
     (m.state not in('committed','aborted') or exists(select 1 from clinical_private.program_media_multipart_attempts where artifact_id=m.artifact_id and state<>'settled'))))
   then raise exception 'program_media_writer_pending'; end if;
 end if;
 return new;
end $$;
create trigger program_media_multipart_work_fence before insert or update on clinical_private.program_media_work
 for each row execute function clinical_private.program_media_multipart_parent_fence();
create trigger program_media_multipart_commit_fence before update on clinical_core.program_media_artifacts
 for each row execute function clinical_private.program_media_multipart_parent_fence();

create function clinical_private.program_media_multipart_json(_m clinical_private.program_media_multipart,_a clinical_core.program_media_artifacts) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('artifactId',_m.artifact_id,'clinic',_m.organization_id,'programId',_a.program_id,'actorId',_m.actor_id,
 'writerClaimId',_m.writer_claim_id,'kind',_a.kind,'contentType',_a.content_type,'sha256',_a.sha256,'totalBytes',_a.bytes,
 'objectKey',_a.object_key,'acceptBefore',_a.accept_before,'manifest',_m.manifest,'checksum',_m.composite_checksum,
 'uploadId',_m.upload_id,'objectVersion',_m.object_version,'state',_m.state,
 'parts',coalesce((select jsonb_agg(jsonb_build_object('partNumber',p.part_number,'bytes',p.bytes,'sha256',p.sha256,'checksum',p.checksum,'etag',p.etag) order by p.part_number)
  from clinical_private.program_media_multipart_parts p where p.artifact_id=_m.artifact_id),'[]'::jsonb),
 'pending',coalesce((select jsonb_agg(jsonb_build_object('claimId',w.claim_id,'kind',w.kind,'partNumber',w.part_number,'state',w.state) order by w.kind,w.part_number)
  from clinical_private.program_media_multipart_attempts w where w.artifact_id=_m.artifact_id and w.state<>'settled'),'[]'::jsonb))
$$;

create function clinical_core.program_media_multipart_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; org uuid:=clinical_private.organization_id(); op text; p jsonb; keys text[]; parent jsonb;
 a clinical_core.program_media_artifacts%rowtype; m clinical_private.program_media_multipart%rowtype;
 w clinical_private.program_media_multipart_attempts%rowtype; activation clinical_core.program_media_activation%rowtype;
 artifact uuid; claim uuid; partno integer; part jsonb; item jsonb; recipe jsonb; material bytea:=''::bytea;
 checksum text; total bigint; n integer; i integer; work_kind text; result_receipt jsonb; work_outcome text; admitted boolean:=false; failure text; checked timestamptz;
begin
 actor:=clinical_private.program_media_require_actor();
 if _request is null or jsonb_typeof(_request) is distinct from 'object' or (select count(*) from jsonb_object_keys(_request))<>4
 or not(_request ?& array['operation','parameters','release','multipartEvidenceSha256'])
 or jsonb_typeof(_request->'operation') is distinct from 'string' or jsonb_typeof(_request->'parameters') is distinct from 'object' then raise exception 'pm.request_invalid'; end if;
 select * into activation from clinical_core.program_media_activation where singleton;
 if not activation.multipart_enabled then raise exception 'pm.program_media_disabled'; end if;
 if _request->>'multipartEvidenceSha256' is distinct from activation.multipart_evidence_sha256 then raise exception 'pm.storage_unverified'; end if;
 op:=_request->>'operation';p:=_request->'parameters';
 keys:=case op when 'start' then array['artifactId','manifest','writerClaimId']
 when 'status' then array['artifactId'] when 'cancel' then array['artifactId']
 when 'admitCreation' then array['artifactId','claimId'] when 'recordUpload' then array['artifactId','claimId','uploadId']
 when 'admitPart' then array['artifactId','claimId','partNumber'] when 'recordPart' then array['artifactId','claimId','partNumber','receipt']
 when 'admitCompletion' then array['artifactId','claimId'] when 'recordCompletion' then array['artifactId','claimId','objectVersion','checksum']
 when 'settleAttempt' then array['artifactId','claimId','outcome'] when 'commit' then array['artifactId','proof']
 when 'certifyAbort' then array['artifactId','proof'] end;
 if keys is null or not(p ?& keys) or (select count(*) from jsonb_object_keys(p))<>cardinality(keys) then raise exception 'pm.request_invalid'; end if;
 artifact:=(p->>'artifactId')::uuid;
 -- The existing family locks the CURRENT authority/release/program/artifact.
 -- A caught parent refusal must become an exception so this transaction cannot
 -- persist a multipart change under an invalid release.
 parent:=clinical_core.program_media_request(jsonb_build_object('operation','reservation','parameters',jsonb_build_object('artifactId',artifact),'release',_request->'release'));
 if parent->'ok' is distinct from 'true'::jsonb then raise exception 'pm.%',parent->>'error'; end if;
 select * into a from clinical_core.program_media_artifacts where id=artifact and organization_id=org for update;
 if a.id is null then raise exception 'pm.not_found'; end if;
 select * into m from clinical_private.program_media_multipart where artifact_id=artifact for update;
 if m.artifact_id is not null and m.actor_id<>actor then raise exception 'pm.access_refused'; end if;
 if op='start' then
  recipe:=p->'manifest';total:=(recipe->>'totalBytes')::bigint;
  if a.kind<>'video' or total is distinct from a.bytes or total not between 1 and 268435456
   or jsonb_typeof(recipe) is distinct from 'object' or (select count(*) from jsonb_object_keys(recipe))<>2
   or not(recipe ?& array['totalBytes','parts']) or jsonb_typeof(recipe->'totalBytes') is distinct from 'number'
   or jsonb_typeof(recipe->'parts') is distinct from 'array' then raise exception 'pm.request_invalid'; end if;
  n:=ceil(total::numeric/8388608)::int;
  if jsonb_array_length(recipe->'parts')<>n then raise exception 'pm.request_invalid'; end if;
  for i in 1..n loop
   item:=recipe->'parts'->(i-1);
   if jsonb_typeof(item) is distinct from 'object' or (select count(*) from jsonb_object_keys(item))<>3
    or not(item ?& array['partNumber','bytes','sha256']) or jsonb_typeof(item->'partNumber') is distinct from 'number'
    or jsonb_typeof(item->'bytes') is distinct from 'number' or jsonb_typeof(item->'sha256') is distinct from 'string'
    or (item->>'partNumber')::int<>i or (item->>'bytes')::bigint<>least(8388608,total-(i-1)::bigint*8388608)
    or item->>'sha256' !~ '^[a-f0-9]{64}$' then raise exception 'pm.request_invalid'; end if;
   material:=material||decode(item->>'sha256','hex');
  end loop;
  checksum:=encode(sha256(material),'base64')||'-'||n;
  if m.artifact_id is not null then
   if m.manifest is distinct from recipe then raise exception 'pm.conflict'; end if;
  else
   if a.state<>'reserved' or clock_timestamp()>=a.accept_before
    or exists(select 1 from clinical_private.program_media_work where artifact_id=artifact and kind<>'cleanup' and state<>'settled')
    then raise exception 'pm.conflict'; end if;
   claim:=(p->>'writerClaimId')::uuid;
   if not clinical_private.program_media_begin_work(org,actor,artifact,claim,'admit') then raise exception 'pm.conflict'; end if;
   insert into clinical_private.program_media_multipart(artifact_id,organization_id,actor_id,writer_claim_id,manifest,composite_checksum)
    values(artifact,org,actor,claim,recipe,checksum) returning * into m;admitted:=true;
  end if;
 elsif m.artifact_id is null then raise exception 'pm.not_found';
 elsif op in('admitCreation','admitPart','admitCompletion') then
  claim:=(p->>'claimId')::uuid;work_kind:=case op when 'admitCreation' then 'creation' when 'admitPart' then 'part' else 'completion' end;
  partno:=case when work_kind='part' then (p->>'partNumber')::int else null end;
  if work_kind='part' and partno not between 1 and jsonb_array_length(m.manifest->'parts') then raise exception 'pm.request_invalid'; end if;
  select * into w from clinical_private.program_media_multipart_attempts where claim_id=claim;
  if w.claim_id is not null then
   if (w.artifact_id,w.actor_id,w.kind,w.part_number) is distinct from (artifact,actor,work_kind,partno) then raise exception 'pm.conflict'; end if;
  elsif work_kind='part' and exists(select 1 from clinical_private.program_media_multipart_parts where artifact_id=artifact and part_number=partno) then null;
  else
   if clock_timestamp()>=a.accept_before or m.state is distinct from (case work_kind when 'creation' then 'prepared' else 'uploading' end)
    or exists(select 1 from clinical_private.program_media_multipart_attempts where artifact_id=artifact and kind=work_kind
     and part_number is not distinct from partno and state<>'settled')
    or (work_kind='completion' and ((select count(*) from clinical_private.program_media_multipart_parts where artifact_id=artifact)<>jsonb_array_length(m.manifest->'parts')
     or exists(select 1 from clinical_private.program_media_multipart_attempts where artifact_id=artifact and state<>'settled')))
    then raise exception 'pm.conflict'; end if;
   insert into clinical_private.program_media_multipart_attempts(claim_id,artifact_id,organization_id,actor_id,kind,part_number)
    values(claim,artifact,org,actor,work_kind,partno);
   if work_kind<>'part' then update clinical_private.program_media_multipart set state=case work_kind when 'creation' then 'creation_admitted' else 'completion_admitted' end where artifact_id=artifact;end if;
   admitted:=true;
  end if;
 elsif op in('recordUpload','recordPart','recordCompletion','settleAttempt') then
  claim:=(p->>'claimId')::uuid;
  select * into w from clinical_private.program_media_multipart_attempts where claim_id=claim and artifact_id=artifact and actor_id=actor for update;
  if w.claim_id is null then raise exception 'pm.conflict'; end if;
  if op='settleAttempt' then
   work_outcome:=p->>'outcome';
   if work_outcome is null or jsonb_typeof(p->'outcome') is distinct from 'string'
    or work_outcome not in('uncertain','not_sent','failed_before_mutation') then raise exception 'pm.request_invalid'; end if;
   if w.state='settled' then if w.outcome is distinct from work_outcome then raise exception 'pm.conflict';end if;
   elsif work_outcome='uncertain' then update clinical_private.program_media_multipart_attempts set state='uncertain',outcome='uncertain' where claim_id=claim;
   elsif w.state='uncertain' then raise exception 'pm.conflict';
   else
    update clinical_private.program_media_multipart_attempts set state='settled',outcome=work_outcome,settled_at=clock_timestamp() where claim_id=claim;
    if m.state<>'abort_requested' and w.kind<>'part' then update clinical_private.program_media_multipart set state=case w.kind when 'creation' then 'prepared' else 'uploading' end where artifact_id=artifact;end if;
   end if;
  else
   work_kind:=case op when 'recordUpload' then 'creation' when 'recordPart' then 'part' else 'completion' end;
   if w.kind<>work_kind or (work_kind='part' and w.part_number is distinct from (p->>'partNumber')::int) then raise exception 'pm.conflict'; end if;
   if work_kind='creation' then
    if jsonb_typeof(p->'uploadId') is distinct from 'string' or char_length(p->>'uploadId') not between 1 and 1024 then raise exception 'pm.request_invalid';end if;
    result_receipt:=jsonb_build_object('uploadId',p->'uploadId');
   elsif work_kind='completion' then
    if p->>'checksum' is distinct from m.composite_checksum or jsonb_typeof(p->'objectVersion') is distinct from 'string'
     or char_length(p->>'objectVersion') not between 1 and 1024 or p->>'objectVersion'='null' then raise exception 'pm.request_invalid';end if;
    result_receipt:=jsonb_build_object('objectVersion',p->'objectVersion','checksum',p->'checksum');
   else
    result_receipt:=p->'receipt';part:=m.manifest->'parts'->(w.part_number-1);
    if jsonb_typeof(result_receipt) is distinct from 'object' or (select count(*) from jsonb_object_keys(result_receipt))<>3
     or not(result_receipt ?& array['bytes','checksum','etag']) or result_receipt->'bytes' is distinct from part->'bytes'
     or result_receipt->>'checksum' is distinct from encode(decode(part->>'sha256','hex'),'base64')
     or jsonb_typeof(result_receipt->'etag') is distinct from 'string' or char_length(result_receipt->>'etag') not between 1 and 1024 then raise exception 'pm.request_invalid';end if;
   end if;
   if w.state='settled' then if w.receipt is distinct from result_receipt then raise exception 'pm.conflict';end if;
   else
    if m.state in('committed','aborted') then raise exception 'pm.conflict';end if;
    update clinical_private.program_media_multipart_attempts set state='settled',outcome='receipt',receipt=result_receipt,settled_at=clock_timestamp() where claim_id=claim;
    if work_kind='creation' then update clinical_private.program_media_multipart set upload_id=p->>'uploadId',state=case when m.state='abort_requested' then m.state else 'uploading' end where artifact_id=artifact;
    elsif work_kind='completion' then update clinical_private.program_media_multipart set object_version=p->>'objectVersion',state=case when m.state='abort_requested' then m.state else 'verifying' end where artifact_id=artifact;
    else insert into clinical_private.program_media_multipart_parts(artifact_id,organization_id,part_number,claim_id,bytes,sha256,checksum,etag)
     values(artifact,org,w.part_number,claim,(part->>'bytes')::bigint,part->>'sha256',result_receipt->>'checksum',result_receipt->>'etag');end if;
   end if;
  end if;
 elsif op='cancel' then
  if m.state='committed' then raise exception 'pm.conflict';end if;
  if m.state not in('abort_requested','aborted') then update clinical_private.program_media_multipart set state='abort_requested',cancel_requested_at=clock_timestamp() where artifact_id=artifact;end if;
 elsif op='commit' then
  result_receipt:=p->'proof';
  if result_receipt is distinct from jsonb_build_object('objectVersion',m.object_version,'checksum',m.composite_checksum,'sha256',a.sha256,'bytes',a.bytes) then raise exception 'pm.request_invalid';end if;
  if m.state='committed' then if m.verified_proof is distinct from result_receipt then raise exception 'pm.conflict';end if;
  else
   if m.state<>'verifying' or m.object_version is null or exists(select 1 from clinical_private.program_media_multipart_attempts where artifact_id=artifact and state<>'settled') then raise exception 'pm.conflict';end if;
   update clinical_private.program_media_multipart set state='committed',verified_proof=result_receipt where artifact_id=artifact;
   perform clinical_private.program_media_commit_work(org,actor,artifact,m.writer_claim_id,m.object_version);
   perform clinical_private.program_media_finish_work(org,actor,artifact,m.writer_claim_id,'settled');
   insert into clinical_core.program_media_events(artifact_id,organization_id,actor_id,event) values(artifact,org,actor,'committed');
  end if;
 elsif op='certifyAbort' then
  result_receipt:=p->'proof';
  if m.state='aborted' then if m.absence_proof is distinct from result_receipt then raise exception 'pm.conflict';end if;
  else
   if m.state<>'abort_requested' or exists(select 1 from clinical_private.program_media_multipart_attempts where artifact_id=artifact and state<>'settled') then raise exception 'pm.conflict';end if;
   if jsonb_typeof(result_receipt) is distinct from 'object' or (select count(*) from jsonb_object_keys(result_receipt))<>5
    or not(result_receipt ?& array['complete','remainingUploads','remainingVersions','checkedAt','objectKey'])
    or result_receipt->'complete' is distinct from 'true'::jsonb or result_receipt->'remainingUploads' is distinct from '0'::jsonb
    or result_receipt->'remainingVersions' is distinct from '0'::jsonb or result_receipt->>'objectKey' is distinct from a.object_key then raise exception 'pm.request_invalid';end if;
   checked:=(result_receipt->>'checkedAt')::timestamptz;
   if checked is null or checked<m.cancel_requested_at or checked>clock_timestamp()+interval '1 second'
    or checked<coalesce((select max(settled_at) from clinical_private.program_media_multipart_attempts where artifact_id=artifact),m.created_at) then raise exception 'pm.request_invalid';end if;
   update clinical_private.program_media_multipart set state='aborted',absence_proof=result_receipt where artifact_id=artifact;
   perform clinical_private.program_media_finish_work(org,actor,artifact,m.writer_claim_id,'settled');
  end if;
 end if;
 select * into m from clinical_private.program_media_multipart where artifact_id=artifact;
 select * into a from clinical_core.program_media_artifacts where id=artifact;
 if op<>'status' then
  insert into clinical_private.program_media_multipart_events(artifact_id,organization_id,actor_id,operation,request_sha256,multipart_evidence_sha256,state,admitted)
   values(artifact,org,actor,op,encode(sha256(convert_to(_request::text,'UTF8')),'hex'),activation.multipart_evidence_sha256,m.state,admitted)
   on conflict(artifact_id,operation,request_sha256) do nothing;
 end if;
 return jsonb_build_object('contractVersion','program-media-multipart-ledger/1','ok',true,
  'data',jsonb_build_object('session',clinical_private.program_media_multipart_json(m,a),'admitted',admitted));
exception when others then
 failure:=case when SQLERRM like 'pm.%' then substr(SQLERRM,4) when SQLSTATE in('22P02','22007','22008','23502','23514') then 'request_invalid'
  when SQLSTATE='23505' or SQLERRM in('program_media_writer_pending','program_media_commit_not_admitted','program_media_commit_refused') then 'conflict' else 'service_unavailable' end;
 if failure not in('access_refused','program_media_disabled','request_invalid','not_found','conflict','storage_unverified') then failure:='service_unavailable';end if;
 return jsonb_build_object('contractVersion','program-media-multipart-ledger/1','ok',false,'error',failure);
end $$;

grant create on schema clinical_core,clinical_private to program_media_authority;
alter function clinical_core.program_media_multipart_request(jsonb) owner to program_media_authority;
alter function clinical_private.program_media_multipart_json(clinical_private.program_media_multipart,clinical_core.program_media_artifacts) owner to program_media_authority;
alter function clinical_private.program_media_multipart_transition() owner to program_media_authority;
alter function clinical_private.program_media_multipart_parent_fence() owner to program_media_authority;
revoke create on schema clinical_core,clinical_private from program_media_authority;
revoke all on function clinical_core.program_media_multipart_request(jsonb) from public,clinical_core_api;
grant execute on function clinical_core.program_media_multipart_request(jsonb) to program_media_worker;
revoke all on function clinical_private.program_media_multipart_json(clinical_private.program_media_multipart,clinical_core.program_media_artifacts),
 clinical_private.program_media_multipart_transition(),clinical_private.program_media_multipart_parent_fence() from public,clinical_core_api,program_media_worker;
