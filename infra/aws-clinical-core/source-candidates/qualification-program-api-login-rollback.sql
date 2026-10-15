-- BLOCKED qualification-only rollback. Run only after the program Lambda has
-- stopped using the dedicated credential; no secret is changed by this SQL.
-- One DO statement makes the guards and all DDL atomic.
do $$
declare
  _api oid;
  _login oid;
begin
  if current_database() <> 'clinical_core_qualification' then
    raise exception 'qualification_database_refused';
  end if;
  select oid into _api from pg_roles where rolname='clinical_program_qualification_api'
    and not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
    and not rolreplication and not rolbypassrls and not rolinherit;
  select oid into _login from pg_roles where rolname='clinical_program_qualification_login'
    and not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
    and not rolreplication and not rolbypassrls and not rolinherit;
  if _api is null or _login is null then
    raise exception 'qualification_roles_not_rollback_safe';
  end if;
  if (select count(*) from pg_auth_members m where m.member in (_api,_login) or m.roleid in (_api,_login)) <> 1
    or not exists (select 1 from pg_auth_members m where m.member=_login and m.roleid=_api
      and not m.admin_option and not m.inherit_option and m.set_option) then
    raise exception 'qualification_membership_not_rollback_safe';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='clinical_program_qualification') <> 2
    or not exists (select 1 from pg_proc p where p.oid=to_regprocedure(
      'clinical_program_qualification.set_request_context(uuid,uuid,text,text,text,text,text)')
      and p.prosecdef and p.proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='23cb89c1a12f2b2fce4bb13be7e9d34f9759990b1a0afee5470fc22855668215')
    or not exists (select 1 from pg_proc p where p.oid=to_regprocedure(
      'clinical_program_qualification.bounded_request(jsonb)')
      and p.prosecdef and p.proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='7f712320f522c958fb6946685de7be8a3004af9ea89acfb0a467a7bbbe0b78df') then
    raise exception 'qualification_proxy_not_rollback_safe';
  end if;
  execute 'drop function clinical_program_qualification.set_request_context(uuid,uuid,text,text,text,text,text)';
  execute 'drop function clinical_program_qualification.bounded_request(jsonb)';
  execute 'drop schema clinical_program_qualification restrict';
  execute 'revoke clinical_program_qualification_api from clinical_program_qualification_login';
  execute 'drop role clinical_program_qualification_login';
  execute 'drop role clinical_program_qualification_api';
end
$$;
