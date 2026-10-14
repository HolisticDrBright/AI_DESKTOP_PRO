-- Unreleased production candidate: binding a purchase action for one program step to the program's CURRENT clinical
-- review (program-step-purchase/1). BLOCKED: applied nowhere, registered in no manifest, and its activation row below
-- is disabled.
--
-- Parent: the 106-migration production artifact plus, unchanged and in their documented order,
-- lab-result-transfer-v2.sql, lab-observation-attestation.sql and production-program-assignments.sql. This file reads
-- the last one's private review functions and redefines nothing it defines. It is a separately named successor so
-- the reviewed program candidate and the Fullscript consumer-action contract keep their pinned bytes. Order:
-- after production-program-assignments.sql (and independent of lab-attestation-review.sql). No historical migration,
-- ledger, IAM or custody file changes. Registration, activation evidence and execution are Codex work after review.
--
-- Why it exists. A supplement step the program shows as available can stop being safe before anyone buys it: a high
-- ferritin, or a result that disagrees with the verified one, arrives and the server's own lab-aware review now holds
-- the step. A purchase action issued against the earlier view, a V2 build that cached it, or an action id copied into
-- a later request must not reach the destination. So the purchase path reads the server's review now, at issue and
-- again at redemption, and the step must be available in it under the exact binding the person was shown:
--   owner (the consumer actor), enrollment, the exact step, the enrollment revision and the review's plan revision,
--   the care connection (clinic and patient link), the step's catalog stable id, version and target.
-- Refused: a step that is held (lab-held, held, conflicting or a duplicate), not in the current phase, stale (an older
-- enrollment revision or plan revision), superseded (another program version), withdrawn or not active, another
-- owner's, another clinic's or another link's, or bound to another catalog product or version.
--
-- What it does not do: it releases no hold, decides no clinical question, issues no action and returns no address.
-- The destination stays the consumer-action candidate's, after its own checks, and only when a reviewed purchase
-- release exists; the education-only Core release has none.

create table clinical_core.program_step_purchase_activation(
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  reviewed_by text check(reviewed_by is null or char_length(reviewed_by) between 1 and 200),
  reviewed_at timestamptz,
  check(not enabled or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null))
);
insert into clinical_core.program_step_purchase_activation(singleton,enabled) values(true,false);
revoke all on clinical_core.program_step_purchase_activation from public,clinical_core_api;

-- The consumer purchasing: active, production-bound identity in an active clinic, and the supplement-plan storage
-- consent granted now (the program candidate's own rule for any consumer program action). The step check also needs
-- both activations; the held-products guard needs neither of its own (see below).
create function clinical_private.program_step_purchaser(_require_activation boolean,_require_consent boolean) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
begin
  if _require_activation and (not exists(select 1 from clinical_core.program_step_purchase_activation where singleton and enabled)
    or not exists(select 1 from clinical_core.production_program_activation where singleton and enabled)) then
    raise exception using errcode='42501',message='program_step_purchase_disabled'; end if;
  if _actor is null or _org is null or clinical_private.claim('identity_pool') is distinct from 'consumer'
    or clinical_private.claim('purpose') is distinct from 'clinical_data'
    or clinical_private.claim('environment') is distinct from 'production-clinical'
    or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
    or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
      where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
        and i.production_bound and i.status='active' and p.status='active')
    or not exists(select 1 from clinical_core.organizations where id=_org and status='active') then
    raise exception using errcode='42501',message='program_step_refused'; end if;
  if _require_consent and clinical_private.owned_consumer_consent(_actor,'protocols_supplements') is null then
    raise exception using errcode='42501',message='consumer_storage_consent_required'; end if;
  return _actor;
end $$;
revoke all on function clinical_private.program_step_purchaser(boolean,boolean) from public;

-- The step's standing in the current review, for this actor and binding. Returns the reason it is not available, or
-- null when it is. Never a value, a range or a reading.
create function clinical_private.program_step_purchase_reason(_actor uuid,_step jsonb) returns text
language plpgsql stable security definer set search_path='' as $$
declare _org uuid:=clinical_private.organization_id(); _row clinical_core.program_assignments%rowtype;
  _connection clinical_core.patient_connections%rowtype; _review jsonb; _item jsonb; _phase jsonb; _id text:=_step->>'itemId';
begin
  select * into _row from clinical_core.program_assignments where id=(_step->>'enrollmentId')::uuid;
  -- Another owner's, another clinic's, or none: one refusal, so the answer says nothing about which.
  if _row.id is null or _row.organization_id<>_org or _row.consumer_person_id is distinct from _actor then return 'program_step_refused'; end if;
  select * into _connection from clinical_core.patient_connections where id=_row.connection_id;
  if _connection.id is null or _connection.organization_id<>_org or _connection.consumer_person_id is distinct from _actor
    or _connection.state<>'verified' or _connection.id<>(_step->>'connectionId')::uuid
    or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and organization_id=_org and status='active') then
    return 'program_step_refused'; end if;
  if _row.state='withdrawn' then return 'program_step_withdrawn'; end if;
  if _row.source_digest is distinct from _step->>'sourceDigest' then return 'program_step_superseded'; end if;
  if _row.revision::text is distinct from _step->>'assignmentRevision' then return 'program_step_stale'; end if;
  if _row.state<>'active' or _row.finished then return 'program_step_not_active'; end if;
  _phase:=_row.content->_row.phase_index;
  select value into _item from jsonb_array_elements(coalesce(_phase->'items','[]'::jsonb)) where value->>'id'=_id;
  if _item is null then return 'program_step_not_current'; end if;
  if _item->>'kind' is distinct from 'supplement' or jsonb_typeof(_item->'product'->'catalog')<>'object'
    or _item->'product'->'catalog'->>'stableId' is distinct from _step->'catalog'->>'stableId'
    or (_item->'product'->'catalog'->>'version') is distinct from (_step->'catalog'->>'version')
    or _item->'product'->'catalog'->>'target' is distinct from _step->'catalog'->>'target' then
    return 'program_step_catalog_changed'; end if;
  _review:=clinical_private.production_program_review(_row.content,clinical_private.production_program_plan_inventory(_actor),
    clinical_private.production_program_lab_readings(_actor,_org,_connection.patient_record_id));
  if _review->>'planRevision' is distinct from _step->>'planRevision' then return 'program_review_stale'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(_review->'labHolds','[]'::jsonb)) h where h.value->>'itemId'=_id) then return 'program_step_lab_held'; end if;
  if exists(select 1 from jsonb_array_elements_text(_review->'conflicts') x where x.value=_id) then return 'program_step_conflict'; end if;
  if exists(select 1 from jsonb_array_elements_text(_review->'duplicate') x where x.value=_id) then return 'program_step_duplicate'; end if;
  if not exists(select 1 from jsonb_array_elements_text(_review->'add') a where a.value=_id) then return 'program_step_held'; end if;
  return null;
end $$;
revoke all on function clinical_private.program_step_purchase_reason(uuid,jsonb) from public;

-- Is this exact step available to buy now? The binding is the one the person was shown; the answer is the server's.
create function clinical_core.program_step_purchase_check(_request jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.program_step_purchaser(true,true); _step jsonb:=_request->'step'; _reason text;
begin
  if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>4096
    or _request-array['contract','step']<>'{}'::jsonb or _request->>'contract' is distinct from 'program-step-purchase/1'
    or jsonb_typeof(_step)<>'object'
    or _step-array['enrollmentId','itemId','assignmentRevision','planRevision','sourceDigest','connectionId','catalog']<>'{}'::jsonb
    or coalesce(_step->>'enrollmentId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(_step->>'connectionId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(_step->>'itemId','') !~ '^[A-Za-z0-9_.:-]{1,160}$'
    or coalesce(_step->>'assignmentRevision','') !~ '^[0-9]{1,18}$'
    or coalesce(_step->>'planRevision','') !~ '^[A-Za-z0-9:._-]+$' or char_length(_step->>'planRevision')>300
    or coalesce(_step->>'sourceDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(_step->'catalog')<>'object' or (_step->'catalog')-array['stableId','version','target']<>'{}'::jsonb
    or coalesce(_step->'catalog'->>'stableId','') !~ '^prd_[a-z0-9][a-z0-9_-]{2,95}$'
    or jsonb_typeof(_step->'catalog'->'version')<>'number'
    or _step->'catalog'->>'target' is distinct from 'production-clinical' then
    raise exception using errcode='22023',message='program_step_purchase_invalid'; end if;
  _reason:=clinical_private.program_step_purchase_reason(_actor,_step);
  if _reason is not null then
    raise exception using errcode=case when _reason='program_step_refused' then '42501' else '40001' end,message=_reason; end if;
  return jsonb_build_object('contract','program-step-purchase/1','state','available','enrollmentId',_step->>'enrollmentId',
    'itemId',_step->>'itemId','assignmentRevision',_step->>'assignmentRevision','planRevision',_step->>'planRevision',
    'catalog',_step->'catalog');
end $$;
revoke all on function clinical_core.program_step_purchase_check(jsonb) from public;
grant execute on function clinical_core.program_step_purchase_check(jsonb) to clinical_core_api;

-- The catalog products this consumer's current programs hold: every supplement step, in an enrollment that is not
-- withdrawn, that the current review neither lists as available nor as a duplicate of the adopted plan (a duplicate is
-- already the person's own plan item, and buying their plan stays what it was). A purchase made outside the program
-- binding (an older client, a crafted request) is refused for these, so a held step cannot be bought around its hold.
-- It protects whether or not program purchases are released: with the program service itself disabled no enrollment
-- can be acted on, and the answer is the empty list rather than a refusal of every other purchase. Without the
-- supplement-plan consent there is no review to show any step available, so every supplement step of the person's
-- enrollments counts as held; products outside their programs are untouched either way.
create function clinical_core.program_held_catalog_products() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.program_step_purchaser(false,false); _org uuid:=clinical_private.organization_id(); _held text[]:='{}';
  _row clinical_core.program_assignments%rowtype; _review jsonb; _patient uuid;
begin
  if not exists(select 1 from clinical_core.production_program_activation where singleton and enabled) then return '[]'::jsonb; end if;
  for _row in select a.* from clinical_core.program_assignments a where a.organization_id=_org and a.consumer_person_id=_actor and a.state<>'withdrawn' loop
    select c.patient_record_id into _patient from clinical_core.patient_connections c where c.id=_row.connection_id;
    _review:=case when clinical_private.owned_consumer_consent(_actor,'protocols_supplements') is null
      then jsonb_build_object('add','[]'::jsonb,'duplicate','[]'::jsonb)
      else clinical_private.production_program_review(_row.content,clinical_private.production_program_plan_inventory(_actor),
        clinical_private.production_program_lab_readings(_actor,_org,_patient)) end;
    select _held||coalesce(array_agg(i.value->'product'->'catalog'->>'stableId'),'{}') into _held
    from jsonb_array_elements(_row.content) p, jsonb_array_elements(p.value->'items') i
    where i.value->>'kind'='supplement' and jsonb_typeof(i.value->'product'->'catalog')='object'
      and not exists(select 1 from jsonb_array_elements_text(_review->'add') a where a.value=i.value->>'id')
      and not exists(select 1 from jsonb_array_elements_text(_review->'duplicate') d where d.value=i.value->>'id');
  end loop;
  return to_jsonb(coalesce((select array_agg(distinct x order by x) from unnest(_held) x where x is not null),'{}'::text[]));
end $$;
revoke all on function clinical_core.program_held_catalog_products() from public;
grant execute on function clinical_core.program_held_catalog_products() to clinical_core_api;
