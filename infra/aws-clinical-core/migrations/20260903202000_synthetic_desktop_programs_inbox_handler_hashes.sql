-- Replace registration bootstrap sentinels with hashes of the installed,
-- reviewed function definitions. Operations remain disabled until activation.

update clinical_core.desktop_compatibility_operations
set source_sha256 = encode(public.digest(convert_to(
  pg_get_functiondef('clinical_compatibility.synthetic_programs_v1(jsonb)'::regprocedure),
  'UTF8'),'sha256'),'hex')
where kind='rpc' and handler_schema='clinical_compatibility'
  and handler_function='synthetic_programs_v1';

update clinical_core.desktop_compatibility_operations
set source_sha256 = encode(public.digest(convert_to(
  pg_get_functiondef('clinical_compatibility.synthetic_inbox_v1(jsonb)'::regprocedure),
  'UTF8'),'sha256'),'hex')
where kind='rpc' and handler_schema='clinical_compatibility'
  and handler_function='synthetic_inbox_v1';
