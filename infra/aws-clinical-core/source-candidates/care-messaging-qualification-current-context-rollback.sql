-- Rollback for care-messaging-qualification-current-context.sql (BLOCKED; applied nowhere). Removes the fifth proxy,
-- clinical_care_messaging_qualification.set_current_workforce_context, and nothing else: the four parent proxies, both
-- roles, the login's CONNECT grant and the setter are untouched, so the parent credential is exactly as
-- care-messaging-qualification-login.sql left it and its own rollback applies again.
--
-- First set CARE_MESSAGING_WORKFORCE_AUTHORITY back to legacy_claims (or stop the Lambda): afterwards a database_current
-- request under the restricted credential answers 503 again, by design. It refuses unless the fifth proxy is exactly
-- the successor's (body SHA-256 8b1de4471e95f7e3a5a8aea7a390e9c1d9a522cdf3eefd445fc5332d82f2e5be), executable by the API
-- role alone, and the other four are exactly the parent's.
begin;
do $$
declare _api oid := (select oid from pg_roles where rolname = 'clinical_care_messaging_qualification_api');
  _proxy regprocedure := to_regprocedure('clinical_care_messaging_qualification.set_current_workforce_context(text,uuid)');
begin
  if current_database() <> 'clinical_core_qualification' then
    raise exception 'qualification_database_refused';
  end if;
  if _proxy is null or _api is null
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p where p.oid = _proxy)
      <> '8b1de4471e95f7e3a5a8aea7a390e9c1d9a522cdf3eefd445fc5332d82f2e5be'
    or (select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = _proxy and a.grantee <> p.proowner) <> 1
    or not has_function_privilege(_api, _proxy, 'EXECUTE') then
    raise exception 'current_context_rollback_refused';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'clinical_care_messaging_qualification') <> 5
    or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'clinical_care_messaging_qualification'
        and encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') in (
          '23cb89c1a12f2b2fce4bb13be7e9d34f9759990b1a0afee5470fc22855668215',
          '99467cbdf1a891c2770e1a5c543762496fe5935f993de78e53338d625b1f2840',
          'db7803d4d147edc25b7be38aee803d31f4f56269387f312edfd4fa5a54122330',
          '16ae0d63d1383312ef9ed99442e34ff5fe2e7e69cd4c2f5a7822fc8772f675c0')) <> 4 then
    raise exception 'current_context_rollback_refused';
  end if;
end
$$;

drop function clinical_care_messaging_qualification.set_current_workforce_context(text,uuid);

do $$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'clinical_care_messaging_qualification') <> 4 then
    raise exception 'current_context_rollback_refused';
  end if;
end
$$;
commit;
