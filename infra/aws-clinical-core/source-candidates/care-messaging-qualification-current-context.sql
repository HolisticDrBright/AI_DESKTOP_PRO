-- BLOCKED qualification-only successor (care-messaging-qualification-current-context). Applied nowhere, registered in no
-- manifest; no role, login, secret or deployment depends on it. Registration and execution are Codex work after review.
--
-- Parents, both BLOCKED source candidates, applied first and unchanged:
--   care-messaging-qualification-login.sql (SHA-256 7936d0c536dd7224fe32a62489266da730f0202aac09dd30e7d5e466a4f19dac):
--     the NOLOGIN login and API roles and the four proxies;
--   workforce-current-membership-context.sql: clinical_private.set_current_workforce_context, the current-membership
--     setter (prosrc SHA-256 7054db763a6ff38b00a504a09398dcbd60f69b6476b6c85bab36da496d6e0cd6).
--
-- Under the restricted credential the messaging service could not use `database_current`: the API role may execute
-- the four proxies and nothing else, so the setter was out of reach and every workforce request answered 503. This adds
-- one fifth proxy, clinical_care_messaging_qualification.set_current_workforce_context(subject, clinic), which calls the
-- setter with messaging's own purpose fixed to `clinical_data`. The setter itself is unchanged: it reads the subject's
-- identity, person, clinic and membership from current rows and share-locks them for the operation's transaction, so
-- a membership removal or clinic suspension waits for an admitted message and refuses the next one. The proxy is
-- SECURITY DEFINER and owned by the setter's owner, so it runs with exactly the privileges the setter already runs
-- with. No role gains a membership, schema USAGE, table privilege or database CONNECT; the API role reaches five
-- proxies and nothing else, and still cannot call the setter directly.
--
-- One transaction. The guards refuse unless both parents are present exactly and the successor is not; the
-- post-conditions refuse the whole change unless the reach is exactly the five proxies.
-- Rollback: care-messaging-qualification-current-context-rollback.sql removes the fifth proxy only.
begin;
do $$
declare _proxy text := 'clinical_care_messaging_qualification';
begin
  if current_database() <> 'clinical_core_qualification' then
    raise exception 'qualification_database_refused';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = _proxy) <> 4
    or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = _proxy
      and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') in (
        '23cb89c1a12f2b2fce4bb13be7e9d34f9759990b1a0afee5470fc22855668215',
        '99467cbdf1a891c2770e1a5c543762496fe5935f993de78e53338d625b1f2840',
        'db7803d4d147edc25b7be38aee803d31f4f56269387f312edfd4fa5a54122330',
        '16ae0d63d1383312ef9ed99442e34ff5fe2e7e69cd4c2f5a7822fc8772f675c0')) <> 4
    or (select count(*) from pg_roles where rolname in
      ('clinical_care_messaging_qualification_api', 'clinical_care_messaging_qualification_login')) <> 2 then
    raise exception 'care_messaging_credential_parent_refused';
  end if;
  if not exists (select 1 from pg_proc p
      where p.oid = to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)')
        and p.prosecdef and p.proconfig = array['search_path=""']::text[]
        and p.proowner = (select oid from pg_roles where rolname = current_user)
        and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = '7054db763a6ff38b00a504a09398dcbd60f69b6476b6c85bab36da496d6e0cd6') then
    raise exception 'current_membership_setter_refused';
  end if;
end
$$;

create function clinical_care_messaging_qualification.set_current_workforce_context(
  _subject text, _selected_organization_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return clinical_private.set_current_workforce_context(_subject, _selected_organization_id, 'clinical_data');
end
$$;
revoke all on function clinical_care_messaging_qualification.set_current_workforce_context(text,uuid) from public;
grant execute on function clinical_care_messaging_qualification.set_current_workforce_context(text,uuid)
  to clinical_care_messaging_qualification_api;

-- Post-conditions, the parent's with five proxies. Any failure aborts the transaction and removes the proxy.
do $$
declare
  _api oid := (select oid from pg_roles where rolname = 'clinical_care_messaging_qualification_api');
  _login oid := (select oid from pg_roles where rolname = 'clinical_care_messaging_qualification_login');
begin
  if exists (select 1 from pg_database d
      where d.datallowconn and not d.datistemplate and d.datname <> current_database()
        and d.datname <> 'rdsadmin'
        and (has_database_privilege(_login, d.oid, 'CONNECT') or has_database_privilege(_api, d.oid, 'CONNECT'))) then
    raise exception 'sibling_database_connect_refused';
  end if;
  if (select count(*) from pg_auth_members m where m.member in (_api, _login) or m.roleid in (_api, _login)) <> 1
    or not exists (select 1 from pg_auth_members m where m.member = _login and m.roleid = _api
      and not m.admin_option and not m.inherit_option and m.set_option) then
    raise exception 'care_messaging_membership_refused';
  end if;
  if exists (select 1 from pg_namespace n
      where n.nspname not in ('clinical_care_messaging_qualification', 'public', 'pg_catalog', 'information_schema')
        and n.nspname not like 'pg\_%'
        and (has_schema_privilege(_api, n.oid, 'USAGE') or has_schema_privilege(_login, n.oid, 'USAGE'))) then
    raise exception 'care_messaging_schema_usage_refused';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('clinical_care_messaging_qualification', 'pg_catalog', 'information_schema')
        and (has_schema_privilege(_api, n.oid, 'USAGE') or has_schema_privilege(_login, n.oid, 'USAGE'))
        and (has_function_privilege(_api, p.oid, 'EXECUTE') or has_function_privilege(_login, p.oid, 'EXECUTE'))
        and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')) then
    raise exception 'care_messaging_function_reach_refused';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'clinical_care_messaging_qualification') <> 5
    or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'clinical_care_messaging_qualification'
        and (not p.prosecdef or p.proconfig is distinct from array['search_path=""']::text[]
          or not has_function_privilege(_api, p.oid, 'EXECUTE') or has_function_privilege(_login, p.oid, 'EXECUTE')
          or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'))) then
    raise exception 'care_messaging_proxy_refused';
  end if;
  -- The setter stays out of reach except through its proxy, and is owned as the proxy is.
  if has_function_privilege(_api, to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)'), 'EXECUTE')
    or (select p.proowner from pg_proc p where p.oid = to_regprocedure('clinical_care_messaging_qualification.set_current_workforce_context(text,uuid)'))
      <> (select p.proowner from pg_proc p where p.oid = to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)')) then
    raise exception 'current_membership_setter_refused';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'
        and ((c.relkind in ('r', 'p', 'v', 'm', 'f')
          and (has_table_privilege(_api, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            or has_table_privilege(_login, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
        or (c.relkind = 'S' and (has_sequence_privilege(_api, c.oid, 'USAGE,SELECT,UPDATE')
          or has_sequence_privilege(_login, c.oid, 'USAGE,SELECT,UPDATE'))))) then
    raise exception 'care_messaging_table_reach_refused';
  end if;
end
$$;
commit;
