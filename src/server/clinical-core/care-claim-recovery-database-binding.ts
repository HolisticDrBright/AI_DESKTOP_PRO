if(typeof window!=='undefined')throw new Error('care-claim-recovery-database-binding is server-only');
import type {ClinicalCoreDatabase} from './database';
import {CareConnectionError} from './production-care-connections';
import {bindCareConnectionDatabase,type CareConnectionFunctionBinding} from './care-connections-database-binding';

const specs=[['clinical_private.care_claim_result','(uuid,uuid,uuid)',false],
  ['clinical_core.production_care_claim_request','(jsonb)',true]] as const;
/** Capture source pins before touching a client; do not mistake these for reviews. */
export function validateCareClaimFunctions(supplied:readonly CareConnectionFunctionBinding[]){
  const pins=supplied.map(p=>({...p}));
  if(pins.length!==2||new Set(pins.map(p=>p.name)).size!==2||pins.some(p=>!/^[a-f0-9]{64}$/.test(p.bodySha256)
    ||!specs.some(s=>s[0]===p.name&&s[2]===p.apiExecute)))throw new Error('care_claim_binding_invalid');
  return pins;
}
/** Check both the immutable 105 claim dependency and this unreleased overlay
 * inside each transaction, under the API role, before identity or claim work. */
export function bindCareClaimRecoveryDatabase(database:ClinicalCoreDatabase,
  predecessor:readonly CareConnectionFunctionBinding[],supplied:readonly CareConnectionFunctionBinding[]):ClinicalCoreDatabase{
  const pins=validateCareClaimFunctions(supplied);
  const base=bindCareConnectionDatabase(database,predecessor);
  const expected=JSON.stringify(specs.map(([name,args,callable])=>({schema:name.split('.')[0],name:name.split('.')[1],
    signature:name+args,callable,sha256:pins.find(p=>p.name===name)!.bodySha256})));
  return {transaction:work=>base.transaction(async tx=>{
    const check=await tx.query<{valid:boolean}>(`with expected as (
      select * from jsonb_to_recordset($1::jsonb) as e(schema text,name text,signature text,callable boolean,sha256 text)
    ), functions as (
      select count(*)=2 and bool_and(p.oid=to_regprocedure(e.signature) and p.prorettype='jsonb'::regtype
        and p.prokind='f' and p.provolatile='v' and p.prosecdef
        and p.prolang=(select oid from pg_language where lanname='plpgsql') and p.proconfig=array['search_path=""']::text[]
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.sha256
        and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')=e.callable
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.grantee=0 and a.privilege_type='EXECUTE')) valid
      from expected e join pg_namespace n on n.nspname=e.schema join pg_proc p on p.pronamespace=n.oid and p.proname=e.name
    ), tables as (
      select count(*)=2 and bool_and(c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity
        and not has_table_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        and not has_any_column_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
        and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0)
        and not exists(select 1 from pg_attribute a,lateral aclexplode(case when cardinality(a.attacl)>0 then a.attacl else null end) p
          where a.attrelid=c.oid and p.grantee=0)) valid
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname||'.'||c.relname in ('clinical_core.care_claim_requests','clinical_audit.care_claim_events')
    ), expected_triggers(table_name,trigger_name) as (values
      ('clinical_core.care_claim_requests','care_claim_requests_immutable'),
      ('clinical_audit.care_claim_events','care_claim_events_immutable')
    ), triggers as (
      select count(*)=2 and bool_and(not t.tgisinternal and t.tgenabled='O' and t.tgtype=27
        and n.nspname='clinical_private' and p.proname='block_update_delete' and p.pronargs=0) valid
      from expected_triggers e join pg_trigger t on t.tgname=e.trigger_name and t.tgrelid=e.table_name::regclass
      join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
    ) select current_user='clinical_core_api' and f.valid and t.valid and g.valid as valid
      from functions f cross join tables t cross join triggers g`,[expected]);
    if(check.rows[0]?.valid!==true)throw new CareConnectionError('service_unavailable');
    return work(tx);
  })};
}
