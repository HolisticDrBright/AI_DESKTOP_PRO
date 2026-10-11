-- BLOCKED source candidate, successor to program-media-ledger.sql: the durable
-- writer/cleanup fence, absence proof and whole-publication recording that
-- Codex's independent recheck of e3f39a6 required. For review. Not a schema
-- successor of anything registered. Not registered in migrations/manifest.json;
-- not applied anywhere; not to be applied until the design in
-- docs/program-media-authoring-2026-10-11.md (recheck section) is reviewed and a
-- dedicated store exists. The runtime that would write here
-- (src/server/programs/program-media-authoring.ts) is disabled in source and the
-- only ledger implementation in the repository is fictional.
--
-- Parent assumptions (written against exactly these artifacts; the test refuses
-- to run it if any digest has moved). The prior candidate's identity is preserved:
-- this file amends nothing in it and must be applied after it.
--   source-candidates/program-media-ledger.sql
--     sha256 6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d
--   20260812010000_synthetic_identity_consent.sql
--     sha256 c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445
--   20260903200000_synthetic_desktop_programs_inbox.sql
--     sha256 6ba42349af12e2deb2aa163fbca59ea168bababe4017a098ec88314f31a8b26f
-- No historical migration, ledger, binary, privilege, IAM or custody file is
-- changed by this file. The activation row stays disabled. The API role is still
-- granted nothing.
--
-- What changes and why (one defect each):
--   * Lease. A reservation may be `writing` (a writer holds it) or `cleaning`
--     (cleanup holds it); exactly one holder, one token, one expiry. A lease is
--     taken over only after it expired. A commit is admitted only from `writing`,
--     and only the function family that checks the caller's token may perform it:
--     this trigger enforces the transition, the token check is the successor
--     function family's. No SQL lock spans a store call; the lease row is the
--     fence between parties, so cleanup cannot delete what a writer is proving and
--     a writer cannot commit what cleanup is removing.
--   * Absence proof. `abandoned` requires `absence_proven_at` (the exact key read
--     back empty after the delete) unless `unresolved_storage` says bytes may
--     remain. A delete call is never proof; a receipt that says removed names the
--     proof.
--   * Unresolved storage. A writer whose lease was lost after its bytes landed,
--     and a cleanup whose delete could not be proven, set `unresolved_storage`;
--     nothing clears it except a commit or an absence proof under a lease. The
--     cleanup listing (successor function family) must include every row that is
--     not committed, not held and not proven absent, abandoned rows included.
--   * Whole publication. A publication row carries the recorded reference body
--     (`reference` jsonb) and its identity; the body must agree with the row and
--     the artifact in clinic, program, bytes, version and address. A reference is
--     looked up by identity and compared whole; nothing outside the row is a
--     publication.

alter table clinical_core.program_media_artifacts
 add column lease_holder text check(lease_holder in('writer','cleanup')),
 add column lease_token text check(lease_token is null or char_length(lease_token) between 16 and 128),
 add column lease_until timestamptz,
 add column absence_proven_at timestamptz,
 add column unresolved_storage boolean not null default false;
alter table clinical_core.program_media_artifacts drop constraint program_media_artifacts_state_check;
alter table clinical_core.program_media_artifacts
 add constraint program_media_artifacts_state_check check(state in('reserved','writing','cleaning','ready','held','error','abandoned','retired')),
 add constraint program_media_artifacts_lease_whole check((lease_holder is null)=(lease_token is null) and (lease_holder is null)=(lease_until is null)),
 add constraint program_media_artifacts_lease_state check((state='writing')=(lease_holder is not distinct from 'writer') and (state='cleaning')=(lease_holder is not distinct from 'cleanup')),
 add constraint program_media_artifacts_committed_unleased check(state not in('ready','retired','held') or lease_holder is null),
 add constraint program_media_artifacts_abandoned_proof check(state<>'abandoned' or absence_proven_at is not null or unresolved_storage),
 add constraint program_media_artifacts_proof_unleased check(absence_proven_at is null or lease_holder is null);

create or replace function clinical_private.program_media_artifact_transition() returns trigger
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
 if old.state in('held','retired') then raise exception using errcode='42501',message='program_media_terminal'; end if;
 if old.state='abandoned' and not old.unresolved_storage then raise exception using errcode='42501',message='program_media_terminal'; end if;
 -- A live lease belongs to its holder: another lease may replace it only after it expired. Releasing a
 -- lease (new lease null) is admitted here; that the releasing caller presented the holder's token is
 -- the successor function family's check, since a row trigger cannot see the caller.
 if old.lease_holder is not null and old.lease_until>clock_timestamp()
 and new.lease_holder is not null and new.lease_token is distinct from old.lease_token then
  raise exception using errcode='42501',message='program_media_lease_held'; end if;
 if new.state is distinct from old.state and not (
  (old.state in('reserved','error') and new.state in('writing','cleaning'))
  or (old.state='abandoned' and old.unresolved_storage and new.state in('writing','cleaning'))
  or (old.state in('writing','cleaning') and new.state in('writing','cleaning') and old.lease_until<=clock_timestamp())
  or (old.state='writing' and new.state in('ready','reserved','error','abandoned','held'))
  or (old.state='cleaning' and new.state in('reserved','error','abandoned','held'))
  or (old.state='ready' and new.state='retired')) then
  raise exception using errcode='42501',message='program_media_transition_refused'; end if;
 if new.state='ready' and old.state<>'ready' and old.state<>'writing' then
  raise exception using errcode='42501',message='program_media_commit_requires_writer_lease'; end if;
 if old.object_version is not null and (new.object_version is distinct from old.object_version or new.committed_at is distinct from old.committed_at) then
  raise exception using errcode='42501',message='program_media_commit_immutable'; end if;
 if new.state='retired' and (new.caption_text is distinct from old.caption_text or new.transcript_text is distinct from old.transcript_text) then
  raise exception using errcode='42501',message='program_media_retired_text_immutable'; end if;
 -- Unresolved storage is cleared only by a commit or an absence proof made under a lease.
 if old.unresolved_storage and not new.unresolved_storage
 and not (new.state='ready' or (new.state='abandoned' and new.absence_proven_at is not null)) then
  raise exception using errcode='42501',message='program_media_unresolved_storage_sticky'; end if;
 if new.absence_proven_at is distinct from old.absence_proven_at and old.lease_holder is null then
  raise exception using errcode='42501',message='program_media_proof_requires_lease'; end if;
 new.updated_at:=clock_timestamp();
 return new;
end $$;

alter table clinical_core.program_media_publications
 add column reference jsonb not null,
 add column origin_program_id uuid not null,
 add constraint program_media_publications_reference_identity check(
  reference->>'contractVersion'='program-media-reference/1'
  and reference->>'publicationId'=id::text and reference->>'artifactId'=artifact_id::text
  and (reference->>'version')::bigint=version and reference->>'sha256'=sha256 and reference->>'url'=url
  and reference->'origin'->>'clinic'=organization_id::text and reference->'origin'->>'programId'=origin_program_id::text
  and reference ? 'kind' and reference ? 'contentType' and reference ? 'bytes' and reference ? 'publishedAt'
  and reference ? 'caption' and reference ? 'transcript');

create or replace function clinical_private.program_media_publication_admit() returns trigger
language plpgsql security definer set search_path='' as $$
declare a clinical_core.program_media_artifacts%rowtype; o text;
begin
 select * into a from clinical_core.program_media_artifacts where id=new.artifact_id;
 if a.id is null or a.organization_id<>new.organization_id or a.program_id<>new.origin_program_id then
  raise exception using errcode='42501',message='program_media_publication_refused'; end if;
 if a.state<>'ready' then raise exception using errcode='42501',message='program_media_not_ready'; end if;
 if a.version<>new.version or a.sha256<>new.sha256 then raise exception using errcode='42501',message='program_media_version_stale'; end if;
 select public_origin into o from clinical_core.program_media_activation where singleton;
 -- Before activation names a public origin there is no address a publication could truthfully carry.
 if o is null or new.url is distinct from o||a.object_key then
  raise exception using errcode='42501',message='program_media_url_mismatch'; end if;
 -- The recorded body must say exactly what the artifact is: bytes, kind, type and supplied text provenance.
 if new.reference->>'kind' is distinct from a.kind or new.reference->>'contentType' is distinct from a.content_type
 or (new.reference->>'bytes')::bigint is distinct from a.bytes
 or (new.reference->'caption'->>'sha256') is distinct from a.caption_sha256 or (new.reference->'caption'->>'source') is distinct from a.caption_source
 or (new.reference->'transcript'->>'sha256') is distinct from a.transcript_sha256 or (new.reference->'transcript'->>'source') is distinct from a.transcript_source then
  raise exception using errcode='42501',message='program_media_reference_body_mismatch'; end if;
 return new;
end $$;
