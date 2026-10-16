-- Rollback for legacy-claims-clinic-status.sql (BLOCKED; applied nowhere). Restores the parent's definition of
-- clinical_private.set_request_context exactly as 20260821010000_governed_production_lab_import.sql creates it
-- (prosrc SHA-256 36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea). create or replace keeps the grants. The successor wrote no row, so
-- nothing else is touched. It refuses unless the function is exactly the successor (prosrc SHA-256
-- 4187ce781d95640caa788e1a9a2a49b7d59103bc3b0fa2f37ae85de99955201b), so it cannot overwrite a definition it did not create.
--
-- Afterwards a session that already names a suspended or archived clinic is admitted into it again under legacy
-- claims (the pinned gap returns).

begin;

do $guard$
declare _fn regprocedure := to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)');
  _p record;
begin
  if _fn is null then raise exception using errcode = '55000', message = 'clinic_status_rollback_refused'; end if;
  select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body
    into _p from pg_proc p where p.oid = _fn;
  if not _p.prosecdef or _p.proconfig is distinct from array['search_path=""'] or _p.owner <> current_user
    or _p.body <> '4187ce781d95640caa788e1a9a2a49b7d59103bc3b0fa2f37ae85de99955201b' then
    raise exception using errcode = '55000', message = 'clinic_status_rollback_refused';
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

do $check$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')) <> '36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea'
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')
        and a.grantee = 0) then
    raise exception using errcode = '55000', message = 'clinic_status_rollback_refused';
  end if;
end
$check$;

commit;
