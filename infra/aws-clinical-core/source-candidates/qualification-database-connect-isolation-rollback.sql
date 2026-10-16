-- BLOCKED rollback companion for qualification-database-connect-isolation.sql.
-- Restores the prior effective PUBLIC CONNECT grants. PostgreSQL may retain
-- an explicit ACL array rather than the prior NULL/default representation.
-- Never run after the program credential is LOGIN or a dependent Lambda uses it.
BEGIN;

DO $guard$
DECLARE
  expected_databases text[] := ARRAY[
    'alp_chat_rls_synthetic_v1', 'clinical_core',
    'clinical_core_qualification', 'postgres'
  ];
  observed_databases text[];
BEGIN
  IF current_database() <> 'clinical_core_qualification' THEN
    RAISE EXCEPTION 'qualification_connect_rollback_wrong_database';
  END IF;
  SELECT array_agg(datname ORDER BY datname) INTO observed_databases
  FROM pg_database
  WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin';
  IF observed_databases IS DISTINCT FROM expected_databases THEN
    RAISE EXCEPTION 'qualification_connect_rollback_inventory_changed';
  END IF;
  IF (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('clinical_program_qualification_api',
                        'clinical_program_qualification_login')
        AND NOT rolcanlogin) <> 2 THEN
    RAISE EXCEPTION 'qualification_connect_rollback_role_activated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_database
    WHERE datname = ANY(expected_databases)
      AND has_database_privilege('clinical_program_qualification_api',datname,'CONNECT')
  ) OR NOT has_database_privilege('clinical_program_qualification_login',
                                  'clinical_core_qualification','CONNECT') THEN
    RAISE EXCEPTION 'qualification_connect_rollback_state_changed';
  END IF;
END;
$guard$;

GRANT CONNECT ON DATABASE alp_chat_rls_synthetic_v1, clinical_core,
  clinical_core_qualification, postgres TO PUBLIC;
REVOKE CONNECT ON DATABASE alp_chat_rls_synthetic_v1, clinical_core,
  clinical_core_qualification, postgres FROM clinical_admin, rdswriteforwarduser;
REVOKE CONNECT ON DATABASE clinical_core_qualification
  FROM clinical_program_qualification_login;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_database
    WHERE datname IN ('alp_chat_rls_synthetic_v1', 'clinical_core',
                      'clinical_core_qualification', 'postgres')
      AND (NOT has_database_privilege('clinical_program_qualification_login',datname,'CONNECT')
        OR NOT has_database_privilege('clinical_program_qualification_api',datname,'CONNECT'))
  ) THEN
    RAISE EXCEPTION 'qualification_connect_rollback_verification_failed';
  END IF;
END;
$verify$;

COMMIT;
