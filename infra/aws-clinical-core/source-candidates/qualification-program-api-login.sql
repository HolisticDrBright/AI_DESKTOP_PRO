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

grant usage on schema clinical_core, clinical_private to clinical_program_qualification_api;
grant execute on function clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)
  to clinical_program_qualification_api;
grant execute on function clinical_core.production_program_bounded_request(jsonb)
  to clinical_program_qualification_api;
grant clinical_program_qualification_api to clinical_program_qualification_login
  with admin false, inherit false, set true;

-- The login has no direct clinical grants. The runtime explicitly SET LOCAL
-- ROLE clinical_program_qualification_api inside each transaction. That role
-- has only the two reviewed entry points in this database. No membership in
-- the global API or migrator roles is granted; no password is set here.
