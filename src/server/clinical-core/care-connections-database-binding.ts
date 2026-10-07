if (typeof window !== 'undefined') throw new Error('care-connections-database-binding is server-only');
import type { ClinicalCoreDatabase } from './database';
import { CareConnectionError } from './production-care-connections';

export type CareConnectionFunctionBinding = { name: string; bodySha256: string; apiExecute: boolean };
const specs = [
  ['clinical_private.guard_care_consent_text', '()', 'trigger', 'v', false],
  ['clinical_private.serialize_care_consent_release', '()', 'trigger', 'v', false],
  ['clinical_private.protect_care_consent_artifact', '()', 'trigger', 'v', false],
  ['clinical_private.care_connection_actor', '(text,text)', 'uuid', 's', false],
  ['clinical_private.care_connection_artifact', '(text)', 'clinical_core.consent_artifacts', 'v', false],
  ['clinical_core.create_sync_invitation', '(uuid,uuid)', 'jsonb', 'v', true],
  ['clinical_core.production_care_connection_request', '(jsonb)', 'jsonb', 'v', true],
] as const;

/** Capture and validate compiled metadata before any data client is created. */
export function validateCareConnectionFunctions(
  suppliedFunctions: readonly CareConnectionFunctionBinding[]): CareConnectionFunctionBinding[] {
  const functions = suppliedFunctions.map(f => ({ ...f }));
  if (functions.length !== specs.length || new Set(functions.map(f => f.name)).size !== specs.length
    || functions.some(f => !/^[a-f0-9]{64}$/.test(f.bodySha256)
      || !specs.some(s => s[0] === f.name && s[4] === f.apiExecute))) {
    throw new Error('care_connection_contract_binding_invalid');
  }
  return functions;
}

/** Deployed-contract metadata check, not whole-ledger inspection or approval.
 * The handler supplies function digests from its compiled artifact.
 * It never uses an administrative role or reads patient/consent copy content. */
export function bindCareConnectionDatabase(database: ClinicalCoreDatabase,
  suppliedFunctions: readonly CareConnectionFunctionBinding[]): ClinicalCoreDatabase {
  const functions = validateCareConnectionFunctions(suppliedFunctions);
  const expected = JSON.stringify(specs.map(([qualified, arguments_, result, volatility, callable]) => {
    const [schema, name] = qualified.split('.');
    return { schema, name, signature: qualified + arguments_, result, volatility, callable,
      sha256: functions.find(f => f.name === qualified)!.bodySha256 };
  }));
  return { transaction: work => database.transaction(async tx => {
    const check = await tx.query<{ valid: boolean }>(`with expected as (
      select * from jsonb_to_recordset($1::jsonb) as e(schema text,name text,signature text,result text,
        volatility text,callable boolean,sha256 text)
    ), checked_functions as (
      select count(*)=7 and bool_and(p.oid=to_regprocedure(e.signature) and p.prorettype=e.result::regtype
        and p.prokind='f' and p.provolatile::text=e.volatility and p.prosecdef
        and p.prolang=(select oid from pg_language where lanname='plpgsql')
        and p.proconfig=array['search_path=""']::text[]
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.sha256
        and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')=e.callable
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.grantee=0 and a.privilege_type='EXECUTE')) valid
      from expected e join pg_namespace n on n.nspname=e.schema
        join pg_proc p on p.pronamespace=n.oid and p.proname=e.name
    ), checked_table as (
      select count(*)=1 and bool_and(c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity
        and not has_table_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        and not has_any_column_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
        and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
          where a.grantee=0)
        and not exists(select 1 from pg_attribute a, lateral aclexplode(case when cardinality(a.attacl)>0 then a.attacl else null end) p
          where a.attrelid=c.oid and p.grantee=0)) valid
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='clinical_core' and c.relname='care_consent_texts'
    ), expected_triggers(table_name,trigger_name,function_name,event_mask) as (values
      ('clinical_core.care_consent_texts','care_consent_texts_immutable','block_update_delete',27),
      ('clinical_core.care_consent_texts','care_consent_texts_approved','guard_care_consent_text',7),
      ('clinical_core.consent_artifacts','care_consent_release_serialized','serialize_care_consent_release',23),
      ('clinical_core.consent_artifacts','care_consent_artifact_immutable','protect_care_consent_artifact',19)
    ), checked_triggers as (
      select count(*)=4 and bool_and(not t.tgisinternal and t.tgenabled='O' and t.tgtype=e.event_mask
        and n.nspname='clinical_private' and p.proname=e.function_name and p.pronargs=0) valid
      from expected_triggers e join pg_trigger t on t.tgname=e.trigger_name and t.tgrelid=e.table_name::regclass
      join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
    ) select current_user='clinical_core_api' and f.valid and t.valid and g.valid as valid
      from checked_functions f cross join checked_table t cross join checked_triggers g`, [expected]);
    if (check.rows[0]?.valid !== true) throw new CareConnectionError('service_unavailable');
    return work(tx);
  }) };
}
