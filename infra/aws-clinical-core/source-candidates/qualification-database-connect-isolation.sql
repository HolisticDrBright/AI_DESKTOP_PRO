-- BLOCKED source candidate. Synthetic qualification cluster only.
-- Do not execute without the reviewed live-client inventory, exact digest,
-- rollback rehearsal and separate owner approval. This changes cluster-wide
-- database CONNECT grants, not merely one program API function.
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
    RAISE EXCEPTION 'qualification_connect_wrong_database';
  END IF;
  SELECT array_agg(datname ORDER BY datname) INTO observed_databases
  FROM pg_database
  WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin';
  IF observed_databases IS DISTINCT FROM expected_databases THEN
    RAISE EXCEPTION 'qualification_connect_inventory_changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_database
    WHERE datname = ANY(expected_databases) AND datacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'qualification_connect_acl_changed';
  END IF;
  IF (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('clinical_program_qualification_api',
                        'clinical_program_qualification_login')
        AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolbypassrls) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='clinical_admin' AND rolcanlogin)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rdswriteforwarduser' AND rolcanlogin) THEN
    RAISE EXCEPTION 'qualification_connect_roles_changed';
  END IF;
END;
$guard$;

REVOKE CONNECT ON DATABASE alp_chat_rls_synthetic_v1, clinical_core,
  clinical_core_qualification, postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE alp_chat_rls_synthetic_v1, clinical_core,
  clinical_core_qualification, postgres TO clinical_admin, rdswriteforwarduser;
GRANT CONNECT ON DATABASE clinical_core_qualification
  TO clinical_program_qualification_login;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_database
    WHERE datname IN ('alp_chat_rls_synthetic_v1', 'clinical_core', 'postgres')
      AND (has_database_privilege('clinical_program_qualification_login',datname,'CONNECT')
        OR has_database_privilege('clinical_program_qualification_api',datname,'CONNECT'))
  ) OR NOT has_database_privilege('clinical_program_qualification_login',
                                  'clinical_core_qualification','CONNECT')
     OR EXISTS (
       SELECT 1 FROM pg_database
       WHERE datname IN ('alp_chat_rls_synthetic_v1', 'clinical_core',
                         'clinical_core_qualification', 'postgres')
         AND (NOT has_database_privilege('clinical_admin',datname,'CONNECT')
           OR NOT has_database_privilege('rdswriteforwarduser',datname,'CONNECT'))
     ) THEN
    RAISE EXCEPTION 'qualification_connect_verification_failed';
  END IF;
END;
$verify$;

COMMIT;
