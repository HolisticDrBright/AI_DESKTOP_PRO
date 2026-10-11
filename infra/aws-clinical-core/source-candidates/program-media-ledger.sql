-- BLOCKED source candidate: the ledger for governed lesson-media artifacts
-- (program-media/1), for Codex's review. Not a schema successor. Not registered
-- in migrations/manifest.json; not applied anywhere; not to be applied until the
-- dedicated-media design in docs/program-media-authoring-2026-10-11.md is reviewed
-- and a dedicated store exists. The runtime that would write here
-- (src/server/programs/program-media-authoring.ts) is disabled in source and the
-- only ledger implementation in the repository is fictional.
--
-- Parent assumptions (written against exactly these artifacts; the test refuses
-- to run it if either digest has moved):
--   20260812010000_synthetic_identity_consent.sql
--     sha256 c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445
--     (clinical_core.organizations, clinical_core.persons, clinical_core_api,
--      clinical_private.block_update_delete)
--   20260903200000_synthetic_desktop_programs_inbox.sql
--     sha256 6ba42349af12e2deb2aa163fbca59ea168bababe4017a098ec88314f31a8b26f
--     (clinical_core.synthetic_desktop_programs (id, organization_id))
-- No historical migration, ledger, binary, privilege, IAM or custody file is
-- changed by this file. No policy is decided here: the activation row below is
-- disabled, carries no bucket and no public origin, and only a separately
-- reviewed change may enable it.
--
-- What the ledger holds and refuses:
--   * one row per artifact, in one clinic, for one program, created by one
--     command: a repeated command finds its row instead of making a second one;
--   * the object key is a function of clinic, program, artifact and bytes, so a
--     key can never name another clinic's or another program's object;
--   * ready and retired require a proven object version and a commit time; held,
--     error and abandoned never carry one; retired carries its time;
--   * identity columns are immutable; every change raises the version; the only
--     transitions are reserved -> ready | held | error | abandoned,
--     error -> ready | held | abandoned, ready -> retired; held, abandoned and
--     retired are terminal, and a retired artifact's text cannot change;
--   * one committed artifact per (clinic, program, sha256);
--   * a caption or transcript records its supplied source; there is no
--     generated source; a transcript belongs to a video only;
--   * a publication names a ready artifact at its current version, its bytes and
--     an https address that is not a bucket address, and is append-only; a
--     retired artifact can be newly published by nobody, while its earlier
--     publications remain exactly what they were;
--   * the API role can read nothing and write nothing here until a reviewed
--     function family grants it; the educational purpose means no patient
--     identity column exists to be joined.

create table clinical_core.program_media_activation(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
 reviewed_by text check(reviewed_by is null or char_length(btrim(reviewed_by)) between 1 and 200),
 reviewed_at timestamptz,
 storage_bucket text check(storage_bucket is null or (storage_bucket ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' and storage_bucket !~ '(recording|voice|encounter|transcript|phi|patient)')),
 public_origin text check(public_origin is null or (public_origin ~ '^https://[a-z0-9.-]+/$' and public_origin !~ 'amazonaws\.com/$')),
 updated_at timestamptz not null default clock_timestamp(),
 check(not enabled or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null and storage_bucket is not null and public_origin is not null))
);
insert into clinical_core.program_media_activation(singleton,enabled) values(true,false);
alter table clinical_core.program_media_activation enable row level security;
alter table clinical_core.program_media_activation force row level security;
revoke all on clinical_core.program_media_activation from public,clinical_core_api;
create trigger program_media_activation_append_only before delete on clinical_core.program_media_activation
 for each row execute function clinical_private.block_update_delete();

create function clinical_private.program_media_extension(_content_type text) returns text
language sql immutable strict set search_path='' as $$
 select case _content_type when 'video/mp4' then 'mp4' when 'video/webm' then 'webm'
  when 'image/png' then 'png' when 'image/jpeg' then 'jpg' when 'image/webp' then 'webp' end
$$;
revoke all on function clinical_private.program_media_extension(text) from public;

create table clinical_core.program_media_artifacts(
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 program_id uuid not null,
 command_id uuid not null,
 created_by uuid not null references clinical_core.persons(id),
 kind text not null check(kind in('video','image')),
 content_type text not null check(content_type in('video/mp4','video/webm','image/png','image/jpeg','image/webp')),
 bytes bigint not null check(bytes>0 and bytes<=268435456),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 object_key text not null,
 state text not null default 'reserved' check(state in('reserved','ready','held','error','abandoned','retired')),
 version bigint not null default 1 check(version>0),
 object_version text check(object_version is null or (char_length(object_version) between 1 and 1024 and object_version<>'null')),
 committed_at timestamptz,
 retired_at timestamptz,
 failure text check(failure is null or char_length(failure) between 1 and 80),
 caption_text text check(caption_text is null or char_length(caption_text) between 1 and 200000),
 caption_source text check(caption_source in('supplied_by_author','supplied_vendor_file')),
 caption_format text check(caption_format in('plain','vtt')),
 caption_sha256 text check(caption_sha256 is null or caption_sha256 ~ '^[a-f0-9]{64}$'),
 transcript_text text check(transcript_text is null or char_length(transcript_text) between 1 and 200000),
 transcript_source text check(transcript_source in('supplied_by_author','supplied_vendor_file')),
 transcript_format text check(transcript_format in('plain','vtt')),
 transcript_sha256 text check(transcript_sha256 is null or transcript_sha256 ~ '^[a-f0-9]{64}$'),
 accept_before timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 foreign key (program_id, organization_id) references clinical_core.synthetic_desktop_programs(id, organization_id),
 unique(organization_id, program_id, command_id),
 check((kind='video') = (content_type like 'video/%')),
 check(bytes<=case when kind='image' then 16777216 else 268435456 end),
 check(object_key = 'program-media/'||organization_id::text||'/'||program_id::text||'/'||id::text||'/'||sha256||'.'||clinical_private.program_media_extension(content_type)),
 check((state in('ready','retired')) = (object_version is not null and committed_at is not null)),
 check((state='retired') = (retired_at is not null)),
 check(state in('ready','retired') or (caption_text is null and transcript_text is null)),
 check((caption_text is null) = (caption_source is null) and (caption_text is null) = (caption_format is null) and (caption_text is null) = (caption_sha256 is null)),
 check((transcript_text is null) = (transcript_source is null) and (transcript_text is null) = (transcript_format is null) and (transcript_text is null) = (transcript_sha256 is null)),
 check(kind='video' or (transcript_text is null and (caption_format is null or caption_format='plain'))),
 check(accept_before>created_at)
);
create unique index program_media_artifacts_committed_bytes on clinical_core.program_media_artifacts(organization_id,program_id,sha256)
 where state in('ready','retired');
create index program_media_artifacts_program on clinical_core.program_media_artifacts(organization_id,program_id,state,accept_before);

create function clinical_private.program_media_artifact_transition() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
 or new.program_id is distinct from old.program_id or new.command_id is distinct from old.command_id
 or new.created_by is distinct from old.created_by or new.kind is distinct from old.kind
 or new.content_type is distinct from old.content_type or new.bytes is distinct from old.bytes
 or new.sha256 is distinct from old.sha256 or new.object_key is distinct from old.object_key
 or new.accept_before is distinct from old.accept_before or new.created_at is distinct from old.created_at then
  raise exception using errcode='42501',message='program_media_identity_immutable'; end if;
 if new.version<=old.version then raise exception using errcode='42501',message='program_media_version_must_increase'; end if;
 if old.state in('held','abandoned','retired') then raise exception using errcode='42501',message='program_media_terminal'; end if;
 if new.state is distinct from old.state and not (
  (old.state='reserved' and new.state in('ready','held','error','abandoned'))
  or (old.state='error' and new.state in('ready','held','abandoned'))
  or (old.state='ready' and new.state='retired')) then
  raise exception using errcode='42501',message='program_media_transition_refused'; end if;
 if old.object_version is not null and (new.object_version is distinct from old.object_version or new.committed_at is distinct from old.committed_at) then
  raise exception using errcode='42501',message='program_media_commit_immutable'; end if;
 if new.state='retired' and (new.caption_text is distinct from old.caption_text or new.transcript_text is distinct from old.transcript_text) then
  raise exception using errcode='42501',message='program_media_retired_text_immutable'; end if;
 new.updated_at:=clock_timestamp();
 return new;
end $$;
revoke all on function clinical_private.program_media_artifact_transition() from public;
create trigger program_media_artifact_transition before update on clinical_core.program_media_artifacts
 for each row execute function clinical_private.program_media_artifact_transition();
create trigger program_media_artifacts_no_delete before delete on clinical_core.program_media_artifacts
 for each row execute function clinical_private.block_update_delete();

create table clinical_core.program_media_events(
 id uuid primary key default public.gen_random_uuid(),
 artifact_id uuid not null references clinical_core.program_media_artifacts(id),
 organization_id uuid not null references clinical_core.organizations(id),
 actor_id uuid not null references clinical_core.persons(id),
 event text not null check(event in('reserved','committed','held','error','abandoned','orphan_removed','caption','transcript','published','retired','reconciled')),
 detail text check(detail is null or char_length(detail) between 1 and 200),
 occurred_at timestamptz not null default clock_timestamp()
);
create index program_media_events_artifact on clinical_core.program_media_events(artifact_id,occurred_at);
create trigger program_media_events_append_only before update or delete on clinical_core.program_media_events
 for each row execute function clinical_private.block_update_delete();

create table clinical_core.program_media_publications(
 id uuid primary key default public.gen_random_uuid(),
 artifact_id uuid not null references clinical_core.program_media_artifacts(id),
 organization_id uuid not null references clinical_core.organizations(id),
 version bigint not null check(version>0),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 url text not null check(url ~ '^https://[a-z0-9.-]+/program-media/' and url !~ 'amazonaws\.com'),
 published_by uuid not null references clinical_core.persons(id),
 published_at timestamptz not null default clock_timestamp()
);
create function clinical_private.program_media_publication_admit() returns trigger
language plpgsql security definer set search_path='' as $$
declare a clinical_core.program_media_artifacts%rowtype; o text;
begin
 select * into a from clinical_core.program_media_artifacts where id=new.artifact_id;
 if a.id is null or a.organization_id<>new.organization_id then
  raise exception using errcode='42501',message='program_media_publication_refused'; end if;
 if a.state<>'ready' then raise exception using errcode='42501',message='program_media_not_ready'; end if;
 if a.version<>new.version or a.sha256<>new.sha256 then raise exception using errcode='42501',message='program_media_version_stale'; end if;
 select public_origin into o from clinical_core.program_media_activation where singleton;
 -- Before activation names a public origin there is no address a publication could truthfully carry.
 if o is null or new.url is distinct from o||a.object_key then
  raise exception using errcode='42501',message='program_media_url_mismatch'; end if;
 return new;
end $$;
revoke all on function clinical_private.program_media_publication_admit() from public;
create trigger program_media_publication_admit before insert on clinical_core.program_media_publications
 for each row execute function clinical_private.program_media_publication_admit();
create trigger program_media_publications_append_only before update or delete on clinical_core.program_media_publications
 for each row execute function clinical_private.block_update_delete();

alter table clinical_core.program_media_artifacts enable row level security;
alter table clinical_core.program_media_events enable row level security;
alter table clinical_core.program_media_publications enable row level security;
alter table clinical_core.program_media_artifacts force row level security;
alter table clinical_core.program_media_events force row level security;
alter table clinical_core.program_media_publications force row level security;
revoke all on clinical_core.program_media_artifacts,clinical_core.program_media_events,clinical_core.program_media_publications from public,clinical_core_api;
