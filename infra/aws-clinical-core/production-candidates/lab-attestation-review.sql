-- Unreleased production candidate: the reviewer's bound view of one clinic lab reading and the bound attestation
-- request made from it (lab-attestation-review/1). BLOCKED: applied nowhere, registered in no manifest, and its
-- activation row below is disabled.
--
-- Parent: the 106-migration production artifact plus lab-result-transfer-v2.sql and lab-observation-attestation.sql,
-- both unchanged: this file redefines nothing they define and reads them only through their own functions. It is a
-- separately named successor because the reviewed attestation request binds the reading, the document and the
-- reviewer but not the patient the reviewer had open or the revision of the reading they looked at, and those two
-- cannot be added to a reviewed file without changing its pinned bytes. Order with its siblings:
--   1. lab-result-transfer-v2.sql;  2. lab-observation-attestation.sql;  3. production-program-assignments.sql;
--   4. this file (it does not read program assignments; it is listed after them so the earlier order stays as
--      reviewed).
-- No historical migration, ledger, IAM or custody file changes. Registration, activation evidence and execution are
-- Codex work after review.
--
-- What this adds, and what it does not:
--   * A read (lab_attestation_review) that shows a reviewer the clinic's reading exactly as stored — marker, value as
--     the database holds it, unit, draw time — beside the transfer's recorded document digests, the reading's review
--     state and its verification history. It never returns a laboratory flag (no transfer carries one) and names a
--     /1 reading's stored status only as the app's assessment.
--   * A reading revision: a digest of everything the view showed that an attestation depends on. The request made
--     from the view names it, so an attestation made against a view that has since changed (another reviewer
--     attested, the review state moved, a correction arrived) is refused as stale rather than applied.
--   * Supersession of a reading. A later accepted import of the same source marker over the same connection and
--     provider (a correction the patient app sent, accepted by a practitioner) supersedes the earlier reading. The
--     superseded reading can no longer be attested: verifying a value the source has since corrected would let the
--     old value stand in for the new one.
--   * The patient binding. The reviewer has one patient open; a request naming another patient's reading, or a
--     reading in another clinic, is refused with the same refusal as a reading that does not exist.
--   * Everything else is the reviewed attestation function's: actor, role, document, restated fields, compare-and-set
--     on the current attestation, append-only history. This file calls it; it does not restate it.
--   * Nothing here verifies a range, approves anything clinically, or moves a reading out of needs_human_review by
--     itself.

create table clinical_core.lab_attestation_review_activation(
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  reviewed_by text check(reviewed_by is null or char_length(reviewed_by) between 1 and 200),
  reviewed_at timestamptz,
  check(not enabled or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null))
);
insert into clinical_core.lab_attestation_review_activation(singleton,enabled) values(true,false);
revoke all on clinical_core.lab_attestation_review_activation from public,clinical_core_api;

-- The reviewer: a workforce actor in a production clinical context, active identity, person and clinic, with a
-- clinical role in this clinic now. Read on every call, so withdrawn authority refuses the next request.
create function clinical_private.lab_attestation_reviewer() returns text
language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id(); _role text;
begin
  if not exists(select 1 from clinical_core.lab_attestation_review_activation where singleton and enabled)
    or not exists(select 1 from clinical_core.lab_observation_attestation_activation where singleton and enabled) then
    raise exception using errcode='42501',message='lab_attestation_disabled'; end if;
  if _actor is null or _org is null or clinical_private.claim('identity_pool') is distinct from 'workforce'
    or clinical_private.claim('purpose') is distinct from 'clinical_data'
    or clinical_private.claim('environment') is distinct from 'production-clinical'
    or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
    or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
      where i.person_id=_actor and i.identity_pool='workforce' and i.identity_subject=clinical_private.claim('identity_subject')
        and i.production_bound and i.status='active' and p.status='active')
    or not exists(select 1 from clinical_core.organizations where id=_org and status='active') then
    raise exception using errcode='42501',message='lab_attestation_refused'; end if;
  select m.role into _role from clinical_core.organization_memberships m
    where m.organization_id=_org and m.person_id=_actor and m.status='active' and m.role in('owner','admin','practitioner');
  if _role is null then raise exception using errcode='42501',message='clinical_role_required'; end if;
  return _role;
end $$;
revoke all on function clinical_private.lab_attestation_reviewer() from public;

-- The reading that replaced this one, if any: a later-received, accepted and not rejected reading of the same source
-- marker over the same connection and provider. Ordered by the server's own receipt time, never a sender's clock.
create function clinical_private.lab_observation_successor(_observation uuid) returns uuid
language sql stable security definer set search_path='' as $$
  select n.id from clinical_core.lab_observations o
  join clinical_core.lab_import_events e on e.id=o.import_event_id
  join clinical_core.lab_import_events ne on ne.provider_id=e.provider_id and ne.connection_id=e.connection_id
    and ne.external_panel_id=e.external_panel_id and ne.external_marker_id=e.external_marker_id and ne.id<>e.id
    and (ne.received_at,ne.id)>(e.received_at,e.id)
  join clinical_core.lab_observations n on n.import_event_id=ne.id and n.review_status<>'rejected'
  where o.id=_observation
  order by ne.received_at desc,ne.id desc limit 1
$$;
revoke all on function clinical_private.lab_observation_successor(uuid) from public;

-- The draw time exactly as stored, in the one serialisation the attestation request accepts.
create function clinical_private.lab_attestation_instant(_at timestamptz) returns text
language sql immutable set search_path='' as $$
  select case when extract(microseconds from _at)::bigint % 1000 = 0
    then to_char(_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    else to_char(_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
$$;
revoke all on function clinical_private.lab_attestation_instant(timestamptz) from public;

-- The view of one reading, for a reviewer who has its patient open. The caller has already been authorized.
create function clinical_private.lab_attestation_view(_patient uuid,_observation uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _o clinical_core.lab_observations%rowtype; _e clinical_core.lab_import_events%rowtype;
  _transfer jsonb; _verification jsonb; _successor uuid; _blocked text; _view jsonb;
begin
  select * into _o from clinical_core.lab_observations where id=_observation;
  -- Missing, in another clinic, or another patient's: one refusal, so the answer says nothing about which.
  if not found or _o.organization_id is distinct from clinical_private.organization_id() or _o.patient_record_id<>_patient then
    raise exception using errcode='42501',message='lab_attestation_review_refused'; end if;
  select * into _e from clinical_core.lab_import_events where id=_o.import_event_id;
  _transfer:=clinical_core.lab_import_provenance(_o.import_event_id);
  _verification:=clinical_core.lab_observation_verification(_o.id);
  _successor:=clinical_private.lab_observation_successor(_o.id);
  _blocked:=case when _o.review_status='rejected' then 'reading_rejected'
    when _successor is not null then 'reading_superseded'
    when jsonb_array_length(coalesce(_transfer->'documents','[]'::jsonb))=0 then 'document_unknown'
    when _o.unit is null then 'unit_unknown' end;
  _view:=jsonb_build_object('contract','lab-attestation-review/1','patientRecordId',_o.patient_record_id,'observationId',_o.id,
    'reading',jsonb_build_object('marker',_o.marker_name,'value',to_jsonb(_o.value_numeric),'valueText',_o.value_numeric::text,
      'unit',_o.unit,'observedAt',clinical_private.lab_attestation_instant(_o.observed_at)),
    'reviewStatus',_o.review_status,
    'transfer',jsonb_build_object('contract',_transfer->>'contract','origin',_transfer->>'origin','documents',_transfer->'documents',
      'reportedVerification',_transfer->>'reportedVerification','appAssessment',_transfer->'appAssessment','laboratoryFlag',null),
    'supersededBy',_successor,
    'verification',_verification,
    'attestable',_blocked is null,'blockedBy',_blocked);
  return _view||jsonb_build_object('readingRevision',encode(public.digest(convert_to(jsonb_build_object(
    'contract','lab-attestation-review/1','importEventId',_e.id,'payloadSha256',_e.payload_sha256,
    'view',_view-'verification','current',_verification->'current','state',_verification->'state')::text,'UTF8'),'sha256'),'hex'));
end $$;
revoke all on function clinical_private.lab_attestation_view(uuid,uuid) from public;

create function clinical_core.lab_attestation_review(_request jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.lab_attestation_reviewer();
  if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>1024
    or _request-array['contract','patientRecordId','observationId']<>'{}'::jsonb
    or _request->>'contract' is distinct from 'lab-attestation-review/1'
    or coalesce(_request->>'patientRecordId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(_request->>'observationId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='22023',message='lab_attestation_invalid'; end if;
  return clinical_private.lab_attestation_view((_request->>'patientRecordId')::uuid,(_request->>'observationId')::uuid);
end $$;
revoke all on function clinical_core.lab_attestation_review(jsonb) from public;
grant execute on function clinical_core.lab_attestation_review(jsonb) to clinical_core_api;

-- A reviewer's attestation made from a view: the patient they had open, the revision of the reading they saw, and the
-- reviewed lab-reading-attestation/1 statement. The receipt carries the view as it stands afterwards, so the caller
-- shows what the record now says rather than what it asked for.
create function clinical_core.attest_reviewed_lab_observation(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _patient uuid; _observation uuid; _statement jsonb:=_request->'attestation'; _receipt jsonb; _view jsonb;
  _saved clinical_core.lab_observation_attestations%rowtype;
begin
  perform clinical_private.lab_attestation_reviewer();
  if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>6144
    or _request-array['contract','patientRecordId','readingRevision','attestation']<>'{}'::jsonb
    or _request->>'contract' is distinct from 'lab-attestation-review/1'
    or coalesce(_request->>'patientRecordId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(_request->>'readingRevision','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(_statement)<>'object'
    or coalesce(_statement->>'observationId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(_statement->>'requestId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='22023',message='lab_attestation_invalid'; end if;
  _patient:=(_request->>'patientRecordId')::uuid; _observation:=(_statement->>'observationId')::uuid;
  -- One reviewer at a time per reading: the second waits here, then sees the first one's result in the revision.
  perform 1 from clinical_core.lab_observations where id=_observation for update;
  -- A retried request is answered from its own record, by the reviewed function, without a revision check: the
  -- revision has moved because of this very request. A different binding under the same request id is its conflict.
  select * into _saved from clinical_core.lab_observation_attestations
    where organization_id=clinical_private.organization_id() and request_id=(_statement->>'requestId')::uuid;
  if found then
    if _saved.patient_record_id<>_patient then raise exception using errcode='42501',message='lab_attestation_review_refused'; end if;
  else
    _view:=clinical_private.lab_attestation_view(_patient,_observation);
    if _view->>'blockedBy'='reading_superseded' then
      raise exception using errcode='40001',message='lab_attestation_reading_superseded'; end if;
    if _view->>'readingRevision' is distinct from _request->>'readingRevision' then
      raise exception using errcode='40001',message='lab_attestation_stale'; end if;
  end if;
  _receipt:=clinical_core.attest_lab_observation(_statement);
  return _receipt||jsonb_build_object('patientRecordId',_patient,'view',clinical_private.lab_attestation_view(_patient,_observation));
end $$;
revoke all on function clinical_core.attest_reviewed_lab_observation(jsonb) from public;
grant execute on function clinical_core.attest_reviewed_lab_observation(jsonb) to clinical_core_api;
