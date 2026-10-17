-- Rollback of the UNREGISTERED, BLOCKED workforce-identity-emergency-revocation.sql. Applied nowhere.
--
-- Preserving: it restores the parent's set_request_context exactly (prosrc SHA-256
-- 36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea) and removes the operator functions, so no new
-- revocation can be proposed, decided or reconciled here. It keeps every table and every row: proposals, decisions,
-- revocations and provider attempts stay as recorded, and are no longer reachable by any API or operator role.
-- It never re-enables an identity. A login revoked for a suspected compromise stays disabled after the rollback; the
-- parent entry refuses it on its own (it reads identities.status, without the lock).
--
-- It refuses unless the current entry is exactly the successor's.

begin;

do $guard$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'))
      is distinct from '3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b'
    or to_regclass('clinical_private.workforce_identity_revocations') is null then
    raise exception using errcode = '55000', message = 'emergency_revocation_rollback_refused';
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
  perform set_config('clinical.claim.actor_person_id', _actor_person_id::text, true);
  perform set_config('clinical.claim.organization_id', _organization_id::text, true);
  perform set_config('clinical.claim.identity_pool', _identity_pool, true);
  perform set_config('clinical.claim.identity_subject', _identity_subject, true);
  perform set_config('clinical.claim.purpose', _purpose, true);
  perform set_config('clinical.claim.environment', _environment, true);
  perform set_config('clinical.claim.data_classification', _data_classification, true);
end
$$;

drop function clinical_private.list_workforce_identity_revocation_work(text);
drop function clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text);
drop function clinical_private.decide_workforce_identity_revocation(text,uuid,text);
drop function clinical_private.propose_workforce_identity_revocation(text,uuid,text,text);
drop function clinical_private.apply_workforce_identity_revocation(uuid);
drop function clinical_private.workforce_identity_revocation_summary(uuid);
drop function clinical_private.require_not_own_workforce_login(text,uuid);
drop function clinical_private.require_active_platform_operator(text);
update clinical_private.workforce_identity_revocation_release set enabled = false, approval_mode = null, changed_at = clock_timestamp();

do $check$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'))
      <> '36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea'
    or to_regprocedure('clinical_private.propose_workforce_identity_revocation(text,uuid,text,text)') is not null
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)') and a.grantee = 0) then
    raise exception using errcode = '55000', message = 'emergency_revocation_rollback_refused';
  end if;
end
$check$;

commit;
