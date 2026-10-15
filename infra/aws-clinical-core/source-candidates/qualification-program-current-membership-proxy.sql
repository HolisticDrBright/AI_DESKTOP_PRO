-- BLOCKED, qualification-only successor to qualification-program-api-login.sql.
-- Requires the UNREGISTERED workforce-current-membership-context.sql candidate.
-- No login, secret, route, activation or subject is created by this file.
-- This is a new privilege grant and must not be applied without separate review.
begin;
do $$
declare _setter oid;
begin
  if current_database() <> 'clinical_core_qualification' then
    raise exception 'qualification_database_refused';
  end if;
  if not exists (select 1 from pg_roles where rolname='clinical_program_qualification_api'
    and not rolsuper and not rolbypassrls and not rolcanlogin)
    or pg_has_role('clinical_program_qualification_api','clinical_core_api','MEMBER')
    or has_schema_privilege('clinical_program_qualification_api','clinical_core','USAGE')
    or has_schema_privilege('clinical_program_qualification_api','clinical_private','USAGE')
    or has_schema_privilege('clinical_program_qualification_api','clinical_program_qualification','CREATE') then
    raise exception 'qualification_role_refused';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='clinical_program_qualification') <> 2
    or to_regprocedure('clinical_program_qualification.set_request_context(uuid,uuid,text,text,text,text,text)') is null
    or to_regprocedure('clinical_program_qualification.bounded_request(jsonb)') is null
    or (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='clinical_program_qualification' and p.prokind='f' and p.prosecdef
        and p.proconfig=array['search_path=""']::text[]
        and has_function_privilege('clinical_program_qualification_api',p.oid,'EXECUTE')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.privilege_type='EXECUTE' and a.grantee not in
            (p.proowner,(select oid from pg_roles where rolname='clinical_program_qualification_api')))
        and ((p.proname='set_request_context' and
          encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='23cb89c1a12f2b2fce4bb13be7e9d34f9759990b1a0afee5470fc22855668215')
          or (p.proname='bounded_request' and
          encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='7f712320f522c958fb6946685de7be8a3004af9ea89acfb0a467a7bbbe0b78df'))) <> 2 then
    raise exception 'qualification_proxy_parent_refused';
  end if;
  _setter := to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)');
  if _setter is null or not exists (select 1 from pg_proc p where p.oid=_setter
      and p.prokind='f' and p.prosecdef and p.proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=
        '7054db763a6ff38b00a504a09398dcbd60f69b6476b6c85bab36da496d6e0cd6')
    or has_function_privilege('clinical_program_qualification_api',_setter,'EXECUTE')
    or has_schema_privilege('clinical_program_qualification_api','clinical_private','USAGE')
    or exists(select 1 from pg_proc p,
        lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=_setter and a.privilege_type='EXECUTE' and a.grantee not in
        (p.proowner,(select oid from pg_roles where rolname='clinical_core_api'))) then
    raise exception 'current_membership_setter_refused';
  end if;
end
$$;

create function clinical_program_qualification.set_current_workforce_context(
  _subject text, _selected_organization_id uuid, _purpose text
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if _purpose is distinct from 'clinical_data' then
    raise exception using errcode='42501',message='workforce_membership_refused';
  end if;
  return clinical_private.set_current_workforce_context(
    _subject,_selected_organization_id,_purpose);
end
$$;
revoke all on function clinical_program_qualification.set_current_workforce_context(text,uuid,text) from public;
grant execute on function clinical_program_qualification.set_current_workforce_context(text,uuid,text)
  to clinical_program_qualification_api;
commit;
