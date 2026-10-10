if (typeof window !== 'undefined') throw Error('telehealth-consent-database-binding is server-only');
import type { ClinicalCoreDatabase } from './database';
import { CareConnectionError } from './production-care-connections';
import { bindCareConnectionDatabase, type CareConnectionFunctionBinding } from './care-connections-database-binding';

/** Preserve all existing approved-copy protections, plus the exact new function.
 * No changed function, overload, administrative role or public execution admitted. */
export function bindTelehealthConsentDatabase(database: ClinicalCoreDatabase,
  functions: readonly CareConnectionFunctionBinding[], bodySha256: string): ClinicalCoreDatabase {
  if (!/^[a-f0-9]{64}$/.test(bodySha256)) throw Error('telehealth_consent_binding_invalid');
  const bound = bindCareConnectionDatabase(database, functions);
  return { transaction: work => bound.transaction(async tx => {
    const check = await tx.query<{ valid: boolean }>(`select count(*)=1 and bool_and(
      p.oid=to_regprocedure('clinical_core.production_telehealth_consent_request(jsonb)')
      and p.prorettype='jsonb'::regtype and p.prokind='f' and p.provolatile='v' and p.prosecdef
      and p.prolang=(select oid from pg_language where lanname='plpgsql')
      and p.proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$1
      and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE')) as valid
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='clinical_core' and p.proname='production_telehealth_consent_request'`, [bodySha256]);
    if (check.rows[0]?.valid !== true) throw new CareConnectionError('service_unavailable');
    return work(tx);
  }) };
}
