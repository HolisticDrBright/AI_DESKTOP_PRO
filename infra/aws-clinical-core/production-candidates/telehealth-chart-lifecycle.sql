-- Telehealth chart integration and retained-record authority.
--
-- Forward source candidate only. It becomes the 113th migration of a distinct
-- artifact whose first 112 files are byte-identical to the exact
-- telehealth-consent-copy release (scripts/telehealth-chart-lifecycle-candidate.mjs
-- pins the parent ledger and this file's SHA-256). It alters no historical
-- migration, seeds no rows, approves nothing and is not an instruction to apply.
--
-- What it adds, and why it is shaped this way:
--
--   1. clinical_core.telehealth_note_transfers — the AUTHORITATIVE receipt that
--      a reviewed (signed) telehealth visit note was placed into the chart as an
--      unsigned draft. The telehealth visit record lives in DynamoDB and the
--      chart lives here; the two stores are never written atomically. This row
--      is the single-store receipt the other store reconciles against: a lost
--      response is settled by reading it back, never by a second write. One
--      transfer per (organization, appointment): repeating the same transfer
--      returns the original destination; a different source revision or digest
--      is refused rather than producing a second chart note.
--
--   2. clinical_core.transfer_telehealth_note — binds every transfer server-side
--      to the organization, the patient record, the telehealth appointment (its
--      row must carry that patient and that organization), the practitioner's
--      clinical-record authority, the exact source revision and digest, and the
--      destination encounter. The chart note is created through the existing
--      save_note_draft path, so it lands as an UNSIGNED DRAFT under the chart's
--      own review/signature workflow: a visit signature never becomes a chart
--      signature, and action items arrive as text, never as orders. The complete
--      provider summary, the reviewed sections, the practitioner text and the
--      source provenance are kept as distinct data in source_payload.
--
--   3. clinical_core.get_telehealth_record_authority — the reviewed
--      clinical-record read path for a completed visit: the same
--      require_clinical_patient authority the chart's timeline and overview use
--      (active membership, a clinical role, an active patient record in THIS
--      organization). It does not depend on the calendar still returning the
--      appointment, so removing or moving an appointment does not erase access
--      to a retained clinical record; it does not grant every member every note
--      (staff-only roles and foreign clinics are refused by the same function).
--      It also reports an active recording legal hold on the patient so the
--      telehealth record's lifecycle status can say "held" truthfully.
--
--   4. Vocabulary: provenance ref_type 'telehealth_visit' (the chart draft names
--      the visit it came from) and audit action 'telehealth.note_transferred'.
--      Both constraint lists are restated in full; nothing is removed.
--
--   5. Source admission (clinical_private.telehealth_admission_keys). The chart
--      RPC is callable by any authenticated workforce caller through the
--      desktop's data-compatibility route, so the caller's say-so about a
--      "signed visit" proves nothing. transfer_telehealth_note therefore
--      requires an ADMISSION: a document the telehealth boundary issues only
--      after it has verified the signed visit record and the caller's
--      retained-record authority, signed with an HMAC key the boundary holds
--      (Secrets Manager) and this database holds (this private table, readable
--      by no API role). The admission binds the organization, patient,
--      appointment, practitioner (as this database resolves the caller),
--      intent, source custody and record version, signed source revision and
--      digest, and the SHA-256 of the exact content, payload and provenance
--      bytes; it carries an issue time and a short expiry. The function
--      recomputes every hash over the bytes it received and compares every
--      binding; a general API caller cannot mint or substitute one, and the
--      browser never sees the key. The key table is empty in this artifact —
--      no key is seeded; until an operator registers one, every transfer is
--      refused as unavailable. Retiring a key revokes every admission under it.
--
--   6. Receipt reads are bound to the requested patient: a transfer is reported
--      only when it belongs to the organization, the appointment AND the
--      independently authorized patient; an appointment that carries another
--      patient is reported as "not this patient's" and nothing more.
--
--   7. Patient identity of an appointment that carries clinical records (an
--      encounter or a transfer) is immutable: there is no governed operation
--      that re-patients an appointment, and a raw update is refused by name
--      (appointment_patient_identity_immutable) before the foreign keys would.
--      The supported correction is a status correction of the original
--      appointment (correct_appointment_status, with reason and audit) plus a
--      successor appointment for the right patient; the original record stays
--      under the patient it was recorded for.

-- ---------------------------------------------------------------- 1. ledger

create table clinical_core.telehealth_note_transfers (
  id uuid primary key,
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  appointment_id uuid not null,
  source_note_revision integer not null check (source_note_revision > 0),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  source_payload jsonb not null check (jsonb_typeof(source_payload) = 'object'),
  source_payload_sha256 text not null check (source_payload_sha256 ~ '^[0-9a-f]{64}$'),
  encounter_id uuid not null,
  note_id uuid not null references clinical_core.clinical_notes(id),
  note_version integer not null check (note_version > 0),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  transferred_by_person_id uuid not null references clinical_core.persons(id),
  admission jsonb not null check (jsonb_typeof(admission) = 'object'),
  admission_sha256 text not null check (admission_sha256 ~ '^[0-9a-f]{64}$'),
  admission_key_id text not null,
  admitted_at timestamptz not null,
  admission_expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (organization_id, appointment_id),
  foreign key (appointment_id, organization_id, patient_record_id)
    references clinical_core.appointments(id, organization_id, patient_record_id),
  foreign key (encounter_id, organization_id, patient_record_id)
    references clinical_core.encounters(id, organization_id, patient_record_id)
);
create index telehealth_note_transfers_patient_idx
  on clinical_core.telehealth_note_transfers(organization_id, patient_record_id, created_at desc);
alter table clinical_core.telehealth_note_transfers enable row level security;
alter table clinical_core.telehealth_note_transfers force row level security;
revoke all on clinical_core.telehealth_note_transfers from public, clinical_core_api;
create trigger telehealth_note_transfers_append_only before update or delete on clinical_core.telehealth_note_transfers
  for each row execute function clinical_private.block_update_delete();

-- ------------------------------------------------- 1b. admission key custody

-- Empty in this artifact. An operator registers a key (the same bytes the
-- telehealth boundary reads from Secrets Manager) with a privileged
-- connection; no API role can read, insert, update or delete here. A key is
-- never rewritten: it can only be retired, which revokes every admission
-- signed under it.
create table clinical_private.telehealth_admission_keys (
  key_id text primary key check (key_id ~ '^[a-z0-9][a-z0-9-]{7,63}$'),
  secret bytea not null check (octet_length(secret) >= 32),
  created_at timestamptz not null default clock_timestamp(),
  retired_at timestamptz
);
alter table clinical_private.telehealth_admission_keys enable row level security;
alter table clinical_private.telehealth_admission_keys force row level security;
revoke all on clinical_private.telehealth_admission_keys from public, clinical_core_api;
create function clinical_private.guard_telehealth_admission_key() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception using errcode='42501',message='append_only_record'; end if;
  if new.key_id<>old.key_id or new.secret<>old.secret or new.created_at<>old.created_at
    or (old.retired_at is not null and new.retired_at is distinct from old.retired_at) then
    raise exception using errcode='42501',message='append_only_record'; end if;
  return new;
end $$;
revoke all on function clinical_private.guard_telehealth_admission_key() from public, clinical_core_api;
create trigger telehealth_admission_keys_guard before update or delete on clinical_private.telehealth_admission_keys
  for each row execute function clinical_private.guard_telehealth_admission_key();
alter table clinical_core.telehealth_note_transfers
  add constraint telehealth_note_transfers_admission_key_id_fkey
  foreign key (admission_key_id) references clinical_private.telehealth_admission_keys(key_id);

-- ------------------------------------- 1c. appointment patient identity guard

create function clinical_private.guard_appointment_patient_identity() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.patient_record_id is distinct from old.patient_record_id and (
    exists(select 1 from clinical_core.encounters e where e.appointment_id=old.id)
    or exists(select 1 from clinical_core.telehealth_note_transfers t where t.appointment_id=old.id)) then
    raise exception using errcode='42501',message='appointment_patient_identity_immutable';
  end if;
  return new;
end $$;
revoke all on function clinical_private.guard_appointment_patient_identity() from public, clinical_core_api;
create trigger appointments_patient_identity_guard before update of patient_record_id on clinical_core.appointments
  for each row execute function clinical_private.guard_appointment_patient_identity();

-- ---------------------------------------------------------- 2. vocabularies

alter table clinical_core.note_provenance_refs drop constraint note_provenance_refs_ref_type_check;
alter table clinical_core.note_provenance_refs add constraint note_provenance_refs_ref_type_check check (ref_type in
  ('appointment','encounter','lab_observation','lab_document','patient_form','chart_item',
   'practitioner_entered','transcript','differential_question','lens_evaluation','telehealth_visit'));

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
  'sync.inbound_rejected','sync.inbound_correction_recorded','sync.conflict_resolved','sync.provider_registered',
  'sync.provider_reviewed','protocol.interaction_reviewed','protocol_template.created','protocol_template.approved',
  'protocol_template.archived','hypothesis.accepted','hypothesis.rejected','hypothesis.needs_data',
  'lens.question_accepted','lens.question_asked','lens.question_deferred','lens.question_skipped',
  'lens.question_dismissed','lens.question_answered','lens.answer_corrected','lens.question_added_to_note',
  'lens.safety_block_reviewed','knowledge.pathway_draft_created','knowledge.pathway_draft_updated',
  'knowledge.pathway_approved','knowledge.import_staged','knowledge.import_item_applied',
  'knowledge.import_item_rejected','knowledge.import_conflict_resolved','knowledge.research_review_recorded',
  'knowledge.import_committed','knowledge.import_cancelled','telehealth.note_transferred'));

-- --------------------------------------------- 3. retained-record authority

create or replace function clinical_core.get_telehealth_record_authority(
  _organization_id uuid, _patient_id uuid, _appointment_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _appointment clinical_core.appointments%rowtype;
  _transfer clinical_core.telehealth_note_transfers%rowtype; _note clinical_core.clinical_notes%rowtype;
begin
  -- Membership, a clinical role and an active patient record in THIS organization,
  -- exactly as the chart's own reads require. Anything short of that raises.
  _actor := clinical_private.require_clinical_patient(_organization_id,_patient_id);
  if _appointment_id is null then raise exception using errcode='22023',message='appointment_required'; end if;
  -- The appointment is reported, never required: a retained record outlives its calendar entry.
  select * into _appointment from clinical_core.appointments
    where id=_appointment_id and organization_id=_organization_id;
  -- The receipt is THIS patient's or it is not reported: organization, appointment
  -- AND the independently authorized patient. Another patient's transfer on the
  -- same appointment id is never adopted, displayed or described.
  select * into _transfer from clinical_core.telehealth_note_transfers
    where organization_id=_organization_id and appointment_id=_appointment_id and patient_record_id=_patient_id;
  if _transfer.id is not null then
    select * into _note from clinical_core.clinical_notes
      where id=_transfer.note_id and organization_id=_organization_id and patient_record_id=_patient_id;
  end if;
  return jsonb_build_object(
    'authorized',true,'actor_person_id',_actor,'patient_record_id',_patient_id,
    'appointment',case when _appointment.id is null then null
      -- Another patient's appointment: its existence and that it is not this patient's, nothing else.
      when _appointment.patient_record_id is distinct from _patient_id then jsonb_build_object('id',_appointment.id,'patient_matches',false)
      else jsonb_build_object(
      'id',_appointment.id,'status',_appointment.status,'deleted',_appointment.deleted_at is not null,
      'appointment_type',_appointment.appointment_type,'patient_matches',true,
      'practitioner_person_id',_appointment.practitioner_person_id) end,
    'transfer',case when _transfer.id is null then null else jsonb_build_object(
      'transfer_id',_transfer.id,'encounter_id',_transfer.encounter_id,'note_id',_transfer.note_id,
      'note_version',_transfer.note_version,'source_note_revision',_transfer.source_note_revision,
      'source_digest',_transfer.source_digest,'content_sha256',_transfer.content_sha256,
      'transferred_at',_transfer.created_at,'transferred_by_person_id',_transfer.transferred_by_person_id,
      'note_status',_note.status,'note_current_version',_note.current_version,
      'note_deleted',_note.deleted_at is not null) end,
    'legal_hold',exists(select 1 from clinical_private.recording_legal_holds h
      where h.organization_id=_organization_id and h.patient_record_id=_patient_id and h.released_at is null));
end $$;

-- ------------------------------------------------------------- 4. transfer

-- Admission contract (telehealth-chart-admission/1): the boundary issues a JSON
-- object with exactly these members — contract, intent ('chart_draft'),
-- key_id, transfer_id, organization_id, patient_record_id, appointment_id,
-- practitioner_person_id, source_custody ('telehealth-visit-record'),
-- source_record_version, source_revision, source_digest, content_sha256,
-- payload_sha256, provenance_sha256, issued_at, expires_at — and signs the
-- exact UTF-8 bytes of that object with HMAC-SHA256 under key_id. The content,
-- payload and provenance arrive as the exact text the boundary hashed.
create or replace function clinical_core.transfer_telehealth_note(
  _organization_id uuid, _transfer_id uuid, _appointment_id uuid, _patient_id uuid,
  _source_revision integer, _source_digest text, _content text, _source_payload text, _provenance text,
  _admission text, _admission_signature text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid; _appointment clinical_core.appointments%rowtype;
  _existing clinical_core.telehealth_note_transfers%rowtype; _encounter_id uuid; _saved jsonb;
  _content_json jsonb; _payload_json jsonb; _provenance_json jsonb; _a jsonb;
  _key clinical_private.telehealth_admission_keys%rowtype; _expected_signature text;
  _a_transfer uuid; _a_org uuid; _a_patient uuid; _a_appointment uuid; _a_practitioner uuid;
  _a_revision integer; _a_issued timestamptz; _a_expires timestamptz;
  _payload_sha text; _content_sha text; _admission_sha text; _now timestamptz;
begin
  -- Current clinical authority at the moment of the write: membership, a clinical
  -- role and an active patient record in THIS organization.
  _actor := clinical_private.require_clinical_patient(_organization_id,_patient_id);
  if _transfer_id is null or _appointment_id is null or _source_revision is null or _source_revision<1
    or _source_digest is null or _source_digest !~ '^[0-9a-f]{64}$'
    or _content is null or pg_catalog.octet_length(_content)>262144
    or _source_payload is null or pg_catalog.octet_length(_source_payload)>524288
    or _provenance is null or pg_catalog.octet_length(_provenance)>65536
    or _admission is null or pg_catalog.octet_length(_admission)>8192
    or _admission_signature is null or _admission_signature !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='telehealth_transfer_invalid'; end if;
  begin
    _content_json := _content::jsonb; _payload_json := _source_payload::jsonb;
    _provenance_json := _provenance::jsonb; _a := _admission::jsonb;
    if jsonb_typeof(_content_json)<>'object' or jsonb_typeof(_payload_json)<>'object'
      or jsonb_typeof(_provenance_json)<>'array' or jsonb_typeof(_a)<>'object' then
      raise exception using errcode='22023',message='telehealth_transfer_invalid'; end if;
    _a_transfer := (_a->>'transfer_id')::uuid; _a_org := (_a->>'organization_id')::uuid;
    _a_patient := (_a->>'patient_record_id')::uuid; _a_appointment := (_a->>'appointment_id')::uuid;
    _a_practitioner := (_a->>'practitioner_person_id')::uuid; _a_revision := (_a->>'source_revision')::integer;
    _a_issued := (_a->>'issued_at')::timestamptz; _a_expires := (_a->>'expires_at')::timestamptz;
  exception when others then
    raise exception using errcode='22023',message='telehealth_transfer_invalid';
  end;
  -- One transfer per appointment is decided under a lock, so two concurrent
  -- attempts (any order) resolve to one chart note.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('telehealth-transfer:'||_appointment_id::text,0));
  -- The first check authorizes entry, not waiting indefinitely. Resolve the
  -- actor again after serialization, then use wall-clock time after all work
  -- preceding the admission check. Transaction/statement start time is stale.
  _actor := clinical_private.require_clinical_patient(_organization_id,_patient_id);
  -- Source admission: the boundary's signature over the exact admission bytes,
  -- under a registered, unretired key. No key at all = the feature is not
  -- provisioned here; an unknown, retired or wrong key = refused.
  if not exists(select 1 from clinical_private.telehealth_admission_keys where retired_at is null) then
    raise exception using errcode='55000',message='telehealth_admission_unavailable'; end if;
  select * into _key from clinical_private.telehealth_admission_keys
    where key_id=(_a->>'key_id') and retired_at is null;
  if not found then raise exception using errcode='42501',message='telehealth_admission_refused'; end if;
  _expected_signature := pg_catalog.encode(public.hmac(pg_catalog.convert_to(_admission,'UTF8'),_key.secret,'sha256'),'hex');
  if _expected_signature<>pg_catalog.lower(_admission_signature) then
    raise exception using errcode='42501',message='telehealth_admission_refused'; end if;
  -- Every binding, recomputed here from what was received: a valid signature
  -- over a different transfer, subject, source, practitioner or bytes is refused.
  _content_sha := pg_catalog.encode(public.digest(pg_catalog.convert_to(_content,'UTF8'),'sha256'),'hex');
  _payload_sha := pg_catalog.encode(public.digest(pg_catalog.convert_to(_source_payload,'UTF8'),'sha256'),'hex');
  _now := clock_timestamp();
  if (select count(*) from jsonb_object_keys(_a))<>17
    or _a->>'contract' is distinct from 'telehealth-chart-admission/1' or _a->>'intent' is distinct from 'chart_draft'
    or _a->>'source_custody' is distinct from 'telehealth-visit-record'
    or jsonb_typeof(_a->'source_record_version') is distinct from 'number'
    or _a_transfer is distinct from _transfer_id or _a_org is distinct from _organization_id
    or _a_patient is distinct from _patient_id or _a_appointment is distinct from _appointment_id
    or _a_practitioner is distinct from _actor
    or _a_revision is distinct from _source_revision or _a->>'source_digest' is distinct from _source_digest
    or _a->>'content_sha256' is distinct from _content_sha or _a->>'payload_sha256' is distinct from _payload_sha
    or _a->>'provenance_sha256' is distinct from pg_catalog.encode(public.digest(pg_catalog.convert_to(_provenance,'UTF8'),'sha256'),'hex')
    or _a_issued is null or _a_expires is null or _a_issued>_now+interval '5 minutes'
    or _a_expires<=_now or _a_expires-_a_issued>interval '1 hour' then
    raise exception using errcode='42501',message='telehealth_admission_mismatch'; end if;
  select * into _appointment from clinical_core.appointments where id=_appointment_id and deleted_at is null;
  if not found then raise exception using errcode='P0002',message='appointment_not_found'; end if;
  if _appointment.organization_id<>_organization_id or _appointment.patient_record_id is distinct from _patient_id
    or _appointment.appointment_type<>'telehealth' then
    raise exception using errcode='42501',message='telehealth_transfer_refused'; end if;
  select * into _existing from clinical_core.telehealth_note_transfers
    where organization_id=_organization_id and appointment_id=_appointment_id and patient_record_id=_patient_id;
  if found then
    -- A retry of the exact admitted source returns the original destination receipt.
    if _existing.source_note_revision=_source_revision and _existing.source_digest=_source_digest then
      return jsonb_build_object('transfer_id',_existing.id,'encounter_id',_existing.encounter_id,
        'note_id',_existing.note_id,'note_version',_existing.note_version,'content_sha256',_existing.content_sha256,
        'created',false,'transferred_at',_existing.created_at);
    end if;
    raise exception using errcode='40001',message='telehealth_transfer_source_changed';
  end if;
  if exists(select 1 from clinical_core.telehealth_note_transfers where id=_transfer_id) then
    raise exception using errcode='22023',message='telehealth_transfer_id_reused'; end if;
  -- Destination: the appointment's open encounter, else its most recent completed
  -- one, else a new telehealth encounter for this appointment (start_encounter
  -- re-verifies the patient binding).
  select id into _encounter_id from clinical_core.encounters
    where appointment_id=_appointment_id and organization_id=_organization_id and patient_record_id=_patient_id
      and deleted_at is null and status in ('in_progress','completed')
    order by (status='in_progress') desc, coalesce(started_at,created_at) desc limit 1;
  if _encounter_id is null then
    _encounter_id := clinical_core.start_encounter(_organization_id,_patient_id,'telehealth',_appointment_id);
  end if;
  -- The chart's own draft path: version 1, status draft, provenance recorded,
  -- note.draft_created audited. Nothing here signs.
  _now := clock_timestamp();
  if _a_expires<=_now then
    raise exception using errcode='42501',message='telehealth_admission_mismatch'; end if;
  _saved := clinical_core.save_note_draft(_organization_id,_encounter_id,'narrative',_content_json,0,null,'manual',_provenance_json);
  -- Encounter/note authority checks, row locks and triggers may also wait.
  -- An expiry here raises in the same transaction and rolls back their writes.
  _now := clock_timestamp();
  if _a_expires<=_now then
    raise exception using errcode='42501',message='telehealth_admission_mismatch'; end if;
  _admission_sha := pg_catalog.encode(public.digest(pg_catalog.convert_to(_admission,'UTF8'),'sha256'),'hex');
  insert into clinical_core.telehealth_note_transfers(id,organization_id,patient_record_id,appointment_id,
    source_note_revision,source_digest,source_payload,source_payload_sha256,encounter_id,note_id,note_version,
    content_sha256,transferred_by_person_id,admission,admission_sha256,admission_key_id,admitted_at,admission_expires_at,created_at)
  values(_transfer_id,_organization_id,_patient_id,_appointment_id,_source_revision,_source_digest,_payload_json,
    _payload_sha,_encounter_id,(_saved->>'note_id')::uuid,(_saved->>'version')::integer,
    pg_catalog.encode(public.digest(pg_catalog.convert_to(_content_json::text,'UTF8'),'sha256'),'hex'),_actor,
    _a,_admission_sha,_key.key_id,_a_issued,_a_expires,_now);
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,safe_message,purpose,safe_metadata) values(_organization_id,_actor,
    'telehealth.note_transferred','clinical_note',(_saved->>'note_id')::uuid,_patient_id,
    'Telehealth visit note transferred to the chart as an unsigned draft','clinical_data',
    jsonb_build_object('transfer_id',_transfer_id,'appointment_id',_appointment_id,'encounter_id',_encounter_id,
      'source_note_revision',_source_revision,'note_version',(_saved->>'version')::integer,
      'admission_key_id',_key.key_id,'admission_sha256',_admission_sha));
  -- Even receipt/audit work can block. Do not return a successful transfer
  -- when the admission expired during that work; the exception rolls back the
  -- destination, receipt and audit together, never certifying a partial write.
  if _a_expires<=clock_timestamp() then
    raise exception using errcode='42501',message='telehealth_admission_mismatch'; end if;
  return jsonb_build_object('transfer_id',_transfer_id,'encounter_id',_encounter_id,
    'note_id',(_saved->>'note_id')::uuid,'note_version',(_saved->>'version')::integer,
    'content_sha256',pg_catalog.encode(public.digest(pg_catalog.convert_to(_content_json::text,'UTF8'),'sha256'),'hex'),
    'created',true,'transferred_at',_now);
end $$;

revoke all on function clinical_core.get_telehealth_record_authority(uuid,uuid,uuid) from public;
revoke all on function clinical_core.transfer_telehealth_note(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,text) from public;
grant execute on function clinical_core.get_telehealth_record_authority(uuid,uuid,uuid) to clinical_core_api;
grant execute on function clinical_core.transfer_telehealth_note(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,text) to clinical_core_api;
