-- BLOCKED qualification-only candidate. This creates no usable credential.
-- The reviewed operator must first verify the exact isolated database and
-- independently provision a secret/password before changing NOLOGIN to LOGIN.
do $$
begin
  if current_database() <> 'clinical_core_qualification' then
    raise exception 'qualification_database_refused';
  end if;
  -- Roles are cluster-wide. Never grant the global clinical_core_api role to
-- this login: that role has privileges in sibling databases on this cluster.
  if exists (select 1 from pg_roles where rolname in
    ('clinical_program_qualification_api', 'clinical_program_qualification_login')) then
    raise exception 'qualification_roles_already_exist';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'clinical_program_qualification') then
    raise exception 'qualification_schema_already_exists';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'clinical_core_api'
    and not rolcanlogin and not rolsuper and not rolbypassrls) then
    raise exception 'clinical_api_role_refused';
  end if;
  create role clinical_program_qualification_api
    nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  create role clinical_program_qualification_login
    nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
end
$$;

-- A role with USAGE on the existing clinical schemas could also execute any
-- historical function left executable by PUBLIC. Expose only these reviewed
-- proxies in a separate schema; their owner performs the underlying calls.
create schema clinical_program_qualification;
revoke all on schema clinical_program_qualification from public;
grant usage on schema clinical_program_qualification to clinical_program_qualification_api;

create function clinical_program_qualification.set_request_context(
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
revoke all on function clinical_program_qualification.set_request_context(uuid,uuid,text,text,text,text,text) from public;
grant execute on function clinical_program_qualification.set_request_context(uuid,uuid,text,text,text,text,text)
  to clinical_program_qualification_api;

create function clinical_program_qualification.bounded_request(_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return clinical_core.production_program_bounded_request(_request);
end
$$;
revoke all on function clinical_program_qualification.bounded_request(jsonb) from public;
grant execute on function clinical_program_qualification.bounded_request(jsonb)
  to clinical_program_qualification_api;

grant clinical_program_qualification_api to clinical_program_qualification_login
  with admin false, inherit false, set true;

-- The login has no direct clinical grants. The runtime explicitly SET LOCAL
-- ROLE clinical_program_qualification_api inside each transaction. That role
-- has USAGE only on its isolated proxy schema, not clinical_core or
-- clinical_private. No membership in the global API or migrator roles is
-- granted; no password is set here.
