-- BLOCKED distinct candidate; unregistered/unapplied; no login or release enabled.
-- Exact LF parents: native 69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7;
-- multipart a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092.
-- The reviewed operator must provision a dedicated login/secret separately.
-- No password, fixture, approving identity or activation receipt is seeded.
create role program_media_runtime nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant program_media_worker to program_media_runtime;
create role program_media_host_authority nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant usage on schema clinical_core to program_media_host_authority;
grant select(version,name,sha256) on clinical_core.schema_migrations to program_media_host_authority;

create function clinical_core.program_media_host_ledger() returns jsonb
language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'sha256',sha256) order by version),'[]'::jsonb)
 from clinical_core.schema_migrations
$$;
grant create on schema clinical_core to program_media_host_authority;
alter function clinical_core.program_media_host_ledger() owner to program_media_host_authority;
revoke create on schema clinical_core from program_media_host_authority;
revoke all on function clinical_core.program_media_host_ledger() from public,clinical_core_api,program_media_authority,program_media_runtime;
grant execute on function clinical_core.program_media_host_ledger() to program_media_worker;
-- Native worker/authority grants and every original-actor fence are unchanged.
