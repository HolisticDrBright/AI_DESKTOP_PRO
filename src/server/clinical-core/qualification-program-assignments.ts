if (typeof window !== 'undefined') throw new Error('qualification-program-assignments is server-only');
import type { ProgramAssignmentResponse } from '../../contracts/programAssignments';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';
import { assertQualificationConfiguration, qualificationAdmits, type QualificationExecution } from './qualification-execution';
import { boundedProgramExecutor, ProductionProgramAssignmentError, type ProductionProgramAssignmentDependencies } from './production-program-assignments';

/**
 * The program family for the isolated, production-shaped qualification database: DISABLED unless qualification execution
 * is configured, and never a production capability.
 *
 * The isolated qualification database (clinical_core_qualification) is the 106-migration production artifact plus the
 * approved 107->111->112 upgrades. The synthetic adapter (program-assignments.ts) needs synthetic-staging context and the
 * synthetic parent, which that database does not have and must not be given. The production adapter needs reviewed
 * production activation evidence, which a qualification deployment must never carry. This adapter is the third,
 * distinct family member:
 * - it is built only with a qualification execution policy (PHI disabled, activation blocked, a qualification database in
 *   the synthetic account, designated fictional subjects): assertQualificationConfiguration refuses anything else;
 * - every request from an identity that is not a designated subject is refused as `activation_refused`, exactly as when
 *   nothing is activated;
 * - it runs the production adapter's own request path (boundedProgramExecutor): the production-shaped context, the bound
 *   completion contract, the per-request Core entitlement check and the destination lock. Qualification reaches the
 *   same bounded database function only through two reviewed proxies in its isolated schema;
 * - before every transaction the database must hold exactly the reviewed function bodies of the family and the
 *   qualification boundary (bindQualificationProgramDatabase). An unknown or conflicting schema identity is refused as
 *   `service_unavailable` before any request reaches it;
 * - the database itself opens the family only through the BLOCKED qualification-program-boundary.sql successor, which
 *   requires both production activation rows to stay disabled.
 */
export const QUALIFICATION_PROGRAM_BOUNDARY = 'qualification-program-boundary/1' as const;
/** SHA-256 (LF bytes) of infra/aws-clinical-core/source-candidates/qualification-program-boundary.sql and its rollback. */
export const QUALIFICATION_PROGRAM_BOUNDARY_CANDIDATE_SHA256 = '0f07717d240d981b3900f6c2e926aa79025157f916e869c4a74def52214261a6';
export const QUALIFICATION_PROGRAM_BOUNDARY_ROLLBACK_SHA256 = 'bfdf50b7bb0676d83fa2bb37fa653b8023e03cce1efa20d5916896a76274da9e';
/** The approved qualification ledger the boundary was built and tested on (telehealth-consent-copy-candidate/1). */
export const QUALIFICATION_PROGRAM_LEDGER = Object.freeze({ migrationCount: 112, migrationReleaseSha256: '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4' });

export type QualificationProgramFunctionBinding = { name: string; bodySha256: string };
/** The family's functions the binding checks: argument list, whether the qualification role may call it, and whether it runs as
 * its definer (the destination projection is a plain function called only from inside the definer entry points). */
export const QUALIFICATION_PROGRAM_FUNCTIONS = [
  ['clinical_core.production_program_bounded_request', '(jsonb)', false, true],
  ['clinical_private.production_program_bounded_complete', '(jsonb)', false, true],
  ['clinical_core.production_program_assignment_request', '(jsonb)', false, true],
  ['clinical_private.production_program_without_destinations', '(jsonb)', false, false],
  ['clinical_private.program_qualification_open', '()', false, true],
  ['clinical_program_qualification.set_request_context', '(uuid,uuid,text,text,text,text,text)', true, true],
  ['clinical_program_qualification.bounded_request', '(jsonb)', true, true],
] as const;
/** An additive, still-BLOCKED proxy. The base qualification route may coexist with it only at this exact body. */
export const QUALIFICATION_CURRENT_MEMBERSHIP_PROXY_BODY_SHA256 = '5bfb5080bc9bd3bb5613574fdd15a4bff65ef31f8fb3062cd2784c770377f077';

export function validateQualificationProgramFunctions(supplied: readonly QualificationProgramFunctionBinding[]): QualificationProgramFunctionBinding[] {
  const functions = supplied.map(f => ({ name: f.name, bodySha256: f.bodySha256 }));
  if (functions.length !== QUALIFICATION_PROGRAM_FUNCTIONS.length || new Set(functions.map(f => f.name)).size !== functions.length
    || functions.some(f => !/^[a-f0-9]{64}$/.test(f.bodySha256) || !QUALIFICATION_PROGRAM_FUNCTIONS.some(([name]) => name === f.name)))
    throw new Error('qualification_program_binding_invalid');
  return functions;
}

/**
 * Deployed-contract metadata check before every transaction, through the qualification role only: each family function has the
 * reviewed body (SHA-256 of prosrc), the reviewed SECURITY DEFINER setting and an empty search_path, is callable by that role exactly
 * when it should be and never by PUBLIC; the qualification boundary and subject tables force row security and grant the
 * role nothing. It also refuses clinical-schema usage and every extra proxy except the exact, reviewed optional
 * current-membership proxy. This compatibility must be deployed before that SQL is ever applied. It reads no table row.
 */
export function bindQualificationProgramDatabase(database: ClinicalCoreDatabase, supplied: readonly QualificationProgramFunctionBinding[]): ClinicalCoreDatabase {
  const functions = validateQualificationProgramFunctions(supplied);
  const expected = JSON.stringify(QUALIFICATION_PROGRAM_FUNCTIONS.map(([qualified, args, callable, definer]) => {
    const [schema, name] = qualified.split('.');
    return { schema, name, args, callable, definer, sha256: functions.find(f => f.name === qualified)!.bodySha256 };
  }));
  return { transaction: work => database.transaction(async tx => {
    const check = await tx.query<{ valid: boolean }>(`with expected as (
      select * from jsonb_to_recordset($1::jsonb) as e(schema text,name text,args text,callable boolean,definer boolean,sha256 text)
    ), checked_functions as (
      select count(*)=${QUALIFICATION_PROGRAM_FUNCTIONS.length} and bool_and(('('||replace(oidvectortypes(p.proargtypes),' ','')||')')=e.args
        and p.prokind='f' and p.prosecdef=e.definer
        and p.prolang=(select oid from pg_language where lanname='plpgsql')
        and p.proconfig=array['search_path=""']::text[]
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.sha256
        and has_function_privilege('clinical_program_qualification_api',p.oid,'EXECUTE')=e.callable
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.grantee=0 and a.privilege_type='EXECUTE')) valid
      from expected e join pg_namespace n on n.nspname=e.schema join pg_proc p on p.pronamespace=n.oid and p.proname=e.name
    ), checked_tables as (
      select count(*)=2 and bool_and(c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity
        and not has_table_privilege('clinical_program_qualification_api',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0)) valid
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='clinical_core' and c.relname in('program_qualification_boundary','program_qualification_subjects')
    ), checked_optional_proxy as (
      select coalesce((select p.prokind='f' and p.prosecdef
        and p.proconfig=array['search_path=""']::text[]
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$2
        and has_function_privilege('clinical_program_qualification_api',p.oid,'EXECUTE')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.privilege_type='EXECUTE' and a.grantee not in
            (p.proowner,(select oid from pg_roles where rolname='clinical_program_qualification_api')))
        from pg_proc p where p.oid=to_regprocedure('clinical_program_qualification.set_current_workforce_context(text,uuid,text)')),true) as valid
    ), checked_schema as (
      select has_schema_privilege(current_user,'clinical_program_qualification','USAGE')
        and not has_schema_privilege(current_user,'clinical_core','USAGE')
        and not has_schema_privilege(current_user,'clinical_private','USAGE')
        and (select count(*)=2+case when to_regprocedure('clinical_program_qualification.set_current_workforce_context(text,uuid,text)') is null then 0 else 1 end
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='clinical_program_qualification') as valid
    ) select current_user='clinical_program_qualification_api'
      and not pg_has_role(current_user,'clinical_core_api','MEMBER')
      and f.valid and t.valid and o.valid and s.valid as valid
      from checked_functions f cross join checked_tables t cross join checked_optional_proxy o cross join checked_schema s`,
    [expected, QUALIFICATION_CURRENT_MEMBERSHIP_PROXY_BODY_SHA256]);
    if (check.rows[0]?.valid !== true) throw new ProductionProgramAssignmentError('service_unavailable');
    return work(tx);
  }) };
}

export type QualificationProgramDependencies = Pick<ProductionProgramAssignmentDependencies, 'database' | 'verifyConsumerCore'> & {
  functions: readonly QualificationProgramFunctionBinding[];
  phiAllowed: boolean;
  activation: string;
  qualification: QualificationExecution | undefined;
};

/** Built only under qualification execution; throws `qualification_program_configuration_invalid` otherwise. */
export function createQualificationProgramAssignments(deps: QualificationProgramDependencies) {
  let qualification: QualificationExecution | undefined;
  try { qualification = assertQualificationConfiguration({ phiAllowed: deps.phiAllowed, activation: deps.activation, qualification: deps.qualification }); }
  catch { qualification = undefined; }
  if (!qualification) throw new Error('qualification_program_configuration_invalid');
  const policy = qualification;
  const execute = boundedProgramExecutor({ database: bindQualificationProgramDatabase(deps.database, deps.functions), verifyConsumerCore: deps.verifyConsumerCore }, 'qualification');
  return async (context: ClinicalRequestContext, body: unknown, authorization: string): Promise<ProgramAssignmentResponse> => {
    if (!qualificationAdmits(policy, context.identitySubject)) throw new ProductionProgramAssignmentError('activation_refused');
    return execute(context, body, authorization);
  };
}
