-- Distinct blocked source successor of exact clinic-record-privacy/4 (116).
-- Historical candidates and their release identities are unchanged. No seed,
-- provider authority, consent approval, deployment or PHI activation.
-- Private table ACLs and FORCE RLS remain. Only the table-owning migrator may
-- read keys and read/insert transfer receipts through existing definer paths.
create policy telehealth_admission_keys_definer_read
  on clinical_private.telehealth_admission_keys for select to clinical_core_migrator
  using (current_user=pg_catalog.pg_get_userbyid((select relowner from pg_catalog.pg_class
    where oid='clinical_private.telehealth_admission_keys'::pg_catalog.regclass)));
-- A locking SELECT also evaluates UPDATE policies. Permit only the owning
-- migrator; immutable-key guards still restrict updates to retirement only.
create policy telehealth_admission_keys_definer_lock
  on clinical_private.telehealth_admission_keys for update to clinical_core_migrator
  using (current_user=pg_catalog.pg_get_userbyid((select relowner from pg_catalog.pg_class
    where oid='clinical_private.telehealth_admission_keys'::pg_catalog.regclass)))
  with check (current_user=pg_catalog.pg_get_userbyid((select relowner from pg_catalog.pg_class
    where oid='clinical_private.telehealth_admission_keys'::pg_catalog.regclass)));
-- Reviewed key registration is an operator action, never an API role action.
create policy telehealth_admission_keys_definer_register
  on clinical_private.telehealth_admission_keys for insert to clinical_core_migrator
  with check (current_user=pg_catalog.pg_get_userbyid((select relowner from pg_catalog.pg_class
    where oid='clinical_private.telehealth_admission_keys'::pg_catalog.regclass)));
create policy telehealth_note_transfers_definer_read
  on clinical_core.telehealth_note_transfers for select to clinical_core_migrator
  using (current_user=pg_catalog.pg_get_userbyid((select relowner from pg_catalog.pg_class
    where oid='clinical_core.telehealth_note_transfers'::pg_catalog.regclass)));
create policy telehealth_note_transfers_definer_insert
  on clinical_core.telehealth_note_transfers for insert to clinical_core_migrator
  with check (current_user=pg_catalog.pg_get_userbyid((select relowner from pg_catalog.pg_class
    where oid='clinical_core.telehealth_note_transfers'::pg_catalog.regclass)));

-- Authority changes share one transaction fence with transfers. The fence is
-- acquired only for authority-bearing updates/deletes, not ordinary names,
-- appointment times or every clinical write. A shared transfer lock permits
-- concurrent transfers; the short authority mutation takes the exclusive lock.
-- A single namespace avoids cross-organization identity enumeration or new
-- clinical table UPDATE policies merely to perform a locking SELECT.
create function clinical_private.fence_telehealth_authority_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    -- Branch before referencing each record's fields; a generic trigger record
    -- must not prepare an expression containing another table's columns.
    if tg_table_name='organization_memberships' then
      if (new.organization_id,new.person_id,new.role,new.status) is not distinct from
        (old.organization_id,old.person_id,old.role,old.status) then return new; end if;
    elsif tg_table_name='identities' then
      if (new.person_id,new.identity_pool,new.identity_subject,new.production_bound) is not distinct from
        (old.person_id,old.identity_pool,old.identity_subject,old.production_bound) then return new; end if;
    elsif tg_table_name='patient_records' then
      if (new.id,new.organization_id,new.status,new.deleted_at) is not distinct from
        (old.id,old.organization_id,old.status,old.deleted_at) then return new; end if;
    elsif tg_table_name='appointments' then
      if (new.id,new.organization_id,new.patient_record_id,new.practitioner_person_id,new.appointment_type,new.status,new.deleted_at) is not distinct from
        (old.id,old.organization_id,old.patient_record_id,old.practitioner_person_id,old.appointment_type,old.status,old.deleted_at) then return new; end if;
    end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('telehealth-current-authority-v1',0));
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function clinical_private.fence_telehealth_authority_change() from public,clinical_core_api;
create trigger telehealth_membership_authority_fence before update or delete on clinical_core.organization_memberships
  for each row execute function clinical_private.fence_telehealth_authority_change();
create trigger telehealth_identity_authority_fence before update or delete on clinical_core.identities
  for each row execute function clinical_private.fence_telehealth_authority_change();
create trigger telehealth_patient_authority_fence before update or delete on clinical_core.patient_records
  for each row execute function clinical_private.fence_telehealth_authority_change();
create trigger telehealth_appointment_authority_fence before update or delete on clinical_core.appointments
  for each row execute function clinical_private.fence_telehealth_authority_change();

-- Hold the registered admission key through transaction completion. A retirement
-- that wins first refuses the transfer; a transfer that holds the key first
-- finishes before retirement can commit. No key, consent or review is seeded.
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
    where key_id=(_a->>'key_id') and retired_at is null for share;
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
  -- Draft/FK/trigger work can wait after entry authorization. Take the shared
  -- authority fence after that work, then read fresh authority. A revocation
  -- which committed first rolls back all tentative writes; a later authority
  -- change cannot commit before this transaction releases the shared fence.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('telehealth-current-authority-v1',0));
  _actor := clinical_private.require_clinical_patient(_organization_id,_patient_id);
  select * into _appointment from clinical_core.appointments where id=_appointment_id;
  if not found or _appointment.deleted_at is not null or _appointment.organization_id<>_organization_id
    or _appointment.patient_record_id is distinct from _patient_id or _appointment.appointment_type<>'telehealth' then
    raise exception using errcode='42501',message='telehealth_transfer_refused'; end if;
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
