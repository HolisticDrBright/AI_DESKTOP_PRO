-- Unreleased production candidate: a reviewer-attested transition of one clinic lab reading out of
-- needs_human_review. BLOCKED: applied nowhere, registered in no manifest, and its activation row below is disabled.
--
-- Parent: the 106-migration production artifact plus lab-result-transfer-v2.sql (this file reads the document
-- digests that candidate records). Order: lab-result-transfer-v2.sql, this file, production-program-assignments.sql.
-- No historical migration, ledger, IAM or custody file changes. Registration, activation evidence and execution
-- are Codex work after review.
--
-- What an attestation is, and is not:
--   * It is one reviewer's signed-in statement (lab-reading-attestation/1) that the MEASURED VALUE of one clinic
--     reading matches the laboratory report they compared it against: the exact marker, value, unit and draw time,
--     restated by the reviewer and compared by the server to the stored reading, and the SHA-256 of the document
--     they compared it against, which must be one the transfer recorded the reading was read from.
--   * It is not practitioner approval. Accepting an import (review_lab_import) and reviewing a reading
--     (lab_observation.review_status) stay what they were; neither verifies a value, and an attestation approves
--     nothing clinically.
--   * It never verifies a reference range. Ranges in the app came from recalled or analyzer-extracted sources; the
--     scope is 'measured_value' only and nothing here can mark a range verified.
--   * There is no client-provided "verified" boolean and no signature field. The reviewer is the authenticated
--     actor, with the role their membership holds now; the outcome is a closed vocabulary; nothing in the request
--     is trusted that the server can read for itself.
--   * A reading with no recorded document (every lab-result/1 import, and owner-entered or personally imported /2
--     readings) cannot be attested here: there is nothing to bind the statement to. That is a refusal, not a gap
--     to work around.
--   * Attestations are append-only. A later one supersedes the current one only by naming it (compare-and-set); a
--     stale view is refused. A refuted attestation supersedes a verified one and the reading is no longer verified.
--   * The attestation row is the audit record: actor, role, time, statement, request identity and binding. This
--     file deliberately does not restate clinical_audit.events' action list (two other candidates already restate
--     it, and a third restatement would silently drop whichever was applied first).

create table clinical_core.lab_observation_attestation_activation(
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  reviewed_by text check(reviewed_by is null or char_length(reviewed_by) between 1 and 200),
  reviewed_at timestamptz,
  check(not enabled or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null))
);
insert into clinical_core.lab_observation_attestation_activation(singleton,enabled) values(true,false);
revoke all on clinical_core.lab_observation_attestation_activation from public,clinical_core_api;

-- The measured fields of a clinic reading cannot change once recorded: the attestation binds to them.
create function clinical_private.lab_observation_measurement_immutable() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.organization_id<>old.organization_id or new.patient_record_id<>old.patient_record_id
    or new.import_event_id<>old.import_event_id or new.panel_name<>old.panel_name or new.marker_name<>old.marker_name
    or new.value_numeric<>old.value_numeric or new.unit is distinct from old.unit
    or new.reference_min is distinct from old.reference_min or new.reference_max is distinct from old.reference_max
    or new.observed_at<>old.observed_at or new.provenance<>old.provenance then
    raise exception using errcode='55000',message='lab_observation_measurement_immutable';
  end if;
  return new;
end $$;
create trigger lab_observations_measurement_immutable before update on clinical_core.lab_observations
  for each row execute function clinical_private.lab_observation_measurement_immutable();

create table clinical_core.lab_observation_attestations(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  observation_id uuid not null references clinical_core.lab_observations(id),
  import_event_id uuid not null references clinical_core.lab_import_events(id),
  statement_version text not null check(statement_version='lab-reading-attestation/1'),
  scope text not null check(scope='measured_value'),
  outcome text not null check(outcome in('verified','refuted')),
  marker_name text not null check(char_length(marker_name) between 1 and 200),
  value_numeric numeric not null,
  unit text not null check(char_length(unit) between 1 and 80),
  observed_at timestamptz not null,
  document_sha256 text not null check(document_sha256 ~ '^[0-9a-f]{64}$'),
  reviewer_person_id uuid not null references clinical_core.persons(id),
  reviewer_role text not null check(reviewer_role in('owner','admin','practitioner')),
  supersedes_id uuid unique references clinical_core.lab_observation_attestations(id),
  request_id uuid not null,
  attested_at timestamptz not null default clock_timestamp(),
  unique(organization_id,request_id),
  check(supersedes_id is distinct from id)
);
-- One root per reading, and each later attestation supersedes exactly one: a single, linear history.
create unique index lab_observation_attestations_root on clinical_core.lab_observation_attestations(observation_id)
  where supersedes_id is null;
create index lab_observation_attestations_observation on clinical_core.lab_observation_attestations(observation_id,attested_at desc);
create trigger lab_observation_attestations_append_only before update or delete on clinical_core.lab_observation_attestations
  for each row execute function clinical_private.block_update_delete();
alter table clinical_core.lab_observation_attestations enable row level security;
alter table clinical_core.lab_observation_attestations force row level security;
revoke all on clinical_core.lab_observation_attestations from public,clinical_core_api;

-- The current attestation of a reading: the one nothing supersedes. Null when there is none.
create function clinical_private.current_lab_observation_attestation(_observation uuid)
returns clinical_core.lab_observation_attestations
language sql stable security definer set search_path='' as $$
  select a.* from clinical_core.lab_observation_attestations a
  where a.observation_id=_observation
    and not exists(select 1 from clinical_core.lab_observation_attestations b where b.supersedes_id=a.id)
  order by a.attested_at desc,a.id limit 1
$$;
revoke all on function clinical_private.current_lab_observation_attestation(uuid) from public;

-- Whether a reading is verified NOW: its current attestation says verified, binds the reading exactly as it is
-- stored, names a document its transfer recorded, and the reading has not been rejected. Anything else is false.
create function clinical_private.lab_observation_verified(_observation uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare _o clinical_core.lab_observations%rowtype; _e clinical_core.lab_import_events%rowtype;
  _a clinical_core.lab_observation_attestations%rowtype;
begin
  select * into _o from clinical_core.lab_observations where id=_observation;
  if not found or _o.review_status='rejected' then return false; end if;
  select * into _e from clinical_core.lab_import_events where id=_o.import_event_id;
  if not found or _e.transfer_provenance is null then return false; end if;
  _a:=clinical_private.current_lab_observation_attestation(_observation);
  return _a.id is not null and _a.outcome='verified' and _a.organization_id=_o.organization_id
    and _a.patient_record_id=_o.patient_record_id and _a.import_event_id=_o.import_event_id
    and _a.marker_name=_o.marker_name and _a.value_numeric=_o.value_numeric and _a.unit=_o.unit
    and _a.observed_at=_o.observed_at
    and exists(select 1 from jsonb_array_elements_text(_e.transfer_provenance->'documents') d where d.value=_a.document_sha256);
end $$;
revoke all on function clinical_private.lab_observation_verified(uuid) from public;

create function clinical_core.attest_lab_observation(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
  _role text; _o clinical_core.lab_observations%rowtype; _e clinical_core.lab_import_events%rowtype;
  _current clinical_core.lab_observation_attestations%rowtype; _saved clinical_core.lab_observation_attestations%rowtype;
  _reading jsonb:=_request->'reading'; _observed timestamptz; _value numeric; _supersedes uuid;
begin
  if not exists(select 1 from clinical_core.lab_observation_attestation_activation where singleton and enabled) then
    raise exception using errcode='42501',message='lab_attestation_disabled'; end if;
  -- A workforce reviewer in a production clinical context, with a clinical role in this clinic now.
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

  -- Exact shape. There is no "verified" boolean, no signature, no range and no status to send.
  if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>4096
    or _request-array['statement','requestId','observationId','outcome','reading','documentSha256','supersedes']<>'{}'::jsonb
    or _request->>'statement' is distinct from 'lab-reading-attestation/1'
    or coalesce(_request->>'requestId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(_request->>'observationId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or _request->>'outcome' is null or _request->>'outcome' not in('verified','refuted')
    or coalesce(_request->>'documentSha256','') !~ '^[0-9a-f]{64}$'
    or not (_request ? 'supersedes')
    or (jsonb_typeof(_request->'supersedes')<>'null'
      and coalesce(_request->>'supersedes','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or jsonb_typeof(_reading)<>'object' or _reading-array['marker','value','unit','observedAt']<>'{}'::jsonb
    or jsonb_typeof(_reading->'marker')<>'string' or jsonb_typeof(_reading->'value')<>'number'
    or jsonb_typeof(_reading->'unit')<>'string' or jsonb_typeof(_reading->'observedAt')<>'string' then
    raise exception using errcode='22023',message='lab_attestation_invalid'; end if;
  begin _observed:=(_reading->>'observedAt')::timestamptz;
  exception when others then raise exception using errcode='22023',message='lab_attestation_invalid'; end;
  _value:=(_reading->>'value')::numeric; _supersedes:=nullif(_request->>'supersedes','')::uuid;

  -- A retried request is answered from its own record; a different binding under the same identity is a conflict.
  select * into _saved from clinical_core.lab_observation_attestations where organization_id=_org and request_id=(_request->>'requestId')::uuid;
  if found then
    if _saved.observation_id<>(_request->>'observationId')::uuid or _saved.outcome<>_request->>'outcome'
      or _saved.marker_name<>_reading->>'marker' or _saved.value_numeric<>_value or _saved.unit<>_reading->>'unit'
      or _saved.observed_at<>_observed or _saved.document_sha256<>_request->>'documentSha256'
      or _saved.supersedes_id is distinct from _supersedes or _saved.reviewer_person_id<>_actor then
      raise exception using errcode='40001',message='lab_attestation_conflict'; end if;
    return jsonb_build_object('attestationId',_saved.id,'observationId',_saved.observation_id,'outcome',_saved.outcome,
      'scope',_saved.scope,'rangeVerified',false,'attestedAt',_saved.attested_at,'duplicate',true);
  end if;

  select * into _o from clinical_core.lab_observations where id=(_request->>'observationId')::uuid for update;
  if not found or _o.organization_id<>_org then raise exception using errcode='42501',message='lab_attestation_refused'; end if;
  if _o.review_status='rejected' then raise exception using errcode='40001',message='lab_attestation_reading_rejected'; end if;
  select * into _e from clinical_core.lab_import_events where id=_o.import_event_id;
  -- The document must be one the transfer recorded this reading was read from. A /1 import names none.
  if _e.transfer_provenance is null or jsonb_array_length(coalesce(_e.transfer_provenance->'documents','[]'::jsonb))=0 then
    raise exception using errcode='40001',message='lab_attestation_document_unknown'; end if;
  if not exists(select 1 from jsonb_array_elements_text(_e.transfer_provenance->'documents') d where d.value=_request->>'documentSha256') then
    raise exception using errcode='40001',message='lab_attestation_document_mismatch'; end if;
  if _o.unit is null then raise exception using errcode='40001',message='lab_attestation_unit_unknown'; end if;
  -- The reviewer restates what they compared; the server compares it to what it holds, exactly.
  if _o.marker_name<>_reading->>'marker' or _o.value_numeric<>_value or _o.unit<>_reading->>'unit' or _o.observed_at<>_observed then
    raise exception using errcode='40001',message='lab_attestation_mismatch'; end if;

  _current:=clinical_private.current_lab_observation_attestation(_o.id);
  if _current.id is distinct from _supersedes then
    raise exception using errcode='40001',message='lab_attestation_stale'; end if;

  insert into clinical_core.lab_observation_attestations(organization_id,patient_record_id,observation_id,import_event_id,
    statement_version,scope,outcome,marker_name,value_numeric,unit,observed_at,document_sha256,reviewer_person_id,
    reviewer_role,supersedes_id,request_id)
  values(_o.organization_id,_o.patient_record_id,_o.id,_o.import_event_id,'lab-reading-attestation/1','measured_value',
    _request->>'outcome',_o.marker_name,_o.value_numeric,_o.unit,_o.observed_at,_request->>'documentSha256',_actor,_role,
    _supersedes,(_request->>'requestId')::uuid)
  returning * into _saved;
  return jsonb_build_object('attestationId',_saved.id,'observationId',_saved.observation_id,'outcome',_saved.outcome,
    'scope',_saved.scope,'rangeVerified',false,'attestedAt',_saved.attested_at,'duplicate',false);
end $$;
revoke all on function clinical_core.attest_lab_observation(jsonb) from public;
grant execute on function clinical_core.attest_lab_observation(jsonb) to clinical_core_api;

-- What a reviewer sees of a reading's verification: the current state and the history, newest first. The values
-- are the clinic's own record; nothing here classifies the reading or speaks for its range.
create function clinical_core.lab_observation_verification(_observation uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _o clinical_core.lab_observations%rowtype; _current clinical_core.lab_observation_attestations%rowtype;
begin
  select * into _o from clinical_core.lab_observations where id=_observation;
  if not found then raise exception using errcode='P0002',message='lab_observation_not_found'; end if;
  perform clinical_private.assert_production_context(_o.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_o.organization_id) then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  _current:=clinical_private.current_lab_observation_attestation(_o.id);
  return jsonb_build_object('observationId',_o.id,
    'state',case when clinical_private.lab_observation_verified(_o.id) then 'verified'
      when _current.outcome='refuted' then 'refuted' else 'needs_human_review' end,
    'current',case when _current.id is null then null else _current.id end,
    'rangeVerified',false,
    'history',(select coalesce(jsonb_agg(jsonb_build_object('attestationId',a.id,'outcome',a.outcome,'scope',a.scope,
      'documentSha256',a.document_sha256,'reviewerRole',a.reviewer_role,'supersedes',a.supersedes_id,'attestedAt',a.attested_at)
      order by a.attested_at desc,a.id),'[]'::jsonb)
      from (select * from clinical_core.lab_observation_attestations where observation_id=_o.id order by attested_at desc,id limit 50) a));
end $$;
revoke all on function clinical_core.lab_observation_verification(uuid) from public;
grant execute on function clinical_core.lab_observation_verification(uuid) to clinical_core_api;
