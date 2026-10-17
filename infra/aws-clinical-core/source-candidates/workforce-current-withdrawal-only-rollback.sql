-- Guarded rollback of the unregistered, blocked current-membership withdrawal
-- wrapper. Consent history, audit, parents and general context are untouched.
begin;

do $guard$
begin
  if not exists (select 1 from pg_proc p
      where p.oid = to_regprocedure('clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)')
        and p.prosecdef and p.proconfig = array['search_path=""']::text[]
        and p.proowner = (select oid from pg_roles where rolname = current_user)
        and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = 'fa5a963aa356caaf988b6b9f0e5a8894f709a92fcba4adb216ee43392bab67fa')
    or not has_function_privilege('clinical_core_api',
      to_regprocedure('clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)'), 'EXECUTE') then
    raise exception using errcode = '55000', message = 'current_withdrawal_rollback_refused';
  end if;
end
$guard$;

drop function clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text);

do $post$
begin
  if to_regprocedure('clinical_private.revoke_current_workforce_consent(text,uuid,uuid,text,text)') is not null then
    raise exception using errcode = '55000', message = 'current_withdrawal_rollback_refused';
  end if;
end
$post$;
commit;
