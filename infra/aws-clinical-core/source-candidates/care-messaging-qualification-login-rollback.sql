-- BLOCKED qualification-only rollback of care-messaging-qualification-login.sql.
-- Run only after the care-messaging Lambda has stopped using the dedicated
-- credential and the login is NOLOGIN again. It changes no secret, table, row,
-- policy or existing function: it removes the four proxies, their schema, the
-- login's CONNECT grant and the two roles, and nothing else. One DO statement
-- makes every guard and every drop atomic; any drift refuses the whole rollback.
do $$
declare
  _api oid;
  _login oid;
begin
  if current_database() <> 'clinical_core_qualification' then
    raise exception 'qualification_database_refused';
  end if;
  select oid into _api from pg_roles where rolname = 'clinical_care_messaging_qualification_api'
    and not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
    and not rolreplication and not rolbypassrls and not rolinherit;
  select oid into _login from pg_roles where rolname = 'clinical_care_messaging_qualification_login'
    and not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
    and not rolreplication and not rolbypassrls and not rolinherit;
  if _api is null or _login is null then
    raise exception 'qualification_roles_not_rollback_safe';
  end if;
  if (select count(*) from pg_auth_members m where m.member in (_api, _login) or m.roleid in (_api, _login)) <> 1
    or not exists (select 1 from pg_auth_members m where m.member = _login and m.roleid = _api
      and not m.admin_option and not m.inherit_option and m.set_option) then
    raise exception 'qualification_membership_not_rollback_safe';
  end if;
  -- Exactly the four reviewed proxy bodies, and nothing else in the schema.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'clinical_care_messaging_qualification') <> 4
    or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'clinical_care_messaging_qualification')
    or exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'clinical_care_messaging_qualification')
    or not exists (select 1 from pg_proc p where p.oid = to_regprocedure(
      'clinical_care_messaging_qualification.set_request_context(uuid,uuid,text,text,text,text,text)')
      and p.prosecdef and p.proconfig = array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = '23cb89c1a12f2b2fce4bb13be7e9d34f9759990b1a0afee5470fc22855668215')
    or not exists (select 1 from pg_proc p where p.oid = to_regprocedure(
      'clinical_care_messaging_qualification.request(jsonb)')
      and p.prosecdef and p.proconfig = array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = '99467cbdf1a891c2770e1a5c543762496fe5935f993de78e53338d625b1f2840')
    or not exists (select 1 from pg_proc p where p.oid = to_regprocedure(
      'clinical_care_messaging_qualification.resolve(jsonb)')
      and p.prosecdef and p.proconfig = array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = 'db7803d4d147edc25b7be38aee803d31f4f56269387f312edfd4fa5a54122330')
    or not exists (select 1 from pg_proc p where p.oid = to_regprocedure(
      'clinical_care_messaging_qualification.export(jsonb)')
      and p.prosecdef and p.proconfig = array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = '16ae0d63d1383312ef9ed99442e34ff5fe2e7e69cd4c2f5a7822fc8772f675c0') then
    raise exception 'qualification_proxy_not_rollback_safe';
  end if;
  -- The roles own nothing, and hold only what the candidate granted: USAGE on
  -- the proxy schema and EXECUTE on the four proxies (API), CONNECT on this
  -- database (login). A grant added since then is not removed silently.
  if exists (select 1 from pg_shdepend s where s.refclassid = 'pg_authid'::regclass
      and s.refobjid in (_api, _login) and s.deptype = 'o')
    or (select count(*) from pg_shdepend s where s.refclassid = 'pg_authid'::regclass
      and s.refobjid = _api and s.deptype = 'a') <> 5
    or (select count(*) from pg_shdepend s where s.refclassid = 'pg_authid'::regclass
      and s.refobjid = _login and s.deptype = 'a') <> 1
    or not exists (select 1 from pg_shdepend s join pg_database d on d.oid = s.objid
      where s.refclassid = 'pg_authid'::regclass and s.refobjid = _login and s.deptype = 'a'
        and s.classid = 'pg_database'::regclass and d.datname = current_database()) then
    raise exception 'qualification_grants_not_rollback_safe';
  end if;
  execute 'drop function clinical_care_messaging_qualification.set_request_context(uuid,uuid,text,text,text,text,text)';
  execute 'drop function clinical_care_messaging_qualification.request(jsonb)';
  execute 'drop function clinical_care_messaging_qualification.resolve(jsonb)';
  execute 'drop function clinical_care_messaging_qualification.export(jsonb)';
  execute 'drop schema clinical_care_messaging_qualification restrict';
  execute format('revoke connect on database %I from clinical_care_messaging_qualification_login', current_database());
  execute 'revoke clinical_care_messaging_qualification_api from clinical_care_messaging_qualification_login';
  execute 'drop role clinical_care_messaging_qualification_login';
  execute 'drop role clinical_care_messaging_qualification_api';
end
$$;
