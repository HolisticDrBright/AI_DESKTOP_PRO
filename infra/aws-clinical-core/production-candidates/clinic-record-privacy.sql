-- Clinic-record privacy: patient copy and correction requests, practitioner
-- review and fulfilment, and bounded reads of a fulfilled copy.
--
-- Forward source candidate only. It becomes the 114th migration of a distinct
-- artifact whose first 113 files are byte-identical to the exact
-- telehealth-chart-lifecycle/3 candidate (scripts/clinic-record-privacy-candidate.mjs
-- pins the parent ledger and this file's SHA-256). It alters no historical
-- migration, seeds no rows, registers no release and is not an instruction to apply.
--
-- What it adds, and the decisions behind it:
--
--   1. clinical_core.clinic_record_requests — the clinic-scoped request ledger
--      (kind 'copy' or 'correction'). Every row is bound to the organization,
--      the patient record, the patient connection that existed when it was
--      submitted and the IMMUTABLE owner (the consumer person). The legacy
--      clinical_core.privacy_requests row (free text, no scope, no revision,
--      no decision) is left untouched; this ledger supersedes it for V2.
--      One open request per (connection, kind); a client-chosen request id makes
--      submission replay-safe: the same id with the same bytes returns the
--      existing row, the same id with other bytes is a conflict.
--
--   2. clinical_core.clinic_record_request_events — append-only history with a
--      per-request sequence. Workforce decisions carry a decision id; a repeated
--      decision id returns the current state instead of applying twice, and an
--      expected revision refuses a stale decision. Two decisions in either order
--      converge on one outcome.
--
--   3. clinical_core.clinic_record_copies / clinic_record_copy_items — the
--      fulfilled copy as a SNAPSHOT taken at fulfilment (as_of), never a live
--      read later: each item is one record projection with its revision and
--      digest, bounded per item, read back by keyset under the owner's own
--      identity. Reading does not depend on the connection still being active:
--      a received clinic record is the owner's to re-read; nothing here erases.
--      The wire form of an item is the exact UTF-8 text that was digested
--      (payloadText, payloadSha256, byteLength): the device verifies the bytes
--      it received before it parses them, and a decimal such as 1.20 or
--      0.0000001 is displayed as written. (Revision 2 of this candidate; the
--      first revision returned a re-serializable object and was never applied.)
--
--   4. clinical_private.clinic_disclosure_releases — the disclosure authority.
--      Fulfilling a copy requires a live, reviewed release for this organization
--      covering every included section. The artifact seeds none, so every
--      fulfilment fails closed (clinic_disclosure_release_required) until the
--      owner's review registers one with a privileged connection. Tests use
--      clearly fictional releases only.
--
--   5. The section registry (clinical_private.clinic_record_sections): every
--      clinic domain is either read by an authorized projection here (signed
--      notes with append-only addenda; telehealth visit records through their
--      chart-transfer receipts; reviewed lab observations with provenance) or
--      named with the reason it is not (correspondence is already readable
--      through production_care_message_export; programs/protocols and
--      intake/check-ins have no production reader). Unsigned notes, drafts,
--      notes entered in error, unreviewed observations and chart drafts are
--      counted as exclusions, never disclosed. Nothing in a payload is an
--      admission, token, host credential or signing material.
--
--   6. Correction = request against a disclosed signed note revision; the
--      practitioner's acceptance is add_note_addendum (append-only, attributed,
--      reason + referenced version); a decline records the disagreement beside
--      the record. The original signed content, signature and revision are
--      never changed. A dispute is not an amendment; an owner correction is not
--      authority to change a clinician-authored record.
--
--   7. Deletion is not here: a request to delete clinic-held material remains
--      the reviewed disposition workflow (privacy operations, store
--      clinic_records). Holds, provider copies and backups are untouched.

-- ------------------------------------------------------------- 1. ledgers

create table clinical_core.clinic_record_requests (
  id uuid primary key,
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  connection_id uuid not null,
  owner_person_id uuid not null references clinical_core.persons(id),
  kind text not null check (kind in ('copy','correction')),
  sections text[] not null default '{}',
  subject_kind text check (subject_kind is null or subject_kind in ('clinical_note')),
  subject_id uuid,
  subject_revision integer check (subject_revision is null or subject_revision > 0),
  reason_code text check (reason_code is null or reason_code in
    ('not_true_of_me','was_true_no_longer','never_discussed','disagree_with_conclusion','wrong_person','missing_context','other')),
  statement text check (statement is null or char_length(statement) between 1 and 2000),
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'submitted'
    check (status in ('submitted','in_review','fulfilled','refused','withdrawn','superseded')),
  revision integer not null default 1 check (revision > 0),
  submitted_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  decided_by_person_id uuid references clinical_core.persons(id),
  decision_reason_code text,
  decision_reason text check (decision_reason is null or char_length(decision_reason) between 1 and 2000),
  fulfillment_id uuid,
  -- The superseding request is inserted after the open one is closed in the same transaction.
  superseded_by uuid references clinical_core.clinic_record_requests(id) deferrable initially deferred,
  check ((kind='copy') = (cardinality(sections) > 0)),
  check ((kind='copy') = (subject_kind is null and subject_id is null and subject_revision is null and reason_code is null and statement is null)),
  check ((status in ('fulfilled','refused')) = (decided_at is not null and decided_by_person_id is not null)),
  check ((status = 'superseded') = (superseded_by is not null)),
  foreign key (connection_id, organization_id, patient_record_id)
    references clinical_core.patient_connections(id, organization_id, patient_record_id)
);
create unique index clinic_record_requests_open_idx
  on clinical_core.clinic_record_requests(connection_id, kind) where status in ('submitted','in_review');
create index clinic_record_requests_queue_idx
  on clinical_core.clinic_record_requests(organization_id, status, submitted_at, id);
create index clinic_record_requests_owner_idx
  on clinical_core.clinic_record_requests(owner_person_id, organization_id, submitted_at desc);
alter table clinical_core.clinic_record_requests enable row level security;
alter table clinical_core.clinic_record_requests force row level security;
revoke all on clinical_core.clinic_record_requests from public, clinical_core_api;
create function clinical_private.guard_clinic_record_request() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception using errcode='42501',message='append_only_record'; end if;
  -- Identity, owner, kind, subject and input bytes never change; only state does.
  if new.id<>old.id or new.organization_id<>old.organization_id or new.patient_record_id<>old.patient_record_id
    or new.connection_id<>old.connection_id or new.owner_person_id<>old.owner_person_id or new.kind<>old.kind
    or new.sections<>old.sections or new.subject_kind is distinct from old.subject_kind or new.subject_id is distinct from old.subject_id
    or new.subject_revision is distinct from old.subject_revision or new.reason_code is distinct from old.reason_code
    or new.statement is distinct from old.statement or new.input_sha256<>old.input_sha256 or new.submitted_at<>old.submitted_at
    or old.status in ('fulfilled','refused','withdrawn','superseded') then
    raise exception using errcode='42501',message='append_only_record'; end if;
  if new.revision<>old.revision+1 then raise exception using errcode='42501',message='clinic_record_conflict'; end if;
  return new;
end $$;
revoke all on function clinical_private.guard_clinic_record_request() from public, clinical_core_api;
create trigger clinic_record_requests_guard before update or delete on clinical_core.clinic_record_requests
  for each row execute function clinical_private.guard_clinic_record_request();

create table clinical_core.clinic_record_request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references clinical_core.clinic_record_requests(id),
  organization_id uuid not null references clinical_core.organizations(id),
  seq integer not null check (seq > 0),
  actor_person_id uuid not null references clinical_core.persons(id),
  actor_pool text not null check (actor_pool in ('consumer','workforce')),
  action text not null check (action in
    ('submitted','withdrawn','superseded','review_started','copy_fulfilled','refused','amended','declined')),
  from_status text,
  to_status text not null,
  reason_code text,
  reason text check (reason is null or char_length(reason) between 1 and 2000),
  decision_id uuid,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (request_id, seq)
);
create unique index clinic_record_request_events_decision_idx
  on clinical_core.clinic_record_request_events(decision_id) where decision_id is not null;
alter table clinical_core.clinic_record_request_events enable row level security;
alter table clinical_core.clinic_record_request_events force row level security;
revoke all on clinical_core.clinic_record_request_events from public, clinical_core_api;
create trigger clinic_record_request_events_append_only before update or delete on clinical_core.clinic_record_request_events
  for each row execute function clinical_private.block_update_delete();

create table clinical_core.clinic_record_copies (
  id uuid primary key,
  request_id uuid not null unique references clinical_core.clinic_record_requests(id),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  owner_person_id uuid not null references clinical_core.persons(id),
  release_id uuid not null,
  release_version text not null,
  as_of timestamptz not null,
  prepared_by_person_id uuid not null references clinical_core.persons(id),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  item_count integer not null check (item_count >= 0),
  byte_total bigint not null check (byte_total >= 0),
  created_at timestamptz not null default clock_timestamp()
);
alter table clinical_core.clinic_record_copies enable row level security;
alter table clinical_core.clinic_record_copies force row level security;
revoke all on clinical_core.clinic_record_copies from public, clinical_core_api;
create trigger clinic_record_copies_append_only before update or delete on clinical_core.clinic_record_copies
  for each row execute function clinical_private.block_update_delete();

create table clinical_core.clinic_record_copy_items (
  -- Items are written while the snapshot is assembled; the copy row, with the
  -- final manifest and counts, is written last in the same transaction.
  copy_id uuid not null references clinical_core.clinic_record_copies(id) deferrable initially deferred,
  section text not null check (section in ('signed_notes','telehealth_visits','lab_observations')),
  seq integer not null check (seq > 0),
  record_kind text not null check (record_kind in ('clinical_note','telehealth_visit','lab_observation')),
  record_id uuid not null,
  revision integer not null check (revision > 0),
  -- The exact UTF-8 text that was digested is what travels to the device: a
  -- number such as 1.20 or 0.0000001 keeps its bytes, so the device hashes the
  -- text it received, never a value it re-serialized. There is one
  -- authoritative copy; nothing structured is stored beside it.
  payload_text text not null check (jsonb_typeof(payload_text::jsonb) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length integer not null check (byte_length between 1 and 49152),
  check (pg_catalog.octet_length(payload_text) = byte_length),
  primary key (copy_id, section, seq),
  unique (copy_id, record_kind, record_id)
);
alter table clinical_core.clinic_record_copy_items enable row level security;
alter table clinical_core.clinic_record_copy_items force row level security;
revoke all on clinical_core.clinic_record_copy_items from public, clinical_core_api;
create trigger clinic_record_copy_items_append_only before update or delete on clinical_core.clinic_record_copy_items
  for each row execute function clinical_private.block_update_delete();

-- --------------------------------------------- 2. disclosure release custody

-- Empty in this artifact. The owner's review registers a release with a
-- privileged connection naming the sections a clinic may disclose through this
-- path; it can only be revoked, never edited. No API role can read or write it.
create table clinical_private.clinic_disclosure_releases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  release_version text not null check (release_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$'),
  sections text[] not null check (cardinality(sections) between 1 and 8),
  reviewed_by text not null check (char_length(reviewed_by) between 3 and 200),
  review_sha256 text not null check (review_sha256 ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  unique (organization_id, release_version)
);
alter table clinical_private.clinic_disclosure_releases enable row level security;
alter table clinical_private.clinic_disclosure_releases force row level security;
revoke all on clinical_private.clinic_disclosure_releases from public, clinical_core_api;
create function clinical_private.guard_clinic_disclosure_release() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception using errcode='42501',message='append_only_record'; end if;
  if new.id<>old.id or new.organization_id<>old.organization_id or new.release_version<>old.release_version
    or new.sections<>old.sections or new.reviewed_by<>old.reviewed_by or new.review_sha256<>old.review_sha256
    or new.approved_at<>old.approved_at or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception using errcode='42501',message='append_only_record'; end if;
  return new;
end $$;
revoke all on function clinical_private.guard_clinic_disclosure_release() from public, clinical_core_api;
create trigger clinic_disclosure_releases_guard before update or delete on clinical_private.clinic_disclosure_releases
  for each row execute function clinical_private.guard_clinic_disclosure_release();

-- ---------------------------------------------------------- 3. vocabularies

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check(action in(
  'connection.invitation_issued','connection.invitation_claimed','connection.paused','connection.resumed',
  'connection.revoked','consent.granted','consent.revoked','lab_import.received','lab_import.duplicate',
  'lab_import.accepted','lab_import.rejected','clinical_record.received','clinical_record.duplicate',
  'privacy_request.submitted','patient.created','lab_observation.reviewed','marker.view','document.viewed',
  'document.exported','report.exported','audit.exported','membership.role_changed','membership.suspended',
  'review_task.created','review_task.resolved','appointment.booked','appointment.rescheduled',
  'appointment.status_changed','appointment.corrected','encounter.started','encounter.completed',
  'encounter.cancelled','encounter.entered_in_error','note.draft_created','note.draft_saved',
  'note.ready_for_review','note.signed','note.addendum_created','note.entered_in_error',
  'protocol.draft_created','protocol.draft_saved','protocol.approved','protocol.activated','protocol.paused',
  'protocol.completed','protocol.discontinued','protocol.revision_created','sync.export_queued',
  'sync.resource_withdrawal_queued','sync.event_retried','sync.event_cancelled','sync.inbound_accepted',
  'sync.inbound_rejected','sync.inbound_correction_recorded','sync.conflict_resolved',
  'sync.provider_registered','sync.provider_reviewed','protocol.interaction_reviewed',
  'protocol_template.created','protocol_template.approved','protocol_template.archived','hypothesis.accepted',
  'hypothesis.rejected','hypothesis.needs_data','lens.question_accepted','lens.question_asked',
  'lens.question_deferred','lens.question_skipped','lens.question_dismissed','lens.question_answered',
  'lens.answer_corrected','lens.question_added_to_note','lens.safety_block_reviewed',
  'knowledge.pathway_draft_created','knowledge.pathway_draft_updated','knowledge.pathway_approved',
  'knowledge.import_staged','knowledge.import_item_applied','knowledge.import_item_rejected',
  'knowledge.import_conflict_resolved','knowledge.research_review_recorded','knowledge.import_committed',
  'knowledge.import_cancelled','telehealth.note_transferred','clinic_record.request_submitted',
  'clinic_record.request_withdrawn','clinic_record.request_superseded','clinic_record.review_started',
  'clinic_record.copy_fulfilled','clinic_record.request_refused','clinic_record.correction_amended',
  'clinic_record.correction_declined','clinic_record.copy_read'));

-- ----------------------------------------------------------- 4. registry

-- The section registry: what each clinic domain is, who may read it here, how
-- it is projected and revisioned, and why it is excluded when it is.
create function clinical_private.clinic_record_sections()
returns table (section text, readable boolean, exclusion_reason text, projection text, revision_rule text) language sql immutable set search_path='' as $$
  values
    ('signed_notes', true, null::text, 'clinical_notes in status signed or amended: the signed version content, its signature and every append-only addendum', 'signed note version'),
    ('telehealth_visits', true, null::text, 'telehealth_note_transfers: the signed visit record (reviewed AI sections, practitioner text, action-item decisions, consent summary, provider ids) and chart lineage; never the chart draft, the admission or any signing material', 'signed visit record revision'),
    ('lab_observations', true, null::text, 'lab_observations in review_status accepted, with provenance; unreviewed, flagged and rejected rows are counted, not disclosed', 'observation row (immutable)'),
    ('correspondence', false, 'available_through_care_message_export', 'retained in-app messages are read through production_care_message_export under the immutable thread owner', null::text),
    ('protocols_programs', false, 'no_production_reader', 'program assignments and protocols exist only in the synthetic domain; no production projection is ported', null::text),
    ('intake_checkins', false, 'no_production_reader', 'intake packets, responses and check-ins exist only in the synthetic domain; no production projection is ported', null::text)
$$;
revoke all on function clinical_private.clinic_record_sections() from public, clinical_core_api;

-- ----------------------------------------------------------- 5. authority

-- The consumer's live clinic link (verified or paused) with an active patient.
create function clinical_private.clinic_record_connection(_actor uuid, _org uuid) returns clinical_core.patient_connections
language plpgsql stable security definer set search_path='' as $$
declare _c clinical_core.patient_connections;
begin
  select c.* into _c from clinical_core.patient_connections c join clinical_core.patient_records p on p.id=c.patient_record_id
    where c.organization_id=_org and c.consumer_person_id=_actor and c.state in ('verified','paused') and p.status='active';
  return _c;
end $$;
revoke all on function clinical_private.clinic_record_connection(uuid,uuid) from public, clinical_core_api;

-- A request the actor owns. Reading one's own request or fulfilled copy needs the
-- immutable owner, the organization and an active production-bound identity —
-- not the connection still being verified. Nothing else is required and nothing
-- weaker is accepted.
create function clinical_private.clinic_record_owned(_actor uuid, _org uuid, _request_id uuid, _lock boolean) returns clinical_core.clinic_record_requests
language plpgsql security definer set search_path='' as $$
declare _r clinical_core.clinic_record_requests;
begin
  if _request_id is null then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
  if _lock then
    select * into _r from clinical_core.clinic_record_requests where id=_request_id for update;
  else
    select * into _r from clinical_core.clinic_record_requests where id=_request_id;
  end if;
  if _r.id is null or _r.organization_id<>_org or _r.owner_person_id<>_actor then
    raise exception using errcode='P0002',message='clinic_record_not_found'; end if;
  return _r;
end $$;
revoke all on function clinical_private.clinic_record_owned(uuid,uuid,uuid,boolean) from public, clinical_core_api;

-- ------------------------------------------------------------ 6. helpers

create function clinical_private.clinic_record_json(_r clinical_core.clinic_record_requests) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('requestId',_r.id,'kind',_r.kind,'status',_r.status,'revision',_r.revision,
    'sections',to_jsonb(_r.sections),'subject',case when _r.subject_id is null then null else jsonb_build_object(
      'kind',_r.subject_kind,'id',_r.subject_id,'revision',_r.subject_revision) end,
    'reasonCode',_r.reason_code,'statement',_r.statement,'submittedAt',_r.submitted_at,'updatedAt',_r.updated_at,
    'decidedAt',_r.decided_at,'decisionReasonCode',_r.decision_reason_code,'decisionReason',_r.decision_reason,
    'fulfillmentId',_r.fulfillment_id,'supersededBy',_r.superseded_by,
    'outcome',case when _r.status='fulfilled' and _r.kind='copy' then 'copy_delivered'
      when _r.status='fulfilled' then 'amended' when _r.status='refused' and _r.kind='copy' then 'copy_refused'
      when _r.status='refused' then 'declined' else null end)
$$;
revoke all on function clinical_private.clinic_record_json(clinical_core.clinic_record_requests) from public, clinical_core_api;

create function clinical_private.clinic_record_events_json(_request_id uuid) returns jsonb
language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('seq',e.seq,'action',e.action,'actorPool',e.actor_pool,'fromStatus',e.from_status,
    'toStatus',e.to_status,'reasonCode',e.reason_code,'reason',e.reason,'decisionId',e.decision_id,'detail',e.detail,'at',e.created_at)
    order by e.seq),'[]'::jsonb)
  from clinical_core.clinic_record_request_events e where e.request_id=_request_id
$$;
revoke all on function clinical_private.clinic_record_events_json(uuid) from public, clinical_core_api;

create function clinical_private.clinic_record_event(_r clinical_core.clinic_record_requests, _actor uuid, _pool text, _action text,
  _from text, _to text, _reason_code text, _reason text, _decision_id uuid, _detail jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare _seq integer;
begin
  select coalesce(max(seq),0)+1 into _seq from clinical_core.clinic_record_request_events where request_id=_r.id;
  insert into clinical_core.clinic_record_request_events(request_id,organization_id,seq,actor_person_id,actor_pool,action,from_status,to_status,reason_code,reason,decision_id,detail)
    values(_r.id,_r.organization_id,_seq,_actor,_pool,_action,_from,_to,_reason_code,_reason,_decision_id,coalesce(_detail,'{}'::jsonb));
end $$;
revoke all on function clinical_private.clinic_record_event(clinical_core.clinic_record_requests,uuid,text,text,text,text,text,text,uuid,jsonb) from public, clinical_core_api;

create function clinical_private.clinic_record_audit(_org uuid, _actor uuid, _action text, _request uuid, _patient uuid, _message text, _purpose text, _meta jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,safe_message,purpose,safe_metadata)
    values(_org,_actor,_action,'privacy_request',_request,_patient,_message,_purpose,coalesce(_meta,'{}'::jsonb));
end $$;
revoke all on function clinical_private.clinic_record_audit(uuid,uuid,text,uuid,uuid,text,text,jsonb) from public, clinical_core_api;

create function clinical_private.clinic_record_text_array(_v jsonb, _max integer) returns text[]
language plpgsql immutable set search_path='' as $$
declare _out text[]:='{}'; _e jsonb;
begin
  if _v is null or jsonb_typeof(_v)<>'array' or jsonb_array_length(_v)>_max then
    raise exception using errcode='22023',message='clinic_record_invalid'; end if;
  for _e in select * from jsonb_array_elements(_v) loop
    if jsonb_typeof(_e)<>'string' or (_e#>>'{}')=any(_out) then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
    _out:=_out||(_e#>>'{}');
  end loop;
  return _out;
end $$;
revoke all on function clinical_private.clinic_record_text_array(jsonb,integer) from public, clinical_core_api;

-- What fulfilment WOULD include for these sections, as counts: included rows,
-- and each exclusion by reason. Nothing is written and no text is returned.
create function clinical_private.clinic_record_preview(_org uuid, _patient uuid, _sections text[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _s text; _out jsonb:='[]'::jsonb; _row jsonb; _reg record;
begin
  foreach _s in array _sections loop
    select * into _reg from clinical_private.clinic_record_sections() where section=_s;
    if _reg.section is null then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
    if not _reg.readable then
      _row:=jsonb_build_object('section',_s,'readable',false,'exclusionReason',_reg.exclusion_reason,'includable',0,'excluded','{}'::jsonb);
    elsif _s='signed_notes' then
      select jsonb_build_object('section',_s,'readable',true,'exclusionReason',null,
        'includable',count(*) filter (where status in ('signed','amended') and deleted_at is null),
        'excluded',jsonb_strip_nulls(jsonb_build_object(
          'unsigned_not_disclosable',nullif(count(*) filter (where status in ('draft','ready_for_review') and deleted_at is null),0),
          'entered_in_error',nullif(count(*) filter (where status='entered_in_error' or deleted_at is not null),0))))
        into _row from clinical_core.clinical_notes where organization_id=_org and patient_record_id=_patient;
    elsif _s='telehealth_visits' then
      select jsonb_build_object('section',_s,'readable',true,'exclusionReason',null,'includable',count(*),'excluded','{}'::jsonb)
        into _row from clinical_core.telehealth_note_transfers where organization_id=_org and patient_record_id=_patient;
    elsif _s='lab_observations' then
      select jsonb_build_object('section',_s,'readable',true,'exclusionReason',null,
        'includable',count(*) filter (where review_status='accepted'),
        'excluded',jsonb_strip_nulls(jsonb_build_object('not_reviewed',nullif(count(*) filter (where review_status='unreviewed'),0),
          'flagged',nullif(count(*) filter (where review_status='flagged'),0),'rejected',nullif(count(*) filter (where review_status='rejected'),0))))
        into _row from clinical_core.lab_observations where organization_id=_org and patient_record_id=_patient;
    end if;
    _out:=_out||_row;
  end loop;
  return _out;
end $$;
revoke all on function clinical_private.clinic_record_preview(uuid,uuid,text[]) from public, clinical_core_api;

-- Builds the snapshot for one request: every included readable section is
-- projected now, each item bounded; an oversize projection is kept as a digest
-- and counted as omitted, never silently dropped or claimed. Returns the copy id.
create function clinical_private.clinic_record_build_copy(_r clinical_core.clinic_record_requests, _actor uuid, _include text[],
  _excluded jsonb, _release clinical_private.clinic_disclosure_releases) returns uuid
language plpgsql security definer set search_path='' as $$
declare _copy uuid:=gen_random_uuid(); _now timestamptz:=clock_timestamp(); _s text; _seq integer; _rec record;
  _payload jsonb; _text text; _bytes integer; _items integer:=0; _total bigint:=0; _omitted integer; _included integer;
  _sections jsonb:='[]'::jsonb; _preview jsonb; _p jsonb; _manifest jsonb; _manifest_sha text; _x jsonb;
begin
  _preview:=clinical_private.clinic_record_preview(_r.organization_id,_r.patient_record_id,_r.sections);
  foreach _s in array _r.sections loop
    select value into _p from jsonb_array_elements(_preview) where value->>'section'=_s;
    if not (_s=any(_include)) then
      select value into _x from jsonb_array_elements(_excluded) where value->>'section'=_s;
      _sections:=_sections||jsonb_build_object('section',_s,'included',false,'itemCount',0,'byteTotal',0,'omittedCount',0,
        'exclusionReason',coalesce(_x->>'reason',_p->>'exclusionReason'),'excluded',_p->'excluded');
      continue;
    end if;
    _seq:=0; _omitted:=0; _included:=0;
    for _rec in
      select * from (
        select 'clinical_note'::text as record_kind, n.id as record_id, s.note_version as revision, n.signed_at as ord,
          jsonb_build_object('noteId',n.id,'encounterId',n.encounter_id,'noteType',n.note_type,'status',n.status,
            'signedAt',s.signed_at,'signedByPersonId',s.signed_by_person_id,'attestation',s.attestation,
            'version',s.note_version,'contentSha256',s.content_sha256,'content',v.content,
            'addenda',(select coalesce(jsonb_agg(jsonb_build_object('addendumId',a.id,'referencedVersion',a.referenced_version,
              'authorPersonId',a.author_person_id,'reason',a.reason,'content',a.content,'createdAt',a.created_at) order by a.created_at,a.id),'[]'::jsonb)
              from clinical_core.note_addenda a where a.note_id=n.id)) as payload
        from clinical_core.clinical_notes n
          join clinical_core.note_signatures s on s.note_id=n.id
          join clinical_core.clinical_note_versions v on v.note_id=n.id and v.version=s.note_version
        where _s='signed_notes' and n.organization_id=_r.organization_id and n.patient_record_id=_r.patient_record_id
          and n.status in ('signed','amended') and n.deleted_at is null
        union all
        select 'telehealth_visit', t.id, t.source_note_revision, t.created_at,
          jsonb_build_object('transferId',t.id,'appointmentId',t.appointment_id,'sourceNoteRevision',t.source_note_revision,
            'sourceDigest',t.source_digest,'sourcePayload',t.source_payload,'sourcePayloadSha256',t.source_payload_sha256,
            'transferredAt',t.created_at,'transferredByPersonId',t.transferred_by_person_id,
            'chart',jsonb_build_object('encounterId',t.encounter_id,'noteId',t.note_id,'noteVersion',t.note_version,
              'noteStatus',(select cn.status from clinical_core.clinical_notes cn where cn.id=t.note_id)))
        from clinical_core.telehealth_note_transfers t
        where _s='telehealth_visits' and t.organization_id=_r.organization_id and t.patient_record_id=_r.patient_record_id
        union all
        select 'lab_observation', o.id, 1, o.observed_at,
          jsonb_build_object('observationId',o.id,'panelName',o.panel_name,'markerName',o.marker_name,'valueNumeric',o.value_numeric,
            'unit',o.unit,'referenceMin',o.reference_min,'referenceMax',o.reference_max,'observedAt',o.observed_at,
            'reviewedAt',o.reviewed_at,'reviewedByPersonId',o.reviewed_by_person_id,'provenance',o.provenance)
        from clinical_core.lab_observations o
        where _s='lab_observations' and o.organization_id=_r.organization_id and o.patient_record_id=_r.patient_record_id
          and o.review_status='accepted'
      ) rows order by ord, record_id
    loop
      _seq:=_seq+1; _payload:=_rec.payload; _text:=_payload::text; _bytes:=pg_catalog.octet_length(_text);
      if _bytes>49152 then
        _omitted:=_omitted+1;
        _payload:=jsonb_build_object('omitted',true,'reason','oversize_not_inlined','byteLength',_bytes,
          'sha256',pg_catalog.encode(public.digest(pg_catalog.convert_to(_text,'UTF8'),'sha256'),'hex'));
        _text:=_payload::text; _bytes:=pg_catalog.octet_length(_text);
      else
        _included:=_included+1;
      end if;
      insert into clinical_core.clinic_record_copy_items(copy_id,section,seq,record_kind,record_id,revision,payload_text,payload_sha256,byte_length)
        values(_copy,_s,_seq,_rec.record_kind,_rec.record_id,_rec.revision,_text,
          pg_catalog.encode(public.digest(pg_catalog.convert_to(_text,'UTF8'),'sha256'),'hex'),_bytes);
      _items:=_items+1; _total:=_total+_bytes;
    end loop;
    _sections:=_sections||jsonb_build_object('section',_s,'included',true,'itemCount',_included,'byteTotal',_total,
      'omittedCount',_omitted,'exclusionReason',null,'excluded',_p->'excluded');
  end loop;
  _manifest:=jsonb_build_object('contract','clinic-record-copy/1','copyId',_copy,'requestId',_r.id,'asOf',_now,
    'consistency','snapshot_at_fulfillment','releaseVersion',_release.release_version,'sections',_sections,
    'coverage',jsonb_build_object('completeClinicRecord',false,
      'notIncluded',jsonb_build_array('chart drafts and unsigned notes','unreviewed, flagged or rejected lab observations','correspondence (separate export)',
        'provider copies (Zoom)','backups','identity and billing')));
  _manifest_sha:=pg_catalog.encode(public.digest(pg_catalog.convert_to(_manifest::text,'UTF8'),'sha256'),'hex');
  insert into clinical_core.clinic_record_copies(id,request_id,organization_id,patient_record_id,owner_person_id,release_id,release_version,
    as_of,prepared_by_person_id,manifest,manifest_sha256,item_count,byte_total)
    values(_copy,_r.id,_r.organization_id,_r.patient_record_id,_r.owner_person_id,_release.id,_release.release_version,
      _now,_actor,_manifest,_manifest_sha,_items,_total);
  return _copy;
end $$;
revoke all on function clinical_private.clinic_record_build_copy(clinical_core.clinic_record_requests,uuid,text[],jsonb,clinical_private.clinic_disclosure_releases) from public, clinical_core_api;

-- ---------------------------------------------------------- 7. dispatcher

create function clinical_core.clinic_record_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _action text:=_request->>'action'; _pool text; _actor uuid; _org uuid:=clinical_private.organization_id();
  _c clinical_core.patient_connections; _r clinical_core.clinic_record_requests; _prev clinical_core.clinic_record_requests;
  _id uuid; _sections text[]; _input_sha text; _canonical jsonb; _limit integer; _after jsonb; _rows jsonb; _n integer;
  _expected integer; _decision uuid; _e clinical_core.clinic_record_request_events; _release clinical_private.clinic_disclosure_releases;
  _include text[]; _excluded jsonb; _copy uuid; _copy_row clinical_core.clinic_record_copies; _addendum uuid; _note clinical_core.clinical_notes;
  _reason_code text; _reason text; _subject uuid; _subject_rev integer; _s text; _bytes bigint; _item record;
  _consumer_actions text[]:=array['overview','submit_copy','submit_correction','get','withdraw','read_copy'];
  _workforce_actions text[]:=array['queue','review','begin_review','fulfill','refuse','amend','decline'];
begin
  if _request is null or jsonb_typeof(_request)<>'object' or _action is null then
    raise exception using errcode='22023',message='clinic_record_invalid'; end if;
  if _action=any(_consumer_actions) then _pool:='consumer';
  elsif _action=any(_workforce_actions) then _pool:='workforce';
  else raise exception using errcode='22023',message='clinic_record_invalid'; end if;
  -- Identity: an active production-bound identity in this pool, an active
  -- organization, and for workforce a clinical role. Claims only, never the body.
  _actor:=clinical_private.care_connection_actor(_pool,case when _pool='consumer' then 'consent_management' else 'clinical_data' end);
  if _org is null then raise exception using errcode='42501',message='clinic_record_refused'; end if;

  -- ======================================================= consumer actions
  if _action='overview' then
    _c:=clinical_private.clinic_record_connection(_actor,_org);
    select coalesce(jsonb_agg(clinical_private.clinic_record_json(r) order by r.submitted_at desc, r.id desc),'[]'::jsonb) into _rows
      from (select * from clinical_core.clinic_record_requests where owner_person_id=_actor and organization_id=_org
        order by submitted_at desc, id desc limit 50) r;
    return jsonb_build_object('action','overview',
      'connection',case when _c.id is null then null else jsonb_build_object('connectionId',_c.id,'patientRecordId',_c.patient_record_id,
        'state',_c.state,'verifiedAt',_c.verified_at,'version',_c.version) end,
      'sections',(select jsonb_agg(jsonb_build_object('section',section,'readable',readable,'exclusionReason',exclusion_reason,'projection',projection) order by section)
        from clinical_private.clinic_record_sections()),
      'requests',_rows);
  end if;

  if _action in ('submit_copy','submit_correction') then
    if jsonb_typeof(_request->'requestId') is distinct from 'string' then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
    begin _id:=(_request->>'requestId')::uuid; exception when others then raise exception using errcode='22023',message='clinic_record_invalid'; end;
    perform clinical_private.assert_owned_storage_writable(_actor);
    if _action='submit_copy' then
      _sections:=clinical_private.clinic_record_text_array(_request->'sections',8);
      foreach _s in array _sections loop
        if not exists(select 1 from clinical_private.clinic_record_sections() where section=_s) then
          raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      end loop;
      _canonical:=jsonb_build_object('action','submit_copy','requestId',_id,'sections',to_jsonb(_sections),'supersedes',_request->'supersedes');
    else
      if (_request->>'subjectKind') is distinct from 'clinical_note' or jsonb_typeof(_request->'subjectId') is distinct from 'string'
        or jsonb_typeof(_request->'subjectRevision') is distinct from 'number' or jsonb_typeof(_request->'reasonCode') is distinct from 'string'
        or jsonb_typeof(_request->'statement') is distinct from 'string' then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      begin _subject:=(_request->>'subjectId')::uuid; _subject_rev:=(_request->>'subjectRevision')::integer;
      exception when others then raise exception using errcode='22023',message='clinic_record_invalid'; end;
      _reason_code:=_request->>'reasonCode'; _reason:=pg_catalog.btrim(_request->>'statement');
      if _subject_rev<1 or _reason_code not in ('not_true_of_me','was_true_no_longer','never_discussed','disagree_with_conclusion','wrong_person','missing_context','other')
        or char_length(_reason) not between 1 and 2000 then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      _canonical:=jsonb_build_object('action','submit_correction','requestId',_id,'subjectKind','clinical_note','subjectId',_subject,
        'subjectRevision',_subject_rev,'reasonCode',_reason_code,'statement',_reason);
    end if;
    _input_sha:=pg_catalog.encode(public.digest(pg_catalog.convert_to(_canonical::text,'UTF8'),'sha256'),'hex');
    -- Replay: the same request id again with the same bytes returns what was recorded.
    select * into _r from clinical_core.clinic_record_requests where id=_id;
    if _r.id is not null then
      if _r.owner_person_id<>_actor or _r.organization_id<>_org or _r.input_sha256<>_input_sha then
        raise exception using errcode='40001',message='clinic_record_conflict'; end if;
      return jsonb_build_object('action',_action,'request',clinical_private.clinic_record_json(_r),'alreadyApplied',true);
    end if;
    -- A NEW request needs the live link, verified, with an active patient.
    _c:=clinical_private.clinic_record_connection(_actor,_org);
    if _c.id is null or _c.state<>'verified' then raise exception using errcode='42501',message='clinic_record_connection_required'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('clinic-record:'||_c.id::text,0));
    if _action='submit_correction' then
      -- Only a signed revision this owner was actually shown can be corrected.
      select * into _note from clinical_core.clinical_notes where id=_subject and organization_id=_org and patient_record_id=_c.patient_record_id;
      if _note.id is null or _note.status not in ('signed','amended') then raise exception using errcode='42501',message='clinic_record_subject_not_disclosed'; end if;
      if not exists(select 1 from clinical_core.clinic_record_copy_items i join clinical_core.clinic_record_copies cp on cp.id=i.copy_id
          where cp.owner_person_id=_actor and cp.organization_id=_org and i.record_kind='clinical_note' and i.record_id=_subject and i.revision=_subject_rev) then
        raise exception using errcode='42501',message='clinic_record_subject_not_disclosed'; end if;
    end if;
    -- One open request per kind: close the named open one first (its successor
    -- is recorded before it exists; the key is deferred), or refuse.
    select * into _prev from clinical_core.clinic_record_requests where connection_id=_c.id and kind=case when _action='submit_copy' then 'copy' else 'correction' end
      and status in ('submitted','in_review') for update;
    if _prev.id is not null then
      if _action='submit_copy' and (_request->>'supersedes')::uuid=_prev.id then
        _s:=_prev.status;
        update clinical_core.clinic_record_requests set status='superseded',superseded_by=_id,revision=revision+1,updated_at=clock_timestamp() where id=_prev.id returning * into _prev;
      else
        raise exception using errcode='40001',message='clinic_record_open';
      end if;
    end if;
    insert into clinical_core.clinic_record_requests(id,organization_id,patient_record_id,connection_id,owner_person_id,kind,sections,
      subject_kind,subject_id,subject_revision,reason_code,statement,input_sha256)
      values(_id,_org,_c.patient_record_id,_c.id,_actor,case when _action='submit_copy' then 'copy' else 'correction' end,
        coalesce(_sections,'{}'),case when _action='submit_correction' then 'clinical_note' end,_subject,_subject_rev,_reason_code,
        case when _action='submit_correction' then _reason end,_input_sha) returning * into _r;
    perform clinical_private.clinic_record_event(_r,_actor,'consumer','submitted',null,'submitted',null,null,null,
      jsonb_build_object('sections',to_jsonb(_r.sections),'supersedes',_prev.id));
    perform clinical_private.clinic_record_audit(_org,_actor,'clinic_record.request_submitted',_r.id,_r.patient_record_id,
      'Clinic record request submitted','consent_management',jsonb_build_object('kind',_r.kind,'sections',to_jsonb(_r.sections)));
    if _prev.id is not null then
      perform clinical_private.clinic_record_event(_prev,_actor,'consumer','superseded',_s,'superseded',null,null,null,jsonb_build_object('supersededBy',_r.id));
      perform clinical_private.clinic_record_audit(_org,_actor,'clinic_record.request_superseded',_prev.id,_prev.patient_record_id,
        'Clinic record request superseded by a newer request','consent_management',jsonb_build_object('superseded_by',_r.id));
    end if;
    return jsonb_build_object('action',_action,'request',clinical_private.clinic_record_json(_r),'alreadyApplied',false);
  end if;

  if _action='get' then
    begin _id:=(_request->>'requestId')::uuid; exception when others then raise exception using errcode='22023',message='clinic_record_invalid'; end;
    _r:=clinical_private.clinic_record_owned(_actor,_org,_id,false);
    select * into _copy_row from clinical_core.clinic_record_copies where request_id=_r.id;
    return jsonb_build_object('action','get','request',clinical_private.clinic_record_json(_r),
      'events',clinical_private.clinic_record_events_json(_r.id),
      'copy',case when _copy_row.id is null then null else jsonb_build_object('copyId',_copy_row.id,'asOf',_copy_row.as_of,
        'manifest',_copy_row.manifest,'manifestSha256',_copy_row.manifest_sha256,'itemCount',_copy_row.item_count,'byteTotal',_copy_row.byte_total) end);
  end if;

  if _action='withdraw' then
    begin _id:=(_request->>'requestId')::uuid; _expected:=(_request->>'expectedRevision')::integer;
    exception when others then raise exception using errcode='22023',message='clinic_record_invalid'; end;
    _r:=clinical_private.clinic_record_owned(_actor,_org,_id,true);
    if _r.status='withdrawn' then return jsonb_build_object('action','withdraw','request',clinical_private.clinic_record_json(_r),'alreadyApplied',true); end if;
    if _r.status not in ('submitted','in_review') then raise exception using errcode='40001',message='clinic_record_conflict'; end if;
    if _expected is distinct from _r.revision then raise exception using errcode='40001',message='clinic_record_conflict'; end if;
    _s:=_r.status;
    update clinical_core.clinic_record_requests set status='withdrawn',revision=revision+1,updated_at=clock_timestamp() where id=_r.id returning * into _r;
    perform clinical_private.clinic_record_event(_r,_actor,'consumer','withdrawn',_s,'withdrawn',null,null,null,'{}'::jsonb);
    perform clinical_private.clinic_record_audit(_org,_actor,'clinic_record.request_withdrawn',_r.id,_r.patient_record_id,'Clinic record request withdrawn','consent_management','{}'::jsonb);
    return jsonb_build_object('action','withdraw','request',clinical_private.clinic_record_json(_r),'alreadyApplied',false);
  end if;

  if _action='read_copy' then
    begin _id:=(_request->>'requestId')::uuid; _limit:=coalesce((_request->>'limit')::integer,25);
      _after:=_request->'after';
    exception when others then raise exception using errcode='22023',message='clinic_record_invalid'; end;
    _s:=_request->>'section';
    if _limit<1 or _limit>50 or _s is null or _s not in ('signed_notes','telehealth_visits','lab_observations')
      or (_after is not null and jsonb_typeof(_after)<>'number') then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
    _r:=clinical_private.clinic_record_owned(_actor,_org,_id,false);
    select * into _copy_row from clinical_core.clinic_record_copies where request_id=_r.id;
    if _copy_row.id is null or _r.status<>'fulfilled' then raise exception using errcode='P0002',message='clinic_record_not_found'; end if;
    if not exists(select 1 from jsonb_array_elements(_copy_row.manifest->'sections') x where x->>'section'=_s and (x->>'included')::boolean) then
      raise exception using errcode='22023',message='clinic_record_invalid'; end if;
    -- Keyset by sequence, bounded by count and by bytes (RDS Data API rows).
    _rows:='[]'::jsonb; _bytes:=0; _n:=0;
    for _item in select * from clinical_core.clinic_record_copy_items where copy_id=_copy_row.id and section=_s
        and (_after is null or seq>(_after#>>'{}')::integer) order by seq limit _limit loop
      exit when _n>0 and _bytes+_item.byte_length>262144;
      _rows:=_rows||jsonb_build_object('seq',_item.seq,'recordKind',_item.record_kind,'recordId',_item.record_id,'revision',_item.revision,
        'payloadText',_item.payload_text,'payloadSha256',_item.payload_sha256,'byteLength',_item.byte_length);
      _bytes:=_bytes+_item.byte_length; _n:=_n+1;
    end loop;
    perform clinical_private.clinic_record_audit(_org,_actor,'clinic_record.copy_read',_r.id,_r.patient_record_id,'Clinic record copy page read','consent_management',
      jsonb_build_object('copy_id',_copy_row.id,'section',_s,'items',_n));
    return jsonb_build_object('action','read_copy','requestId',_r.id,'copyId',_copy_row.id,'section',_s,'asOf',_copy_row.as_of,
      'items',_rows,'next',case when _n>0 and exists(select 1 from clinical_core.clinic_record_copy_items where copy_id=_copy_row.id and section=_s
        and seq>(_rows->-1->>'seq')::integer) then (_rows->-1->'seq') else null end);
  end if;

  -- ====================================================== workforce actions
  if _action='queue' then
    begin _limit:=coalesce((_request->>'limit')::integer,25); _after:=_request->'after';
    exception when others then raise exception using errcode='22023',message='clinic_record_invalid'; end;
    _s:=_request->>'status';
    if _limit<1 or _limit>100 or (_s is not null and _s not in ('submitted','in_review','fulfilled','refused','withdrawn','superseded'))
      or (_after is not null and (jsonb_typeof(_after)<>'object' or jsonb_typeof(_after->'submittedAt') is distinct from 'string' or jsonb_typeof(_after->'requestId') is distinct from 'string')) then
      raise exception using errcode='22023',message='clinic_record_invalid'; end if;
    select coalesce(jsonb_agg(clinical_private.clinic_record_json(r)||jsonb_build_object('patientRecordId',r.patient_record_id) order by r.submitted_at, r.id),'[]'::jsonb) into _rows
      from (select * from clinical_core.clinic_record_requests q where q.organization_id=_org and (_s is null or q.status=_s)
        and (_after is null or (q.submitted_at,q.id)>((_after->>'submittedAt')::timestamptz,(_after->>'requestId')::uuid))
        order by q.submitted_at, q.id limit _limit) r;
    return jsonb_build_object('action','queue','requests',_rows,'next',case when jsonb_array_length(_rows)=_limit
      then jsonb_build_object('submittedAt',_rows->-1->>'submittedAt','requestId',_rows->-1->>'requestId') else null end);
  end if;

  if _action in ('review','begin_review','fulfill','refuse','amend','decline') then
    begin _id:=(_request->>'requestId')::uuid; exception when others then raise exception using errcode='22023',message='clinic_record_invalid'; end;
    if _action='review' then
      select * into _r from clinical_core.clinic_record_requests where id=_id and organization_id=_org;
    else
      select * into _r from clinical_core.clinic_record_requests where id=_id and organization_id=_org for update;
    end if;
    if _r.id is null then raise exception using errcode='P0002',message='clinic_record_not_found'; end if;
    -- Current clinical authority over THIS patient at the moment of review or decision.
    perform clinical_private.require_clinical_patient(_org,_r.patient_record_id);
    select * into _release from clinical_private.clinic_disclosure_releases where organization_id=_org and revoked_at is null
      order by approved_at desc, id desc limit 1;
    if _action='review' then
      select * into _copy_row from clinical_core.clinic_record_copies where request_id=_r.id;
      return jsonb_build_object('action','review','request',clinical_private.clinic_record_json(_r)||jsonb_build_object('patientRecordId',_r.patient_record_id),
        'events',clinical_private.clinic_record_events_json(_r.id),
        'preview',case when _r.kind='copy' then clinical_private.clinic_record_preview(_org,_r.patient_record_id,_r.sections) else null end,
        'subjectNote',case when _r.subject_id is null then null else (select jsonb_build_object('noteId',n.id,'status',n.status,'currentVersion',n.current_version,
          'signedAt',n.signed_at,'addenda',(select count(*) from clinical_core.note_addenda a where a.note_id=n.id)) from clinical_core.clinical_notes n where n.id=_r.subject_id) end,
        'release',case when _release.id is null then null else jsonb_build_object('releaseVersion',_release.release_version,'sections',to_jsonb(_release.sections),'approvedAt',_release.approved_at) end,
        'copy',case when _copy_row.id is null then null else jsonb_build_object('copyId',_copy_row.id,'asOf',_copy_row.as_of,'manifest',_copy_row.manifest,'itemCount',_copy_row.item_count,'byteTotal',_copy_row.byte_total) end);
    end if;
    -- A decision: bound to an expected revision and a decision id. The same
    -- decision id again returns the state it produced; a stale revision or a
    -- decision on a settled request is a conflict, never a second outcome.
    begin _expected:=(_request->>'expectedRevision')::integer; _decision:=(_request->>'decisionId')::uuid;
    exception when others then raise exception using errcode='22023',message='clinic_record_invalid'; end;
    if _expected is null or _decision is null then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
    select * into _e from clinical_core.clinic_record_request_events where decision_id=_decision;
    if _e.id is not null then
      if _e.request_id<>_r.id or _e.action<>(case _action when 'begin_review' then 'review_started' when 'fulfill' then 'copy_fulfilled'
        when 'refuse' then 'refused' when 'amend' then 'amended' else 'declined' end) then
        raise exception using errcode='40001',message='clinic_record_conflict'; end if;
      return jsonb_build_object('action',_action,'request',clinical_private.clinic_record_json(_r),'alreadyApplied',true);
    end if;
    if _r.status not in ('submitted','in_review') or _expected<>_r.revision then
      raise exception using errcode='40001',message='clinic_record_conflict'; end if;
    _reason_code:=_request->>'reasonCode'; _reason:=nullif(pg_catalog.btrim(coalesce(_request->>'reason','')),'');
    if _action='begin_review' then
      if _r.status='in_review' then raise exception using errcode='40001',message='clinic_record_conflict'; end if;
      update clinical_core.clinic_record_requests set status='in_review',revision=revision+1,updated_at=clock_timestamp() where id=_r.id returning * into _r;
      perform clinical_private.clinic_record_event(_r,_actor,'workforce','review_started','submitted','in_review',null,null,_decision,'{}'::jsonb);
      perform clinical_private.clinic_record_audit(_org,_actor,'clinic_record.review_started',_r.id,_r.patient_record_id,'Clinic record request review started','clinical_data','{}'::jsonb);
      return jsonb_build_object('action',_action,'request',clinical_private.clinic_record_json(_r),'alreadyApplied',false);
    end if;
    if _action in ('refuse','decline') then
      if (_action='refuse')<>(_r.kind='copy') then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      if _reason_code is null or _reason_code not in ('not_disclosable','identity_unverified','duplicate','out_of_scope','record_accurate','other')
        or _reason is null or char_length(_reason)>2000 then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      update clinical_core.clinic_record_requests set status='refused',revision=revision+1,updated_at=clock_timestamp(),decided_at=clock_timestamp(),
        decided_by_person_id=_actor,decision_reason_code=_reason_code,decision_reason=_reason where id=_r.id returning * into _r;
      perform clinical_private.clinic_record_event(_r,_actor,'workforce',case when _action='refuse' then 'refused' else 'declined' end,
        case when _expected>1 then 'in_review' else 'submitted' end,'refused',_reason_code,_reason,_decision,'{}'::jsonb);
      perform clinical_private.clinic_record_audit(_org,_actor,case when _action='refuse' then 'clinic_record.request_refused' else 'clinic_record.correction_declined' end,
        _r.id,_r.patient_record_id,case when _action='refuse' then 'Clinic record copy request refused' else 'Clinic record correction declined; the record stands and the disagreement is recorded' end,
        'clinical_data',jsonb_build_object('reason_code',_reason_code));
      return jsonb_build_object('action',_action,'request',clinical_private.clinic_record_json(_r),'alreadyApplied',false);
    end if;
    if _action='fulfill' then
      if _r.kind<>'copy' then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      _include:=clinical_private.clinic_record_text_array(_request->'sections',8);
      _excluded:=coalesce(_request->'excluded','[]'::jsonb);
      if jsonb_typeof(_excluded)<>'array' or jsonb_array_length(_excluded)>8 then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      foreach _s in array _include loop
        if not (_s=any(_r.sections)) or not exists(select 1 from clinical_private.clinic_record_sections() where section=_s and readable) then
          raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      end loop;
      -- Every requested section is either included or excluded with a reason.
      foreach _s in array _r.sections loop
        if not (_s=any(_include)) and not exists(select 1 from jsonb_array_elements(_excluded) x where x->>'section'=_s
            and jsonb_typeof(x->'reason')='string' and char_length(x->>'reason') between 1 and 200)
          and exists(select 1 from clinical_private.clinic_record_sections() where section=_s and readable) then
          raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      end loop;
      if cardinality(_include)=0 then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      -- Disclosure authority: a live reviewed release covering every included section. None = fail closed.
      if _release.id is null or not (_include<@_release.sections) then
        raise exception using errcode='55000',message='clinic_disclosure_release_required'; end if;
      _copy:=clinical_private.clinic_record_build_copy(_r,_actor,_include,_excluded,_release);
      update clinical_core.clinic_record_requests set status='fulfilled',revision=revision+1,updated_at=clock_timestamp(),decided_at=clock_timestamp(),
        decided_by_person_id=_actor,fulfillment_id=_copy where id=_r.id returning * into _r;
      select * into _copy_row from clinical_core.clinic_record_copies where id=_copy;
      perform clinical_private.clinic_record_event(_r,_actor,'workforce','copy_fulfilled',case when _expected>1 then 'in_review' else 'submitted' end,'fulfilled',null,null,_decision,
        jsonb_build_object('copyId',_copy,'included',to_jsonb(_include),'excluded',_excluded,'itemCount',_copy_row.item_count,'byteTotal',_copy_row.byte_total,'releaseVersion',_release.release_version));
      perform clinical_private.clinic_record_audit(_org,_actor,'clinic_record.copy_fulfilled',_r.id,_r.patient_record_id,'Clinic record copy prepared for the patient','clinical_data',
        jsonb_build_object('copy_id',_copy,'included',to_jsonb(_include),'item_count',_copy_row.item_count,'release_version',_release.release_version));
      return jsonb_build_object('action',_action,'request',clinical_private.clinic_record_json(_r),'alreadyApplied',false,
        'copy',jsonb_build_object('copyId',_copy_row.id,'asOf',_copy_row.as_of,'manifest',_copy_row.manifest,'itemCount',_copy_row.item_count,'byteTotal',_copy_row.byte_total));
    end if;
    if _action='amend' then
      if _r.kind<>'correction' then raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      if jsonb_typeof(_request->'addendumReason') is distinct from 'string' or jsonb_typeof(_request->'addendumContent') is distinct from 'string'
        or char_length(pg_catalog.btrim(_request->>'addendumReason')) not between 1 and 500 or char_length(_request->>'addendumContent') not between 1 and 65536 then
        raise exception using errcode='22023',message='clinic_record_invalid'; end if;
      -- The chart's own append-only amendment: attributed, reasoned, referencing the signed version; the original never changes.
      _addendum:=clinical_core.add_note_addendum(_r.subject_id,pg_catalog.btrim(_request->>'addendumReason'),_request->>'addendumContent');
      update clinical_core.clinic_record_requests set status='fulfilled',revision=revision+1,updated_at=clock_timestamp(),decided_at=clock_timestamp(),
        decided_by_person_id=_actor,fulfillment_id=_addendum,decision_reason=_reason where id=_r.id returning * into _r;
      perform clinical_private.clinic_record_event(_r,_actor,'workforce','amended',case when _expected>1 then 'in_review' else 'submitted' end,'fulfilled',null,_reason,_decision,
        jsonb_build_object('addendumId',_addendum,'noteId',_r.subject_id,'referencedVersion',_r.subject_revision));
      perform clinical_private.clinic_record_audit(_org,_actor,'clinic_record.correction_amended',_r.id,_r.patient_record_id,'Clinic record correction accepted as an append-only addendum','clinical_data',
        jsonb_build_object('addendum_id',_addendum,'note_id',_r.subject_id));
      return jsonb_build_object('action',_action,'request',clinical_private.clinic_record_json(_r),'alreadyApplied',false,'addendumId',_addendum);
    end if;
  end if;
  raise exception using errcode='22023',message='clinic_record_invalid';
end $$;

revoke all on function clinical_core.clinic_record_request(jsonb) from public;
grant execute on function clinical_core.clinic_record_request(jsonb) to clinical_core_api;
