-- Unreleased production candidate: the consumer boundary of the production program family
-- (program-consumer-boundary/1). BLOCKED: applied nowhere, registered in no manifest, and its activation row
-- below is disabled.
--
-- Parent: the 106-migration production artifact plus, unchanged and in their documented order,
-- lab-result-transfer-v2.sql, lab-observation-attestation.sql and production-program-assignments.sql. This file
-- reads the last one's private functions and calls its request function; it redefines nothing any of them
-- defines. It is independent of lab-attestation-review.sql and program-step-purchase.sql. No historical
-- migration, ledger, IAM or custody file changes. Registration, activation evidence and execution are Codex
-- work after review. Rollback: production-program-consumer-boundary-rollback.sql.
--
-- Why it exists.
--   1. The parent's request function returns the stored phases verbatim. `read` (the consumer's view) and
--      `preview` (the workforce's preview of what a consumer would see) both carry every supplement product's
--      authored purchaseUrl. Only the TypeScript adapter blanked it, and only for `read`. While ordering is
--      withheld, a purchase destination must not leave the database through the API role at all.
--   2. The parent's `complete` checks the assignment revision and that the item is in the current review's
--      `add` list, but not the plan revision the person was shown. A completion made against an older review
--      (a new or superseded lab result, a changed plan, a consent change) was applied whenever the item was
--      still listed.
--
-- What it does.
--   * clinical_core.production_program_bounded_request(jsonb) becomes the API role's only program entry point:
--     EXECUTE on the parent's request function is revoked from clinical_core_api, so the unredacted
--     projection cannot be reached by calling it directly. Every action except `complete` is answered by the
--     parent function, unchanged, and the answer is then redacted: every `purchaseUrl` value at any depth is
--     null. Refusals are the parent's own fixed tokens and carry no content.
--   * `complete` is decided here, in one transaction, against ONE review: the same authority checks as the
--     parent in the same order, then the revision the person saw (sourceDigest, expectedRevision AND
--     planRevision, which is now mandatory), and only then the item check and the writes (the completion, the
--     revision and the audit row). A stale plan revision refuses with program_review_stale before anything is
--     written, even when the item is still in `add`. A replayed completion is not turned into a second write:
--     it names a revision that no longer holds and is refused as stale, and the caller reads the current state.
--
-- What it does not do. It does not change or remove a stored destination: program_versions.content and
-- program_assignments.content keep exactly what the practitioner authored (the parent's immutability trigger
-- forbids changing assignment content anyway), and the practitioner authoring surface (invoke_program_operation,
-- knowledge editors only, from the 106-migration artifact) is not this family and is unchanged. It does not
-- scrub free text: an address typed into a title or an instruction is the practitioner's text, not a purchase
-- binding, and is left for review (see the return document). It releases no hold and decides no clinical question.

create table clinical_core.program_consumer_boundary_activation(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
 reviewed_by text check(reviewed_by is null or char_length(btrim(reviewed_by)) between 1 and 200),
 reviewed_at timestamptz,
 updated_at timestamptz not null default clock_timestamp(),
 check(not enabled or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null))
);
insert into clinical_core.program_consumer_boundary_activation(singleton,enabled) values(true,false);
alter table clinical_core.program_consumer_boundary_activation enable row level security;
alter table clinical_core.program_consumer_boundary_activation force row level security;
revoke all on clinical_core.program_consumer_boundary_activation from public,clinical_core_api;
create trigger program_consumer_boundary_activation_append_only before delete on clinical_core.program_consumer_boundary_activation
 for each row execute function clinical_private.block_update_delete();

-- Every `purchaseUrl` value in an answer, at any depth, becomes null; nothing else changes. Key-based on purpose:
-- the parent's content contract admits a destination only as product.purchaseUrl, and a later projection that
-- carries one under the same key is covered without another release.
create function clinical_private.production_program_without_destinations(_value jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
begin
 if _value is null then return null; end if;
 if jsonb_typeof(_value)='object' then
  return coalesce((select jsonb_object_agg(e.key,case when e.key='purchaseUrl' then 'null'::jsonb
    else clinical_private.production_program_without_destinations(e.value) end) from jsonb_each(_value) e),'{}'::jsonb);
 end if;
 if jsonb_typeof(_value)='array' then
  return coalesce((select jsonb_agg(clinical_private.production_program_without_destinations(e.value) order by e.ordinality)
    from jsonb_array_elements(_value) with ordinality e),'[]'::jsonb);
 end if;
 return _value;
end $$;
revoke all on function clinical_private.production_program_without_destinations(jsonb) from public;

-- `complete`, bound to the review the person was shown. The authority checks repeat the parent's, in its order,
-- so a refusal names the same reason it would have; the plan revision is compared against the review computed
-- here, which is the review the item check and the writes then use.
create function clinical_private.production_program_bounded_complete(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool');
 _connection clinical_core.patient_connections%rowtype; _row clinical_core.program_assignments%rowtype;
 _review jsonb; _phase jsonb; _expected bigint; _now timestamptz:=clock_timestamp();
begin
 if not exists(select 1 from clinical_core.production_program_activation where singleton and enabled) then
  raise exception using errcode='42501',message='production_program_disabled'; end if;
 if _actor is null or _org is null or _pool is null or _pool not in('consumer','workforce')
 or clinical_private.claim('purpose') is distinct from 'clinical_data'
 or clinical_private.claim('environment') is distinct from 'production-clinical'
 or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool and i.identity_subject=clinical_private.claim('identity_subject')
  and i.production_bound and i.status='active' and p.status='active')
 or not exists(select 1 from clinical_core.organizations where id=_org and status='active')
 or (_pool='workforce' and not clinical_private.has_clinical_role(_org)) then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 -- The plan revision is part of the request, not an optional extra: a completion without one is not a completion.
 if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>262144
 or _request-array['action','enrollmentId','sourceDigest','expectedRevision','planRevision','itemId']<>'{}'::jsonb
 or not (_request ?& array['action','enrollmentId','sourceDigest','expectedRevision','planRevision','itemId'])
 or jsonb_typeof(_request->'planRevision')<>'string' or char_length(btrim(_request->>'planRevision')) not between 1 and 200
 or jsonb_typeof(_request->'itemId')<>'string' or (_request->>'itemId') !~ '^[A-Za-z0-9_.:-]{1,160}$'
 or jsonb_typeof(_request->'expectedRevision')<>'string' or (_request->>'expectedRevision') !~ '^[1-9][0-9]{0,18}$'
 or jsonb_typeof(_request->'enrollmentId')<>'string'
 or (_request->>'enrollmentId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 if _pool<>'consumer' then raise exception using errcode='42501',message='program_assignment_refused'; end if;
 if clinical_private.owned_consumer_consent(_actor,'protocols_supplements') is null then
  raise exception using errcode='42501',message='consumer_storage_consent_required'; end if;
 select * into _row from clinical_core.program_assignments where id=(_request->>'enrollmentId')::uuid for update;
 if _row.id is null or _row.organization_id<>_org then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 select * into _connection from clinical_core.patient_connections where id=_row.connection_id;
 if _connection.id is null or _connection.organization_id<>_org or _connection.state<>'verified'
 or _connection.consumer_person_id is distinct from _actor
 or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and organization_id=_org and status='active') then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 _review:=clinical_private.production_program_review(_row.content,clinical_private.production_program_plan_inventory(_actor),
  clinical_private.production_program_lab_readings(_actor,_org,_connection.patient_record_id));
 if _request->>'sourceDigest' is distinct from _row.source_digest then
  raise exception using errcode='40001',message='program_assignment_version_changed'; end if;
 _expected:=(_request->>'expectedRevision')::bigint;
 if _expected<>_row.revision then raise exception using errcode='40001',message='program_assignment_revision_stale'; end if;
 -- The review the person was shown is the one they act on. A new or corrected result, a changed plan or a consent
 -- change moves the plan revision, and the step is refused here even if it is still listed as available.
 if _request->>'planRevision' is distinct from (_review->>'planRevision') then
  raise exception using errcode='40001',message='program_review_stale'; end if;
 if _row.state<>'active' or _row.finished then
  raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;
 _phase:=_row.content->_row.phase_index;
 if _phase is null then raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;
 if not exists(select 1 from jsonb_array_elements(_phase->'items') i where i.value->>'id'=_request->>'itemId')
 or not exists(select 1 from jsonb_array_elements_text(_review->'add') a where a.value=_request->>'itemId') then
  raise exception using errcode='42501',message='program_item_held'; end if;
 insert into clinical_core.program_assignment_completions(assignment_id,item_id)
 values(_row.id,_request->>'itemId') on conflict do nothing;
 update clinical_core.program_assignments set revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
 insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'complete');
 return jsonb_build_object('action','complete','enrollmentId',_row.id,'revision',_row.revision::text,'itemId',_request->>'itemId');
end $$;
revoke all on function clinical_private.production_program_bounded_complete(jsonb) from public;

create function clinical_core.production_program_bounded_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from clinical_core.program_consumer_boundary_activation where singleton and enabled) then
  raise exception using errcode='42501',message='program_boundary_disabled'; end if;
 if _request is not null and jsonb_typeof(_request)='object' and _request->>'action'='complete' then
  return clinical_private.production_program_bounded_complete(_request);
 end if;
 return clinical_private.production_program_without_destinations(clinical_core.production_program_assignment_request(_request));
end $$;
revoke all on function clinical_core.production_program_bounded_request(jsonb) from public;
grant execute on function clinical_core.production_program_bounded_request(jsonb) to clinical_core_api;
-- The parent's request function stays callable by its owner (and so by the entry point above), never by the API role.
revoke execute on function clinical_core.production_program_assignment_request(jsonb) from clinical_core_api;
