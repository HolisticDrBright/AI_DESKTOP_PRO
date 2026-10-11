if (typeof window !== 'undefined') throw new Error('clinic-records-deployment is server-only');
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import type { ClinicalCoreDatabase } from './database';
import { createProductionClinicRecordsApi } from './production-clinic-records-api';
import { createProductionClinicRecordsConsumer, createProductionClinicRecordsWorkforce, ClinicRecordError } from './production-clinic-records';
import { createRdsDataClinicalCoreDatabase, type RdsDataConfiguration } from './rds-data-database';
import { resolveQualificationExecution } from './qualification-execution';

/**
 * UNRELEASED runtime binding for the clinic-record routes. The compiled build
 * carries the exact source commit, the 116 ledger, the candidate SQL hash and
 * the dispatcher body hash; the deployment environment must name the same
 * values or the function answers 503 to everything without constructing a
 * database client. Nothing here registers a route, applies SQL, seeds a
 * disclosure release or turns a review hash into an executed review.
 */
export type ClinicRecordsBuild = {
  sourceCommit: string; sourceClean: boolean; migrationCount: 116; migrationReleaseSha256: string; extensionSha256: string;
  dispatcher: { schema: 'clinical_core'; name: 'clinic_record_request'; sha256: string };
};
type Environment = Record<string, string | undefined>;
const hash = /^[a-f0-9]{64}$/, commit = /^[a-f0-9]{40}$/;
const TABLES = ['clinical_core.clinic_record_requests', 'clinical_core.clinic_record_request_events', 'clinical_core.clinic_record_copies',
  'clinical_core.clinic_record_copy_items', 'clinical_private.clinic_disclosure_releases'];
const TRIGGERS: [string, string, string][] = [
  ['clinical_core.clinic_record_requests', 'clinic_record_requests_guard', 'guard_clinic_record_request'],
  ['clinical_core.clinic_record_request_events', 'clinic_record_request_events_append_only', 'block_update_delete'],
  ['clinical_core.clinic_record_copies', 'clinic_record_copies_append_only', 'block_update_delete'],
  ['clinical_core.clinic_record_copy_items', 'clinic_record_copy_items_append_only', 'block_update_delete'],
  ['clinical_private.clinic_disclosure_releases', 'clinic_disclosure_releases_guard', 'guard_clinic_disclosure_release'],
];

function validateBuild(supplied: ClinicRecordsBuild): ClinicRecordsBuild {
  const build = structuredClone(supplied);
  if (!commit.test(build.sourceCommit) || typeof build.sourceClean !== 'boolean' || build.migrationCount !== 116
    || !hash.test(build.migrationReleaseSha256) || !hash.test(build.extensionSha256) || build.dispatcher?.schema !== 'clinical_core'
    || build.dispatcher.name !== 'clinic_record_request' || !hash.test(build.dispatcher.sha256)) throw new Error('binding_refused');
  return build;
}
/** Checks deployment identity, not approval. */
function binding(e: Environment, build: ClinicRecordsBuild) {
  if (e.SOURCE_COMMIT !== build.sourceCommit || e.MIGRATION_RELEASE_SHA256 !== build.migrationReleaseSha256
    || e.CLINIC_RECORDS_EXTENSION_SHA256 !== build.extensionSha256
    || e.CLINIC_RECORDS_ACTIVATION !== 'blocked' && e.CLINIC_RECORDS_ACTIVATION !== 'approved'
    || e.PHI_ALLOWED !== 'false' && e.PHI_ALLOWED !== 'true' || e.AWS_REGION !== 'us-east-2') throw new Error('binding_refused');
  const activation = e.CLINIC_RECORDS_ACTIVATION === 'approved' ? 'approved' as const : 'blocked' as const;
  const qualification = resolveQualificationExecution(e, activation);
  const serving = qualification !== undefined || e.PHI_ALLOWED === 'true';
  if (serving && !build.sourceClean) throw new Error('binding_refused');
  if (serving) {
    const account = qualification?.accountId ?? '173535830222';
    if (e.DEPLOYMENT_ACCOUNT_ID !== account || qualification && (account !== '588966314750' || qualification.databaseName !== 'clinical_core_qualification')
      || !new RegExp(`^arn:aws:rds:us-east-2:${account}:cluster:[A-Za-z0-9-]{1,63}$`).test(e.CLINICAL_DATABASE_CLUSTER_ARN ?? '')
      || !new RegExp(`^arn:aws:secretsmanager:us-east-2:${account}:secret:[A-Za-z0-9/_+=.@!-]+$`).test(e.CLINICAL_DATABASE_SECRET_ARN ?? '')
      || !/^[a-z][a-z0-9_]{0,62}$/.test(e.CLINICAL_DATABASE_NAME ?? '')
      || !qualification && /qualification/.test(e.CLINICAL_DATABASE_NAME ?? '')) throw new Error('binding_refused');
  }
  return { activation, qualification };
}

/**
 * Under clinical_core_api only. Before business SQL, every transaction checks
 * that the deployed dispatcher is the compiled one (body hash, security
 * definer, empty search_path, executable by the API role and by nobody
 * anonymous), that the five ledgers force row security and grant the API role
 * nothing, and that the guard and append-only triggers are in place. This is
 * not a whole-database ledger claim; the hosted target runner verifies that.
 */
export function bindClinicRecordsDatabase(database: ClinicalCoreDatabase, build: Pick<ClinicRecordsBuild, 'dispatcher'>): ClinicalCoreDatabase {
  const dispatcher = { ...build.dispatcher };
  if (dispatcher.schema !== 'clinical_core' || dispatcher.name !== 'clinic_record_request' || !hash.test(dispatcher.sha256)) throw new Error('binding_refused');
  return { transaction: work => database.transaction(async tx => {
    const checked = await tx.query<{ valid: boolean }>(`with checked_function as (
      select count(*)=1 and bool_and(p.prosecdef and p.proconfig=array['search_path=""']::text[]
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$1
        and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.grantee=0 and a.privilege_type='EXECUTE')) valid
      from pg_namespace n join pg_proc p on p.pronamespace=n.oid
      where n.nspname='clinical_core' and p.proname='clinic_record_request' and p.pronargs=1
    ), checked_tables as (
      select count(*)=5 and bool_and(c.relrowsecurity and c.relforcerowsecurity
        and not has_table_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,DELETE')
        and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
          where a.grantee=0 and a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE'))) valid
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname||'.'||c.relname in (select jsonb_array_elements_text($2::jsonb))
    ), expected_triggers as (
      select * from jsonb_to_recordset($3::jsonb) as e(table_name text,trigger_name text,function_name text)
    ), checked_triggers as (
      select count(*)=5 and bool_and(not t.tgisinternal and t.tgenabled='O' and t.tgtype=27
        and n.nspname='clinical_private' and p.proname=e.function_name and p.pronargs=0) valid
      from expected_triggers e join pg_trigger t on t.tgname=e.trigger_name and t.tgrelid=e.table_name::regclass
      join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
    ) select current_user='clinical_core_api' and f.valid and t.valid and g.valid as valid
      from checked_function f cross join checked_tables t cross join checked_triggers g`,
      [dispatcher.sha256, JSON.stringify(TABLES), JSON.stringify(TRIGGERS.map(([table_name, trigger_name, function_name]) => ({ table_name, trigger_name, function_name })))]);
    if (checked.rows[0]?.valid !== true) throw new ClinicRecordError('service_unavailable');
    return work(tx);
  }) };
}

/** Injectable factory permits transport tests without credentials. Blocked,
 * mismatched or unauthorized traffic never gets a database client. */
export function createClinicRecordsHandler(environment: Environment, supplied: ClinicRecordsBuild,
  databaseFactory: (configuration: RdsDataConfiguration) => ClinicalCoreDatabase = createRdsDataClinicalCoreDatabase,
  now?: () => number): (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Response> {
  try {
    const e = { ...environment }, build = validateBuild(supplied);
    const { activation, qualification } = binding(e, build);
    let database: ClinicalCoreDatabase | undefined;
    const getDatabase = () => database ??= bindClinicRecordsDatabase(databaseFactory({
      clusterArn: e.CLINICAL_DATABASE_CLUSTER_ARN ?? '', secretArn: e.CLINICAL_DATABASE_SECRET_ARN ?? '',
      databaseName: e.CLINICAL_DATABASE_NAME ?? '', region: e.AWS_REGION,
    }), build);
    return createProductionClinicRecordsApi({ configuration: {
      consumerIssuer: e.CONSUMER_ISSUER ?? '', consumerAudience: e.CONSUMER_AUDIENCE ?? '',
      workforceIssuer: e.WORKFORCE_ISSUER ?? '', workforceAudience: e.WORKFORCE_AUDIENCE ?? '',
      organizationId: e.CLINIC_RECORDS_ORGANIZATION_ID ?? '', phiAllowed: e.PHI_ALLOWED === 'true', activation,
      ...(qualification ? { qualification } : {}), activationEvidenceSha256: e.CLINIC_RECORDS_EVIDENCE_SHA256,
      databaseReviewSha256: e.DATABASE_REVIEW_SHA256, mfaReviewSha256: e.WORKFORCE_MFA_REVIEW_SHA256,
      disclosureReviewSha256: e.DISCLOSURE_REVIEW_SHA256, retentionReviewSha256: e.RETENTION_REVIEW_SHA256,
    }, consumer: () => createProductionClinicRecordsConsumer(getDatabase()), workforce: () => createProductionClinicRecordsWorkforce(getDatabase()), now });
  } catch {
    return async () => ({ statusCode: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff' }, body: JSON.stringify({ error: 'service_unavailable' }) });
  }
}
