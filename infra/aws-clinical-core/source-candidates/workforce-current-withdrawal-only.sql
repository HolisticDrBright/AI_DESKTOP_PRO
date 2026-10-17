-- UNREGISTERED, BLOCKED successor. Never apply independently of the reviewed
-- current-membership context and withdrawal-only consent-decision candidates.
-- One exact operation, not a general closed-clinic request context: the API
-- role cannot retain these claims after the function returns.
begin;

do $guard$
begin
  if to_regprocedure('clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)') is not null
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
        where p.oid = to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)'))
       <> '7054db763a6ff38b00a504a09398dcbd60f69b6476b6c85bab36da496d6e0cd6'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
        where p.oid = to_regprocedure('clinical_core.revoke_consent_grant(uuid,text,text)'))
       <> '002dc02bb8e55e9853a3fffa8ecbc1dd1f900893bce7ee2421530b53627da88f' then
    raise exception using errcode = '55000', message = 'current_withdrawal_parent_refused';
  end if;
end
$guard$;

create function clinical_private.revoke_current_workforce_consent(
  _subject text, _selected_organization_id uuid, _connection_id uuid,
  _scope text, _reason_code text
) returns table(
  consent_id uuid, connection_id uuid, scope text, status text,
  version integer, recorded_at timestamptz
) language plpgsql security definer set search_path = '' as $$
declare
  _identity clinical_core.identities%rowtype;
  _person clinical_core.persons%rowtype;
  _organization clinical_core.organizations%rowtype;
  _membership clinical_core.organization_memberships%rowtype;
begin
  -- This entry point is one statement in its own transaction. A previously
  -- established context is refused rather than replaced or inherited.
  if nullif(current_setting('clinical.claim.actor_person_id', true), '') is not null
    or nullif(current_setting('clinical.claim.organization_id', true), '') is not null
    or _subject is null or _subject !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or _selected_organization_id is null or _connection_id is null
    or _reason_code is null
    or _reason_code not in ('patient_request','scope_changed','connection_revoked') then
    raise exception using errcode = '42501', message = 'workforce_membership_refused';
  end if;

  -- Match the current-membership lock order. An identity or membership
  -- revocation must wait for an admitted withdrawal, or win before it.
  select * into _identity from clinical_core.identities
    where identity_pool = 'workforce' and identity_subject = _subject for share;
  if not found or _identity.status <> 'active' or _identity.production_bound is distinct from true then
    raise exception using errcode = '42501', message = 'workforce_membership_refused';
  end if;
  select * into _person from clinical_core.persons
    where id = _identity.person_id for share;
  if not found or _person.status <> 'active' or _person.contains_phi is distinct from true then
    raise exception using errcode = '42501', message = 'workforce_membership_refused';
  end if;
  select * into _organization from clinical_core.organizations
    where id = _selected_organization_id for share;
  if not found or _organization.environment <> 'production-clinical'
    or _organization.data_classification <> 'clinical_phi'
    or _organization.contains_phi is distinct from true then
    raise exception using errcode = '42501', message = 'workforce_membership_refused';
  end if;
  select * into _membership from clinical_core.organization_memberships
    where organization_id = _selected_organization_id and person_id = _person.id for share;
  if not found or _membership.status <> 'active'
    or _membership.role not in ('owner','admin','practitioner') then
    raise exception using errcode = '42501', message = 'workforce_membership_refused';
  end if;
  perform 1 from clinical_core.patient_connections c
    where c.id = _connection_id and c.organization_id = _selected_organization_id
      and c.state in ('verified','paused','revoked') for update;
  if not found then
    raise exception using errcode = '42501', message = 'workforce_membership_refused';
  end if;

  perform set_config('clinical.claim.actor_person_id', _person.id::text, true);
  perform set_config('clinical.claim.organization_id', _organization.id::text, true);
  perform set_config('clinical.claim.identity_pool', 'workforce', true);
  perform set_config('clinical.claim.identity_subject', _subject, true);
  perform set_config('clinical.claim.purpose', 'consent_management', true);
  perform set_config('clinical.claim.environment', 'production-clinical', true);
  perform set_config('clinical.claim.data_classification', 'clinical_phi', true);
  return query select * from clinical_core.revoke_consent_grant(
    _connection_id, _scope, _reason_code);

  -- A caller with the API role cannot reuse this narrowly admitted context
  -- for a grant or patient read later in the same transaction.
  perform set_config('clinical.claim.actor_person_id', '', true);
  perform set_config('clinical.claim.organization_id', '', true);
  perform set_config('clinical.claim.identity_pool', '', true);
  perform set_config('clinical.claim.identity_subject', '', true);
  perform set_config('clinical.claim.purpose', '', true);
  perform set_config('clinical.claim.environment', '', true);
  perform set_config('clinical.claim.data_classification', '', true);
end
$$;

revoke all on function clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text) from public;
grant execute on function clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text) to clinical_core_api;

do $post$
begin
  if not exists (select 1 from pg_proc p
      where p.oid = to_regprocedure('clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)')
        and p.prosecdef and p.proconfig = array['search_path=""']::text[]
        and p.proowner = (select oid from pg_roles where rolname = current_user)
        and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = 'fa5a963aa356caaf988b6b9f0e5a8894f709a92fcba4adb216ee43392bab67fa')
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)')
        and a.grantee = 0 and a.privilege_type = 'EXECUTE')
    or not has_function_privilege('clinical_core_api',
      to_regprocedure('clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)'), 'EXECUTE') then
    raise exception using errcode = '55000', message = 'current_withdrawal_successor_refused';
  end if;
end
$post$;
commit;
