-- Unregistered source candidate (legacy-claims-clinic-status). BLOCKED: applied nowhere, registered in no manifest,
-- and no route, role or setting depends on it. Registration and execution are Codex work after review, and applying it
-- is Brandon's decision with Codex (docs/desktop-onboarding-authority-2026-10-16.md).
--
-- Parent: the 106-migration production artifact and the 112-migration qualification ledger, which share one
-- definition of clinical_private.set_request_context (20260821010000_governed_production_lab_import.sql, prosrc SHA-256
-- 36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea). The successor redefines that one function, identical to the parent's except for
-- one refusal after the parent's own. Signature, owner, SECURITY DEFINER, search_path and grants are kept (create or
-- replace keeps the parent's EXECUTE grants). No table, row, policy, role or other function changes.
-- Rollback: legacy-claims-clinic-status-rollback.sql restores the parent's definition exactly.
--
-- The defect. Under the deployed `legacy_claims` authority, every workforce service sets the request context from the
-- verified token (person, clinic, pool, purpose) through this function, and each operation then checks membership
-- rows (has_clinical_role, is_active_member, the inline admin, schedule and catalog checks). None of them reads
-- clinical_core.organizations.status. list_my_organizations hides a suspended or archived clinic, so sign-in no longer
-- offers it, but a session that already named it kept reading and writing clinical data in it
-- (legacy-claims-clinic-status.database.test.ts). Here, at the one place every legacy workforce request enters and in
-- the operation's own transaction, a clinical-data or identity-linking request is refused unless its clinic is active,
-- and the clinic row stays share-locked until the operation commits. The `database_current` path never calls this
-- function: its setter (workforce-current-membership-context.sql) already share-locks and checks the clinic.
--
-- Deliberately unchanged, and listed for the owner's review: workforce `consent_management` (the retention sweep,
-- erasure recovery, care-data lifecycle and recording cleanup run under it and must keep deleting in a closed clinic;
-- a practitioner's own consent recording therefore also stays open under legacy claims, because this function cannot
-- tell a service identity from a practitioner) and every `consumer` request (a patient's records, privacy requests,
-- exports and erasure).
--
-- The successor itself refuses unless the parent is exactly the reviewed definition, owned by the applying role, and
-- refuses afterwards unless the result is exactly the successor with no PUBLIC execute.

begin;

do $guard$
declare _fn regprocedure := to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)');
  _p record;
begin
  if _fn is null then raise exception using errcode = '55000', message = 'clinic_status_parent_refused'; end if;
  select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body
    into _p from pg_proc p where p.oid = _fn;
  if not _p.prosecdef or _p.proconfig is distinct from array['search_path=""'] or _p.owner <> current_user
    or _p.body <> '36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea' then
    raise exception using errcode = '55000', message = 'clinic_status_parent_refused';
  end if;
end
$guard$;

create or replace function clinical_private.set_request_context(
  _actor_person_id uuid,
  _organization_id uuid,
  _identity_pool text,
  _identity_subject text,
  _purpose text,
  _environment text,
  _data_classification text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if _identity_pool not in ('workforce','consumer')
    or _purpose not in ('identity_link','consent_management','clinical_data')
    or _environment <> 'production-clinical'
    or _data_classification <> 'clinical_phi'
    or not exists (
      select 1 from clinical_core.identities i
      join clinical_core.persons p on p.id = i.person_id
      where i.person_id = _actor_person_id
        and i.identity_pool = _identity_pool
        and i.identity_subject = _identity_subject
        and i.production_bound = true
        and i.status = 'active'
        and p.status = 'active'
        and p.contains_phi = true
    ) then
    raise exception using errcode = '42501', message = 'request_context_refused';
  end if;
  -- legacy-claims-clinic-status: a workforce request for clinical data or identity linking is admitted only into a
  -- clinic whose own status is active. Under legacy claims the clinic is the one the service took from the token, and
  -- every check after this point reads membership rows only, so a session that chose a clinic before it was suspended
  -- or archived kept working in it. The row is share-locked for the rest of the operation's transaction, in the same
  -- way the current-membership setter locks it: a suspension waits for an admitted operation to finish, and an
  -- operation that waits on an uncommitted suspension re-reads the committed row and is refused. The refusal is the one
  -- above, so it says neither whether the clinic exists nor why it is closed. Workforce consent management (the
  -- retention sweep, erasure recovery and recording cleanup run under it) and every consumer request are unchanged;
  -- what else may continue in a closed clinic is the owner's decision (docs/desktop-onboarding-authority-2026-10-16.md),
  -- not this function's.
  if _identity_pool = 'workforce' and _purpose in ('clinical_data', 'identity_link') then
    perform 1 from clinical_core.organizations o
      where o.id = _organization_id and o.status = 'active'
      for share;
    if not found then
      raise exception using errcode = '42501', message = 'request_context_refused';
    end if;
  end if;
  perform set_config('clinical.claim.actor_person_id', _actor_person_id::text, true);
  perform set_config('clinical.claim.organization_id', _organization_id::text, true);
  perform set_config('clinical.claim.identity_pool', _identity_pool, true);
  perform set_config('clinical.claim.identity_subject', _identity_subject, true);
  perform set_config('clinical.claim.purpose', _purpose, true);
  perform set_config('clinical.claim.environment', _environment, true);
  perform set_config('clinical.claim.data_classification', _data_classification, true);
end
$$;

do $check$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')) <> '4187ce781d95640caa788e1a9a2a49b7d59103bc3b0fa2f37ae85de99955201b'
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')
        and a.grantee = 0) then
    raise exception using errcode = '55000', message = 'clinic_status_successor_refused';
  end if;
end
$check$;

commit;
