-- BLOCKED qualification-only candidate. This creates no usable credential.
-- The reviewed operator must first verify the exact isolated database and
-- independently provision a secret/password before changing NOLOGIN to LOGIN.
do $$
begin
  if current_database() <> 'clinical_core_qualification' then
    raise exception 'qualification_database_refused';
  end if;
  if exists (select 1 from pg_roles where rolname = 'clinical_program_qualification_login') then
    raise exception 'qualification_login_already_exists';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'clinical_core_api'
    and not rolcanlogin and not rolsuper and not rolbypassrls) then
    raise exception 'clinical_api_role_refused';
  end if;
  create role clinical_program_qualification_login
    nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
end
$$;

grant clinical_core_api to clinical_program_qualification_login
  with admin false, inherit false, set true;

-- The new role has no direct clinical grants. The runtime still explicitly
-- SET LOCAL ROLE clinical_core_api inside each transaction. No membership in
-- clinical_core_migrator is granted, and this file does not set a password.
