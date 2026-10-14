-- BLOCKED SOURCE CANDIDATE. Do not register or apply without preserving-upgrade
-- review, lifecycle review, exact-source qualification and operator approval.
-- A receipt is a clinical-record companion, not a second copy of note content.
create table clinical_private.note_save_receipts (
  request_id uuid primary key,
  organization_id uuid not null references clinical_core.organizations(id),
  encounter_id uuid not null references clinical_core.encounters(id),
  actor_person_id uuid not null references clinical_core.persons(id),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  note_id uuid not null,
  note_version integer not null check (note_version > 0),
  saved_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (note_id, note_version)
    references clinical_core.clinical_note_versions(note_id, version)
);
create index note_save_receipts_note_idx
  on clinical_private.note_save_receipts(note_id, note_version);
revoke all on clinical_private.note_save_receipts from public, clinical_core_api;

-- A repeat is the same logical save, not a new save. The unique request ID is
-- inserted in the SAME transaction as the clinical note and audit event. If
-- two callers race, one insert blocks on the other; the loser rolls its own
-- note/audit work back inside the exception subtransaction, then reads the
-- winner's receipt. A failed original transaction leaves no receipt and no note.
create or replace function clinical_core.save_note_draft_idempotent(
  _organization_id uuid, _encounter_id uuid, _note_type text, _content jsonb,
  _expected_version integer, _note_id uuid, _save_kind text, _provenance jsonb,
  _request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  _actor uuid;
  _encounter clinical_core.encounters%rowtype;
  _receipt clinical_private.note_save_receipts%rowtype;
  _result jsonb;
  _fingerprint text;
begin
  if _request_id is null then
    raise exception using errcode='22023', message='note_save_request_invalid';
  end if;
  select * into _encounter from clinical_core.encounters
    where id=_encounter_id and deleted_at is null;
  if not found then
    raise exception using errcode='P0002', message='encounter_not_found';
  end if;
  _actor := clinical_private.require_clinical_patient(
    _organization_id, _encounter.patient_record_id);
  if _encounter.organization_id<>_organization_id then
    raise exception using errcode='42501', message='encounter_documentation_refused';
  end if;
  _fingerprint := pg_catalog.encode(public.digest(pg_catalog.convert_to(
    jsonb_build_object(
      'organization_id',_organization_id,'encounter_id',_encounter_id,
      'actor_person_id',_actor,'note_type',_note_type,'content',_content,
      'expected_version',_expected_version,'note_id',_note_id,
      'save_kind',_save_kind,'provenance',_provenance
    )::text,'UTF8'),'sha256'),'hex');
  select * into _receipt from clinical_private.note_save_receipts
    where request_id=_request_id;
  if found then
    if _receipt.organization_id<>_organization_id
      or _receipt.encounter_id<>_encounter_id
      or _receipt.actor_person_id<>_actor
      or _receipt.request_sha256<>_fingerprint then
      raise exception using errcode='42501', message='note_save_request_mismatch';
    end if;
    return jsonb_build_object('note_id',_receipt.note_id,
      'version',_receipt.note_version,'saved_at',_receipt.saved_at,
      'status','draft','replayed',true);
  end if;
  begin
    _result := clinical_core.save_note_draft(
      _organization_id,_encounter_id,_note_type,_content,_expected_version,
      _note_id,_save_kind,_provenance);
    insert into clinical_private.note_save_receipts(
      request_id,organization_id,encounter_id,actor_person_id,request_sha256,
      note_id,note_version,saved_at)
    values (_request_id,_organization_id,_encounter_id,_actor,_fingerprint,
      (_result->>'note_id')::uuid,(_result->>'version')::integer,
      (_result->>'saved_at')::timestamptz);
    return _result || jsonb_build_object('replayed',false);
  exception when unique_violation then
    -- This exception block rolls the losing save, including its audit event,
    -- back to its implicit savepoint. A different uniqueness error is re-raised.
    select * into _receipt from clinical_private.note_save_receipts
      where request_id=_request_id;
    if not found then raise; end if;
    if _receipt.organization_id<>_organization_id
      or _receipt.encounter_id<>_encounter_id
      or _receipt.actor_person_id<>_actor
      or _receipt.request_sha256<>_fingerprint then
      raise exception using errcode='42501', message='note_save_request_mismatch';
    end if;
    return jsonb_build_object('note_id',_receipt.note_id,
      'version',_receipt.note_version,'saved_at',_receipt.saved_at,
      'status','draft','replayed',true);
  end;
end $$;

-- A read of the exact request receipt is an authorized settlement probe, not
-- proof that a missing receipt can never arrive later. Callers must treat an
-- absent receipt as unconfirmed and never infer that the write failed.
create or replace function clinical_core.get_note_save_receipt(
  _organization_id uuid, _encounter_id uuid, _request_id uuid
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  _actor uuid;
  _encounter clinical_core.encounters%rowtype;
  _receipt clinical_private.note_save_receipts%rowtype;
begin
  if _request_id is null then
    raise exception using errcode='22023', message='note_save_request_invalid';
  end if;
  select * into _encounter from clinical_core.encounters
    where id=_encounter_id and deleted_at is null;
  if not found then
    raise exception using errcode='P0002', message='encounter_not_found';
  end if;
  _actor := clinical_private.require_clinical_patient(
    _organization_id,_encounter.patient_record_id);
  if _encounter.organization_id<>_organization_id then
    raise exception using errcode='42501', message='encounter_documentation_refused';
  end if;
  select * into _receipt from clinical_private.note_save_receipts
    where request_id=_request_id;
  if not found then return jsonb_build_object('state','unconfirmed'); end if;
  if _receipt.organization_id<>_organization_id
    or _receipt.encounter_id<>_encounter_id
    or _receipt.actor_person_id<>_actor then
    raise exception using errcode='42501', message='note_save_request_mismatch';
  end if;
  return jsonb_build_object('state','saved','note_id',_receipt.note_id,
    'version',_receipt.note_version,'saved_at',_receipt.saved_at);
end $$;

revoke all on function clinical_core.save_note_draft_idempotent(
  uuid,uuid,text,jsonb,integer,uuid,text,jsonb,uuid),
  clinical_core.get_note_save_receipt(uuid,uuid,uuid) from public;
grant execute on function clinical_core.save_note_draft_idempotent(
  uuid,uuid,text,jsonb,integer,uuid,text,jsonb,uuid),
  clinical_core.get_note_save_receipt(uuid,uuid,uuid) to clinical_core_api;
