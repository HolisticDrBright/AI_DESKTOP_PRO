-- BLOCKED qualification-only care-messaging database credential. This creates
-- no usable credential: both roles are NOLOGIN, no password or secret is set,
-- and nothing here is applied by any script in this repository.
--
-- Today the care-messaging Lambda signs in with the RDS-managed cluster-master
-- secret and runs as the global clinical_core_api role, which can execute 332
-- functions across every clinical family. This candidate gives it a separate
-- path that reaches exactly four reviewed proxies:
--
--   clinical_care_messaging_qualification_login  (NOLOGIN until provisioned;
--     member of the API role with SET only, no INHERIT, no ADMIN)
--   clinical_care_messaging_qualification_api    (USAGE on the proxy schema
--     only; EXECUTE on the four proxies only)
--
-- Each proxy is SECURITY DEFINER and calls one existing function. The executing
-- role must already own all four targets, so a proxy runs as the same owner its
-- target already runs as: it adds no privilege the target lacks, and changes no
-- existing function's ownership. Consent, recipient, connection, idempotency and
-- row-level-security checks stay inside the unchanged targets.
--
-- Keep everything in one transaction, even when an operator executes it one
-- statement at a time. The post-conditions at the end refuse the whole change
-- unless the login can reach no sibling database and the API role can reach
-- no other function, schema or table.
begin;
do $$
begin
  if current_database() <> 'clinical_core_qualification' then
    raise exception 'qualification_database_refused';
  end if;
  -- Roles are cluster-wide. Never grant clinical_core_api (or any other role)
  -- to these roles: the global API role has privileges in sibling databases.
  if exists (select 1 from pg_roles where rolname in
    ('clinical_care_messaging_qualification_api', 'clinical_care_messaging_qualification_login')) then
    raise exception 'qualification_roles_already_exist';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'clinical_care_messaging_qualification') then
    raise exception 'qualification_schema_already_exists';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'clinical_core_api'
    and not rolcanlogin and not rolsuper and not rolbypassrls) then
    raise exception 'clinical_api_role_refused';
  end if;
  if (select count(*) from pg_proc p
      where p.oid in (
        to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'),
        to_regprocedure('clinical_core.production_care_message_request(jsonb)'),
        to_regprocedure('clinical_core.production_care_message_resolve(jsonb)'),
        to_regprocedure('clinical_core.production_care_message_export(jsonb)'))
      and p.prosecdef and p.proconfig = array['search_path=""']::text[]
      and p.proowner = (select oid from pg_roles where rolname = current_user)) <> 4 then
    raise exception 'care_messaging_targets_refused';
  end if;
  create role clinical_care_messaging_qualification_api
    nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  create role clinical_care_messaging_qualification_login
    nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
end
$$;

create schema clinical_care_messaging_qualification;
revoke all on schema clinical_care_messaging_qualification from public;
grant usage on schema clinical_care_messaging_qualification to clinical_care_messaging_qualification_api;

create function clinical_care_messaging_qualification.set_request_context(
  _actor_person_id uuid, _organization_id uuid, _identity_pool text,
  _identity_subject text, _purpose text, _environment text,
  _data_classification text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform clinical_private.set_request_context(
    _actor_person_id, _organization_id, _identity_pool, _identity_subject,
    _purpose, _environment, _data_classification);
end
$$;
revoke all on function clinical_care_messaging_qualification.set_request_context(uuid,uuid,text,text,text,text,text) from public;
grant execute on function clinical_care_messaging_qualification.set_request_context(uuid,uuid,text,text,text,text,text)
  to clinical_care_messaging_qualification_api;

create function clinical_care_messaging_qualification.request(_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return clinical_core.production_care_message_request(_request);
end
$$;
revoke all on function clinical_care_messaging_qualification.request(jsonb) from public;
grant execute on function clinical_care_messaging_qualification.request(jsonb) to clinical_care_messaging_qualification_api;

create function clinical_care_messaging_qualification.resolve(_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return clinical_core.production_care_message_resolve(_request);
end
$$;
revoke all on function clinical_care_messaging_qualification.resolve(jsonb) from public;
grant execute on function clinical_care_messaging_qualification.resolve(jsonb) to clinical_care_messaging_qualification_api;

create function clinical_care_messaging_qualification.export(_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return clinical_core.production_care_message_export(_request);
end
$$;
revoke all on function clinical_care_messaging_qualification.export(jsonb) from public;
grant execute on function clinical_care_messaging_qualification.export(jsonb) to clinical_care_messaging_qualification_api;

grant clinical_care_messaging_qualification_api to clinical_care_messaging_qualification_login
  with admin false, inherit false, set true;

-- The login needs CONNECT on this database once the CONNECT isolation has
-- removed PUBLIC's; it is granted here, to this database only.
do $$
begin
  execute format('grant connect on database %I to clinical_care_messaging_qualification_login', current_database());
end
$$;

-- Post-conditions. Any failure here aborts the transaction and removes the
-- roles, schema and proxies created above.
do $$
declare
  _api oid := (select oid from pg_roles where rolname = 'clinical_care_messaging_qualification_api');
  _login oid := (select oid from pg_roles where rolname = 'clinical_care_messaging_qualification_login');
begin
  -- No sibling database through PUBLIC CONNECT: the CONNECT isolation for this
  -- cluster must already have run. The same rule the isolation preflight uses:
  -- every connectable, non-template database other than this one.
  if exists (select 1 from pg_database d
      where d.datallowconn and not d.datistemplate and d.datname <> current_database()
        and d.datname <> 'rdsadmin'
        and (has_database_privilege(_login, d.oid, 'CONNECT') or has_database_privilege(_api, d.oid, 'CONNECT'))) then
    raise exception 'sibling_database_connect_refused';
  end if;
  -- Exactly one membership edge: login -> API, SET only. Nothing reaches either
  -- role, and neither reaches clinical_core_api or any other role.
  if (select count(*) from pg_auth_members m where m.member in (_api, _login) or m.roleid in (_api, _login)) <> 1
    or not exists (select 1 from pg_auth_members m where m.member = _login and m.roleid = _api
      and not m.admin_option and not m.inherit_option and m.set_option) then
    raise exception 'care_messaging_membership_refused';
  end if;
  -- No schema but the proxy schema (and the system schemas and public) is
  -- usable, so no historical function executable by PUBLIC is reachable.
  if exists (select 1 from pg_namespace n
      where n.nspname not in ('clinical_care_messaging_qualification', 'public', 'pg_catalog', 'information_schema')
        and n.nspname not like 'pg\_%'
        and (has_schema_privilege(_api, n.oid, 'USAGE') or has_schema_privilege(_login, n.oid, 'USAGE'))) then
    raise exception 'care_messaging_schema_usage_refused';
  end if;
  -- Exactly the four proxies are executable. Extension functions in public
  -- (pgcrypto) are not clinical functions and are left as installed.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('clinical_care_messaging_qualification', 'pg_catalog', 'information_schema')
        and (has_schema_privilege(_api, n.oid, 'USAGE') or has_schema_privilege(_login, n.oid, 'USAGE'))
        and (has_function_privilege(_api, p.oid, 'EXECUTE') or has_function_privilege(_login, p.oid, 'EXECUTE'))
        and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')) then
    raise exception 'care_messaging_function_reach_refused';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'clinical_care_messaging_qualification') <> 4
    or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'clinical_care_messaging_qualification'
        and (not p.prosecdef or p.proconfig is distinct from array['search_path=""']::text[]
          or not has_function_privilege(_api, p.oid, 'EXECUTE') or has_function_privilege(_login, p.oid, 'EXECUTE')
          or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'))) then
    raise exception 'care_messaging_proxy_refused';
  end if;
  -- No table, view or sequence privilege anywhere outside the system schemas.
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
