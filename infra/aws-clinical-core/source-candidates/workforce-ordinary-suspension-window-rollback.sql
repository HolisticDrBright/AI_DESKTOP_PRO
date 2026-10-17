-- Rollback of the UNREGISTERED, BLOCKED workforce-ordinary-suspension-window.sql. Applied nowhere.
--
-- Preserving: it restores the parent's legacy entry exactly (the emergency revocation's successor, prosrc SHA-256
-- 3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b), removes the token-evidence entry and the private
-- admission function, and stops recording new status transitions. It keeps
-- clinical_private.organization_status_transitions and every row in it, still append-only: a recorded suspension time
-- is evidence and is never deleted. After it, a session in a suspended clinic behaves as the parent (admitted, as today,
-- without the window), and the emergency revocation keeps refusing a revoked login.
--
-- It refuses unless the three functions are exactly the successor's. Roll this back before rolling back the emergency
-- revocation, whose own rollback refuses any entry but its successor's.

begin;

do $guard$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'))
      is distinct from '359837b0d0f46046fae4ea842ddef0b02d9cb284294ac76b30bc442c126370d1'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text)'))
      is distinct from 'f1f07d424d6f1b2da2fbf3a381b3e0eba90a13f24712bacb753ccb4cecf2933d'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.admit_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text)'))
      is distinct from '8ccbfd1375c1e11ce1205140219fc56ccfbf87da186d905b991e418f94252b32'
    or to_regclass('clinical_private.organization_status_transitions') is null then
    raise exception using errcode = '55000', message = 'ordinary_suspension_window_rollback_refused';
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
  -- workforce-identity-emergency-revocation: the workforce identity row stays share-locked until the operation's
  -- transaction ends, so an emergency revocation (FOR UPDATE on the same row) waits for this request to finish, and a
  -- request that waited on a pending revocation re-reads the committed row here and is refused. The refusal is the one
  -- above, so it does not say why. Consumer requests are unchanged.
  if _identity_pool = 'workforce' then
    perform 1 from clinical_core.identities i
      where i.person_id = _actor_person_id
        and i.identity_pool = 'workforce'
        and i.identity_subject = _identity_subject
        and i.production_bound = true
        and i.status = 'active'
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

drop function clinical_private.set_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text);
drop function clinical_private.admit_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text);
drop trigger organization_status_transition_recorded on clinical_core.organizations;
drop function clinical_private.record_organization_status_transition();

do $check$
begin
  if (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'))
      <> '3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b'
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)') and a.grantee = 0)
    or to_regclass('clinical_private.organization_status_transitions') is null
    or not exists (select 1 from pg_trigger where tgname = 'organization_status_transitions_append_only'
      and tgrelid = 'clinical_private.organization_status_transitions'::regclass) then
    raise exception using errcode = '55000', message = 'ordinary_suspension_window_rollback_refused';
  end if;
end
$check$;

commit;
